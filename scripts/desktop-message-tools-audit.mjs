import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import { _electron as electron } from 'playwright-core'
import { MailDatabase } from '../electron/mail/database.ts'
import { desktopAuditEnvironment } from './electron-audit-environment.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const profile = mkdtempSync(join(tmpdir(), 'aerio-message-tools-audit-'))
assert.equal(dirname(profile), resolve(tmpdir()))
const raw = Buffer.from('From: Ada <ada@example.test>\r\nTo: me@example.test\r\nSubject: Message tools audit\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="audit"\r\n\r\n--audit\r\nContent-Type: text/plain\r\n\r\nEmail body\r\n--audit\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename="report.txt"\r\nContent-Transfer-Encoding: base64\r\n\r\nYXR0YWNobWVudCBjb250ZW50\r\n--audit--\r\n')
const rawPath = join(profile, 'original.eml')
const output = join(profile, 'exported.eml')
const database = new MailDatabase(join(profile, 'aerio.sqlite'), join(profile, 'mail'))
writeFileSync(rawPath, raw)
database.upsertAccount({ id: 'audit', provider: 'gmail', email: 'me@example.test', displayName: 'Audit', color: '#123456', status: 'needs-auth', archived: false, signature: '', notifications: false, syncEnabled: false })
database.replaceLabels('audit', [{ accountId: 'audit', id: 'work', name: 'Work', type: 'user' }])
database.addInventory('audit', [{ id: 'm1', threadId: 'thread' }, { id: 'm2', threadId: 'thread' }])
for (const [index, id] of ['m1', 'm2'].entries()) database.upsertMessage({ accountId: 'audit', id, threadId: 'thread', historyId: '1', internalDate: `2026-10-01T0${index + 8}:00:00Z`, fromName: 'Ada', fromEmail: 'ada@example.test', to: ['me@example.test'], cc: [], subject: 'Message tools audit', messageIdHeader: `<${id}@example.test>`, references: [], snippet: 'Email body', text: 'Email body', html: '<p>Formatted <strong>email body</strong></p>', labelIds: ['INBOX'], sizeEstimate: raw.length, rawPath, attachments: [{ id: `part-0-${Buffer.from('report.txt::text/plain').toString('base64url').slice(0, 16)}`, messageId: id, filename: 'report.txt', mimeType: 'text/plain', size: 18 }] })
database.close()

const errors = []
let application
const translationServer = createServer((request, response) => {
  let body = ''
  request.on('data', (chunk) => { body += chunk })
  request.on('end', () => {
    const input = JSON.parse(body)
    assert.equal(input.q, 'Email body')
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ translatedText: 'Texte du courriel' }))
  })
})
await new Promise((resolve) => translationServer.listen(0, '127.0.0.1', resolve))
const endpoint = `http://127.0.0.1:${translationServer.address().port}`
const launch = () => electron.launch({ executablePath: electronPath, args: [root, `--user-data-dir=${profile}`], cwd: root, env: desktopAuditEnvironment() })
const track = (page) => { page.setDefaultTimeout(15_000); page.on('pageerror', (error) => errors.push(error.message)) }
const choose = async (page, label) => {
  console.log(`Checking ${label}`)
  await page.locator('.thread-message').last().getByRole('button', { name: 'Message options' }).click()
  await page.getByRole('menuitem', { name: label, exact: true }).click()
}
try {
  application = await launch()
  const page = await application.firstWindow()
  track(page)
  await page.locator('.message-row').first().click()
  await page.locator('.thread-message').last().waitFor()
  await choose(page, 'Expand all messages')
  assert.equal(await page.locator('.thread-message.expanded').count(), 2)
  await choose(page, 'Collapse all messages')
  assert.equal(await page.locator('.thread-message.expanded').count(), 0)
  await choose(page, 'Expand all messages')
  await choose(page, 'Edit categories…')
  await page.getByLabel('Categories', { exact: true }).fill('Work, Urgent')
  await page.getByRole('button', { name: 'Save categories' }).click()
  await page.getByText('Urgent', { exact: true }).waitFor()
  await choose(page, 'Message format…')
  await page.getByLabel('Display format').selectOption('plain')
  await page.getByLabel('Text size').selectOption('18')
  await page.getByRole('button', { name: 'Save format' }).click()
  await page.locator('.thread-message').last().locator('.mail-text').waitFor()
  await application.evaluate(({ dialog }, { output, profile }) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: output })
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [profile] })
  }, { output, profile })
  await choose(page, 'Save email as…')
  await page.getByText('Email saved', { exact: true }).waitFor()
  assert.deepEqual(readFileSync(output), raw)
  await choose(page, 'Save all attachments…')
  await page.getByText('Saved 1 attachment', { exact: true }).waitFor()
  assert.equal(readFileSync(join(profile, 'report.txt'), 'utf8'), 'attachment content')
  await application.evaluate(({ webContents }) => {
    Object.getPrototypeOf(webContents.getAllWebContents()[0]).print = function (_options, callback) {
      this.executeJavaScript('document.body.innerText').then((text) => { globalThis.__aerioPrintText = text; callback(true, '') }, (error) => callback(false, error.message))
    }
  })
  await choose(page, 'Print email…')
  await page.waitForFunction(() => !document.querySelector('.context-menu'))
  const printText = await application.evaluate(async () => {
    for (let attempt = 0; attempt < 50 && !globalThis.__aerioPrintText; attempt++) await new Promise((resolve) => setTimeout(resolve, 100))
    return globalThis.__aerioPrintText
  })
  assert.ok(printText?.includes('Email body'))
  assert.ok(!printText?.includes('Formatted email body'))
  await choose(page, 'Create task from email…')
  await page.getByRole('dialog').getByLabel('Title').fill('Follow up from email')
  await page.getByRole('button', { name: 'Create task', exact: true }).click()
  await page.getByText('Task created from email', { exact: true }).waitFor()
  await choose(page, 'Add note…')
  await page.getByRole('dialog').getByLabel('Note', { exact: true }).fill('Email context note')
  await page.getByRole('button', { name: 'Save note' }).click()
  await page.getByText('Note attached to email', { exact: true }).waitFor()
  await choose(page, 'Create rule from email…')
  assert.equal(await page.getByLabel('Condition 1 value').inputValue(), 'ada@example.test')
  await page.getByLabel('Action 1', { exact: true }).selectOption('read')
  await page.getByRole('button', { name: 'Save rule' }).click()
  await page.getByText('Rule saved', { exact: true }).waitFor()
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).last().click()
  await choose(page, 'Translate…')
  await page.getByLabel('LibreTranslate server').fill(endpoint)
  await page.getByLabel('Target language code').fill('fr')
  await page.getByRole('button', { name: 'Translate', exact: true }).click()
  await page.getByText('Texte du courriel', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await choose(page, 'Message properties')
  await page.getByRole('dialog').getByText('<m2@example.test>', { exact: true }).waitFor()
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).last().click()
  await page.locator('.module-rail').getByRole('button', { name: 'Tasks', exact: true }).click()
  await page.getByText('Follow up from email', { exact: true }).waitFor()
  await page.locator('.module-rail').getByRole('button', { name: 'Notes', exact: true }).click()
  await page.getByText('Email context note', { exact: true }).first().waitFor()

  const opened = application.waitForEvent('window')
  await page.evaluate(async () => window.aerio.window.openMessage({ source: 'connected', accountId: 'audit', threadId: 'thread', messageId: 'm2', title: 'Message tools audit' }))
  const windowPage = await opened
  assert.ok(windowPage)
  track(windowPage)
  await windowPage.locator('.thread-message').last().locator('.mail-text').waitFor()
  await choose(windowPage, 'Expand all messages')
  assert.equal(await windowPage.locator('.thread-message.expanded').count(), 2)
  await choose(windowPage, 'Add note…')
  await windowPage.getByText('Email context note', { exact: true }).waitFor()
  await windowPage.getByRole('button', { name: 'Cancel', exact: true }).click()
  await application.close()
  application = await launch()
  const reopened = await application.firstWindow()
  track(reopened)
  await reopened.locator('.message-row').first().click()
  await reopened.getByText('Urgent', { exact: true }).waitFor()
  await reopened.locator('.thread-message').last().locator('.mail-text').waitFor()
  const local = await reopened.evaluate(() => window.aerio.productivity.localSnapshot())
  assert.equal(local.tasks[0].title, 'Follow up from email')
  assert.equal(local.notes[0].content, 'Email context note')
  assert.deepEqual(errors, [])
  console.log('Desktop message tools audit passed: both viewers, expansion, persistent categories/format, byte-exact EML export, batch attachments, tasks, linked notes, rule creation, translation IPC, properties, restart persistence.')
} finally {
  if (application) await application.close().catch(() => undefined)
  await new Promise((resolve) => translationServer.close(resolve))
  assert.equal(dirname(profile), resolve(tmpdir()))
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
