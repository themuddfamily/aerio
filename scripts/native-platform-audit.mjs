import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { _electron as electron } from 'playwright-core'
import { desktopAuditEnvironment } from './electron-audit-environment.mjs'
import { auditLinuxTrayHost } from './linux-tray-host-audit.mjs'
import { auditMacIntegration } from './mac-integration-audit.mjs'

if (!['linux', 'darwin'].includes(process.platform)) throw new Error('This audit requires a native macOS or Linux host')
const defaultExecutable = process.platform === 'darwin'
  ? `release/${process.arch === 'x64' ? 'mac' : `mac-${process.arch}`}/Aerio.app/Contents/MacOS/Aerio`
  : 'release/linux-unpacked/aerio'
const executable = resolve(process.argv[2] ?? defaultExecutable)
const profile = mkdtempSync(join(tmpdir(), 'aerio-native-platform-'))
const preferences = { schemaVersion: 1, settings: { theme: 'dark', density: 'compact', closeToTray: false, launchAtLogin: false, notifications: false, startModule: 'notes' } }
const local = { tasks: [], contacts: [], notes: [{ id: 'native-note', folder: 'Work', title: 'Native persistence — 日本語', content: 'First line\nSecond line', tags: ['native'], pinned: false, archived: false, updatedAt: '2026-10-01T12:00:00Z' }] }
let application
let encrypted
const errors = []

async function launch(login = false) {
  const env = desktopAuditEnvironment()
  env.AERIO_TEST_HIDDEN = '0'
  application = await electron.launch({ executablePath: executable, args: [`--user-data-dir=${profile}`, ...(login ? ['--aerio-login'] : [])], env, timeout: 30_000 })
  const page = await application.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.context().setOffline(true)
  await page.getByRole('button', { name: 'Settings', exact: true }).waitFor()
  await page.locator('.save-indicator.saved').waitFor()
  const native = await application.evaluate(({ app, BrowserWindow }) => ({
    packaged: app.isPackaged, platform: process.platform, arch: process.arch,
    preferences: BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()
  }))
  assert.equal(native.packaged, true)
  assert.equal(native.platform, process.platform)
  assert.equal(native.arch, process.arch)
  assert.equal(native.preferences.sandbox, true)
  assert.equal(native.preferences.contextIsolation, true)
  assert.equal(native.preferences.nodeIntegration, false)
  assert.deepEqual(await page.evaluate(() => window.aerio.loadPreferences()), preferences)
  assert.equal((await page.evaluate(() => window.aerio.updates.status())).phase, 'unsupported')
  assert.equal(typeof await page.evaluate(() => window.aerio.mail.diagnostics.health()), 'object')
  return page
}

try {
  const database = new DatabaseSync(join(profile, 'aerio-state.sqlite'))
  database.exec('CREATE TABLE app_preferences(id INTEGER PRIMARY KEY, schema_version INTEGER NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL)')
  database.prepare('INSERT INTO app_preferences VALUES(1, 1, ?, ?)').run(JSON.stringify(preferences), new Date().toISOString())
  database.close()
  // Seed before renderer hydration: an out-of-band IPC write into an empty
  // live renderer would race its pending autosave of the original snapshot.
  const productivity = new DatabaseSync(join(profile, 'productivity.sqlite'))
  productivity.exec("CREATE TABLE local_module_state(module TEXT PRIMARY KEY CHECK(module IN ('tasks','notes')), payload_json TEXT NOT NULL, updated_at TEXT NOT NULL)")
  for (const module of ['tasks', 'notes']) productivity.prepare('INSERT INTO local_module_state VALUES(?, ?, ?)').run(module, JSON.stringify(local[module]), new Date().toISOString())
  productivity.close()
  let page = await launch()
  await page.evaluate((snapshot) => window.aerio.productivity.saveLocal(snapshot), local)
  assert.deepEqual(await page.evaluate(() => window.aerio.productivity.localSnapshot()), local)
  encrypted = await application.evaluate(({ safeStorage }) => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Native secure storage is unavailable')
    const backend = process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : 'keychain'
    if (['basic_text', 'unknown'].includes(backend)) throw new Error('Weak secure storage backend')
    return { backend, bytes: safeStorage.encryptString('disposable-native-fixture').toString('base64') }
  })
  assert.notEqual(Buffer.from(encrypted.bytes, 'base64').toString(), 'disposable-native-fixture')
  await page.evaluate(() => window.aerio.appLock.enable('native-fixture-lock-passphrase'))
  assert.equal((await page.evaluate(() => window.aerio.appLock.lock())).locked, true)
  assert.equal((await page.evaluate(() => window.aerio.appLock.unlock('native-fixture-lock-passphrase'))).locked, false)
  await page.evaluate(() => window.aerio.appLock.disable('native-fixture-lock-passphrase'))
  if (process.platform === 'linux') {
    await page.evaluate((value) => window.aerio.savePreferences({ ...value, settings: { ...value.settings, closeToTray: true } }), preferences)
    await page.evaluate(() => window.aerio.appLock.enable('background-fixture-passphrase'))
    const window = await application.browserWindow(page)
    await window.evaluate((window) => window.close())
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await window.evaluate((window) => window.isMinimized())) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.deepEqual(await window.evaluate((window) => ({ minimized: window.isMinimized(), visible: window.isVisible(), destroyed: window.isDestroyed() })), { minimized: true, visible: true, destroyed: false })
    assert.equal((await page.evaluate(() => window.aerio.appLock.status())).locked, true)
    await window.evaluate((window) => window.restore())
    await page.evaluate(() => window.aerio.appLock.unlock('background-fixture-passphrase'))
    await page.evaluate(() => window.aerio.appLock.disable('background-fixture-passphrase'))
    await page.evaluate((value) => window.aerio.savePreferences(value), preferences)
  }
  let startupEntry
  if (process.platform === 'linux') {
    if (!homedir().startsWith(join(tmpdir(), 'aerio-native-home-')) || !process.env.XDG_CONFIG_HOME?.startsWith(`${homedir()}/`)) {
      throw new Error('Linux login audit requires the disposable HOME wrapper')
    }
    startupEntry = join(process.env.XDG_CONFIG_HOME, 'autostart', 'aerio.desktop')
    preferences.settings.launchAtLogin = true
    await page.evaluate((value) => window.aerio.savePreferences(value), preferences)
    const content = readFileSync(startupEntry, 'utf8')
    assert.match(content, /^X-Aerio-Autostart=com\.aerio\.desktop$/m)
    assert.ok(content.includes(`Exec=/usr/bin/env "${executable}" --aerio-login`))
  }
  await application.close()
  application = undefined
  page = await launch(process.platform === 'linux')
  if (process.platform === 'linux') {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()), true)
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore())
    preferences.settings.launchAtLogin = false
    await page.evaluate((value) => window.aerio.savePreferences(value), preferences)
    assert.equal(existsSync(startupEntry), false)
  }
  assert.deepEqual(await page.evaluate(() => window.aerio.productivity.localSnapshot()), local)
  await page.getByText(local.notes[0].title, { exact: true }).first().waitFor()
  assert.equal(await application.evaluate(({ safeStorage }, bytes) => safeStorage.decryptString(Buffer.from(bytes, 'base64')), encrypted.bytes), 'disposable-native-fixture')
  if (process.platform === 'linux') {
    await application.close()
    application = undefined
    await auditLinuxTrayHost({ profile, preferences, launch: async () => {
      const page = await launch()
      return { page, application }
    } })
    application = undefined
  }
  if (process.platform === 'darwin') {
    await auditMacIntegration(application, page, preferences)
    application = undefined
  }
  assert.deepEqual(errors, [])
  console.log(`Native packaged audit passed: ${process.platform}/${process.arch}, ${encrypted.backend}, sandbox/preload/SQLite/worker IPC, local data and credential encryption across restart, app lock, disabled updates${process.platform === 'linux' ? ', owned startup registration/removal and minimized login launch' : ''}.`)
} finally {
  if (application) await application.close().catch(() => undefined)
  const location = relative(tmpdir(), profile)
  if (!location.startsWith('aerio-native-platform-') || location.includes('..') || isAbsolute(location)) throw new Error('Unsafe audit cleanup path')
  rmSync(profile, { recursive: true, force: true })
}
