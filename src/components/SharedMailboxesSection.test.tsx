// @vitest-environment jsdom

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MailAccountSummary, MailLabel } from '../mail-types'
import type { MailboxDelegation, MailboxOwnerSummary } from '../mailbox-owner-types'
import { mailboxRestriction } from '../lib/mailbox-owners'
import SharedMailboxesSection from './SharedMailboxesSection'
import { MailFolderTreeSidebar } from './MailSidebarFolders'

const account: MailAccountSummary = { id: 'ex-1', provider: 'exchange', email: 'ada@contoso.test', displayName: 'Ada', color: '#0f6cbd', status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true }

const owner = (overrides: Partial<MailboxOwnerSummary> = {}): MailboxOwnerSummary => ({
  id: 'mbx-1', accountId: 'ex-1', provider: 'exchange', kind: 'delegated', address: 'grace@contoso.test', displayName: 'Grace', status: 'active', access: 'read',
  folders: [{ folderId: 'F1', labelId: 'owner:mbx-1:F1', name: 'Inbox', kind: 'mail', distinguished: 'inbox', access: 'read', canCreate: false, canModify: false, canDelete: false }],
  sendMode: 'none', discoveredBy: 'manual', heldOperations: 0, createdAt: '2026-10-17T10:00:00Z', updatedAt: '2026-10-17T10:00:00Z', ...overrides
})

const delegation: MailboxDelegation = { accountId: 'ex-1', supported: true, delegates: [], deliverMeetingRequests: 'DelegatesAndSendInformationToMe' }

const api = {
  list: vi.fn(async () => [owner(), owner({ id: 'mbx-2', address: 'team@contoso.test', displayName: 'Team', kind: 'shared', status: 'access-removed', access: 'none', error: 'Your access to Team was removed.' })]),
  discover: vi.fn(async () => ({ supported: true, mailboxes: [{ address: 'sales@contoso.test', displayName: 'Sales', kind: 'shared' as const, attached: false }] })),
  attach: vi.fn(async () => owner()),
  update: vi.fn(async () => owner()),
  remove: vi.fn(async () => undefined),
  sync: vi.fn(async () => []),
  publicFolders: {
    browse: vi.fn(async (_accountId: string, parent?: string) => parent
      ? [{ folderId: 'P2', parentFolderId: 'P1', name: 'Aerio', folderClass: 'IPF.Note', kind: 'mail' as const, childCount: 0, access: 'write' as const, subscribed: false }]
      : [{ folderId: 'P1', name: 'Projects', folderClass: 'IPF.Note', kind: 'mail' as const, childCount: 1, access: 'read' as const, subscribed: false }]),
    subscribe: vi.fn(async () => undefined)
  },
  delegates: {
    get: vi.fn(async () => delegation),
    save: vi.fn(async () => ({ ...delegation, delegates: [{ address: 'bob@contoso.test', permissions: { calendar: 'Editor' as const, tasks: 'None' as const, inbox: 'None' as const, contacts: 'None' as const, notes: 'None' as const }, receiveCopiesOfMeetingMessages: true, viewPrivateItems: false }] })),
    remove: vi.fn(async () => delegation),
    setMeetingDelivery: vi.fn(async () => ({ ...delegation, deliverMeetingRequests: 'DelegatesOnly' as const }))
  },
  held: {
    list: vi.fn(async () => [{ id: 'op-1', accountId: 'ex-1', ownerId: 'mbx-2', ownerName: 'Team', kind: 'move', threadCount: 2, error: 'Your access to Team was removed.', createdAt: '2026-10-17T10:00:00Z' }]),
    resolve: vi.fn(async () => [])
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'aerio', { configurable: true, value: { mailboxOwners: api, mail: { onEvent: () => () => undefined } } })
})

describe('SharedMailboxesSection', () => {
  it('lists mailboxes with permission and access-removed indicators and resolves held changes', async () => {
    const user = userEvent.setup()
    const toast = vi.fn()
    render(<SharedMailboxesSection account={account} onToast={toast} />)
    const list = await screen.findByRole('list', { name: 'Attached mailboxes' })
    const rows = within(list).getAllByRole('listitem')
    expect(rows[0]).toHaveTextContent('Grace')
    expect(rows[0]).toHaveTextContent('Read-only')
    expect(rows[1]).toHaveTextContent('Access removed')
    expect(rows[1]).toHaveTextContent('Your access to Team was removed.')
    await user.click(within(rows[0]).getByRole('button', { name: /Permissions/ }))
    expect(screen.getByRole('table', { name: 'Permissions in Grace' })).toHaveTextContent('Inbox')
    await user.selectOptions(within(rows[0]).getByLabelText('Send from grace@contoso.test'), 'send-on-behalf')
    expect(api.update).toHaveBeenCalledWith({ accountId: 'ex-1', ownerId: 'mbx-1', sendMode: 'send-on-behalf' })
    const held = screen.getByRole('region', { name: 'Held mailbox changes' })
    expect(held).toHaveTextContent('move · 2 conversations')
    await user.click(within(held).getByRole('button', { name: 'Discard' }))
    expect(api.held.resolve).toHaveBeenCalledWith('op-1', 'discard')
  })

  it('attaches a mailbox by address and from Autodiscover', async () => {
    const user = userEvent.setup()
    render(<SharedMailboxesSection account={account} onToast={vi.fn()} />)
    await user.type(await screen.findByLabelText('Mailbox address'), 'team@contoso.test')
    await user.selectOptions(screen.getByLabelText('Send from the new mailbox'), 'send-as')
    await user.click(screen.getByRole('button', { name: /Add mailbox/ }))
    expect(api.attach).toHaveBeenCalledWith({ accountId: 'ex-1', address: 'team@contoso.test', kind: 'shared', sendMode: 'send-as' })
    await user.click(screen.getByRole('button', { name: /Find my mailboxes/ }))
    const found = await screen.findByRole('region', { name: 'Mailboxes found by Autodiscover' })
    await user.click(within(found).getByRole('button', { name: 'Add' }))
    expect(api.attach).toHaveBeenLastCalledWith({ accountId: 'ex-1', address: 'sales@contoso.test', displayName: 'Sales', kind: 'shared', sendMode: 'none', discoveredBy: 'autodiscover' })
  })

  it('browses public folders lazily and subscribes them', async () => {
    const user = userEvent.setup()
    render(<SharedMailboxesSection account={account} onToast={vi.fn()} />)
    await user.click(await screen.findByRole('button', { name: /Browse public folders/ }))
    const tree = await screen.findByRole('list', { name: 'Public folders' })
    await within(tree).findByText('Projects')
    await user.click(within(tree).getByRole('button', { name: 'Expand Projects' }))
    await within(tree).findByText('Aerio')
    expect(api.publicFolders.browse).toHaveBeenLastCalledWith('ex-1', 'P1')
    await user.click(within(tree).getByLabelText('Show Aerio in Aerio'))
    expect(api.publicFolders.subscribe).toHaveBeenCalledWith('ex-1', 'P2', true)
    await waitFor(() => expect(within(tree).getByLabelText('Show Aerio in Aerio')).toBeChecked())
  })

  it('adds a delegate with folder permissions and changes meeting request delivery', async () => {
    const user = userEvent.setup()
    render(<SharedMailboxesSection account={account} onToast={vi.fn()} />)
    await user.click(await screen.findByRole('button', { name: /Manage delegates/ }))
    const region = await screen.findByRole('region', { name: 'Delegates' })
    await user.type(within(region).getByLabelText('New delegate'), 'bob@contoso.test')
    await user.selectOptions(within(region).getByLabelText('Inbox permission for bob@contoso.test'), 'Reviewer')
    await user.click(within(region).getByRole('button', { name: /Add delegate/ }))
    expect(api.delegates.save).toHaveBeenCalledWith({ accountId: 'ex-1', mode: 'add', delegate: expect.objectContaining({ address: 'bob@contoso.test', permissions: expect.objectContaining({ calendar: 'Editor', inbox: 'Reviewer' }) }) })
    expect(await within(region).findAllByText('bob@contoso.test')).not.toHaveLength(0)
    await user.selectOptions(within(region).getByLabelText('Deliver meeting requests to'), 'DelegatesOnly')
    expect(api.delegates.setMeetingDelivery).toHaveBeenCalledWith('ex-1', 'DelegatesOnly')
  })

  it('shows Microsoft 365 limits instead of Exchange-only tools', async () => {
    render(<SharedMailboxesSection account={{ ...account, provider: 'microsoft' }} onToast={vi.fn()} />)
    expect(await screen.findByText(/Mail.ReadWrite.Shared/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Browse public folders/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Find my mailboxes/ })).not.toBeInTheDocument()
  })
})

describe('owner indicators in the folder tree and read-only enforcement', () => {
  const labels: MailLabel[] = [
    { accountId: 'ex-1', id: 'folder:inbox', name: 'Inbox', type: 'system' },
    { accountId: 'ex-1', id: 'owner:mbx-1', name: 'Grace', type: 'user', owner: { id: 'mbx-1', kind: 'delegated', address: 'grace@contoso.test', displayName: 'Grace', status: 'active', access: 'read', root: true } },
    { accountId: 'ex-1', id: 'owner:mbx-1:F1', name: 'Inbox', type: 'user', parentId: 'owner:mbx-1', owner: { id: 'mbx-1', kind: 'delegated', address: 'grace@contoso.test', displayName: 'Grace', status: 'active', access: 'read' } },
    { accountId: 'ex-1', id: 'owner:mbx-2:F9', name: 'Inbox', type: 'user', owner: { id: 'mbx-2', kind: 'shared', address: 'team@contoso.test', displayName: 'Team', status: 'access-removed', access: 'none' } }
  ]

  it('badges shared mailbox folders in the sidebar tree', () => {
    render(<MailFolderTreeSidebar accounts={[account]} labels={labels} accountFilter="all" appearance={new Map()} favorites={new Map()} selectedAccountId="ex-1" showHidden={false} onToggleHidden={vi.fn()} onOpen={vi.fn()} onContextMenu={vi.fn()} />)
    expect(screen.getAllByText('Read-only').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('Access removed')).toHaveAttribute('title', 'Team <team@contoso.test>')
  })

  it('explains why a conversation of another mailbox cannot be changed', () => {
    expect(mailboxRestriction(labels, 'ex-1', ['folder:inbox', 'INBOX'])).toBeUndefined()
    expect(mailboxRestriction(labels, 'ex-1', ['owner:mbx-1:F1', 'UNREAD'])).toMatch(/Read-only: .*Inbox \(Grace\)/)
    expect(mailboxRestriction(labels, 'ex-1', ['owner:mbx-2:F9'])).toMatch(/Access to Team was removed/)
  })
})
