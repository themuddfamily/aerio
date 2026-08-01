import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import { _electron as electron } from 'playwright-core'
import { MailDatabase } from '../electron/mail/database.ts'
import { ProductivityStore } from '../electron/productivity/store.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const profile = mkdtempSync(join(tmpdir(), 'aerio-context-menu-audit-'))
const runtimeErrors = []
let application

function seedRealMailFixture() {
  const database = new MailDatabase(join(profile, 'aerio.sqlite'), join(profile, 'mail'))
  const rawPath = join(profile, 'context-message-1.eml')
  writeFileSync(rawPath, 'From: Aerio Test Pilot <pilot@aerio.local>\r\nTo: audit@aerio.local\r\nSubject: Real mail context audit\r\n\r\nContext audit body')
  database.upsertAccount({
    id: 'context-audit-account',
    provider: 'gmail',
    email: 'audit@aerio.local',
    displayName: 'Aerio Audit',
    color: '#1d7a62',
    status: 'needs-auth',
    archived: false,
    signature: '',
    notifications: true,
    syncEnabled: true
  })
  database.replaceLabels('context-audit-account', [
    { accountId: 'context-audit-account', id: 'RELEASE', name: 'Release', type: 'user', color: '#1d7a62' }
  ])
  database.addInventory('context-audit-account', [{ id: 'context-message-1', threadId: 'context-thread-1' }])
  database.upsertMessage({
    accountId: 'context-audit-account',
    id: 'context-message-1',
    threadId: 'context-thread-1',
    historyId: '100',
    internalDate: '2026-07-31T09:30:00.000Z',
    fromName: 'Aerio Test Pilot',
    fromEmail: 'pilot@aerio.local',
    to: ['audit@aerio.local'],
    cc: [],
    subject: 'Real mail context audit',
    messageIdHeader: '<context-message-1@aerio.local>',
    references: [],
    snippet: 'This local message exercises the production mail workspace.',
    text: 'This local message exercises the production mail workspace without contacting an email provider.',
    html: '<p>This local message exercises the <strong>production mail workspace</strong> without contacting an email provider.</p>',
    labelIds: ['INBOX', 'STARRED', 'IMPORTANT', 'RELEASE'],
    sizeEstimate: 2048,
    rawPath,
    attachments: [{
      id: 'context-attachment-1',
      messageId: 'context-message-1',
      filename: 'aerio-context-audit.txt',
      mimeType: 'text/plain',
      size: 128
    }]
  })
  database.saveDraft({
    id: 'context-draft-1',
    accountId: 'context-audit-account',
    to: ['reader@aerio.local'],
    cc: [],
    bcc: [],
    subject: 'Editable real mail draft',
    text: 'This draft should reopen without contacting the provider.',
    html: '<p>This draft should <strong>reopen</strong> without contacting the provider.</p>',
    attachmentPaths: []
  }, { status: 'synced' })
  database.close()

  const productivity = new ProductivityStore(join(profile, 'productivity.sqlite'))
  productivity.replaceAccount('context-audit-account', 'gmail', {
    calendars: [{ id: 'context-calendar', remoteId: 'primary', accountId: 'context-audit-account', provider: 'gmail', name: 'Audit calendar', color: '#1d7a62', primary: true, canWrite: true }],
    events: [{
      id: 'context-event', remoteId: 'remote-event', accountId: 'context-audit-account', provider: 'gmail', readOnly: true,
      calendarId: 'context-calendar', title: 'Connected calendar review', start: '2026-08-01T10:00:00.000Z', end: '2026-08-01T11:00:00.000Z',
      color: '#1d7a62', attendees: ['pilot@aerio.local'], reminderMinutes: 30, recurrence: 'none'
    }],
    contacts: [{
      id: 'context-contact', remoteId: 'people/context', accountId: 'context-audit-account', provider: 'gmail', readOnly: true,
      name: 'Connected Contact', email: 'contact@aerio.local', phone: '+44 20 0000 0000', group: 'Google', favorite: false, color: '#1d7a62'
    }]
  })
  productivity.close()
}

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
  seedRealMailFixture()
  application = await electron.launch({
    executablePath: electronPath,
    args: [root, `--user-data-dir=${profile}`],
    cwd: root,
    env: { ...process.env, NODE_ENV: 'test' }
  })
  const page = await application.firstWindow()
  const trackRuntimeErrors = (target) => {
    target.on('pageerror', (error) => runtimeErrors.push(error.message))
    target.on('console', (message) => { if (message.type() === 'error') runtimeErrors.push(message.text()) })
  }
  trackRuntimeErrors(page)
  await page.waitForSelector('.app')

  const modeSwitch = page.locator('.mode-switch')
  if ((await modeSwitch.innerText()).includes('Connected workspace')) {
    await modeSwitch.click()
    await page.getByText('Demo workspace', { exact: true }).waitFor()
  }

  const popup = page.locator('.context-menu')
  const moduleButton = (name) => page.locator('.module-rail').getByRole('button', { name })
  const menuItem = (label) => popup.getByText(label, { exact: true })
  const openMenu = async (target) => {
    await target.click({ button: 'right' })
    await popup.waitFor()
  }
  const dismiss = async () => {
    await page.keyboard.press('Escape')
    await popup.waitFor({ state: 'hidden' })
  }
  const expectItems = async (...labels) => {
    for (const label of labels) await menuItem(label).waitFor()
  }

  await step('window and module chrome expose keyboard-accessible context menus', async () => {
    await openMenu(page.locator('.titlebar-drag'))
    await expectItems('Minimize', 'Maximize', 'Close')
    assert.equal(await popup.getAttribute('role'), 'menu')
    assert.equal(await popup.locator('button').first().evaluate((button) => button === document.activeElement), true)
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Escape')
    await popup.waitFor({ state: 'hidden' })

    await openMenu(moduleButton('Mail'))
    await expectItems('Open Mail', 'New message', 'Search Mail', 'Open on startup')
    const bounds = await popup.boundingBox()
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
    assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width + 1 && bounds.y + bounds.height <= viewport.height + 1)
    await dismiss()

    await moduleButton('Mail').focus()
    await page.keyboard.press('Shift+F10')
    await popup.waitFor()
    await expectItems('Open Mail', 'New message')
    await dismiss()
  })

  await step('editable controls provide the expected desktop editing menu', async () => {
    await page.keyboard.press('Control+K')
    const input = page.getByPlaceholder('Search Aerio…')
    await input.fill('context menu text')
    await input.press('Control+A')
    await openMenu(input)
    await expectItems('Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Delete', 'Select all')
    await dismiss()
    await page.keyboard.press('Escape')
  })

  await step('links, images, and selected text receive content-aware menus', async () => {
    await page.evaluate(() => {
      const fixture = document.createElement('div')
      fixture.id = 'context-content-fixture'
      fixture.innerHTML = '<a href="https://example.com/context">Example link</a><img alt="Example image" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="><p>Selectable context text</p>'
      document.body.append(fixture)
    })
    await openMenu(page.locator('#context-content-fixture a'))
    const linkMenu = await popup.innerText()
    assert.match(linkMenu, /Open link/, `Unexpected link menu: ${linkMenu}`)
    await expectItems('Copy link')
    await dismiss()
    await openMenu(page.locator('#context-content-fixture img'))
    await expectItems('Open image', 'Copy image address', 'Copy alt text')
    await dismiss()
    await page.locator('#context-content-fixture p').selectText()
    await openMenu(page.locator('#context-content-fixture p'))
    await expectItems('Copy')
    await dismiss()
    await page.evaluate(() => document.querySelector('#context-content-fixture')?.remove())
  })

  await step('demo mail menus cover folders, accounts, messages, forwarding, and attachments', async () => {
    await moduleButton('Mail').click()
    await openMenu(page.getByRole('button', { name: /Unified inbox/ }))
    await expectItems('Open Unified inbox', 'New message')
    assert.match(await popup.innerText(), /Mark all as read/)
    await dismiss()

    await openMenu(page.locator('.account-heading').first())
    assert.match(await popup.innerText(), /folders/)
    await expectItems('Copy email address')
    await dismiss()

    await page.getByRole('button', { name: 'New message' }).click()
    const compose = page.getByRole('dialog', { name: 'New message' })
    await compose.getByPlaceholder('name@example.com').fill('draft@example.com')
    await compose.getByPlaceholder('What’s this about?').fill('Context menu draft')
    await compose.getByRole('button', { name: 'Save draft' }).click()
    await page.locator('.context-sidebar .sidebar-item').filter({ hasText: 'Drafts' }).first().click()
    const draft = page.locator('.message-row').filter({ hasText: 'Context menu draft' })
    await openMenu(draft)
    await expectItems('Edit draft', 'Duplicate draft', 'Copy subject', 'Move to Trash')
    await menuItem('Edit draft').click()
    await page.getByRole('dialog', { name: 'Edit draft' }).waitFor()
    await page.getByRole('dialog', { name: 'Edit draft' }).getByRole('button', { name: 'Close' }).click()
    await page.getByRole('button', { name: /Unified inbox/ }).click()

    const message = page.locator('.message-row').filter({ hasText: 'The new identity feels exactly right' })
    await openMenu(message)
    await expectItems('Open in new window', 'Reply', 'Reply all', 'Forward', 'Remove star', 'Flag message', 'Archive', 'Move to Trash', 'Add to Tasks', 'Add to Calendar', 'Copy subject')
    await menuItem('Forward').click()
    await page.getByRole('dialog', { name: 'Forward' }).waitFor()
    await page.getByRole('dialog', { name: 'Forward' }).getByRole('button', { name: 'Close' }).click()

    await message.click()
    const attachment = page.locator('.reader-panel .attachment-card').first()
    await openMenu(attachment)
    await expectItems('Show attachment details', 'Copy filename')
    await dismiss()
  })

  await step('calendar menus cover calendars, dates, and event operations', async () => {
    await moduleButton('Calendar').click()
    await openMenu(page.locator('.calendar-toggle').first())
    await expectItems('Hide calendar', 'Show only this calendar', 'Show all calendars', 'Copy calendar address')
    assert.match(await popup.innerText(), /New event in/)
    await dismiss()

    await openMenu(page.locator('.month-day').first())
    await expectItems('New event', 'Open day view', 'Copy date')
    await dismiss()

    const event = page.locator('.up-next-card button').first()
    await openMenu(event)
    await expectItems('Open event', 'Duplicate event', 'Copy event details', 'Delete event')
    await menuItem('Duplicate event').click()
    await page.getByRole('dialog', { name: 'Edit event' }).waitFor()
    await page.getByRole('dialog', { name: 'Edit event' }).getByRole('button', { name: 'Close' }).click()
  })

  await step('contact menus cover communication, editing, copying, and related mail', async () => {
    await moduleButton('Contacts').click()
    const contact = page.locator('.contact-row').filter({ hasText: 'Jon Bell' })
    await openMenu(contact)
    await expectItems('Email', 'Start chat', 'Edit contact', 'Add to favourites', 'Copy email address', 'Copy phone number', 'Delete contact')
    await menuItem('Add to favourites').click()
    await openMenu(contact)
    await expectItems('Remove from favourites')
    await dismiss()

    await openMenu(page.locator('.detail-card dl > div').first())
    await expectItems('Email contact', 'Copy email address')
    await dismiss()

    const related = page.locator('.related-message').first()
    await openMenu(related)
    await expectItems('Open message', 'Reply', 'Copy subject', 'Copy sender address')
    await dismiss()
  })

  await step('task menus cover completion, priorities, lists, duplication, and deletion', async () => {
    await moduleButton('Tasks').click()
    await openMenu(page.locator('.sidebar-item').filter({ hasText: 'Today' }).first())
    await expectItems('Open Today', 'New task in Today')
    assert.match(await popup.innerText(), /Complete all open tasks/)
    await dismiss()

    await openMenu(page.locator('.task-row').first())
    await expectItems('Edit task', 'Complete task', 'High priority', 'Normal priority', 'Low priority', 'Move to Today', 'Move to This week', 'Move to Someday', 'Duplicate task', 'Copy task title', 'Delete task')
    await menuItem('Duplicate task').click()
    await page.getByText('Task duplicated').waitFor()
  })

  await step('note menus cover library, tags, pinning, archive, copying, and duplication', async () => {
    await moduleButton('Notes').click()
    await openMenu(page.locator('.sidebar-item').filter({ hasText: 'Studio' }).first())
    await expectItems('Open Studio', 'New note in Studio')
    await dismiss()

    await openMenu(page.locator('.sidebar-group').filter({ hasText: 'Tags' }).locator('.sidebar-item').first())
    assert.match(await popup.innerText(), /Show #|New note tagged #/)
    await expectItems('Copy tag')
    await dismiss()

    await openMenu(page.locator('.note-card').first())
    await expectItems('Open note', 'Unpin note', 'Archive note', 'Duplicate note', 'Copy note text', 'Delete note')
    await menuItem('Duplicate note').click()
    await page.getByText('Note duplicated').waitFor()
  })

  await step('chat menus cover conversations, mute/search state, messages, reactions, and files', async () => {
    await moduleButton('Chat').click()
    const conversation = page.locator('.chat-list-item').filter({ hasText: 'Maya Chen' })
    await openMenu(conversation)
    await expectItems('Open conversation', 'Mark as read', 'Mute conversation', 'Search conversation', 'Copy contact name', 'Delete conversation')
    await menuItem('Mute conversation').click()
    await openMenu(conversation)
    await expectItems('Unmute conversation')
    await dismiss()

    const chatMessage = page.locator('.chat-bubble-row').first()
    await openMenu(chatMessage)
    await expectItems('Copy message', '👍 React', '❤️ React', '😂 React', '🎉 React')
    await menuItem('👍 React').click()
    await openMenu(chatMessage)
    assert.equal(await popup.getByText('👍 React', { exact: true }).locator('..').getAttribute('aria-checked'), 'true')
    await dismiss()
    const infoPanel = page.locator('.chat-info-panel')
    if (!(await infoPanel.isVisible())) await page.getByRole('button', { name: 'Conversation details' }).click()
    await openMenu(infoPanel.locator('.info-person').first())
    await expectItems('Copy participant name')
    await dismiss()
  })

  await step('real mail menus cover accounts, folders, labels, conversations, messages, and attachments', async () => {
    await modeSwitch.click()
    await page.locator('.real-mail').waitFor()
    const productivitySnapshot = await page.evaluate(() => window.aerio.productivity.snapshot())
    assert.equal(productivitySnapshot.events.length, 1, `Unexpected productivity snapshot: ${JSON.stringify(productivitySnapshot)}`)

    await moduleButton('Calendar').click()
    await page.waitForTimeout(200)
    assert.match(await page.locator('.module-content').innerText(), /Connected calendar review/, `Connected Calendar did not render. Snapshot: ${JSON.stringify(productivitySnapshot)}`)
    await page.getByRole('button', { name: 'Connected calendar review' }).click()
    const eventDetails = page.getByRole('dialog', { name: 'Event details' })
    await eventDetails.waitFor()
    assert.equal(await eventDetails.getByLabel('Event title').isDisabled(), true)
    await eventDetails.getByRole('button', { name: 'Close' }).last().click()
    await page.getByRole('button', { name: 'Sync now' }).waitFor()

    await moduleButton('Contacts').click()
    await page.getByText('Connected Contact', { exact: true }).first().waitFor()
    assert.equal(await page.getByRole('button', { name: 'New contact' }).count(), 0)

    await moduleButton('Mail').click()
    await page.locator('.real-mail').waitFor()

    await openMenu(page.locator('.real-mail .context-sidebar .sidebar-item').filter({ hasText: 'Inbox' }).first())
    await expectItems('Open Inbox', 'New message', 'Check for mail')
    await dismiss()

    const realAccount = page.locator('.gmail-account-row').filter({ hasText: 'audit@aerio.local' })
    await openMenu(realAccount)
    await expectItems('Open audit@aerio.local', 'New message', 'Check for mail', 'Offline storage', 'Account settings…', 'Copy email address', 'Disconnect account…')
    await menuItem('Account settings…').click()
    const accountSettings = page.getByRole('dialog', { name: 'Mail account settings' })
    await accountSettings.waitFor()
    await accountSettings.getByLabel('Display name').fill('Aerio Audit Updated')
    await accountSettings.getByRole('button', { name: 'Save changes' }).click()
    await accountSettings.waitFor({ state: 'hidden' })

    await openMenu(page.locator('.real-mail .sidebar-item').filter({ hasText: 'Release' }))
    await expectItems('Open Release', 'New message', 'Check account for mail')
    await dismiss()

    const realMessage = page.locator('.real-mail .message-row').filter({ hasText: 'Real mail context audit' })
    await realMessage.waitFor()
    await realMessage.getByRole('checkbox', { name: 'Select Real mail context audit' }).click()
    const bulkToolbar = page.locator('.bulk-mail-toolbar')
    await bulkToolbar.getByText('1 selected', { exact: true }).waitFor()
    await bulkToolbar.getByRole('button', { name: 'Move' }).click()
    const moveDialog = page.getByRole('dialog', { name: 'Move conversations' })
    await moveDialog.waitFor()
    await moveDialog.getByRole('button', { name: 'Cancel' }).click()
    await bulkToolbar.getByRole('button', { name: 'Labels' }).click()
    const labelsDialog = page.getByRole('dialog', { name: 'Manage labels' })
    await labelsDialog.waitFor()
    await labelsDialog.getByRole('button', { name: 'Cancel' }).click()
    await bulkToolbar.getByRole('button', { name: 'Clear selection' }).click()
    await bulkToolbar.waitFor({ state: 'hidden' })
    const realWindowPromise = application.waitForEvent('window')
    await realMessage.dblclick()
    const realWindow = await realWindowPromise
    trackRuntimeErrors(realWindow)
    await realWindow.locator('.message-window-shell').waitFor()
    await realWindow.getByRole('heading', { name: 'Real mail context audit' }).waitFor()
    await realWindow.getByText('aerio-context-audit.txt').waitFor()
    const realWindowClosed = realWindow.waitForEvent('close')
    await realWindow.getByRole('button', { name: 'Close' }).click()
    await realWindowClosed

    await openMenu(realMessage)
    await expectItems('Open conversation', 'Open in new window', 'Reply', 'Forward', 'Mark as unread', 'Remove star', 'Mark as not important', 'Archive', 'Move to Trash', 'Copy subject', 'Copy participants')
    await menuItem('Forward').click()
    const realCompose = page.getByRole('dialog', { name: 'Compose mail message' })
    await realCompose.waitFor()
    await realCompose.getByRole('heading', { name: 'Forward' }).waitFor()
    await realCompose.getByRole('button', { name: 'Close' }).click()

    await page.locator('.gmail-message').filter({ hasText: 'Aerio Test Pilot' }).waitFor()
    await openMenu(page.locator('.gmail-message').filter({ hasText: 'Aerio Test Pilot' }))
    await expectItems('Reply', 'Forward', 'Copy sender name', 'Copy sender address', 'Copy message text')
    await dismiss()

    await openMenu(page.locator('.real-mail .attachment-card').filter({ hasText: 'aerio-context-audit.txt' }))
    await expectItems('Open attachment', 'Save as…', 'Copy filename')
    await dismiss()

    await page.locator('.real-mail .context-sidebar .sidebar-item').filter({ hasText: 'Drafts' }).first().click()
    const savedDraft = page.locator('.real-mail .local-draft-row').filter({ hasText: 'Editable real mail draft' })
    await savedDraft.waitFor()
    await savedDraft.dblclick()
    const editDraft = page.getByRole('dialog', { name: 'Compose mail message' })
    await editDraft.getByRole('heading', { name: 'Edit draft' }).waitFor()
    assert.equal(await editDraft.getByPlaceholder('name@example.com').inputValue(), 'reader@aerio.local')
    await editDraft.getByRole('button', { name: 'Close' }).click()
    await editDraft.waitFor({ state: 'hidden' })
    await page.locator('.real-mail .context-sidebar .sidebar-item').filter({ hasText: 'Inbox' }).first().click()
  })

  await step('workspace and theme controls expose direct choices', async () => {
    await openMenu(modeSwitch)
    await expectItems('Demo workspace', 'Connected workspace', 'Sync Calendar and Contacts', 'New message')
    await dismiss()

    await openMenu(page.getByRole('button', { name: 'Settings' }))
    await expectItems('Open settings')
    assert.doesNotMatch(await popup.innerText(), /Open profile/)
    await dismiss()

    await page.getByRole('button', { name: 'Settings' }).click()
    const settings = page.getByRole('dialog', { name: 'Aerio settings' })
    await settings.getByRole('button', { name: 'Check mail storage' }).click()
    await settings.getByText('Mail storage is healthy.').waitFor()
    await settings.getByRole('button', { name: 'Close' }).click()

    await openMenu(page.getByRole('button', { name: /Profile:/ }))
    await expectItems('Open profile')
    assert.doesNotMatch(await popup.innerText(), /Open settings/)
    await dismiss()

    await openMenu(page.locator('.theme-quick'))
    await expectItems('System theme', 'Light theme', 'Dark theme')
    const bounds = await popup.boundingBox()
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
    assert.ok(bounds && bounds.x + bounds.width <= viewport.width + 1 && bounds.y + bounds.height <= viewport.height + 1)
    await dismiss()
  })

  assert.deepEqual(runtimeErrors, [], `Renderer errors: ${runtimeErrors.join(' | ')}`)
  console.log('Desktop context-menu audit passed.')
} finally {
  if (application) await application.close().catch(() => undefined)
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
