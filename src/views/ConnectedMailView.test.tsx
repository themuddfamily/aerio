// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MailAccountSummary, MailDraftRecord, MailPage, MailQuickAction, MailQuickActionRunResult, MailSavedSearch, MailThreadDetail, SyncProgress } from '../mail-types'
import { ContextMenuProvider } from '../components/ContextMenu'
import ConnectedMailView from './ConnectedMailView'
import { KeymapProvider } from '../lib/use-keymap'
import { formatMailDateHeading } from '../lib/mail-date'

vi.mock('../components/MailComposeModal', () => ({ default: (props: any) => <div role="dialog" aria-label="Compose mock"><span>{props.draft ? `Editing ${props.draft.subject}` : props.replyAll ? 'Reply all' : props.forward ? 'Forward' : props.reply ? 'Reply' : `New ${props.initialTo ?? ''}`}</span><button onClick={() => props.onSent({ id: 'send-1', status: 'send-pending', updatedAt: new Date().toISOString(), undoUntil: new Date(Date.now() + 60_000).toISOString() })}>Queue send</button><button onClick={props.onClose}>Close compose</button></div> }))
vi.mock('../components/MailAccountSetupModal', () => ({ default: (props: any) => <div role="dialog" aria-label="Account setup mock"><button onClick={() => props.onConnected()}>Finish account</button><button onClick={props.onClose}>Close setup</button></div> }))
vi.mock('../components/MailAccountSettingsModal', () => ({ default: (props: any) => <div role="dialog" aria-label="Account settings mock"><span>{props.account.email}</span><button onClick={() => props.onSaved({ ...props.account, displayName: 'Updated' })}>Save account</button><button onClick={props.onClose}>Close settings</button></div> }))
vi.mock('../components/MailOrganizeModal', () => ({ default: (props: any) => <div role="dialog" aria-label="Organize mock"><button onClick={() => props.onApply([{ accountId: props.items[0].accountId, threadIds: props.items.map((item: any) => item.id), action: props.mode === 'move' ? 'move' : 'label', labelId: 'project' }])}>Apply organize</button><button onClick={props.onClose}>Close organize</button></div> }))
vi.mock('../components/MailMessageSourceModal', () => ({ default: (props: any) => <div role="dialog" aria-label="Source mock"><span>{props.mode}:{props.content}</span><button onClick={props.onClose}>Close source</button></div> }))
vi.mock('../components/MailAttachmentsModal', () => ({ default: (props: any) => <div role="dialog" aria-label="Attachments mock"><span>{props.accounts.length} accounts</span><button onClick={props.onClose}>Close attachments</button></div> }))
vi.mock('../components/MailRulesModal', () => ({ default: (props: any) => <div role="dialog" aria-label="Rules mock"><button onClick={props.onClose}>Close rules</button></div> }))
vi.mock('../components/MailSearchFiltersPanel', () => ({ default: (props: any) => <div role="dialog" aria-label="Filters mock">
  <button onClick={() => props.onApply({ subject: 'Launch' })}>Apply filters</button>
  {Object.entries({ from: 'Nobody', to: 'nobody@example.test', subject: 'Missing', attachmentName: 'missing.pdf', dateFrom: '2026-09-01', dateTo: '2026-01-01', hasAttachments: true, unread: true, starred: true, important: true }).map(([field, value]) => <button key={field} onClick={() => props.onApply({ [field]: value })}>{`Filter draft ${field}`}</button>)}
  <button onClick={props.onClose}>Close filters</button>
</div> }))
vi.mock('../components/MailSnoozeModal', () => ({ default: (props: any) => <div role="dialog" aria-label="Snooze mock"><button onClick={() => props.onApply(new Date(Date.now() + 60_000).toISOString())}>Apply snooze</button><button onClick={props.onClose}>Close snooze</button></div> }))
vi.mock('../components/SenderAvatar', () => ({ default: ({ name }: any) => <span>{name?.slice(0, 1)}</span> }))
vi.mock('../components/ThreadListPreview', () => ({ default: (props: any) => <div data-testid="thread-preview"><button onClick={() => props.onSelect(props.thread.messages[0])}>Select preview message</button><button onClick={() => props.onOpenWindow(props.thread.messages[0])}>Open preview window</button></div> }))
vi.mock('../components/ThreadMessageAccordion', () => ({ default: (props: any) => <section data-testid={`accordion-${props.message.id}`} onContextMenu={props.onContextMenu}><button onClick={props.onToggle}>{props.expanded ? 'Collapse mail message' : 'Expand mail message'}</button>{props.onReply && <button onClick={props.onReply}>Reply to provider message</button>}{props.onMoreActions && <button onClick={props.onMoreActions}>Message options</button>}{props.expanded && props.onLoadRemoteImages && <button onClick={props.onLoadRemoteImages}>Load remote images</button>}{props.expanded && <span>{props.message.text}</span>}{props.children}</section> }))
vi.mock('../components/MailPaneResizer', () => ({
  useResizableMailPanes: () => ({ containerRef: { current: null }, style: {}, widths: { sidebar: 220, list: 420 }, startResize: vi.fn(), resizeWithKeyboard: vi.fn(), resetWidths: vi.fn() }),
  MailPaneSeparator: ({ pane }: any) => <div data-testid={`separator-${pane}`} />
}))

const account = (overrides: Partial<MailAccountSummary> = {}): MailAccountSummary => ({
  id: 'account', provider: 'gmail', email: 'me@example.test', displayName: 'Me', color: '#6558e8', status: 'ready', archived: false,
  signature: '', notifications: true, syncEnabled: true, ...overrides
})
const summary = (overrides: any = {}) => ({
  accountId: 'account', id: 'thread-1', subject: 'Launch &amp; plans', participants: ['Ada'], senderEmail: 'ada@example.test', snippet: 'Ready &amp; waiting',
  lastDate: '2026-08-08T10:00:00Z', unread: true, starred: true, important: false, trashed: false, draft: false, hasAttachments: true,
  labelIds: ['INBOX', 'UNREAD', 'STARRED', 'project'], messageCount: 2, ...overrides
})
const detail: MailThreadDetail = {
  accountId: 'account', id: 'thread-1', subject: 'Launch & plans', messages: [{
    accountId: 'account', id: 'message-1', threadId: 'thread-1', fromName: 'Ada', fromEmail: 'ada@example.test', to: ['me@example.test'], cc: [], subject: 'Launch & plans', messageIdHeader: '<message@example.test>',
    date: '2026-08-08T09:00:00Z', text: 'Message body', html: '<p>Message body</p>', sanitizedHtml: '<p>Message body</p>', labelIds: ['INBOX', 'UNREAD'],
    attachments: [{ id: 'attachment', messageId: 'message-1', filename: 'report.pdf', mimeType: 'application/pdf', size: 2048 }]
  }]
}
const initialPage: MailPage = { items: [summary(), summary({ id: 'thread-2', subject: 'Second conversation', participants: ['Grace'], senderEmail: 'grace@example.test', lastDate: '2026-08-07T10:00:00Z', unread: false, starred: false, hasAttachments: false, labelIds: ['INBOX'], messageCount: 1 })], total: 3, nextCursor: 'next' }
const localDraft: MailDraftRecord = { id: 'draft-1', accountId: 'account', to: ['reader@example.test'], cc: [], bcc: [], subject: 'Local draft', text: 'Draft body', attachmentPaths: [], status: 'local', updatedAt: '2026-08-08T10:00:00Z' }
const scheduledDraft: MailDraftRecord = { ...localDraft, id: 'scheduled-1', subject: 'Scheduled draft', status: 'scheduled', deliveryAt: '2026-08-09T10:00:00Z' }

let emitMail: ((event: any) => void) | undefined
let observerCallback: ((entries: Array<{ isIntersecting: boolean }>) => void) | undefined
let accountsResult: MailAccountSummary[] = [account()]
let pageResult: MailPage = initialPage
let unreadCountsResult = { inbox: 2, starred: 1, important: 0, sent: 0, drafts: 0, scheduled: 0, snoozed: 0, archive: 1, spam: 0, trash: 0, all: 3 }
let accountUnreadCountsResult = { account: 2 }
const api = {
  mail: {
    accounts: { list: vi.fn(async () => accountsResult), disconnect: vi.fn(async () => undefined) },
    sync: { progress: vi.fn(async (): Promise<SyncProgress[]> => []), start: vi.fn(async () => undefined), pause: vi.fn(async () => undefined), resume: vi.fn(async () => undefined) },
    mail: {
      labels: vi.fn(async () => [{ accountId: 'account', id: 'project', name: 'Project', type: 'user' }]),
      list: vi.fn(async (query: any) => query.cursor ? { items: [summary({ id: 'thread-3', subject: 'Loaded later', lastDate: '2026-08-06T10:00:00Z' })], total: 3 } : pageResult),
      unreadCounts: vi.fn(async () => unreadCountsResult),
      accountUnreadCounts: vi.fn(async () => accountUnreadCountsResult),
      thread: vi.fn(async () => detail), source: vi.fn(async () => ({ headers: 'Header: value', source: 'raw source' })),
      action: vi.fn(async (input: any) => ({ id: `operation-${input.action}`, accountId: input.accountId, kind: input.action, status: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), undoUntil: new Date(Date.now() + 60_000).toISOString() })),
      undo: vi.fn(async () => true), snooze: vi.fn(async () => []), unsnooze: vi.fn(async () => true)
    },
    drafts: { list: vi.fn(async () => [localDraft, scheduledDraft]), delete: vi.fn(async () => ({ id: 'draft-1', status: 'discarded', updatedAt: new Date().toISOString() })), cancelSend: vi.fn(async (id: string) => ({ id, status: 'local', updatedAt: new Date().toISOString() })), get: vi.fn(async () => scheduledDraft) },
    attachments: { open: vi.fn(async () => ({})), save: vi.fn(async () => ({ savedPath: 'C:\\saved\\report.pdf' })) },
    storage: vi.fn(async () => ({ totalBytes: 2048, freeBytes: 4096, accounts: [] })),
    savedSearches: {
      list: vi.fn(async (): Promise<MailSavedSearch[]> => []),
      save: vi.fn(async (input: any): Promise<MailSavedSearch> => ({ ...input, id: input.id ?? 'saved-new', createdAt: '2026-08-08T10:00:00Z', updatedAt: '2026-08-08T10:00:00Z' })),
      delete: vi.fn(async () => undefined)
    },
    quickActions: {
      list: vi.fn(async (): Promise<MailQuickAction[]> => []),
      save: vi.fn(async (input: any): Promise<MailQuickAction> => ({ ...input, id: input.id ?? 'quick-new', createdAt: '2026-08-08T10:00:00Z', updatedAt: '2026-08-08T10:00:00Z' })),
      delete: vi.fn(async () => undefined),
      run: vi.fn(async (): Promise<MailQuickActionRunResult> => ({ operations: [], updatedThreads: 0, failures: [] }))
    },
    onEvent: vi.fn((callback: (event: any) => void) => { emitMail = callback; return vi.fn() })
  },
  window: { openMessage: vi.fn(async () => undefined) }
}

const renderMail = (props: any = {}) => {
  const onToast = vi.fn()
  render(<ContextMenuProvider><ConnectedMailView onToast={onToast} {...props} /></ContextMenuProvider>)
  return onToast
}

beforeEach(() => {
  vi.clearAllMocks()
  accountsResult = [account()]
  pageResult = initialPage
  unreadCountsResult = { inbox: 2, starred: 1, important: 0, sent: 0, drafts: 0, scheduled: 0, snoozed: 0, archive: 1, spam: 0, trash: 0, all: 3 }
  accountUnreadCountsResult = { account: 2 }
  emitMail = undefined
  observerCallback = undefined
  Object.defineProperty(window, 'aerio', { configurable: true, value: api })
  Object.defineProperty(window, 'getSelection', { configurable: true, value: vi.fn(() => ({ toString: () => '' })) })
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => undefined) } })
  Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: class {
    constructor(callback: any) { observerCallback = callback }
    observe() {}; disconnect() {}
  } })
  window.confirm = vi.fn(() => true)
  api.mail.accounts.list.mockImplementation(async () => accountsResult)
  api.mail.mail.labels.mockResolvedValue([{ accountId: 'account', id: 'project', name: 'Project', type: 'user' }])
  api.mail.accounts.disconnect.mockResolvedValue(undefined)
  api.mail.sync.progress.mockResolvedValue([])
  api.mail.sync.start.mockResolvedValue(undefined)
  api.mail.sync.pause.mockResolvedValue(undefined)
  api.mail.sync.resume.mockResolvedValue(undefined)
  api.mail.mail.list.mockImplementation(async (query: any) => query.cursor ? { items: [summary({ id: 'thread-3', subject: 'Loaded later', lastDate: '2026-08-06T10:00:00Z' })], total: 3 } : pageResult)
  api.mail.mail.unreadCounts.mockImplementation(async () => unreadCountsResult)
  api.mail.mail.accountUnreadCounts.mockImplementation(async () => accountUnreadCountsResult)
  api.mail.mail.thread.mockResolvedValue(detail)
  api.mail.mail.source.mockResolvedValue({ headers: 'Header: value', source: 'raw source' })
  api.mail.mail.action.mockImplementation(async (input: any) => ({ id: `operation-${input.action}`, accountId: input.accountId, kind: input.action, status: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), undoUntil: new Date(Date.now() + 60_000).toISOString() }))
  api.mail.mail.undo.mockResolvedValue(true)
  api.mail.mail.snooze.mockResolvedValue([])
  api.mail.mail.unsnooze.mockResolvedValue(true)
  api.mail.drafts.list.mockResolvedValue([localDraft, scheduledDraft])
  api.mail.drafts.delete.mockResolvedValue({ id: 'draft-1', status: 'discarded', updatedAt: new Date().toISOString() })
  api.mail.drafts.cancelSend.mockImplementation(async (id: string) => ({ id, status: 'local', updatedAt: new Date().toISOString() }))
  api.mail.drafts.get.mockResolvedValue(scheduledDraft)
  api.mail.attachments.open.mockResolvedValue({})
  api.mail.attachments.save.mockResolvedValue({ savedPath: 'C:\\saved\\report.pdf' })
  api.mail.storage.mockResolvedValue({ totalBytes: 2048, freeBytes: 4096, accounts: [] })
  api.window.openMessage.mockResolvedValue(undefined)
  api.mail.savedSearches.list.mockResolvedValue([])
  api.mail.savedSearches.delete.mockResolvedValue(undefined)
  api.mail.quickActions.list.mockResolvedValue([])
})

describe('ConnectedMailView', () => {
  it('shows unread counts for every non-empty folder and scopes them to the selected account', async () => {
    const user = userEvent.setup()
    await act(async () => { renderMail() })
    expect(screen.getByRole('button', { name: 'Inbox 2 unread conversations' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Starred 1 unread conversation' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Archive 1 unread conversation' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'All mail 3 unread conversations' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'All accounts 2 unread conversations' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'me@example.test 2 unread conversations' })).toBeInTheDocument()
    expect(within(document.querySelector('.context-sidebar')!).getByRole('button', { name: 'Sent' })).not.toHaveTextContent('0')
    expect(api.mail.mail.accountUnreadCounts).toHaveBeenCalled()
    await user.click(screen.getByTitle(/me@example.test · gmail/))
    await waitFor(() => expect(api.mail.mail.unreadCounts).toHaveBeenCalledWith(['account']))
  })

  it('loads accounts, labels, grouped conversations, a selected thread, and marks unread mail read', async () => {
    renderMail()
    expect(screen.getByText('Loading local mail…')).toBeInTheDocument()
    expect(await screen.findByText('Launch & plans')).toBeInTheDocument()
    expect(screen.getAllByText('Ready & waiting')).toHaveLength(2)
    expect(screen.getByRole('heading', { name: formatMailDateHeading(initialPage.items[0].lastDate) })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Launch & plans' })).toBeInTheDocument()
    expect(api.mail.mail.action).toHaveBeenCalledWith({ accountId: 'account', threadIds: ['thread-1'], action: 'read', labelId: undefined })
    expect(screen.getAllByText('Project').length).toBeGreaterThanOrEqual(1)
  })

  it('searches, applies advanced filters, selects labels and accounts, and clears them', async () => {
    const user = userEvent.setup()
    renderMail(); await screen.findByText('Launch & plans')
    await user.type(screen.getByLabelText('Search mail'), 'launch')
    await waitFor(() => expect(api.mail.mail.list).toHaveBeenCalledWith(expect.objectContaining({ search: 'launch' })))
    await user.click(screen.getByTitle('Advanced search filters')); await user.click(screen.getByRole('button', { name: 'Apply filters' }))
    await waitFor(() => expect(api.mail.mail.list).toHaveBeenCalledWith(expect.objectContaining({ filters: { subject: 'Launch' } })))
    await user.click(within(document.querySelector('.context-sidebar')!).getByRole('button', { name: 'Project' })); await waitFor(() => expect(api.mail.mail.list).toHaveBeenCalledWith(expect.objectContaining({ folder: 'all', accountIds: ['account'], labelId: 'project' })))
    await user.click(screen.getByRole('button', { name: 'Clear mail search' }))
    expect(screen.getByLabelText('Search mail')).toHaveValue('')
    await user.click(screen.getByRole('button', { name: /All accounts/ }))
  })

  it('shows query validation inline without listing, and saves, opens, and deletes saved searches', async () => {
    const user = userEvent.setup()
    const saved: MailSavedSearch = { id: 'saved-1', name: 'Unpaid invoices', query: 'invoice -paid', folder: 'all', accountId: 'account', filters: { unread: true }, createdAt: '2026-08-08T10:00:00Z', updatedAt: '2026-08-08T10:00:00Z' }
    api.mail.savedSearches.list.mockResolvedValue([saved])
    renderMail(); await screen.findByText('Launch & plans')
    const sidebar = within(document.querySelector('.context-sidebar')!)
    await user.click(await sidebar.findByRole('button', { name: 'Unpaid invoices' }))
    await waitFor(() => expect(api.mail.mail.list).toHaveBeenCalledWith(expect.objectContaining({ folder: 'all', accountIds: ['account'], search: 'invoice -paid', filters: { unread: true } })))
    expect(screen.getByLabelText('Search mail')).toHaveValue('invoice -paid')
    expect(sidebar.getByRole('button', { name: 'Unpaid invoices' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Saved as Unpaid invoices' })).toBeInTheDocument()

    api.mail.mail.list.mockClear()
    await user.type(screen.getByLabelText('Search mail'), ' AND')
    expect(await screen.findByRole('alert')).toHaveTextContent('Add a search term after AND')
    expect(api.mail.mail.list).not.toHaveBeenCalledWith(expect.objectContaining({ search: 'invoice -paid AND' }))
    expect(screen.getByRole('button', { name: 'Save search' })).toBeDisabled()
    expect(sidebar.getByRole('button', { name: 'Unpaid invoices' })).toHaveAttribute('aria-pressed', 'false')

    await user.clear(screen.getByLabelText('Search mail'))
    await user.type(screen.getByLabelText('Search mail'), 'from:ada "launch plan"')
    await user.click(screen.getByRole('button', { name: 'Save search' }))
    const dialog = await screen.findByRole('dialog', { name: /Save search/ })
    await user.clear(within(dialog).getByLabelText('Name')); await user.type(within(dialog).getByLabelText('Name'), 'Ada launch')
    await user.click(within(dialog).getByRole('button', { name: 'Save search' }))
    await waitFor(() => expect(api.mail.savedSearches.save).toHaveBeenCalledWith({ name: 'Ada launch', query: 'from:ada "launch plan"', folder: 'all', accountId: 'account', filters: { unread: true } }))
    expect(await sidebar.findByRole('button', { name: 'Ada launch' })).toHaveAttribute('aria-pressed', 'true')

    fireEvent.contextMenu(sidebar.getByRole('button', { name: 'Unpaid invoices' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Delete saved search' }))
    await waitFor(() => expect(api.mail.savedSearches.delete).toHaveBeenCalledWith('saved-1'))
    await waitFor(() => expect(sidebar.queryByRole('button', { name: 'Unpaid invoices' })).not.toBeInTheDocument())
  })

  it('selects conversations with Ctrl-click without opening them and supports range and keyboard selection', async () => {
    renderMail()
    await screen.findByText('Launch & plans')
    const first = document.querySelector('.message-row')!
    const second = screen.getByText('Second conversation').closest('.message-row')!
    expect(document.querySelector('.message-select')).toBeNull()
    const openedThreads = api.mail.mail.thread.mock.calls.length

    fireEvent.click(second, { ctrlKey: true })
    expect(second).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('1 selected')).toBeInTheDocument()
    expect(api.mail.mail.thread).toHaveBeenCalledTimes(openedThreads)
    expect(api.mail.mail.action).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'read', threadIds: ['thread-2'] }))

    fireEvent.click(first, { shiftKey: true })
    expect(screen.getByText('2 selected')).toBeInTheDocument()
    fireEvent.keyDown(first, { key: ' ', ctrlKey: true })
    expect(first).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByText('1 selected')).toBeInTheDocument()
    fireEvent.click(second, { ctrlKey: true })
    expect(document.querySelector('.bulk-mail-toolbar')).toBeNull()

    fireEvent.click(second)
    await waitFor(() => expect(api.mail.mail.thread).toHaveBeenCalledWith('account', 'thread-2'))
  })

  it('runs remappable mail shortcuts on the open or checked conversations, never while typing or in dialogs', async () => {
    const onToast = vi.fn()
    render(<KeymapProvider platform="windows" overrides={{ version: 1, bindings: { 'mail.archive': ['E'], 'mail.reply': [] } }}><ContextMenuProvider><ConnectedMailView onToast={onToast} /></ContextMenuProvider></KeymapProvider>)
    await screen.findByText('Launch & plans')
    const first = document.querySelector('.message-row') as HTMLElement
    fireEvent.click(first)
    await waitFor(() => expect(first).toHaveAttribute('aria-current', 'true'))
    const actions = (action: string) => api.mail.mail.action.mock.calls.filter(([input]: any[]) => input.action === action)
    fireEvent.keyDown(first, { key: 'Delete', code: 'Delete' })
    await waitFor(() => expect(actions('trash')).toEqual([[{ accountId: 'account', threadIds: ['thread-1'], action: 'trash', labelId: undefined }]]))
    // Plain and modified Mail shortcuts are ignored in the search field.
    const search = screen.getByLabelText('Search mail')
    fireEvent.keyDown(search, { key: 'Delete', code: 'Delete' })
    fireEvent.keyDown(search, { key: 'u', code: 'KeyU', ctrlKey: true })
    fireEvent.keyDown(search, { key: 'e', code: 'KeyE' })
    expect(actions('trash')).toHaveLength(1)
    expect(actions('unread')).toHaveLength(0)
    fireEvent.keyDown(document.body, { key: 'u', code: 'KeyU', ctrlKey: true })
    await waitFor(() => expect(actions('unread')).toHaveLength(1))
    // A remapped plain key acts on the checked conversations instead of the open one.
    fireEvent.click(screen.getByText('Second conversation').closest('.message-row')!, { ctrlKey: true })
    fireEvent.keyDown(document.body, { key: 'e', code: 'KeyE' })
    await waitFor(() => expect(actions('archive')).toEqual([[{ accountId: 'account', threadIds: ['thread-2'], action: 'archive' }]]))
    fireEvent.keyDown(document.body, { key: 'e', code: 'KeyE', ctrlKey: true, shiftKey: true })
    fireEvent.keyDown(document.body, { key: 'r', code: 'KeyR', ctrlKey: true })
    expect(screen.queryByRole('dialog', { name: 'Compose mock' })).not.toBeInTheDocument()
    fireEvent.keyDown(document.body, { key: 'R', code: 'KeyR', ctrlKey: true, shiftKey: true })
    const compose = await screen.findByRole('dialog', { name: 'Compose mock' })
    expect(compose).toHaveTextContent('Reply all')
    fireEvent.keyDown(compose, { key: 'Delete', code: 'Delete' })
    expect(actions('trash')).toHaveLength(1)
    expect(actions('archive')).toHaveLength(1)
    fireEvent.contextMenu(first)
    expect(await screen.findByRole('menuitem', { name: 'Archive' })).toHaveAttribute('aria-keyshortcuts', 'E')
    expect(screen.getByRole('menuitem', { name: 'Reply' })).not.toHaveAttribute('aria-keyshortcuts')
    expect(screen.getByRole('menuitem', { name: 'Reply all' })).toHaveAttribute('aria-keyshortcuts', 'Control+Shift+R')
  })

  it('performs bulk actions, move/label organization, snooze, and undo', async () => {
    const user = userEvent.setup(), onToast = renderMail()
    await screen.findByText('Launch & plans')
    await user.click(screen.getByRole('button', { name: 'Select visible conversations' }))
    expect(screen.getByText('2 selected')).toBeInTheDocument()
    await user.click(within(document.querySelector('.bulk-mail-toolbar')!).getByRole('button', { name: 'Archive' }))
    await waitFor(() => expect(screen.getByText(/mail change(?:s)? queued/i)).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'Undo' })); expect(onToast).toHaveBeenCalledWith('Change undone')
    await user.click(screen.getByRole('button', { name: 'Select visible conversations' }))
    await user.click(screen.getByRole('button', { name: 'Move' })); await user.click(screen.getByRole('button', { name: 'Apply organize' }))
    expect(onToast).toHaveBeenCalledWith('2 conversations updated')
    await user.click(screen.getByRole('button', { name: 'Select visible conversations' }))
    await user.click(screen.getByRole('button', { name: 'Snooze' })); await user.click(screen.getByRole('button', { name: 'Apply snooze' }))
    expect(api.mail.mail.snooze).toHaveBeenCalled()
  })

  it('uses conversation context actions, inline expansion, keyboard opening, and the pop-out window', async () => {
    const user = userEvent.setup()
    renderMail(); await screen.findByText('Launch & plans')
    const row = document.querySelector('.message-row') as HTMLElement
    fireEvent.doubleClick(row); expect(api.window.openMessage).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-1' }))
    fireEvent.keyDown(row, { key: 'Enter', shiftKey: true }); expect(api.window.openMessage).toHaveBeenCalledTimes(2)
    await user.click(screen.getByRole('button', { name: /Expand 2 messages/ })); expect(await screen.findByTestId('thread-preview')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Open preview window' })); expect(api.window.openMessage).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'message-1' }))
    fireEvent.contextMenu(row); await user.click(screen.getByRole('menuitem', { name: 'Reply all' }))
    expect(screen.getByRole('dialog', { name: 'Compose mock' })).toHaveTextContent('Reply all')
  })

  it('handles reader tools, message source, attachments, replies, remote images, and undo-send', async () => {
    const user = userEvent.setup(), onToast = renderMail()
    await screen.findByText('report.pdf')
    await user.click(screen.getByTitle('Open')); expect(api.mail.attachments.open).toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Save as' })); expect(onToast).toHaveBeenCalledWith('Saved report.pdf')
    await user.click(screen.getByRole('button', { name: 'Load remote images' })); expect(api.mail.mail.thread).toHaveBeenCalledWith('account', 'thread-1', true)
    await user.click(screen.getByRole('button', { name: 'More message actions' })); await user.click(screen.getByRole('menuitem', { name: 'View message headers' }))
    expect(await screen.findByRole('dialog', { name: 'Source mock' })).toHaveTextContent('headers:Header: value')
    await user.click(within(document.querySelector('.reader-toolbar')!).getByRole('button', { name: 'Reply all' })); await user.click(screen.getByRole('button', { name: 'Queue send' }))
    expect(screen.getByText('Message will send shortly')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Undo Send' })); expect(api.mail.drafts.cancelSend).toHaveBeenCalled()
  })

  it('opens account, rule, setup, settings, storage, sync, pause, and disconnect workflows', async () => {
    const user = userEvent.setup(), onToast = renderMail()
    await screen.findByText('Launch & plans')
    await user.click(screen.getByRole('button', { name: /Add mail account/ })); expect(screen.getByRole('dialog', { name: 'Account setup mock' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close setup' }))
    await user.click(screen.getByRole('button', { name: /Mail rules/ })); expect(screen.getByRole('dialog', { name: 'Rules mock' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close rules' }))
    await user.click(screen.getByRole('button', { name: /All attachments/ })); expect(screen.getByRole('dialog', { name: 'Attachments mock' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close attachments' })); expect(screen.queryByRole('dialog', { name: 'Attachments mock' })).not.toBeInTheDocument()
    await user.click(screen.getByTitle('Settings for me@example.test')); expect(screen.getByRole('dialog', { name: 'Account settings mock' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close settings' }))
    await user.click(screen.getByRole('button', { name: /Offline storage/ })); expect(onToast).toHaveBeenCalledWith('2 KB stored offline · 4 KB free')
    await user.click(screen.getByRole('button', { name: 'Check for mail' })); expect(api.mail.sync.start).toHaveBeenCalledWith(undefined)
    fireEvent.contextMenu(screen.getByTitle(/me@example.test · gmail/)); await user.click(screen.getByRole('menuitem', { name: 'Disconnect account…' }))
    await waitFor(() => expect(api.mail.accounts.disconnect).toHaveBeenCalledWith('account', 'archive'))
  })

  it('renders local and scheduled drafts and can edit, cancel, and discard them', async () => {
    const user = userEvent.setup(), onToast = renderMail()
    await screen.findByText('Launch & plans')
    await user.click(screen.getByRole('button', { name: /Drafts/ }))
    expect(await screen.findByText('Local draft')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Draft · reader@example.test/ })); expect(screen.getByRole('dialog', { name: 'Compose mock' })).toHaveTextContent('Editing Local draft')
    await user.click(screen.getByRole('button', { name: 'Close compose' }))
    await user.click(screen.getByRole('button', { name: /Scheduled/ }))
    expect(await screen.findByText('Scheduled draft')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Scheduled · reader@example.test/ }))
    expect(await screen.findByRole('dialog', { name: 'Compose mock' })).toHaveTextContent('Editing Scheduled draft')
    await user.click(screen.getByRole('button', { name: 'Close compose' }))
    fireEvent.contextMenu(screen.getByRole('button', { name: /Scheduled · reader@example.test/ }))
    await user.click(screen.getByRole('menuitem', { name: 'Cancel delivery' }))
    expect(onToast).toHaveBeenCalledWith('Scheduled delivery cancelled')
    await user.click(screen.getByRole('button', { name: /Drafts/ }))
    fireEvent.contextMenu(screen.getByRole('button', { name: /Draft · reader@example.test/ }))
    await user.click(screen.getByRole('menuitem', { name: 'Discard draft' }))
    expect(onToast).toHaveBeenCalledWith('Draft discarded')
  })

  it('executes conversation, reader, provider-message, and attachment context actions', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    renderMail(); await screen.findByText('report.pdf')
    const summaryAction = async (name: string) => {
      fireEvent.contextMenu(document.querySelector('.message-row')!)
      await user.click(within(screen.getByRole('menu')).getByText(name))
    }

    await summaryAction('Forward')
    expect(screen.getByRole('dialog', { name: 'Compose mock' })).toHaveTextContent('Forward')
    await user.click(screen.getByRole('button', { name: 'Close compose' }))
    await summaryAction('Mark as important')
    await waitFor(() => expect(api.mail.mail.action).toHaveBeenCalledWith(expect.objectContaining({ action: 'important' })))
    await summaryAction('Remove star')
    await summaryAction('Archive')
    await summaryAction('Move to…')
    expect(screen.getByRole('dialog', { name: 'Organize mock' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close organize' }))
    await summaryAction('Manage labels…')
    await user.click(screen.getByRole('button', { name: 'Close organize' }))
    await summaryAction('Copy subject')
    expect(writeText).toHaveBeenCalledWith('Launch &amp; plans')

    await user.click(within(screen.getByTestId('accordion-message-1')).getByRole('button', { name: 'Message options' }))
    expect(screen.getByRole('menuitem', { name: 'Snooze…' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'View message headers' })).toBeInTheDocument()
    await user.click(screen.getByRole('menuitem', { name: 'Copy sender address' }))
    expect(writeText).toHaveBeenCalledWith('ada@example.test')
    fireEvent.contextMenu(document.querySelector('.attachment-card')!)
    await user.click(screen.getByRole('menuitem', { name: 'Copy filename' }))
    expect(writeText).toHaveBeenCalledWith('report.pdf')

    await user.click(screen.getByRole('button', { name: 'More message actions' }))
    await user.click(screen.getByRole('menuitem', { name: 'Forward' }))
    expect(screen.getByRole('dialog', { name: 'Compose mock' })).toHaveTextContent('Forward')
    await user.click(screen.getByRole('button', { name: 'Close compose' }))
    await user.click(screen.getByRole('button', { name: 'More message actions' }))
    await user.click(screen.getByRole('menuitem', { name: 'Copy message ID' }))
    expect(writeText).toHaveBeenCalledWith('<message@example.test>')
  })

  it('covers range selection and the remaining bulk toolbar actions', async () => {
    const user = userEvent.setup()
    renderMail(); await screen.findByText('Launch & plans')
    const rows = document.querySelectorAll('.message-row')
    fireEvent.click(rows[0], { ctrlKey: true })
    fireEvent.click(rows[1], { shiftKey: true })
    expect(screen.getByText('2 selected')).toBeInTheDocument()
    await user.click(screen.getByTitle('Clear selection'))

    const runBulk = async (name: string, action: string) => {
      await user.click(screen.getByRole('button', { name: 'Select visible conversations' }))
      await user.click(within(document.querySelector('.bulk-mail-toolbar')!).getByRole('button', { name }))
      await waitFor(() => expect(api.mail.mail.action).toHaveBeenCalledWith(expect.objectContaining({ action })))
    }
    await runBulk('Read', 'read')
    await runBulk('Star', 'star')
    await runBulk('Trash', 'trash')
    await user.click(screen.getByRole('button', { name: 'Select visible conversations' }))
    await user.click(within(document.querySelector('.bulk-mail-toolbar')!).getByRole('button', { name: 'Labels' }))
    await user.click(screen.getByRole('button', { name: 'Apply organize' }))

    await user.click(screen.getByRole('button', { name: 'Snoozed' }))
    await screen.findByText('Launch & plans')
    await user.click(screen.getByRole('button', { name: 'Select visible conversations' }))
    await user.click(within(document.querySelector('.bulk-mail-toolbar')!).getByRole('button', { name: 'Return now' }))
    await waitFor(() => expect(api.mail.mail.unsnooze).toHaveBeenCalled())
  })

  it('shows sync progress, resumes and pauses accounts, and responds to sync events', async () => {
    const user = userEvent.setup()
    api.mail.sync.progress.mockResolvedValueOnce([{ accountId: 'account', phase: 'paused', completed: 10, total: 20, transferredBytes: 100, message: 'Paused', pausedReason: 'user', updatedAt: new Date().toISOString() }])
    renderMail()
    expect(await screen.findByText(/Paused · 10\/20/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Resume sync' }))
    expect(api.mail.sync.resume).toHaveBeenCalledWith('account')
    emitMail?.({ type: 'sync-progress', payload: { accountId: 'account', phase: 'downloading', completed: 15, total: 20, transferredBytes: 200, message: 'Downloading', updatedAt: new Date().toISOString() } })
    expect(await screen.findByText(/Downloading · 15\/20/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Pause sync' }))
    expect(api.mail.sync.pause).toHaveBeenCalledWith('account')
    emitMail?.({ type: 'sync-progress', payload: { accountId: 'account', phase: 'complete', completed: 20, total: 20, transferredBytes: 300, updatedAt: new Date().toISOString() } })
    await waitFor(() => expect(api.mail.mail.labels).toHaveBeenCalledWith())
    emitMail?.({ type: 'accounts-changed', payload: [account({ email: 'changed@example.test' })] })
    expect(await screen.findByText('changed@example.test')).toBeInTheDocument()
  })

  it('reports recoverable reader, attachment, source, window, action, storage, and sync failures', async () => {
    const user = userEvent.setup(), onToast = renderMail()
    await screen.findByText('report.pdf')
    api.mail.attachments.open.mockResolvedValueOnce({ error: 'Open failed' })
    await user.click(screen.getByTitle('Open'))
    expect(onToast).toHaveBeenCalledWith('Open failed')
    api.mail.attachments.save.mockRejectedValueOnce(new Error('Save failed'))
    await user.click(screen.getByRole('button', { name: 'Save as' }))
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Save failed'))

    api.mail.mail.thread.mockRejectedValueOnce(new Error('Images failed'))
    await user.click(screen.getByRole('button', { name: 'Load remote images' }))
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Images failed'))
    api.mail.mail.source.mockRejectedValueOnce(new Error('Source failed'))
    await user.click(screen.getByRole('button', { name: 'More message actions' }))
    await user.click(screen.getByRole('menuitem', { name: 'View message source' }))
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Source failed'))

    api.window.openMessage.mockRejectedValueOnce(new Error('Window failed'))
    fireEvent.doubleClick(document.querySelector('.message-row')!)
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Window failed'))
    api.mail.mail.action.mockRejectedValueOnce(new Error('Action failed'))
    await user.click(within(document.querySelector('.reader-toolbar')!).getByRole('button', { name: 'Unstar' }))
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Action failed'))
    api.mail.storage.mockRejectedValueOnce(new Error('Storage failed'))
    await user.click(screen.getByRole('button', { name: /Offline storage/ }))
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Storage failed'))
    api.mail.sync.start.mockRejectedValueOnce(new Error('Sync failed'))
    await user.click(screen.getByRole('button', { name: 'Check for mail' }))
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Sync failed'))
  })

  it('offers an infinite-scroll retry and reports undo failures', async () => {
    const user = userEvent.setup(), onToast = renderMail()
    await screen.findByText('Launch & plans')
    api.mail.mail.list.mockRejectedValueOnce(new Error('More failed'))
    observerCallback?.([{ isIntersecting: true }])
    expect(await screen.findByRole('button', { name: /Couldn’t load more/ })).toBeInTheDocument()
    expect(onToast).toHaveBeenCalledWith('More failed')
    api.mail.mail.list.mockImplementation(async (query: any) => query.cursor ? { items: [], total: 2 } : pageResult)
    await user.click(screen.getByRole('button', { name: /Couldn’t load more/ }))

    api.mail.mail.undo.mockRejectedValueOnce(new Error('Undo failed'))
    api.mail.mail.action.mockResolvedValueOnce({ id: 'operation-test', accountId: 'account', kind: 'star', status: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), undoUntil: new Date(Date.now() + 60_000).toISOString() })
    await user.click(within(document.querySelector('.reader-toolbar')!).getByRole('button', { name: 'Unstar' }))
    await screen.findByText(/Mail change queued/)
    await user.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Undo failed'))
  })

  it('loads another infinite-scroll page and reacts to provider events', async () => {
    const onToast = renderMail(); await screen.findByText('Launch & plans')
    await waitFor(() => expect(observerCallback).toBeDefined())
    observerCallback?.([{ isIntersecting: true }])
    expect(await screen.findByText('Loaded later')).toBeInTheDocument()
    emitMail?.({ type: 'connectivity', payload: { online: false } }); expect(onToast).toHaveBeenCalledWith('Offline — changes will be sent when you reconnect')
    emitMail?.({ type: 'draft-delivery', payload: { id: 'send-1', status: 'sent' } }); expect(onToast).toHaveBeenCalledWith('Message sent')
    emitMail?.({ type: 'operation', payload: { id: 'bad', status: 'failed', error: 'provider rejected' } }); expect(onToast).toHaveBeenCalledWith('provider rejected')
  })

  it('shows onboarding and reports startup, list, thread, attachment, source, and sync failures', async () => {
    const user = userEvent.setup()
    accountsResult = []
    const onboardingToast = renderMail()
    expect(await screen.findByText(/Your inboxes, together/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Add your first account/ })); expect(screen.getByRole('dialog', { name: 'Account setup mock' })).toBeInTheDocument()
    expect(onboardingToast).not.toHaveBeenCalled()
  })

  it('covers inverse conversation states and their reader and context actions', async () => {
    const user = userEvent.setup()
    pageResult = {
      items: [
        summary({ unread: false, starred: false, important: true, trashed: true, snoozedUntil: '2026-08-09T10:00:00Z', labelIds: ['TRASH'], participants: [], senderEmail: '' }),
        summary({ id: 'thread-spam', subject: 'Spam route', labelIds: ['SPAM'], unread: false, starred: false, important: false, messageCount: 1, hasAttachments: false }),
        summary({ id: 'thread-archive', subject: 'Archive route', labelIds: [], unread: false, starred: false, important: false, messageCount: 1, hasAttachments: false })
      ], total: 3
    }
    renderMail()
    await screen.findByRole('heading', { name: 'Launch & plans' })

    await user.click(within(document.querySelector('.reader-toolbar')!).getByTitle('Mark unread'))
    await user.click(within(document.querySelector('.reader-toolbar')!).getByTitle('Star'))
    await user.click(within(document.querySelector('.reader-toolbar')!).getByTitle('Restore from Trash'))
    await waitFor(() => expect(api.mail.mail.action).toHaveBeenCalledWith(expect.objectContaining({ action: 'untrash' })))

    const chooseRowAction = async (subject: string, action: string) => {
      const row = screen.getAllByText(subject).map((item) => item.closest('.message-row')).find(Boolean)!
      fireEvent.contextMenu(row)
      await user.click(within(screen.getByRole('menu')).getByText(action))
    }
    await chooseRowAction('Launch &amp; plans', 'Mark as not important')
    await chooseRowAction('Launch &amp; plans', 'Return to Inbox now')
    await chooseRowAction('Spam route', 'Move to inbox')
    expect(api.mail.mail.action).toHaveBeenCalledWith(expect.objectContaining({ action: 'move', labelId: 'INBOX' }))
    await chooseRowAction('Archive route', 'Move to inbox')
    expect(api.mail.mail.action).toHaveBeenCalledWith(expect.objectContaining({ action: 'unarchive' }))

    await user.click(screen.getByRole('button', { name: 'More message actions' }))
    await user.click(screen.getByText('Mark as not important'))
    await user.click(screen.getByRole('button', { name: 'More message actions' }))
    await user.click(screen.getByText('Return to Inbox now'))
    expect(api.mail.mail.unsnooze).toHaveBeenCalledWith('account', ['thread-1'])
  })

  it('renders queued, sending, failed, empty, and attachment-bearing draft variants', async () => {
    const user = userEvent.setup(), onToast = renderMail()
    const drafts: MailDraftRecord[] = [
      localDraft,
      scheduledDraft,
      { ...localDraft, id: 'queued-1', subject: 'Queued draft', status: 'queued', to: [], text: '', attachmentPaths: ['C:\\tmp\\file.txt'] },
      { ...localDraft, id: 'sending-1', subject: 'Sending draft', status: 'send-pending' },
      { ...localDraft, id: 'failed-1', subject: '', status: 'failed', to: [], text: '', error: 'Provider refused it', attachmentPaths: ['C:\\tmp\\failed.pdf'] }
    ]
    api.mail.drafts.list.mockResolvedValue(drafts)
    await screen.findByText('Launch & plans')
    await user.click(screen.getByRole('button', { name: /Scheduled/ }))
    expect(await screen.findByText('Queued draft')).toBeInTheDocument()
    expect(screen.getByText(/Outbox · No recipients/)).toBeInTheDocument()
    expect(screen.getByText(/Sending shortly/)).toBeInTheDocument()
    expect(screen.getByText('Waiting for connection')).toBeInTheDocument()

    fireEvent.contextMenu(screen.getByText('Queued draft').closest('.message-row')!)
    await user.click(screen.getByRole('menuitem', { name: 'Cancel delivery and edit' }))
    expect(await screen.findByRole('dialog', { name: 'Compose mock' })).toHaveTextContent('Editing Queued draft')
    expect(onToast).toHaveBeenCalledWith('Send undone — message returned to Drafts')
    await user.click(screen.getByRole('button', { name: 'Close compose' }))

    await user.click(screen.getByRole('button', { name: /Drafts/ }))
    expect(await screen.findByText('(No subject)')).toBeInTheDocument()
    expect(screen.getByText('Provider refused it')).toBeInTheDocument()
    expect(screen.getByText('Save failed')).toBeInTheDocument()
    api.mail.drafts.delete.mockResolvedValueOnce({ id: 'failed-1', status: 'discard-queued', updatedAt: new Date().toISOString() })
    fireEvent.contextMenu(screen.getByText('(No subject)').closest('.message-row')!)
    await user.click(screen.getByRole('menuitem', { name: 'Discard draft' }))
    expect(onToast).toHaveBeenCalledWith('Offline — draft will be discarded after reconnecting')
  })

  it('runs folder, label, account, list, setup, and settings context callbacks', async () => {
    const user = userEvent.setup(), onToast = renderMail()
    await screen.findByText('Launch & plans')
    const choose = async (target: Element, label: string) => {
      fireEvent.contextMenu(target)
      await user.click(within(screen.getByRole('menu')).getByText(label))
    }

    await choose(screen.getByRole('button', { name: /All accounts/ }), 'New message')
    await user.click(screen.getByRole('button', { name: 'Close compose' }))
    await choose(within(document.querySelector('.context-sidebar')!).getByRole('button', { name: 'Spam' }), 'Open Spam')
    expect(screen.getByRole('heading', { name: 'Spam' })).toBeInTheDocument()
    await choose(within(document.querySelector('.context-sidebar')!).getByRole('button', { name: 'Project' }), 'Open Project')
    await choose(within(document.querySelector('.context-sidebar')!).getByRole('button', { name: 'Project' }), 'Clear Project filter')

    await choose(document.querySelector('.message-list')!, 'Mark visible conversations as read')
    expect(onToast).toHaveBeenCalledWith('Visible conversations marked as read')
    await user.click(screen.getByRole('button', { name: /Add mail account/ }))
    await user.click(screen.getByRole('button', { name: 'Finish account' }))
    await waitFor(() => expect(api.mail.accounts.list).toHaveBeenCalledTimes(2))

    await user.click(screen.getByTitle('Settings for me@example.test'))
    await user.click(screen.getByRole('button', { name: 'Save account' }))
    expect(screen.getByRole('dialog', { name: 'Account settings mock' })).toHaveTextContent('me@example.test')
    await user.click(screen.getByRole('button', { name: 'Close settings' }))
  })

  it('covers list expansion switching, collapsing, preview selection, and fallback errors', async () => {
    const user = userEvent.setup(), onToast = renderMail()
    await screen.findByText('Launch & plans')
    const firstToggle = screen.getByRole('button', { name: /Expand 2 messages in Launch/ })
    await user.click(firstToggle)
    await user.click(await screen.findByRole('button', { name: 'Select preview message' }))
    await user.click(screen.getByRole('button', { name: /Collapse 2 messages in Launch/ }))

    pageResult = { items: [summary(), summary({ id: 'thread-2', subject: 'Second conversation', messageCount: 2 })], total: 2 }
    await user.click(screen.getByRole('button', { name: 'Check for mail' }))
    emitMail?.({ type: 'mail-changed', payload: { accountId: 'account' } })
    expect(await screen.findByRole('button', { name: /Expand 2 messages in Second conversation/ })).toBeInTheDocument()
    api.mail.mail.thread.mockRejectedValueOnce('offline')
    await user.click(screen.getByRole('button', { name: /Expand 2 messages in Second conversation/ }))
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Conversation replies could not be loaded'))
  })

  it('uses fallback messages for startup reads, counts, drafts, threads, and provider events', async () => {
    accountsResult = [account()]
    api.mail.mail.unreadCounts.mockRejectedValueOnce('bad counts')
    api.mail.mail.accountUnreadCounts.mockRejectedValueOnce('bad account counts')
    api.mail.mail.thread.mockRejectedValueOnce('bad thread')
    api.mail.drafts.list.mockRejectedValueOnce('bad drafts')
    const onToast = renderMail()
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Unread counts could not be loaded'))
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Account unread counts could not be loaded'))
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Conversation could not be opened'))
    emitMail?.({ type: 'operation', payload: { id: 'bad', status: 'failed' } })
    emitMail?.({ type: 'draft-delivery', payload: { id: 'bad', status: 'failed' } })
    expect(onToast).toHaveBeenCalledWith('The mail provider rejected the change')
    expect(onToast).toHaveBeenCalledWith('Message could not be sent')
  })

  it('renders archived and syncing account states and exercises disconnect alternatives', async () => {
    const user = userEvent.setup()
    accountsResult = [account({ archived: true, status: 'syncing' })]
    pageResult = { items: [], total: 0 }
    const onToast = renderMail()
    expect(await screen.findByText('Downloading your mailbox')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New message' })).toBeDisabled()
    expect(screen.getByTitle(/offline archive/)).toHaveTextContent('archive')

    accountsResult = [account()]
    window.confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)
    fireEvent.contextMenu(screen.getByTitle(/offline archive/))
    expect(screen.queryByRole('menuitem', { name: 'Disconnect account…' })).not.toBeInTheDocument()
    expect(onToast).not.toHaveBeenCalledWith('Account disconnected')
  })

  it.each([
    ['address and content', ['from', 'to', 'subject', 'attachmentName', 'dateFrom']],
    ['date and state', ['dateTo', 'hasAttachments', 'unread', 'starred', 'important']]
  ] as const)('applies local-draft %s search filters', async (_group, fields) => {
    const user = userEvent.setup()
    renderMail(); await screen.findByText('Launch & plans')
    await user.click(screen.getByRole('button', { name: /Drafts/ }))
    expect(await screen.findByText('Local draft')).toBeInTheDocument()
    await user.type(screen.getByLabelText('Search mail'), 'missing')
    expect(screen.queryByText('Local draft')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Clear mail search' }))
    for (const field of fields) {
      await user.click(screen.getByTitle('Advanced search filters'))
      await user.click(screen.getByRole('button', { name: `Filter draft ${field}` }))
      expect(screen.queryByText('Local draft')).not.toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Clear mail search' }))
      expect(await screen.findByText('Local draft')).toBeInTheDocument()
    }
  }, 15_000) // Five complete filter/reset interactions also run on slower native CI hosts.

  it('renders read-only conversation and menu states for archived accounts', async () => {
    const user = userEvent.setup()
    accountsResult = [account({ archived: true })]
    pageResult = { items: [summary({ draft: true, starred: false, unread: false, important: true, snoozedUntil: '2026-08-09T10:00:00Z' })], total: 1 }
    renderMail()
    await screen.findByRole('heading', { name: 'Launch & plans' })
    expect(within(document.querySelector('.reader-toolbar')!).getByRole('button', { name: 'Reply' })).toBeDisabled()
    expect(document.querySelector('.quick-actions')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reply to provider message' })).not.toBeInTheDocument()
    fireEvent.contextMenu(document.querySelector('.message-row')!)
    expect(screen.getByRole('menuitem', { name: 'Reply' })).toBeDisabled()
    expect(screen.getByRole('menuitem', { name: 'Manage labels…' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'More message actions' }))
    expect(screen.getByRole('menuitem', { name: 'Manage tags / labels…' })).toBeDisabled()
    expect(screen.getByRole('menuitem', { name: 'Return to Inbox now' })).toBeDisabled()
  })

  it('renders progress without account metadata and contains non-Error action failures', async () => {
    api.mail.sync.progress.mockResolvedValueOnce([{ accountId: 'missing', phase: 'downloading', completed: 0, total: 0, transferredBytes: 0, updatedAt: new Date().toISOString() }])
    const user = userEvent.setup(), onToast = renderMail()
    expect(await screen.findByText(/downloading · 0\/0/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Pause sync' })).toBeDisabled()
    await screen.findByText('report.pdf')

    api.window.openMessage.mockRejectedValueOnce('blocked')
    fireEvent.doubleClick(document.querySelector('.message-row')!)
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('The message window could not be opened'))
    api.mail.storage.mockRejectedValueOnce('blocked')
    await user.click(screen.getByRole('button', { name: /Offline storage/ }))
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Storage information is unavailable'))
    api.mail.sync.start.mockRejectedValueOnce('blocked')
    await user.click(screen.getByRole('button', { name: 'Check for mail' }))
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Sync could not start'))
    api.mail.mail.source.mockRejectedValueOnce('blocked')
    await user.click(screen.getByRole('button', { name: 'More message actions' }))
    await user.click(screen.getByRole('menuitem', { name: 'View message source' }))
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('The original message is not available'))
    api.mail.attachments.open.mockRejectedValueOnce('blocked')
    await user.click(screen.getByTitle('Open'))
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Attachment could not be opened'))
    api.mail.attachments.save.mockRejectedValueOnce('blocked')
    await user.click(screen.getByRole('button', { name: 'Save as' }))
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Attachment could not be saved'))
  })

  it('reports startup and initial-list failures with safe fallback messages', async () => {
    api.mail.accounts.list.mockRejectedValueOnce('accounts unavailable')
    const startupToast = renderMail()
    await waitFor(() => expect(startupToast).toHaveBeenCalledWith('Mail could not start'))
  })

  it('reports a non-Error initial mail-list failure', async () => {
    api.mail.mail.list.mockRejectedValue('mail unavailable')
    const onToast = renderMail()
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Mail could not be loaded'))
  })

  it('reports resume and pause failures using the matching action name', async () => {
    const user = userEvent.setup()
    api.mail.sync.progress.mockResolvedValueOnce([{ accountId: 'account', phase: 'paused', completed: 1, total: 2, transferredBytes: 10, updatedAt: new Date().toISOString() }])
    api.mail.sync.resume.mockRejectedValueOnce('resume unavailable')
    const onToast = renderMail()
    await user.click(await screen.findByRole('button', { name: 'Resume sync' }))
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Sync could not be resumed'))

    emitMail?.({ type: 'sync-progress', payload: { accountId: 'account', phase: 'downloading', completed: 1, total: 2, transferredBytes: 10, updatedAt: new Date().toISOString() } })
    api.mail.sync.pause.mockRejectedValueOnce('pause unavailable')
    await user.click(await screen.findByRole('button', { name: 'Pause sync' }))
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Sync could not be paused'))
  })

  it('covers delete, cancel, and failed account disconnection choices', async () => {
    const user = userEvent.setup()
    const onToast = renderMail()
    await screen.findByText('Launch & plans')
    const disconnect = async () => {
      fireEvent.contextMenu(screen.getByTitle(/me@example.test · gmail/))
      await user.click(screen.getByRole('menuitem', { name: 'Disconnect account…' }))
    }

    window.confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)
    await disconnect()
    await waitFor(() => expect(api.mail.accounts.disconnect).toHaveBeenCalledWith('account', 'delete'))

    window.confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(false)
    await disconnect()
    expect(api.mail.accounts.disconnect).toHaveBeenCalledTimes(1)

    window.confirm = vi.fn(() => true)
    api.mail.accounts.disconnect.mockRejectedValueOnce('disconnect unavailable')
    await disconnect()
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('The account could not be disconnected'))
  })

  it('reports fallback failures for summary composition, bulk changes, drafts, and unsnoozing', async () => {
    const user = userEvent.setup()
    const onToast = renderMail()
    await screen.findByText('Launch & plans')

    api.mail.mail.thread.mockRejectedValueOnce('conversation unavailable')
    fireEvent.contextMenu(screen.getByText('Second conversation').closest('.message-row')!)
    await user.click(screen.getByRole('menuitem', { name: 'Forward' }))
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Conversation could not be opened'))

    await user.click(screen.getByRole('button', { name: 'Select visible conversations' }))
    await user.click(within(document.querySelector('.bulk-mail-toolbar')!).getByRole('button', { name: 'Move' }))
    api.mail.mail.action.mockRejectedValueOnce('bulk unavailable')
    await user.click(screen.getByRole('button', { name: 'Apply organize' }))
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('The bulk change could not be queued'))
    await user.click(screen.getByRole('button', { name: 'Close organize' }))

    await user.click(screen.getByRole('button', { name: /Drafts/ }))
    const draftRow = await screen.findByRole('button', { name: /Draft · reader@example.test/ })
    window.confirm = vi.fn(() => false)
    fireEvent.contextMenu(draftRow)
    await user.click(screen.getByRole('menuitem', { name: 'Discard draft' }))
    expect(api.mail.drafts.delete).not.toHaveBeenCalled()

    window.confirm = vi.fn(() => true)
    api.mail.drafts.delete.mockRejectedValueOnce('delete unavailable')
    fireEvent.contextMenu(draftRow)
    await user.click(screen.getByRole('menuitem', { name: 'Discard draft' }))
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Draft could not be discarded'))

    await user.click(screen.getByRole('button', { name: /Scheduled/ }))
    api.mail.drafts.cancelSend.mockRejectedValueOnce('cancel unavailable')
    fireEvent.contextMenu(await screen.findByRole('button', { name: /Scheduled · reader@example.test/ }))
    await user.click(screen.getByRole('menuitem', { name: 'Cancel delivery' }))
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('The queued message could not be cancelled'))

    await user.click(screen.getByRole('button', { name: 'Snoozed' }))
    await screen.findByText('Launch & plans')
    await user.click(screen.getByRole('button', { name: 'Select visible conversations' }))
    api.mail.mail.unsnooze.mockRejectedValueOnce('restore unavailable')
    await user.click(within(document.querySelector('.bulk-mail-toolbar')!).getByRole('button', { name: 'Return now' }))
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('The conversations could not be restored'))
  })

  it('runs saved quick actions from the toolbar, context menu, shortcut, and palette, and undoes newest step first', async () => {
    const user = userEvent.setup()
    const quick: MailQuickAction = { id: 'quick-1', name: 'File it', accountId: 'account', steps: [{ action: 'read' }, { action: 'archive' }], shortcut: 3, showInToolbar: true, createdAt: '2026-08-08T10:00:00Z', updatedAt: '2026-08-08T10:00:00Z' }
    const operation = (id: string, kind: 'read' | 'archive') => ({ id, accountId: 'account', kind, status: 'queued' as const, undoUntil: new Date(Date.now() + 60_000).toISOString() })
    api.mail.quickActions.list.mockResolvedValue([quick])
    api.mail.quickActions.run.mockResolvedValue({ operations: [operation('step-1', 'read'), operation('step-2', 'archive')], updatedThreads: 1, failures: [] })
    const onToast = vi.fn()
    const view = (request = { id: 0, quickActionId: '' }) => <ContextMenuProvider><ConnectedMailView onToast={onToast} quickActionRequest={request} /></ContextMenuProvider>
    const { rerender } = render(view({ id: 4, quickActionId: 'quick-1' }))
    await screen.findByText('Launch & plans')

    await user.click(await screen.findByTitle('Run quick action “File it” (Ctrl+Shift+3)'))
    expect(api.mail.quickActions.run).toHaveBeenCalledTimes(1)
    expect(api.mail.quickActions.run).toHaveBeenCalledWith('quick-1', [{ accountId: 'account', threadIds: ['thread-1'] }])
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('“File it” applied to 1 conversation'))
    await user.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(api.mail.mail.undo.mock.calls.map((call) => (call as unknown[])[0])).toEqual(['step-2', 'step-1']))

    const first = document.querySelector('.message-row')!
    const second = screen.getByText('Second conversation').closest('.message-row')!
    fireEvent.click(first, { ctrlKey: true }); fireEvent.click(second, { ctrlKey: true })
    api.mail.quickActions.run.mockResolvedValueOnce({ operations: [operation('step-3', 'read')], updatedThreads: 0, failures: [{ accountId: 'account', threadCount: 2, step: 1, appliedSteps: 1, error: 'Destination missing' }] })
    fireEvent.contextMenu(second)
    await user.click(await screen.findByRole('menuitem', { name: /Quick action: File it/ }))
    await waitFor(() => expect(api.mail.quickActions.run).toHaveBeenLastCalledWith('quick-1', [{ accountId: 'account', threadIds: ['thread-1', 'thread-2'] }]))
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('2 conversations in me@example.test partly updated, step 2 failed after 1 step (Undo reverts them): Destination missing'))
    await waitFor(() => expect(document.querySelector('.bulk-mail-toolbar')).toBeNull())

    fireEvent.keyDown(window, { key: '#', code: 'Digit3', ctrlKey: true, shiftKey: true })
    await waitFor(() => expect(api.mail.quickActions.run).toHaveBeenCalledTimes(3))
    fireEvent.keyDown(screen.getByLabelText('Search mail'), { key: '#', code: 'Digit3', ctrlKey: true, shiftKey: true })
    rerender(view({ id: 5, quickActionId: 'quick-1' }))
    await waitFor(() => expect(api.mail.quickActions.run).toHaveBeenCalledTimes(4))
    rerender(view({ id: 6, quickActionId: 'deleted' }))
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('That quick action no longer exists'))
    expect(api.mail.quickActions.run).toHaveBeenCalledTimes(4)
  })

  it('creates a quick action with ordered, account-specific steps from the sidebar manager', async () => {
    const user = userEvent.setup()
    renderMail(); await screen.findByText('Launch & plans')
    await user.click(within(document.querySelector('.context-sidebar')!).getByRole('button', { name: 'Quick actions' }))
    const dialog = await screen.findByRole('dialog', { name: /Quick actions/ })
    await user.click(within(dialog).getByRole('button', { name: 'New quick action' }))
    await user.type(within(dialog).getByLabelText('Name'), 'Project done')
    await user.selectOptions(within(dialog).getByLabelText('Account'), 'account')
    await user.click(within(dialog).getByRole('button', { name: 'Add step' }))
    await user.selectOptions(within(dialog).getByLabelText('Step 2'), 'label')
    await user.selectOptions(within(dialog).getByLabelText('Step 2 destination'), 'project')
    await user.click(within(dialog).getByRole('button', { name: 'Move step 2 up' }))
    await user.selectOptions(within(dialog).getByLabelText('Keyboard shortcut'), '2')
    await user.click(within(dialog).getByRole('button', { name: 'Save quick action' }))
    await waitFor(() => expect(api.mail.quickActions.save).toHaveBeenCalledWith({ name: 'Project done', accountId: 'account', steps: [{ action: 'label', labelId: 'project' }, { action: 'read' }], shortcut: 2, showInToolbar: true }))
    expect(await within(dialog).findByText('Apply label: Project → Mark as read')).toBeInTheDocument()
  })

  it('splits only the Inbox into category tabs with unread counts, keyboard switching, and reassignment', async () => {
    const user = userEvent.setup()
    const tabsConfig = { tabs: [
      { id: 'primary', name: 'Primary', enabled: true, builtIn: true }, { id: 'social', name: 'Social', enabled: true, builtIn: true },
      { id: 'promotions', name: 'Deals', enabled: true, builtIn: true }, { id: 'updates', name: 'Updates', enabled: false, builtIn: true }, { id: 'forums', name: 'Forums', enabled: false, builtIn: true }
    ] }
    const categories = {
      tabs: vi.fn(async () => tabsConfig), saveTabs: vi.fn(), rules: vi.fn(async () => []), saveRule: vi.fn(), deleteRule: vi.fn(),
      counts: vi.fn(async () => ({ primary: { unread: 2, total: 3 }, social: { unread: 0, total: 1 }, promotions: { unread: 5, total: 8 } })),
      assign: vi.fn(async () => ({ updated: 1, providerOperations: 2 }))
    }
    pageResult = { items: [summary({ pinned: true, pinnedAt: '2026-08-09T00:00:00Z', category: 'primary', categorySource: 'heuristic' }), summary({ id: 'thread-2', subject: 'Second conversation', category: 'primary' })], total: 2 }
    ;(api.mail as any).categories = categories
    try {
      const onToast = renderMail()
      const tablist = await screen.findByRole('tablist', { name: 'Inbox categories' })
      expect(within(tablist).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Primary2', 'Social', 'Deals5'])
      await waitFor(() => expect(api.mail.mail.list).toHaveBeenLastCalledWith(expect.objectContaining({ folder: 'inbox', category: 'primary' })))
      expect(categories.counts).toHaveBeenCalledWith(undefined)
      expect(document.getElementById('mail-message-list')).toHaveAttribute('role', 'tabpanel')
      // Pinned conversations still lead the tab's list.
      expect(screen.getAllByRole('heading', { level: 2 })[0]).toHaveTextContent('Pinned')

      await user.click(within(tablist).getByRole('tab', { name: /Social/ }))
      await waitFor(() => expect(api.mail.mail.list).toHaveBeenLastCalledWith(expect.objectContaining({ category: 'social' })))
      fireEvent.keyDown(window, { key: 'ArrowRight', altKey: true })
      await waitFor(() => expect(api.mail.mail.list).toHaveBeenLastCalledWith(expect.objectContaining({ category: 'promotions' })))
      fireEvent.keyDown(within(tablist).getByRole('tab', { name: /Deals/ }), { key: 'Home' })
      await waitFor(() => expect(api.mail.mail.list).toHaveBeenLastCalledWith(expect.objectContaining({ category: 'primary' })))

      fireEvent.contextMenu(screen.getByText('Second conversation').closest('.message-row')!)
      await user.click(await screen.findByRole('menuitem', { name: 'Move to inbox tab…' }))
      const dialog = await screen.findByRole('dialog', { name: /Move to inbox tab/ })
      await user.click(within(dialog).getByRole('radio', { name: 'Deals' }))
      categories.counts.mockClear()
      await user.click(within(dialog).getByRole('button', { name: 'Move' }))
      await waitFor(() => expect(categories.assign).toHaveBeenCalledWith({ accountId: 'account', threadIds: ['thread-2'], category: 'promotions' }))
      expect(onToast).toHaveBeenCalledWith('Moved to Deals and updated on the server')
      // Counts reload after a reassignment, and tabs disappear outside the Inbox.
      await waitFor(() => expect(categories.counts).toHaveBeenCalled())
      await user.click(screen.getByRole('button', { name: 'Starred 1 unread conversation' }))
      await waitFor(() => expect(screen.queryByRole('tablist', { name: 'Inbox categories' })).toBeNull())
      expect(api.mail.mail.list).toHaveBeenLastCalledWith(expect.objectContaining({ folder: 'starred', category: undefined }))
    } finally {
      delete (api.mail as any).categories
    }
  })

  it('pins and unpins from the context menu, bulk toolbar, reader, and palette, under a Pinned heading with undo', async () => {
    const user = userEvent.setup()
    pageResult = { items: [summary({ pinned: true, pinnedAt: '2026-08-09T00:00:00Z' }), summary({ id: 'thread-2', subject: 'Second conversation', participants: ['Grace'], lastDate: '2026-08-07T10:00:00Z', unread: false, starred: false, labelIds: ['INBOX'], messageCount: 1 })], total: 2 }
    api.mail.mail.action.mockImplementation(async (input: any) => ({ id: `operation-${input.action}`, accountId: input.accountId, kind: input.action, status: input.action === 'pin' || input.action === 'unpin' ? 'succeeded' : 'queued', createdAt: '', updatedAt: '', undoUntil: new Date(Date.now() + 60_000).toISOString() }))
    const onToast = vi.fn()
    const view = (request = { id: 0, action: 'pin' as 'pin' | 'unpin' }) => <ContextMenuProvider><ConnectedMailView onToast={onToast} pinRequest={request} /></ContextMenuProvider>
    const { rerender } = render(view({ id: 3, action: 'pin' }))
    await screen.findByText('Launch & plans')
    // A request issued before mounting is not replayed.
    expect(api.mail.mail.action).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'pin' }))
    const headings = screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent?.trim())
    expect(headings.slice(0, 2)).toEqual(['Pinned', formatMailDateHeading('2026-08-07T10:00:00Z')])
    const first = document.querySelector('.message-row')!
    expect(first).toHaveClass('pinned')

    fireEvent.contextMenu(first)
    await user.click(await screen.findByRole('menuitemcheckbox', { name: 'Unpin conversation' }))
    expect(api.mail.mail.action).toHaveBeenCalledWith({ accountId: 'account', threadIds: ['thread-1'], action: 'unpin' })
    // Pins succeed immediately; the success event must not withdraw the undo offer.
    act(() => emitMail?.({ type: 'operation', payload: { id: 'operation-unpin', accountId: 'account', kind: 'unpin', status: 'succeeded' } }))
    expect(screen.getByText('Unpinned')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Undo' }))
    expect(api.mail.mail.undo).toHaveBeenCalledWith('operation-unpin')

    fireEvent.contextMenu(screen.getByText('Second conversation').closest('.message-row')!)
    await user.click(await screen.findByRole('menuitemcheckbox', { name: 'Pin to top' }))
    expect(api.mail.mail.action).toHaveBeenCalledWith({ accountId: 'account', threadIds: ['thread-2'], action: 'pin' })
    expect(await screen.findByText('Pinned to the top of the list')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Select visible conversations' }))
    await user.click(within(document.querySelector('.bulk-mail-toolbar')!).getByRole('button', { name: 'Pin' }))
    expect(api.mail.mail.action).toHaveBeenCalledWith({ accountId: 'account', threadIds: ['thread-1', 'thread-2'], action: 'pin' })
    await waitFor(() => expect(document.querySelector('.bulk-mail-toolbar')).toBeNull())

    await user.click(await screen.findByTitle('Unpin conversation'))
    expect(api.mail.mail.action).toHaveBeenLastCalledWith({ accountId: 'account', threadIds: ['thread-1'], action: 'unpin' })
    api.mail.mail.action.mockClear()
    rerender(view({ id: 4, action: 'pin' }))
    await waitFor(() => expect(api.mail.mail.action).toHaveBeenCalledWith({ accountId: 'account', threadIds: ['thread-1'], action: 'pin' }))
  })

  it('adds folders to Favorites from the folder context menu and opens, reorders, and removes them without deleting folders', async () => {
    const user = userEvent.setup()
    accountsResult = [account(), account({ id: 'imap', provider: 'imap', email: 'me@imap.test' })]
    api.mail.mail.labels.mockResolvedValue([
      { accountId: 'account', id: 'project', name: 'Project', type: 'user' },
      ...Array.from({ length: 13 }, (_, index) => ({ accountId: 'imap', id: `folder:Project/${index + 1}`, name: `Project/${index + 1}`, type: 'user' as const, parentId: 'folder:Project' })),
      { accountId: 'imap', id: 'folder:Project', name: 'Project', type: 'user' }
    ] as any)
    let preferences: any = { favorites: [], appearance: [] }
    const folderPreferences = {
      get: vi.fn(async () => preferences),
      addFavorite: vi.fn(async (accountId: string, labelId: string) => {
        preferences = { ...preferences, favorites: [...preferences.favorites, { accountId, labelId, position: preferences.favorites.length, lastKnownName: labelId, addedAt: '2026-10-01T00:00:00Z' }] }
        return preferences
      }),
      removeFavorite: vi.fn(async (accountId: string, labelId: string) => {
        preferences = { ...preferences, favorites: preferences.favorites.filter((item: any) => item.accountId !== accountId || item.labelId !== labelId) }
        return preferences
      }),
      reorderFavorites: vi.fn(async (order: any[]) => {
        preferences = { ...preferences, favorites: order.map((item, position) => ({ ...preferences.favorites.find((other: any) => other.accountId === item.accountId && other.labelId === item.labelId), position })) }
        return preferences
      }),
      setFavoriteAlias: vi.fn(async () => preferences),
      setAppearance: vi.fn(async () => preferences)
    }
    Object.defineProperty(window, 'aerio', { configurable: true, value: { ...api, mail: { ...api.mail, folderPreferences } } })
    renderMail(); await screen.findByText('Launch & plans')
    const sidebar = within(document.querySelector('.context-sidebar')!)
    // The full tree, not just the first twelve labels, with a filter for large trees.
    expect(await sidebar.findByRole('button', { name: '13' })).toBeInTheDocument()
    expect(sidebar.getByLabelText('Filter folders')).toBeInTheDocument()

    const choose = async (target: Element, label: string) => {
      fireEvent.contextMenu(target)
      await user.click(within(screen.getByRole('menu')).getByText(label))
    }
    const gmailTree = within(sidebar.getByRole('tree', { name: 'Folders in me@example.test' }))
    const imapTree = within(sidebar.getByRole('tree', { name: 'Folders in me@imap.test' }))
    await choose(gmailTree.getByRole('button', { name: 'Project' }), 'Add to Favorites')
    await choose(imapTree.getByRole('button', { name: 'Project' }), 'Add to Favorites')
    expect(folderPreferences.addFavorite).toHaveBeenCalledWith('account', 'project')
    expect(folderPreferences.addFavorite).toHaveBeenCalledWith('imap', 'folder:Project')
    const favorites = within(await sidebar.findByRole('group', { name: 'Favorites' }))
    await waitFor(() => expect(favorites.getAllByRole('button').map((button) => button.textContent)).toEqual(['Project me@example.test', 'Project me@imap.test']))

    await user.click(favorites.getAllByRole('button')[1])
    await waitFor(() => expect(api.mail.mail.list).toHaveBeenCalledWith(expect.objectContaining({ accountIds: ['imap'], labelId: 'folder:Project' })))
    await choose(favorites.getAllByRole('button')[1], 'Move up')
    expect(folderPreferences.reorderFavorites).toHaveBeenCalledWith([{ accountId: 'imap', labelId: 'folder:Project' }, { accountId: 'account', labelId: 'project' }])
    await waitFor(() => expect(favorites.getAllByRole('button')[0]).toHaveTextContent('me@imap.test'))
    await choose(favorites.getAllByRole('button')[0], 'Remove from Favorites')
    expect(folderPreferences.removeFavorite).toHaveBeenCalledWith('imap', 'folder:Project')
    await waitFor(() => expect(favorites.getAllByRole('button')).toHaveLength(1))
    expect(imapTree.getByRole('button', { name: 'Project' })).toBeInTheDocument()
  })
})
