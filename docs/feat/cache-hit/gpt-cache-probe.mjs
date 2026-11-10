#!/usr/bin/env node
// Probes GitHub Copilot GPT prompt-cache behavior (docs/feat/gpt-warmer-design.md, section 6).
// Usage: node gpt-cache-probe.mjs quick|timed [--model gpt-6.1-sol] [--minutes 20]
// Reads the Copilot API token from ~/.dsh/.credentials.yaml (llm-pi-ai/github-copilot access); never prints it.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const args = process.argv.slice(2)
const mode = args[0] ?? 'quick'
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt }
const model = opt('model', 'gpt-6.1-sol')
const pingAfterMin = Number(opt('minutes', '20'))

const creds = readFileSync(join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.credentials.yaml'), 'utf8')
const section = creds.slice(creds.indexOf('llm-pi-ai/github-copilot:'))
const token = /\n\s+access:\s*(\S+)/.exec(section)?.[1]
if (!token) throw new Error('Copilot access token not found in .credentials.yaml')
const exp = Number(/exp=(\d+)/.exec(token)?.[1] ?? 0) * 1000
const proxy = /proxy-ep=([^;]+)/.exec(token)?.[1] ?? 'proxy.individual.githubcopilot.com'
const baseUrl = `https://${proxy.replace(/^proxy\./, 'api.')}`
const needMs = mode === 'timed' ? (2 * pingAfterMin + 5) * 60_000 : 5 * 60_000
if (exp && exp - Date.now() < needMs) throw new Error(`Copilot token expires at ${new Date(exp).toISOString()}; open DSH once to refresh it`)

const WORDS = 'alpha beta gamma delta epsilon zeta theta kappa lambda sigma omega river stone cloud forest signal buffer packet thread kernel vector matrix tensor socket cursor ledger harbor lantern meadow pepper copper silver violet amber cobalt orbit quartz rocket saddle tunnel velvet walnut yonder zephyr'.split(' ')
function prefix(seed, words = 26000) {
  let x = 0
  for (const c of seed) x = (x * 31 + c.charCodeAt(0)) >>> 0
  const out = [`Reference corpus ${seed}.`]
  for (let i = 0; i < words; i++) {
    x = (x * 1103515245 + 12345) >>> 0
    out.push(WORDS[x % WORDS.length] + (i % 17 === 16 ? '.\n' : ''))
  }
  return out.join(' ')
}

async function call(label, seed, extra = {}, question = 'Reply with the single word OK.') {
  const body = {
    model,
    instructions: 'You are a terse assistant used for a cache test.',
    input: [
      { role: 'user', content: [{ type: 'input_text', text: prefix(seed) }] },
      { role: 'user', content: [{ type: 'input_text', text: question }] },
    ],
    reasoning: { effort: 'low' },
    max_output_tokens: 256,
    store: false,
    stream: true,
    prompt_cache_key: `probe-${seed}`.slice(0, 64),
    ...extra,
  }
  for (const [k, v] of Object.entries(body)) if (v === undefined) delete body[k]
  const t0 = Date.now()
  const res = await fetch(`${baseUrl}/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'GitHubCopilotChat/0.35.0',
      'Editor-Version': 'vscode/1.107.0',
      'Editor-Plugin-Version': 'copilot-chat/0.35.0',
      'Copilot-Integration-Id': 'vscode-chat',
      'X-Initiator': 'agent',
      'Openai-Intent': 'conversation-edits',
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let final
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue
    try {
      const ev = JSON.parse(line.slice(6))
      if (ev.response?.usage || ev.response?.status) final = ev.response
    } catch { /* non-JSON keepalive line: ignored */ }
  }
  const sent = Object.keys(extra).map(k => `${k}=${JSON.stringify(extra[k])}`).join(' ')
  console.log(`\n[${new Date().toISOString()}] ${label}  (${Date.now() - t0} ms)  HTTP ${res.status}  ${sent}`)
  if (!res.ok) { console.log('  body:', text.slice(0, 600)); return undefined }
  const u = final?.usage
  console.log(`  status=${final?.status} incomplete=${JSON.stringify(final?.incomplete_details ?? null)}`)
  console.log(`  usage=${JSON.stringify(u)}`)
  const cacheEcho = Object.fromEntries(Object.entries(final ?? {}).filter(([k]) => /cache/i.test(k)))
  if (Object.keys(cacheEcho).length) console.log(`  echoed=${JSON.stringify(cacheEcho)}`)
  return u
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
const run = randomUUID().slice(0, 8)
console.log(`model=${model} baseUrl=${baseUrl} run=${run} tokenExpires=${new Date(exp).toISOString()}`)

if (mode === 'quick') {
  // 1 + 6: default parameters as pi-ai sends them for cacheRetention long (no explicit mode), then a repeat.
  await call('1a default write', `${run}-a`, { prompt_cache_retention: '24h' })
  await sleep(3000)
  await call('1b default repeat (expect read)', `${run}-a`, { prompt_cache_retention: '24h' })
  // 1 without any retention field.
  await call('1c no retention field', `${run}-n`)
  await sleep(3000)
  await call('1d no retention repeat', `${run}-n`)
  // 5: explicit options.
  await call('5a prompt_cache_options ttl=30m', `${run}-b`, { prompt_cache_options: { mode: 'implicit', ttl: '30m' } })
  await sleep(3000)
  await call('5b ttl=30m repeat', `${run}-b`, { prompt_cache_options: { mode: 'implicit', ttl: '30m' } })
  await call('5c prompt_cache_options ttl=12h', `${run}-c`, { prompt_cache_options: { mode: 'implicit', ttl: '12h' } })
  await sleep(3000)
  await call('5d ttl=12h repeat', `${run}-c`, { prompt_cache_options: { mode: 'implicit', ttl: '12h' } })
  // 4: ping-sized output limit on a warm prefix.
  await call('4a ping max_output_tokens=16', `${run}-a`, { prompt_cache_retention: '24h', max_output_tokens: 16 })
} else if (mode === 'timed') {
  // 2 + 3: X is pinged at +N min; Y is not. Both are re-requested at +2N min.
  await call('X write', `${run}-x`, { prompt_cache_retention: '24h' })
  await call('Y write', `${run}-y`, { prompt_cache_retention: '24h' })
  await call('Z write (ttl=12h)', `${run}-z`, { prompt_cache_options: { mode: 'implicit', ttl: '12h' } })
  await sleep(pingAfterMin * 60_000)
  await call(`X ping at +${pingAfterMin}m (max_output_tokens=16)`, `${run}-x`, { prompt_cache_retention: '24h', max_output_tokens: 16 })
  await sleep(pingAfterMin * 60_000)
  await call(`X real at +${2 * pingAfterMin}m (pinged)`, `${run}-x`, { prompt_cache_retention: '24h' })
  await call(`Y real at +${2 * pingAfterMin}m (not pinged)`, `${run}-y`, { prompt_cache_retention: '24h' })
  await call(`Z real at +${2 * pingAfterMin}m (ttl=12h, not pinged)`, `${run}-z`, { prompt_cache_options: { mode: 'implicit', ttl: '12h' } })
} else {
  throw new Error(`unknown mode ${mode}`)
}
