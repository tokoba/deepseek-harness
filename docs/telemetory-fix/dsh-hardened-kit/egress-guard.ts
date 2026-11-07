/**
 * dsh-egress-guard — process-wide outbound privacy guard for DeepSeek Harness (DSH).
 *
 * Load BEFORE any DSH code:
 *   node --import file:///C:/tools/dsh-hardened/egress-guard.ts <dsh-entry> --profile web
 *   (or NODE_OPTIONS="--import=file:///C:/tools/dsh-hardened/egress-guard.ts")
 *
 * Node >= 22.18 / 24 strips erasable TypeScript natively; this file uses erasable syntax only.
 * Keep it OUTSIDE node_modules (Node refuses to strip types under node_modules).
 *
 * Layers (all independent of DSH internals, so they survive upstream refactors):
 *   L1 fetch     : strip top-level `dsh_*` JSON body fields (dsh_session_log, dsh_plugin_packages, ...)
 *                  and `x-deepseek-harness-*` headers; deny-list / allow-list by host.
 *   L2 http(s)   : deny/allow by host for node:http / node:https (OTLP/HTTP exporter path).
 *   L3 dns       : deny-listed hostnames never resolve (catches undici / net / tls / anything else).
 *   Audit        : metadata-only JSONL (host, path, header NAMES, removed keys, sizes). No bodies, no values.
 *
 * Environment:
 *   DSH_EGRESS_MODE        enforce (default) | audit        audit = log only, never modify/block
 *   DSH_EGRESS_ALLOW       comma list: host | *.suffix      when set => strict allow-list (loopback always allowed)
 *   DSH_EGRESS_DENY        comma list, added to built-in deny (*.deepseeksvc.com)
 *   DSH_EGRESS_SESSION_HEADER_HOSTS  hosts that may receive x-deepseek-harness-session-id (default: none)
 *   DSH_EGRESS_STRIP_BODY_PREFIX     default "dsh_"
 *   DSH_EGRESS_LOG         path of JSONL audit log (default: none)
 *   DSH_EGRESS_QUIET       1 = no stderr notices
 *   DSH_EGRESS_PROPAGATE   1 (default) = also guard worker_threads and child Node processes (via NODE_OPTIONS)
 */
import http from 'node:http'
import https from 'node:https'
import dns from 'node:dns'
import zlib from 'node:zlib'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import workerThreads, { threadId } from 'node:worker_threads'

export const GUARD_VERSION = '1.0.0'

export type EgressMode = 'enforce' | 'audit'
export type Decision = 'allow' | 'deny'

export interface EgressPolicy {
  mode: EgressMode
  /** null => no allow-list (deny-list only). Non-null => strict: anything not matched is denied. */
  allow: string[] | null
  deny: string[]
  sessionHeaderHosts: string[]
  stripBodyPrefix: string
  stripHeaderPattern: RegExp
  logFile: string | null
  quiet: boolean
}

export interface AuditRecord {
  ts: string
  pid: number
  thread: number
  layer: 'fetch' | 'http' | 'dns'
  decision: Decision | 'modified' | 'uninspected'
  host: string
  method?: string
  path?: string
  removedHeaders?: string[]
  removedBodyKeys?: string[]
  bytesBefore?: number
  bytesAfter?: number
  reason?: string
}

const BUILTIN_DENY = ['*.deepseeksvc.com', 'deepseeksvc.com']
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0:0:0:0:0:0:0:1'])

function list(v: string | undefined): string[] {
  return (v ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
}

function policyFromEnv(env: NodeJS.ProcessEnv): EgressPolicy {
  const mode: EgressMode = env.DSH_EGRESS_MODE === 'audit' ? 'audit' : 'enforce'
  const allowRaw = env.DSH_EGRESS_ALLOW
  return {
    mode,
    allow: allowRaw === undefined || allowRaw.trim() === '' ? null : list(allowRaw),
    deny: [...BUILTIN_DENY, ...list(env.DSH_EGRESS_DENY)],
    sessionHeaderHosts: list(env.DSH_EGRESS_SESSION_HEADER_HOSTS),
    stripBodyPrefix: env.DSH_EGRESS_STRIP_BODY_PREFIX ?? 'dsh_',
    stripHeaderPattern: /^x-deepseek-harness-/i,
    logFile: env.DSH_EGRESS_LOG?.trim() || null,
    quiet: env.DSH_EGRESS_QUIET === '1',
  }
}

let policy: EgressPolicy = policyFromEnv(process.env)

/** Test / embedder hook. Production should configure through environment only. */
export function configureEgressGuard(patch: Partial<EgressPolicy>): EgressPolicy {
  policy = { ...policy, ...patch, deny: patch.deny ? [...BUILTIN_DENY, ...patch.deny] : policy.deny }
  return policy
}

export function currentPolicy(): Readonly<EgressPolicy> {
  return policy
}

// ---------------------------------------------------------------- host matching

function normHost(h: string): string {
  let host = h.trim().toLowerCase()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  if (host.endsWith('.')) host = host.slice(0, -1)
  return host
}

function matches(host: string, pattern: string): boolean {
  const p = normHost(pattern)
  if (p.startsWith('*.')) {
    const suffix = p.slice(2)
    return host === suffix || host.endsWith('.' + suffix)
  }
  return host === p
}

export function decide(rawHost: string): { decision: Decision; reason: string } {
  const host = normHost(rawHost)
  if (LOOPBACK.has(host) || host.startsWith('127.')) return { decision: 'allow', reason: 'loopback' }
  if (policy.deny.some((p) => matches(host, p))) return { decision: 'deny', reason: 'deny-list' }
  if (policy.allow !== null && !policy.allow.some((p) => matches(host, p))) {
    return { decision: 'deny', reason: 'not-in-allow-list' }
  }
  return { decision: 'allow', reason: policy.allow === null ? 'no-allow-list' : 'allow-list' }
}

// ---------------------------------------------------------------- audit

const noticed = new Set<string>()

function audit(rec: Omit<AuditRecord, 'ts' | 'pid' | 'thread'>): void {
  const full: AuditRecord = { ts: new Date().toISOString(), pid: process.pid, thread: threadId, ...rec }
  if (policy.logFile) {
    try {
      fs.appendFileSync(policy.logFile, JSON.stringify(full) + '\n', { encoding: 'utf8' })
    } catch {
      /* audit must never break the request path */
    }
  }
  if (!policy.quiet && (rec.decision === 'deny' || rec.decision === 'modified')) {
    const key = `${rec.layer}:${rec.decision}:${rec.host}`
    if (!noticed.has(key)) {
      noticed.add(key)
      const extra = rec.removedBodyKeys?.length || rec.removedHeaders?.length
        ? ` removed=[${[...(rec.removedHeaders ?? []), ...(rec.removedBodyKeys ?? [])].join(',')}]`
        : ''
      process.stderr.write(`[dsh-egress-guard] ${rec.decision} ${rec.layer} ${rec.host}${extra}${policy.mode === 'audit' ? ' (audit-only)' : ''}\n`)
    }
  }
}

export class EgressBlockedError extends Error {
  code = 'EGRESS_BLOCKED'
  host: string
  constructor(host: string, reason: string) {
    super(`dsh-egress-guard blocked outbound connection to ${host} (${reason})`)
    this.name = 'EgressBlockedError'
    this.host = host
  }
}

// ---------------------------------------------------------------- body stripping

type Encoding = 'gzip' | 'deflate' | 'br' | 'identity' | 'unknown'

function encodingOf(headers: Headers): Encoding {
  const v = (headers.get('content-encoding') ?? '').trim().toLowerCase()
  if (v === '' || v === 'identity') return 'identity'
  if (v === 'gzip' || v === 'x-gzip') return 'gzip'
  if (v === 'deflate') return 'deflate'
  if (v === 'br') return 'br'
  return 'unknown'
}

function decode(buf: Buffer, enc: Encoding): Buffer | null {
  try {
    if (enc === 'identity') return buf
    if (enc === 'gzip') return zlib.gunzipSync(buf)
    if (enc === 'deflate') return zlib.inflateSync(buf)
    if (enc === 'br') return zlib.brotliDecompressSync(buf)
  } catch {
    return null
  }
  return null
}

function encode(buf: Buffer, enc: Encoding): Buffer {
  if (enc === 'gzip') return zlib.gzipSync(buf)
  if (enc === 'deflate') return zlib.deflateSync(buf)
  if (enc === 'br') return zlib.brotliCompressSync(buf)
  return buf
}

function looksJson(headers: Headers, text: string): boolean {
  const ct = (headers.get('content-type') ?? '').toLowerCase()
  if (ct.includes('json')) return true
  const t = text.trimStart()
  return t.startsWith('{')
}

export interface StripResult {
  changed: boolean
  body: string | Buffer
  removedKeys: string[]
  bytesBefore: number
  bytesAfter: number
}

/** Remove top-level keys with the configured prefix from a JSON object body. Non-JSON is returned untouched. */
export function stripJsonBody(raw: string | Buffer, headers: Headers): StripResult {
  const original = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw
  const enc = encodingOf(headers)
  const plain = enc === 'unknown' ? null : decode(original, enc)
  const untouched: StripResult = { changed: false, body: raw, removedKeys: [], bytesBefore: original.length, bytesAfter: original.length }
  if (plain === null) return untouched
  const text = plain.toString('utf8')
  if (!looksJson(headers, text)) return untouched
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return untouched
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return untouched
  const obj = parsed as Record<string, unknown>
  const removedKeys = Object.keys(obj).filter((k) => policy.stripBodyPrefix !== '' && k.startsWith(policy.stripBodyPrefix))
  if (removedKeys.length === 0) return untouched
  for (const k of removedKeys) delete obj[k]
  const out = encode(Buffer.from(JSON.stringify(obj), 'utf8'), enc)
  return {
    changed: true,
    body: typeof raw === 'string' && enc === 'identity' ? out.toString('utf8') : out,
    removedKeys,
    bytesBefore: original.length,
    bytesAfter: out.length,
  }
}

function stripHeaders(headers: Headers, host: string): string[] {
  const removed: string[] = []
  const keepSession = policy.sessionHeaderHosts.some((p) => matches(normHost(host), p))
  for (const name of [...headers.keys()]) {
    if (!policy.stripHeaderPattern.test(name)) continue
    if (keepSession && name.toLowerCase() === 'x-deepseek-harness-session-id') continue
    removed.push(name.toLowerCase())
  }
  if (policy.mode === 'enforce') for (const n of removed) headers.delete(n)
  return removed
}

// ---------------------------------------------------------------- L1: fetch

type FetchFn = typeof globalThis.fetch

function toBuffer(body: unknown): Buffer | string | null {
  if (typeof body === 'string') return body
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  return null
}

function installFetch(): void {
  const original: FetchFn | undefined = globalThis.fetch
  if (typeof original !== 'function') return
  const guarded = async function guardedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const isReq = typeof Request !== 'undefined' && input instanceof Request
    const href = isReq ? (input as Request).url : input instanceof URL ? input.href : String(input)
    let url: URL
    try {
      url = new URL(href)
    } catch {
      return original(input as RequestInfo, init)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return original(input as RequestInfo, init)
    const host = url.hostname
    const method = (init?.method ?? (isReq ? (input as Request).method : 'GET')).toUpperCase()
    const { decision, reason } = decide(host)
    if (decision === 'deny') {
      audit({ layer: 'fetch', decision: 'deny', host, method, path: url.pathname, reason })
      if (policy.mode === 'enforce') throw new TypeError('fetch failed', { cause: new EgressBlockedError(host, reason) })
    }

    const headers = new Headers(isReq ? (input as Request).headers : undefined)
    if (init?.headers) new Headers(init.headers).forEach((v, k) => headers.set(k, v))
    const removedHeaders = stripHeaders(headers, host)

    // Resolve the body we are about to send.
    let bodyIn: unknown = init && 'body' in init ? init.body : undefined
    if (bodyIn === undefined && isReq && (input as Request).body !== null) {
      bodyIn = Buffer.from(await (input as Request).clone().arrayBuffer())
    }
    const buf = bodyIn === undefined || bodyIn === null ? null : toBuffer(bodyIn)
    let removedBodyKeys: string[] = []
    let newBody: unknown = bodyIn
    let bytesBefore: number | undefined
    let bytesAfter: number | undefined
    if (buf !== null) {
      const r = stripJsonBody(buf, headers)
      bytesBefore = r.bytesBefore
      bytesAfter = r.bytesAfter
      if (r.changed) {
        removedBodyKeys = r.removedKeys
        if (policy.mode === 'enforce') {
          newBody = r.body
          headers.delete('content-length')
        }
      }
    } else if (bodyIn !== undefined && bodyIn !== null) {
      audit({ layer: 'fetch', decision: 'uninspected', host, method, path: url.pathname, reason: 'stream/form body' })
    }

    const modified = removedHeaders.length > 0 || removedBodyKeys.length > 0
    audit({
      layer: 'fetch',
      decision: modified ? 'modified' : 'allow',
      host,
      method,
      path: url.pathname,
      removedHeaders: removedHeaders.length ? removedHeaders : undefined,
      removedBodyKeys: removedBodyKeys.length ? removedBodyKeys : undefined,
      bytesBefore,
      bytesAfter,
      reason,
    })
    if (policy.mode === 'audit') return original(input as RequestInfo, init)

    const nextInit: RequestInit & { duplex?: 'half' } = { ...(init ?? {}), headers }
    if (isReq) {
      const req = input as Request
      nextInit.method = method
      nextInit.signal = init?.signal ?? req.signal
      nextInit.redirect = init?.redirect ?? req.redirect
      if (newBody !== undefined) nextInit.body = newBody as BodyInit
      return original(url.href, nextInit)
    }
    if (newBody !== undefined) nextInit.body = newBody as BodyInit
    return original(input as RequestInfo, nextInit)
  }
  Object.defineProperty(guarded, '__dshEgressGuard', { value: true })
  globalThis.fetch = guarded as FetchFn
}

// ---------------------------------------------------------------- L2: node:http / node:https

function targetOf(args: unknown[], defaultProto: 'http:' | 'https:'): { host: string; path: string; method: string } | null {
  const a0 = args[0]
  const a1 = args[1]
  let host = ''
  let path = '/'
  let method = 'GET'
  if (typeof a0 === 'string' || a0 instanceof URL) {
    try {
      const u = new URL(String(a0))
      host = u.hostname
      path = u.pathname
    } catch {
      return null
    }
    if (a1 && typeof a1 === 'object') {
      const o = a1 as Record<string, unknown>
      if (typeof o.hostname === 'string') host = o.hostname
      else if (typeof o.host === 'string') host = String(o.host).split(':')[0]
      if (typeof o.method === 'string') method = o.method
    }
  } else if (a0 && typeof a0 === 'object') {
    const o = a0 as Record<string, unknown>
    host = typeof o.hostname === 'string' ? o.hostname : typeof o.host === 'string' ? String(o.host).split(':')[0] : 'localhost'
    path = typeof o.path === 'string' ? o.path.split('?')[0] : '/'
    if (typeof o.method === 'string') method = o.method
  } else {
    return null
  }
  void defaultProto
  return { host, path, method: method.toUpperCase() }
}

function withBlockedConnection(args: unknown[], err: EgressBlockedError, proto: 'http:' | 'https:'): unknown[] {
  // A throw-away Agent whose only socket factory fails. (Note: `agent: false` would make Node build a
  // fresh default Agent and ignore `createConnection`, so a dedicated Agent instance is required.)
  const agent = proto === 'https:' ? new https.Agent({ keepAlive: false }) : new http.Agent({ keepAlive: false })
  ;(agent as unknown as { createConnection: unknown }).createConnection = (_opts: unknown, cb: (e: Error | null) => void): undefined => {
    process.nextTick(cb, err)
    return undefined
  }
  const blockOpts = { agent }
  const out = [...args]
  if (typeof out[0] === 'string' || out[0] instanceof URL) {
    if (out[1] && typeof out[1] === 'object') out[1] = { ...(out[1] as object), ...blockOpts }
    else out.splice(1, 0, blockOpts)
  } else {
    out[0] = { ...(out[0] as object), ...blockOpts }
  }
  return out
}

function wrapModule(mod: typeof http | typeof https, proto: 'http:' | 'https:'): void {
  const origRequest = mod.request
  const wrappedRequest = function (this: unknown, ...args: unknown[]) {
    const t = targetOf(args, proto)
    if (t) {
      const { decision, reason } = decide(t.host)
      audit({ layer: 'http', decision, host: t.host, method: t.method, path: t.path, reason })
      if (decision === 'deny' && policy.mode === 'enforce') {
        const err = new EgressBlockedError(t.host, reason)
        const req = (origRequest as (...a: unknown[]) => http.ClientRequest).apply(this, withBlockedConnection(args, err, proto))
        req.on('error', () => {}) // never crash a caller that forgot an error listener
        return req
      }
    }
    return (origRequest as (...a: unknown[]) => http.ClientRequest).apply(this, args)
  }
  const wrappedGet = function (this: unknown, ...args: unknown[]) {
    const req = wrappedRequest.apply(this, args)
    req.end()
    return req
  }
  ;(mod as { request: unknown }).request = wrappedRequest
  ;(mod as { get: unknown }).get = wrappedGet
}

// ---------------------------------------------------------------- L3: dns

function dnsError(hostname: string, reason: string): NodeJS.ErrnoException {
  const e = new EgressBlockedError(hostname, reason) as unknown as NodeJS.ErrnoException
  e.code = 'ENOTFOUND'
  ;(e as unknown as { hostname: string }).hostname = hostname
  return e
}

function installDns(): void {
  const origLookup = dns.lookup
  const lookup = function (this: unknown, hostname: string, ...rest: unknown[]) {
    const cb = rest[rest.length - 1]
    const { decision, reason } = decide(String(hostname))
    if (decision === 'deny') {
      audit({ layer: 'dns', decision: 'deny', host: String(hostname), reason })
      if (policy.mode === 'enforce' && typeof cb === 'function') {
        process.nextTick(cb as (e: Error) => void, dnsError(String(hostname), reason))
        return {}
      }
    }
    return (origLookup as (...a: unknown[]) => unknown).call(this, hostname, ...rest)
  }
  ;(dns as { lookup: unknown }).lookup = lookup

  const origP = dns.promises.lookup
  ;(dns.promises as { lookup: unknown }).lookup = async function (hostname: string, ...rest: unknown[]) {
    const { decision, reason } = decide(String(hostname))
    if (decision === 'deny') {
      audit({ layer: 'dns', decision: 'deny', host: String(hostname), reason })
      if (policy.mode === 'enforce') throw dnsError(String(hostname), reason)
    }
    return (origP as (...a: unknown[]) => Promise<unknown>).call(dns.promises, hostname, ...rest)
  }
}

// ---------------------------------------------------------------- propagation: workers + child Node processes

const SELF_URL = import.meta.url
const SELF_PATH = fileURLToPath(SELF_URL)

/** `--import` preloads are NOT inherited by worker_threads; wrap Worker so every worker loads the guard first. */
function installWorkerPropagation(): void {
  const Orig = workerThreads.Worker
  const loader = `require(${JSON.stringify(SELF_PATH)});`
  const Guarded = function (this: unknown, filename: string | URL, options?: Record<string, unknown>) {
    const opts: Record<string, unknown> = { ...(options ?? {}) }
    if (opts.eval === true && typeof filename === 'string') {
      return new Orig(`${loader}\n${filename}`, opts as never)
    }
    const target = filename instanceof URL ? filename.href : /^[a-z]+:/i.test(String(filename)) && !/^[a-z]:[\\/]/i.test(String(filename))
      ? String(filename)
      : pathToFileURL(String(filename)).href
    const boot = `${loader}\nimport(${JSON.stringify(target)}).catch((e) => { process.nextTick(() => { throw e }) })`
    return new Orig(boot, { ...opts, eval: true } as never)
  } as unknown as typeof workerThreads.Worker
  Object.setPrototypeOf(Guarded, Orig)
  ;(Guarded as unknown as { prototype: unknown }).prototype = Orig.prototype
  ;(workerThreads as { Worker: unknown }).Worker = Guarded
}

/** Child Node processes (e.g. a launcher spawning the profile runtime) inherit the guard through NODE_OPTIONS. */
function installChildPropagation(): void {
  const flag = `--import=${SELF_URL}`
  const cur = process.env.NODE_OPTIONS ?? ''
  if (!cur.includes(SELF_URL)) process.env.NODE_OPTIONS = `${cur} ${flag}`.trim()
}

// ---------------------------------------------------------------- install (idempotent)

const MARK = Symbol.for('dsh-egress-guard')
const g = globalThis as unknown as Record<symbol, unknown>
if (!g[MARK]) {
  g[MARK] = { version: GUARD_VERSION }
  installFetch()
  wrapModule(http, 'http:')
  wrapModule(https, 'https:')
  installDns()
  if (process.env.DSH_EGRESS_PROPAGATE !== '0') {
    installWorkerPropagation()
    installChildPropagation()
  }
  syncBuiltinESMExports() // propagate to `import { request } from 'node:https'` style bindings
  if (!policy.quiet) {
    process.stderr.write(
      `[dsh-egress-guard] v${GUARD_VERSION} active mode=${policy.mode} allow=${policy.allow ? policy.allow.join('|') : '(deny-list only)'} deny=${policy.deny.join('|')}\n`,
    )
  }
}
