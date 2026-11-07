import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { getOrCreateAnonymousUserId } from '../src/index.ts'

afterEach(() => vi.unstubAllEnvs())

it('returns one per-process id without writing to the harness home by default', () => {
  vi.stubEnv('DSH_HARDENED_ALLOW_PERSISTENT_ID', '')
  const home = mkdtempSync(join(tmpdir(), 'dsh-ephemeral-id-'))
  try {
    const env = { DSH_HOME: home }
    const first = getOrCreateAnonymousUserId({ env })
    expect(getOrCreateAnonymousUserId({ env: { DSH_HOME: join(home, 'other') } })).toBe(first)
    expect(readdirSync(home)).toEqual([])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
