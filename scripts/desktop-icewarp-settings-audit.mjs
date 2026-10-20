import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { _electron as electron } from 'playwright-core'
import electronPath from 'electron'
import { desktopAuditEnvironment } from './electron-audit-environment.mjs'
const root = resolve(import.meta.dirname, '..'), profile = mkdtempSync(join(tmpdir(), 'aerio-icewarp-audit-'))
let application
try {
  application = await electron.launch({ executablePath: electronPath, args: [root, `--user-data-dir=${profile}`], cwd: root, env: desktopAuditEnvironment() })
  let page
  for (let attempt = 0; attempt < 5; attempt++) {
    page = application.windows().find((candidate) => !candidate.isClosed() && !candidate.url().startsWith('aerio-chat-service:')) ?? await application.waitForEvent('window')
    try { await page.getByRole('button', { name: 'Settings', exact: true }).waitFor({ timeout: 15_000 }); break } catch (error) { if (!page.isClosed()) throw error }
  }
  const chat = await page.evaluate(() => window.aerio.providerChat.snapshot())
  assert.ok(chat.providers.find((provider) => provider.id === 'icewarp' && provider.available))
  const status = await page.evaluate(() => window.aerio.meetingHosts.status())
  assert.ok(status.accounts.find((account) => account.provider === 'icewarp' && !account.connected))
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Aerio settings' })
  await dialog.getByLabel('IceWarp meetings server HTTPS URL').fill('http://invalid.example.test')
  await dialog.getByLabel('IceWarp conference API token').fill('disposable-unused-token')
  await dialog.getByRole('button', { name: 'Connect IceWarp meetings', exact: true }).click()
  await dialog.getByRole('alert').filter({ hasText: 'Enter the HTTPS IceWarp server URL' }).waitFor()
  assert.equal((await page.evaluate(() => window.aerio.meetingHosts.status())).accounts.find((account) => account.provider === 'icewarp').connected, false)
  console.log('Native IceWarp integration smoke passed: chat descriptor, conference status/settings, secure token control and real IPC HTTPS rejection. No server credentials or live API calls used.')
} finally {
  await application?.close()
  const target = resolve(profile), rel = relative(resolve(tmpdir()), target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || !target.includes('aerio-icewarp-audit-')) throw new Error('Unsafe audit cleanup path')
  rmSync(target, { recursive: true, force: true })
}
