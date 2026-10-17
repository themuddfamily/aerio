// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MailAccountSummary, MailMessageDetail, MailReplyWatch, MailWorkerEvent } from '../mail-types'
import { ContextMenuProvider } from './ContextMenu'
import MailComposeModal from './MailComposeModal'
import { MailReplyWatchesModal, canWatchMessage, replyWatchDeadline } from './MailReplyWatches'

const accounts: MailAccountSummary[] = [{
  id: 'account', provider: 'gmail', email: 'me@example.test', displayName: 'Me', color: '#123456', status: 'ready', archived: false,
  signature: '', notifications: true, syncEnabled: true
}]
const watch = (overrides: Partial<MailReplyWatch> = {}): MailReplyWatch => ({
  id: 'watch-1', accountId: 'account', subject: 'Proposal', recipients: ['ada@example.test'], status: 'watching', createdAt: '2026-08-08T10:00:00Z', ...overrides
})
const sentMessage: MailMessageDetail = {
  accountId: 'account', id: 'sent-1', threadId: 'thread-1', fromName: 'Me', fromEmail: 'me@example.test', to: ['ada@example.test'], cc: [],
  subject: 'Proposal', messageIdHeader: '<sent@aerio.local>', date: '2026-08-08T10:00:00Z', text: '', html: '', sanitizedHtml: '', labelIds: ['SENT'], attachments: []
}
let listener: ((event: MailWorkerEvent) => void) | undefined
const api = {
  mail: {
    mail: { suggestRecipients: vi.fn(async () => []) },
    drafts: {
      save: vi.fn(async () => ({ id: 'draft', status: 'synced', updatedAt: '2026-08-08T10:00:00Z' })),
      send: vi.fn(async () => ({ id: 'draft', status: 'send-pending', updatedAt: '2026-08-08T10:00:00Z' })),
      schedule: vi.fn(async () => ({ id: 'draft', status: 'scheduled', updatedAt: '2026-08-08T10:00:00Z' }))
    },
    replyWatches: {
      list: vi.fn(async () => [watch(), watch({ id: 'watch-2', subject: 'Old', status: 'replied', replyFrom: 'Ada <ada@example.test>' })]),
      create: vi.fn(async () => watch()),
      cancel: vi.fn(async () => true)
    },
    onEvent: vi.fn((callback: (event: MailWorkerEvent) => void) => { listener = callback; return () => { listener = undefined } })
  }
}
const future = () => {
  const date = new Date(Date.now() + 2 * 24 * 60 * 60_000)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'aerio', { configurable: true, value: api })
  Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => true) })
})

describe('reply watch helpers', () => {
  it('accepts only future deadlines and allows watching without one', () => {
    expect(replyWatchDeadline({ enabled: true, deadline: '' })).toEqual({ ok: true })
    expect(replyWatchDeadline({ enabled: false, deadline: '2020-01-01T10:00' })).toEqual({ ok: true })
    expect(replyWatchDeadline({ enabled: true, deadline: '2020-01-01T10:00' })).toEqual({ ok: false })
    expect(replyWatchDeadline({ enabled: true, deadline: future() })).toMatchObject({ ok: true, deadlineAt: expect.any(String) })
  })

  it('offers watching only for the account’s own sent messages with a Message-ID', () => {
    expect(canWatchMessage(sentMessage, accounts)).toBe(true)
    expect(canWatchMessage({ ...sentMessage, labelIds: ['INBOX'], fromEmail: 'ada@example.test' }, accounts)).toBe(false)
    expect(canWatchMessage({ ...sentMessage, messageIdHeader: undefined }, accounts)).toBe(false)
    expect(canWatchMessage(sentMessage, [{ ...accounts[0], archived: true }])).toBe(false)
  })
})

describe('composer reply watch', () => {
  const renderCompose = () => {
    const callbacks = { onClose: vi.fn(), onSent: vi.fn(), onToast: vi.fn() }
    render(<ContextMenuProvider><MailComposeModal accounts={accounts} initialTo="ada@example.test" {...callbacks} /></ContextMenuProvider>)
    return callbacks
  }

  it('arms a watch with the chosen deadline after queuing the message', async () => {
    const user = userEvent.setup(), callbacks = renderCompose()
    await user.click(screen.getByRole('button', { name: 'Watch for replies' }))
    expect(screen.getByRole('button', { name: 'Stop watching for replies' })).toHaveAttribute('aria-pressed', 'true')
    const deadline = future()
    fireEvent.change(screen.getByLabelText('Reply deadline'), { target: { value: deadline } })
    await user.click(screen.getByRole('button', { name: /^Send$/ }))
    await waitFor(() => expect(api.mail.replyWatches.create).toHaveBeenCalledWith({ accountId: 'account', draftId: 'draft', deadlineAt: new Date(deadline).toISOString() }))
    expect(api.mail.drafts.send.mock.invocationCallOrder[0]).toBeLessThan(api.mail.replyWatches.create.mock.invocationCallOrder[0])
    expect(callbacks.onClose).toHaveBeenCalled()
  })

  it('does not watch by default, rejects past deadlines, and reports a failed watch without losing the send', async () => {
    const user = userEvent.setup(), callbacks = renderCompose()
    await user.click(screen.getByRole('button', { name: 'Watch for replies' }))
    fireEvent.change(screen.getByLabelText('Reply deadline'), { target: { value: '2020-01-01T10:00' } })
    await user.click(screen.getByRole('button', { name: /^Send$/ }))
    expect(callbacks.onToast).toHaveBeenCalledWith('Choose a reply deadline in the future')
    expect(api.mail.drafts.send).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Clear reply deadline' }))
    api.mail.replyWatches.create.mockRejectedValueOnce(new Error("Error invoking remote method 'mail:reply-watches:create': Error: disk busy"))
    await user.click(screen.getByRole('button', { name: /^Send$/ }))
    await waitFor(() => expect(callbacks.onToast).toHaveBeenCalledWith('Message queued, but replies are not being watched: disk busy'))
    expect(api.mail.replyWatches.create).toHaveBeenCalledWith({ accountId: 'account', draftId: 'draft', deadlineAt: undefined })
    expect(callbacks.onSent).toHaveBeenCalled()
  })

  it('leaves replies unwatched when the toggle is off', async () => {
    const user = userEvent.setup()
    renderCompose()
    await user.click(screen.getByRole('button', { name: /^Send$/ }))
    await waitFor(() => expect(api.mail.drafts.send).toHaveBeenCalled())
    expect(api.mail.replyWatches.create).not.toHaveBeenCalled()
  })
})

describe('MailReplyWatchesModal', () => {
  it('lists watches, cancels active ones, and refreshes on reply-watch events', async () => {
    const user = userEvent.setup(), onToast = vi.fn()
    render(<MailReplyWatchesModal accounts={accounts} onToast={onToast} onClose={vi.fn()} />)
    expect(await screen.findByText('Watching with no deadline')).toBeInTheDocument()
    expect(screen.getByText('Replied by Ada <ada@example.test>')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /Stop watching/ })).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'Stop watching Proposal' }))
    expect(api.mail.replyWatches.cancel).toHaveBeenCalledWith('watch-1')
    expect(onToast).toHaveBeenCalledWith('Stopped watching for replies')
    const calls = api.mail.replyWatches.list.mock.calls.length
    listener?.({ type: 'reply-watch', payload: { watch: watch({ status: 'expired' }), reason: 'expired' } })
    await waitFor(() => expect(api.mail.replyWatches.list.mock.calls.length).toBe(calls + 1))
  })

  it('watches an already sent message with an optional deadline', async () => {
    const user = userEvent.setup(), onToast = vi.fn(), onClose = vi.fn()
    render(<MailReplyWatchesModal accounts={accounts} message={sentMessage} onToast={onToast} onClose={onClose} />)
    await user.click(screen.getByRole('button', { name: 'Watch for replies' }))
    await waitFor(() => expect(api.mail.replyWatches.create).toHaveBeenCalledWith({ accountId: 'account', messageId: 'sent-1', deadlineAt: undefined }))
    expect(onToast).toHaveBeenCalledWith('Watching for replies')
    expect(onClose).toHaveBeenCalled()
  })
})
