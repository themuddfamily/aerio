import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import { _electron as electron } from 'playwright-core'

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
    env: { ...process.env, NODE_ENV: 'test' }
  })
  const page = await application.firstWindow()
  page.on('pageerror', (error) => runtimeErrors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') runtimeErrors.push(message.text()) })
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

  await step('profile button opens settings and theme controls apply', async () => {
    await page.getByRole('button', { name: 'Profile and settings' }).click()
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

  await step('demo mail account sections, attachments, reply-all, and drafts work', async () => {
    await moduleButton('Mail').click()
    await assertAccessibleButtons()
    const account = page.getByRole('button', { name: /Personal/ }).filter({ has: page.locator('.account-dot') }).first()
    await account.click()
    assert.equal(await account.getAttribute('aria-expanded'), 'false')
    await account.click()
    assert.equal(await account.getAttribute('aria-expanded'), 'true')
    await page.getByRole('button', { name: /Aperture_Final_Review.pdf/ }).click()
    await page.getByText(/sample metadata/).waitFor()
    await page.getByRole('button', { name: 'Reply all' }).click()
    assert.match(await dialog('Reply').locator('.compose-row').filter({ hasText: 'To' }).locator('input').inputValue(), /maya@northstar\.design/)
    await closeDialog('Reply')
    await page.getByRole('button', { name: 'New message' }).click()
    await dialog('New message').locator('.compose-row').filter({ hasText: 'To' }).locator('input').fill('person@example.com')
    await dialog('New message').locator('.compose-row').filter({ hasText: 'Subject' }).locator('input').fill('Button audit draft')
    await dialog('New message').getByPlaceholder('Write a message…').fill('Draft body')
    await dialog('New message').getByRole('button', { name: 'Save draft' }).click()
    await page.getByText('Draft saved').waitFor()
  })

  await step('calendar editor validates and saves', async () => {
    await moduleButton('Calendar').click()
    await assertAccessibleButtons()
    await page.getByRole('button', { name: 'New event' }).click()
    const editor = dialog('New event')
    assert.equal(await editor.getByRole('button', { name: 'Save event' }).isDisabled(), true)
    await editor.getByPlaceholder('Add a title').fill('Interaction audit')
    await editor.getByRole('button', { name: 'Save event' }).click()
    await page.getByText('Event created').waitFor()
  })

  await step('contact related mail opens and contact chat navigates', async () => {
    await moduleButton('Contacts').click()
    await assertAccessibleButtons()
    await page.getByRole('button', { name: /The new identity feels exactly right/ }).click()
    await page.getByRole('heading', { name: 'The new identity feels exactly right' }).waitFor()
    await moduleButton('Contacts').click()
    await page.getByRole('main').getByRole('button', { name: 'Chat', exact: true }).click()
    await page.locator('.chat-header').getByText('Maya Chen', { exact: true }).waitFor()
  })

  await step('chat new conversation, emoji, send, search, and mute controls work', async () => {
    await page.getByRole('button', { name: 'New conversation' }).click()
    await dialog('New conversation').getByRole('button', { name: /Elliot Reed/ }).click()
    await page.locator('.chat-header').getByText('Elliot Reed', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Choose emoji' }).click()
    await page.getByRole('button', { name: '🎉' }).click()
    const composer = page.locator('.chat-composer input')
    assert.match(await composer.inputValue(), /🎉/)
    await composer.fill('Hello from the audit')
    await assertAccessibleButtons()
    await page.locator('.chat-composer').getByRole('button', { name: 'Send message' }).click()
    await page.getByRole('paragraph').filter({ hasText: 'Hello from the audit' }).waitFor()
    await page.locator('.chat-info-panel').getByRole('button', { name: 'Search' }).click()
    await page.getByPlaceholder(/Search Elliot Reed/).fill('Hello')
    await page.getByRole('button', { name: 'Done' }).click()
    const mute = page.locator('.chat-info-panel').getByRole('button', { name: 'Mute' })
    await mute.click()
    await page.getByText('Conversation muted').waitFor()
    await page.locator('.chat-info-panel').getByRole('button', { name: 'Unmute' }).click()
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
    await page.getByRole('button', { name: 'reading', exact: true }).click()
    await page.getByRole('heading', { name: '#reading' }).waitFor()
    await page.getByRole('button', { name: 'Grid view' }).click()
    await page.getByRole('button', { name: 'New note' }).click()
    await page.getByTitle('Archive').click()
    await page.getByText('Note archived').waitFor()
  })

  await step('real-mail onboarding and Ctrl+N account setup work without credentials', async () => {
    await moduleButton('Mail').click()
    const mode = page.locator('.mode-switch')
    if ((await mode.innerText()).includes('Demo')) await mode.click()
    await page.getByRole('button', { name: 'Add your first account' }).click()
    const setup = dialog('Add mail account')
    await setup.getByRole('button', { name: /Apple iCloud Mail/ }).click()
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
    await browserWindow.evaluate((window) => { window.restore(); window.show() })
    await page.getByRole('button', { name: 'Close' }).first().click()
    assert.equal(await browserWindow.evaluate((window) => window.isVisible()), false)
  })

  assert.deepEqual(runtimeErrors, [], `Renderer errors: ${runtimeErrors.join('\n')}`)
  console.log('Desktop button audit passed.')
} finally {
  if (application) await application.close().catch(() => undefined)
  rmSync(profile, { recursive: true, force: true })
}
