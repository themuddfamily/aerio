import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import { _electron as electron } from 'playwright-core'
import { desktopAuditEnvironment, desktopAuditVisible } from './electron-audit-environment.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const profile = mkdtempSync(join(tmpdir(), 'aerio-button-audit-'))
const runtimeErrors = []
let application

async function step(name, task) {
  try {
    await task()
    console.log(`✓ ${name}`)
  } catch (error) {
    error.message = `${name}: ${error.message}`
    throw error
  }
}

try {
  application = await electron.launch({
    executablePath: electronPath,
    args: [root, `--user-data-dir=${profile}`],
    cwd: root,
    env: desktopAuditEnvironment()
  })
  const page = await application.firstWindow()
  const trackRuntimeErrors = (target) => {
    target.on('pageerror', (error) => runtimeErrors.push(error.message))
    target.on('console', (message) => { if (message.type() === 'error') runtimeErrors.push(message.text()) })
  }
  trackRuntimeErrors(page)
  await page.waitForSelector('.app')

  const dialog = (name) => page.getByRole('dialog', { name })
  const closeDialog = async (name) => dialog(name).getByRole('button', { name: 'Close' }).click()
  const moduleButton = (name) => page.locator('.module-rail').getByRole('button', { name })
  const assertAccessibleButtons = async () => {
    const missing = await page.locator('button:visible:not([disabled])').evaluateAll((buttons) => buttons
      .filter((button) => !button.innerText.trim() && !button.getAttribute('aria-label') && !button.getAttribute('title'))
      .map((button) => button.outerHTML.slice(0, 180)))
    assert.deepEqual(missing, [])
  }

  await step('all initially visible enabled buttons have an accessible label', async () => {
    await assertAccessibleButtons()
  })

  await step('profile management and application settings are separate', async () => {
    await page.getByRole('button', { name: 'Profile: Aerio user' }).click()
    const profileEditor = dialog('Your Aerio profile')
    await profileEditor.getByLabel('Display name').fill('Aerio Auditor')
    const profilePopoutPromise = application.waitForEvent('window')
    await profileEditor.getByRole('button', { name: 'Pop out Your Aerio profile' }).click()
    const profilePopout = await profilePopoutPromise
    trackRuntimeErrors(profilePopout)
    const poppedProfileEditor = profilePopout.getByRole('dialog', { name: 'Your Aerio profile' })
    await poppedProfileEditor.waitFor()
    assert.equal(await poppedProfileEditor.getByLabel('Display name').inputValue(), 'Aerio Auditor')
    assert.equal(await profileEditor.count(), 0)
    const profilePopoutClosed = profilePopout.waitForEvent('close')
    await poppedProfileEditor.getByRole('button', { name: 'Return Your Aerio profile to main window' }).click()
    await profilePopoutClosed
    await profileEditor.waitFor()
    assert.equal(await profileEditor.getByLabel('Display name').inputValue(), 'Aerio Auditor')
    await profileEditor.getByRole('button', { name: 'Save profile' }).click()
    await page.getByText('Profile updated').waitFor()
    await page.getByRole('button', { name: 'Profile: Aerio Auditor' }).waitFor()

    await page.getByRole('button', { name: 'Settings' }).click()
    await dialog('Aerio settings').getByRole('button', { name: 'dark' }).click()
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark')
    await dialog('Aerio settings').getByRole('button', { name: 'system' }).click()
    await closeDialog('Aerio settings')
  })

  await step('command palette supports keyboard navigation and execution', async () => {
    await page.getByRole('button', { name: /Search mail or run a command/ }).click()
    const search = dialog('Command palette').getByPlaceholder('Search Aerio…')
    await search.fill('notes')
    await search.press('ArrowDown')
    await search.press('Enter')
    await page.getByRole('heading', { name: 'All notes' }).waitFor()
  })

  await step('mail panes expose accessible resize separators', async () => {
    await moduleButton('Mail').click()
    const foldersSeparator = page.getByRole('separator', { name: 'Resize mail folders' })
    const listSeparator = page.getByRole('separator', { name: 'Resize message list' })
    await foldersSeparator.waitFor()
    await listSeparator.waitFor()
    assert.equal(await foldersSeparator.getAttribute('aria-orientation'), 'vertical')
    assert.equal(await listSeparator.getAttribute('aria-orientation'), 'vertical')
  })

  await step('calendar explains how to enable provider editing', async () => {
    await moduleButton('Calendar').click()
    await assertAccessibleButtons()
    await page.getByRole('button', { name: 'Enable event editing' }).click()
    await page.getByText('Connect Google or Microsoft to enable Calendar editing').waitFor()
  })

  await step('contacts show a local-first empty state and Chat stays outside v1 navigation', async () => {
    await moduleButton('Contacts').click()
    await assertAccessibleButtons()
    await page.getByRole('heading', { name: 'Select a contact' }).waitFor()
    assert.equal(await page.locator('.module-rail').getByRole('button', { name: 'Chat', exact: true }).count(), 0)
  })

  await step('task editor blocks empty saves and creates a task', async () => {
    await moduleButton('Tasks').click()
    await assertAccessibleButtons()
    await page.getByRole('button', { name: 'New task' }).click()
    const editor = dialog('New task')
    assert.equal(await editor.getByRole('button', { name: 'Save task' }).isDisabled(), true)
    await editor.getByPlaceholder('What needs doing?').fill('Verify every button')
    await editor.getByRole('button', { name: 'Save task' }).click()
    await page.getByText('Task created').waitFor()
  })

  await step('note tag filters, view buttons, creation, and archive work', async () => {
    await moduleButton('Notes').click()
    await assertAccessibleButtons()
    await page.getByRole('button', { name: 'Grid view' }).click()
    await page.getByRole('button', { name: 'New note' }).click()
    await page.getByTitle('Archive').click()
    await page.getByText('Note archived').waitFor()
  })

  await step('real-mail onboarding and Ctrl+N account setup work without credentials', async () => {
    await moduleButton('Mail').click()
    assert.equal(await moduleButton('Tasks').locator('em').count(), 0, 'Connected Tasks badge should use the connected workspace task count')
    await page.getByRole('button', { name: 'Add your first account' }).click()
    const setup = dialog('Add mail account')
    const setupPopoutPromise = application.waitForEvent('window')
    await setup.getByRole('button', { name: 'Pop out Add mail account' }).click()
    const setupPopout = await setupPopoutPromise
    trackRuntimeErrors(setupPopout)
    const poppedSetup = setupPopout.getByRole('dialog', { name: 'Add mail account' })
    await poppedSetup.waitFor()
    await poppedSetup.getByRole('button', { name: /Apple iCloud Mail/ }).click()
    const setupPopoutClosed = setupPopout.waitForEvent('close')
    await poppedSetup.getByRole('button', { name: 'Return Add mail account to main window' }).click()
    await setupPopoutClosed
    await setup.waitFor()
    await dialog('Add mail account').getByRole('button', { name: 'Back to providers' }).click()
    await closeDialog('Add mail account')
    await page.keyboard.press('Control+N')
    await dialog('Add mail account').waitFor()
    await closeDialog('Add mail account')
  })

  await step('maximize, restore, minimize, and close-to-tray window buttons work', async () => {
    const browserWindow = await application.browserWindow(page)
    await page.getByRole('button', { name: 'Maximize' }).click()
    await page.getByRole('button', { name: 'Restore' }).waitFor()
    await page.getByRole('button', { name: 'Restore' }).click()
    await page.getByRole('button', { name: 'Minimize' }).click()
    await browserWindow.evaluate((window, visible) => {
      window.restore()
      if (visible) window.show()
    }, desktopAuditVisible)
    await page.getByRole('button', { name: 'Close' }).first().click()
    assert.equal(await browserWindow.evaluate((window) => window.isVisible()), false)
  })

  assert.deepEqual(runtimeErrors, [], `Renderer errors: ${runtimeErrors.join('\n')}`)
  console.log('Desktop button audit passed.')
} finally {
  if (application) await application.close().catch(() => undefined)
  rmSync(profile, { recursive: true, force: true })
}
