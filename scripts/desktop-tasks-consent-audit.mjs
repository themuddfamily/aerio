import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { _electron as electron } from 'playwright-core'
import electronPath from 'electron'
import { MailDatabase } from '../electron/mail/database.ts'
import { desktopAuditEnvironment } from './electron-audit-environment.mjs'

const root = resolve(import.meta.dirname, '..')
const profile = mkdtempSync(join(tmpdir(), 'aerio-tasks-consent-audit-'))
const email = 'consent@example.test'
const accountId = createHash('sha256').update(email).digest('hex').slice(0, 24)
const listId = `${accountId}:google-task-list:list`
let application, page
async function launch(previous) {
  application = await electron.launch({ executablePath: electronPath, args: [root, `--user-data-dir=${profile}`], cwd: root, env: desktopAuditEnvironment() })
  page = await application.firstWindow(); page.setDefaultTimeout(15_000)
  await page.context().setOffline(true)
  await page.waitForSelector('.app')
  await page.evaluate(async () => { window.dispatchEvent(new Event('offline')); await window.aerio.mail.accounts.list() })
  await application.evaluate((_electron, { root, previous, email }) => {
    const require = process.getBuiltinModule('module').createRequire(`${root}/package.json`)
    require(`${root}/scripts/fixtures/task-consent-fixture.cjs`).install(previous, email)
  }, { root, previous, email })
}
async function online() {
  await page.context().setOffline(false)
  await page.evaluate(async () => { window.dispatchEvent(new Event('online')); await window.aerio.mail.accounts.list() })
}
async function waitForSnapshot(predicate) {
  const deadline = Date.now() + 15_000
  let snapshot
  do {
    snapshot = await page.evaluate(() => window.aerio.tasks.snapshot())
    if (predicate(snapshot)) return snapshot
    await new Promise((resolve) => setTimeout(resolve, 50))
  } while (Date.now() < deadline)
  throw new Error(`Consent audit state did not settle: ${JSON.stringify(snapshot.accounts)}`)
}
try {
  const preferences = new DatabaseSync(join(profile, 'aerio-state.sqlite'))
  preferences.exec('CREATE TABLE app_preferences(id INTEGER PRIMARY KEY, schema_version INTEGER NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL)')
  preferences.prepare('INSERT INTO app_preferences VALUES(1,1,?,?)').run(JSON.stringify({ schemaVersion: 1, settings: { theme: 'light', density: 'comfortable', closeToTray: false, launchAtLogin: false, notifications: false, startModule: 'tasks' } }), new Date().toISOString())
  preferences.close()
  const mail = new MailDatabase(join(profile, 'aerio.sqlite'), join(profile, 'mail'))
  mail.upsertAccount({ id: accountId, provider: 'gmail', email, displayName: 'Consent audit', color: '#6558e8', status: 'paused', archived: false, signature: '', notifications: false, syncEnabled: true }); mail.close()
  await launch()
  const encrypted = await application.evaluate(({ safeStorage }, accountId) => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Native secure storage is required')
    const fixture = { googleConfig: { clientId: 'fixture', clientSecret: 'fixture' }, googleTokens: { [accountId]: { access_token: 'synthetic-consent-token', expiry_date: Date.now() + 3_600_000, scope: 'https://www.googleapis.com/auth/tasks' } }, googleCalendarWrite: {}, microsoftTokens: {}, imapAccounts: {} }
    return safeStorage.encryptString(JSON.stringify(fixture)).toString('base64')
  }, accountId)
  writeFileSync(join(profile, 'oauth-vault.dat'), encrypted)
  await online()
  await page.evaluate(async (id) => { await window.aerio.tasks.sync(id) }, accountId)
  let snapshot = await page.evaluate(() => window.aerio.tasks.snapshot())
  const taskId = snapshot.tasks[0].id
  await page.getByRole('button', { name: /Consent audit list/ }).click()
  await application.evaluate(() => { globalThis.taskConsentAudit.loseTaskCreate = true; globalThis.taskConsentAudit.loseListCreate = true })
  await page.evaluate(async ({ accountId, listId }) => {
    await window.aerio.tasks.create(accountId, listId, { title: 'Uncertain task', completed: false })
    await window.aerio.tasks.createList(accountId, 'Uncertain list')
  }, { accountId, listId })
  snapshot = await waitForSnapshot((snapshot) => snapshot.operations.some((op) => op.status === 'review') && snapshot.listOperations?.some((op) => op.status === 'review'))
  const uncertainTask = snapshot.operations.find((op) => op.status === 'review').id
  const uncertainList = snapshot.listOperations.find((op) => op.status === 'review').id
  await page.context().setOffline(true)
  await page.evaluate(async ({ taskId, listId }) => {
    window.dispatchEvent(new Event('offline')); await window.aerio.mail.accounts.list()
    await window.aerio.tasks.update(taskId, { title: 'Pending task rename' })
    await window.aerio.tasks.renameList(listId, 'Pending list rename')
  }, { taskId, listId })
  const writesBeforeConsent = await application.evaluate(() => globalThis.taskConsentAudit.writes.length)
  await application.evaluate(() => { globalThis.taskConsentAudit.scope = 'https://www.googleapis.com/auth/tasks.readonly' })
  await page.evaluate(async (id) => { await window.aerio.mail.accounts.reconnect(id) }, accountId)
  await online()
  snapshot = await page.evaluate(async (id) => window.aerio.tasks.sync(id), accountId)
  assert.equal(snapshot.accounts[0].canRead, true); assert.equal(snapshot.accounts[0].canWrite, false)
  assert.ok(snapshot.lists.every((list) => list.readOnly))
  assert.ok(snapshot.operations.filter((op) => op.status === 'queued').every((op) => op.attempts === 0))
  assert.ok(snapshot.listOperations.filter((op) => op.status === 'queued').every((op) => op.attempts === 0))
  assert.equal(await application.evaluate(() => globalThis.taskConsentAudit.writes.length), writesBeforeConsent)
  assert.equal(await page.getByRole('button', { name: 'Complete Pending task rename', exact: true }).isDisabled(), true)
  const deniedMutation = await page.evaluate(async (id) => { try { await window.aerio.tasks.update(id, { title: 'Forbidden' }); return false } catch { return true } }, taskId)
  assert.equal(deniedMutation, true)
  console.log('✓ real reconnect accepts read-only consent, preserves task/list queues and review holds, and blocks edits and dispatch')

  await application.evaluate(() => { globalThis.taskConsentAudit.denied = true })
  await page.getByRole('button', { name: 'Connect Google Tasks', exact: true }).click()
  await page.getByText(/Google sign-in failed: access_denied/).waitFor()
  snapshot = await page.evaluate(() => window.aerio.tasks.snapshot())
  assert.equal(snapshot.accounts[0].canWrite, false)
  assert.equal(await application.evaluate(() => globalThis.taskConsentAudit.writes.length), writesBeforeConsent)
  await application.evaluate(() => { globalThis.taskConsentAudit.denied = false; globalThis.taskConsentAudit.scope = 'https://www.googleapis.com/auth/gmail.modify' })
  await page.evaluate(async (id) => { await window.aerio.mail.accounts.reconnect(id) }, accountId)
  snapshot = await page.evaluate(() => window.aerio.tasks.snapshot())
  assert.equal(snapshot.accounts[0].canRead, false); assert.equal(snapshot.accounts[0].canWrite, false)
  console.log('✓ denied consent leaves existing access intact; a grant without Tasks scope revokes access without discarding local intent')

  await page.context().setOffline(true)
  await page.evaluate(async () => { window.dispatchEvent(new Event('offline')); await window.aerio.mail.accounts.list() })
  const previous = await application.evaluate(() => globalThis.taskConsentAudit)
  await application.close(); application = undefined
  // The persisted grant has no Tasks scope and mail remains paused, so neither
  // provider can run before the controlled fixture is installed on relaunch.
  await launch(previous)
  snapshot = await page.evaluate(() => window.aerio.tasks.snapshot())
  assert.equal(snapshot.tasks.find((task) => task.id === taskId).fields.title, 'Pending task rename')
  assert.equal(snapshot.accounts[0].canRead, false)
  assert.equal(snapshot.operations.find((op) => op.id === uncertainTask).status, 'review')
  assert.equal(snapshot.listOperations.find((op) => op.id === uncertainList).status, 'review')
  await online()
  await application.evaluate(() => { globalThis.taskConsentAudit.scope = 'https://www.googleapis.com/auth/tasks' })
  await page.getByRole('button', { name: 'Connect Google Tasks', exact: true }).click()
  await page.getByText('Google Tasks connected', { exact: true }).waitFor()
  snapshot = await waitForSnapshot((snapshot) => snapshot.operations.some((op) => op.patch.title === 'Pending task rename' && op.status === 'succeeded') && snapshot.listOperations?.some((op) => op.title === 'Pending list rename' && op.status === 'succeeded'))
  assert.equal(snapshot.tasks.find((task) => task.id === taskId).fields.title, 'Pending task rename')
  assert.equal(snapshot.operations.find((op) => op.id === uncertainTask).status, 'review')
  assert.equal(snapshot.listOperations.find((op) => op.id === uncertainList).status, 'review')
  const state = await application.evaluate(() => globalThis.taskConsentAudit)
  assert.equal(state.taskCreates, 1); assert.equal(state.listCreates, 1)
  assert.equal(state.writes.filter((write) => write.kind === 'task' && write.method === 'PATCH' && write.id === 'original').length, 1)
  assert.equal(state.writes.filter((write) => write.kind === 'list' && write.method === 'PATCH' && write.id === 'list').length, 1)
  assert.equal(state.oauth.browserOpens, 4); assert.equal(state.oauth.tokenExchanges, 3)
  assert.equal(state.oauth.pkceMatches, 3); assert.equal(state.oauth.mailPauses, 6)
  assert.equal((await page.evaluate(() => window.aerio.mail.accounts.list()))[0].status, 'paused')
  console.log('✓ native reconnect after restart validates OAuth state/PKCE, restores write access, sends queued work once, and never replays uncertain writes')

  await page.context().setOffline(true)
  await page.evaluate(async ({ taskId, listId }) => {
    window.dispatchEvent(new Event('offline')); await window.aerio.mail.accounts.list()
    await window.aerio.tasks.update(taskId, { title: 'Network restored task' })
    await window.aerio.tasks.renameList(listId, 'Network restored list')
  }, { taskId, listId })
  await application.evaluate(() => { globalThis.taskConsentAudit.scope = 'https://www.googleapis.com/auth/tasks.readonly' })
  await page.evaluate(async (id) => { await window.aerio.mail.accounts.reconnect(id) }, accountId)
  await online()
  await page.evaluate(async (id) => { await window.aerio.tasks.sync(id) }, accountId)
  await page.context().setOffline(true)
  await page.evaluate(async () => { window.dispatchEvent(new Event('offline')); await window.aerio.mail.accounts.list() })
  await application.evaluate(() => { globalThis.taskConsentAudit.scope = 'https://www.googleapis.com/auth/tasks' })
  await page.evaluate(async (id) => { await window.aerio.mail.accounts.reconnect(id) }, accountId)
  // Only the actual online event triggers dispatch here. No explicit Tasks
  // refresh masks cached read-only flags left by the preceding consent grant.
  await online()
  snapshot = await waitForSnapshot((snapshot) => snapshot.operations.some((op) => op.patch.title === 'Network restored task' && op.status === 'succeeded') && snapshot.listOperations?.some((op) => op.title === 'Network restored list' && op.status === 'succeeded'))
  assert.equal(snapshot.operations.find((op) => op.id === uncertainTask).status, 'review')
  assert.equal(snapshot.listOperations.find((op) => op.id === uncertainList).status, 'review')
  const recovered = await application.evaluate(() => globalThis.taskConsentAudit)
  assert.equal(recovered.taskCreates, 1); assert.equal(recovered.listCreates, 1)
  assert.equal(recovered.writes.filter((write) => write.kind === 'task' && write.method === 'PATCH').length, 2)
  assert.equal(recovered.writes.filter((write) => write.kind === 'list' && write.method === 'PATCH').length, 2)
  assert.equal(recovered.oauth.browserOpens, 6); assert.equal(recovered.oauth.pkceMatches, 5)
  console.log('✓ an online event refreshes stale read-only permissions before sending queued task/list work after renewed consent')
} catch (error) {
  if (page) console.error(await page.locator('body').innerText().catch(() => 'Renderer unavailable'))
  throw error
} finally {
  if (application) await application.close().catch(() => {})
  const location = relative(tmpdir(), profile)
  assert.ok(location && !location.startsWith('..') && !isAbsolute(location) && location.startsWith('aerio-tasks-consent-audit-'))
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
