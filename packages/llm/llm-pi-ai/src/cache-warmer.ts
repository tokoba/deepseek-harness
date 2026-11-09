/**
 * Prompt-cache keepalive for Anthropic-protocol routes.
 *
 * After a main conversation request completes, the warmer keeps that request's
 * pi-ai model, context, and options in process memory. Shortly before the
 * provider's cache TTL expires it resends the same request with only the output
 * cap lowered, so every cache breakpoint reads (and refreshes) the existing
 * entry instead of letting the next human turn rewrite the whole prefix at the
 * cache-write price. The resend's output is discarded and never reaches the
 * Session log; it changes no model-visible input.
 *
 * Pings per idle period are capped by the configured limit and by the
 * break-even count `floor((cacheWrite - cacheRead) / cacheRead)` from the
 * model's prices, and all pings share a daily credit budget estimated from the
 * same prices (1 credit = USD 0.01). Any new request on the Session cancels the
 * pending or in-flight ping; only a later main request re-arms it.
 *
 * @module dsh-llm-pi-ai/cache-warmer
 */

import type { Api, AssistantMessageEvent, Context as PiContext, Model, SimpleStreamOptions, Usage } from '@earendil-works/pi-ai'

/** Dispatch entry the warmer resends through: the request's own snapshot collection. */
export type CacheWarmerStream = (
  model: Model<Api>, context: PiContext, options: SimpleStreamOptions,
) => AsyncIterable<AssistantMessageEvent>

/** Anthropic's default ephemeral cache lifetime (provider specification). */
const ANTHROPIC_SHORT_TTL_MS = 5 * 60_000
/** Anthropic's extended cache lifetime selected by `ttl: "1h"` (provider specification). */
const ANTHROPIC_LONG_TTL_MS = 60 * 60_000

/** Keepalive settings for one provider route; every field is required. */
export interface PiAiCacheWarmerConfig {
  /** Upper bound on pings between two real requests; the price break-even count may lower it. */
  maxPingsPerIdle: number
  /** Estimated AI Credits all pings of this process may spend per local calendar day. */
  dailyCreditBudget: number
  /** Smallest cached prefix, in input tokens, worth keeping warm. */
  minPrefixTokens: number
  /** How long before TTL expiry a ping is sent, in milliseconds. */
  marginMs: number
  /** Output cap of a ping request; it must satisfy the model's thinking constraints. */
  pingMaxTokens: number
}

/** One completed main request the warmer may resend. */
export interface CacheWarmerAnchor {
  /** Session that owns the cached prefix. */
  sessionId: string
  /** Harness provider route, for diagnostics. */
  provider: string
  /** Dispatch through the collection the request used. */
  stream: CacheWarmerStream
  /** Resolved model descriptor of the request. */
  model: Model<Api>
  /** Converted pi-ai context of the request. */
  context: PiContext
  /** Stream options of the request, without its signal. */
  options: SimpleStreamOptions
  /** Usage the provider reported for the request. */
  usage: Usage
  /** Route keepalive settings. */
  config: PiAiCacheWarmerConfig
  /** Time the request was sent, in epoch milliseconds; TTL counts from here. */
  sentAt: number
}

/** Timer and clock hooks; production uses the global timers. */
export interface CacheWarmerClock {
  /** Current epoch milliseconds. */
  now: () => number
  /** Schedule a callback; returns a cancel function. */
  schedule: (callback: () => void, delayMs: number) => () => void
  /** Local calendar day key used for the daily budget. */
  day: () => string
}

/** One warmer outcome reported to the owning plugin's logger. */
export type CacheWarmerReport =
  | { kind: 'ping'; sessionId: string; provider: string; model: string; cacheReadTokens: number; cacheWriteTokens: number; credits: number }
  | { kind: 'ping-failed'; sessionId: string; provider: string; model: string; message: string }
  | { kind: 'skipped'; sessionId: string; provider: string; model: string; reason: string }

interface Armed {
  anchor: CacheWarmerAnchor
  pings: number
  limit: number
  cancelTimer: () => void
  inFlight?: AbortController
}

const systemClock: CacheWarmerClock = {
  now: () => Date.now(),
  schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs)
    timer.unref?.()
    return () => { clearTimeout(timer) }
  },
  day: () => new Date().toLocaleDateString('sv-SE'),
}

/**
 * Cache TTL a request selected, or undefined when the protocol is not kept warm.
 * @param anchor - the completed request.
 * @returns lifetime in milliseconds.
 */
export function cacheTtlMs(anchor: Pick<CacheWarmerAnchor, 'model' | 'options'>): number | undefined {
  if (anchor.model.api !== 'anthropic-messages') return undefined
  const retention = anchor.options.cacheRetention ?? 'short'
  if (retention === 'none') return undefined
  const compat = anchor.model.compat as { supportsLongCacheRetention?: boolean } | undefined
  return retention === 'long' && compat?.supportsLongCacheRetention !== false ? ANTHROPIC_LONG_TTL_MS : ANTHROPIC_SHORT_TTL_MS
}

/**
 * Pings that cost less than one cache rewrite of the same prefix.
 * @param model - priced model descriptor (USD per million tokens).
 * @returns the break-even ping count; 0 when the model has no write premium.
 */
export function breakEvenPings(model: Model<Api>): number {
  const { cacheRead, cacheWrite } = model.cost
  if (cacheRead <= 0 || cacheWrite <= cacheRead) return 0
  // Rounded before flooring so a decimal price ratio such as 4.8 / 0.2 is not 23.999….
  return Math.floor(Math.round((cacheWrite - cacheRead) / cacheRead * 1e6) / 1e6)
}

/**
 * Estimated credits of one ping (1 credit = USD 0.01).
 * @param model - priced model descriptor.
 * @param prefixTokens - prefix the ping reads from cache.
 * @param outputTokens - ping output cap.
 * @returns credits.
 */
export function pingCredits(model: Model<Api>, prefixTokens: number, outputTokens: number): number {
  return (prefixTokens * model.cost.cacheRead + outputTokens * model.cost.output) / 1_000_000 * 100
}

/** Per-adapter keepalive scheduler; one armed anchor per Session. */
export class PiAiCacheWarmer {
  private readonly armed = new Map<string, Armed>()
  private readonly generation = new Map<string, number>()
  private budgetDay = ''
  private spent = 0
  private disposed = false

  /**
   * @param report - receives every ping, failure, and skip.
   * @param isArchived - whether a Session is archived; checked when a request
   *   arms the warmer and again before each ping, so archiving stops warming
   *   by the next scheduled ping without spending budget.
   * @param clock - timers and calendar day.
   */
  constructor(
    private readonly report: (report: CacheWarmerReport) => void,
    private readonly isArchived: (sessionId: string) => boolean,
    private readonly clock: CacheWarmerClock = systemClock,
  ) {}

  /**
   * Cancel any pending or in-flight ping for a Session and mark a new request.
   * @param sessionId - Session starting a request.
   * @returns the request generation; {@link arm} ignores an older one.
   */
  begin(sessionId: string): number {
    this.cancel(sessionId)
    const next = (this.generation.get(sessionId) ?? 0) + 1
    this.generation.set(sessionId, next)
    return next
  }

  /**
   * Keep one completed main request warm.
   * @param anchor - the completed request.
   * @param generation - value {@link begin} returned for this request.
   */
  arm(anchor: CacheWarmerAnchor, generation: number): void {
    if (this.disposed || this.generation.get(anchor.sessionId) !== generation) return
    const skip = (reason: string): void => {
      this.report({ kind: 'skipped', sessionId: anchor.sessionId, provider: anchor.provider, model: anchor.model.id, reason })
    }
    if (this.isArchived(anchor.sessionId)) return skip('the Session is archived')
    const ttl = cacheTtlMs(anchor)
    if (ttl === undefined) return skip('the protocol or cache retention has no keepalive')
    const prefix = anchor.usage.input + anchor.usage.cacheRead + anchor.usage.cacheWrite
    if (prefix < anchor.config.minPrefixTokens) return skip(`prefix ${prefix} is below minPrefixTokens`)
    const limit = Math.min(anchor.config.maxPingsPerIdle, breakEvenPings(anchor.model))
    if (limit <= 0) return skip('pings cannot pay for themselves at this model\'s prices')
    const entry: Armed = { anchor, pings: 0, limit, cancelTimer: () => {} }
    this.armed.set(anchor.sessionId, entry)
    this.scheduleNext(entry, anchor.sentAt, ttl)
  }

  /**
   * Stop keeping one Session warm.
   * @param sessionId - Session whose anchor is dropped.
   */
  cancel(sessionId: string): void {
    const entry = this.armed.get(sessionId)
    if (entry === undefined) return
    this.armed.delete(sessionId)
    entry.cancelTimer()
    entry.inFlight?.abort('cache warmer cancelled')
  }

  /** Cancel every anchor; later calls are ignored. */
  dispose(): void {
    this.disposed = true
    for (const sessionId of [...this.armed.keys()]) this.cancel(sessionId)
  }

  private scheduleNext(entry: Armed, from: number, ttl: number): void {
    const delay = Math.max(0, from + ttl - entry.anchor.config.marginMs - this.clock.now())
    entry.cancelTimer = this.clock.schedule(() => { void this.ping(entry, ttl) }, delay)
  }

  private async ping(entry: Armed, ttl: number): Promise<void> {
    const { anchor } = entry
    if (this.armed.get(anchor.sessionId) !== entry) return
    const base = { sessionId: anchor.sessionId, provider: anchor.provider, model: anchor.model.id }
    if (this.isArchived(anchor.sessionId)) {
      this.armed.delete(anchor.sessionId)
      this.report({ ...base, kind: 'skipped', reason: 'the Session is archived' })
      return
    }
    const prefix = anchor.usage.input + anchor.usage.cacheRead + anchor.usage.cacheWrite
    const credits = pingCredits(anchor.model, prefix, anchor.config.pingMaxTokens)
    const day = this.clock.day()
    if (day !== this.budgetDay) { this.budgetDay = day; this.spent = 0 }
    if (this.spent + credits > anchor.config.dailyCreditBudget) {
      this.armed.delete(anchor.sessionId)
      this.report({ ...base, kind: 'skipped', reason: 'dailyCreditBudget is exhausted' })
      return
    }
    this.spent += credits
    entry.pings += 1
    const sentAt = this.clock.now()
    const controller = new AbortController()
    entry.inFlight = controller
    let usage: Usage | undefined
    let failure: string | undefined
    try {
      const events = anchor.stream(anchor.model, anchor.context, {
        ...anchor.options,
        maxTokens: anchor.config.pingMaxTokens,
        signal: controller.signal,
      })
      for await (const event of events) {
        if (event.type === 'done') usage = event.message.usage
        else if (event.type === 'error') failure = event.error.errorMessage ?? 'pi-ai stream error'
      }
    } catch (error) {
      // The ping is advisory: a failure is reported and stops this anchor; the next real request re-arms.
      failure = error instanceof Error ? error.message : String(error)
    } finally {
      if (entry.inFlight === controller) delete entry.inFlight
    }
    if (controller.signal.aborted || this.armed.get(anchor.sessionId) !== entry) return
    if (failure !== undefined || usage === undefined) {
      this.armed.delete(anchor.sessionId)
      this.report({ ...base, kind: 'ping-failed', message: failure ?? 'the provider reported no usage' })
      return
    }
    this.report({ ...base, kind: 'ping', cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite, credits })
    if (entry.pings >= entry.limit) {
      this.armed.delete(anchor.sessionId)
      return
    }
    this.scheduleNext(entry, sentAt, ttl)
  }
}
