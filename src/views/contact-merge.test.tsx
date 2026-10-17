// @vitest-environment jsdom

import { configure, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextMenuProvider } from '../components/ContextMenu'
import type { AppState, Contact, ContactList } from '../types'
import type { ProductivitySnapshot, SyncedContact } from '../productivity-types'
import type { ContactAssociation, ContactMergeDesktopApi, ContactMergeEntry } from '../contact-merge-types'
import type { MailAccountSummary } from '../mail-types'
import type { ContactHistoryMailApi } from '../components/ContactHistoryPanel'
import ContactsView from './ContactsView'

configure({ asyncUtilTimeout: 5_000 })

const ada: Contact = { id: 'ada', name: 'Ada Lovelace', email: 'ada@home.test', company: 'Analytical', group: 'Friends', favorite: false, color: '#000', source: 'local', emails: [{ value: 'ada@home.test', type: 'home' }] }
const adaCopy: Contact = { id: 'ada-2', name: 'Lovelace, Ada', email: 'ADA@home.test', company: 'Babbage & Co', phone: '+44 20 7946 0000', group: 'Work', favorite: false, color: '#000', source: 'local' }
const adaGoogle: SyncedContact = { id: 'g:ada', remoteId: 'people/ada', accountId: 'g', provider: 'gmail', readOnly: false, revision: 'etag-1', name: 'Ada Lovelace', email: 'ada@home.test', group: 'Google', favorite: false, color: '#000' }
const alan: Contact = { id: 'alan', name: 'Alan Turing', email: 'alan@example.test', group: 'Friends', favorite: false, color: '#000', source: 'local' }
const state = (contacts: Contact[]): AppState => ({ accounts: [], events: [], contacts, tasks: [], notes: [] })
const providerAccounts = [{ id: 'g', email: 'g@example.test', provider: 'gmail' as const }]
const mailAccount = (id: string, extra: Partial<MailAccountSummary> = {}): MailAccountSummary => ({ id, provider: 'gmail', email: `${id}@mail.test`, displayName: id, color: '#123', status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true, ...extra })

function mergeApi(associations: ContactAssociation[] = [], merges: ContactMergeEntry[] = []) {
  let current = associations
  return {
    merges: vi.fn(async () => merges),
    mergeProvider: vi.fn(),
    recordLocalMerge: vi.fn(async (record) => ({ id: 'entry-1', kind: 'local', survivorId: record.survivorBefore.id, loserId: record.loserBefore.id, ...record, loserDeleted: true, createdAt: '2026-10-17T10:00:00.000Z' }) as ContactMergeEntry),
    undo: vi.fn(async (id: string) => ({ entry: { ...merges.find((entry) => entry.id === id)!, undoneAt: '2026-10-17T11:00:00.000Z' }, snapshot: { calendars: [], events: [], contacts: [], sync: [] } as ProductivitySnapshot })),
    associations: vi.fn(async () => current),
    associate: vi.fn(async (kind, firstId, secondId) => {
      const [a, b] = [firstId, secondId].sort()
      current = [...current, { id: `${a}|${b}`, kind, contactIds: [a, b], owners: ['local', 'g'], createdAt: '' } as ContactAssociation]
      return current
    }),
    removeAssociation: vi.fn(async (id: string) => { current = current.filter((item) => item.id !== id); return current })
  } satisfies ContactMergeDesktopApi
}

function historyMail(accounts = [mailAccount('m1'), mailAccount('m2', { archived: true })]): ContactHistoryMailApi {
  return {
    accounts: { list: vi.fn(async () => accounts) } as unknown as ContactHistoryMailApi['accounts'],
    attachments: {
      list: vi.fn(async () => ({ items: [{ accountId: 'm2', threadId: 't2', messageId: 'msg-2', attachmentId: 'p1', filename: 'notes.pdf', mimeType: 'application/pdf', size: 2048, fileType: 'pdf' as const, date: '2026-10-01T10:00:00.000Z', fromName: 'Ada', fromEmail: 'ada@home.test', to: [], cc: [], subject: 'Engine notes', available: false, accountArchived: true }], total: 1 })),
      open: vi.fn(), save: vi.fn()
    },
    contactHistory: {
      messages: vi.fn(async (query) => query.cursor
        ? { items: [{ accountId: 'm1', accountEmail: 'm1@mail.test', accountArchived: false, threadId: 't3', messageId: 'msg-3', date: '2026-09-01T10:00:00.000Z', fromName: 'Me', fromEmail: 'me@mail.test', to: ['ada@home.test'], cc: [], subject: 'Older', snippet: '', direction: 'to' as const, attachmentCount: 0 }], total: 2 }
        : { items: [{ accountId: 'm2', accountEmail: 'm2@mail.test', accountArchived: true, threadId: 't1', messageId: 'msg-1', date: '2026-10-02T10:00:00.000Z', fromName: 'Ada', fromEmail: 'ada@home.test', to: [], cc: [], subject: 'Hello from Ada', snippet: 'Hi', direction: 'from' as const, attachmentCount: 1 }], total: 2, nextCursor: 'next' })
    }
  }
}

beforeEach(() => vi.clearAllMocks())

describe('ContactsView duplicate merge and history', () => {
  vi.setConfig({ testTimeout: 20_000 })

  it('suggests duplicates with reasons, previews field choices, merges local contacts, and journals the originals', async () => {
    const user = userEvent.setup()
    const api = mergeApi()
    const onLocalContactsChange = vi.fn()
    const lists: ContactList[] = [{ id: 'l1', name: 'Club', source: 'local', members: [{ contactId: 'ada-2', email: 'ada@home.test' }] }]
    const onLocalListsChange = vi.fn()
    render(<ContextMenuProvider><ContactsView state={state([ada, adaCopy, adaGoogle, alan])} query="" onCompose={vi.fn()} onToast={vi.fn()} onSync={vi.fn()} providerAccounts={providerAccounts}
      onLocalContactsChange={onLocalContactsChange} mergeApi={api} listActions={{ localLists: lists, groups: [], onLocalListsChange }} /></ContextMenuProvider>)
    await user.click(screen.getByRole('button', { name: /Find duplicates/ }))
    const suggestions = within(screen.getByRole('list', { name: 'Duplicate suggestions' })).getAllByRole('listitem')
    // Two local copies can be merged; the Google copy is a different owner and can only be linked.
    expect(suggestions).toHaveLength(3)
    expect(suggestions[0]).toHaveTextContent(/High confidence.*Same email address ada@home.test · Same name/)
    expect(within(screen.getByRole('list', { name: 'Duplicate suggestions' })).queryByText(/Alan Turing/)).not.toBeInTheDocument()
    const local = suggestions.find((item) => within(item).queryByRole('button', { name: /Review merge/ }) && !item.textContent?.includes('Google'))!
    await user.click(within(local).getByRole('button', { name: /Review merge/ }))
    expect(screen.getByText(/Both records belong to Local contacts on this PC/)).toBeInTheDocument()
    await user.click(screen.getByLabelText(/Company from Lovelace, Ada/))
    await user.click(screen.getByRole('button', { name: 'Merge contacts' }))
    await waitFor(() => expect(onLocalContactsChange).toHaveBeenCalled())
    const saved = onLocalContactsChange.mock.calls[0][0] as Contact[]
    expect(saved.map((contact) => contact.id)).toEqual(['ada', 'alan'])
    expect(saved[0]).toMatchObject({ name: 'Ada Lovelace', company: 'Babbage & Co', phone: '+44 20 7946 0000', groups: ['Friends', 'Work'] })
    expect(onLocalListsChange).toHaveBeenCalledWith([expect.objectContaining({ members: [{ contactId: 'ada', email: 'ada@home.test' }] })])
    expect(api.recordLocalMerge).toHaveBeenCalledWith(expect.objectContaining({ survivorBefore: ada, loserBefore: adaCopy, relinkedLists: [{ listId: 'l1', email: 'ada@home.test' }] }))
  })

  it('links contacts across owners, dismisses false positives, and shows linked contacts with their owner', async () => {
    const user = userEvent.setup()
    const api = mergeApi()
    const onToast = vi.fn()
    render(<ContextMenuProvider><ContactsView state={state([ada, adaGoogle])} query="" onCompose={vi.fn()} onToast={onToast} onSync={vi.fn()} providerAccounts={providerAccounts} mergeApi={api} /></ContextMenuProvider>)
    await user.click(screen.getByRole('button', { name: /Find duplicates/ }))
    expect(screen.getByText(/can be linked on this PC but not merged/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Review merge/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^Link$/ }))
    expect(api.associate).toHaveBeenCalledWith('link', 'ada', 'g:ada')
    await waitFor(() => expect(screen.getByText(/No likely duplicates found/)).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'Close' }))
    // The local Ada is selected; the linked Google record is listed with its owner.
    expect(screen.getByText('Linked')).toBeInTheDocument()
    expect(screen.getByText('(g@example.test · Google)')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Unlink Ada Lovelace' }))
    expect(api.removeAssociation).toHaveBeenCalledWith('ada|g:ada')
  })

  it('undoes a local merge from the journal unless the kept contact changed', async () => {
    const user = userEvent.setup()
    const merged = { ...ada, company: 'Babbage & Co' }
    const entry: ContactMergeEntry = { id: 'entry-1', kind: 'local', survivorId: 'ada', loserId: 'ada-2', survivorBefore: ada, loserBefore: adaCopy, merged, loserDeleted: true, createdAt: '2026-10-17T10:00:00.000Z' }
    const api = mergeApi([], [entry])
    const onLocalContactsChange = vi.fn()
    const onToast = vi.fn()
    const { rerender } = render(<ContextMenuProvider><ContactsView state={state([{ ...merged, name: 'Edited later' }])} query="" onCompose={vi.fn()} onToast={onToast} onSync={vi.fn()} mergeApi={api} onLocalContactsChange={onLocalContactsChange} /></ContextMenuProvider>)
    await user.click(screen.getByRole('button', { name: /Find duplicates/ }))
    await user.click(await screen.findByRole('button', { name: /Undo/ }))
    expect(onToast).toHaveBeenCalledWith(expect.stringMatching(/changed after the merge/))
    expect(api.undo).not.toHaveBeenCalled()
    rerender(<ContextMenuProvider><ContactsView state={state([merged])} query="" onCompose={vi.fn()} onToast={onToast} onSync={vi.fn()} mergeApi={api} onLocalContactsChange={onLocalContactsChange} /></ContextMenuProvider>)
    await user.click(screen.getByRole('button', { name: /Undo/ }))
    await waitFor(() => expect(onLocalContactsChange).toHaveBeenCalledWith([ada, adaCopy]))
    expect(api.undo).toHaveBeenCalledWith('entry-1')
    expect(await screen.findByText(/Undone/)).toBeInTheDocument()
  })

  it('lists messages and attachments with the contact across selected accounts and opens the message', async () => {
    const user = userEvent.setup()
    const mail = historyMail()
    const onOpenMessage = vi.fn()
    render(<ContextMenuProvider><ContactsView state={state([ada])} query="" onCompose={vi.fn()} onToast={vi.fn()} onSync={vi.fn()} historyMail={mail} onOpenMessage={onOpenMessage} /></ContextMenuProvider>)
    const history = screen.getByRole('region', { name: 'Communication history' })
    expect(await within(history).findByText('Hello from Ada')).toBeInTheDocument()
    expect(mail.contactHistory!.messages).toHaveBeenLastCalledWith({ addresses: ['ada@home.test'], accountIds: ['m1', 'm2'], pageSize: 20 })
    expect(within(history).getByText(/m2@mail.test \(archived\)/)).toBeInTheDocument()
    await user.click(within(history).getByRole('button', { name: /Load more \(1 remaining\)/ }))
    expect(await within(history).findByText('Older')).toBeInTheDocument()
    await user.click(within(history).getByRole('button', { name: /Hello from Ada/ }))
    expect(onOpenMessage).toHaveBeenCalledWith({ source: 'connected', accountId: 'm2', threadId: 't1', messageId: 'msg-1', title: 'Hello from Ada' })

    await user.click(within(history).getByLabelText(/m2@mail.test/))
    await waitFor(() => expect(mail.contactHistory!.messages).toHaveBeenLastCalledWith({ addresses: ['ada@home.test'], accountIds: ['m1'], pageSize: 20 }))
    await user.click(within(history).getByLabelText(/m1@mail.test/))
    expect(await within(history).findByText('Choose at least one account.')).toBeInTheDocument()
    await user.click(within(history).getByLabelText(/m1@mail.test/))
    await user.click(within(history).getByRole('tab', { name: /Attachments/ }))
    expect(await within(history).findByText('notes.pdf')).toBeInTheDocument()
    expect(mail.attachments.list).toHaveBeenLastCalledWith({ participants: ['ada@home.test'], accountIds: ['m1'], includeArchivedAccounts: true, pageSize: 20 })
    expect(within(history).getByText(/not stored offline/)).toBeInTheDocument()
  })
})
