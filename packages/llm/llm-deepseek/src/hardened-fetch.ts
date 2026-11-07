/**
 * Outbound filter for DeepSeek provider requests in the privacy-hardened build.
 *
 * Independent of plugin config, settings UI, HMR, or profile patches, every request sent through
 * {@link hardenedFetch}:
 * - drops top-level `dsh_*` JSON body fields, including fields added in the future;
 * - drops `x-deepseek-harness-*` headers;
 * - refuses any `*.deepseeksvc.com` host.
 *
 * Each item is restored only by its process environment variable set to `1`:
 * - `DSH_HARDENED_ALLOW_SESSION_LOG_UPLOAD`: `dsh_session_log`
 * - `DSH_HARDENED_ALLOW_PLUGIN_INVENTORY`: `dsh_plugin_packages`
 * - `DSH_HARDENED_ALLOW_REQUEST_EXTENSIONS`: every other `dsh_*` field
 * - `DSH_HARDENED_ALLOW_PERSISTENT_ID`: `x-deepseek-harness-user-id`
 * - `DSH_HARDENED_ALLOW_SESSION_HEADER`: `x-deepseek-harness-session-id` and `x-deepseek-harness-compact`
 *
 * `packages/llm/llm-deepseek/src/hardened-fetch.ts` and `packages/web/web-deepseek-api/src/hardened-fetch.ts`
 * are identical copies maintained by `docs/telemetory-fix/dsh-hardened-kit/fork/apply-hardening.ts`.
 */

const DENY_SUFFIX = 'deepseeksvc.com'

const allowed = (envVar: string): boolean => process.env[envVar] === '1'

function allowedBodyKey(key: string): boolean {
  if (!key.startsWith('dsh_')) return true
  if (key === 'dsh_session_log') return allowed('DSH_HARDENED_ALLOW_SESSION_LOG_UPLOAD')
  if (key === 'dsh_plugin_packages') return allowed('DSH_HARDENED_ALLOW_PLUGIN_INVENTORY')
  return allowed('DSH_HARDENED_ALLOW_REQUEST_EXTENSIONS')
}

function allowedHeader(name: string): boolean {
  const n = name.toLowerCase()
  if (!n.startsWith('x-deepseek-harness-')) return true
  if (n === 'x-deepseek-harness-user-id') return allowed('DSH_HARDENED_ALLOW_PERSISTENT_ID')
  if (n === 'x-deepseek-harness-session-id' || n === 'x-deepseek-harness-compact') return allowed('DSH_HARDENED_ALLOW_SESSION_HEADER')
  return false
}

function sanitizeHeaders(headers: Headers): void {
  for (const name of [...headers.keys()]) {
    if (!allowedHeader(name)) headers.delete(name)
  }
}

function sanitizeBody(body: unknown, headers: Headers): unknown {
  // Multipart, binary, and stream bodies (Files API uploads) pass through unchanged.
  if (typeof body !== 'string' || !body.trimStart().startsWith('{')) return body
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    // A non-JSON string body carries no `dsh_*` fields to remove.
    return body
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return body
  const entries = Object.entries(parsed)
  const kept = entries.filter(([key]) => allowedBodyKey(key))
  if (kept.length === entries.length) return body
  headers.delete('content-length')
  return JSON.stringify(Object.fromEntries(kept))
}

/**
 * `fetch` replacement that applies the hardened outbound policy before delegating to the global `fetch`.
 * @param input - request URL or `Request`.
 * @param init - request options; plain header records stay plain records.
 * @returns the response of the filtered request.
 * @throws TypeError when the destination host is `*.deepseeksvc.com`.
 */
export async function hardenedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const href = input instanceof Request ? input.url : input instanceof URL ? input.href : input
  const url = new URL(href)
  const host = url.hostname.toLowerCase()
  if (host === DENY_SUFFIX || host.endsWith('.' + DENY_SUFFIX)) {
    throw new TypeError('fetch failed', { cause: new Error(`[dsh-hardened] blocked ${host}`) })
  }
  if (input instanceof Request) {
    const headers = new Headers(input.headers)
    if (init?.headers) new Headers(init.headers).forEach((v, k) => { headers.set(k, v) })
    sanitizeHeaders(headers)
    const raw = init?.body !== undefined ? init.body : input.body === null ? undefined : await input.clone().text()
    const body = sanitizeBody(raw, headers)
    const method = init?.method ?? input.method
    const signal = init?.signal ?? input.signal
    return fetch(url.href, { ...init, method, signal, headers, body: (body ?? null) as BodyInit | null })
  }
  if (init === undefined) return fetch(input)
  const headers = new Headers(init.headers)
  sanitizeHeaders(headers)
  const body = init.body === undefined || init.body === null ? init.body : sanitizeBody(init.body, headers)
  const outHeaders = init.headers === undefined || init.headers instanceof Headers || Array.isArray(init.headers)
    ? headers
    : Object.fromEntries(Object.entries(init.headers).filter(([k]) => headers.has(k)))
  const next: RequestInit = { ...init, headers: outHeaders }
  if (body !== undefined) next.body = body as BodyInit | null
  return fetch(input, next)
}
