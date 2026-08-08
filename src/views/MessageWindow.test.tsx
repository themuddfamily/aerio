// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MailThreadDetail } from '../mail-types'
import { ContextMenuProvider } from '../components/ContextMenu'
import MessageWindow from './MessageWindow'

vi.mock('../components/TitleBar', () => ({ default: ({ title }: any) => <div data-testid="title-bar">{title}</div> }))
vi.mock('../components/ThreadMessageAccordion', () => ({
  default: ({ message, expanded, onToggle, onReply, children }: any) => <section data-testid={`message-${message.id}`}>
    <button onClick={onToggle}>{expanded ? 'Collapse message' : 'Expand message'}</button>
    {onReply && <button onClick={onReply}>Reply to message</button>}
    {expanded && <div>{message.text}</div>}{children}
  </section>
}))
vi.mock('../components/MailComposeModal', () => ({
  default: (props: any) => <div role="dialog" aria-label="Mock composer">
    <span>{props.replyAll ? 'Reply all composer' : props.forward ? 'Forward composer' : 'Reply composer'}</span>
    <button onClick={() => props.onSent({ id: 'send-1', status: 'send-pending', updatedAt: new Date().toISOString(), undoUntil: new Date(Date.now() + 60_000).toISOString() })}>Complete send</button>
    <button onClick={props.onClose}>Close composer</button>
  </div>
}))

const thread: MailThreadDetail = {
  accountId: 'account', id: 'thread', subject: 'Launch discussion', messages: [{
    accountId: 'account', id: 'message-1', threadId: 'thread', fromName: 'Ada', fromEmail: 'ada@example.test', to: ['me@example.test'], cc: [],
    subject: 'Launch discussion', messageIdHeader: '<one@example.test>', date: '2026-08-08T09:00:00Z', text: 'First message', html: '<p>First</p>', sanitizedHtml: '<p>First</p>', labelIds: ['INBOX', 'UNREAD', 'STARRED'], attachments: []
  }, {
    accountId: 'account', id: 'message-2', threadId: 'thread', fromName: 'Me', fromEmail: 'me@example.test', to: ['ada@example.test'], cc: [],
    subject: 'Re: Launch discussion', messageIdHeader: '<two@example.test>', references: ['<one@example.test>'], date: '2026-08-08T10:00:00Z', text: 'Second message', html: '<p>Second</p>', sanitizedHtml: '<p>Second</p>', labelIds: ['INBOX'],
    attachments: [{ id: 'attachment', messageId: 'message-2', filename: 'report.pdf', mimeType: 'application/pdf', size: 2048 }]
  }]
}
let emitMail: ((event: any) => void) | undefined
const api = {
  loadPreferences: vi.fn(async () => ({ schemaVersion: 1, settings: { theme: 'system', density: 'compact', closeToTray: true, notifications: true, startModule: 'mail' } })),
  mail: {
    accounts: { list: vi.fn(async () => [{ id: 'account', provider: 'gmail', email: 'me@example.test', displayName: 'Me', color: '#123456', status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true }]) },
    mail: {
      thread: vi.fn(async () => thread), action: vi.fn(async (_input: any) => ({ id: 'operation', accountId: 'account', kind: 'read', status: 'queued', createdAt: '2026-08-08T10:00:00Z', updatedAt: '2026-08-08T10:00:00Z', undoUntil: '2099-01-01T00:00:00Z' })),
      undo: vi.fn(async () => true)
    },
    onEvent: vi.fn((callback: (event: any) => void) => { emitMail = callback; return vi.fn() }),
    attachments: { open: vi.fn(async () => ({})), save: vi.fn(async (): Promise<{ savedPath?: string; error?: string }> => ({ savedPath: 'C:\\saved\\report.pdf' })) },
    drafts: { cancelSend: vi.fn(async () => ({ id: 'send-1', status: 'local', updatedAt: '2026-08-08T10:00:00Z' })) }
  }
}

const renderWindow = () => render(<ContextMenuProvider><MessageWindow /></ContextMenuProvider>)

beforeEach(() => {
  vi.clearAllMocks()
  emitMail = undefined
  window.history.replaceState({}, '', '/?view=message&source=connected&accountId=account&threadId=thread&messageId=message-1')
  Object.defineProperty(window, 'aerio', { configurable: true, value: api })
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({ matches: true })) })
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => undefined) } })
  api.loadPreferences.mockResolvedValue({ schemaVersion: 1, settings: { theme: 'system', density: 'compact', closeToTray: true, notifications: true, startModule: 'mail' } })
  api.mail.accounts.list.mockResolvedValue([{ id: 'account', provider: 'gmail', email: 'me@example.test', displayName: 'Me', color: '#123456', status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true }])
  api.mail.mail.thread.mockResolvedValue(thread)
  api.mail.mail.action.mockResolvedValue({ id: 'operation', accountId: 'account', kind: 'read', status: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), undoUntil: new Date(Date.now() + 60_000).toISOString() })
  api.mail.attachments.open.mockResolvedValue({})
  api.mail.attachments.save.mockResolvedValue({ savedPath: 'C:\\saved\\report.pdf' })
})

describe('MessageWindow', () => {
  it('loads preferences, accounts, the requested message, and applies renderer appearance', async () => {
    renderWindow()
    expect(screen.getByText('Opening message…')).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Launch discussion' })).toBeInTheDocument()
    expect(api.mail.mail.thread).toHaveBeenCalledWith('account', 'thread')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.dataset.density).toBe('compact')
    await waitFor(() => expect(document.title).toBe('Launch discussion — Aerio'))
    expect(screen.getByTestId('message-message-1')).toHaveTextContent('First message')
  })

  it('applies, reloads, undoes, and reports toolbar mail actions', async () => {
    const user = userEvent.setup()
    renderWindow(); await screen.findByRole('heading', { name: 'Launch discussion' })
    await user.click(screen.getByRole('button', { name: 'Mark as read' }))
    await waitFor(() => expect(api.mail.mail.action).toHaveBeenCalledWith({ accountId: 'account', threadIds: ['thread'], action: 'read' }))
    expect(screen.getByText('Conversation marked as read')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(api.mail.mail.undo).toHaveBeenCalledWith('operation'))
    expect(screen.getByText('Mail change undone')).toBeInTheDocument()

    api.mail.mail.action.mockRejectedValueOnce(new Error('provider offline'))
    await user.click(screen.getByRole('button', { name: 'Remove star' }))
    expect(await screen.findByText('provider offline')).toBeInTheDocument()
  })

  it('opens reply, reply-all, and forward composers and supports undo send', async () => {
    const user = userEvent.setup()
    renderWindow(); await screen.findByRole('heading', { name: 'Launch discussion' })
    await user.click(screen.getByRole('button', { name: 'Reply all' })); expect(screen.getByText('Reply all composer')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close composer' }))
    await user.click(screen.getByRole('button', { name: 'Forward' })); expect(screen.getByText('Forward composer')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Complete send' }))
    expect(await screen.findByText('Message will send shortly')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Undo Send' }))
    expect(api.mail.drafts.cancelSend).toHaveBeenCalledWith('send-1')
    expect(await screen.findByText('Send undone — message returned to Drafts')).toBeInTheDocument()
  })

  it('opens, saves, and reports attachment and remote-image results', async () => {
    const user = userEvent.setup()
    renderWindow(); await screen.findByText('report.pdf')
    await user.click(screen.getByTitle('Open')); expect(api.mail.attachments.open).toHaveBeenCalledWith('account', 'message-2', 'attachment', 'report.pdf')
    await user.click(screen.getByRole('button', { name: 'Save as' })); expect(await screen.findByText('Saved report.pdf')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Load remote images/ }))
    expect(api.mail.mail.thread).toHaveBeenCalledWith('account', 'thread', true)
    expect(screen.queryByRole('button', { name: /Load remote images/ })).not.toBeInTheDocument()
    api.mail.attachments.open.mockResolvedValueOnce({ error: 'No application' })
    await user.click(screen.getByTitle('Open')); expect(await screen.findByText('No application')).toBeInTheDocument()
  })

  it('reacts to account, mail, operation, and draft-delivery events', async () => {
    const user = userEvent.setup()
    renderWindow(); await screen.findByRole('heading', { name: 'Launch discussion' })
    await user.click(screen.getByRole('button', { name: 'Archive' }))
    emitMail?.({ type: 'operation', payload: { id: 'operation', status: 'failed', error: 'archive rejected' } })
    expect(await screen.findByText('archive rejected')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Reply' }))
    await user.click(screen.getByRole('button', { name: 'Complete send' }))
    emitMail?.({ type: 'accounts-changed', payload: [{ id: 'account', archived: true }] })
    emitMail?.({ type: 'mail-changed', payload: {} })
    await waitFor(() => expect(api.mail.mail.thread.mock.calls.length).toBeGreaterThan(2))
    emitMail?.({ type: 'draft-delivery', payload: { id: 'send-1', status: 'sent' } })
    expect(await screen.findByText('Message sent')).toBeInTheDocument()
  })

  it('shows invalid-source and loading-failure states and disables archived accounts', async () => {
    window.history.replaceState({}, '', '/?view=calendar')
    const invalid = renderWindow()
    expect(await screen.findByText('This message window request is invalid.')).toBeInTheDocument()
    invalid.unmount()

    window.history.replaceState({}, '', '/?view=message&source=connected&accountId=account&threadId=thread')
    api.mail.mail.thread.mockRejectedValueOnce(new Error('message missing'))
    const failed = renderWindow()
    expect(await screen.findByText('message missing')).toBeInTheDocument()
    failed.unmount()

    api.mail.accounts.list.mockResolvedValueOnce([{ id: 'account', archived: true } as any])
    renderWindow(); await screen.findByRole('heading', { name: 'Launch discussion' })
    for (const button of within(screen.getByRole('toolbar', { name: 'Conversation actions' })).getAllByRole('button')) expect(button).toBeDisabled()
  })

  it('handles attachment, remote-image, undo, and send-cancellation failures', async () => {
    const user = userEvent.setup()
    api.mail.attachments.open.mockRejectedValueOnce(new Error('open failed'))
    api.mail.attachments.save.mockRejectedValueOnce(new Error('save failed'))
    renderWindow(); await screen.findByText('report.pdf')
    await user.click(screen.getByTitle('Open')); expect(await screen.findByText('open failed')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save as' })); expect(await screen.findByText('save failed')).toBeInTheDocument()
    api.mail.mail.thread.mockRejectedValueOnce(new Error('images blocked'))
    await user.click(screen.getByRole('button', { name: /Load remote images/ })); expect(await screen.findByText('images blocked')).toBeInTheDocument()
  })

  it('runs inverse unread, star, inbox, trash, expansion, reply, and attachment context branches', async () => {
    const user = userEvent.setup()
    const inverse: MailThreadDetail = {
      ...thread,
      messages: thread.messages.map((message, index) => ({
        ...message,
        labelIds: [],
        attachments: index === 1 ? [
          ...message.attachments,
          { id: 'attachment-2', messageId: message.id, filename: 'notes.txt', mimeType: 'text/plain', size: 10 }
        ] : message.attachments
      }))
    }
    api.loadPreferences.mockResolvedValueOnce({ schemaVersion: 1, settings: { theme: 'light', density: 'comfortable', closeToTray: true, notifications: true, startModule: 'mail' } })
    api.mail.mail.thread.mockResolvedValue(inverse)
    renderWindow(); await screen.findByRole('heading', { name: 'Launch discussion' })
    expect(document.documentElement.dataset.theme).toBe('light')
    for (const [name, action] of [['Mark as unread', 'unread'], ['Add star', 'star'], ['Move to inbox', 'unarchive'], ['Move to trash', 'trash']] as const) {
      await user.click(screen.getByRole('button', { name }))
      await waitFor(() => expect(api.mail.mail.action).toHaveBeenCalledWith(expect.objectContaining({ action })))
    }
    await user.click(screen.getAllByRole('button', { name: 'Collapse message' })[0])
    await user.click(screen.getAllByRole('button', { name: 'Expand message' })[0])
    await user.click(screen.getAllByRole('button', { name: 'Reply to message' })[0])
    expect(screen.getByRole('dialog', { name: 'Mock composer' })).toHaveTextContent('Reply composer')
    await user.click(screen.getByRole('button', { name: 'Close composer' }))

    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    fireEvent.contextMenu(screen.getByText('notes.txt').closest('.attachment-card')!)
    await user.click(screen.getByRole('menuitem', { name: 'Copy filename' }))
    expect(writeText).toHaveBeenCalledWith('notes.txt')
    expect(screen.getByText('2 attachments')).toBeInTheDocument()
  })

  it('renders trashed conversations and handles provider events with fallback messages', async () => {
    const user = userEvent.setup()
    api.mail.mail.thread.mockResolvedValue({ ...thread, messages: thread.messages.map((message) => ({ ...message, labelIds: ['TRASH'] })) })
    renderWindow(); await screen.findByRole('heading', { name: 'Launch discussion' })
    expect(screen.getByRole('button', { name: 'Move to inbox' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Restore from trash' }))
    await waitFor(() => expect(api.mail.mail.action).toHaveBeenCalledWith(expect.objectContaining({ action: 'untrash' })))
    emitMail?.({ type: 'operation', payload: { id: 'operation', status: 'failed' } })
    expect(await screen.findByText('The mail provider rejected the change')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Reply' }))
    await user.click(screen.getByRole('button', { name: 'Complete send' }))
    emitMail?.({ type: 'draft-delivery', payload: { id: 'send-1', status: 'failed' } })
    expect(await screen.findByText('Message could not be sent')).toBeInTheDocument()
  })

  it('uses non-Error fallbacks for load, actions, undo, cancellation, attachments, and remote images', async () => {
    window.history.replaceState({}, '', '/?view=message&source=connected&accountId=account&threadId=thread')
    api.mail.mail.thread.mockRejectedValueOnce('missing')
    const failed = renderWindow()
    expect(await screen.findByText('The message could not be opened')).toBeInTheDocument()
    failed.unmount()

    api.mail.mail.thread.mockResolvedValue(thread)
    const user = userEvent.setup()
    renderWindow(); await screen.findByText('report.pdf')
    api.mail.mail.action.mockRejectedValueOnce('action failed')
    await user.click(screen.getByRole('button', { name: 'Mark as read' }))
    expect(await screen.findByText('The conversation could not be updated')).toBeInTheDocument()

    api.mail.attachments.open.mockRejectedValueOnce('open failed')
    await user.click(screen.getByTitle('Open'))
    expect(await screen.findByText('The attachment could not be opened')).toBeInTheDocument()
    api.mail.attachments.save.mockResolvedValueOnce({ error: 'save result failed' })
    await user.click(screen.getByRole('button', { name: 'Save as' }))
    expect(await screen.findByText('save result failed')).toBeInTheDocument()
    api.mail.attachments.save.mockRejectedValueOnce('save threw')
    await user.click(screen.getByRole('button', { name: 'Save as' }))
    expect(await screen.findByText('The attachment could not be saved')).toBeInTheDocument()

    api.mail.mail.thread.mockRejectedValueOnce('images failed')
    await user.click(screen.getByRole('button', { name: /Load remote images/ }))
    expect(await screen.findByText('Remote images could not be loaded')).toBeInTheDocument()

    api.mail.mail.action.mockResolvedValueOnce({ id: 'undo-fallback', accountId: 'account', kind: 'star', status: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), undoUntil: new Date(Date.now() + 60_000).toISOString() })
    await user.click(screen.getByRole('button', { name: 'Remove star' }))
    api.mail.mail.undo.mockRejectedValueOnce('undo failed')
    await user.click(await screen.findByRole('button', { name: 'Undo' }))
    expect(await screen.findByText('The mail change could not be undone')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Reply' }))
    await user.click(screen.getByRole('button', { name: 'Complete send' }))
    api.mail.drafts.cancelSend.mockRejectedValueOnce('cancel failed')
    await user.click(screen.getByRole('button', { name: 'Undo Send' }))
    expect(await screen.findByText('The message could not be cancelled')).toBeInTheDocument()
  })

  it('falls back to the latest message, a light system theme, and ignores a cancelled save dialog', async () => {
    window.history.replaceState({}, '', '/?view=message&source=connected&accountId=account&threadId=thread&messageId=missing')
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({ matches: false })) })
    api.mail.attachments.save.mockResolvedValueOnce({})
    const user = userEvent.setup()

    renderWindow()
    expect(await screen.findByText('Second message')).toBeInTheDocument()
    expect(document.documentElement.dataset.theme).toBe('light')
    await user.click(screen.getByRole('button', { name: 'Save as' }))
    expect(api.mail.attachments.save).toHaveBeenCalledOnce()
    expect(screen.queryByText('Saved report.pdf')).not.toBeInTheDocument()
  })
})
