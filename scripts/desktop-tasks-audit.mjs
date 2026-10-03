import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { _electron as electron } from 'playwright-core'
import electronPath from 'electron'
import { MailDatabase } from '../electron/mail/database.ts'
import { TaskStore } from '../electron/productivity/task-store.ts'
import { ProductivityStore } from '../electron/productivity/store.ts'
import { desktopAuditEnvironment } from './electron-audit-environment.mjs'

const root = resolve(import.meta.dirname, '..')
const profile = mkdtempSync(join(tmpdir(), 'aerio-tasks-audit-'))
const accountId = 'tasks-audit-account'
const list = { id: `${accountId}:list`, accountId, provider: 'gmail', remoteId: 'list', title: 'Provider audit list', readOnly: false }
const remote = { id: `${accountId}:task`, accountId, provider: 'gmail', remoteId: 'task', listId: list.id, remoteListId: 'list', title: 'Provider audit task', completed: false, revision: 'v1', readOnly: false }
let application
let taskId
async function launch() {
  application = await electron.launch({ executablePath: electronPath, args: [root, `--user-data-dir=${profile}`], cwd: root, env: desktopAuditEnvironment() })
  const page = await application.firstWindow()
  page.on('dialog', (dialog) => dialog.accept())
  await page.context().setOffline(true)
  await page.waitForSelector('.app')
  await page.evaluate(async () => {
    if (navigator.onLine) throw new Error('Tasks audit must stay offline')
    window.dispatchEvent(new Event('offline'))
    await window.aerio.mail.accounts.list()
  })
  return page
}

try {
  const preferences = new DatabaseSync(join(profile, 'aerio-state.sqlite'))
  preferences.exec('CREATE TABLE app_preferences(id INTEGER PRIMARY KEY, schema_version INTEGER NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL)')
  preferences.prepare('INSERT INTO app_preferences VALUES(1,1,?,?)').run(JSON.stringify({ schemaVersion: 1, settings: { theme: 'light', density: 'comfortable', closeToTray: false, launchAtLogin: false, notifications: false, startModule: 'tasks' } }), new Date().toISOString())
  preferences.close()
  const mail = new MailDatabase(join(profile, 'aerio.sqlite'), join(profile, 'mail'))
  mail.upsertAccount({ id: accountId, provider: 'gmail', email: 'tasks@example.test', displayName: 'Tasks audit', color: '#6558e8', status: 'ready', archived: false, signature: '', notifications: false, syncEnabled: false }); mail.close()
  const local = new ProductivityStore(join(profile, 'productivity.sqlite'))
  local.saveLocal({ tasks: [{ id: 'local-task', title: 'Local audit task', listId: 'Today', completed: false, priority: 'normal', subtasks: [] }], notes: [], contacts: [] }); local.close()
  const tasks = new TaskStore(join(profile, 'provider-tasks.sqlite'))
  tasks.replaceProviderSnapshot(accountId, 'gmail', { lists: [list], tasks: [remote], checkpoints: {} })
  taskId = tasks.entities(accountId, 'gmail')[0].id; tasks.close()
  let page = await launch()
  // This synthetic grant contains no token or real account credentials. All
  // network processing stays offline, including before enabling the account.
  const encrypted = await application.evaluate(({ safeStorage }) => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Native secure storage is required for the Tasks audit')
    const fixture = { googleTokens: { 'tasks-audit-account': { scope: 'https://www.googleapis.com/auth/tasks' } }, googleCalendarWrite: {}, microsoftTokens: {}, imapAccounts: {} }
    return safeStorage.encryptString(JSON.stringify(fixture)).toString('base64')
  })
  writeFileSync(join(profile, 'oauth-vault.dat'), encrypted)
  await page.evaluate(async (accountId) => {
    await window.aerio.mail.accounts.update({ accountId, displayName: 'Tasks audit', color: '#6558e8', signature: '', notifications: false, syncEnabled: true })
  }, accountId)
  // Reenabling the account publishes its fresh permissions through the
  // production event, allowing the editor to become writable automatically.
  await page.getByRole('button', { name: /Provider audit list/ }).click()
  await page.getByRole('button', { name: 'Open task Provider audit task' }).click()
  let editor = page.getByRole('dialog', { name: 'Google task' })
  await editor.getByLabel('Task', { exact: true }).fill('Offline edited task')
  await editor.getByLabel('Repeat in Aerio').selectOption('weekly')
  await editor.getByLabel('Due date').fill('2026-10-01')
  await editor.getByRole('button', { name: 'Save task', exact: true }).click()
  await editor.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: 'Complete Offline edited task' }).click()
  let snapshot = await page.evaluate(() => window.aerio.tasks.snapshot())
  assert.equal(snapshot.tasks.length, 2)
  const successor = snapshot.tasks.find((task) => task.id !== taskId)
  assert.equal(successor.fields.due, '2026-10-08')
  assert.equal(successor.local.recurrence, 'weekly')
  assert.ok(snapshot.operations.every((operation) => operation.attempts === 0 && operation.status === 'queued'))
  assert.equal((await page.evaluate(() => window.aerio.productivity.localSnapshot())).tasks[0].title, 'Local audit task')
  console.log('✓ real renderer/preload/main/SQLite persist offline provider edits and recurrence without changing local tasks')
  // Disable syncing before closing so the next startup cannot attempt a
  // provider request before the audit reports offline again.
  await page.evaluate(async (accountId) => {
    await window.aerio.mail.accounts.update({ accountId, displayName: 'Tasks audit', color: '#6558e8', signature: '', notifications: false, syncEnabled: false })
  }, accountId)
  await application.close(); application = undefined
  page = await launch()
  await page.evaluate(async (accountId) => {
    await window.aerio.mail.accounts.update({ accountId, displayName: 'Tasks audit', color: '#6558e8', signature: '', notifications: false, syncEnabled: true })
  }, accountId)
  snapshot = await page.evaluate(() => window.aerio.tasks.snapshot())
  assert.equal(snapshot.tasks.find((task) => task.id === taskId).fields.completed, true)
  assert.equal(snapshot.tasks.find((task) => task.id === successor.id).fields.due, '2026-10-08')
  const completion = snapshot.operations.find((operation) => operation.patch.completed === true)
  await page.evaluate(async (id) => { await window.aerio.tasks.undo(id) }, completion.id)
  snapshot = await page.evaluate(() => window.aerio.tasks.snapshot())
  assert.equal(snapshot.tasks.length, 1)
  assert.equal(snapshot.tasks[0].fields.completed, false)
  assert.ok(snapshot.operations.filter((operation) => operation.kind === 'create').every((operation) => operation.status === 'cancelled'))
  console.log('✓ full quit/relaunch retains stable identities and pending work; undo cancels the unsent recurring successor')
  await page.getByRole('button', { name: /^Manage Google lists for/ }).click()
  let listManager = page.getByRole('dialog', { name: 'Google task lists' })
  await listManager.getByLabel('List name', { exact: true }).fill('Offline new list')
  await listManager.getByRole('button', { name: 'Create Google list', exact: true }).click()
  await page.getByText('List change saved', { exact: true }).waitFor()
  snapshot = await page.evaluate(() => window.aerio.tasks.snapshot())
  const listCreation = snapshot.listOperations.find((operation) => operation.title === 'Offline new list')
  assert.equal(listCreation.status, 'queued')
  assert.equal(listCreation.attempts, 0)
  assert.equal(snapshot.lists.length, 1)
  await listManager.getByRole('button', { name: 'Done', exact: true }).click()
  const backupPath = join(profile, 'connected-task-backup.json')
  await application.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, backupPath)
  await page.getByRole('button', { name: 'Back up connected tasks', exact: true }).click()
  await page.getByText('Connected tasks backup saved', { exact: true }).waitFor()
  const backup = JSON.parse(readFileSync(backupPath, 'utf8'))
  assert.equal(backup.format, 'aerio-provider-tasks')
  assert.equal(backup.entities.find((task) => task.id === taskId).local.recurrence, 'weekly')
  assert.equal(backup.listOperations.find((operation) => operation.id === listCreation.id).status, 'queued')
  await page.evaluate(async (id) => { await window.aerio.tasks.update(id, { title: 'Changed after backup' }) }, taskId)
  await page.getByRole('button', { name: 'Restore connected tasks', exact: true }).click()
  await page.getByText('Connected tasks restored. Pending changes require review.', { exact: true }).waitFor()
  snapshot = await page.evaluate(() => window.aerio.tasks.snapshot())
  assert.equal(snapshot.tasks[0].fields.title, 'Offline edited task')
  assert.equal(snapshot.tasks[0].local.recurrence, 'weekly')
  assert.ok(snapshot.operations.filter((operation) => operation.status !== 'cancelled').every((operation) => operation.status === 'review' && operation.error === 'restored-write'))
  await page.getByRole('button', { name: /Provider audit list/ }).click()
  await page.getByRole('button', { name: 'Review change', exact: true }).click()
  await page.getByText(/This change was restored from backup/).waitFor()
  await page.getByRole('dialog', { name: 'Review task change' }).getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('button', { name: /^Manage Google lists for/ }).click()
  listManager = page.getByRole('dialog', { name: 'Google task lists' })
  await listManager.getByRole('button', { name: 'Review list change', exact: true }).click()
  await listManager.getByText('This list change was restored from backup. Review it before sending.', { exact: true }).waitFor()
  await listManager.getByRole('button', { name: 'Done', exact: true }).click()
  assert.equal((await page.evaluate(() => window.aerio.productivity.localSnapshot())).tasks[0].title, 'Local audit task')
  await page.evaluate(async (accountId) => {
    await window.aerio.mail.accounts.update({ accountId, displayName: 'Tasks audit', color: '#6558e8', signature: '', notifications: false, syncEnabled: false })
  }, accountId)
  await application.close(); application = undefined
  page = await launch()
  snapshot = await page.evaluate(() => window.aerio.tasks.snapshot())
  assert.equal(snapshot.tasks[0].id, taskId)
  assert.ok(snapshot.operations.filter((operation) => operation.status !== 'cancelled').every((operation) => operation.status === 'review' && operation.error === 'restored-write'))
  assert.equal(snapshot.listOperations.find((operation) => operation.id === listCreation.id).status, 'review')
  assert.equal(snapshot.listOperations.find((operation) => operation.id === listCreation.id).attempts, 0)
  console.log('✓ real backup file dialogs restore metadata and stable identities, preserve local data, and hold pending writes for review across restart')
} finally {
  if (application) await application.close().catch(() => {})
  const location = relative(tmpdir(), profile)
  assert.ok(location && !location.startsWith('..') && !isAbsolute(location) && location.startsWith('aerio-tasks-audit-'))
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
