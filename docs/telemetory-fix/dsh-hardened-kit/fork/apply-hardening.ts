/**
 * apply-hardening.ts — idempotent, drift-detecting codemod that turns an upstream
 * deepseek-ai/deepseek-harness checkout into a privacy-hardened fork.
 *
 *   node hardening/apply-hardening.ts [--root <repo>] [--dry-run] [--strict]
 *
 *   --dry-run  report only, write nothing
 *   --strict   treat OPTIONAL patches that fail to anchor as errors (use in CI)
 *
 * Every REQUIRED patch must anchor exactly; if upstream drifted, the script exits 2 and prints
 * which anchor was not found, so a reviewer re-derives the patch instead of shipping a silent no-op.
 * A machine-readable report is written to hardening/HARDENING-REPORT.json.
 *
 * Design rule: never delete upstream packages. session-log-deepseek declares the
 * `session-log-deepseek/delivery-accepted` event type; removing the package from the workspace would
 * drop it from the generated known-event vocabulary and make existing session logs unreadable
 * ("unknown to this harness ... refusing to interpret the log"). We neuter behaviour instead.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

type Level = 'required' | 'optional'
interface Outcome {
  id: string
  level: Level
  file: string
  status: 'applied' | 'already' | 'missing-file' | 'anchor-not-found'
  detail: string
  sha256Before?: string
  sha256After?: string
}

const args = process.argv.slice(2)
const flag = (n: string) => args.includes(n)
const opt = (n: string) => {
  const i = args.indexOf(n)
  return i >= 0 ? args[i + 1] : undefined
}
const ROOT = path.resolve(opt('--root') ?? process.cwd())
const DRY = flag('--dry-run')
const STRICT = flag('--strict')
const HERE = path.dirname(fileURLToPath(import.meta.url))
const MARK = '[dsh-hardened]'
const outcomes: Outcome[] = []

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16)
const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join('/')

function edit(id: string, level: Level, file: string, fn: (src: string) => { out: string; detail: string } | null): void {
  const abs = path.join(ROOT, file)
  if (!fs.existsSync(abs)) {
    outcomes.push({ id, level, file, status: 'missing-file', detail: 'file not found' })
    return
  }
  const src = fs.readFileSync(abs, 'utf8')
  const res = fn(src)
  if (res === null) {
    outcomes.push({ id, level, file, status: 'anchor-not-found', detail: 'anchor not found (upstream drift?)', sha256Before: sha(src) })
    return
  }
  if (res.out === src) {
    outcomes.push({ id, level, file, status: 'already', detail: res.detail, sha256Before: sha(src) })
    return
  }
  if (!DRY) fs.writeFileSync(abs, res.out, 'utf8')
  outcomes.push({ id, level, file, status: 'applied', detail: res.detail, sha256Before: sha(src), sha256After: sha(res.out) })
}

// ------------------------------------------------------------------------------------------ helpers

/** `enabled: <schema>.boolean().default(true)` -> default(false). Works for zod-like `z.` and schemastery `Schema.`. */
function flipEnabledDefault(src: string): { out: string; n: number } {
  let n = 0
  const out = src.replace(/(\benabled\s*:\s*[\w$.]*boolean\(\)(?:\s*\.\s*[\w$]+\([^()]*\))*?\s*\.\s*default\(\s*)true(\s*\))/g, (_m, a: string, b: string) => {
    n++
    return `${a}false${b}`
  })
  return { out, n }
}

/** Insert an env-gated early return at the top of `export function apply(...) {`. */
function gateApply(src: string, envVar: string, what: string): { out: string; ok: boolean } {
  if (src.includes(`${MARK} gate ${envVar}`)) return { out: src, ok: true }
  const re = /export\s+(?:async\s+)?function\s+apply\s*(?:<[^>]*>)?\s*\(([^)]*)\)\s*(?::\s*[^{]+?)?\{/
  const m = re.exec(src)
  if (!m) return { out: src, ok: false }
  const at = m.index + m[0].length
  const guard =
    `\n  // ${MARK} gate ${envVar}: ${what} is compiled out of the request path unless explicitly re-enabled.\n` +
    `  // UI switches, profile patches and HMR cannot re-enable it; only the process environment can.\n` +
    `  if (process.env.${envVar} !== '1') {\n` +
    `    return\n` +
    `  }\n`
  return { out: src.slice(0, at) + guard + src.slice(at), ok: true }
}

function addImport(src: string, line: string): string {
  if (src.includes(line)) return src
  const imports = [...src.matchAll(/^import[\s\S]*?from\s+['"][^'"]+['"]\s*;?\s*$/gm)]
  if (imports.length === 0) return `${line}\n${src}`
  const last = imports[imports.length - 1]
  const at = (last.index ?? 0) + last[0].length
  return src.slice(0, at) + `\n${line}` + src.slice(at)
}

/** Rewrite bare `fetch(` calls (not `.fetch(` / `xfetch(` / declarations) to `hardenedFetch(`. */
function rewriteFetch(src: string): { out: string; n: number } {
  let n = 0
  const out = src.replace(/(?<![\w$.])fetch\s*\(/g, (m: string, offset: number, whole: string) => {
    const lineStart = whole.lastIndexOf('\n', offset - 1) + 1
    const lineEnd = whole.indexOf('\n', offset)
    const before = whole.slice(lineStart, offset)
    const after = whole.slice(offset, lineEnd < 0 ? undefined : lineEnd)
    if (/function\s*\*?\s*$/.test(before)) return m // declaration `function fetch(`
    if (/^\s*(?:(?:public|private|protected|static|async|override)\s+)*$/.test(before) && /\)\s*(?::[^=;]*)?\{\s*$/.test(after)) return m // method definition
    if (/^\s*\/\//.test(before) || /^\s*\*/.test(before)) return m // comment line
    n++
    return 'hardenedFetch('
  })
  return { out, n }
}

/** YAML row helpers for cordis.patch.yml (keeps `!!js` tags intact by working on text). */
interface Row { start: number; end: number; indent: string; text: string }
function findRow(lines: string[], id: string): Row | null {
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)-\s+id:\s*['"]?([\w.-]+)['"]?\s*$/.exec(lines[i])
    if (!m || m[2] !== id) continue
    const indent = m[1]
    let j = i + 1
    while (j < lines.length) {
      const l = lines[j]
      if (l.trim() === '' || l.trimStart().startsWith('#')) { j++; continue }
      const lead = /^(\s*)/.exec(l)![1]
      if (lead.length <= indent.length) break
      j++
    }
    while (j > i + 1 && (lines[j - 1].trim() === '' || lines[j - 1].trimStart().startsWith('#'))) j--
    return { start: i, end: j, indent, text: lines.slice(i, j).join('\n') }
  }
  return null
}

function setRowConfigEnabledFalse(src: string, id: string): { out: string; detail: string } | null {
  const lines = src.split('\n')
  const row = findRow(lines, id)
  if (!row) return null
  const body = row.indent + '  '
  const rowLines = lines.slice(row.start, row.end)
  if (rowLines.some((l) => l.includes(`${MARK} ${id}`))) return { out: src, detail: 'already pinned' }
  const cfgIdx = rowLines.findIndex((l) => new RegExp(`^${body}config:\\s*(\\{.*\\})?\\s*$`).test(l))
  let newRow: string[]
  if (cfgIdx < 0) {
    newRow = [...rowLines, `${body}# ${MARK} ${id}: upload disabled by default`, `${body}config:`, `${body}  enabled: false`]
  } else {
    // replace whole config block (patch semantics replace config anyway) keeping other keys except `enabled`
    let k = cfgIdx + 1
    const kept: string[] = []
    while (k < rowLines.length && rowLines[k].startsWith(body + ' ')) {
      if (!/^\s*enabled\s*:/.test(rowLines[k])) kept.push(rowLines[k])
      k++
    }
    const inline = /\{(.*)\}/.exec(rowLines[cfgIdx])
    const inlineKept = inline ? inline[1].split(',').map((s) => s.trim()).filter((s) => s && !s.startsWith('enabled')) : []
    newRow = [
      ...rowLines.slice(0, cfgIdx),
      `${body}# ${MARK} ${id}: upload disabled by default`,
      `${body}config:`,
      `${body}  enabled: false`,
      ...inlineKept.map((kv) => `${body}  ${kv.replace(/\s*:\s*/, ': ')}`),
      ...kept,
      ...rowLines.slice(k),
    ]
  }
  lines.splice(row.start, row.end - row.start, ...newRow)
  return { out: lines.join('\n'), detail: `row ${id} pinned to enabled:false` }
}

function hardenTelemetryRows(src: string): { out: string; detail: string } | null {
  let out = src
  const notes: string[] = []
  // 1) env-default expression: process.env.DSH_TELEMETRY_MODE || 'FEEDBACK_ONLY'  -> 'DISABLED'
  out = out.replace(/(DSH_TELEMETRY_MODE[^\n]*?\|\|\s*)(['"])(FEEDBACK_ONLY|FULL)\2/g, (_m, a: string, q: string) => {
    notes.push('mode default -> DISABLED')
    return `${a}${q}DISABLED${q}`
  })
  // 2) literal modes inside telemetry rows
  out = out.replace(/^(\s*mode:\s*)(['"]?)(FEEDBACK_ONLY|FULL)\2\s*$/gm, (_m, a: string) => {
    notes.push('literal mode -> DISABLED')
    return `${a}DISABLED`
  })
  // 3) DeepSeek-owned collector URLs -> discard port on loopback (belt and braces; DISABLED ignores it)
  out = out.replace(/https?:\/\/[\w.-]*deepseeksvc\.com[^\s'"`]*/g, () => {
    notes.push('collector url -> blackhole')
    return 'http://127.0.0.1:9/dsh-hardened-blackhole'
  })
  // 4) disable the OTel session backend row outright
  const lines = out.split('\n')
  for (const id of ['session-telemetry-otel', 'product-telemetry-otel']) {
    const row = findRow(lines, id)
    if (!row) continue
    const body = row.indent + '  '
    const rl = lines.slice(row.start, row.end)
    if (rl.some((l) => l.includes(`${MARK} ${id} disabled`))) continue
    const disIdx = rl.findIndex((l) => new RegExp(`^${body}disabled:`).test(l))
    if (disIdx >= 0) rl[disIdx] = `${body}disabled: true # ${MARK} ${id} disabled`
    else rl.splice(1, 0, `${body}disabled: true # ${MARK} ${id} disabled`)
    lines.splice(row.start, row.end - row.start, ...rl)
    notes.push(`row ${id} disabled`)
  }
  out = lines.join('\n')
  if (notes.length === 0) return out === src ? { out, detail: 'nothing to change' } : null
  return { out, detail: [...new Set(notes)].join('; ') }
}

// ------------------------------------------------------------------------------------------ patches

// P1  session-log-deepseek: default false + env gate
edit('P1a session-log default false', 'required', 'packages/session/session-log-deepseek/src/index.ts', (src) => {
  const { out, n } = flipEnabledDefault(src)
  if (n === 0) return /default\(\s*false\s*\)/.test(src) && /\benabled\b/.test(src) ? { out: src, detail: 'already false' } : null
  return { out, detail: `enabled default true->false (${n})` }
})
edit('P1b session-log env gate', 'required', 'packages/session/session-log-deepseek/src/index.ts', (src) => {
  const r = gateApply(src, 'DSH_HARDENED_ALLOW_SESSION_LOG_UPLOAD', 'dsh_session_log upload')
  return r.ok ? { out: r.out, detail: 'apply() gated' } : null
})

// P2  plugin-package-inventory-deepseek: default false + env gate
edit('P2a inventory default false', 'required', 'packages/llm/plugin-package-inventory-deepseek/src/index.ts', (src) => {
  const { out, n } = flipEnabledDefault(src)
  if (n === 0) return /default\(\s*false\s*\)/.test(src) && /\benabled\b/.test(src) ? { out: src, detail: 'already false' } : null
  return { out, detail: `enabled default true->false (${n})` }
})
edit('P2b inventory env gate', 'required', 'packages/llm/plugin-package-inventory-deepseek/src/index.ts', (src) => {
  const r = gateApply(src, 'DSH_HARDENED_ALLOW_PLUGIN_INVENTORY', 'dsh_plugin_packages inventory')
  return r.ok ? { out: r.out, detail: 'apply() gated' } : null
})

// P3  anonymous-user-id: ephemeral per-process id, never persisted
edit('P3 ephemeral anonymous id', 'required', 'packages/identity/anonymous-user-id/src/index.ts', (src) => {
  if (src.includes(`${MARK} ephemeral-id`)) return { out: src, detail: 'already' }
  const re = /export\s+function\s+getOrCreateAnonymousUserId\s*\(/
  if (!re.test(src)) return null
  let out = src.replace(re, 'function upstreamGetOrCreateAnonymousUserId(')
  out += `

// ${MARK} ephemeral-id: the upstream id is persisted in $DSH_HOME/.anonymous-user-id and sent as
// x-deepseek-harness-user-id / OTel user.id / feedback acknowledgement. The hardened build returns a
// random per-process value and writes nothing, so no stable cross-session identifier exists.
let hardenedEphemeralUserId: string | undefined
export function getOrCreateAnonymousUserId(
  ...args: Parameters<typeof upstreamGetOrCreateAnonymousUserId>
): ReturnType<typeof upstreamGetOrCreateAnonymousUserId> {
  if (process.env.DSH_HARDENED_ALLOW_PERSISTENT_ID === '1') return upstreamGetOrCreateAnonymousUserId(...args)
  hardenedEphemeralUserId ??= globalThis.crypto.randomUUID()
  return hardenedEphemeralUserId as ReturnType<typeof upstreamGetOrCreateAnonymousUserId>
}
`
  return { out, detail: 'getOrCreateAnonymousUserId -> ephemeral, non-persistent' }
})

// P4  llm-deepseek + web-deepseek-api: route every bare fetch() through hardenedFetch
function hardenFetchPackage(id: string, level: Level, srcDir: string): void {
  const absDir = path.join(ROOT, srcDir)
  if (!fs.existsSync(absDir)) {
    outcomes.push({ id, level, file: srcDir, status: 'missing-file', detail: 'package src dir not found' })
    return
  }
  const target = path.join(absDir, 'hardened-fetch.ts')
  const helper = fs.readFileSync(path.join(HERE, 'hardened-fetch.ts'), 'utf8')
  if (!DRY && (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== helper)) fs.writeFileSync(target, helper, 'utf8')
  let total = 0
  for (const f of fs.readdirSync(absDir).filter((x) => x.endsWith('.ts') && x !== 'hardened-fetch.ts' && !x.endsWith('.d.ts'))) {
    const file = rel(path.join(absDir, f))
    edit(`${id} ${f}`, 'optional', file, (src) => {
      const { out, n } = rewriteFetch(src)
      if (n === 0) return { out: src, detail: 'no bare fetch()' }
      total += n
      return { out: addImport(out, `import { hardenedFetch } from './hardened-fetch.ts' // ${MARK}`), detail: `${n} fetch() -> hardenedFetch()` }
    })
  }
  const already = fs.readdirSync(absDir).some((x) => x.endsWith('.ts') && x !== 'hardened-fetch.ts' && fs.readFileSync(path.join(absDir, x), 'utf8').includes('hardenedFetch('))
  outcomes.push({
    id, level, file: srcDir,
    status: total > 0 ? 'applied' : already ? 'already' : 'anchor-not-found',
    detail: total > 0 ? `${total} call sites routed through hardenedFetch` : already ? 'already routed' : 'no fetch() call site found — transport moved? review manually',
  })
}
hardenFetchPackage('P4a llm-deepseek fetch', 'required', 'packages/llm/llm-deepseek/src')
hardenFetchPackage('P4b web-deepseek-api fetch', 'optional', 'packages/web/web-deepseek-api/src')

// P5  remove the persistent-id header literal at the source as well (defence in depth)
edit('P5 drop user-id header line', 'optional', 'packages/llm/llm-deepseek/src/adapter.ts', (src) => {
  const re = /^[ \t]*['"]x-deepseek-harness-user-id['"]\s*:[^\n]*\n/m
  if (src.includes(`${MARK} x-deepseek-harness-user-id removed`)) return { out: src, detail: 'already removed' }
  if (!re.test(src)) return src.includes('x-deepseek-harness-user-id') ? null : { out: src, detail: 'header literal absent' }
  return { out: src.replace(re, (l) => `${l.match(/^[ \t]*/)![0]}// ${MARK} x-deepseek-harness-user-id removed\n`), detail: 'header line removed' }
})

// P6  bundle composition: telemetry rows DISABLED, collector URLs blackholed, upload rows pinned false
const bundleDir = path.join(ROOT, 'packages/bundle')
let sawSessionLogRow = false
if (fs.existsSync(bundleDir)) {
  for (const b of fs.readdirSync(bundleDir)) {
    const f = `packages/bundle/${b}/cordis.patch.yml`
    if (!fs.existsSync(path.join(ROOT, f))) continue
    edit(`P6 telemetry ${b}`, 'optional', f, (src) => hardenTelemetryRows(src))
    for (const id of ['session-log-deepseek', 'plugin-package-inventory-deepseek']) {
      edit(`P6 ${id} ${b}`, 'optional', f, (src) => {
        const r = setRowConfigEnabledFalse(src, id)
        if (r) sawSessionLogRow ||= id === 'session-log-deepseek'
        return r ?? { out: src, detail: 'row not in this bundle' }
      })
    }
  }
}
outcomes.push({
  id: 'P6 base rows present', level: 'required', file: 'packages/bundle/*/cordis.patch.yml',
  status: sawSessionLogRow ? 'already' : 'anchor-not-found',
  detail: sawSessionLogRow ? 'session-log-deepseek row pinned in bundle layer' : 'session-log-deepseek row not found in any bundle',
})

// P7  web search: do not forward the user's original question to the search provider
for (const dir of ['packages/web/web-deepseek-api/src', 'packages/web/web-search-deepseek/src']) {
  const abs = path.join(ROOT, dir)
  if (!fs.existsSync(abs)) continue
  for (const f of fs.readdirSync(abs).filter((x) => x.endsWith('.ts') && x !== 'hardened-fetch.ts')) {
    edit(`P7 sendOriginalQuestion ${f}`, 'optional', rel(path.join(abs, f)), (src) => {
      if (!src.includes('sendOriginalQuestion')) return { out: src, detail: 'n/a' }
      const out = src.replace(/(sendOriginalQuestion\s*:\s*[\w$.]*boolean\(\)(?:\s*\.\s*[\w$]+\([^()]*\))*?\s*\.\s*default\(\s*)true(\s*\))/g, '$1false$2')
      return { out, detail: out === src ? 'no default(true) found' : 'sendOriginalQuestion default -> false' }
    })
  }
}

// ------------------------------------------------------------------------------------------ report
const failed = outcomes.filter((o) => (o.level === 'required' || STRICT) && (o.status === 'anchor-not-found' || (o.level === 'required' && o.status === 'missing-file')))
const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length))
for (const o of outcomes) {
  const icon = o.status === 'applied' ? 'APPLY' : o.status === 'already' ? 'OK   ' : o.level === 'required' ? 'FAIL ' : 'skip '
  console.log(`${icon} ${pad(o.id, 44)} ${pad(o.status, 17)} ${o.file}  — ${o.detail}`)
}
if (!DRY) {
  const dir = path.join(ROOT, 'hardening')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'HARDENING-REPORT.json'), JSON.stringify({ generated: new Date().toISOString(), root: ROOT, outcomes }, null, 2) + '\n')
}
if (failed.length) {
  console.error(`\n${failed.length} required patch(es) did not anchor. Upstream drifted — review before building.`)
  process.exit(2)
}
console.log(`\nhardening ${DRY ? 'dry-run ' : ''}complete: ${outcomes.filter((o) => o.status === 'applied').length} applied, ${outcomes.filter((o) => o.status === 'already').length} already in place`)
