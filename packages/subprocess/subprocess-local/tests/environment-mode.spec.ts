/** Terminal-only credential inheritance retains the shared environment composition rules. */
import { Context } from '@deepseek-ai/cordis'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { scrubbedParentEnv, terminalParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessSpawnSpec, SubprocessTerminalEnvironmentMode, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { SUBPROCESS_CONTROL_ENV } from '@deepseek-ai/dsh-subprocess/control'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import LocalSubprocessRuntime from '../src/index.ts'
import { targetEnvironment } from '../src/runner-launch.ts'
import { childEnv } from '../src/spawn.ts'

const credentials = ['TERMINAL_ENV_KEY', 'TERMINAL_ENV_PASSWORD', 'TERMINAL_ENV_SECRET', 'TERMINAL_ENV_TOKEN']
const internal = ['DSH_TERMINAL_ENV_UPPER', 'dsh_terminal_env_lower']
const names = [...credentials, ...internal, 'TERMINAL_ENV_PLAIN', 'DSH_SESSION_ID']

function seedEnvironment(): void {
  for (const name of credentials) vi.stubEnv(name, 'fixture-credential')
  for (const name of internal) vi.stubEnv(name, 'stale-internal')
  vi.stubEnv('TERMINAL_ENV_PLAIN', 'visible')
  vi.stubEnv('DSH_SESSION_ID', 'stale-session')
}

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('terminal environment mode', () => {
  it('keeps ordinary request types mode-free and preserves the scrubbed helper', () => {
    expectTypeOf<SubprocessSpawnSpec>().not.toHaveProperty('environmentMode')
    expectTypeOf<SubprocessTerminalEnvironmentMode>().toEqualTypeOf<'scrubbed' | 'inherit-user'>()
    const parsed: Pick<SubprocessTerminalSpawnSpec, 'environmentMode'> = { environmentMode: undefined }
    expect(parsed.environmentMode).toBeUndefined()
    seedEnvironment()
    const ordinary = scrubbedParentEnv()
    expect(terminalParentEnv('scrubbed')).toEqual(ordinary)
    for (const name of [...credentials, ...internal]) expect(ordinary[name]).toBeUndefined()
    expect(ordinary.TERMINAL_ENV_PLAIN).toBe('visible')
    const inherited = terminalParentEnv('inherit-user')
    for (const name of credentials) expect(inherited[name]).toBe('fixture-credential')
    for (const name of internal) expect(inherited[name]).toBeUndefined()
    expect(inherited.DSH_SESSION_ID).toBeUndefined()
  })

  it('preserves proxy normalization instead of stale ambient values', async () => {
    const dispose = await installProxyFromEnvironment(createLaunchEnvironmentSnapshot([{
      source: 'process', values: { ALL_PROXY: 'http://127.0.0.1:32123' },
    }]), () => undefined)
    try {
      vi.stubEnv('https_proxy', 'http://stale.invalid:32124')
      const scrubbed = scrubbedParentEnv()
      const inherited = terminalParentEnv('inherit-user')
      expect(inherited.HTTP_PROXY).toBe(scrubbed.HTTP_PROXY)
      expect(inherited.HTTPS_PROXY).toBe(scrubbed.HTTPS_PROXY)
      expect(inherited.NODE_USE_ENV_PROXY).toBe('1')
      expect(inherited.NO_PROXY).toBe(scrubbed.NO_PROXY)
      expect(inherited.https_proxy).toBe(scrubbed.https_proxy)
      expect(inherited.https_proxy).not.toBe('http://stale.invalid:32124')
    } finally { await dispose() }
  })

  it.each(['scrubbed', 'inherit-user'] as const)('merges Windows overrides case-insensitively in %s mode', (mode) => {
    seedEnvironment()
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const env = childEnv({ terminal_env_key: 'explicit', dsh_session_id: 'current-session' }, mode)
    expect(Object.keys(env).filter(key => key.toUpperCase() === 'TERMINAL_ENV_KEY')).toEqual(['terminal_env_key'])
    expect(env.terminal_env_key).toBe('explicit')
    expect(Object.keys(env).filter(key => key.toUpperCase() === 'DSH_SESSION_ID')).toEqual(['dsh_session_id'])
    expect(env.dsh_session_id).toBe('current-session')
    expect(env.dsh_terminal_env_lower).toBeUndefined()
    expect(childEnv({ terminal_env_plain: undefined }, mode).terminal_env_plain).toBeUndefined()
    expect(Object.keys(childEnv({ terminal_env_plain: undefined }, mode))).not.toContain('TERMINAL_ENV_PLAIN')
  })

  it.each(['scrubbed', 'inherit-user'] as const)('retains NUL validation and private-control checks in %s mode', (mode) => {
    const spec = { argv: ['node'], cwd: process.cwd() }
    for (const invalid of [
      { ...spec, argv: ['node\0'] }, { ...spec, cwd: 'bad\0cwd' },
      { ...spec, env: { 'BAD\0KEY': 'value' } }, { ...spec, env: { BAD: 'value\0' } },
    ]) expect(() => targetEnvironment(invalid, mode)).toThrow('must be a string without null bytes')
    expect(() => targetEnvironment({ ...spec, env: { [SUBPROCESS_CONTROL_ENV.toLowerCase()]: 'spoof' } }, mode))
      .toThrow('reserved for subprocess control-channel setup')
    expect(targetEnvironment({ ...spec, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', control: 'pipe' } }, mode))
      .toHaveProperty(SUBPROCESS_CONTROL_ENV, 'pipe')
  })

  it.each([undefined, 'scrubbed', 'inherit-user'] as const)('uses %s only for real PTY allocation and leaves ordinary children filtered', async (environmentMode) => {
    seedEnvironment()
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    try {
      const script = `const names=${JSON.stringify(names)}; process.stdout.write('ENV:'+JSON.stringify(names.map(name=>process.env[name]??null))+'\\n')`
      const ordinary = ctx.subprocess.spawn({
        argv: [process.execPath, '-e', script], cwd: process.cwd(), graceMs: 200,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
      })
      expect(await ordinary.done).toEqual({ exitCode: 0, signal: null })
      expect(await ordinary.waitForExit()).toBe(true)
      expect(ordinary.collected.stdout?.readFrom(0).text)
        .toContain('ENV:' + JSON.stringify([...credentials.map(() => null), ...internal.map(() => null), 'visible', null]))
      const childScript = `process.stdout.write('CHILD:'+JSON.stringify(${JSON.stringify(names)}.map(name=>process.env[name]??null))+'\\n')`
      const argv = [process.execPath, '-e', script + `;require('node:child_process').execFileSync(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'inherit'})`]
      const terminal = await ctx.subprocess.spawnTerminal({
        argv, cwd: process.cwd(), rows: 24, cols: 500, terminalType: 'dumb', graceMs: 200,
        env: { DSH_SESSION_ID: 'current-session' },
        ...environmentMode === undefined ? {} : { environmentMode },
      })
      let output = ''
      const drain = (async () => { for await (const chunk of terminal.output) output += String(chunk) })()
      expect(await terminal.done).toEqual({ exitCode: 0, signal: null })
      await drain
      await terminal.terminate()
      const value = environmentMode === 'inherit-user' ? 'fixture-credential' : null
      const expected = JSON.stringify([...credentials.map(() => value), ...internal.map(() => null), 'visible', 'current-session'])
      expect(output).toContain('ENV:' + expected)
      expect(output).toContain('CHILD:' + expected)
    } finally { await fiber.dispose() }
  })
})
