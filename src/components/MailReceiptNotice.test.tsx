// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MailReceiptInfo } from '../mail-types'
import MailReceiptNotice, { receiptReportSummary } from './MailReceiptNotice'

const receipts = {
  inspect: vi.fn<(accountId: string, messageId: string) => Promise<MailReceiptInfo>>(),
  respond: vi.fn<(accountId: string, messageId: string, decision: 'send' | 'decline') => Promise<MailReceiptInfo>>()
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'aerio', { configurable: true, value: { mail: { receipts } } })
})

describe('MailReceiptNotice', () => {
  it('asks before sending a requested read receipt', async () => {
    const user = userEvent.setup()
    receipts.inspect.mockResolvedValue({ request: { notifyTo: 'Ada <ada@example.com>', status: 'pending', policy: 'ask' } })
    receipts.respond.mockResolvedValue({ request: { notifyTo: 'Ada <ada@example.com>', status: 'sent', policy: 'ask', automatic: false } })
    render(<MailReceiptNotice accountId="account" messageId="message" />)
    expect(await screen.findByText(/asked for a read receipt at Ada <ada@example.com>/)).toBeInTheDocument()
    expect(receipts.respond).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Send receipt' }))
    expect(receipts.respond).toHaveBeenCalledWith('account', 'message', 'send')
    expect(await screen.findByText(/Read receipt sent to/)).toBeInTheDocument()
  })

  it('declines, explains held automatic receipts, and shows send errors', async () => {
    const user = userEvent.setup()
    receipts.inspect.mockResolvedValue({ request: { notifyTo: 'x@example.net', status: 'pending', policy: 'always', reason: 'The receipt address is different from the sender’s address.' } })
    receipts.respond.mockResolvedValueOnce({ request: { notifyTo: 'x@example.net', status: 'declined', policy: 'always' } })
    render(<MailReceiptNotice accountId="account" messageId="message" />)
    expect(await screen.findByText(/different from the sender/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Don’t send' }))
    expect(await screen.findByText(/chose not to send/)).toBeInTheDocument()
    receipts.respond.mockRejectedValueOnce(new Error("Error invoking remote method 'mail:receipts:respond': Error: Sending a read receipt requires an internet connection"))
    await user.click(screen.getByRole('button', { name: 'Send anyway' }))
    expect(await screen.findByText('Sending a read receipt requires an internet connection')).toBeInTheDocument()
  })

  it('renders nothing for suppressed requests or ordinary messages', async () => {
    receipts.inspect.mockResolvedValueOnce({ request: { notifyTo: 'a@example.com', status: 'suppressed', policy: 'never' } })
    const { container, rerender } = render(<MailReceiptNotice accountId="account" messageId="one" />)
    await waitFor(() => expect(receipts.inspect).toHaveBeenCalledTimes(1))
    expect(container).toBeEmptyDOMElement()
    receipts.inspect.mockResolvedValueOnce({})
    rerender(<MailReceiptNotice accountId="account" messageId="two" />)
    await waitFor(() => expect(receipts.inspect).toHaveBeenCalledTimes(2))
    expect(container).toBeEmptyDOMElement()
  })

  it('describes returned receipts without claiming the message was read', async () => {
    receipts.inspect.mockResolvedValue({ report: { kind: 'read', reporter: 'reader@example.org', disposition: 'displayed', originalSubject: 'Plan', recipients: [] } })
    render(<MailReceiptNotice accountId="account" messageId="message" />)
    expect(await screen.findByText(/reader@example.org reported that the message was displayed for “Plan”/)).toBeInTheDocument()
    expect(screen.getByText(/do not prove the message was read/)).toBeInTheDocument()
    expect(receiptReportSummary({ kind: 'delivery', originalMessageId: '<x>', recipients: [{ recipient: 'a@example.org', action: 'delivered' }, { recipient: 'b@example.org', action: 'failed' }] }))
      .toBe('Delivery report for a message you sent: a@example.org delivered; b@example.org could not be delivered.')
  })

  it('stays silent when the receipts bridge is unavailable', () => {
    Object.defineProperty(window, 'aerio', { configurable: true, value: { mail: {} } })
    const { container } = render(<MailReceiptNotice accountId="account" messageId="message" />)
    expect(container).toBeEmptyDOMElement()
  })
})
