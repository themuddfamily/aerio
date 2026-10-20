import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { _electron as electron } from 'playwright-core'
import electronPath from 'electron'
import { MailTemplateStore } from '../electron/mail/template-store.ts'
import { desktopAuditEnvironment } from './electron-audit-environment.mjs'
const root = resolve(import.meta.dirname, '..'), directory = mkdtempSync(join(tmpdir(), 'aerio-settings-sync-audit-'))
const first = join(directory, 'desktop'), second = join(directory, 'laptop'); mkdirSync(first); mkdirSync(second)
let application, encrypted, revision = 0
const server = createServer((request, response) => {
  if (request.headers.authorization !== `Basic ${Buffer.from('aerio-audit:disposable-app-password').toString('base64')}`) { response.writeHead(401).end(); return }
  if (request.method === 'GET') { if (!encrypted) response.writeHead(404).end(); else response.writeHead(200, { ETag: `"${revision}"` }).end(encrypted); return }
  if (request.method !== 'PUT') { response.writeHead(405).end(); return }
  if (encrypted ? request.headers['if-match'] !== `"${revision}"` : request.headers['if-none-match'] !== '*') { response.writeHead(412).end(); return }
  const chunks = []; request.on('data', (chunk) => chunks.push(chunk)); request.on('end', () => { encrypted = Buffer.concat(chunks).toString(); response.writeHead(201, { ETag: `"${++revision}"` }).end() })
})
await new Promise((resolveReady) => server.listen(0, '127.0.0.1', resolveReady))
const url = `http://127.0.0.1:${server.address().port}/aerio-settings.enc.json`
async function launch(profile) {
  application = await electron.launch({ executablePath: electronPath, args: [root, `--user-data-dir=${profile}`], cwd: root, env: desktopAuditEnvironment() })
  for (let attempt = 0; attempt < 5; attempt++) {
    const page = application.windows().find((page) => !page.isClosed() && !page.url().startsWith('aerio-chat-service:')) ?? await application.waitForEvent('window')
    try { await page.getByRole('button', { name: 'Settings', exact: true }).waitFor({ timeout: 15000 }); return page } catch (error) { if (!page.isClosed()) throw error }
  }
  throw new Error('Aerio did not open its workspace.')
}
async function configure(page, deviceName) {
  await page.evaluate(({ url, deviceName }) => window.aerio.settingsSync.configure({ enabled: true, url, username: 'aerio-audit', password: 'disposable-app-password', passphrase: 'disposable shared sync passphrase', intervalMinutes: 15, deviceName }), { url, deviceName })
}
try {
  const source = join(directory, 'brief.txt'); writeFileSync(source, 'Portable template attachment')
  const templates = new MailTemplateStore(join(first, 'mail-templates.sqlite'), join(first, 'template-attachments'), () => true)
  templates.save({ kind: 'snippet', name: 'Portable QuickText', html: '<p>Thanks from desktop</p>' })
  templates.save({ kind: 'template', name: 'Portable report', subject: 'Review report', html: '<p>Report body</p>', attachments: [{ name: 'brief.txt', size: Buffer.byteLength('Portable template attachment'), path: source }] }); templates.close()
  let page = await launch(first)
  await page.evaluate(() => window.aerio.mail.identities.signatures.save({ name: 'Portable signature', html: '<b>Desktop signoff</b>' }))
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('dialog', { name: 'Aerio settings' }).getByRole('button', { name: 'dark', exact: true }).click()
  await page.getByRole('dialog', { name: 'Aerio settings' }).getByRole('button', { name: 'Close', exact: true }).click()
  await page.waitForTimeout(500)
  await configure(page, 'Desktop')
  { const status = await page.evaluate(() => window.aerio.settingsSync.sync()); assert.equal(status.phase, 'idle', JSON.stringify(status)) }
  assert.ok(encrypted && !encrypted.includes('Desktop signoff') && !encrypted.includes('Portable QuickText') && !encrypted.includes('Portable template attachment'))
  await application.close(); application = undefined

  page = await launch(second); await configure(page, 'Laptop')
  assert.equal((await page.evaluate(() => window.aerio.settingsSync.sync())).phase, 'review')
  assert.equal((await page.evaluate(() => window.aerio.settingsSync.resolve('remote'))).phase, 'idle')
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
  assert.equal((await page.evaluate(() => window.aerio.mail.identities.signatures.list()))[0].name, 'Portable signature')
  const restored = await page.evaluate(() => window.aerio.mail.templates.list())
  assert.equal(restored.length, 2)
  assert.equal(readFileSync(restored.find((item) => item.kind === 'template').attachments[0].path, 'utf8'), 'Portable template attachment')
  const snippet = restored.find((item) => item.kind === 'snippet')
  await page.evaluate((snippet) => window.aerio.mail.templates.save({ id: snippet.id, kind: 'snippet', name: snippet.name, html: '<p>Updated from laptop</p>', expectedUpdatedAt: snippet.updatedAt }), snippet)
  { const status = await page.evaluate(() => window.aerio.settingsSync.sync()); assert.equal(status.phase, 'idle', JSON.stringify(status)) }
  await application.close(); application = undefined

  page = await launch(first)
  assert.equal((await page.evaluate(() => window.aerio.settingsSync.status())).configured, true)
  { const status = await page.evaluate(() => window.aerio.settingsSync.sync()); assert.equal(status.phase, 'idle', JSON.stringify(status)) }
  assert.equal((await page.evaluate(() => window.aerio.mail.templates.list())).find((item) => item.kind === 'snippet').text, 'Updated from laptop')
  assert.equal((await page.evaluate(() => window.aerio.settingsSync.disconnect())).configured, false)
  assert.ok(encrypted)
  console.log('✓ encrypted settings, signatures, templates, QuickText and attachment bytes synchronized both ways through real conditional WebDAV between two Electron profiles; credentials persisted securely and disconnected locally')
} finally {
  if (application) await application.close().catch(() => undefined)
  server.closeAllConnections(); await new Promise((resolveClosed) => server.close(resolveClosed))
  const location = relative(tmpdir(), directory); assert.ok(location && !isAbsolute(location) && !location.startsWith('..') && location.startsWith('aerio-settings-sync-audit-'))
  rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
