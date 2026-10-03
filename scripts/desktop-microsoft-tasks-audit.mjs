import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { _electron as electron } from 'playwright-core'
import electronPath from 'electron'
import { MailDatabase } from '../electron/mail/database.ts'
import { desktopAuditEnvironment } from './electron-audit-environment.mjs'

const root = resolve(import.meta.dirname, '..'), profile = mkdtempSync(join(tmpdir(), 'aerio-ms-tasks-audit-'))
const email = 'ms-audit@example.test', profileId = 'ms-fixture-profile', accountId = createHash('sha256').update(`microsoft:${profileId}`).digest('hex').slice(0, 24)
const listId = `${accountId}:microsoft-task-list:list`
let application, page
async function launch(previous) {
  application = await electron.launch({ executablePath: electronPath, args: [root, `--user-data-dir=${profile}`], cwd: root, env: desktopAuditEnvironment() })
  page = await application.firstWindow(); page.setDefaultTimeout(15_000); page.on('dialog', (dialog) => dialog.accept())
  await page.context().setOffline(true); await page.waitForSelector('.app')
  await page.evaluate(async () => { window.dispatchEvent(new Event('offline')); await window.aerio.mail.accounts.list() })
  await application.evaluate((_electron, { root, previous, email, profileId }) => {
    const require = process.getBuiltinModule('module').createRequire(`${root}/package.json`)
    require(`${root}/scripts/fixtures/microsoft-task-fixture.cjs`).install(previous, email, profileId)
  }, { root, previous, email, profileId })
}
async function network(online) {
  await page.context().setOffline(!online)
  await page.evaluate(async (online) => { window.dispatchEvent(new Event(online ? 'online' : 'offline')); await window.aerio.mail.accounts.list() }, online)
}
async function snapshot() { return page.evaluate(() => window.aerio.tasks.snapshot()) }
async function wait(predicate) {
  const deadline = Date.now() + 15_000
  do { const value = await snapshot(); if (predicate(value)) return value; await new Promise((resolve) => setTimeout(resolve, 50)) } while (Date.now() < deadline)
  throw new Error('Microsoft desktop state did not settle')
}
const settled = () => wait((value) => ![...value.operations, ...value.listOperations].some((op) => ['queued', 'running'].includes(op.status)))
const fixture = () => application.evaluate(() => globalThis.microsoftTaskAudit)
const reconnect = () => page.evaluate((id) => window.aerio.mail.accounts.reconnect(id), accountId)
async function scope(value) { await application.evaluate((_electron, scope) => { globalThis.microsoftTaskAudit.scope = scope }, value) }
const full = 'User.Read Mail.ReadWrite Tasks.ReadWrite', readonly = 'User.Read Mail.ReadWrite Tasks.Read', absent = 'User.Read Mail.ReadWrite'
try {
  const preferences = new DatabaseSync(join(profile, 'aerio-state.sqlite'))
  preferences.exec('CREATE TABLE app_preferences(id INTEGER PRIMARY KEY, schema_version INTEGER NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL)')
  preferences.prepare('INSERT INTO app_preferences VALUES(1,1,?,?)').run(JSON.stringify({ schemaVersion: 1, settings: { theme: 'light', density: 'comfortable', closeToTray: false, launchAtLogin: false, notifications: false, startModule: 'tasks' } }), new Date().toISOString()); preferences.close()
  const mail = new MailDatabase(join(profile, 'aerio.sqlite'), join(profile, 'mail'))
  mail.upsertAccount({ id: accountId, provider: 'microsoft', email, displayName: 'MS audit', color: '#6558e8', status: 'paused', archived: false, signature: '', notifications: false, syncEnabled: true }); mail.close()
  await launch()
  const encrypted = await application.evaluate(({ safeStorage }, { accountId, absent }) => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Native secure storage is required')
    return safeStorage.encryptString(JSON.stringify({ googleTokens: {}, googleCalendarWrite: {}, microsoftConfig: { clientId: '11111111-1111-4111-8111-111111111111' }, microsoftTokens: { [accountId]: { accessToken: 'ms-fixture-token', refreshToken: 'ms-fixture-refresh', expiresAt: Date.now() + 3_600_000, scope: absent } }, imapAccounts: {} })).toString('base64')
  }, { accountId, absent })
  writeFileSync(join(profile, 'oauth-vault.dat'), encrypted)
  await network(true)
  await page.getByRole('button', { name: 'Connect Microsoft To Do', exact: true }).click()
  await page.getByText('Microsoft To Do connected', { exact: true }).waitFor()
  let value = await snapshot(), taskId = value.tasks.find((task) => task.remote.remoteId === 'original').id
  assert.equal(value.accounts[0].provider, 'microsoft'); assert.equal(value.accounts[0].canWrite, true)
  assert.equal(value.tasks.find((task) => task.id === taskId).fields.native.dueTimeZone, 'GMT Standard Time')
  await page.getByRole('button', { name: /MS audit list/ }).click()
  await page.getByRole('button', { name: 'Open task MS audit task' }).click()
  let editor = page.getByRole('dialog', { name: 'Microsoft task', exact: true })
  await editor.getByLabel('Notes', { exact: true }).fill('Edited <notes>')
  await editor.getByLabel('Priority in Microsoft', { exact: true }).selectOption('low')
  await editor.getByLabel('Progress', { exact: true }).selectOption('deferred')
  await editor.getByLabel('Repeat in Microsoft', { exact: true }).selectOption('weekly')
  await editor.getByLabel('Repeat interval', { exact: true }).fill('3')
  await editor.getByRole('button', { name: 'Save task', exact: true }).click(); await editor.waitFor({ state: 'hidden' })
  value = await settled(); const first = value.operations.at(-1)
  assert.equal(first.status, 'succeeded')
  let state = await fixture(), nativeOriginal = state.tasks.list.original
  assert.equal(nativeOriginal.importance, 'low'); assert.equal(nativeOriginal.status, 'deferred')
  assert.equal(nativeOriginal.recurrence.pattern.type, 'weekly'); assert.equal(nativeOriginal.recurrence.pattern.interval, 3)
  assert.equal(nativeOriginal.body.content, 'Edited &lt;notes&gt;')
  assert.equal(nativeOriginal.dueDateTime.dateTime, '2026-10-05T09:00:00.0000000')
  await page.getByRole('button', { name: 'Undo update MS audit task', exact: true }).click()
  await wait((value) => value.operations.some((op) => op.undoOf === first.id && op.status === 'succeeded'))
  state = await fixture(); nativeOriginal = state.tasks.list.original
  assert.equal(nativeOriginal.body.content, '<p><b>Original</b> &amp; notes</p>')
  assert.equal(nativeOriginal.status, 'inProgress'); assert.equal(nativeOriginal.importance, 'high'); assert.equal(nativeOriginal.recurrence.pattern.type, 'daily')
  assert.equal(state.taskCreates, 0)
  console.log('✓ native Microsoft OAuth callback/PKCE and renderer task writes preserve rich notes, progress, recurrence and due zones; undo restores original fields')

  await page.getByRole('button', { name: 'Open task MS audit step' }).click()
  editor = page.getByRole('dialog', { name: 'Microsoft checklist item', exact: true })
  assert.equal(await editor.getByLabel('Notes', { exact: true }).count(), 0)
  assert.equal(await editor.getByRole('button', { name: 'Move task' }).count(), 0)
  await editor.getByLabel('Task', { exact: true }).fill('Edited checklist')
  await editor.getByLabel('Progress', { exact: true }).selectOption('completed')
  await editor.getByRole('button', { name: 'Save task', exact: true }).click(); await editor.waitFor({ state: 'hidden' }); await settled()
  state = await fixture(); assert.equal(state.children.original.step.displayName, 'Edited checklist'); assert.equal(state.children.original.step.isChecked, true)
  assert.equal(state.writes.filter((write) => write.kind === 'child').at(-1).ifMatch, null)
  await application.evaluate(() => { globalThis.microsoftTaskAudit.children.original.step.displayName = 'Changed independently' })
  await page.evaluate((id) => window.aerio.tasks.sync(id), accountId)
  value = await snapshot(); assert.equal(value.tasks.find((task) => task.remote.remoteId === 'step').fields.title, 'Changed independently')
  console.log('✓ checklist edits use native parent identities and snapshot comparisons; refresh sees checklist changes without a parent delta')

  await page.getByRole('button', { name: 'New task', exact: true }).click()
  editor = page.getByRole('dialog', { name: 'New Microsoft task', exact: true })
  await editor.getByLabel('Task', { exact: true }).fill('Native form task')
  await editor.getByLabel('Notes', { exact: true }).fill('New & notes')
  await editor.getByLabel('Due date and time', { exact: true }).fill('2026-10-10T10:30')
  await editor.getByLabel('Time zone', { exact: true }).fill('Eastern Standard Time')
  await editor.getByLabel('Priority in Microsoft', { exact: true }).selectOption('high')
  await editor.getByLabel('Repeat in Microsoft', { exact: true }).selectOption('relativeYearly')
  await editor.getByLabel('Month', { exact: true }).fill('10')
  await editor.getByLabel('Week of month', { exact: true }).selectOption('last')
  await editor.getByLabel('Repeat ends', { exact: true }).selectOption('numbered')
  await editor.getByLabel('Number of occurrences', { exact: true }).fill('3')
  await editor.getByRole('button', { name: 'Save task', exact: true }).click(); await editor.waitFor({ state: 'hidden' })
  value = await settled(); const nativeCreated = value.tasks.find((task) => task.fields.title === 'Native form task')
  assert.equal(nativeCreated.fields.native.recurrence.pattern.type, 'relativeYearly')
  assert.equal(nativeCreated.fields.native.recurrence.range.numberOfOccurrences, 3)
  assert.equal(nativeCreated.fields.native.dueTimeZone, 'Eastern Standard Time')
  await page.getByRole('button', { name: 'Open task Native form task', exact: true }).click()
  editor = page.getByRole('dialog', { name: 'Microsoft task', exact: true })
  await editor.getByRole('button', { name: 'Delete task', exact: true }).click(); await editor.waitFor({ state: 'hidden' }); await settled()
  assert.ok(!(await snapshot()).tasks.some((task) => task.id === nativeCreated.id))
  await page.getByRole('button', { name: 'Undo delete Native form task', exact: true }).click()
  value = await settled(); const restoredNative = value.tasks.find((task) => task.id === nativeCreated.id)
  assert.ok(restoredNative); assert.notEqual(restoredNative.remote.id, nativeCreated.remote.id)
  assert.deepEqual(restoredNative.fields.native.recurrence, nativeCreated.fields.native.recurrence)
  assert.equal(restoredNative.fields.native.body.content, 'New &amp; notes')
  state = await fixture()
  console.log('✓ native creation form stores yearly weekday recurrence and due zones; deletion undo restores native fields under the original local identity')

  const beforeConflict = state.writes.length
  await application.evaluate(() => {
    const state = globalThis.microsoftTaskAudit
    Object.assign(state.tasks.list.original, { title: 'Changed elsewhere', importance: 'normal', '@odata.etag': 'external-version' })
    state.changes.push({ list: 'list', id: 'original', revision: ++state.revision })
  })
  await page.evaluate((id) => window.aerio.tasks.update(id, { native: { priority: 'low' } }), taskId)
  await wait((value) => value.operations.some((op) => op.status === 'conflict'))
  assert.equal((await fixture()).writes.length, beforeConflict)
  await page.getByRole('button', { name: 'Review change', exact: true }).click()
  let review = page.getByRole('dialog', { name: 'Review task change', exact: true })
  await review.getByRole('button', { name: 'Refresh Microsoft tasks', exact: true }).click()
  await review.getByText(/Changed elsewhere.*Priority: normal/).waitFor()
  await review.getByRole('button', { name: 'Retry my change', exact: true }).click(); await review.waitFor({ state: 'hidden' }); await settled()
  assert.equal((await fixture()).tasks.list.original.importance, 'low')
  console.log('✓ original native ETags block concurrent edits before PATCH; native review retries only the refreshed revision')

  await application.evaluate(() => { globalThis.microsoftTaskAudit.loseTaskUpdate = true })
  await page.evaluate((id) => window.aerio.tasks.update(id, { notes: null, due: null, completed: true }), taskId)
  await wait((value) => value.operations.some((op) => op.status === 'review'))
  const beforeConfirm = (await fixture()).writes.length
  await page.getByRole('button', { name: 'Review change', exact: true }).click(); review = page.getByRole('dialog', { name: 'Review task change', exact: true })
  await review.getByRole('button', { name: 'Refresh Microsoft tasks', exact: true }).click()
  await review.getByRole('button', { name: 'Confirm applied', exact: true }).click(); await review.waitFor({ state: 'hidden' })
  assert.equal((await fixture()).writes.length, beforeConfirm)
  assert.equal((await fixture()).taskCreates, 2)
  console.log('✓ native lost-response clears/completion reconcile without resending or generating local recurring duplicates')

  await application.evaluate(() => { globalThis.microsoftTaskAudit.loseTaskCreate = true; globalThis.microsoftTaskAudit.loseChildCreate = true })
  await page.evaluate(({ accountId, listId }) => window.aerio.tasks.create(accountId, listId, { title: 'Accepted native creation', completed: false, due: '2026-10-08T10:00:00+02:00', native: { priority: 'high', dueTimeZone: 'Eastern Standard Time' } }), { accountId, listId })
  value = await wait((value) => value.operations.some((op) => op.kind === 'create' && op.status === 'review')); const created = value.operations.at(-1), createdLocal = created.entityId
  await page.getByRole('button', { name: 'Review change', exact: true }).click(); review = page.getByRole('dialog', { name: 'Review task change', exact: true })
  await review.getByRole('button', { name: 'Refresh Microsoft tasks', exact: true }).click()
  value = await snapshot(); const accepted = value.remoteTasks.find((task) => task.title === 'Accepted native creation')
  await review.getByLabel('Task created in Microsoft', { exact: true }).selectOption(accepted.id)
  await review.getByRole('button', { name: 'Confirm applied', exact: true }).click(); await review.waitFor({ state: 'hidden' })
  assert.equal((await snapshot()).tasks.find((task) => task.id === createdLocal).remote.id, accepted.id)
  await page.evaluate(({ accountId, listId, taskId }) => window.aerio.tasks.create(accountId, listId, { title: 'Accepted checklist creation', completed: false }, taskId), { accountId, listId, taskId })
  await wait((value) => value.operations.some((op) => op.status === 'review'))
  await page.getByRole('button', { name: 'Review change', exact: true }).click(); review = page.getByRole('dialog', { name: 'Review task change', exact: true })
  await review.getByRole('button', { name: 'Refresh Microsoft tasks', exact: true }).click()
  value = await snapshot(); const acceptedChild = value.remoteTasks.find((task) => task.title === 'Accepted checklist creation')
  await review.getByLabel('Task created in Microsoft', { exact: true }).selectOption(acceptedChild.id)
  await review.getByRole('button', { name: 'Confirm applied', exact: true }).click(); await review.waitFor({ state: 'hidden' })
  state = await fixture(); assert.equal(state.taskCreates, 3); assert.equal(state.childCreates, 1)
  console.log('✓ accepted task/checklist creates reconcile to native identities, normalized due times and parents without replay')

  await page.getByRole('button', { name: /^Manage Microsoft lists for/ }).click()
  let manager = page.getByRole('dialog', { name: 'Microsoft task lists', exact: true })
  assert.equal(await manager.getByRole('button', { name: 'Rename Microsoft list Managed list' }).isDisabled(), true)
  await application.evaluate(() => { globalThis.microsoftTaskAudit.loseListCreate = true })
  await manager.getByLabel('List name', { exact: true }).fill('Native list')
  await manager.getByRole('button', { name: 'Create Microsoft list', exact: true }).click()
  await wait((value) => value.listOperations.some((op) => op.kind === 'create' && op.status === 'review'))
  await manager.getByRole('button', { name: 'Review list change', exact: true }).click()
  await manager.getByRole('button', { name: 'Refresh Microsoft lists', exact: true }).click()
  const nativeList = (await snapshot()).lists.find((list) => list.title === 'Native list')
  await manager.getByLabel('List created in Microsoft', { exact: true }).selectOption(nativeList.id)
  await manager.getByRole('button', { name: 'Confirm list change applied', exact: true }).click()
  await manager.getByLabel('List name', { exact: true }).waitFor()
  await manager.getByRole('button', { name: 'Rename Microsoft list Native list', exact: true }).click()
  await manager.getByLabel('New list name', { exact: true }).fill('Renamed native list')
  const beforeListConflict = (await fixture()).writes.length
  await application.evaluate((_electron, id) => { globalThis.microsoftTaskAudit.lists[id].displayName = 'Changed list elsewhere' }, nativeList.remoteId)
  await manager.getByRole('button', { name: 'Save list name', exact: true }).click()
  await wait((value) => value.listOperations.some((op) => op.kind === 'update' && op.status === 'conflict'))
  assert.equal((await fixture()).writes.length, beforeListConflict)
  await manager.getByRole('button', { name: 'Review list change', exact: true }).click()
  await manager.getByRole('button', { name: 'Refresh Microsoft lists', exact: true }).click()
  await manager.getByRole('button', { name: 'Retry list change', exact: true }).click()
  await manager.getByLabel('List name', { exact: true }).waitFor(); await settled()
  await application.evaluate(() => { globalThis.microsoftTaskAudit.loseListDelete = true })
  await manager.getByRole('button', { name: 'Delete Microsoft list Renamed native list', exact: true }).click()
  await wait((value) => value.listOperations.some((op) => op.kind === 'delete' && op.status === 'review'))
  await manager.getByRole('button', { name: 'Review list change', exact: true }).click()
  await manager.getByRole('button', { name: 'Refresh Microsoft lists', exact: true }).click()
  const beforeDeleteConfirm = (await fixture()).writes.length
  await manager.getByRole('button', { name: 'Confirm list change applied', exact: true }).click()
  await manager.getByLabel('List name', { exact: true }).waitFor()
  assert.equal((await fixture()).writes.length, beforeDeleteConfirm)
  await manager.getByRole('button', { name: 'Done', exact: true }).click()
  assert.ok((await fixture()).writes.filter((write) => write.kind === 'list').every((write) => write.ifMatch === null))
  console.log('✓ native list CRUD protects managed lists, reviews original snapshot conflicts, and reconciles accepted/lost create/delete responses without replay')

  await application.evaluate(() => { globalThis.microsoftTaskAudit.loseTaskCreate = true; globalThis.microsoftTaskAudit.loseListCreate = true })
  await page.evaluate(async ({ accountId, listId }) => { await window.aerio.tasks.create(accountId, listId, { title: 'Held uncertain task', completed: false }); await window.aerio.tasks.createList(accountId, 'Held uncertain list') }, { accountId, listId })
  value = await wait((value) => value.operations.some((op) => op.status === 'review') && value.listOperations.some((op) => op.status === 'review'))
  const heldTask = value.operations.at(-1).id, heldList = value.listOperations.at(-1).id
  await network(false)
  await page.evaluate(async ({ taskId, listId }) => { await window.aerio.tasks.update(taskId, { native: { priority: 'high' } }); await window.aerio.tasks.renameList(listId, 'Pending native list') }, { taskId, listId })
  const beforeConsent = (await fixture()).writes.length
  await scope(readonly); await reconnect(); await network(true)
  value = await page.evaluate((id) => window.aerio.tasks.sync(id), accountId)
  assert.equal(value.accounts[0].canRead, true); assert.equal(value.accounts[0].canWrite, false)
  assert.equal((await fixture()).writes.length, beforeConsent)
  assert.ok(value.operations.filter((op) => op.status === 'queued').every((op) => op.attempts === 0))
  await application.evaluate(() => { globalThis.microsoftTaskAudit.denied = true })
  await page.getByRole('button', { name: 'Connect Microsoft To Do', exact: true }).click(); await page.getByText(/access_denied/).waitFor()
  assert.equal((await snapshot()).accounts[0].canRead, true)
  await application.evaluate(() => { globalThis.microsoftTaskAudit.denied = false }); await scope(absent); await reconnect()
  assert.equal((await snapshot()).accounts[0].canRead, false)
  await network(false); state = await fixture(); await application.close(); application = undefined
  // No Tasks grant and paused mail prevent startup network access before the
  // controlled fixture is reinstalled in the new native process.
  await launch(state)
  value = await snapshot(); assert.equal(value.operations.find((op) => op.id === heldTask).status, 'review')
  assert.equal(value.listOperations.find((op) => op.id === heldList).status, 'review')
  assert.equal(value.tasks.find((task) => task.id === taskId).fields.native.priority, 'high')
  await scope(full); await reconnect(); await network(true)
  value = await wait((value) => value.operations.some((op) => op.patch.native?.priority === 'high' && op.status === 'succeeded') && value.listOperations.some((op) => op.title === 'Pending native list' && op.status === 'succeeded'))
  assert.equal(value.operations.find((op) => op.id === heldTask).status, 'review'); assert.equal(value.listOperations.find((op) => op.id === heldList).status, 'review')
  state = await fixture(); assert.equal(state.taskCreates, 4); assert.equal(state.listCreates, 2)
  assert.equal(state.oauth.browserOpens, 5); assert.equal(state.oauth.exchanges, 4); assert.equal(state.oauth.pkce, 4)
  assert.equal((await page.evaluate(() => window.aerio.mail.accounts.list()))[0].status, 'paused')
  console.log('✓ native read-only/denied/absent consent and full quit/relaunch preserve intent; an online event refreshes restored permissions and never replays uncertain creates')

  await network(false)
  await page.evaluate((id) => window.aerio.tasks.update(id, { native: { priority: 'low', recurrence: null } }), taskId)
  const backupPath = join(profile, 'ms-task-backup.json')
  await application.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, backupPath)
  await page.getByRole('button', { name: 'Back up connected tasks', exact: true }).click(); await page.getByText('Connected tasks backup saved', { exact: true }).waitFor()
  const backup = JSON.parse(readFileSync(backupPath, 'utf8'))
  assert.equal(backup.accounts[0].provider, 'microsoft'); assert.equal(backup.entities.find((task) => task.id === taskId).fields.native.priority, 'high')
  assert.ok(!JSON.stringify(backup).includes('ms-fixture-token'))
  await page.getByRole('button', { name: 'Restore connected tasks', exact: true }).click(); await page.getByText('Connected tasks restored. Pending changes require review.', { exact: true }).waitFor()
  value = await snapshot(); assert.ok(value.operations.filter((op) => !['succeeded', 'cancelled'].includes(op.status)).every((op) => op.status === 'review' && op.error === 'restored-write'))
  assert.equal(value.tasks.find((task) => task.id === taskId).fields.native.priority, 'low')
  const beforeRestoreGrant = (await fixture()).writes.length
  await scope(absent); await reconnect(); state = await fixture(); await application.close(); application = undefined
  await launch(state); await scope(full); await reconnect(); await network(true)
  await page.evaluate((id) => window.aerio.tasks.sync(id), accountId)
  value = await snapshot(); assert.equal(value.tasks.find((task) => task.id === taskId).fields.native.priority, 'low')
  assert.equal((await fixture()).writes.length, beforeRestoreGrant)
  assert.ok(value.operations.filter((op) => !['succeeded', 'cancelled'].includes(op.status)).every((op) => op.status === 'review' && op.error === 'restored-write'))
  console.log('✓ native backup file dialogs retain Microsoft fields, revisions and pending intent; restored writes remain held after reconnect and restart')

  await network(false)
  const beforeArchive = (await fixture()).writes.length
  await page.evaluate((id) => window.aerio.mail.accounts.disconnect(id, 'archive'), accountId)
  assert.equal((await snapshot()).accounts[0].canWrite, false)
  await page.evaluate((id) => window.aerio.mail.accounts.disconnect(id, 'delete'), accountId)
  value = await snapshot(); for (const key of ['accounts', 'lists', 'tasks', 'remoteTasks', 'operations', 'listOperations']) assert.deepEqual(value[key], [])
  assert.equal((await fixture()).writes.length, beforeArchive)
  console.log('✓ native account archival holds cached intent; deletion purges Microsoft caches/history without provider writes')
} catch (error) {
  if (page) console.error(await page.locator('body').innerText().catch(() => 'Renderer unavailable'))
  throw error
} finally {
  if (application) await application.close().catch(() => {})
  const location = relative(tmpdir(), profile)
  assert.ok(location && !location.startsWith('..') && !isAbsolute(location) && location.startsWith('aerio-ms-tasks-audit-'))
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
