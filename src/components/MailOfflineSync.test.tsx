// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MailAccountSummary, MailMessageDetail } from '../mail-types'
import type { MailOfflineAvailability, MailOfflineSettings } from '../offline-sync-types'
import { MailFolderOfflineModal, MailOfflineContentNotice, MailOfflineListFooter, MailOfflineSyncSection, MailSearchCoverageNotice, availabilitySummary, mailboxOfflineTarget, offlineFolderMenuItems } from './MailOfflineSync'

const account = (overrides: Partial<MailAccountSummary> = {}): MailAccountSummary => ({
  id: 'account-1', provider: 'gmail', email: 'person@example.com', displayName: 'Person', color: '#1d7a62', status: 'ready',
  archived: false, signature: '', notifications: true, syncEnabled: true, ...overrides
})
const settings = (overrides: Partial<MailOfflineSettings> = {}): MailOfflineSettings => ({
  accountId: 'account-1', supported: true, defaults: { downloadMode: 'full', window: { unit: 'all', amount: 0 } }, overrides: [], extensions: [], ...overrides
})
const availability = (overrides: Partial<MailOfflineAvailability> = {}): MailOfflineAvailability => ({
  accountId: 'account-1', total: 10, full: 6, bodyOnly: 2, headersOnly: 2, outsideWindow: 1, bytes: 2048,
  policy: { downloadMode: 'full', window: { unit: 'all', amount: 0 } }, extraSteps: 0, ...overrides
})
const offline = {
  settings: vi.fn(), setAccountPolicy: vi.fn(), setFolderOverride: vi.fn(), extend: vi.fn(), availability: vi.fn(),
  searchCoverage: vi.fn(), serverSearch: vi.fn(), reclaim: vi.fn()
}
const api = { mail: { offline, mail: { labels: vi.fn(async () => [{ accountId: 'account-1', id: 'Label_7', name: 'Projects', type: 'user' }]) } } }

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'aerio', { configurable: true, value: api })
  offline.settings.mockResolvedValue(settings())
  offline.availability.mockResolvedValue(availability())
  offline.searchCoverage.mockResolvedValue([{ accountId: 'account-1', complete: true, serverSearch: true, reasons: [] }])
})

describe('offline scope UI (E36)', () => {
  it('saves account defaults, lists folder overrides and frees space', async () => {
    offline.settings.mockResolvedValue(settings({ overrides: [{ labelId: 'Label_7', downloadMode: 'headers', updatedAt: '' }, { labelId: 'INBOX', window: { unit: 'days', amount: 7 }, updatedAt: '' }] }))
    offline.setAccountPolicy.mockResolvedValue(settings())
    offline.setFolderOverride.mockResolvedValue(settings())
    offline.reclaim.mockResolvedValue({ messages: 3, bytes: 4096 })
    const onToast = vi.fn()
    const user = userEvent.setup()
    render(<MailOfflineSyncSection account={account()} onToast={onToast} />)
    expect(await screen.findByText(/10 cached messages: 6 full · 2 without attachments · 2 headers only · 1 outside the window/)).toBeInTheDocument()
    expect(screen.getByText('Search covers the whole mailbox.')).toBeInTheDocument()
    expect(screen.getByText('Projects')).toBeInTheDocument()
    expect(screen.getByText('Inbox')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Apply offline settings/ })).toBeDisabled()
    await user.click(screen.getByRole('radio', { name: /Headers only/ }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Synchronize' }), 'days')
    await user.clear(screen.getByRole('spinbutton', { name: 'Days' }))
    await user.type(screen.getByRole('spinbutton', { name: 'Days' }), '45')
    await user.click(screen.getByRole('button', { name: /Apply offline settings/ }))
    await waitFor(() => expect(offline.setAccountPolicy).toHaveBeenCalledWith('account-1', { downloadMode: 'headers', window: { unit: 'days', amount: 45 } }))
    expect(onToast).toHaveBeenCalledWith(expect.stringMatching(/stays on the server/))
    await user.click(screen.getAllByRole('button', { name: /Use default/ })[0])
    await waitFor(() => expect(offline.setFolderOverride).toHaveBeenCalledWith('account-1', 'Label_7', null))
    await user.click(screen.getByRole('button', { name: /Free space outside the scope/ }))
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Freed 4 KB from 3 messages'))
  })

  it('explains that Local Folders and POP3 mail is always offline', async () => {
    offline.settings.mockResolvedValue(settings({ supported: false }))
    render(<MailOfflineSyncSection account={account({ provider: 'local' })} onToast={vi.fn()} />)
    expect(await screen.findByText(/always available offline and fully searchable/)).toBeInTheDocument()
    expect(offlineFolderMenuItems(account({ provider: 'pop3' }), { labelId: 'INBOX', name: 'Inbox' }, vi.fn())).toEqual([])
    expect(offlineFolderMenuItems(account(), mailboxOfflineTarget('starred', 'Starred'), vi.fn())).toEqual([])
    const open = vi.fn()
    const [item] = offlineFolderMenuItems(account(), mailboxOfflineTarget('inbox', 'Inbox'), open)
    void item.action()
    expect(open).toHaveBeenCalledWith({ accountId: 'account-1', labelId: 'INBOX', name: 'Inbox' })
  })

  it('saves and removes a folder override from folder properties', async () => {
    offline.settings.mockResolvedValue(settings({ overrides: [{ labelId: 'Label_7', downloadMode: 'bodies', updatedAt: '' }] }))
    offline.setFolderOverride.mockResolvedValue(settings())
    const onClose = vi.fn()
    const user = userEvent.setup()
    const { unmount } = render(<MailFolderOfflineModal target={{ accountId: 'account-1', labelId: 'Label_7', name: 'Projects' }} onClose={onClose} onToast={vi.fn()} />)
    expect(await screen.findByRole('combobox', { name: 'Download' })).toHaveValue('bodies')
    await user.click(screen.getByRole('checkbox', { name: /Use the account’s date window/ }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Synchronize' }), 'months')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(offline.setFolderOverride).toHaveBeenCalledWith('account-1', 'Label_7', { downloadMode: 'bodies', window: { unit: 'months', amount: 6 } }))
    expect(onClose).toHaveBeenCalled()
    unmount()
    render(<MailFolderOfflineModal target={{ accountId: 'account-1', labelId: 'Label_7', name: 'Projects' }} onClose={onClose} onToast={vi.fn()} />)
    await user.click(await screen.findByRole('button', { name: /Use account default/ }))
    await waitFor(() => expect(offline.setFolderOverride).toHaveBeenLastCalledWith('account-1', 'Label_7', null))
  })

  it('offers Load more and Load all at the end of a windowed folder', async () => {
    offline.availability.mockResolvedValue(availability({ windowStart: '2026-09-17T00:00:00.000Z' }))
    offline.extend.mockResolvedValue([settings()])
    const onExtended = vi.fn()
    const user = userEvent.setup()
    render(<MailOfflineListFooter accounts={[account(), account({ id: 'local', provider: 'local' })]} folder="inbox" refreshKey="1" onExtended={onExtended} onToast={vi.fn()} />)
    await user.click(await screen.findByRole('button', { name: 'Load more' }))
    expect(offline.availability).toHaveBeenCalledWith('account-1', 'INBOX')
    expect(offline.availability).toHaveBeenCalledTimes(1)
    expect(offline.extend).toHaveBeenCalledWith({ accountIds: ['account-1'], folder: 'inbox', mode: 'more' })
    await user.click(screen.getByRole('button', { name: 'Load all' }))
    expect(offline.extend).toHaveBeenLastCalledWith({ accountIds: ['account-1'], folder: 'inbox', mode: 'all' })
    expect(onExtended).toHaveBeenCalledTimes(2)
  })

  it('hides the footer when all mail is synchronized', async () => {
    const { container } = render(<MailOfflineListFooter accounts={[account()]} folder="all" refreshKey="1" onExtended={vi.fn()} onToast={vi.fn()} />)
    await waitFor(() => expect(offline.availability).toHaveBeenCalledWith('account-1', undefined))
    expect(container).toBeEmptyDOMElement()
  })

  it('reports incomplete search coverage and runs a server search', async () => {
    offline.searchCoverage.mockResolvedValue([{ accountId: 'account-1', complete: false, serverSearch: true, reasons: ['1 message has only headers downloaded'] }])
    offline.serverSearch.mockResolvedValue({ searchId: 'search-1', matched: 5, added: 2, errors: [] })
    const onServerSearch = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(<MailSearchCoverageNotice accounts={[account()]} query="budget" active online onServerSearch={onServerSearch} onLocalResults={vi.fn()} onToast={vi.fn()} />)
    expect(await screen.findByText('Search covers downloaded mail only.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Search server' }))
    expect(offline.serverSearch).toHaveBeenCalledWith({ accountIds: ['account-1'], query: 'budget' })
    expect(onServerSearch).toHaveBeenCalledWith('search-1', 5)
    const onLocalResults = vi.fn()
    rerender(<MailSearchCoverageNotice accounts={[account()]} query="budget" active online serverResults={{ matched: 5 }} onServerSearch={onServerSearch} onLocalResults={onLocalResults} onToast={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Show downloaded results' }))
    expect(onLocalResults).toHaveBeenCalled()
  })

  it('explains when the server cannot be searched', async () => {
    offline.searchCoverage.mockResolvedValue([{ accountId: 'account-1', complete: false, serverSearch: false, reasons: ['Mail outside the sync window (last 30 days) is not downloaded'] }])
    render(<MailSearchCoverageNotice accounts={[account({ archived: true })]} query="budget" active online onServerSearch={vi.fn()} onLocalResults={vi.fn()} onToast={vi.fn()} />)
    expect(await screen.findByText(/can’t be searched on the server/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Search server' })).not.toBeInTheDocument()
  })

  it('shows offline notices in the reader', () => {
    const message = { id: 'm', attachments: [{ id: 'a' }], offline: { state: 'headers', notice: 'Not downloaded — connect to load' } } as unknown as MailMessageDetail
    const { rerender } = render(<MailOfflineContentNotice message={message} />)
    expect(screen.getByRole('status')).toHaveTextContent('Not downloaded — connect to load')
    rerender(<MailOfflineContentNotice message={{ ...message, offline: { state: 'body' } }} />)
    expect(screen.getByText('Attachments download when you open them.')).toBeInTheDocument()
    rerender(<MailOfflineContentNotice message={{ ...message, offline: undefined }} />)
    expect(screen.queryByText(/download/)).not.toBeInTheDocument()
    expect(availabilitySummary(availability({ total: 1, full: 1, bodyOnly: 0, headersOnly: 0, outsideWindow: 0, bytes: 0 }))).toBe('1 cached message: 1 full · 0 bytes on this computer')
  })
})
