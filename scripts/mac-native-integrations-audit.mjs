import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { _electron as electron } from 'playwright-core'
import { MailDatabase } from '../electron/mail/database.ts'
import { desktopAuditEnvironment } from './electron-audit-environment.mjs'
import { auditMacAppleScript } from './mac-applescript-audit.mjs'

if (process.platform !== 'darwin') throw new Error('Native AppleScript/Spotlight audit requires macOS')
const run = promisify(execFile), root = resolve(import.meta.dirname, '..')
const onlyAppleScript = process.argv.includes('--applescript-only')
const bundle = resolve(process.argv.slice(2).find((value) => !value.startsWith('--')) ?? `release/${process.arch === 'x64' ? 'mac' : `mac-${process.arch}`}/Aerio.app`)
const directory = mkdtempSync(join(tmpdir(), 'aerio-mac-native-')), title = `Aerio Spotlight fixture ${randomUUID()}`
if (!onlyAppleScript) {
const database = new MailDatabase(join(directory, 'aerio.sqlite'), join(directory, 'mail'))
for (const accountId of ['allowed', 'omitted']) {
  database.upsertAccount({ id: accountId, provider: 'gmail', email: `${accountId}@example.test`, displayName: accountId, color: '#123456', status: 'needs-auth', archived: false, signature: '', notifications: false, syncEnabled: false })
  database.addInventory(accountId, [{ id: 'fixture-message', threadId: 'fixture-thread' }])
  const rawPath = join(directory, `${accountId}.eml`)
  writeFileSync(rawPath, 'From: sender@example.test\r\nSubject: Native fixture\r\n\r\nDisposable native Spotlight fixture body\r\n')
  database.upsertMessage({ accountId, id: 'fixture-message', threadId: 'fixture-thread', historyId: '1', internalDate: new Date().toISOString(), fromName: 'Native fixture', fromEmail: 'sender@example.test', to: [`${accountId}@example.test`], cc: [], subject: accountId === 'allowed' ? title : `${title} omitted`, messageIdHeader: '<fixture@example.test>', references: [], snippet: 'Disposable preview', text: 'Disposable native Spotlight fixture body', html: '', labelIds: ['INBOX'], sizeEstimate: 100, rawPath, attachments: [] })
}
database.close()
}
let application, page
const waitFor = async (check, message, timeout = 60_000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await check()) return; await new Promise((done) => setTimeout(done, 250)) }
  throw new Error(message)
}
try {
  application = await electron.launch({ executablePath: join(bundle, 'Contents/MacOS/Aerio'), args: [`--user-data-dir=${directory}`], env: { ...desktopAuditEnvironment(), AERIO_NATIVE_AUDIT: '1' }, timeout: 30_000 })
  application.process().stderr?.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) if (line.startsWith('[Aerio AppleScript] ')) console.log(line)
  })
  // The crypto persistence probe creates and destroys a sandboxed service view
  // during startup. Wait for the actual application window, including when a
  // just-created blank service view was the first Playwright page.
  for (let attempt = 0; attempt < 8; attempt++) {
    page = application.windows().find((candidate) => !candidate.isClosed() && !candidate.url().startsWith('aerio-chat-service:')) ?? await application.waitForEvent('window', { timeout: 30_000 })
    try { await page.getByRole('button', { name: 'Settings', exact: true }).waitFor({ timeout: 15_000 }); break }
    catch (error) { if (!page.isClosed() || attempt === 7) throw error }
  }
  await page.context().setOffline(true)
  await auditMacAppleScript(application, page)
  if (onlyAppleScript) console.log('PASS: packaged native inbound AppleScript automation. Spotlight was not requested by this audit mode.')
  else {
  const profile = await application.evaluate(({ app }) => app.getPath('userData'))
  const domain = `com.aerio.spotlight.${createHash('sha256').update(profile).digest('hex').slice(0, 24)}`
  const query = (title) => application.evaluate(async ({ app }, { domain, title }) => {
    const { createRequire } = await import('node:module')
    const native = createRequire(app.getAppPath() + '/package.json')(process.resourcesPath + '/native/spotlight.node')
    return JSON.parse(await native.perform('query', JSON.stringify({ domain, title })))
  }, { domain, title })
  const status = await page.evaluate(() => window.aerio.spotlight.status())
  assert.equal(status.available, true, status.error); assert.equal(status.settings.enabled, false)
  const indexed = await page.evaluate(() => window.aerio.spotlight.save({ enabled: true, accountIds: ['allowed'], includePreview: false }))
  assert.equal(indexed.indexed, 1, indexed.error)
  let identifiers = []
  await waitFor(async () => { identifiers = await query(title); return identifiers.length === 1 }, 'Core Spotlight did not return the donated native fixture item')
  assert.deepEqual(await query(title + ' omitted'), [])
  await page.evaluate(() => window.aerio.appLock.enable('spotlight-native-fixture'))
  await page.evaluate(() => window.aerio.appLock.lock())
  await waitFor(async () => (await query(title)).length === 0, 'Core Spotlight did not remove indexed metadata after locking')
  const before = application.windows().filter((window) => window.url().includes('view=message')).length
  await run('open', ['-a', bundle, `aerio://spotlight/${identifiers[0]}`], { timeout: 10_000 })
  await page.getByRole('heading', { name: 'Unlock Aerio' }).waitFor()
  assert.equal(application.windows().filter((window) => window.url().includes('view=message')).length, before)
  await page.evaluate(() => window.aerio.appLock.unlock('spotlight-native-fixture'))
  await waitFor(() => application.windows().some((window) => window.url().includes('view=message') && window.url().includes('accountId=allowed')), 'LaunchServices Spotlight route did not restore the selected conversation after unlock')
  const message = application.windows().find((window) => window.url().includes('view=message') && window.url().includes('accountId=allowed'))
  await message.getByText('Disposable native Spotlight fixture body', { exact: true }).waitFor()
  await page.evaluate(() => window.aerio.appLock.disable('spotlight-native-fixture'))
  await page.evaluate(() => window.aerio.spotlight.save({ enabled: false, accountIds: [], includePreview: false }))
  await waitFor(async () => (await query(title)).length === 0, 'Core Spotlight did not remove metadata after disabling')
  console.log('PASS: packaged native AppleScript + Core Spotlight donation/query/removal, selected-account exclusion, real LaunchServices URL routing through app lock and conversation restoration.')
  }
} finally {
  if (page && !page.isClosed()) {
    const lock = await page.evaluate(() => window.aerio.appLock.status()).catch(() => undefined)
    if (lock?.locked) await page.evaluate(() => window.aerio.appLock.unlock('spotlight-native-fixture')).catch(() => {})
    await page.evaluate(() => window.aerio.spotlight.save({ enabled: false, accountIds: [], includePreview: false })).catch(() => {})
  }
  await application?.close()
  const path = relative(tmpdir(), directory); if (!path.startsWith('aerio-mac-native-') || path.includes('..') || isAbsolute(path)) throw new Error('Unsafe audit cleanup path')
  rmSync(directory, { recursive: true, force: true })
}
