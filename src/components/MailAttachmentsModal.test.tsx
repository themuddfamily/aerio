// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MailAccountSummary, MailAttachmentListItem, MailAttachmentPage } from '../mail-types'
import { ContextMenuProvider } from './ContextMenu'
import MailAttachmentsModal, { attachmentQueryFromFilters } from './MailAttachmentsModal'

const account = (overrides: Partial<MailAccountSummary> = {}): MailAccountSummary => ({
  id: 'account-1', provider: 'gmail', email: 'person@example.test', displayName: 'Personal', color: '#123456',
  status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true, ...overrides
})

const item = (overrides: Partial<MailAttachmentListItem> = {}): MailAttachmentListItem => ({
  accountId: 'account-1', threadId: 'thread-1', messageId: 'message-1', attachmentId: 'part-0', filename: 'report.pdf',
  mimeType: 'application/pdf', size: 2048, fileType: 'pdf', date: '2026-08-01T10:00:00.000Z', fromName: 'Ada Lovelace',
  fromEmail: 'ada@example.test', to: ['person@example.test'], cc: [], subject: 'Quarterly report', available: true, accountArchived: false,
  ...overrides
})

describe('MailAttachmentsModal', () => {
  let api: { list: ReturnType<typeof vi.fn>; open: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn> }
  let openMessage: ReturnType<typeof vi.fn>

  beforeEach(() => {
    api = {
      list: vi.fn().mockResolvedValue({ items: [], total: 0 } satisfies MailAttachmentPage),
      open: vi.fn().mockResolvedValue({}),
      save: vi.fn().mockResolvedValue({ savedPath: 'C:/Downloads/report.pdf' })
    }
    openMessage = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'aerio', { configurable: true, value: { mail: { attachments: api }, window: { openMessage } } })
  })

  const renderModal = (accounts = [account()], onToast = vi.fn()) => render(<ContextMenuProvider><MailAttachmentsModal accounts={accounts} onToast={onToast} onClose={vi.fn()} /></ContextMenuProvider>)

  it('maps filters to a query', () => {
    expect(attachmentQueryFromFilters({
      search: ' invoice ', sender: '', recipient: 'team', accountId: 'account-2', fileType: 'image', size: 'large',
      dateFrom: '2026-07-01', dateTo: '', includeArchivedAccounts: false, includeInline: true
    })).toEqual({
      accountIds: ['account-2'], includeArchivedAccounts: false, includeInline: true, search: 'invoice', sender: undefined, recipient: 'team',
      dateFrom: '2026-07-01', dateTo: undefined, fileTypes: ['image'], minSize: 1024 * 1024, maxSize: 10 * 1024 * 1024 - 1, pageSize: 50
    })
  })

  it('shows the empty state and re-queries with debounced filters', async () => {
    renderModal()
    expect(await screen.findByText('No attachments yet')).toBeInTheDocument()
    expect(api.list).toHaveBeenCalledTimes(1)
    fireEvent.change(screen.getByLabelText('Attachment name'), { target: { value: 'budget' } })
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'spreadsheet' } })
    await waitFor(() => expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'budget', fileTypes: ['spreadsheet'] })))
    expect(api.list).toHaveBeenCalledTimes(2)
    expect(await screen.findByText('No attachments match these filters')).toBeInTheDocument()
  })

  it('opens, saves, navigates to the message, and pages with the cursor', async () => {
    const onToast = vi.fn()
    api.list
      .mockResolvedValueOnce({ items: [item()], total: 2, nextCursor: 'next' })
      .mockResolvedValueOnce({ items: [item({ messageId: 'message-2', filename: 'older.zip', fileType: 'archive' })], total: 2 })
    renderModal([account()], onToast)
    expect(await screen.findByText('report.pdf')).toBeInTheDocument()
    expect(screen.getByText(/Ada Lovelace · Quarterly report/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Open report.pdf' }))
    await waitFor(() => expect(api.open).toHaveBeenCalledWith('account-1', 'message-1', 'part-0', 'report.pdf'))
    fireEvent.click(screen.getByRole('button', { name: 'Save report.pdf' }))
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Saved report.pdf'))
    fireEvent.click(screen.getByRole('button', { name: 'Show message for report.pdf' }))
    expect(openMessage).toHaveBeenCalledWith({ source: 'connected', accountId: 'account-1', threadId: 'thread-1', messageId: 'message-1', title: 'Quarterly report' })

    fireEvent.click(screen.getByRole('button', { name: 'Load more (1 remaining)' }))
    expect(await screen.findByText('older.zip')).toBeInTheDocument()
    expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'next' }))
    expect(screen.queryByRole('button', { name: /Load more/ })).not.toBeInTheDocument()
  })

  it('disables extraction for unavailable originals and labels archived accounts', async () => {
    api.list.mockResolvedValue({ items: [item({ available: false, accountArchived: true })], total: 1 })
    renderModal([account({ archived: true, status: 'archived' })])
    expect(await screen.findByText(/Original not downloaded · Archived account/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open report.pdf' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save report.pdf' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Show message for report.pdf' })).toBeEnabled()
  })

  it('reloads when an account is deleted and resets a stale account filter', async () => {
    const { rerender } = renderModal([account(), account({ id: 'account-2', email: 'work@example.test' })])
    await screen.findByText('No attachments yet')
    fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'account-2' } })
    await waitFor(() => expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ accountIds: ['account-2'] })))
    const calls = api.list.mock.calls.length
    await act(async () => {
      rerender(<ContextMenuProvider><MailAttachmentsModal accounts={[account()]} onToast={vi.fn()} onClose={vi.fn()} /></ContextMenuProvider>)
    })
    await waitFor(() => expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ accountIds: undefined })))
    expect(api.list.mock.calls.length).toBeGreaterThan(calls)
    expect(screen.getByLabelText('Account')).toHaveValue('all')
  })

  it('reports load and action failures', async () => {
    const onToast = vi.fn()
    api.list.mockRejectedValueOnce(new Error('Database locked'))
    const { unmount } = renderModal([account()], onToast)
    expect(await screen.findByText('Database locked')).toBeInTheDocument()
    unmount()

    api.list.mockResolvedValue({ items: [item()], total: 1 })
    api.open.mockResolvedValueOnce({ error: 'No application is associated with this file' })
    api.save.mockRejectedValueOnce(new Error('The original message is not available offline'))
    renderModal([account()], onToast)
    fireEvent.click(await screen.findByRole('button', { name: 'Open report.pdf' }))
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('No application is associated with this file'))
    fireEvent.click(screen.getByRole('button', { name: 'Save report.pdf' }))
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('The original message is not available offline'))
  })
})
