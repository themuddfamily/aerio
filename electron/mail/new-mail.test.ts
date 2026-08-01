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
})
