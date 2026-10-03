import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { _electron as electron } from 'playwright-core'
import electronPath from 'electron'
import { MailDatabase } from '../electron/mail/database.ts'
import { desktopAuditEnvironment } from './electron-audit-environment.mjs'

const root = resolve(import.meta.dirname, '..')
const profile = mkdtempSync(join(tmpdir(), 'aerio-tasks-write-audit-'))
const accountId = 'tasks-write-audit'
let application
let page
async function waitForSnapshot(predicate) {
  const deadline = Date.now() + 15_000
  let snapshot
  do {
    snapshot = await page.evaluate(() => window.aerio.tasks.snapshot())
    if (predicate(snapshot)) return snapshot
    await new Promise((resolve) => setTimeout(resolve, 50))
  } while (Date.now() < deadline)
  throw new Error(`Task state did not settle: ${JSON.stringify(snapshot.operations)}`)
}
try {
  const preferences = new DatabaseSync(join(profile, 'aerio-state.sqlite'))
  preferences.exec('CREATE TABLE app_preferences(id INTEGER PRIMARY KEY, schema_version INTEGER NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL)')
  preferences.prepare('INSERT INTO app_preferences VALUES(1,1,?,?)').run(JSON.stringify({ schemaVersion: 1, settings: { theme: 'light', density: 'comfortable', closeToTray: false, launchAtLogin: false, notifications: false, startModule: 'tasks' } }), new Date().toISOString())
  preferences.close()
  const mail = new MailDatabase(join(profile, 'aerio.sqlite'), join(profile, 'mail'))
  // Mail stays paused throughout: only the main-process Tasks adapter gets a
  // controlled fetch implementation. No real provider credentials are used.
  mail.upsertAccount({ id: accountId, provider: 'gmail', email: 'fixture@example.test', displayName: 'Write audit', color: '#6558e8', status: 'paused', archived: false, signature: '', notifications: false, syncEnabled: true })
  mail.close()
  application = await electron.launch({ executablePath: electronPath, args: [root, `--user-data-dir=${profile}`], cwd: root, env: desktopAuditEnvironment() })
  page = await application.firstWindow()
  page.on('dialog', (dialog) => dialog.accept())
  page.setDefaultTimeout(15_000)
  await page.context().setOffline(true)
  await page.waitForSelector('.app')
  await page.evaluate(async () => {
    window.dispatchEvent(new Event('offline'))
    await window.aerio.mail.accounts.list()
  })
  const encrypted = await application.evaluate(({ safeStorage, net }, accountId) => {
    const fixture = { googleConfig: { clientId: 'fixture', clientSecret: 'fixture' }, googleTokens: { [accountId]: { access_token: 'synthetic-task-token', expiry_date: Date.now() + 3_600_000, scope: 'https://www.googleapis.com/auth/tasks' } }, googleCalendarWrite: {}, microsoftTokens: {}, imapAccounts: {} }
    net.isOnline = () => true
    globalThis.taskAudit = { lists: { list: { id: 'list', title: 'Write audit list', etag: 'list-v1' } }, tasks: { original: { id: 'original', title: 'Original task', etag: 'v1', status: 'needsAction', updated: new Date().toISOString() } }, writes: [], revision: 1, creates: 0, listCreates: 0, loseListCreate: false, loseListDelete: false, loseCreate: false, loseUpdate: false }
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(String(input))
      if (url.origin !== 'https://tasks.googleapis.com') throw new Error('Unexpected Tasks audit network destination')
      const state = globalThis.taskAudit
      const method = init.method ?? 'GET'
      const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
      if (url.pathname === '/tasks/v1/users/@me/lists' && method === 'GET') return json({ items: Object.values(state.lists) })
      if (url.pathname === '/tasks/v1/users/@me/lists' && method === 'POST') {
        const list = { ...JSON.parse(init.body), id: `created-list-${++state.listCreates}`, etag: `list-v${++state.revision}` }
        state.lists[list.id] = list; state.writes.push({ method, id: list.id })
        if (state.loseListCreate) { state.loseListCreate = false; throw new Error('Synthetic lost list create response') }
        return json(list)
      }
      const listMatch = url.pathname.match(/^\/tasks\/v1\/users\/@me\/lists\/([^/]+)$/)
      if (listMatch) {
        const list = state.lists[decodeURIComponent(listMatch[1])]
        if (!list) return json({}, 404)
        if (method === 'GET') return json(list)
        if (new Headers(init.headers).get('If-Match') !== list.etag) return json({}, 412)
        state.writes.push({ method, id: list.id })
        if (method === 'PATCH') { Object.assign(list, JSON.parse(init.body), { etag: `list-v${++state.revision}` }); return json(list) }
        if (method === 'DELETE') {
          delete state.lists[list.id]
          for (const [id, task] of Object.entries(state.tasks)) if ((task.listId ?? 'list') === list.id) delete state.tasks[id]
          if (state.loseListDelete) { state.loseListDelete = false; throw new Error('Synthetic lost list delete response') }
          return new Response(null, { status: 204 })
        }
      }
      const tasksMatch = url.pathname.match(/^\/tasks\/v1\/lists\/([^/]+)\/tasks$/)
      if (tasksMatch && method === 'GET') return json({ items: Object.values(state.tasks).filter((task) => (task.listId ?? 'list') === decodeURIComponent(tasksMatch[1])) })
      if (tasksMatch && method === 'POST') {
        const task = { ...JSON.parse(init.body), listId: decodeURIComponent(tasksMatch[1]), id: `created-${++state.creates}`, etag: `v${++state.revision}`, updated: new Date().toISOString(), parent: url.searchParams.get('parent') ?? undefined }
        state.tasks[task.id] = task
        state.writes.push({ method, id: task.id })
        if (state.loseCreate) { state.loseCreate = false; throw new Error('Synthetic lost response after acceptance') }
        return json(task)
      }
      const match = url.pathname.match(/^\/tasks\/v1\/lists\/([^/]+)\/tasks\/([^/]+)$/)
      if (!match) throw new Error(`Unexpected Tasks audit endpoint ${method} ${url.pathname}`)
      const task = state.tasks[decodeURIComponent(match[2])]
      if (!task || task.deleted || (task.listId ?? 'list') !== decodeURIComponent(match[1])) return json({ error: { message: 'Missing task' } }, 404)
      if (method === 'GET') return json(task)
      if (new Headers(init.headers).get('If-Match') !== task.etag) return json({ error: { message: 'Revision mismatch' } }, 412)
      state.writes.push({ method, id: task.id })
      if (method === 'PATCH') {
        Object.assign(task, JSON.parse(init.body), { etag: `v${++state.revision}`, updated: new Date().toISOString() })
        if (state.loseUpdate) { state.loseUpdate = false; throw new Error('Synthetic lost update response after acceptance') }
        return json(task)
      }
      if (method === 'DELETE') { Object.assign(task, { deleted: true, updated: new Date().toISOString() }); return new Response(null, { status: 204 }) }
      throw new Error(`Unexpected Tasks audit method ${method}`)
    }
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Native secure storage is required')
    return safeStorage.encryptString(JSON.stringify(fixture)).toString('base64')
  }, accountId)
  writeFileSync(join(profile, 'oauth-vault.dat'), encrypted)
  await page.evaluate(async (accountId) => {
    await window.aerio.mail.sync.pause(accountId)
  }, accountId)
  await page.context().setOffline(false)
  await page.evaluate(async (accountId) => {
    window.dispatchEvent(new Event('online'))
    await window.aerio.mail.accounts.list()
    await window.aerio.tasks.sync(accountId)
  }, accountId)
  await page.getByRole('button', { name: /Write audit list/ }).click()
  await page.getByRole('button', { name: 'Open task Original task' }).click()
  let editor = page.getByRole('dialog', { name: 'Google task' })
  await editor.getByLabel('Task', { exact: true }).fill('Edited in Aerio')
  await editor.getByRole('button', { name: 'Save task', exact: true }).click()
  await waitForSnapshot((snapshot) => snapshot.operations.some((op) => op.kind === 'update' && op.status === 'succeeded'))
  let snapshot = await page.evaluate(() => window.aerio.tasks.snapshot())
  const originalId = snapshot.tasks[0].id
  const update = snapshot.operations.find((op) => op.kind === 'update')
  await page.getByRole('button', { name: 'Undo update Original task' }).click()
  await waitForSnapshot((snapshot) => snapshot.operations.some((op) => op.undoOf === update.id && op.status === 'succeeded'))
  assert.equal(await application.evaluate(() => globalThis.taskAudit.tasks.original.title), 'Original task')
  console.log('✓ real task editor writes through the production adapter; undo uses a compensating provider write')

  await application.evaluate(() => { Object.assign(globalThis.taskAudit.tasks.original, { title: 'Changed elsewhere', etag: 'external-v2', updated: new Date().toISOString() }) })
  const writesBeforeConflict = await application.evaluate(() => globalThis.taskAudit.writes.length)
  await page.evaluate(async (id) => { await window.aerio.tasks.update(id, { title: 'My concurrent edit' }) }, originalId)
  await waitForSnapshot((snapshot) => snapshot.operations.some((op) => op.status === 'conflict'))
  assert.equal(await application.evaluate(() => globalThis.taskAudit.writes.length), writesBeforeConflict)
  await page.getByRole('button', { name: 'Review change', exact: true }).click()
  const review = page.getByRole('dialog', { name: 'Review task change' })
  await review.getByRole('button', { name: 'Refresh Google tasks' }).click()
  await review.getByText('Changed elsewhere · Open', { exact: true }).waitFor()
  await review.getByRole('button', { name: 'Retry my change' }).click()
  await review.waitFor({ state: 'hidden' })
  assert.equal(await application.evaluate(() => globalThis.taskAudit.tasks.original.title), 'My concurrent edit')
  console.log('✓ concurrent provider edits block the stale write; native review refreshes and retries the revision the user reviewed')

  await application.evaluate(() => { globalThis.taskAudit.loseCreate = true })
  snapshot = await page.evaluate(async (accountId) => window.aerio.tasks.create(accountId, `${accountId}:google-task-list:list`, { title: 'Accepted despite lost response', completed: false }), accountId)
  const pendingId = snapshot.tasks.find((task) => task.fields.title === 'Accepted despite lost response').id
  await waitForSnapshot((snapshot) => snapshot.operations.some((op) => op.kind === 'create' && op.status === 'review'))
  await page.getByRole('button', { name: 'Review change', exact: true }).click()
  await review.getByRole('button', { name: 'Refresh Google tasks' }).click()
  await review.getByLabel('Task created in Google').selectOption(`${accountId}:google-task:list:created-1`)
  await review.getByRole('button', { name: 'Confirm applied' }).click()
  await review.waitFor({ state: 'hidden' })
  snapshot = await page.evaluate(() => window.aerio.tasks.snapshot())
  assert.equal(snapshot.tasks.filter((task) => task.fields.title === 'Accepted despite lost response').length, 1)
  assert.equal(snapshot.tasks.find((task) => task.fields.title === 'Accepted despite lost response').id, pendingId)
  assert.equal(await application.evaluate(() => globalThis.taskAudit.creates), 1)
  assert.equal(snapshot.operations.find((op) => op.entityId === pendingId).status, 'succeeded')
  assert.equal((await page.evaluate(() => window.aerio.mail.accounts.list()))[0].status, 'paused')
  console.log('✓ accepted creates with lost responses require review, reconcile to the original local identity, and never replay')

  await page.evaluate(async (id) => { await window.aerio.tasks.update(id, { notes: 'Remove these notes', due: '2026-10-04', completed: true }) }, originalId)
  await waitForSnapshot((snapshot) => snapshot.operations.at(-1)?.status === 'succeeded')
  await application.evaluate(() => { globalThis.taskAudit.loseUpdate = true })
  await page.evaluate(async (id) => { await window.aerio.tasks.update(id, { notes: null, due: null, completed: false }) }, originalId)
  await waitForSnapshot((snapshot) => snapshot.operations.at(-1)?.status === 'review')
  const writesBeforeConfirmation = await application.evaluate(() => globalThis.taskAudit.writes.length)
  await page.getByRole('button', { name: 'Review change', exact: true }).click()
  await review.getByRole('button', { name: 'Refresh Google tasks' }).click()
  await review.getByRole('button', { name: 'Confirm applied' }).click()
  await review.waitFor({ state: 'hidden' })
  snapshot = await page.evaluate(() => window.aerio.tasks.snapshot())
  assert.equal(snapshot.operations.at(-1).status, 'succeeded')
  const cleared = snapshot.tasks.find((task) => task.id === originalId)
  assert.equal(cleared.fields.notes ?? '', '')
  assert.equal(cleared.fields.due, undefined)
  assert.equal(cleared.fields.completed, false)
  assert.equal(await application.evaluate(() => globalThis.taskAudit.writes.length), writesBeforeConfirmation)
  console.log('✓ accepted field clears and reopening reconcile after a lost response without repeating the write')

  await page.getByRole('button', { name: /^Manage Google lists for/ }).click()
  const listManager = page.getByRole('dialog', { name: 'Google task lists' })
  await listManager.getByLabel('List name', { exact: true }).fill('Desktop list')
  await listManager.getByRole('button', { name: 'Create Google list', exact: true }).click()
  await waitForSnapshot((snapshot) => snapshot.listOperations?.some((op) => op.title === 'Desktop list' && op.status === 'succeeded'))
  const desktopListId = `${accountId}:google-task-list:created-list-1`
  await listManager.getByRole('button', { name: 'Rename Google list Desktop list', exact: true }).click()
  await listManager.getByLabel('New list name').fill('Renamed desktop list')
  await listManager.getByRole('button', { name: 'Save list name', exact: true }).click()
  await waitForSnapshot((snapshot) => snapshot.listOperations?.some((op) => op.title === 'Renamed desktop list' && op.status === 'succeeded'))
  await application.evaluate(() => { Object.assign(globalThis.taskAudit.lists['created-list-1'], { title: 'Changed list elsewhere', etag: 'external-list-v2' }) })
  const writesBeforeListConflict = await application.evaluate(() => globalThis.taskAudit.writes.length)
  await listManager.getByRole('button', { name: 'Rename Google list Renamed desktop list', exact: true }).click()
  await listManager.getByLabel('New list name').fill('My list name')
  await listManager.getByRole('button', { name: 'Save list name', exact: true }).click()
  await waitForSnapshot((snapshot) => snapshot.listOperations?.some((op) => op.title === 'My list name' && op.status === 'conflict'))
  assert.equal(await application.evaluate(() => globalThis.taskAudit.writes.length), writesBeforeListConflict)
  await listManager.getByRole('button', { name: 'Review list change', exact: true }).click()
  await listManager.getByRole('button', { name: 'Refresh Google lists', exact: true }).click()
  await listManager.getByText('Changed list elsewhere', { exact: true }).waitFor()
  await listManager.getByRole('button', { name: 'Retry list change', exact: true }).click()
  await listManager.getByLabel('List name', { exact: true }).waitFor()
  assert.equal(await application.evaluate(() => globalThis.taskAudit.lists['created-list-1'].title), 'My list name')
  console.log('✓ native list creation and rename persist provider identities; conflict review retries only the reviewed list revision')

  await application.evaluate(() => { globalThis.taskAudit.loseListCreate = true })
  await listManager.getByLabel('List name', { exact: true }).fill('Accepted list')
  await listManager.getByRole('button', { name: 'Create Google list', exact: true }).click()
  await waitForSnapshot((snapshot) => snapshot.listOperations?.some((op) => op.title === 'Accepted list' && op.status === 'review'))
  await listManager.getByRole('button', { name: 'Review list change', exact: true }).click()
  await listManager.getByRole('button', { name: 'Refresh Google lists', exact: true }).click()
  await listManager.getByLabel('List created in Google').selectOption(`${accountId}:google-task-list:created-list-2`)
  await listManager.getByRole('button', { name: 'Confirm list change applied', exact: true }).click()
  await listManager.getByLabel('List name', { exact: true }).waitFor()
  assert.equal(await application.evaluate(() => globalThis.taskAudit.listCreates), 2)
  await page.evaluate(async ({ accountId, listId }) => { await window.aerio.tasks.create(accountId, listId, { title: 'Task inside new list', completed: false }) }, { accountId, listId: desktopListId })
  await waitForSnapshot((snapshot) => snapshot.operations.some((op) => op.before.fields.title === 'Task inside new list' && op.status === 'succeeded'))
  await application.evaluate(() => { globalThis.taskAudit.loseListDelete = true })
  await listManager.getByRole('button', { name: 'Delete Google list My list name', exact: true }).click()
  await waitForSnapshot((snapshot) => snapshot.listOperations?.some((op) => op.kind === 'delete' && op.status === 'review'))
  const writesBeforeListDeleteConfirmation = await application.evaluate(() => globalThis.taskAudit.writes.length)
  await listManager.getByRole('button', { name: 'Review list change', exact: true }).click()
  await listManager.getByRole('button', { name: 'Refresh Google lists', exact: true }).click()
  await listManager.getByRole('button', { name: 'Confirm list change applied', exact: true }).click()
  await listManager.getByLabel('List name', { exact: true }).waitFor()
  snapshot = await page.evaluate(() => window.aerio.tasks.snapshot())
  assert.ok(!snapshot.lists.some((list) => list.id === desktopListId))
  assert.ok(!snapshot.tasks.some((task) => task.listId === desktopListId))
  assert.equal(await application.evaluate(() => globalThis.taskAudit.writes.length), writesBeforeListDeleteConfirmation)
  await listManager.getByRole('button', { name: 'Done', exact: true }).click()
  console.log('✓ list create/delete lost responses reconcile without replay; confirmed deletion removes only that list and its tasks')

  await page.context().setOffline(true)
  await page.evaluate(async (id) => {
    window.dispatchEvent(new Event('offline'))
    await window.aerio.mail.accounts.list()
    await window.aerio.tasks.update(id, { title: 'Pending before archive' })
  }, originalId)
  const writesBeforeArchive = await application.evaluate(() => globalThis.taskAudit.writes.length)
  await page.evaluate(async (accountId) => { await window.aerio.mail.accounts.disconnect(accountId, 'archive') }, accountId)
  snapshot = await page.evaluate(() => window.aerio.tasks.snapshot())
  assert.equal(snapshot.accounts[0].archived, true)
  assert.equal(snapshot.accounts[0].canWrite, false)
  assert.equal(snapshot.tasks.find((task) => task.id === originalId).fields.title, 'Pending before archive')
  assert.ok(snapshot.lists.every((list) => list.readOnly))
  assert.ok(snapshot.operations.some((op) => op.status === 'queued'))
  await page.getByRole('button', { name: 'Complete Pending before archive' }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Complete Pending before archive' }).isDisabled(), true)
  await page.evaluate(async (accountId) => { await window.aerio.mail.accounts.disconnect(accountId, 'delete') }, accountId)
  snapshot = await page.evaluate(() => window.aerio.tasks.snapshot())
  for (const key of ['accounts', 'lists', 'tasks', 'remoteTasks', 'operations', 'listOperations']) assert.deepEqual(snapshot[key], [])
  assert.equal(await application.evaluate(() => globalThis.taskAudit.writes.length), writesBeforeArchive)
  console.log('✓ account archive preserves pending work read-only; deletion purges the task cache without provider writes')
} catch (error) {
  if (page) console.error(await page.locator('body').innerText().catch(() => 'Renderer unavailable'))
  throw error
} finally {
  if (application) await application.close().catch(() => {})
  const location = relative(tmpdir(), profile)
  assert.ok(location && !location.startsWith('..') && !isAbsolute(location) && location.startsWith('aerio-tasks-write-audit-'))
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
