import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { _electron as electron } from 'playwright-core'
import electronPath from 'electron'
import { ProductivityStore } from '../electron/productivity/store.ts'
import { desktopAuditEnvironment } from './electron-audit-environment.mjs'

const root = resolve(import.meta.dirname, '..')
const profile = mkdtempSync(join(tmpdir(), 'aerio-preferences-audit-'))
const initial = { schemaVersion: 1, settings: { theme: 'light', density: 'compact', closeToTray: true, launchAtLogin: false, notifications: false, startModule: 'notes' } }
const local = {
  tasks: [{ id: 'restart-task', listId: 'Today', title: 'Persisted restart task', priority: 'normal', completed: false, subtasks: [] }],
  notes: [{ id: 'restart-note', folder: 'Work', title: 'Persisted restart note', content: 'Retain this workspace', tags: [], pinned: false, archived: false, updatedAt: new Date().toISOString() }],
  contacts: [{ id: 'restart-contact', name: 'Restart fixture', email: 'restart@example.test', group: 'Work', favorite: false, color: '#6558e8', source: 'local' }]
}
let application

async function launch() {
  application = await electron.launch({ executablePath: electronPath, args: [root, `--user-data-dir=${profile}`], cwd: root, env: desktopAuditEnvironment() })
  const page = await application.firstWindow()
  await page.context().setOffline(true)
  await page.getByRole('button', { name: 'Settings', exact: true }).waitFor()
  return page
}

try {
  const database = new DatabaseSync(join(profile, 'aerio-state.sqlite'))
  database.exec('CREATE TABLE app_preferences(id INTEGER PRIMARY KEY, schema_version INTEGER NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL)')
  database.prepare('INSERT INTO app_preferences VALUES(1, 1, ?, ?)').run(JSON.stringify(initial), new Date().toISOString())
  database.close()
  const store = new ProductivityStore(join(profile, 'productivity.sqlite'))
  store.saveLocal(local); store.close()
  let page = await launch()
  await page.locator('.module-rail button[aria-current="page"][aria-label="Notes"]').waitFor()
  await page.getByText('Persisted restart note', { exact: true }).first().waitFor()
  assert.deepEqual(await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, density: document.documentElement.dataset.density })), { theme: 'light', density: 'compact' })
  assert.deepEqual(await page.evaluate(() => window.aerio.productivity.localSnapshot()), local)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  let settings = page.getByRole('dialog', { name: 'Aerio settings' })
  await settings.getByRole('button', { name: 'dark', exact: true }).click()
  await settings.getByRole('button', { name: 'comfortable', exact: true }).click()
  await settings.getByRole('checkbox', { name: /Keep scheduling active in the tray/ }).uncheck()
  await settings.getByRole('checkbox', { name: /Start Aerio when you sign in/ }).check()
  await settings.getByRole('checkbox', { name: /Desktop notifications/ }).check()
  await settings.getByLabel(/^Open Aerio to/).selectOption('tasks')
  const expected = { schemaVersion: 1, settings: { theme: 'dark', density: 'comfortable', closeToTray: false, launchAtLogin: true, notifications: true, startModule: 'tasks' } }
  let saved
  for (let attempt = 0; attempt < 100; attempt++) {
    saved = await page.evaluate(() => window.aerio.loadPreferences())
    if (JSON.stringify(saved) === JSON.stringify(expected)) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.deepEqual(saved, expected, 'Native preferences must be persisted before testing close behavior')
  await settings.getByRole('button', { name: 'Close', exact: true }).click()
  const exited = new Promise((resolve) => application.process().once('exit', resolve))
  await page.getByRole('button', { name: 'Close', exact: true }).first().click()
  await Promise.race([exited, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Close without tray did not exit')), 10_000); timer.unref() })])
  application = undefined
  page = await launch()
  await page.locator('.module-rail button[aria-current="page"][aria-label="Tasks"]').waitFor()
  await page.getByText('Persisted restart task', { exact: true }).waitFor()
  assert.deepEqual(await page.evaluate(() => window.aerio.loadPreferences()), expected)
  assert.deepEqual(await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, density: document.documentElement.dataset.density })), { theme: 'dark', density: 'comfortable' })
  assert.deepEqual(await page.evaluate(() => window.aerio.productivity.localSnapshot()), local)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  settings = page.getByRole('dialog', { name: 'Aerio settings' })
  assert.equal(await settings.getByRole('checkbox', { name: /Keep scheduling active in the tray/ }).isChecked(), false)
  assert.equal(await settings.getByRole('checkbox', { name: /Start Aerio when you sign in/ }).isChecked(), true)
  assert.equal(await settings.getByRole('checkbox', { name: /Desktop notifications/ }).isChecked(), true)
  console.log('✓ persisted startup module, appearance, tray, login, and notification choices survive a real quit/relaunch with local data intact')
} finally {
  if (application) await application.close().catch(() => undefined)
  const location = relative(tmpdir(), profile)
  assert.ok(location && !location.startsWith('..') && !isAbsolute(location) && location.startsWith('aerio-preferences-audit-'))
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
