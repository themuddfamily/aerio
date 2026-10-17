// @vitest-environment jsdom

import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextMenuProvider } from '../components/ContextMenu'
import type { AppState, Contact, ContactList } from '../types'
import type { ProductivitySnapshot, SyncedContact, SyncedContactGroup } from '../productivity-types'
import ContactsView from './ContactsView'

const ada: Contact = { id: 'ada', name: 'Ada Lovelace', email: 'ada@home.test', group: 'Friends', favorite: false, color: '#000', source: 'local', emails: [{ value: 'ada@home.test', type: 'home' }] }
const alan: SyncedContact = { id: 'g:alan', remoteId: 'people/alan', accountId: 'g', provider: 'gmail', readOnly: false, revision: 'etag-1', name: 'Alan Turing', email: 'alan@example.test', group: 'Team', groups: ['Team'], groupIds: ['contactGroups/team'], favorite: false, color: '#000' }
const kat: SyncedContact = { ...alan, id: 'g:kat', remoteId: 'people/kat', name: 'Katherine Johnson', email: 'kj@example.test', group: 'Google', groups: undefined, groupIds: [], revision: 'etag-k' }
const linus: SyncedContact = { id: 'm:linus', remoteId: 'linus', accountId: 'm', provider: 'microsoft', readOnly: true, name: 'Linus', email: 'linus@example.test', group: 'Board', groups: ['Board'], favorite: false, color: '#000' }
const team: SyncedContactGroup = { id: 'g:team', remoteId: 'contactGroups/team', accountId: 'g', provider: 'gmail', name: 'Team', system: false, readOnly: false }
const state = (contacts: Contact[]): AppState => ({ accounts: [], events: [], contacts, tasks: [], notes: [] })
const accounts = [{ id: 'g', email: 'g@example.test', provider: 'gmail' as const }, { id: 'm', email: 'm@example.test', provider: 'microsoft' as const }]
const snapshot: ProductivitySnapshot = { calendars: [], events: [], contacts: [], sync: [], contactGroups: [team] }

configure({ asyncUtilTimeout: 5_000 })
const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
const listsSidebar = () => within(screen.getByText('Distribution lists').closest('.sidebar-group') as HTMLElement)

beforeEach(() => {
  vi.clearAllMocks()
  window.confirm = vi.fn(() => true)
})

const renderView = (overrides: Partial<React.ComponentProps<typeof ContactsView>> = {}, lists: ContactList[] = []) => {
  const props = {
    onLocalContactsChange: vi.fn(), onSaveProviderContact: vi.fn(async (_accountId: string, contact: Contact) => contact), onToast: vi.fn(), onCompose: vi.fn(),
    listActions: {
      localLists: lists, groups: [team], onLocalListsChange: vi.fn(),
      createGroup: vi.fn(async () => ({ ...snapshot, contactGroups: [team, { ...team, id: 'g:new', remoteId: 'contactGroups/new', name: 'Readers' }] })),
      renameGroup: vi.fn(async () => snapshot), deleteGroup: vi.fn(async () => snapshot), updateGroupMembers: vi.fn(async () => snapshot)
    }
  }
  render(<ContextMenuProvider><ContactsView state={state([ada, alan, kat, linus])} query="" onSync={vi.fn()} providerAccounts={accounts} {...props} {...overrides} /></ContextMenuProvider>)
  return props
}

describe('ContactsView rich contacts and lists', () => {
  // These flows drive whole modals; allow for a busy full-suite run.
  vi.setConfig({ testTimeout: 20_000 })
  it('edits multiple typed emails, phones, addresses, groups, and birthday on a local contact', async () => {
    const user = userEvent.setup(), props = renderView()
    await user.click(screen.getByRole('button', { name: /Ada Lovelace/ }))
    await user.click(screen.getByRole('button', { name: /^Edit$/ }))
    await user.click(screen.getByRole('button', { name: 'Add email' }))
    fill('Email 2', 'ada@work.test')
    await user.selectOptions(screen.getByLabelText('Email 2 type'), 'work')
    await user.click(within(screen.getByLabelText('Email 2').closest('div')!).getByTitle('Make primary'))
    fill('Phone', '+44 1')
    await user.click(screen.getByRole('button', { name: 'Add address' }))
    fill('Address', '1 Lane, London')
    fill('Groups', 'Friends, Chess club')
    fill('Birthday', '1815-12-10')
    await user.click(screen.getByRole('button', { name: 'Save contact' }))
    expect(props.onLocalContactsChange).toHaveBeenCalledWith([expect.objectContaining({
      email: 'ada@work.test', phone: '+44 1', group: 'Friends', groups: ['Friends', 'Chess club'], birthday: '1815-12-10',
      emails: [{ value: 'ada@home.test', type: 'home' }, { value: 'ada@work.test', type: 'work', preferred: true }],
      addresses: [{ value: '1 Lane, London', type: 'home' }]
    })])
  })

  it('sends the edited revision with provider contact updates and keeps Google groups out of the editor', async () => {
    const user = userEvent.setup(), props = renderView()
    await user.click(screen.getByRole('button', { name: /Alan Turing/ }))
    await user.click(screen.getByRole('button', { name: /^Edit$/ }))
    expect(screen.getByLabelText('Groups')).toBeDisabled()
    fill('Job title', 'Mathematician')
    await user.click(screen.getByRole('button', { name: 'Save contact' }))
    await waitFor(() => expect(props.onSaveProviderContact).toHaveBeenCalledWith('g', expect.objectContaining({ revision: 'etag-1', title: 'Mathematician', groups: ['Team'], group: 'Team' }), true))
  })

  it('shows read-only provider contacts without edit actions', async () => {
    const user = userEvent.setup()
    renderView()
    await user.click(screen.getByRole('button', { name: /Linus/ }))
    expect(screen.queryByRole('button', { name: /^Edit$/ })).not.toBeInTheDocument()
    expect(screen.getByText(/Read-only: reconnect this account/)).toBeInTheDocument()
    await user.click(listsSidebar().getByRole('button', { name: /^Board/ }))
    expect(screen.getByRole('button', { name: /Edit list/ })).toBeDisabled()
  })

  it('creates a local distribution list with contacts and other addresses', async () => {
    const user = userEvent.setup(), props = renderView()
    await user.click(screen.getByTitle('New distribution list'))
    fill('Name', 'Book club')
    await user.click(screen.getByRole('checkbox', { name: /Ada Lovelace/ }))
    fill('Other addresses', 'not-an-address')
    expect(screen.getByRole('button', { name: 'Save list' })).toBeDisabled()
    fill('Other addresses', 'Guest <guest@example.test>')
    await user.click(screen.getByRole('button', { name: 'Save list' }))
    await waitFor(() => expect(props.listActions.onLocalListsChange).toHaveBeenCalledWith([expect.objectContaining({
      name: 'Book club', source: 'local', members: [{ contactId: 'ada', email: 'ada@home.test', name: 'Ada Lovelace' }, { email: 'guest@example.test' }]
    })]))
    expect(props.onToast).toHaveBeenCalledWith('List created')
  })

  it('filters by a list, emails all members, and manages Google group membership', async () => {
    const user = userEvent.setup()
    const props = renderView({}, [{ id: 'list-1', name: 'Book club', source: 'local', members: [{ contactId: 'ada', email: 'ada@home.test' }, { email: 'guest@example.test' }] }])
    await user.click(listsSidebar().getByRole('button', { name: /^Book club/ }))
    expect(screen.getByRole('heading', { name: 'Book club' })).toBeInTheDocument()
    expect(screen.getByText(/not a saved contact/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Email list/ }))
    expect(props.onCompose).toHaveBeenCalledWith('Ada Lovelace <ada@home.test>, guest@example.test')

    await user.click(listsSidebar().getByRole('button', { name: /^Team/ }))
    await user.click(screen.getByRole('button', { name: /Edit list/ }))
    await user.click(screen.getByRole('checkbox', { name: /Katherine Johnson/ }))
    await user.click(screen.getByRole('checkbox', { name: /Alan Turing/ }))
    fill('Name', 'Crew')
    await user.click(screen.getByRole('button', { name: 'Save list' }))
    await waitFor(() => expect(props.listActions.updateGroupMembers).toHaveBeenCalledWith('g:team', ['g:kat'], ['g:alan']))
    expect(props.listActions.renameGroup).toHaveBeenCalledWith('g:team', 'Crew')

    fireEvent.contextMenu(listsSidebar().getByRole('button', { name: /^Team/ }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete list' }))
    await waitFor(() => expect(props.listActions.deleteGroup).toHaveBeenCalledWith('g:team'))
  })

  it('creates a Google group and an Outlook category list through their providers', async () => {
    const user = userEvent.setup(), props = renderView()
    await user.click(screen.getByTitle('New distribution list'))
    await user.selectOptions(screen.getByLabelText('Save to'), 'group:g')
    fill('Name', 'Readers')
    await user.click(screen.getByRole('checkbox', { name: /Katherine Johnson/ }))
    await user.click(screen.getByRole('button', { name: 'Save list' }))
    await waitFor(() => expect(props.listActions.updateGroupMembers).toHaveBeenCalledWith('g:new', ['g:kat'], []))
    expect(props.listActions.createGroup).toHaveBeenCalledWith('g', 'Readers')

    await user.click(screen.getByTitle('New distribution list'))
    await user.selectOptions(screen.getByLabelText('Save to'), 'category:m')
    fill('Name', 'Advisors')
    // Read-only Outlook contacts cannot be categorized, so there is nobody to pick.
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save list' })).toBeDisabled()
  })
})
