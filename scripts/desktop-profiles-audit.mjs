import assert from 'node:assert/strict'
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { _electron as electron } from 'playwright-core'
import electronPath from 'electron'
import { desktopAuditEnvironment } from './electron-audit-environment.mjs'

const root = resolve(import.meta.dirname, '..')
const profileRoot = mkdtempSync(join(tmpdir(), 'aerio-profiles-audit-'))
let application
async function launch(id) {
  application = await electron.launch({ executablePath: electronPath, args: [root, `--user-data-dir=${profileRoot}`, ...(id ? [`--aerio-profile=${id}`] : [])], cwd: root, env: desktopAuditEnvironment() })
  for (let attempt = 0; attempt < 5; attempt++) {
    const page = application.windows().find((window) => !window.isClosed() && !window.url().startsWith('aerio-chat-service:')) ?? await application.waitForEvent('window')
    try {
      await page.getByRole('button', { name: 'Settings', exact: true }).waitFor({ timeout: 15_000 })
      await page.context().setOffline(true)
      return page
    } catch (error) { if (!page.isClosed()) throw error }
  }
  throw new Error('Aerio did not open its main workspace.')
}
const fixture = (name) => ({ tasks: [], contacts: [], notes: [{ id: `${name}-note`, folder: 'Notes', title: `${name} private note`, content: `${name} only`, tags: [], pinned: false, archived: false, updatedAt: new Date().toISOString() }] })
try {
  let page = await launch('default')
  const profiles = await page.evaluate(() => window.aerio.appProfiles.create('Work'))
  const work = profiles.profiles.find((profile) => profile.name === 'Work')
  assert.ok(work)
  await page.evaluate((local) => window.aerio.productivity.saveLocal(local), fixture('Personal'))
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'dark', exact: true }).click()
  await page.getByRole('dialog', { name: 'Aerio settings' }).getByRole('button', { name: 'Close', exact: true }).click()
  await page.waitForTimeout(600)
  await application.close(); application = undefined

  page = await launch(work.id)
  const workPaths = await application.evaluate(({ app }) => ({ data: app.getPath('userData'), session: app.getPath('sessionData') }))
  assert.equal(workPaths.data, join(profileRoot, 'profiles', work.id))
  assert.equal(workPaths.session, workPaths.data)
  assert.equal((await page.evaluate(() => window.aerio.appProfiles.list())).currentId, work.id)
  assert.deepEqual((await page.evaluate(() => window.aerio.productivity.localSnapshot())).notes, [])
  assert.equal((await page.evaluate(() => window.aerio.loadPreferences())).settings.theme, 'system')
  await page.evaluate((local) => window.aerio.productivity.saveLocal(local), fixture('Work'))
  await page.evaluate(() => localStorage.setItem('profile-isolation-fixture', 'Work'))
  await application.close(); application = undefined

  page = await launch()
  assert.equal((await page.evaluate(() => window.aerio.appProfiles.list())).currentId, work.id)
  assert.equal((await page.evaluate(() => window.aerio.productivity.localSnapshot())).notes[0].title, 'Work private note')
  assert.equal(await page.evaluate(() => localStorage.getItem('profile-isolation-fixture')), 'Work')
  await application.close(); application = undefined

  page = await launch('default')
  assert.equal((await page.evaluate(() => window.aerio.productivity.localSnapshot())).notes[0].title, 'Personal private note')
  assert.equal((await page.evaluate(() => window.aerio.loadPreferences())).settings.theme, 'dark')
  assert.equal(await page.evaluate(() => localStorage.getItem('profile-isolation-fixture')), null)
  assert.equal(await application.evaluate(({ app }) => app.getPath('userData')), profileRoot)
  await page.getByRole('button', { name: 'Switch application profile' }).click()
  await page.getByRole('dialog', { name: 'Application profiles' }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Switch to Personal' }).isDisabled(), true)
  console.log('✓ isolated profile databases, preferences, browser storage, startup selection and existing default profile preserved across four real launches')
} catch (error) {
  const log = join(profileRoot, 'logs', 'aerio.jsonl')
  if (existsSync(log)) console.error(readFileSync(log, 'utf8').slice(-6000))
  throw error
} finally {
  if (application) await application.close().catch(() => undefined)
  const location = relative(tmpdir(), profileRoot)
  assert.ok(location && !location.startsWith('..') && !isAbsolute(location) && location.startsWith('aerio-profiles-audit-'))
  rmSync(profileRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
