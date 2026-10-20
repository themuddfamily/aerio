import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, relative, isAbsolute } from 'node:path'
import { _electron as electron } from 'playwright-core'
import electronPath from 'electron'
import { MailDatabase } from '../electron/mail/database.ts'
import { desktopAuditEnvironment } from './electron-audit-environment.mjs'
const root = resolve(import.meta.dirname, '..'), profile = mkdtempSync(join(tmpdir(), 'aerio-task-delegation-audit-'))
let application
async function launch() {
  application = await electron.launch({ executablePath: electronPath, args: [root, `--user-data-dir=${profile}`], cwd: root, env: desktopAuditEnvironment() })
  for (let count = 0; count < 5; count++) {
    const page = application.windows().find((item) => !item.isClosed() && !item.url().startsWith('aerio-chat-service:')) ?? await application.waitForEvent('window')
    try {
      await page.context().setOffline(true)
      await page.getByRole('button', { name: 'Tasks', exact: true }).waitFor({ timeout: 15000 })
      await page.evaluate(() => { window.dispatchEvent(new Event('offline')) })
      await page.getByRole('button', { name: 'Tasks', exact: true }).click()
      await page.getByRole('button', { name: 'Delegated tasks', exact: true }).click()
      return page
    } catch (error) { if (!page.isClosed()) throw error }
  }
  throw new Error('Workspace did not open')
}
try {
  // Disconnected synthetic accounts have no vault entries. This audit never contacts a provider.
  let db = new MailDatabase(join(profile, 'aerio.sqlite'), join(profile, 'mail'))
  for (const email of ['assignor@example.test', 'assignee@example.test']) db.upsertAccount({ id: email, email, provider: 'imap', displayName: email, color: '#6558e8', status: 'paused', archived: false, signature: '', notifications: false, syncEnabled: false })
  db.close()
  let page = await launch()
  await page.getByRole('button', { name: 'Delegate task', exact: true }).click()
  await page.getByLabel('Send from').selectOption('assignor@example.test')
  await page.getByLabel('Assign to').fill('assignee@example.test')
  await page.getByLabel('Task title').fill('Offline native delegation')
  await page.getByRole('textbox', { name: 'Notes', exact: true }).fill('Review this request')
  await page.getByRole('button', { name: 'Send task request', exact: true }).click()
  await page.getByRole('heading', { name: 'Offline native delegation' }).waitFor()
  let tasks = await page.evaluate(() => window.aerio.taskDelegations.list())
  assert.equal(tasks.length, 1); assert.equal(tasks[0].deliveries[0].status, 'send-pending')
  const uid = tasks[0].uid
  await application.close(); application = undefined
  db = new MailDatabase(join(profile, 'aerio.sqlite'), join(profile, 'mail'))
  const original = db.taskDelegations.list()[0]
  const calendar = db.taskDelegations.calendar(original.deliveries[0].id)
  assert.match(calendar.ics, /BEGIN:VTODO/)
  db.taskDelegations.observe('assignee@example.test', 'assignor@example.test', ['assignee@example.test'], [calendar.ics])
  db.close()
  page = await launch()
  const incoming = page.locator('.delegation-card').filter({ has: page.getByRole('button', { name: 'Accept and send reply', exact: true }) })
  await incoming.getByLabel('Reply comment').fill('Accepted offline')
  await incoming.getByRole('button', { name: 'Accept and send reply', exact: true }).click()
  await page.getByRole('button', { name: 'Complete and send reply', exact: true }).waitFor()
  tasks = await page.evaluate(() => window.aerio.taskDelegations.list())
  assert.equal(tasks.length, 2)
  const response = tasks.find((task) => task.role === 'assignee')
  assert.equal(response.participation, 'ACCEPTED'); assert.equal(response.uid, uid)
  assert.equal(response.deliveries[0].method, 'REPLY')
  await application.close(); application = undefined
  console.log('✓ native task delegation form, durable offline request, restarted recipient recognition, and explicit acceptance reply passed with synthetic disconnected accounts')
} finally {
  if (application) await application.close().catch(() => {})
  const target = relative(tmpdir(), profile); assert.ok(target && !isAbsolute(target) && !target.startsWith('..') && target.startsWith('aerio-task-delegation-audit-'))
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
