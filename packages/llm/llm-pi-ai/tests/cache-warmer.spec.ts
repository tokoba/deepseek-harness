/** Prompt-cache keepalive scheduling, break-even limits, budget, and cancellation. */
import { describe, expect, it } from 'vitest'
import type { Api, AssistantMessage, AssistantMessageEvent, Model, SimpleStreamOptions, Usage } from '@earendil-works/pi-ai'
import { breakEvenPings, cacheTtlMs, PiAiCacheWarmer } from '../src/cache-warmer.ts'
import type { CacheWarmerAnchor, CacheWarmerClock, CacheWarmerReport, PiAiCacheWarmerConfig } from '../src/cache-warmer.ts'

function usage(cacheRead: number, cacheWrite = 0): Usage {
  return {
    input: 10, output: 1, cacheRead, cacheWrite, totalTokens: 11 + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

const MODEL = {
  id: 'claude-opus-5.5', api: 'anthropic-messages', provider: 'github-copilot',
  cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
} as Model<Api>

class FakeClock implements CacheWarmerClock {
  time = 0
  today = '2026-11-08'
  private timers: { at: number; callback: () => void; live: boolean }[] = []
  now = (): number => this.time
  day = (): string => this.today
  schedule = (callback: () => void, delayMs: number): (() => void) => {
    const timer = { at: this.time + delayMs, callback, live: true }
    this.timers.push(timer)
    return () => { timer.live = false }
  }

  async advance(ms: number): Promise<void> {
    this.time += ms
    for (const timer of this.timers.filter(entry => entry.live && entry.at <= this.time)) {
      timer.live = false
      timer.callback()
    }
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }

  pending(): number { return this.timers.filter(timer => timer.live).length }
}

function message(stopReason: 'stop' | 'error', cacheRead: number, errorMessage?: string): AssistantMessage {
  return {
    role: 'assistant', content: [], api: 'anthropic-messages', provider: 'github-copilot', model: 'claude-opus-5.5',
    usage: usage(cacheRead), stopReason, timestamp: 0, ...errorMessage === undefined ? {} : { errorMessage },
  }
}

const DONE: AssistantMessageEvent = { type: 'done', reason: 'stop', message: message('stop', 50_000) }

function harness(result: () => AssistantMessageEvent[] = () => [DONE]) {
  const clock = new FakeClock()
  const reports: CacheWarmerReport[] = []
  const calls: SimpleStreamOptions[] = []
  const stream = (_model: Model<Api>, _context: unknown, options: SimpleStreamOptions): AsyncIterable<AssistantMessageEvent> => {
    calls.push(options)
    return (async function* () { yield* result() })()
  }
  const warmer = new PiAiCacheWarmer(report => reports.push(report), clock)
  const config: PiAiCacheWarmerConfig = {
    maxPingsPerIdle: 2, dailyCreditBudget: 100, minPrefixTokens: 30_000, marginMs: 60_000, pingMaxTokens: 16,
  }
  const anchor = (overrides: Partial<CacheWarmerAnchor> = {}): CacheWarmerAnchor => ({
    sessionId: 's', provider: 'github-copilot', stream, model: MODEL, context: { messages: [] },
    options: { cacheRetention: 'long', maxTokens: 8192 }, usage: usage(50_000), config, sentAt: clock.now(),
    ...overrides,
  })
  return { clock, reports, calls, warmer, anchor, config }
}

describe('cache warmer', () => {
  it('derives the TTL from protocol and retention and the break-even count from prices', () => {
    expect(cacheTtlMs({ model: MODEL, options: { cacheRetention: 'long' } })).toBe(3_600_000)
    expect(cacheTtlMs({ model: MODEL, options: {} })).toBe(300_000)
    expect(cacheTtlMs({ model: MODEL, options: { cacheRetention: 'none' } })).toBeUndefined()
    expect(cacheTtlMs({ model: { ...MODEL, api: 'openai-responses' } as Model<Api>, options: {} })).toBeUndefined()
    expect(breakEvenPings(MODEL)).toBe(24)
    expect(breakEvenPings({ ...MODEL, cost: { ...MODEL.cost, cacheWrite: 0 } } as Model<Api>)).toBe(0)
  })

  it('resends the request with the ping cap before expiry and stops at the idle limit', async () => {
    const h = harness()
    h.warmer.arm(h.anchor(), h.warmer.begin('s'))
    await h.clock.advance(3_600_000 - 60_001)
    expect(h.calls).toHaveLength(0)
    await h.clock.advance(1)
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]?.maxTokens).toBe(16)
    await h.clock.advance(3_600_000 - 60_000)
    expect(h.calls).toHaveLength(2)
    await h.clock.advance(3_600_000)
    expect(h.calls).toHaveLength(2)
    expect(h.reports.filter(report => report.kind === 'ping')).toHaveLength(2)
  })

  it('cancels the pending ping when the Session starts another request and ignores a stale arm', async () => {
    const h = harness()
    const first = h.warmer.begin('s')
    h.warmer.arm(h.anchor(), first)
    h.warmer.begin('s')
    h.warmer.arm(h.anchor(), first)
    await h.clock.advance(3_600_000)
    expect(h.calls).toHaveLength(0)
    expect(h.clock.pending()).toBe(0)
  })

  it('skips small prefixes and stops when the daily budget would be exceeded', async () => {
    const h = harness()
    h.warmer.arm(h.anchor({ usage: usage(1_000) }), h.warmer.begin('s'))
    expect(h.reports.at(-1)).toMatchObject({ kind: 'skipped' })
    h.warmer.arm(h.anchor({ config: { ...h.config, dailyCreditBudget: 0.5 } }), h.warmer.begin('s'))
    await h.clock.advance(3_600_000)
    expect(h.calls).toHaveLength(0)
    expect(h.reports.at(-1)).toMatchObject({ kind: 'skipped', reason: 'dailyCreditBudget is exhausted' })
  })

  it('reports a failed ping and stops warming the Session', async () => {
    const h = harness(() => [{ type: 'error', reason: 'error', error: message('error', 0, '400 bad') }])
    h.warmer.arm(h.anchor(), h.warmer.begin('s'))
    await h.clock.advance(3_600_000)
    expect(h.reports.at(-1)).toMatchObject({ kind: 'ping-failed', message: '400 bad' })
    await h.clock.advance(3_600_000)
    expect(h.calls).toHaveLength(1)
  })

  it('cancels everything on dispose', async () => {
    const h = harness()
    h.warmer.arm(h.anchor(), h.warmer.begin('s'))
    h.warmer.dispose()
    await h.clock.advance(3_600_000)
    expect(h.calls).toHaveLength(0)
  })
})
