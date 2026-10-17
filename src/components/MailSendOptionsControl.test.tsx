// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MailAccountSummary, MailDraftRecord, MailDraftResult } from '../mail-types'
import { ContextMenuProvider } from './ContextMenu'
import MailComposeModal from './MailComposeModal'
import MailSendOptionsControl from './MailSendOptionsControl'

const account = (provider: MailAccountSummary['provider']): MailAccountSummary => ({
  id: 'account', provider, email: 'me@example.test', displayName: 'Me', color: '#123456', status: 'ready', archived: false,
  signature: '', notifications: true, syncEnabled: true
})
const result = (status: MailDraftResult['status'] = 'synced'): MailDraftResult => ({ id: 'draft', status, updatedAt: '2026-10-17T10:00:00Z' })
const api = {
  mail: {
    mail: { suggestRecipients: vi.fn(async () => []) },
    drafts: { save: vi.fn(async () => result()), send: vi.fn(async () => result('send-pending')), schedule: vi.fn(), delete: vi.fn(), stageMessageAttachments: vi.fn() }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'aerio', { configurable: true, value: api })
  Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => true) })
})

describe('MailSendOptionsControl', () => {
  it('emits normalized importance and receipt choices', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const { rerender } = render(<MailSendOptionsControl provider="microsoft" onChange={onChange} />)
    await user.click(screen.getByLabelText('Importance and receipts', { selector: 'summary' }))
    await user.selectOptions(screen.getByRole('combobox'), 'high')
    expect(onChange).toHaveBeenLastCalledWith({ importance: 'high' })
    rerender(<MailSendOptionsControl provider="microsoft" value={{ importance: 'high' }} onChange={onChange} />)
    await user.click(screen.getByRole('checkbox', { name: 'Request read receipt' }))
    expect(onChange).toHaveBeenLastCalledWith({ importance: 'high', requestReadReceipt: true })
    rerender(<MailSendOptionsControl provider="microsoft" value={{ requestReadReceipt: true }} onChange={onChange} />)
    await user.click(screen.getByRole('checkbox', { name: 'Request read receipt' }))
    expect(onChange).toHaveBeenLastCalledWith(undefined)
    expect(screen.getByText(/never proof that a message was delivered or read/)).toBeInTheDocument()
  })

  it('disables delivery receipts where the provider cannot request them', () => {
    render(<MailSendOptionsControl provider="gmail" value={{ requestDeliveryReceipt: true }} onChange={vi.fn()} />)
    const delivery = screen.getByRole('checkbox', { name: /Request delivery receipt/ })
    expect(delivery).toBeDisabled()
    expect(delivery).not.toBeChecked()
    expect(screen.getByText(/Gmail does not offer delivery receipts/)).toBeInTheDocument()
  })

  it('saves and sends the composer choices and restores them from a draft', async () => {
    const user = userEvent.setup()
    render(<ContextMenuProvider><MailComposeModal accounts={[account('imap')]} onClose={vi.fn()} onSent={vi.fn()} onToast={vi.fn()} /></ContextMenuProvider>)
    await user.type(screen.getByPlaceholderText('name@example.com'), 'ada@example.test')
    await user.click(screen.getByLabelText('Importance and receipts', { selector: 'summary' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Importance' }), 'low')
    await user.click(screen.getByRole('checkbox', { name: /Request delivery receipt/ }))
    await user.click(screen.getByRole('button', { name: /Save draft/ }))
    await waitFor(() => expect(api.mail.drafts.save).toHaveBeenCalledWith(expect.objectContaining({ sendOptions: { importance: 'low', requestDeliveryReceipt: true } })))
    await user.click(screen.getByRole('button', { name: /^Send$/ }))
    await waitFor(() => expect(api.mail.drafts.send).toHaveBeenCalledWith(expect.objectContaining({ sendOptions: { importance: 'low', requestDeliveryReceipt: true } })))
  })

  it('reopens a draft with its stored choices', async () => {
    const draft: MailDraftRecord = { ...result(), accountId: 'account', to: ['ada@example.test'], cc: [], bcc: [], subject: 'Kept', text: 'Body', attachmentPaths: [], sendOptions: { importance: 'high', requestReadReceipt: true } }
    render(<ContextMenuProvider><MailComposeModal accounts={[account('microsoft')]} draft={draft} onClose={vi.fn()} onSent={vi.fn()} onToast={vi.fn()} /></ContextMenuProvider>)
    expect(screen.getByRole('combobox', { name: 'Importance' })).toHaveValue('high')
    expect(screen.getByRole('checkbox', { name: 'Request read receipt' })).toBeChecked()
  })
})
