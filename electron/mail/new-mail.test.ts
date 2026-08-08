import { describe, expect, it } from 'vitest'
import type { ParsedMailMessage } from './database'
import { buildNewMailNotification } from './new-mail'

const message = (overrides: Partial<ParsedMailMessage> = {}): ParsedMailMessage => ({
  accountId: 'account-1', id: 'message-1', threadId: 'thread-1', historyId: '1', internalDate: '2026-08-01T10:00:00.000Z',
  fromName: 'Ada', fromEmail: 'ada@example.com', to: ['me@example.com'], cc: [], subject: 'Hello', messageIdHeader: '<one@example.com>',
  references: [], snippet: 'Hello', text: 'Hello', html: '<p>Hello</p>', labelIds: ['INBOX', 'UNREAD'], sizeEstimate: 20, rawPath: 'one.eml', attachments: [],
  ...overrides
})

describe('new mail notifications', () => {
  it('deduplicates physical IMAP copies by Message-ID', () => {
    expect(buildNewMailNotification('account-1', [message(), message({ id: 'message-2', remoteFolderId: 'All Mail' })])).toEqual(expect.objectContaining({ count: 1, threadId: 'thread-1', subject: 'Hello', sender: 'Ada' }))
  })

  it('does not notify for sent, draft, spam, or trash mail', () => {
    expect(buildNewMailNotification('account-1', [message({ labelIds: ['SENT'] }), message({ id: 'two', labelIds: ['SPAM'] })])).toBeUndefined()
  })

  it('deduplicates Message-IDs case-insensitively and ignores surrounding whitespace', () => {
    const result = buildNewMailNotification('account-1', [
      message({ id: 'one', messageIdHeader: ' <Shared@Example.com> ' }),
      message({ id: 'two', messageIdHeader: '<shared@example.com>' })
    ])
    expect(result?.count).toBe(1)
  })

  it('uses local message ids when the Message-ID header is absent', () => {
    const result = buildNewMailNotification('account-1', [
      message({ id: 'one', messageIdHeader: undefined }),
      message({ id: 'two', messageIdHeader: undefined })
    ])
    expect(result?.count).toBe(2)
  })

  it('uses the newest visible message for a single-message notification', () => {
    const result = buildNewMailNotification('account-1', [
      message({ id: 'hidden-newer', internalDate: '2026-08-02T12:00:00.000Z', labelIds: ['TRASH'] }),
      message({ id: 'visible', threadId: 'visible-thread', subject: 'Visible subject', internalDate: '2026-08-02T11:00:00.000Z' })
    ])
    expect(result).toMatchObject({ count: 1, threadId: 'visible-thread', subject: 'Visible subject' })
  })

  it('omits conversation-specific metadata for a multi-message notification', () => {
    const result = buildNewMailNotification('account-1', [message({ id: 'one' }), message({ id: 'two', messageIdHeader: '<two@example.com>' })])
    expect(result).toEqual({ accountId: 'account-1', count: 2, threadId: undefined, subject: undefined, sender: undefined })
  })

  it('falls back to the sender address when no display name exists', () => {
    expect(buildNewMailNotification('account-1', [message({ fromName: '', fromEmail: 'sender@example.com' })])?.sender).toBe('sender@example.com')
  })

  it('allows archived mail that is not spam, trash, sent, or a draft', () => {
    expect(buildNewMailNotification('account-1', [message({ labelIds: ['ARCHIVE', 'UNREAD'] })])?.count).toBe(1)
  })
})
