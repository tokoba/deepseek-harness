import { afterEach, describe, expect, it, vi } from 'vitest'
import { hardenedFetch } from '../src/hardened-fetch.ts'

const OPT_INS = [
  'DSH_HARDENED_ALLOW_SESSION_LOG_UPLOAD',
  'DSH_HARDENED_ALLOW_PLUGIN_INVENTORY',
  'DSH_HARDENED_ALLOW_REQUEST_EXTENSIONS',
  'DSH_HARDENED_ALLOW_PERSISTENT_ID',
  'DSH_HARDENED_ALLOW_SESSION_HEADER',
] as const

function capture(): ReturnType<typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>> {
  const mock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}'))
  vi.stubGlobal('fetch', mock)
  for (const name of OPT_INS) vi.stubEnv(name, '')
  return mock
}

const body = JSON.stringify({ model: 'm', dsh_session_log: { a: 1 }, dsh_plugin_packages: [], dsh_future: 1 })
const headers = {
  authorization: 'Bearer k',
  'x-deepseek-harness-user-id': 'u',
  'x-deepseek-harness-session-id': 's',
  'x-deepseek-harness-compact': '1',
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('hardenedFetch', () => {
  it('drops dsh_* fields and harness identity headers by default', async () => {
    const mock = capture()
    await hardenedFetch('https://api.deepseek.com/anthropic/v1/messages', { method: 'POST', body, headers })
    const init = mock.mock.calls[0]?.[1]
    expect(JSON.parse(init?.body as string)).toEqual({ model: 'm' })
    expect(init?.headers).toEqual({ authorization: 'Bearer k' })
  })

  it('restores each item only through its environment opt-in', async () => {
    const mock = capture()
    vi.stubEnv('DSH_HARDENED_ALLOW_SESSION_LOG_UPLOAD', '1')
    vi.stubEnv('DSH_HARDENED_ALLOW_SESSION_HEADER', '1')
    await hardenedFetch('http://127.0.0.1:1/messages', { method: 'POST', body, headers })
    const init = mock.mock.calls[0]?.[1]
    expect(JSON.parse(init?.body as string)).toEqual({ model: 'm', dsh_session_log: { a: 1 } })
    expect(init?.headers).toEqual({ authorization: 'Bearer k', 'x-deepseek-harness-session-id': 's', 'x-deepseek-harness-compact': '1' })
  })

  it('passes bodies without dsh_* fields through unchanged', async () => {
    const mock = capture()
    const plain = JSON.stringify({ model: 'm' })
    await hardenedFetch('https://api.deepseek.com/models', { method: 'POST', body: plain })
    expect(mock.mock.calls[0]?.[1]?.body).toBe(plain)
  })

  it('refuses deepseeksvc.com hosts without contacting them', async () => {
    const mock = capture()
    await expect(hardenedFetch('https://dsh-otel-collector.deepseeksvc.com/v1/logs', { method: 'POST' })).rejects.toThrow(TypeError)
    expect(mock).not.toHaveBeenCalled()
  })
})
