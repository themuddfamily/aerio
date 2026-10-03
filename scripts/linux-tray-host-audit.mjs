import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
async function until(predicate, description) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Native tray audit timed out: ${description}`)
}

export async function auditLinuxTrayHost({ profile, launch, preferences }) {
  const record = join(profile, 'tray-host.json')
  const host = spawn('python3', [join(import.meta.dirname, 'fixtures', 'linux-tray-host.py'), record], { stdio: ['ignore', 'ignore', 'inherit'] })
  const hostClosed = new Promise((resolve) => { host.once('exit', resolve); host.once('error', resolve) })
  let hostError
  host.once('error', (error) => { hostError = error })
  const state = () => existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')) : undefined
  let application
  try {
    await until(() => {
      if (hostError) throw hostError
      if (host.exitCode !== null) throw new Error('Controlled tray host exited early')
      return state()?.ready
    }, 'host registration')
    const launched = await launch()
    application = launched.application
    const page = launched.page
    const local = await page.evaluate(() => window.aerio.productivity.localSnapshot())
    await until(() => state()?.items.length, 'real Electron tray registration')
    const item = state().items[0]
    const window = await application.browserWindow(page)
    await page.evaluate((value) => window.aerio.savePreferences({ ...value, settings: { ...value.settings, closeToTray: true } }), preferences)
    await page.evaluate(() => window.aerio.appLock.enable('tray-host-fixture-passphrase'))
    await window.evaluate((window) => window.close())
    await until(() => window.evaluate((window) => !window.isVisible()), 'close to registered tray')
    assert.equal((await page.evaluate(() => window.aerio.appLock.status())).locked, true)
    await exec('gdbus', ['call', '--session', '--dest', item.service, '--object-path', item.path,
      '--method', 'org.kde.StatusNotifierItem.Activate', '0', '0'], { timeout: 5_000 })
    await until(() => window.evaluate((window) => window.isVisible() && !window.isMinimized()), 'tray activation')
    assert.equal((await page.evaluate(() => window.aerio.appLock.status())).locked, true)
    await window.evaluate((window) => window.close())
    await until(() => window.evaluate((window) => !window.isVisible()), 'second tray close')
    host.kill('SIGTERM')
    await hostClosed
    await until(() => window.evaluate((window) => window.isVisible() && window.isMinimized()), 'host loss restores taskbar access')
    assert.equal((await page.evaluate(() => window.aerio.appLock.status())).locked, true)
    await window.evaluate((window) => window.restore())
    await page.evaluate(() => window.aerio.appLock.unlock('tray-host-fixture-passphrase'))
    await page.evaluate(() => window.aerio.appLock.disable('tray-host-fixture-passphrase'))
    await page.evaluate((value) => window.aerio.savePreferences(value), preferences)
    assert.deepEqual(await page.evaluate(() => window.aerio.productivity.localSnapshot()), local)
    console.log('Native registered tray: real item registration, D-Bus activation, lock-preserving reopening and taskbar recovery after host loss passed.')
  } finally {
    if (host.exitCode === null && host.signalCode === null) host.kill('SIGTERM')
    await hostClosed
    if (application) await application.close().catch(() => undefined)
  }
}
