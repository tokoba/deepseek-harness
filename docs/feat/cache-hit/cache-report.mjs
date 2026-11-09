// Prompt-cache report over DSH Session logs (~/.dsh/sessions/**/session.v4.jsonl.zstd).
// Usage: node docs/feat/cache-hit/cache-report.mjs [sessionIdPrefix] [--ttl-min 60] [--root <dir>] [--detail]
// --root defaults to <home>/.dsh/sessions of the user running node.
// For every main request (assistant/message usage) and compaction summary it reports
// cache read/write tokens, and classifies a request as cold when its cache read is below
// half of the previous request's prefix. The cause is the first matching rule:
// model-changed, effort-changed, compaction, tool-result-pruned (compaction/prune rewrote
// earlier tool results), ttl-expired (gap > TTL), otherwise
// prefix-or-provider (prefix changed before the last breakpoint, or the provider evicted).
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import os from 'node:os'

const args = process.argv.slice(2)
const valued = new Set(['--ttl-min', '--root'])
const filter = args.find((arg, i) => !arg.startsWith('--') && !valued.has(args[i - 1]))
const ttlMin = Number(args[args.indexOf('--ttl-min') + 1] ?? 5) || 5
const ttlMs = (args.includes('--ttl-min') ? ttlMin : 5) * 60_000
const detail = args.includes('--detail')
const rootIndex = args.indexOf('--root')
const root = rootIndex >= 0 ? args[rootIndex + 1] : path.join(os.homedir(), '.dsh', 'sessions')
if (!fs.existsSync(root)) {
  console.error(`sessions directory not found: ${root} (pass --root <dir>/.dsh/sessions)`)
  process.exit(1)
}
console.log(`sessions: ${root}`)

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? files(full) : full.endsWith('.jsonl.zstd') ? [full] : []
  })
}

// The log is a sequence of independent zstd frames.
function readLog(file) {
  const bytes = fs.readFileSync(file)
  const starts = []
  for (let i = 0; i < bytes.length - 3; i++) {
    if (bytes[i] === 0x28 && bytes[i + 1] === 0xb5 && bytes[i + 2] === 0x2f && bytes[i + 3] === 0xfd) starts.push(i)
  }
  starts.push(bytes.length)
  let text = ''
  let begin = 0
  for (let k = 1; k < starts.length; k++) {
    try {
      text += zlib.zstdDecompressSync(bytes.subarray(begin, starts[k])).toString()
      begin = starts[k]
    } catch {
      // A magic-number match inside compressed data is not a frame start; extend the slice.
    }
  }
  return text.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
}

const PRICE = { // USD per 1M tokens: input, cacheRead, cacheWrite (catalog values)
  'claude-opus-5.5': [4, 0.2, 5], 'claude-sonnet-5.5': [2, 0.1, 2.5], 'claude-opus-5': [5, 0.5, 6.25],
}

const totals = { read: 0, write: 0, input: 0, requests: 0, cold: 0, lostCredits: 0, causes: {} }
for (const file of files(root)) {
  const id = path.basename(path.dirname(file))
  if (filter !== undefined && !id.includes(filter)) continue
  let config = {}
  let prev
  let compacted = false
  let pruned = false
  const rows = []
  for (const event of readLog(file)) {
    if (event.type === 'request/header') config = event.data?.header?.config ?? {}
    if (event.type === 'compaction/end') compacted = true
    if (event.type === 'compaction/prune') pruned = true
    const isSummary = event.type === 'compaction/summary'
    const usage = event.type === 'assistant/message' ? event.data?.usage : isSummary ? event.data?.usage : undefined
    if (usage === undefined) continue
    const read = usage.cacheReadTokens ?? 0
    const write = usage.cacheWriteTokens ?? 0
    const input = usage.inputTokens ?? 0
    const prefix = read + write + input
    const model = isSummary ? event.data.model : config.model
    let cause
    if (prev !== undefined && prev.prefix >= 1024 && read < 0.5 * prev.prefix) {
      if (model !== prev.model) cause = 'model-changed'
      else if (!isSummary && config.reasoningEffort !== prev.effort) cause = 'effort-changed'
      else if (isSummary) cause = 'compaction-request'
      else if (compacted) cause = 'after-compaction'
      else if (pruned) cause = 'tool-result-pruned'
      else if (event.time - prev.time > ttlMs) cause = 'ttl-expired'
      else cause = 'prefix-or-provider'
    }
    const price = PRICE[model]
    const lost = cause !== undefined && price !== undefined ? (write * (price[2] - price[1])) / 1e6 * 100 : 0
    rows.push({ time: new Date(event.time).toISOString(), kind: isSummary ? 'summary' : 'turn', model, read, write, input, gapS: prev ? Math.round((event.time - prev.time) / 1000) : 0, cause: cause ?? '' })
    totals.read += read; totals.write += write; totals.input += input; totals.requests++
    if (cause !== undefined) { totals.cold++; totals.lostCredits += lost; totals.causes[cause] = (totals.causes[cause] ?? 0) + 1 }
    prev = { prefix, model, effort: config.reasoningEffort, time: event.time }
    compacted = false
    pruned = false
  }
  if (rows.length === 0) continue
  const read = rows.reduce((sum, row) => sum + row.read, 0)
  const all = rows.reduce((sum, row) => sum + row.read + row.write + row.input, 0)
  console.log(`${id}: ${rows.length} requests, hit ${(100 * read / Math.max(1, all)).toFixed(1)}%, cold ${rows.filter(row => row.cause).length}`)
  if (detail) console.table(rows)
  else for (const row of rows.filter(r => r.cause)) console.log(`  ${row.time} ${row.kind} ${row.model} gap=${row.gapS}s read=${row.read} write=${row.write} -> ${row.cause}`)
}
const all = totals.read + totals.write + totals.input
console.log(`\nTOTAL requests=${totals.requests} hit=${(100 * totals.read / Math.max(1, all)).toFixed(1)}% cold=${totals.cold} estimated loss=${totals.lostCredits.toFixed(1)} credits`)
console.log('causes:', totals.causes)
