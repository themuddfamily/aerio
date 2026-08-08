// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MailAccountSummary, MailDraftRecord, MailThreadDetail } from '../mail-types'
import { ContextMenuProvider } from './ContextMenu'
import MailComposeModal from './MailComposeModal'

const accounts: MailAccountSummary[] = [{
  id: 'account', provider: 'gmail', email: 'me@example.test', displayName: 'Me', color: '#123456', status: 'ready', archived: false,
  signature: 'Aerio User', notifications: true, syncEnabled: true
}]
const result = (status: 'synced' | 'send-pending' | 'scheduled' | 'failed' | 'discarded' | 'discard-queued' = 'synced') => ({
  id: 'draft', status, updatedAt: '2026-08-08T10:00:00Z', ...(status === 'failed' ? { error: 'Provider rejected it' } : {})
})
const api = {
  chooseAttachments: vi.fn(async () => [{ id: 'file', name: 'report.pdf', size: 2048, path: 'C:\\files\\report.pdf', mime: 'pdf' }]),
  mail: {
    mail: { suggestRecipients: vi.fn(async () => [{ accountId: 'account', email: 'ada@example.test', name: 'Lovelace, Ada' }]) },
    drafts: {
      save: vi.fn(async () => result()), send: vi.fn(async () => result('send-pending')), schedule: vi.fn(async () => result('scheduled')),
      delete: vi.fn(async () => result('discarded')), stageMessageAttachments: vi.fn(async () => [{ name: 'forwarded.txt', size: 12, path: 'C:\\staged\\forwarded.txt' }])
    }
  }
}

const renderCompose = (props: Partial<React.ComponentProps<typeof MailComposeModal>> = {}) => {
  const callbacks = { onClose: vi.fn(), onSent: vi.fn(), onToast: vi.fn() }
  render(<ContextMenuProvider><MailComposeModal accounts={accounts} {...callbacks} {...props} /></ContextMenuProvider>)
  return callbacks
}
const rowInput = (label: string) => {
  const row = Array.from(document.querySelectorAll<HTMLElement>('.compose-row')).find((item) => item.querySelector('label')?.textContent === label)
  if (!row) throw new Error(`Missing ${label} row`)
  return row.querySelector('input,select') as HTMLInputElement
}
const editor = () => document.querySelector<HTMLDivElement>('.compose-rich-body')!

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'aerio', { configurable: true, value: api })
  window.confirm = vi.fn(() => true)
  window.prompt = vi.fn(() => 'https://example.test')
  Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => true) })
  api.chooseAttachments.mockResolvedValue([{ id: 'file', name: 'report.pdf', size: 2048, path: 'C:\\files\\report.pdf', mime: 'pdf' }])
  api.mail.drafts.save.mockResolvedValue(result())
  api.mail.drafts.send.mockResolvedValue(result('send-pending'))
  api.mail.drafts.schedule.mockResolvedValue(result('scheduled'))
  api.mail.drafts.delete.mockResolvedValue(result('discarded'))
})

describe('MailComposeModal', () => {
  it('saves an unfinished recipient as a draft without surfacing a remote validation prefix', async () => {
    const user = userEvent.setup(), callbacks = renderCompose()
    await user.type(rowInput('To'), 'unfinished recipient')
    await user.type(rowInput('Subject'), 'Work in progress')
    api.mail.drafts.save.mockRejectedValueOnce(new Error("Error invoking remote method 'mail:drafts:save': Error: disk busy"))
    await user.click(screen.getByRole('button', { name: /Save draft/ }))
    await waitFor(() => expect(api.mail.drafts.save).toHaveBeenCalledWith(expect.objectContaining({ to: ['unfinished recipient'], subject: 'Work in progress' })))
    expect(callbacks.onToast).toHaveBeenCalledWith('disk busy')
    expect(screen.getByText('disk busy')).toBeInTheDocument()
  })

  it('validates missing, incomplete, and scheduled recipients before provider calls', async () => {
    const user = userEvent.setup(), callbacks = renderCompose()
    await user.click(screen.getByRole('button', { name: /^Send$/ }))
    expect(callbacks.onToast).toHaveBeenCalledWith('Add at least one recipient')
    await user.type(rowInput('To'), 'unfinished')
    await user.click(screen.getByRole('button', { name: /^Send$/ }))
    expect(callbacks.onToast).toHaveBeenCalledWith('Finish or correct the recipient email addresses before sending')
    await user.clear(rowInput('To')); await user.type(rowInput('To'), 'reader@example.test')
    fireEvent.change(screen.getByLabelText('Scheduled delivery time'), { target: { value: '2020-01-01T10:00' } })
    await user.click(screen.getByRole('button', { name: 'Schedule' }))
    expect(callbacks.onToast).toHaveBeenCalledWith('Choose a scheduled time in the future')
    expect(api.mail.drafts.send).not.toHaveBeenCalled(); expect(api.mail.drafts.schedule).not.toHaveBeenCalled()
  })

  it('queues immediate delivery and reports provider-side send failures', async () => {
    const user = userEvent.setup(), callbacks = renderCompose({ initialTo: 'reader@example.test' })
    await user.click(screen.getByRole('button', { name: /^Send$/ }))
    await waitFor(() => expect(callbacks.onSent).toHaveBeenCalledWith(expect.objectContaining({ status: 'send-pending' })))
    expect(callbacks.onToast).toHaveBeenCalledWith('Message ready to send — use Undo if you need it back')
    expect(callbacks.onClose).toHaveBeenCalled()

    api.mail.drafts.send.mockResolvedValueOnce(result('failed'))
    const failed = renderCompose({ initialTo: 'reader@example.test' })
    await user.click(screen.getAllByRole('button', { name: /^Send$/ }).at(-1)!)
    await waitFor(() => expect(failed.onToast).toHaveBeenCalledWith('Provider rejected it'))
    expect(failed.onClose).not.toHaveBeenCalled()
  })

  it('schedules future delivery and can clear the selected delivery time', async () => {
    const callbacks = renderCompose({ initialTo: 'reader@example.test' })
    fireEvent.change(screen.getByLabelText('Scheduled delivery time'), { target: { value: '2099-08-09T12:30' } })
    expect(screen.getByRole('button', { name: 'Schedule' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }))
    await waitFor(() => expect(api.mail.drafts.schedule).toHaveBeenCalledWith(expect.any(Object), new Date('2099-08-09T12:30').toISOString()))
    expect(callbacks.onToast).toHaveBeenCalledWith(expect.stringContaining('Message scheduled for'))
    fireEvent.click(screen.getByRole('button', { name: 'Clear scheduled delivery' }))
  })

  it('adds, de-duplicates, displays, removes, and reports attachment selection failures', async () => {
    const user = userEvent.setup(), callbacks = renderCompose()
    await user.click(screen.getByTitle('Attach files'))
    expect(await screen.findByText('report.pdf')).toBeInTheDocument()
    expect(screen.getByText('2 KB')).toBeInTheDocument()
    await user.click(screen.getByTitle('Attach files'))
    expect(screen.getAllByText('report.pdf')).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'Remove report.pdf' }))
    expect(screen.queryByText('report.pdf')).not.toBeInTheDocument()
    api.chooseAttachments.mockRejectedValueOnce(new Error('picker unavailable'))
    await user.click(screen.getByTitle('Attach files'))
    expect(callbacks.onToast).toHaveBeenCalledWith('picker unavailable')
  })

  it('suggests and safely formats recipients containing commas', async () => {
    const user = userEvent.setup()
    renderCompose()
    await user.type(rowInput('To'), 'ada')
    const suggestion = await screen.findByRole('button', { name: /Lovelace, Ada/ }, { timeout: 1000 })
    await user.click(suggestion)
    expect(rowInput('To')).toHaveValue('"Lovelace, Ada" <ada@example.test>, ')
    await user.click(screen.getByRole('button', { name: 'Bcc' }))
    expect(rowInput('Bcc')).toBeInTheDocument()
  })

  it('formats rich text, sanitizes link schemes, and inserts pasted text', async () => {
    const user = userEvent.setup(), callbacks = renderCompose()
    const body = editor()
    Object.defineProperty(body, 'innerText', { configurable: true, writable: true, value: 'Hello' })
    body.innerHTML = '<b>Hello</b>'
    fireEvent.input(body)
    await user.click(screen.getByTitle('Bold'))
    await user.click(screen.getByTitle('Italic'))
    await user.click(screen.getByTitle('Underline'))
    await user.click(screen.getByTitle('Bulleted list'))
    await user.click(screen.getByTitle('Add link'))
    expect(document.execCommand).toHaveBeenCalledWith('createLink', false, 'https://example.test')
    window.prompt = vi.fn(() => 'javascript:alert(1)')
    await user.click(screen.getByTitle('Add link'))
    expect(callbacks.onToast).toHaveBeenCalledWith('Use an https://, http://, or mailto: link')
    fireEvent.paste(body, { clipboardData: { getData: () => 'Plain paste' } })
    expect(document.execCommand).toHaveBeenCalledWith('insertText', false, 'Plain paste')
  })

  it('initializes reply-all recipients and forward content while excluding the sender account', async () => {
    const thread: MailThreadDetail = {
      accountId: 'account', id: 'thread', subject: 'Planning', messages: [{
        accountId: 'account', id: 'message', threadId: 'thread', fromName: 'Ada', fromEmail: 'ada@example.test',
        to: ['me@example.test', 'bob@example.test'], cc: ['carol@example.test', 'ada@example.test'], subject: 'Planning',
        messageIdHeader: '<message@example.test>', references: ['<root@example.test>'], date: '2026-08-08T10:00:00Z', text: 'Original', html: '<p>Original</p>', sanitizedHtml: '<p>Original</p>', labelIds: ['INBOX'],
        attachments: [{ id: 'attachment', messageId: 'message', filename: 'forwarded.txt', mimeType: 'text/plain', size: 12 }]
      }]
    }
    const reply = renderCompose({ replyTo: thread, replyAll: true })
    expect(rowInput('To')).toHaveValue('ada@example.test, bob@example.test')
    expect(rowInput('Cc')).toHaveValue('carol@example.test')
    expect(rowInput('Subject')).toHaveValue('Re: Planning')
    fireEvent.click(screen.getByRole('button', { name: /^Send$/ }))
    await waitFor(() => expect(api.mail.drafts.send).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread', inReplyTo: '<message@example.test>' })))
    expect(reply.onClose).toHaveBeenCalled()
  })

  it('stages forwarded attachments and discards online or queues discard while offline', async () => {
    const thread = {
      accountId: 'account', id: 'thread', subject: 'Planning', messages: [{
        accountId: 'account', id: 'message', threadId: 'thread', fromName: 'Ada', fromEmail: 'ada@example.test', to: ['me@example.test'], cc: [], subject: 'Planning',
        date: '2026-08-08T10:00:00Z', text: 'Original', html: '', sanitizedHtml: '', labelIds: [], attachments: [{ id: 'a', messageId: 'message', filename: 'forwarded.txt', mimeType: 'text/plain', size: 12 }]
      }]
    } as MailThreadDetail
    const user = userEvent.setup(), callbacks = renderCompose({ replyTo: thread, forward: true })
    expect(rowInput('Subject')).toHaveValue('Fwd: Planning')
    await screen.findByText('forwarded.txt')
    expect(api.mail.drafts.stageMessageAttachments).toHaveBeenCalledWith(expect.any(String), 'account', 'message')
    api.mail.drafts.delete.mockResolvedValueOnce(result('discard-queued'))
    await user.click(screen.getByRole('button', { name: /Discard/ }))
    expect(callbacks.onToast).toHaveBeenCalledWith('Offline — draft will be discarded after reconnecting')
    expect(callbacks.onClose).toHaveBeenCalled()
  })

  it('saves changed content before closing and preserves an existing failed draft state', async () => {
    const draft: MailDraftRecord = {
      id: 'existing', accountId: 'account', to: ['reader@example.test'], cc: [], bcc: [], subject: 'Draft', text: 'Body', attachmentPaths: [],
      status: 'failed', updatedAt: '2026-08-08T10:00:00Z', error: 'Previous failure'
    }
    const user = userEvent.setup(), callbacks = renderCompose({ draft })
    expect(screen.getByText('Previous failure')).toBeInTheDocument()
    await user.type(rowInput('Subject'), ' changed')
    await user.click(screen.getByTitle('Save draft and close'))
    await waitFor(() => expect(api.mail.drafts.save).toHaveBeenCalled())
    expect(callbacks.onClose).toHaveBeenCalled()
  })

  it('selects plain suggestions into To, Cc, and Bcc replacement and append paths', async () => {
    const user = userEvent.setup()
    api.mail.mail.suggestRecipients.mockResolvedValue([{ accountId: 'account', email: 'bob@example.test', name: '' }])
    renderCompose()
    await user.type(rowInput('To'), 'partial')
    await user.click(await screen.findByRole('button', { name: /bob@example.test/ }))
    expect(rowInput('To')).toHaveValue('bob@example.test, ')

    await user.type(rowInput('Cc'), 'first@example.test; ')
    await user.click(await screen.findByRole('button', { name: /bob@example.test/ }))
    expect(rowInput('Cc')).toHaveValue('first@example.test, bob@example.test, ')

    await user.click(screen.getByRole('button', { name: 'Bcc' }))
    await user.type(rowInput('Bcc'), 'replace-me')
    await user.click(await screen.findByRole('button', { name: /bob@example.test/ }))
    expect(rowInput('Bcc')).toHaveValue('bob@example.test, ')
    await user.click(screen.getByRole('button', { name: 'Bcc' }))
    expect(screen.queryByText('Bcc', { selector: 'label' })).not.toBeInTheDocument()
  })

  it('initializes scheduled drafts, normalizes stored filenames, and runs attachment context actions', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const draft: MailDraftRecord = {
      id: 'scheduled', accountId: 'account', to: [], cc: [], bcc: ['hidden@example.test'], subject: '', text: '', html: '<br>',
      attachmentPaths: ['C:\\files\\0-abcdef1234-report.pdf', ''], status: 'scheduled', deliveryAt: '2099-08-09T12:30:00Z', updatedAt: '2026-08-08T10:00:00Z'
    }
    renderCompose({ draft })
    expect(rowInput('From')).toBeDisabled()
    expect(rowInput('Bcc')).toHaveValue('hidden@example.test')
    expect(screen.getByText('report.pdf')).toBeInTheDocument()
    expect(screen.getByText('attachment')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Schedule' })).toBeInTheDocument()
    fireEvent.contextMenu(screen.getByText('report.pdf').closest('span')!)
    await user.click(screen.getByRole('menuitem', { name: 'Copy filename' }))
    expect(writeText).toHaveBeenCalledWith('report.pdf')
    fireEvent.contextMenu(screen.getByText('report.pdf').closest('span')!)
    await user.click(screen.getByRole('menuitem', { name: 'Remove attachment' }))
    expect(screen.queryByText('report.pdf')).not.toBeInTheDocument()
  })

  it('uses fallback messages for save, picker, forward staging, discard, and send failures', async () => {
    const user = userEvent.setup()
    api.mail.drafts.save.mockResolvedValueOnce({ id: 'draft', status: 'failed', updatedAt: new Date().toISOString() })
    const save = renderCompose({ initialTo: 'reader@example.test' })
    await user.type(rowInput('Subject'), 'Failure')
    await user.click(screen.getByRole('button', { name: /Save draft/ }))
    await waitFor(() => expect(save.onToast).toHaveBeenCalledWith('Draft could not be saved'))
    api.chooseAttachments.mockRejectedValueOnce('picker failed')
    await user.click(screen.getByTitle('Attach files'))
    expect(save.onToast).toHaveBeenCalledWith('Attachments could not be selected')
    window.confirm = vi.fn(() => false)
    await user.click(screen.getByRole('button', { name: /Discard/ }))
    expect(api.mail.drafts.delete).not.toHaveBeenCalled()
    window.confirm = vi.fn(() => true)
    api.mail.drafts.delete.mockRejectedValueOnce('delete failed')
    await user.click(screen.getByRole('button', { name: /Discard/ }))
    expect(save.onToast).toHaveBeenCalledWith('Draft could not be discarded')
    api.mail.drafts.send.mockRejectedValueOnce('send failed')
    await user.click(screen.getByRole('button', { name: /^Send$/ }))
    expect(save.onToast).toHaveBeenCalledWith('Message could not be sent')

    const source: MailThreadDetail = {
      accountId: 'account', id: 'thread', subject: 'Fwd: Existing', messages: [{
        accountId: 'account', id: 'message', threadId: 'thread', fromName: '', fromEmail: 'me@example.test', to: ['other@example.test'], cc: [],
        subject: 'Fwd: Existing', date: '2026-08-08T10:00:00Z', text: 'Original', html: '', sanitizedHtml: '', labelIds: [],
        attachments: [{ id: 'a', messageId: 'message', filename: 'forwarded.txt', mimeType: 'text/plain', size: 12 }]
      }]
    }
    api.mail.drafts.stageMessageAttachments.mockRejectedValueOnce('stage failed')
    const forwarded = renderCompose({ replyTo: source, forward: true })
    await waitFor(() => expect(forwarded.onToast).toHaveBeenCalledWith('Forwarded attachments could not be prepared'))
    expect(screen.getAllByDisplayValue('Fwd: Existing').length).toBeGreaterThan(0)
  })

  it('replies to the original recipients when the latest sender is the current account', () => {
    const source: MailThreadDetail = {
      accountId: 'account', id: 'thread', subject: 'Re: Existing', messages: [{
        accountId: 'account', id: 'message', threadId: 'thread', fromName: 'Me', fromEmail: 'me@example.test', to: ['other@example.test'], cc: [],
        subject: 'Re: Existing', date: '2026-08-08T10:00:00Z', text: '', html: '', sanitizedHtml: '', labelIds: [], attachments: []
      }]
    }
    renderCompose({ replyTo: source })
    expect(rowInput('To')).toHaveValue('other@example.test')
    expect(rowInput('Subject')).toHaveValue('Re: Existing')
  })
})
