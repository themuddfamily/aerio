import PostalMime from 'postal-mime'
import { describe, expect, it, vi } from 'vitest'
import type { MailAccountSummary } from '../../src/mail-types'
import {
  addressList,
  automaticReceiptBlocker,
  createReadReceiptMime,
  createReceiptService,
  headerBlock,
  isReceiptReport,
  parseHeaders,
  parseReceiptReport,
  readReceiptRequest,
  type ReceiptServiceDependencies
} from './receipts'

const requestMessage = (extra = '') => [
  'Return-Path: <ada@example.com>',
  'From: Ada Lovelace <ada@example.com>',
  'To: person@example.com',
  'Subject: Launch plan',
  'Message-ID: <launch-1@example.com>',
  'Disposition-Notification-To: Ada Lovelace',
  ' <ada@example.com>',
  extra,
  '',
  'Body'
].filter((line, index, lines) => line !== '' || index === lines.length - 2).join('\r\n')

const mdn = [
  'From: Reader <reader@example.org>',
  'To: person@example.com',
  'Subject: Read: Quarterly plan',
  'Content-Type: multipart/report; report-type="disposition-notification";',
  '\tboundary="mdn-boundary"',
  '',
  'Preamble',
  '--mdn-boundary',
  'Content-Type: text/plain',
  '',
  'Your message was displayed.',
  '--mdn-boundary',
  'Content-Type: message/disposition-notification',
  '',
  'Reporting-UA: reader.example.org; Example Mail',
  'Final-Recipient: rfc822; reader@example.org',
  'Original-Message-ID: <plan-1@aerio.local>',
  'Disposition: manual-action/MDN-sent-manually; displayed',
  '--mdn-boundary--',
  ''
].join('\r\n')

const dsn = [
  'From: Mail Delivery System <MAILER-DAEMON@mx.example.org>',
  'Content-Type: multipart/report; report-type=delivery-status; boundary=dsn',
  '',
  '--dsn',
  'Content-Type: text/plain',
  '',
  'Delivery report',
  '--dsn',
  'Content-Type: message/delivery-status',
  '',
  'Reporting-MTA: dns; mx.example.org',
  '',
  'Final-Recipient: rfc822; one@example.org',
  'Action: delivered',
  'Status: 2.0.0',
  '',
  'Final-Recipient: rfc822; two@example.org',
  'Action: failed',
  'Status: 5.1.1',
  '--dsn',
  'Content-Type: text/rfc822-headers',
  '',
  'Message-ID: <plan-1@aerio.local>',
  'Subject: Quarterly plan',
  '--dsn--',
  ''
].join('\r\n')

describe('receipt parsing', () => {
  it('reads folded Disposition-Notification-To requests and address lists', () => {
    const headers = parseHeaders(headerBlock(requestMessage()))
    expect(readReceiptRequest(headers)).toEqual({ notifyTo: 'Ada Lovelace <ada@example.com>', addresses: ['ada@example.com'] })
    expect(readReceiptRequest(parseHeaders('From: ada@example.com'))).toBeUndefined()
    expect(addressList('"Lovelace, Ada" <ada@example.com>, bob@example.com (Bob), not-an-address')).toEqual(['ada@example.com', 'bob@example.com'])
  })

  it('holds automatic receipts for junk, automated mail, several or mismatched addresses', () => {
    const headers = parseHeaders(headerBlock(requestMessage()))
    const base = { addresses: ['ada@example.com'], headers, fromEmail: 'ada@example.com', labelIds: ['INBOX'] }
    expect(automaticReceiptBlocker(base)).toBeUndefined()
    expect(automaticReceiptBlocker({ ...base, labelIds: ['SPAM'] })).toMatch(/junk/)
    expect(automaticReceiptBlocker({ ...base, addresses: ['ada@example.com', 'eve@example.com'] })).toMatch(/more than one/)
    expect(automaticReceiptBlocker({ ...base, addresses: ['tracker@example.net'] })).toMatch(/different/)
    expect(automaticReceiptBlocker({ ...base, headers: parseHeaders(headerBlock(requestMessage('Auto-Submitted: auto-generated'))) })).toMatch(/Automated/)
    // Without Return-Path the From address is the reference.
    expect(automaticReceiptBlocker({ ...base, headers: parseHeaders('From: ada@example.com') })).toBeUndefined()
  })

  it('parses returned read receipts (MDN)', () => {
    expect(isReceiptReport(parseHeaders(headerBlock(mdn)))).toBe(true)
    expect(parseReceiptReport(mdn)).toEqual({
      kind: 'read',
      reporter: 'reader@example.org',
      originalMessageId: '<plan-1@aerio.local>',
      disposition: 'displayed',
      recipients: [{ recipient: 'reader@example.org', action: 'displayed' }]
    })
  })

  it('parses delivery status notifications per recipient and their returned Message-ID', () => {
    expect(parseReceiptReport(dsn)).toEqual({
      kind: 'delivery',
      reporter: 'mx.example.org',
      originalMessageId: '<plan-1@aerio.local>',
      recipients: [
        { recipient: 'one@example.org', action: 'delivered', status: '2.0.0' },
        { recipient: 'two@example.org', action: 'failed', status: '5.1.1' }
      ]
    })
    expect(parseReceiptReport(requestMessage())).toBeUndefined()
    expect(parseReceiptReport('Content-Type: multipart/report; report-type=other; boundary=x\r\n\r\n--x--')).toBeUndefined()
  })

  it('builds an RFC 8098 MDN that Aerio and standard parsers can read back', async () => {
    const raw = createReadReceiptMime({ from: 'Person <person@example.com>', finalRecipient: 'person@example.com', notifyTo: 'Ada <ada@example.com>', originalMessageId: '<launch-1@example.com>', originalSubject: 'Launch\r\nBcc: injected', automatic: true })
    const parsed = await PostalMime.parse(raw)
    expect(parsed.subject).toBe('Read: Launch Bcc: injected')
    expect(parsed.inReplyTo).toBe('<launch-1@example.com>')
    expect(raw.toString()).toContain('Auto-Submitted: auto-replied')
    expect(raw.toString()).not.toMatch(/^Bcc:/m)
    expect(parseReceiptReport(raw.toString())).toMatchObject({ kind: 'read', originalMessageId: '<launch-1@example.com>', disposition: 'displayed' })
    expect(raw.toString()).toContain('manual-action/MDN-sent-automatically; displayed')
    expect(createReadReceiptMime({ from: 'p@example.com', finalRecipient: 'p@example.com', notifyTo: 'a@example.com', originalSubject: 'x', automatic: false }).toString())
      .toMatch(/MDN-sent-manually[\s\S]*$/)
  })
})

const account: MailAccountSummary = { id: 'account-1', provider: 'imap', email: 'person@example.com', displayName: 'Person', color: '#000', status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true }

function harness(raw: string, overrides: { fromEmail?: string; labelIds?: string[]; online?: boolean } = {}) {
  const responses = new Map<string, NonNullable<ReturnType<ReceiptServiceDependencies['database']['getReceiptResponse']>>>()
  const sendRaw = vi.fn<ReceiptServiceDependencies['sendRaw']>(async () => undefined)
  let online = overrides.online ?? true
  const deps: ReceiptServiceDependencies = {
    database: {
      getAccount: (id) => id === account.id ? account : undefined,
      receiptMessageContext: () => ({ fromEmail: overrides.fromEmail ?? 'ada@example.com', subject: 'Launch plan', messageIdHeader: '<launch-1@example.com>', labelIds: overrides.labelIds ?? ['INBOX'], rawPath: 'message.eml' }),
      messageByHeaderId: (_accountId, id) => id === '<plan-1@aerio.local>' ? { id: 'sent-1', subject: 'Quarterly plan', date: '2026-10-01T10:00:00.000Z' } : undefined,
      getReceiptResponse: (_accountId, messageId) => responses.get(messageId),
      recordReceiptResponse: (_accountId, messageId, input) => {
        const value = { notifyTo: input.notifyTo, status: input.status, automatic: input.automatic, error: input.error, respondedAt: '2026-10-17T00:00:00.000Z' }
        responses.set(messageId, value)
        return value
      }
    },
    readRaw: (_path, maxBytes) => Buffer.from(raw).subarray(0, maxBytes),
    online: () => online,
    sendRaw
  }
  return { service: createReceiptService(deps), sendRaw, responses, setOnline: (value: boolean) => { online = value } }
}

describe('read receipt service', () => {
  it('asks by default and sends nothing until the user consents', async () => {
    const { service, sendRaw } = harness(requestMessage())
    await expect(service.inspect('account-1', 'message-1', 'ask')).resolves.toEqual({ request: { notifyTo: 'Ada Lovelace <ada@example.com>', policy: 'ask', status: 'pending' } })
    expect(sendRaw).not.toHaveBeenCalled()
    await expect(service.respond('account-1', 'message-1', 'send', 'ask')).resolves.toMatchObject({ request: { status: 'sent', automatic: false } })
    expect(sendRaw).toHaveBeenCalledOnce()
    expect(sendRaw.mock.calls[0][2]).toEqual(['ada@example.com'])
    expect(sendRaw.mock.calls[0][1].toString()).toContain('MDN-sent-manually')
    // Answered requests are never sent twice.
    await service.respond('account-1', 'message-1', 'send', 'ask')
    await expect(service.inspect('account-1', 'message-1', 'always')).resolves.toMatchObject({ request: { status: 'sent' } })
    expect(sendRaw).toHaveBeenCalledOnce()
  })

  it('records a decline and still lets the user change their mind', async () => {
    const { service, sendRaw } = harness(requestMessage())
    await expect(service.respond('account-1', 'message-1', 'decline', 'ask')).resolves.toMatchObject({ request: { status: 'declined' } })
    await expect(service.inspect('account-1', 'message-1', 'always')).resolves.toMatchObject({ request: { status: 'declined' } })
    expect(sendRaw).not.toHaveBeenCalled()
    await expect(service.respond('account-1', 'message-1', 'send', 'ask')).resolves.toMatchObject({ request: { status: 'sent' } })
  })

  it('never sends under the never policy', async () => {
    const { service, sendRaw } = harness(requestMessage())
    await expect(service.inspect('account-1', 'message-1', 'never')).resolves.toMatchObject({ request: { status: 'suppressed' } })
    await expect(service.respond('account-1', 'message-1', 'send', 'never')).rejects.toThrow(/turned off/)
    expect(sendRaw).not.toHaveBeenCalled()
  })

  it('sends automatically under always only for safe requests', async () => {
    const safe = harness(requestMessage())
    await expect(safe.service.inspect('account-1', 'message-1', 'always')).resolves.toMatchObject({ request: { status: 'sent', automatic: true } })
    expect(safe.sendRaw.mock.calls[0][1].toString()).toContain('MDN-sent-automatically')

    const junk = harness(requestMessage(), { labelIds: ['SPAM'] })
    await expect(junk.service.inspect('account-1', 'message-1', 'always')).resolves.toMatchObject({ request: { status: 'pending', reason: expect.stringMatching(/junk/) } })
    const offline = harness(requestMessage(), { online: false })
    await expect(offline.service.inspect('account-1', 'message-1', 'always')).resolves.toMatchObject({ request: { status: 'pending', reason: expect.stringMatching(/offline/) } })
    await expect(offline.service.respond('account-1', 'message-1', 'send', 'always')).rejects.toThrow(/internet/)
    expect(junk.sendRaw).not.toHaveBeenCalled()
    expect(offline.sendRaw).not.toHaveBeenCalled()
  })

  it('reports failures without retrying automatically', async () => {
    const { service, sendRaw } = harness(requestMessage())
    sendRaw.mockRejectedValueOnce(new Error('SMTP refused'))
    await expect(service.inspect('account-1', 'message-1', 'always')).resolves.toMatchObject({ request: { status: 'failed', error: 'SMTP refused' } })
    await service.inspect('account-1', 'message-1', 'always')
    expect(sendRaw).toHaveBeenCalledOnce()
    await expect(service.respond('account-1', 'message-1', 'send', 'always')).resolves.toMatchObject({ request: { status: 'sent' } })
  })

  it('ignores requests on the account’s own mail and on receipts themselves', async () => {
    const own = harness(requestMessage(), { fromEmail: 'Person@Example.com' })
    await expect(own.service.inspect('account-1', 'message-1', 'always')).resolves.toEqual({})
    await expect(own.service.respond('account-1', 'message-1', 'send', 'ask')).rejects.toThrow(/did not ask/)
    expect(own.sendRaw).not.toHaveBeenCalled()
  })

  it('correlates returned receipts with the sent message', async () => {
    await expect(harness(mdn).service.inspect('account-1', 'message-1', 'ask')).resolves.toEqual({
      report: expect.objectContaining({ kind: 'read', originalSubject: 'Quarterly plan', originalSentAt: '2026-10-01T10:00:00.000Z' })
    })
    const unknown = harness(mdn.replace('plan-1@aerio.local', 'other@aerio.local'))
    const info = await unknown.service.inspect('account-1', 'message-1', 'ask')
    expect(info.report?.originalSubject).toBeUndefined()
    expect(info.request).toBeUndefined()
  })
})
