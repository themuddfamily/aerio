import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { _electron as electron } from 'playwright-core'
import electronPath from 'electron'
import { desktopAuditEnvironment } from './electron-audit-environment.mjs'

const root = resolve(import.meta.dirname, '..')
const profile = mkdtempSync(join(tmpdir(), 'aerio-app-lock-audit-'))
const passphrase = 'local audit passphrase'
let application

async function launch() {
  application = await electron.launch({ executablePath: electronPath, args: [root, `--user-data-dir=${profile}`], cwd: root, env: desktopAuditEnvironment() })
  const page = await application.firstWindow()
  await page.context().setOffline(true)
  await page.waitForSelector('.app')
  return page
}

async function unlock(page) {
  await page.getByLabel('Passphrase', { exact: true }).fill(passphrase)
  await page.getByRole('button', { name: 'Unlock Aerio', exact: true }).click()
  await page.waitForSelector('.app-locked', { state: 'detached' })
}

async function assertLocked(page) {
  await page.waitForSelector('.app-locked')
  assert.deepEqual(await page.evaluate(() => window.aerio.appLock.status()), { enabled: true, locked: true })
  assert.equal(await page.getByRole('button', { name: 'Settings', exact: true }).count(), 0)
  await assert.rejects(page.evaluate(() => window.aerio.window.openMessage({ source: 'connected', accountId: 'fixture', threadId: 'private-thread', title: 'Private message' })), /Unlock Aerio/)
}

try {
  let page = await launch()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  let settings = page.getByRole('dialog', { name: 'Aerio settings' })
  await settings.getByLabel('New passphrase', { exact: true }).fill(passphrase)
  await settings.getByLabel('Confirm passphrase', { exact: true }).fill(passphrase)
  await settings.getByRole('button', { name: 'Enable app lock', exact: true }).click()
  await settings.getByRole('button', { name: 'Lock Aerio now', exact: true }).waitFor()
  await settings.getByRole('button', { name: 'Close', exact: true }).click()

  const messageOpened = application.waitForEvent('window')
  await page.evaluate(() => window.aerio.window.openMessage({ source: 'connected', accountId: 'fixture', threadId: 'private-thread', title: 'Private message' }))
  const message = await messageOpened
  const messageClosed = message.waitForEvent('close')
  await page.keyboard.press('Control+l')
  await messageClosed
  await assertLocked(page)
  await page.getByLabel('Passphrase', { exact: true }).fill('incorrect passphrase')
  await page.getByRole('button', { name: 'Unlock Aerio', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: /incorrect/ }).waitFor()
  assert.equal(await page.getByLabel('Passphrase', { exact: true }).inputValue(), '')
  await assertLocked(page)
  await unlock(page)
  console.log('✓ keyboard locking closes message windows; incorrect unlock keeps the workspace hidden')

  // Hidden audit windows do not produce a native hide event. Emit that exact
  // event to exercise the production tray handler without showing a window.
  const mainWindow = await application.browserWindow(page)
  await mainWindow.evaluate((window) => window.emit('hide'))
  await assertLocked(page)
  await unlock(page)
  console.log('✓ sending the main window to the tray locks the workspace')
  await application.close(); application = undefined

  page = await launch()
  await assertLocked(page)
  await unlock(page)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  settings = page.getByRole('dialog', { name: 'Aerio settings' })
  await settings.getByLabel('Current passphrase', { exact: true }).fill(passphrase)
  page.once('dialog', (dialog) => dialog.accept())
  await settings.getByRole('button', { name: 'Turn off app lock', exact: true }).click()
  await settings.getByRole('button', { name: 'Enable app lock', exact: true }).waitFor()
  await application.close(); application = undefined
  page = await launch()
  await page.getByRole('button', { name: 'Settings', exact: true }).waitFor()
  assert.deepEqual(await page.evaluate(() => window.aerio.appLock.status()), { enabled: false, locked: false })
  console.log('✓ launch requires the persisted passphrase until app lock is explicitly disabled')
} finally {
  if (application) await application.close().catch(() => undefined)
  const location = relative(tmpdir(), profile)
  assert.ok(location && !location.startsWith('..') && !isAbsolute(location) && location.startsWith('aerio-app-lock-audit-'))
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
