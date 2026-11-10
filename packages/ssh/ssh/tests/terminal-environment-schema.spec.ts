/** Terminal inheritance is admitted only in terminal-specific helper request fields. */
import { describe, expect, it } from 'vitest'
import { spawnSchema } from '../src/schemas.ts'

const base = { argv: ['node'], cwd: '/remote/workspace', graceMs: 100 }
const terminal = { terminalType: 'dumb', rows: 24, cols: 80 }
const stdio = { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }

describe('SSH terminal environment request validation', () => {
  it.each([undefined, 'scrubbed', 'inherit-user'] as const)('preserves the terminal mode %s', (environmentMode) => {
    expect(spawnSchema.parse({ ...base, terminal: { ...terminal, environmentMode } }).terminal?.environmentMode)
      .toBe(environmentMode)
  })

  it('rejects invalid modes and ordinary-process mode fields', () => {
    expect(() => spawnSchema.parse({ ...base, terminal: { ...terminal, environmentMode: 'ambient' } })).toThrow()
    expect(() => spawnSchema.parse({ ...base, stdio, environmentMode: 'inherit-user' })).toThrow()
    expect(() => spawnSchema.parse({ ...base, stdio: { ...stdio, environmentMode: 'inherit-user' } })).toThrow()
    expect(spawnSchema.parse({ ...base, stdio })).not.toHaveProperty('environmentMode')
  })
})
