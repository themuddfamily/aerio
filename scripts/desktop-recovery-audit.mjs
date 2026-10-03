import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { _electron as electron } from 'playwright-core'
import electronPath from 'electron'
import { MailDatabase } from '../electron/mail/database.ts'
import { desktopAuditEnvironment } from './electron-audit-environment.mjs'

const root = resolve(import.meta.dirname, '..')
const profile = mkdtempSync(join(tmpdir(), 'aerio-recovery-audit-'))
const databasePath = join(profile, 'aerio.sqlite'), contentPath = join(profile, 'mail')
const accountId = 'recovery-account'
const legacyPath = join(profile, 'aerio-demo.sqlite')
const legacyPreferences = { schemaVersion: 1, settings: { theme: 'light', density: 'compact', closeToTray: true, launchAtLogin: false, notifications: false, startModule: 'mail', profile: { displayName: 'Migration fixture', email: 'migration@example.test' } } }
let application

function fixture() {
  const db = new MailDatabase(databasePath, contentPath)
  try {
    db.upsertAccount({ id: accountId, provider: 'gmail', email: 'audit@example.test', displayName: 'Recovery audit', color: '#6558e8', status: 'needs-auth', archived: false, signature: '', notifications: false, syncEnabled: false })
    db.addInventory(accountId, [{ id: 'message', threadId: 'thread' }])
    const rawPath = join(profile, 'message.eml')
    writeFileSync(rawPath, 'From: sender@example.test\r\nSubject: Recovery fixture\r\n\r\nBody')
    db.upsertMessage({ accountId, id: 'message', threadId: 'thread', historyId: '1', internalDate: new Date().toISOString(), fromName: 'Sender', fromEmail: 'sender@example.test', to: ['audit@example.test'], cc: [], subject: 'Recovery fixture', references: [], messageIdHeader: '<recovery@example.test>', snippet: 'Body', text: 'Body', html: '<p>Body</p>', labelIds: [], sizeEstimate: 70, rawPath, attachments: [] })
  } finally { db.close() }
}

async function launchOffline() {
  application = await electron.launch({ executablePath: electronPath, args: [root, `--user-data-dir=${profile}`], cwd: root, env: desktopAuditEnvironment() })
  const page = await application.firstWindow()
  await page.context().setOffline(true)
  await page.waitForSelector('.app')
  await page.evaluate(() => {
    if (navigator.onLine) throw new Error('The isolated preload must observe a real offline browser context')
    window.dispatchEvent(new Event('offline'))
  })
  // A subsequent IPC request gives the worker time to handle the offline report.
  await page.evaluate(() => window.aerio.mail.accounts.list())
  return page
}

async function waitUntil(predicate, description) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out: ${description}`)
}

try {
  fixture()
  const legacy = new DatabaseSync(legacyPath)
  legacy.exec('CREATE TABLE app_state(id INTEGER PRIMARY KEY, payload TEXT)')
  legacy.prepare('INSERT INTO app_state VALUES(1, ?)').run(JSON.stringify({ ...legacyPreferences, notes: [{ id: 'sample-note', title: 'Do not import sample content' }] }))
  legacy.close()
  const legacyBytes = readFileSync(legacyPath)
  let page = await launchOffline()
  assert.deepEqual(await page.evaluate(() => window.aerio.loadPreferences()), legacyPreferences)
  assert.deepEqual(await page.evaluate(() => window.aerio.productivity.localSnapshot()), { tasks: [], notes: [], contacts: [] })
  assert.deepEqual(readFileSync(legacyPath), legacyBytes)
  console.log('✓ legacy preferences migrate without importing sample content or modifying the legacy database')
  await page.evaluate(async (accountId) => {
    const draft = { id: 'scheduled', accountId, to: ['reader@example.test'], cc: [], bcc: [], subject: 'Scheduled recovery', text: 'Body', attachmentPaths: [] }
    await window.aerio.mail.drafts.schedule(draft, new Date(Date.now() + 2_500).toISOString())
    await window.aerio.mail.drafts.send({ ...draft, id: 'undone' })
    await window.aerio.mail.drafts.cancelSend('undone')
    await window.aerio.mail.mail.snooze(accountId, ['thread'], new Date(Date.now() + 2_500).toISOString())
  }, accountId)
  const mainWindow = await application.browserWindow(page)
  await page.getByRole('button', { name: 'Close', exact: true }).first().click()
  await waitUntil(() => mainWindow.evaluate((window) => !window.isVisible() || window.isMinimized()), 'reachable background close')
  await waitUntil(() => page.evaluate(async (accountId) => (await window.aerio.mail.mail.list({ folder: 'inbox', accountIds: [accountId] })).items.some((thread) => thread.id === 'thread'), accountId), 'tray worker restoring the snoozed conversation')
  assert.equal(await page.evaluate(async () => (await window.aerio.mail.drafts.get('scheduled')).status), 'scheduled')
  assert.equal(await page.evaluate(async () => (await window.aerio.mail.drafts.get('undone')).status), 'local')
  console.log('✓ tray mode continues snooze processing while offline delivery and Undo Send remain safe')
  await application.close(); application = undefined

  const db = new MailDatabase(databasePath, contentPath)
  const dueAt = new Date(Date.now() + 1_000).toISOString()
  try {
    db.snoozeThreads(accountId, ['thread'], dueAt)
    db.applyLocalAction({ accountId, threadIds: ['thread'], action: 'archive' }, 'quit-archive', 0)
    db.updateOperation('quit-archive', 'succeeded')
    db.saveDraft({ id: 'quit-scheduled', accountId, to: ['reader@example.test'], cc: [], bcc: [], subject: 'Quit recovery', text: 'Body', attachmentPaths: [] }, { status: 'scheduled', deliveryAt: dueAt })
  } finally { db.close() }
  await new Promise((resolve) => setTimeout(resolve, 1_200))
  const stopped = new MailDatabase(databasePath, contentPath)
  try {
    assert.equal(stopped.getDraftRecord('quit-scheduled').status, 'scheduled')
    assert.equal(stopped.listThreads({ folder: 'inbox', accountIds: [accountId] }).total, 0)
  } finally { stopped.close() }
  page = await launchOffline()
  assert.deepEqual(await page.evaluate(() => window.aerio.loadPreferences()), legacyPreferences)
  await waitUntil(() => page.evaluate(async (accountId) => (await window.aerio.mail.mail.list({ folder: 'inbox', accountIds: [accountId] })).items.some((thread) => thread.id === 'thread'), accountId), 'relaunch restoring the overdue snooze')
  assert.equal(await page.evaluate(async () => (await window.aerio.mail.drafts.get('quit-scheduled')).status), 'scheduled')
  assert.equal(await page.evaluate(async () => (await window.aerio.mail.drafts.get('undone')).status), 'local')
  console.log('✓ full quit defers due work; relaunch recovers reminders and preserves unsent/cancelled drafts')

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Aerio settings' })
  await settings.getByRole('checkbox', { name: /Keep scheduling active in the tray/ }).uncheck()
  await waitUntil(() => page.evaluate(async () => !(await window.aerio.loadPreferences()).settings.closeToTray), 'persisted close-to-tray setting')
  await settings.getByRole('button', { name: 'Close', exact: true }).click()
  const exited = new Promise((resolve) => application.process().once('exit', resolve))
  const closed = page.waitForEvent('close', { timeout: 10_000 })
  // A fast native exit can close the renderer before Playwright acknowledges its click.
  await page.getByRole('button', { name: 'Close', exact: true }).first().click().catch((error) => {
    if (!/Target page, context or browser has been closed/.test(error.message)) throw error
  })
  await closed
  if (process.platform === 'darwin') {
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 0)
    assert.equal(application.process().exitCode, null)
    await application.close()
  }
  await Promise.race([exited, new Promise((_, reject) => { const timeout = setTimeout(() => reject(new Error('Close without tray did not exit')), 10_000); timeout.unref() })])
  application = undefined
  console.log(process.platform === 'darwin'
    ? '✓ disabling close-to-tray closes the last window; macOS stays available until full quit'
    : '✓ disabling close-to-tray causes a real process exit')
} finally {
  if (application) await application.close().catch(() => undefined)
  const location = relative(tmpdir(), profile)
  assert.ok(location && !location.startsWith('..') && !isAbsolute(location) && location.startsWith('aerio-recovery-audit-'))
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
