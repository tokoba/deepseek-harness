/**
 * Self-test for egress-guard.ts — no network, no DSH required.
 *   node egress-guard.selftest.ts
 * Exit code 0 = all assertions passed.
 */
import { configureEgressGuard, stripJsonBody, decide, currentPolicy } from './egress-guard.ts'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import dns from 'node:dns'
import zlib from 'node:zlib'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const CANARY = 'DSH_PRIVACY_CANARY_7F4E2C9A'
const logFile = path.join(os.tmpdir(), `dsh-egress-selftest-${process.pid}.jsonl`)
configureEgressGuard({ logFile, quiet: true, mode: 'enforce', allow: null })

type Captured = { headers: http.IncomingHttpHeaders; body: Buffer; url: string }
const captured: Captured[] = []
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => chunks.push(c))
  req.on('end', () => {
    captured.push({ headers: req.headers, body: Buffer.concat(chunks), url: req.url ?? '' })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
const port = (server.address() as net.AddressInfo).port
const base = `http://127.0.0.1:${port}`

const payload = {
  model: 'deepseek-flash',
  messages: [{ role: 'user', content: 'hello' }],
  dsh_session_log: { sessionFormatVersion: 4, events: [{ type: 'tool/result', data: CANARY }] },
  dsh_plugin_packages: [{ name: '@corp/secret-plugin', version: '1.0.0' }],
}
const harnessHeaders = {
  'content-type': 'application/json',
  authorization: 'Bearer sk-test',
  'x-deepseek-harness-user-id': '11111111-2222-4333-8444-555555555555',
  'x-deepseek-harness-session-id': 'session-abc',
  'x-deepseek-harness-compact': '1',
}
let passed = 0
const ok = (name: string) => {
  passed++
  console.log(`  ok  ${name}`)
}

// 1. fetch(string, init) with JSON string body
{
  const r = await fetch(`${base}/anthropic/v1/messages`, { method: 'POST', headers: harnessHeaders, body: JSON.stringify(payload) })
  assert.equal(r.status, 200)
  const c = captured.at(-1)!
  const body = JSON.parse(c.body.toString('utf8'))
  assert.equal('dsh_session_log' in body, false)
  assert.equal('dsh_plugin_packages' in body, false)
  assert.deepEqual(body.messages, payload.messages)
  assert.equal(c.headers['x-deepseek-harness-user-id'], undefined)
  assert.equal(c.headers['x-deepseek-harness-session-id'], undefined)
  assert.equal(c.headers['x-deepseek-harness-compact'], undefined)
  assert.equal(c.headers.authorization, 'Bearer sk-test')
  assert.equal(c.body.includes(CANARY), false)
  ok('fetch(string) strips dsh_* body keys and x-deepseek-harness-* headers, keeps auth')
}

// 2. fetch(Request) with Uint8Array body
{
  const req = new Request(`${base}/v1/messages`, { method: 'POST', headers: harnessHeaders, body: new TextEncoder().encode(JSON.stringify(payload)) })
  await fetch(req)
  const c = captured.at(-1)!
  assert.equal(c.body.includes('dsh_session_log'), false)
  assert.equal(c.headers['x-deepseek-harness-user-id'], undefined)
  ok('fetch(Request) path strips body + headers')
}

// 3. gzip-encoded JSON body
{
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(payload)))
  await fetch(`${base}/v1/messages`, { method: 'POST', headers: { ...harnessHeaders, 'content-encoding': 'gzip' }, body: gz })
  const c = captured.at(-1)!
  const body = JSON.parse(zlib.gunzipSync(c.body).toString('utf8'))
  assert.equal('dsh_session_log' in body, false)
  ok('gzip body is decoded, stripped and re-encoded')
}

// 4. session-id header kept only for configured host
{
  configureEgressGuard({ sessionHeaderHosts: ['127.0.0.1'] })
  await fetch(`${base}/v1/messages`, { method: 'POST', headers: harnessHeaders, body: '{}' })
  const c = captured.at(-1)!
  assert.equal(c.headers['x-deepseek-harness-session-id'], 'session-abc')
  assert.equal(c.headers['x-deepseek-harness-user-id'], undefined)
  configureEgressGuard({ sessionHeaderHosts: [] })
  ok('x-deepseek-harness-session-id kept only for explicitly allowed host; user-id always removed')
}

// 5. telemetry collector via fetch is blocked before any socket
{
  await assert.rejects(
    fetch('https://harness-telemetry.deepseeksvc.com/v1/logs', { method: 'POST', body: '{}' }),
    (e: Error & { cause?: { code?: string } }) => e.cause?.code === 'EGRESS_BLOCKED',
  )
  await assert.rejects(fetch('https://dsh-otel-collector.deepseeksvc.com/v1/logs', { method: 'POST', body: '{}' }))
  ok('fetch to *.deepseeksvc.com rejected (EGRESS_BLOCKED)')
}

// 6. https.request (OTLP/HTTP exporter path) is blocked and emits error, no crash
{
  const err = await new Promise<Error>((resolve) => {
    const req = https.request({ hostname: 'dsh-otel-collector.deepseeksvc.com', port: 443, path: '/v1/logs', method: 'POST' })
    req.on('error', resolve)
    req.end('{}')
  })
  assert.equal((err as Error & { code?: string }).code, 'EGRESS_BLOCKED')
  // no listener attached by caller: must not crash the process
  https.get('https://harness-telemetry.deepseeksvc.com/v1/logs')
  await new Promise((r) => setTimeout(r, 50))
  ok('https.request / https.get blocked with error event, unlistened error does not crash')
}

// 7. named-import binding also patched (syncBuiltinESMExports)
{
  const { request } = await import('node:https')
  const err = await new Promise<Error>((resolve) => {
    const req = request('https://x.deepseeksvc.com/v1/logs', { method: 'POST' })
    req.on('error', resolve)
    req.end()
  })
  assert.equal((err as Error & { code?: string }).code, 'EGRESS_BLOCKED')
  ok('named ESM import { request } from node:https is guarded')
}

// 8. DNS layer + raw net.connect
{
  await assert.rejects(dns.promises.lookup('harness-telemetry.deepseeksvc.com'), (e: NodeJS.ErrnoException) => e.code === 'ENOTFOUND')
  const err = await new Promise<NodeJS.ErrnoException>((resolve) => {
    const s = net.connect({ host: 'dsh-otel-collector.deepseeksvc.com', port: 443 })
    s.on('error', resolve)
  })
  assert.equal(err.code, 'ENOTFOUND')
  ok('dns.lookup / dns.promises.lookup / net.connect cannot resolve deny-listed hosts')
}

// 9. strict allow-list
{
  configureEgressGuard({ allow: ['api.deepseek.com', '*.npmjs.org'] })
  assert.equal(decide('api.deepseek.com').decision, 'allow')
  assert.equal(decide('registry.npmjs.org').decision, 'allow')
  assert.equal(decide('evil.example.com').decision, 'deny')
  assert.equal(decide('localhost').decision, 'allow')
  assert.equal(decide('harness-telemetry.deepseeksvc.com').decision, 'deny')
  await assert.rejects(fetch('https://evil.example.com/'))
  configureEgressGuard({ allow: null })
  ok('strict allow-list denies everything else, loopback always allowed, deny-list wins')
}

// 10. non-JSON and array bodies untouched
{
  const h = new Headers({ 'content-type': 'text/plain' })
  assert.equal(stripJsonBody('dsh_session_log=1', h).changed, false)
  assert.equal(stripJsonBody('[{"dsh_session_log":1}]', new Headers({ 'content-type': 'application/json' })).changed, false)
  ok('non-JSON / non-object bodies are passed through unchanged')
}

// 11. audit mode never modifies
{
  configureEgressGuard({ mode: 'audit' })
  await fetch(`${base}/v1/messages`, { method: 'POST', headers: harnessHeaders, body: JSON.stringify(payload) })
  const c = captured.at(-1)!
  assert.equal(c.body.includes('dsh_session_log'), true)
  configureEgressGuard({ mode: 'enforce' })
  ok('audit mode logs but does not modify (for baseline measurement)')
}

// 12. audit log is metadata-only
{
  const log = fs.readFileSync(logFile, 'utf8')
  assert.equal(log.includes(CANARY), false)
  assert.equal(log.includes('sk-test'), false)
  assert.equal(log.includes('11111111-2222'), false)
  const recs = log.trim().split('\n').map((l) => JSON.parse(l))
  assert.ok(recs.some((r) => r.decision === 'modified' && r.removedBodyKeys?.includes('dsh_session_log')))
  assert.ok(recs.some((r) => r.decision === 'deny' && r.layer === 'http'))
  ok(`audit log has ${recs.length} metadata-only records (no canary, no token, no id values)`)
}

server.close()
fs.rmSync(logFile, { force: true })
console.log(`\nALL ${passed} CHECKS PASSED  (guard policy mode=${currentPolicy().mode})`)
