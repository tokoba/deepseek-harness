/** Sidebar-only credential inheritance through the shipped Web profile, Remote mux and real PTY. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {} from '@deepseek-ai/dsh-api-terminal-controller'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

const names = ['SIDEBAR_ENV_KEY', 'SIDEBAR_ENV_PASSWORD', 'SIDEBAR_ENV_SECRET', 'SIDEBAR_ENV_TOKEN', 'DSH_SIDEBAR_ENV_INTERNAL', 'SIDEBAR_ENV_PLAIN']
const probe = `console.log('ENV_RESULT:' + ${JSON.stringify(names)}.map(name => process.env[name] || 'absent').join('|'))`
const filtered = 'absent|absent|absent|absent|absent|synthetic-5'
const inherited = 'synthetic-0|synthetic-1|synthetic-2|synthetic-3|absent|synthetic-5'

async function openTerminal(page: Page): Promise<void> {
  const expand = page.locator('[data-sidebar-right-expand]')
  if (await expand.isVisible()) await expand.click()
  const entry = page.locator('[data-sidebar-right-guide-entry="terminal"]')
  if (!await entry.isVisible()) await page.locator('[data-dockkit-add-tab]').click()
  await entry.getByRole('button', { name: /^New terminal/u }).click()
  await page.locator('.xterm-helper-textarea:visible').click()
}

async function assertEnvironment(page: Page, marker: string, value: string): Promise<void> {
  const script = probe.replace('ENV_RESULT:', marker).replaceAll('"', '\\"')
  const executable = process.execPath.replaceAll('\\', '/')
  await page.locator('.xterm-helper-textarea:visible').click()
  await page.keyboard.insertText(`"${executable}" -e "${script}"`)
  await page.keyboard.press('Enter')
  await expect.poll(() => page.locator('.xterm-rows:visible').innerText()).toContain(marker + value)
}

describe('Web sidebar environment inheritance', () => {
  let root: string | undefined
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined

  afterEach(async () => {
    try { await browser?.close() } finally {
      try { await scaffold?.close() } finally {
        vi.unstubAllEnvs()
        if (root !== undefined) await rm(root, { recursive: true, force: true })
      }
    }
    browser = undefined
    scaffold = undefined
    root = undefined
  })

  it.each(['scrubbed', 'inherit-user'] as const)('uses %s only for user terminals and preserves live shells across mode changes', async (environmentMode) => {
    root = await mkdtemp(join(tmpdir(), 'dsh-sidebar-env-'))
    for (const [index, name] of names.entries()) vi.stubEnv(name, `synthetic-${index}`)
    const overlay = join(root, 'terminal.patch.yml')
    await writeFile(overlay, `- id: terminal-controller\n  config:\n    environmentMode: ${environmentMode}\n`)
    scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
    browser = await chromium.launch()
    const page = await newEnglishPage(browser)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const agent = scaffold.ctx.agents.list()[0]
    if (agent === undefined) throw new Error('Workspace did not create an Agent')
    await openTerminal(page)
    const original = environmentMode === 'inherit-user' ? inherited : filtered
    await assertEnvironment(page, 'ENV_FIRST:', original)
    const controller = scaffold.ctx.terminalController
    const first = controller.list(agent.id)[0]
    if (first === undefined) throw new Error('Sidebar Terminal allocation is missing')

    const entry = scaffold.ctx.configEditor.entries().find(row => row.options.id === 'terminal-controller')
    if (entry === undefined) throw new Error('Terminal configuration entry is missing')
    const nextMode = environmentMode === 'inherit-user' ? 'scrubbed' : 'inherit-user'
    const uid = entry.fiber?.uid
    if (uid === undefined || uid === null) throw new Error('Terminal Loader fiber is inactive')
    // The scenario overlay owns this row; update that Loader entry instead of a lower-priority profile patch.
    await entry.update({ config: { environmentMode: nextMode } })
    expect(entry.fiber?.uid).toBe(uid)
    expect(controller.list(agent.id)).toMatchObject([{ id: first.id, state: 'running' }])
    await assertEnvironment(page, 'ENV_RETAINED:', original)
    await openTerminal(page)
    await assertEnvironment(page, 'ENV_NEW:', nextMode === 'inherit-user' ? inherited : filtered)

    const executable = process.execPath.replaceAll("'", "''")
    const command = process.platform === 'win32'
      ? `& '${executable}' -e '${probe.replaceAll("'", "''")}'`
      : `'${process.execPath.replaceAll("'", "'\\''")}' -e '${probe.replaceAll("'", "'\\''")}'`
    const result = await executeToolFixture(scaffold.ctx, {
      agent, callId: ToolCallId(`sidebar-env-agent-${environmentMode}`),
      name: process.platform === 'win32' ? 'pwsh' : 'bash',
      arguments: { command, description: 'Check synthetic credential isolation in agent shell' }, signal: new AbortController().signal,
    })
    expect(result.isError).not.toBe(true)
    expect(result.content.filter(block => block.type === 'text').map(block => block.text).join('')).toContain('ENV_RESULT:' + filtered)
    for (const terminal of controller.list(agent.id)) await controller.close(agent, terminal.id)
  })
})
