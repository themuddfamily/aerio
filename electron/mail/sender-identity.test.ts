import { describe, expect, it } from 'vitest'
import type { MailAccountSummary } from '../../src/mail-types'
import type { MailSenderIdentity } from '../../src/mail-identity-types'
import { describeSenderRejection, formatSenderAddress, parseGmailSendAs, parseMicrosoftProxyAddresses, resolveDraftSender, SenderIdentityError } from './sender-identity'

const account = (provider: MailAccountSummary['provider'] = 'gmail'): MailAccountSummary => ({
  id: 'account-1', provider, email: 'me@example.com', displayName: 'Me', color: '#123456', status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true
})
const identity = (overrides: Partial<MailSenderIdentity> = {}): MailSenderIdentity => ({
  id: 'alias', accountId: 'account-1', email: 'sales@example.com', name: 'Sales, Inc', replyTo: [], source: 'gmail', status: 'verified',
  isDefault: false, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...overrides
})

describe('sender identity helpers', () => {
  it('formats display names safely', () => {
    expect(formatSenderAddress('Ada Lovelace', 'ada@example.com')).toBe('Ada Lovelace <ada@example.com>')
    expect(formatSenderAddress('Sales, "Inc"\r\n', 'sales@example.com')).toBe('"Sales, \\"Inc\\"" <sales@example.com>')
    expect(formatSenderAddress('', 'a@example.com\r\n')).toBe('a@example.com')
  })

  it('parses Gmail send-as aliases and Microsoft proxy addresses', () => {
    expect(parseGmailSendAs({ sendAs: [
      { sendAsEmail: 'me@example.com', isPrimary: true, signature: ' <b>Sig</b> ' },
      { sendAsEmail: ' sales@example.com ', displayName: 'Sales', replyToAddress: 'desk@example.com', verificationStatus: 'accepted' },
      { sendAsEmail: 'wait@example.com', verificationStatus: 'pending', signature: '  ' },
      { displayName: 'No address' }
    ] })).toEqual([
      { email: 'me@example.com', name: undefined, replyTo: [], status: 'verified', signatureHtml: '<b>Sig</b>' },
      { email: 'sales@example.com', name: 'Sales', replyTo: ['desk@example.com'], status: 'verified', signatureHtml: undefined },
      { email: 'wait@example.com', name: undefined, replyTo: [], status: 'pending', signatureHtml: undefined }
    ])
    expect(parseGmailSendAs(undefined)).toEqual([])
    expect(parseMicrosoftProxyAddresses({ mail: 'Me@example.com', proxyAddresses: ['SMTP:me@example.com', 'smtp:alias@example.com', 'SIP:me@example.com', 'smtp:ALIAS@example.com', 'smtp:'] }, 'me@example.com'))
      .toEqual([{ email: 'alias@example.com', status: 'unverified' }])
    expect(parseMicrosoftProxyAddresses(undefined, 'me@example.com')).toEqual([])
  })

  it('resolves primary, alias, missing, pending, and unauthorized Gmail senders', () => {
    expect(resolveDraftSender(account(), undefined, {}, true)).toEqual({ from: 'Me <me@example.com>', email: 'me@example.com' })
    expect(resolveDraftSender(account(), undefined, { fromIdentityId: 'account-1:primary' }, true).email).toBe('me@example.com')
    expect(resolveDraftSender(account(), identity(), { fromIdentityId: 'alias' }, true)).toMatchObject({ from: '"Sales, Inc" <sales@example.com>', email: 'sales@example.com' })
    expect(resolveDraftSender(account(), undefined, { fromIdentityId: 'gone' }, false).email).toBe('me@example.com')
    expect(() => resolveDraftSender(account(), undefined, { fromIdentityId: 'gone' }, true)).toThrow(/no longer configured.*kept as a draft/)
    expect(() => resolveDraftSender(account(), identity({ accountId: 'other' }), { fromIdentityId: 'alias' }, true)).toThrow(SenderIdentityError)
    expect(() => resolveDraftSender(account(), identity({ status: 'pending' }), { fromIdentityId: 'alias' }, true)).toThrow(/not finished verifying/)
    expect(() => resolveDraftSender(account(), identity({ source: 'manual', status: 'unverified' }), { fromIdentityId: 'alias' }, true)).toThrow(/has not authorized/)
    expect(resolveDraftSender(account(), identity({ status: 'pending' }), { fromIdentityId: 'alias' }, false).email).toBe('sales@example.com')
    expect(resolveDraftSender(account('imap'), identity({ source: 'manual', status: 'unverified' }), { fromIdentityId: 'alias' }, true).email).toBe('sales@example.com')
  })

  it('turns provider send-as rejections into actionable errors only for aliases', () => {
    const alias = resolveDraftSender(account('microsoft'), identity({ source: 'microsoft' }), { fromIdentityId: 'alias' }, true)
    const graph = Object.assign(new Error('ErrorSendAsDenied: The user account which was used to submit this request does not have the right to send mail on behalf of the specified sending account.'), { status: 403 })
    expect(describeSenderRejection(graph, 'microsoft', alias)?.message).toMatch(/^Microsoft refused to send as sales@example.com.*kept as a draft/)
    expect(describeSenderRejection(Object.assign(new Error('Access is denied'), { status: 403 }), 'microsoft', alias)).toBeUndefined()
    expect(describeSenderRejection(Object.assign(new Error('Invalid From header'), { status: 400 }), 'gmail', alias)?.message).toMatch(/^Gmail refused/)
    expect(describeSenderRejection(Object.assign(new Error('Rate limit'), { status: 429 }), 'gmail', alias)).toBeUndefined()
    expect(describeSenderRejection(Object.assign(new Error('553 5.7.1 Sender address rejected: not owned by user'), { responseCode: 553 }), 'imap', alias)?.message).toMatch(/^The mail server refused/)
    expect(describeSenderRejection(new Error('Sender address rejected: not owned by user'), 'icloud', alias)).toBeInstanceOf(SenderIdentityError)
    expect(describeSenderRejection(Object.assign(new Error('Mailbox full'), { responseCode: 552 }), 'imap', alias)).toBeUndefined()
    expect(describeSenderRejection(graph, 'microsoft', resolveDraftSender(account('microsoft'), undefined, {}, true))).toBeUndefined()
    expect(describeSenderRejection(new SenderIdentityError('x'), 'gmail', alias)).toBeUndefined()
    expect(describeSenderRejection('plain failure about sender', 'imap', alias)).toBeUndefined()
  })
})
