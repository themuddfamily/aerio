// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextMenuProvider } from './components/ContextMenu'
import type { AppPreferences, CalendarEvent } from './types'
import type { LocalModuleSnapshot, ProductivitySnapshot } from './productivity-types'
import App from './App'

vi.mock('./components/TitleBar', () => ({ default: () => <div data-testid="title-bar" /> }))
vi.mock('./components/SettingsModal', () => ({ default: (props: any) => <div role="dialog" aria-label="Settings mock"><button onClick={() => props.onChange({ ...props.preferences, settings: { ...props.preferences.settings, density: 'compact' } })}>Change density</button><button onClick={props.onClose}>Close settings</button></div> }))
vi.mock('./components/ProfileModal', () => ({ default: (props: any) => <div role="dialog" aria-label="Profile mock"><span>{props.profile.displayName}</span><button onClick={() => props.onSave({ displayName: 'Saved Person', email: 'saved@example.test' })}>Save profile</button><button onClick={props.onClose}>Close profile</button></div> }))
vi.mock('./views/ConnectedMailView', () => ({ default: (props: any) => <section aria-label="Mail mock"><span>Compose {props.composeRequest.id}:{props.composeRequest.initialTo ?? ''}</span><button onClick={() => props.onToast('Mail says hello')}>Mail toast</button></section> }))
vi.mock('./views/CalendarView', () => ({ default: (props: any) => <section aria-label="Calendar mock"><span>Calendar query:{props.query}</span><span>{props.sourceMessage}</span><span>Writable:{[...props.writableCalendarIds].join(',')}</span><button onClick={() => void props.onSync()}>Sync calendar</button><button onClick={() => void props.onEnableEditing()}>Enable editing</button><button onClick={() => void props.onSaveProviderEvent(providerEvent, false)}>Create provider event</button><button onClick={() => void props.onSaveProviderEvent(providerEvent, true)}>Update provider event</button><button onClick={() => void props.onDeleteProviderEvent(providerEvent)}>Delete provider event</button></section> }))
vi.mock('./views/ContactsView', () => ({ default: (props: any) => <section aria-label="Contacts mock"><span>Contacts query:{props.query}</span><button onClick={() => props.onCompose('ada@example.test')}>Email Ada</button><button onClick={() => void props.onSync()}>Sync contacts</button><button onClick={() => void props.onEnableEditing()}>Enable contact editing</button><button onClick={() => void props.onSaveProviderContact(props.providerAccounts[0].id, productivity.contacts[0], false)}>Create provider contact</button><button onClick={() => void props.onSaveProviderContact(props.providerAccounts[0].id, productivity.contacts[0], true)}>Update provider contact</button><button onClick={() => void props.onDeleteProviderContact(productivity.contacts[0].id)}>Delete provider contact</button></section> }))
vi.mock('./views/TasksView', () => ({ default: (props: any) => <section aria-label="Tasks mock"><button onClick={() => props.onChange({ ...props.state, tasks: [...props.state.tasks, { id: 'task-2', listId: 'inbox', title: 'Added task', priority: 'normal', completed: false, subtasks: [] }] })}>Change tasks</button><button onClick={() => props.onToast('Task toast')}>Task toast</button></section> }))
vi.mock('./views/NotesView', () => ({ default: (props: any) => <section aria-label="Notes mock"><button onClick={() => props.onChange({ ...props.state, notes: [...props.state.notes, { id: 'note-2', folder: 'Notes', title: 'Added note', content: '', tags: [], pinned: false, archived: false, updatedAt: '2026-08-08T10:00:00Z' }] })}>Change notes</button></section> }))

const preferences: AppPreferences = {
  schemaVersion: 1,
  settings: { theme: 'dark', density: 'comfortable', closeToTray: true, notifications: true, startModule: 'mail' }
}
const providerEvent: CalendarEvent = {
  id: 'event-1', calendarId: 'calendar-1', title: 'Planning', start: '2026-08-08T10:00:00Z', end: '2026-08-08T11:00:00Z', color: '#6558e8', attendees: [], reminderMinutes: 10
}
const productivity: ProductivitySnapshot = {
  calendars: [{ id: 'calendar-1', remoteId: 'remote-calendar', accountId: 'gmail', provider: 'gmail', name: 'Work Calendar', color: '#6558e8', primary: true, canWrite: true }],
  events: [{ ...providerEvent, remoteId: 'remote-event', accountId: 'gmail', provider: 'gmail', readOnly: false }],
  contacts: [{ id: 'contact-1', remoteId: 'remote-contact', accountId: 'gmail', provider: 'gmail', readOnly: true, name: 'Ada', email: 'ada@example.test', group: 'Work', favorite: true, color: '#6558e8' }],
  sync: [{ accountId: 'gmail', module: 'calendar', phase: 'ready', lastSyncedAt: '2026-08-08T09:00:00Z' }]
}
const localModules: LocalModuleSnapshot = {
  tasks: [{ id: 'task-1', listId: 'inbox', title: 'Existing task', priority: 'normal', completed: false, subtasks: [] }],
  notes: [{ id: 'note-1', folder: 'Notes', title: 'Existing note', content: '', tags: [], pinned: false, archived: false, updatedAt: '2026-08-08T09:00:00Z' }]
}
const gmailAccount = { id: 'gmail', provider: 'gmail', email: 'me@gmail.test', displayName: 'Google User', color: '#6558e8', status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true }
const microsoftAccount = { ...gmailAccount, id: 'microsoft', provider: 'microsoft', email: 'me@microsoft.test', displayName: 'Microsoft User' }
let composeCommand: (() => void) | undefined
let accountResults: any[]

const api = {
  loadPreferences: vi.fn(async () => preferences),
  savePreferences: vi.fn(async () => ({ savedAt: new Date().toISOString() })),
  onComposeCommand: vi.fn((callback: () => void) => { composeCommand = callback; return vi.fn() }),
  mail: { accounts: { list: vi.fn(async () => accountResults), reconnect: vi.fn(async () => gmailAccount) } },
  productivity: {
    snapshot: vi.fn(async () => productivity),
    sync: vi.fn(async (_accountId: string) => productivity),
    createEvent: vi.fn(async () => productivity),
    updateEvent: vi.fn(async () => productivity),
    deleteEvent: vi.fn(async () => productivity),
    createContact: vi.fn(async (_accountId: string, contact: any) => ({ contact, snapshot: productivity })),
    updateContact: vi.fn(async (contact: any) => ({ contact, snapshot: productivity })),
    deleteContact: vi.fn(async () => productivity),
    chooseNoteAttachments: vi.fn(async () => []),
    openNoteAttachment: vi.fn(async () => ({})),
    localSnapshot: vi.fn(async () => localModules),
    saveLocal: vi.fn(async () => undefined)
  }
}

const renderApp = () => render(<ContextMenuProvider><App /></ContextMenuProvider>)

beforeEach(() => {
  vi.clearAllMocks()
  composeCommand = undefined
  accountResults = [gmailAccount, microsoftAccount]
  api.loadPreferences.mockResolvedValue(preferences)
  api.savePreferences.mockResolvedValue({ savedAt: new Date().toISOString() })
  api.mail.accounts.list.mockImplementation(async () => accountResults)
  api.mail.accounts.reconnect.mockResolvedValue(gmailAccount)
  api.productivity.snapshot.mockResolvedValue(productivity)
  api.productivity.sync.mockResolvedValue(productivity)
  api.productivity.createEvent.mockResolvedValue(productivity)
  api.productivity.updateEvent.mockResolvedValue(productivity)
  api.productivity.deleteEvent.mockResolvedValue(productivity)
  api.productivity.createContact.mockImplementation(async (_accountId: string, contact: any) => ({ contact, snapshot: productivity }))
  api.productivity.updateContact.mockImplementation(async (contact: any) => ({ contact, snapshot: productivity }))
  api.productivity.deleteContact.mockResolvedValue(productivity)
  api.productivity.localSnapshot.mockResolvedValue(localModules)
  api.productivity.saveLocal.mockResolvedValue(undefined)
  Object.defineProperty(window, 'aerio', { configurable: true, value: api })
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })) })
})

describe('App', () => {
  it('hydrates the shell, changes theme/settings/profile, navigates, and persists local modules', async () => {
    const user = userEvent.setup()
    renderApp()
    expect(screen.getByText('Bringing your day into focus…')).toBeInTheDocument()
    expect(await screen.findByRole('region', { name: 'Mail mock' })).toBeInTheDocument()
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'))
    expect(document.documentElement.dataset.density).toBe('comfortable')

    await user.click(screen.getByRole('button', { name: 'Toggle theme' }))
    expect(document.documentElement.dataset.theme).toBe('light')
    await waitFor(() => expect(api.savePreferences).toHaveBeenCalledWith(expect.objectContaining({ settings: expect.objectContaining({ theme: 'light' }) })), { timeout: 1200 })

    await user.click(screen.getByRole('button', { name: 'Settings' }))
    await user.click(screen.getByRole('button', { name: 'Change density' }))
    expect(document.documentElement.dataset.density).toBe('compact')
    await user.click(screen.getByRole('button', { name: 'Close settings' }))

    await user.click(screen.getByRole('button', { name: 'Profile: Google User' }))
    await user.click(screen.getByRole('button', { name: 'Save profile' }))
    expect(screen.getByRole('button', { name: 'Profile: Saved Person' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close profile' }))

    await user.click(screen.getByRole('button', { name: 'Tasks' }))
    await user.click(screen.getByRole('button', { name: 'Change tasks' }))
    await waitFor(() => expect(api.productivity.saveLocal).toHaveBeenCalledWith(expect.objectContaining({ tasks: expect.arrayContaining([expect.objectContaining({ id: 'task-2' })]) })), { timeout: 1200 })
    await user.click(screen.getByRole('button', { name: 'Notes' }))
    await user.click(screen.getByRole('button', { name: 'Change notes' }))
    await waitFor(() => expect(api.productivity.saveLocal).toHaveBeenCalledWith(expect.objectContaining({ notes: expect.arrayContaining([expect.objectContaining({ id: 'note-2' })]) })), { timeout: 1200 })

    await user.click(screen.getByRole('button', { name: 'What’s new' }))
    expect(screen.getByRole('dialog', { name: 'What’s new in Aerio' })).toBeInTheDocument()
  })

  it('supports command search, keyboard navigation, module shortcuts, compose commands, and context menus', async () => {
    const user = userEvent.setup()
    renderApp(); await screen.findByRole('region', { name: 'Mail mock' })

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    const palette = screen.getByRole('dialog', { name: 'Command palette' })
    await user.type(screen.getByPlaceholderText('Search Aerio…'), 'calendar')
    expect(screen.getByRole('button', { name: /Search Mail for “calendar”/ })).toBeInTheDocument()
    fireEvent.keyDown(screen.getByPlaceholderText('Search Aerio…'), { key: 'ArrowDown' })
    fireEvent.keyDown(screen.getByPlaceholderText('Search Aerio…'), { key: 'Enter' })
    expect(screen.getByRole('region', { name: 'Calendar mock' })).toBeInTheDocument()
    expect(palette).not.toBeInTheDocument()

    fireEvent.keyDown(window, { key: '3', ctrlKey: true })
    await user.click(screen.getByRole('button', { name: 'Email Ada' }))
    expect(screen.getByRole('region', { name: 'Mail mock' })).toHaveTextContent('Compose 1:ada@example.test')
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true })
    expect(screen.getByRole('region', { name: 'Mail mock' })).toHaveTextContent('Compose 2:')
    composeCommand?.()
    await waitFor(() => expect(screen.getByRole('region', { name: 'Mail mock' })).toHaveTextContent('Compose 3:'))

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Mail' }))
    await user.click(screen.getByRole('menuitem', { name: 'Search Mail' }))
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument()
  })

  it('synchronizes supported providers, exposes provider status, and writes calendar events', async () => {
    const user = userEvent.setup()
    renderApp(); await screen.findByRole('region', { name: 'Mail mock' })
    await user.click(screen.getByRole('button', { name: 'Calendar' }))
    expect(screen.getByText(/Last synchronized/)).toBeInTheDocument()
    expect(screen.getByText('Writable:calendar-1')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Sync calendar' }))
    await waitFor(() => expect(api.productivity.sync).toHaveBeenCalledWith('gmail'))
    expect(api.productivity.sync).toHaveBeenCalledWith('microsoft')
    expect(await screen.findByRole('status')).toHaveTextContent('Calendar and Contacts synchronized')

    await user.click(screen.getByRole('button', { name: 'Enable editing' }))
    await waitFor(() => expect(api.mail.accounts.reconnect).toHaveBeenCalledWith('gmail'))
    expect(screen.getByRole('status')).toHaveTextContent('Google Calendar editing enabled')

    await user.click(screen.getByRole('button', { name: 'Create provider event' }))
    await user.click(screen.getByRole('button', { name: 'Update provider event' }))
    await user.click(screen.getByRole('button', { name: 'Delete provider event' }))
    await waitFor(() => expect(api.productivity.createEvent).toHaveBeenCalledWith(providerEvent))
    expect(api.productivity.updateEvent).toHaveBeenCalledWith(providerEvent)
    expect(api.productivity.deleteEvent).toHaveBeenCalledWith('event-1')
  })

  it('reconnects provider Contacts and routes provider contact writes', async () => {
    const user = userEvent.setup()
    renderApp(); await screen.findByRole('region', { name: 'Mail mock' })
    await user.click(screen.getByRole('button', { name: 'Contacts' }))
    await user.click(screen.getByRole('button', { name: 'Enable contact editing' }))
    await waitFor(() => expect(api.mail.accounts.reconnect).toHaveBeenCalledWith('gmail'))
    expect(screen.getByRole('status')).toHaveTextContent('Google Contacts editing enabled')

    await user.click(screen.getByRole('button', { name: 'Create provider contact' }))
    await user.click(screen.getByRole('button', { name: 'Update provider contact' }))
    await user.click(screen.getByRole('button', { name: 'Delete provider contact' }))
    await waitFor(() => expect(api.productivity.createContact).toHaveBeenCalledWith('gmail', productivity.contacts[0]))
    expect(api.productivity.updateContact).toHaveBeenCalledWith(productivity.contacts[0])
    expect(api.productivity.deleteContact).toHaveBeenCalledWith('contact-1')
  })

  it('reports unsupported and partially failed provider synchronization and missing Google editing', async () => {
    const user = userEvent.setup()
    accountResults = [{ ...gmailAccount, id: 'imap', provider: 'imap', email: 'me@imap.test' }]
    renderApp(); await screen.findByRole('region', { name: 'Mail mock' })
    await user.click(screen.getByRole('button', { name: 'Connected services' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Connect Google or Microsoft')
    await user.click(screen.getByRole('button', { name: 'Calendar' }))
    await user.click(screen.getByRole('button', { name: 'Enable editing' }))
    expect(screen.getByRole('status')).toHaveTextContent('Connect Google or Microsoft')
  })

  it('reports partial provider failures while retaining the latest successful snapshot', async () => {
    const user = userEvent.setup()
    api.productivity.sync.mockImplementation(async (accountId: string) => {
      if (accountId === 'gmail') throw new Error('Google calendar unavailable')
      return productivity
    })
    renderApp(); await screen.findByRole('region', { name: 'Mail mock' })
    await user.click(screen.getByRole('button', { name: 'Connected services' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Some provider data could not synchronize: Google calendar unavailable')
    expect(api.productivity.snapshot).toHaveBeenCalledTimes(3)
  })

  it('surfaces preference and local-module persistence failures', async () => {
    const user = userEvent.setup()
    api.savePreferences.mockRejectedValueOnce(new Error('preferences unavailable'))
    renderApp(); await screen.findByRole('region', { name: 'Mail mock' })
    await user.click(screen.getByRole('button', { name: 'Toggle theme' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Preferences could not be saved'), { timeout: 1200 })
    api.productivity.saveLocal.mockRejectedValueOnce(new Error('local storage unavailable'))
    await user.click(screen.getByRole('button', { name: 'Tasks' }))
    await user.click(screen.getByRole('button', { name: 'Change tasks' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Local Tasks or Notes could not be saved'), { timeout: 1200 })
  })

  it('executes shell context menus and applies the system theme', async () => {
    const user = userEvent.setup()
    renderApp(); await screen.findByRole('region', { name: 'Mail mock' })

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Settings' }))
    await user.click(screen.getByRole('menuitem', { name: 'Open settings' }))
    expect(screen.getByRole('dialog', { name: 'Settings mock' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close settings' }))

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Profile: Google User' }))
    await user.click(screen.getByRole('menuitem', { name: 'Open profile' }))
    expect(screen.getByRole('dialog', { name: 'Profile mock' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close profile' }))

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Toggle theme' }))
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'System theme' }))
    expect(document.documentElement.dataset.theme).toBe('dark')

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Calendar' }))
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Open on startup' }))
    await waitFor(() => expect(api.savePreferences).toHaveBeenCalledWith(expect.objectContaining({ settings: expect.objectContaining({ startModule: 'calendar' }) })), { timeout: 1200 })

    fireEvent.contextMenu(screen.getByRole('button', { name: /Search mail or run a command/ }))
    await user.click(screen.getByRole('menuitem', { name: 'Search and commands' }))
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument()
    fireEvent.mouseDown(document.querySelector('.command-backdrop')!)
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument()
  })

  it('surfaces hydration and save failures while tolerating an unavailable provider snapshot', async () => {
    api.mail.accounts.list.mockRejectedValueOnce(new Error('accounts unavailable'))
    api.productivity.snapshot.mockRejectedValueOnce(new Error('snapshot unavailable'))
    api.productivity.localSnapshot.mockRejectedValueOnce(new Error('local unavailable'))
    renderApp()
    expect(await screen.findByRole('region', { name: 'Mail mock' })).toBeInTheDocument()
    expect(await screen.findByRole('status')).toHaveTextContent(/Mail accounts could not be loaded|Local Tasks and Notes could not be opened/)
  })

  it('renders light system appearance, avatar and badge fallbacks, provider errors, and the v1 module rail', async () => {
    api.loadPreferences.mockResolvedValueOnce({ ...preferences, settings: { ...preferences.settings, theme: 'system', profile: { displayName: ' ', avatarDataUrl: 'data:image/png;base64,AA==' } } })
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })) })
    api.productivity.snapshot.mockResolvedValueOnce({ ...productivity, sync: [{ accountId: 'gmail', module: 'calendar', phase: 'error' }] })
    api.productivity.localSnapshot.mockResolvedValueOnce({
      ...localModules,
      tasks: Array.from({ length: 10 }, (_, index) => ({ id: `overdue-${index}`, listId: 'Today', title: `Overdue ${index}`, due: '2020-01-01T00:00:00Z', priority: 'normal' as const, completed: false, subtasks: [] }))
    })
    const user = userEvent.setup()
    renderApp(); await screen.findByRole('region', { name: 'Mail mock' })
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(screen.getByRole('button', { name: /Profile:/ }).querySelector('img')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Tasks' })).toHaveTextContent('9+')
    await user.click(screen.getByRole('button', { name: 'Calendar' }))
    expect(screen.getByText('A provider needs attention.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Chat' })).not.toBeInTheDocument()
  })

  it('uses non-Error provider fallbacks and preserves command-search queries', async () => {
    api.productivity.sync.mockRejectedValueOnce('offline')
    const user = userEvent.setup()
    renderApp(); await screen.findByRole('region', { name: 'Mail mock' })
    await user.click(screen.getByRole('button', { name: 'Connected services' }))
    expect(await screen.findByRole('status')).toHaveTextContent('me@gmail.test could not synchronize')

    api.mail.accounts.reconnect.mockRejectedValueOnce('offline')
    await user.click(screen.getByRole('button', { name: 'Calendar' }))
    await user.click(screen.getByRole('button', { name: 'Enable editing' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Calendar editing could not be enabled')

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    const search = screen.getByPlaceholderText('Search Aerio…')
    await user.type(search, 'planning')
    fireEvent.keyDown(search, { key: 'ArrowUp' })
    await user.click(screen.getByRole('button', { name: /Search Calendar for “planning”/ }))
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(screen.getByPlaceholderText('Search Aerio…')).toHaveValue('planning')
  })
})
