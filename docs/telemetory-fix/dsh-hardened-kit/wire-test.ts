/**
 * wire-test.ts — end-to-end wire check for a DSH build (stock + overlay, or the hardened fork).
 *
 * Starts a local mock of the DeepSeek Messages API, points DSH at it with DEEPSEEK_BASE_URL and a dummy
 * key, runs ONE headless job, and inspects what actually went over the wire. No real credentials, no
 * real network: the guard (audit mode by default) records any attempt to reach other hosts.
 *
 *   node wire-test.ts --entry "C:/nvm4w/nodejs/node_modules/@deepseek-ai/dsh/<bin>.js"
 *   node wire-test.ts --cmd "pnpm dsh"                  # inside a fork checkout
 *   options:
 *     --profile headless          (default headless)
 *     --patch <file.yml>          extra --patch overlay passed to dsh
 *     --guard audit|enforce|off   (default audit: measure the build itself, do not fix it)
 *     --no-env-optout             do NOT set DSH_TELEMETRY_DISABLED / DSH_TELEMETRY_MODE (tests fork defaults)
 *     --timeout <sec>             (default 120)
 *     --json <file>               write machine-readable result
 * Exit 0 = PASS, 1 = FAIL, 3 = inconclusive (no model request captured).
 */
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const argv = process.argv.slice(2)
const opt = (n: string, d?: string) => {
  const i = argv.indexOf(n)
  return i >= 0 ? argv[i + 1] : d
}
const has = (n: string) => argv.includes(n)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const CANARY = `DSH_WIRE_CANARY_${Date.now().toString(36).toUpperCase()}`
const profile = opt('--profile', 'headless')!
const guardMode = opt('--guard', 'audit')!
const timeoutSec = Number(opt('--timeout', '120'))
const entryRaw = opt('--entry')
const entry = entryRaw ? path.resolve(entryRaw) : undefined
const cmd = opt('--cmd')
const patch = opt('--patch')
if (!entry && !cmd) {
  console.error('need --entry <dsh js entry> or --cmd "<command>"')
  process.exit(64)
}

interface Seen {
  method: string
  path: string
  headerNames: string[]
  harnessHeaders: string[]
  bodyKeys: string[]
  dshFields: Record<string, number>
  bodyBytes: number
  canaryInMessages: boolean
  canaryInDshFields: boolean
}
const seen: Seen[] = []

function sse(res: http.ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  const ev = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  ev('message_start', { message: { id: 'msg_wiretest', type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } })
  ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
  ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'OK' } })
  ev('content_block_stop', { index: 0 })
  ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
  ev('message_stop', {})
  res.end()
}

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => chunks.push(c))
  req.on('end', () => {
    const raw = Buffer.concat(chunks)
    let body: Record<string, unknown> = {}
    try {
      body = JSON.parse(raw.toString('utf8') || '{}')
    } catch {
      /* non-JSON (e.g. multipart upload) */
    }
    const dshFields: Record<string, number> = {}
    let canaryInDsh = false
    for (const [k, v] of Object.entries(body)) {
      if (!k.startsWith('dsh_')) continue
      const s = JSON.stringify(v)
      dshFields[k] = Buffer.byteLength(s)
      if (s.includes(CANARY)) canaryInDsh = true
    }
    const names = Object.keys(req.headers)
    seen.push({
      method: req.method ?? '',
      path: (req.url ?? '').split('?')[0],
      headerNames: names,
      harnessHeaders: names.filter((n) => n.startsWith('x-deepseek-harness-')),
      bodyKeys: Object.keys(body),
      dshFields,
      bodyBytes: raw.length,
      canaryInMessages: JSON.stringify(body.messages ?? '').includes(CANARY),
      canaryInDshFields: canaryInDsh,
    })
    if (req.method === 'GET' && /models/.test(req.url ?? '')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-flash', object: 'model' }] }))
      return
    }
    sse(res)
  })
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
const port = (server.address() as net.AddressInfo).port
const base = `http://127.0.0.1:${port}`

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wiretest-home-'))
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wiretest-ws-'))
fs.writeFileSync(path.join(work, 'NOTE.txt'), `${CANARY} fake secret: sk-NOT-A-REAL-KEY-0000\n`)
const auditLog = path.join(home, 'egress-audit.jsonl')

const env: NodeJS.ProcessEnv = {
  ...process.env,
  DSH_HOME: home,
  DEEPSEEK_BASE_URL: base,
  DEEPSEEK_API_KEY: 'sk-wiretest-dummy',
  DSH_EGRESS_LOG: auditLog,
  DSH_EGRESS_QUIET: '1',
  NO_COLOR: '1',
}
if (!has('--no-env-optout')) {
  env.DSH_TELEMETRY_DISABLED = '1'
  env.DSH_TELEMETRY_MODE = 'DISABLED'
}
const guardUrl = pathToFileURL(path.join(HERE, 'egress-guard.ts')).href
if (guardMode !== 'off') {
  env.DSH_EGRESS_MODE = guardMode
  env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --import=${guardUrl}`.trim()
}
const job = `Read NOTE.txt in the workspace and reply with the single word OK. ${CANARY}`
const dshArgs = ['--profile', profile, ...(patch ? ['--patch', path.resolve(patch)] : []), job]

const child = entry
  ? spawn(process.execPath, [entry, ...dshArgs], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] })
  : spawn(`${cmd} ${dshArgs.map((a) => JSON.stringify(a)).join(' ')}`, { cwd: work, env, shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''
child.stdout?.on('data', (d) => (out += d))
child.stderr?.on('data', (d) => (out += d))

const started = Date.now()
await new Promise<void>((resolve) => {
  let settleTimer: NodeJS.Timeout | undefined
  const tick = setInterval(() => {
    const llm = seen.filter((s) => s.method === 'POST')
    if (llm.length > 0 && !settleTimer) settleTimer = setTimeout(done, 4000)
    if (Date.now() - started > timeoutSec * 1000) done()
  }, 250)
  child.on('exit', () => setTimeout(done, 1500))
  let fired = false
  function done() {
    if (fired) return
    fired = true
    clearInterval(tick)
    if (settleTimer) clearTimeout(settleTimer)
    if (child.exitCode === null) child.kill()
    resolve()
  }
})
server.close()

// ------------------------------------------------------------------ evaluate
type Verdict = 'PASS' | 'FAIL' | 'WARN' | 'INFO'
const checks: { verdict: Verdict; name: string; detail: string }[] = []
const add = (verdict: Verdict, name: string, detail: string) => checks.push({ verdict, name, detail })
const posts = seen.filter((s) => s.method === 'POST')

if (posts.length === 0) {
  add('WARN', 'model request captured', 'no POST reached the mock — check --entry/--cmd, profile, or that the provider honours DEEPSEEK_BASE_URL')
} else {
  add('INFO', 'model request captured', `${posts.length} POST(s): ${[...new Set(posts.map((p) => p.path))].join(', ')}`)
  const dsh = posts.flatMap((p) => Object.entries(p.dshFields))
  add(dsh.length === 0 ? 'PASS' : 'FAIL', 'no dsh_* body fields', dsh.length === 0 ? 'none' : dsh.map(([k, b]) => `${k}=${b}B`).join(', '))
  const hh = [...new Set(posts.flatMap((p) => p.harnessHeaders))]
  const hhBad = hh.filter((h) => h !== 'x-deepseek-harness-session-id')
  add(hhBad.length === 0 ? 'PASS' : 'FAIL', 'no x-deepseek-harness-* identity headers', hh.length === 0 ? 'none' : hh.join(', '))
  const leaked = posts.some((p) => p.canaryInDshFields)
  add(leaked ? 'FAIL' : 'PASS', 'canary not in side-channel fields', leaked ? 'canary found inside dsh_* field(s)' : posts.some((p) => p.canaryInMessages) ? 'canary only in model messages (expected: normal inference input)' : 'canary absent')
}
const audit = fs.existsSync(auditLog) ? fs.readFileSync(auditLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
const foreign = audit.filter((r: { host: string }) => !['127.0.0.1', 'localhost', '::1'].includes(r.host))
const telemetry = foreign.filter((r: { host: string }) => /deepseeksvc\.com$/.test(r.host))
if (guardMode === 'off') add('INFO', 'egress audit', 'guard off — host-level attempts not observed')
else {
  const hosts = [...new Set(telemetry.map((r: { host: string }) => r.host))].join(', ')
  if (telemetry.length === 0) add('PASS', 'no attempt to reach *.deepseeksvc.com', 'none')
  else if (guardMode === 'enforce') add('WARN', 'no attempt to reach *.deepseeksvc.com', `attempted but BLOCKED by guard: ${hosts} (the build itself still tries — fix config/fork)`)
  else add('FAIL', 'no attempt to reach *.deepseeksvc.com', hosts)
  add(foreign.length === 0 ? 'PASS' : 'WARN', 'no other non-loopback egress', foreign.length === 0 ? 'none' : [...new Set(foreign.map((r: { host: string; layer: string }) => `${r.layer}:${r.host}`))].join(', '))
}
const idFile = path.join(home, '.anonymous-user-id')
add(fs.existsSync(idFile) ? 'WARN' : 'PASS', 'no persistent .anonymous-user-id', fs.existsSync(idFile) ? 'created (stock behaviour; hardened fork should not create it)' : 'not created')

const pad = (s: string, n: number) => (s + ' '.repeat(n)).slice(0, n)
console.log(`\nDSH wire test — profile=${profile} guard=${guardMode} env-optout=${!has('--no-env-optout')} mock=${base}`)
for (const c of checks) console.log(`${pad(c.verdict, 5)} ${pad(c.name, 44)} ${c.detail}`)
const fail = checks.some((c) => c.verdict === 'FAIL')
const inconclusive = posts.length === 0
if (opt('--json')) fs.writeFileSync(opt('--json')!, JSON.stringify({ profile, guardMode, checks, requests: seen, audit: foreign }, null, 2))
if (has('--verbose') || inconclusive) console.log('\n--- dsh output (tail) ---\n' + out.split('\n').slice(-40).join('\n'))
fs.rmSync(work, { recursive: true, force: true })
if (!has('--keep-home')) fs.rmSync(home, { recursive: true, force: true })
console.log(`\nRESULT: ${fail ? 'FAIL' : inconclusive ? 'INCONCLUSIVE' : 'PASS'}`)
process.exit(fail ? 1 : inconclusive ? 3 : 0)
