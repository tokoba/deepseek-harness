import { describe, expect, it } from 'vitest'
import { openaiPromptCacheHook } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'

const responses = { api: 'openai-responses' as const }

describe('openaiPromptCacheHook', () => {
  it('replaces prompt_cache_retention with implicit prompt_cache_options', async () => {
    const { onPayload } = openaiPromptCacheHook({ openaiPromptCacheTtl: '12h', cacheRetention: 'long' }, responses)
    const payload = await onPayload?.({ model: 'gpt-6.1-sol', prompt_cache_key: 'k', prompt_cache_retention: '24h' }, responses as never)
    expect(payload).toEqual({ model: 'gpt-6.1-sol', prompt_cache_key: 'k', prompt_cache_options: { mode: 'implicit', ttl: '12h' } })
  })

  it('adds nothing when unset, on other protocols, or with cacheRetention none', () => {
    expect(openaiPromptCacheHook({}, responses)).toEqual({})
    expect(openaiPromptCacheHook({ openaiPromptCacheTtl: '12h' }, { api: 'anthropic-messages' })).toEqual({})
    expect(openaiPromptCacheHook({ openaiPromptCacheTtl: '12h', cacheRetention: 'none' }, responses)).toEqual({})
  })

  it('is carried through profile resolution', () => {
    const resolved = resolveProfiles({ 'github-copilot': { openaiPromptCacheTtl: '12h' } }, 'deferred')
    expect(resolved.get('github-copilot')?.openaiPromptCacheTtl).toBe('12h')
  })
})
