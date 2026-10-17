// @vitest-environment jsdom

import { configure, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MailAccountSummary } from '../mail-types'
import type { DirectoryEntry, DirectorySearchRequest, DirectorySearchResult, DirectorySnapshot } from '../directory-types'
import type { AppState, Contact } from '../types'
import { ContextMenuProvider } from './ContextMenu'
import MailComposeModal from './MailComposeModal'
import ContactsView from '../views/ContactsView'
import SchedulingAssistant from './SchedulingAssistant'
import { formatAge } from './DirectoryPanel'
import { directoryEntryDetail, matchPersonalContacts } from './RecipientDirectory'

configure({ asyncUtilTimeout: 5_000 })

const accounts: MailAccountSummary[] = [{
  id: 'ex', provider: 'exchange', email: 'me@contoso.test', displayName: 'Me', color: '#123456', status: 'ready', archived: false,
  signature: '', notifications: true, syncEnabled: true
}]
const entry = (overrides: Partial<DirectoryEntry> & Pick<DirectoryEntry, 'name' | 'email'>): DirectoryEntry => ({
  id: `ex:${overrides.email}`, accountId: 'ex', backend: 'exchange-ews', kind: 'person', ...overrides
})
const people = [
  entry({ name: 'Alex Kim', email: 'akim@contoso.test', title: 'Engineer', department: 'Platform', ambiguous: true }),
  entry({ name: 'Alex Kim', email: 'alex.kim@contoso.test', title: 'Accountant', department: 'Finance', ambiguous: true }),
  entry({ name: 'All Finance', email: 'finance@contoso.test', kind: 'group', expandable: true }),
  entry({ name: 'Conference Room Alpha', email: 'room.alpha@contoso.test', kind: 'room', capacity: 10 })
]
const snapshot: DirectorySnapshot = {
  online: true,
  accounts: [{
    accountId: 'ex', email: 'me@contoso.test', provider: 'exchange', backend: 'exchange-ews', supported: true, consent: 'not-required', missingScopes: [], missingResourceScopes: [],
    capabilities: { people: true, groups: true, rooms: true, expandGroups: true, offline: true },
    cache: { mode: 'full', entries: 1234, lastSuccessAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(), lastAttemptAt: new Date().toISOString(), error: 'Exchange responded with HTTP 503', refreshing: false }
  }]
}
let source: DirectorySearchResult['source'] = 'online'
const directory = {
  snapshot: vi.fn(async () => snapshot),
  search: vi.fn(async (request: DirectorySearchRequest): Promise<DirectorySearchResult> => {
    const term = request.query.toLowerCase()
    const entries = people.filter((item) => `${item.name} ${item.email}`.toLowerCase().includes(term) && (!request.kinds || request.kinds.includes(item.kind)))
    return { entries, source, accounts: [{ accountId: 'ex', source: source === 'offline' ? 'offline' : 'online' }] }
  }),
  expandGroup: vi.fn(async () => ({ accountId: 'ex', groupEmail: 'finance@contoso.test', members: [people[1], entry({ name: 'Ruth Ruiz', email: 'ruth@contoso.test' })], truncated: false })),
  refresh: vi.fn(async () => snapshot),
  grantAccess: vi.fn(async () => snapshot),
  onChanged: vi.fn(() => () => undefined)
}
const api = {
  chooseAttachments: vi.fn(async () => []),
  mail: {
    mail: { suggestRecipients: vi.fn(async () => [{ accountId: 'ex', email: 'alex@partner.test', name: 'Alex Partner' }]) },
    drafts: { save: vi.fn(async () => ({ id: 'draft', status: 'synced', updatedAt: '2026-08-08T10:00:00Z' })), send: vi.fn(), schedule: vi.fn(), delete: vi.fn(), stageMessageAttachments: vi.fn(async () => []) }
  },
  productivity: {
    snapshot: vi.fn(async () => ({ calendars: [], events: [], sync: [], contacts: [] })),
    localSnapshot: vi.fn(async () => ({ tasks: [], notes: [], contacts: [{ id: 'alexa', name: 'Alexa Personal', email: 'alexa@home.test', group: 'Personal', favorite: false, color: '#000', source: 'local' }] }))
  },
  directory
}
const rowInput = (label: string) => {
  const row = Array.from(document.querySelectorAll<HTMLElement>('.compose-row')).find((item) => item.querySelector('label')?.textContent === label)
  return row!.querySelector('input') as HTMLInputElement
}

beforeEach(() => {
  vi.clearAllMocks()
  source = 'online'
  Object.defineProperty(window, 'aerio', { configurable: true, value: api })
})

describe('composer recipient selection with the directory', () => {
  vi.setConfig({ testTimeout: 20_000 })

  it('lists cached suggestions, personal contacts, and read-only directory entries with disambiguation', async () => {
    const user = userEvent.setup()
    render(<ContextMenuProvider><MailComposeModal accounts={accounts} onClose={vi.fn()} onSent={vi.fn()} onToast={vi.fn()} /></ContextMenuProvider>)
    await user.type(rowInput('To'), 'alex')
    await screen.findByText(/Directory · read-only/)
    expect(directory.search).toHaveBeenLastCalledWith({ query: 'alex', accountIds: ['ex'], limit: 8 })
    // Cached-mail suggestion, then personal contacts, then the directory.
    expect(screen.getByRole('button', { name: /Alex Partner/ })).toBeInTheDocument()
    expect(screen.getByText('My contacts')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Alexa Personal/ })).toBeInTheDocument()
    const ambiguous = screen.getAllByRole('button', { name: /^Person Alex Kim/ })
    expect(ambiguous.map((button) => button.textContent)).toEqual(['Alex KimEngineer · Platform · akim@contoso.test', 'Alex KimAccountant · Finance · alex.kim@contoso.test'])
    await user.click(ambiguous[1])
    expect(rowInput('To')).toHaveValue('Alex Kim <alex.kim@contoso.test>, ')
  })

  it('inserts a group address or expands its members', async () => {
    const user = userEvent.setup(), onToast = vi.fn()
    render(<ContextMenuProvider><MailComposeModal accounts={accounts} onClose={vi.fn()} onSent={vi.fn()} onToast={onToast} /></ContextMenuProvider>)
    await user.type(rowInput('To'), 'finance')
    await user.click(await screen.findByRole('button', { name: /^Group All Finance/ }))
    expect(rowInput('To')).toHaveValue('All Finance <finance@contoso.test>, ')
    await user.type(rowInput('Cc'), 'all fin')
    await user.click(await screen.findByRole('button', { name: 'Expand members' }))
    await waitFor(() => expect(rowInput('Cc')).toHaveValue('Alex Kim <alex.kim@contoso.test>, Ruth Ruiz <ruth@contoso.test>, '))
    expect(directory.expandGroup).toHaveBeenCalledWith('ex', 'finance@contoso.test')
    expect(onToast).toHaveBeenCalledWith('Added 2 members of All Finance')
  })

  it('marks offline answers from the saved address book', async () => {
    source = 'offline'
    const user = userEvent.setup()
    render(<ContextMenuProvider><MailComposeModal accounts={accounts} onClose={vi.fn()} onSent={vi.fn()} onToast={vi.fn()} /></ContextMenuProvider>)
    await user.type(rowInput('To'), 'room')
    expect(await screen.findByText('Directory · read-only · saved address book')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Room Conference Room Alpha/ })).toHaveTextContent('room.alpha@contoso.test · 10 seats')
  })

  it('formats details and personal contact matches', () => {
    expect(directoryEntryDetail(people[0])).toBe('Engineer · Platform · akim@contoso.test')
    expect(directoryEntryDetail({ ...people[0], ambiguous: false })).toBe('akim@contoso.test · Engineer')
    const contacts: Contact[] = [{ id: '1', name: 'Ada', email: 'ada@x.test', emails: [{ value: 'ada@x.test' }, { value: 'ada@y.test' }], group: 'Personal', favorite: false, color: '#000' }]
    expect(matchPersonalContacts(contacts, 'ada', new Set(['ada@x.test']))).toEqual([{ accountId: '', email: 'ada@y.test', name: 'Ada' }])
    expect(formatAge(new Date(Date.now() - 90 * 60_000).toISOString())).toBe('2 h ago')
  })
})

describe('Contacts directory section', () => {
  vi.setConfig({ testTimeout: 20_000 })
  const state: AppState = { accounts: [], events: [], contacts: [], tasks: [], notes: [] }

  it('searches the read-only directory, shows freshness, and copies an entry into personal contacts', async () => {
    const user = userEvent.setup(), onLocalContactsChange = vi.fn(), onToast = vi.fn()
    render(<ContextMenuProvider><ContactsView state={state} query="" onSync={vi.fn()} onCompose={vi.fn()} onToast={onToast} onLocalContactsChange={onLocalContactsChange} /></ContextMenuProvider>)
    await user.click(screen.getByRole('button', { name: /Directory/ }))
    expect(await screen.findByText(/Offline address book: 1,234 entries · updated 3 h ago/)).toBeInTheDocument()
    expect(screen.getByText(/last refresh failed .*HTTP 503/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Refresh now' }))
    expect(directory.refresh).toHaveBeenCalledWith('ex')
    await user.type(screen.getByLabelText('Search the directory'), 'alex')
    await user.click(await screen.findByRole('button', { name: /Alex Kim.*Accountant/ }))
    expect(screen.getByText(/Read-only directory entry/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Edit$/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Add to my contacts/ }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Alex Kim')
    expect(within(dialog).getByLabelText('Job title')).toHaveValue('Accountant')
    await user.click(within(dialog).getByRole('button', { name: 'Save contact' }))
    expect(onLocalContactsChange).toHaveBeenCalledWith([expect.objectContaining({ name: 'Alex Kim', email: 'alex.kim@contoso.test', title: 'Accountant', source: 'local', notes: 'Department: Finance' })])
    expect(onToast).toHaveBeenCalledWith('Contact created')
  })

  it('lists group members on request', async () => {
    const user = userEvent.setup()
    render(<ContextMenuProvider><ContactsView state={state} query="" onSync={vi.fn()} onCompose={vi.fn()} onToast={vi.fn()} /></ContextMenuProvider>)
    await user.click(screen.getByRole('button', { name: /Directory/ }))
    await user.type(screen.getByLabelText('Search the directory'), 'finance')
    await user.click(await screen.findByRole('button', { name: /All Finance/ }))
    await user.click(screen.getByRole('button', { name: /Show members/ }))
    expect(await screen.findByText('Ruth Ruiz')).toBeInTheDocument()
  })
})

describe('scheduling assistant rooms from the directory', () => {
  it('adds a directory room as a resource', async () => {
    const user = userEvent.setup()
    render(<SchedulingAssistant calendarId="ex:cal" start="2026-10-20T09:00" end="2026-10-20T10:00" attendees="" timeZone="UTC" api={{}} onApply={vi.fn()} onClose={vi.fn()} />)
    await user.type(screen.getByPlaceholderText('Room name or building'), 'alpha')
    await user.click(await screen.findByRole('button', { name: /Conference Room Alpha · 10 seats/ }))
    expect(directory.search).toHaveBeenLastCalledWith({ query: 'alpha', kinds: ['room', 'equipment'], limit: 10 })
    expect(screen.getByText('room.alpha@contoso.test')).toBeInTheDocument()
    expect(screen.getAllByText('Resource').length).toBeGreaterThan(0)
  })
})
