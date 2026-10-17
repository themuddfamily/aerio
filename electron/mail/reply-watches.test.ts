import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MailDatabase, type ParsedMailMessage } from './database'
import { messageIdFromMime, normalizeMessageId, replyMatchesWatch, watchExpiryDue, type ReplyCandidate } from './reply-watches'

const directories: string[] = []
const SENT_AT = '2026-08-01T10:00:00.000Z'

function account(id: string, email: string) {
  return { id, provider: 'gmail' as const, email, displayName: 'Person', color: '#6558e8', status: 'ready' as const, archived: false, signature: '', notifications: true, syncEnabled: true }
}

function setup(path?: string) {
  const directory = path ?? mkdtempSync(join(tmpdir(), 'aerio-watch-test-'))
  if (!path) directories.push(directory)
  const database = new MailDatabase(join(directory, 'aerio.sqlite'), join(directory, 'mail'))
  database.upsertAccount(account('account-1', 'me@example.com'))
  database.upsertAccount(account('account-2', 'other@example.com'))
  return { database, directory }
}

function message(overrides: Partial<ParsedMailMessage> = {}): ParsedMailMessage {
  return {
    accountId: 'account-1', id: 'message-1', threadId: 'thread-1', historyId: '1', internalDate: '2026-08-01T11:00:00.000Z',
    fromName: 'Ada', fromEmail: 'ada@example.com', to: ['me@example.com'], cc: [], subject: 'Re: Proposal',
    messageIdHeader: '<reply-1@example.com>', references: [], snippet: '', text: '', html: '', labelIds: ['INBOX', 'UNREAD'],
    sizeEstimate: 10, rawPath: 'raw.eml', attachments: [], ...overrides
  }
}

function queueDraft(database: MailDatabase, id = 'draft-1', status: 'send-pending' | 'scheduled' = 'send-pending') {
  database.saveDraft({ id, accountId: 'account-1', to: ['Ada <ada@example.com>', 'grace@example.com'], cc: [], bcc: [], subject: 'Proposal', text: 'Body', attachmentPaths: [] }, { status, deliveryAt: SENT_AT })
}

function candidate(overrides: Partial<ReplyCandidate> = {}): ReplyCandidate {
  return { id: 'm', threadId: 'thread-1', fromEmail: 'ada@example.com', headerMessageId: '<r@example.com>', references: [], labelIds: ['INBOX'], internalDate: '2026-08-01T11:00:00.000Z', ...overrides }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('reply watch matching', () => {
  const watch = { messageIdHeader: '<sent@aerio.local>', threadId: 'thread-1', recipients: ['Ada <ada@example.com>', 'grace@example.com'], sentAt: SENT_AT }

  it('matches references to the sent Message-ID from any sender', () => {
    expect(replyMatchesWatch(watch, candidate({ threadId: 'elsewhere', fromEmail: 'forwarded@example.com', references: ['<root@x>', '<SENT@aerio.local>'] }), 'me@example.com')).toBe(true)
    expect(normalizeMessageId('Sent@Aerio.local')).toBe('<sent@aerio.local>')
  })

  it('matches later thread mail only from an original recipient', () => {
    expect(replyMatchesWatch(watch, candidate({ fromEmail: 'Grace@Example.com' }), 'me@example.com')).toBe(true)
    expect(replyMatchesWatch(watch, candidate({ fromEmail: 'stranger@example.com' }), 'me@example.com')).toBe(false)
    expect(replyMatchesWatch(watch, candidate({ internalDate: '2026-08-01T09:00:00.000Z' }), 'me@example.com')).toBe(false)
    expect(replyMatchesWatch(watch, candidate({ threadId: 'thread-2' }), 'me@example.com')).toBe(false)
  })

  it('ignores the sent copy, drafts, and the account’s own messages', () => {
    expect(replyMatchesWatch(watch, candidate({ headerMessageId: '<sent@aerio.local>', references: ['<sent@aerio.local>'] }), 'me@example.com')).toBe(false)
    expect(replyMatchesWatch(watch, candidate({ labelIds: ['SENT'], references: ['<sent@aerio.local>'] }), 'me@example.com')).toBe(false)
    expect(replyMatchesWatch(watch, candidate({ fromEmail: 'me@example.com', references: ['<sent@aerio.local>'] }), 'ME@example.com')).toBe(false)
  })

  it('expires deadlines only after a post-deadline sync, a grace period, or when sync is off', () => {
    const due = { status: 'watching' as const, deadlineAt: '2026-08-02T10:00:00.000Z' }
    const now = Date.parse('2026-08-02T12:00:00.000Z')
    const synced = { email: 'me@example.com', archived: false, syncEnabled: true }
    expect(watchExpiryDue(due, { ...synced, lastSyncAt: '2026-08-02T09:00:00.000Z' }, now)).toBe(false)
    expect(watchExpiryDue(due, { ...synced, lastSyncAt: '2026-08-02T11:00:00.000Z' }, now)).toBe(true)
    expect(watchExpiryDue(due, { ...synced, lastSyncAt: '2026-08-02T09:00:00.000Z' }, Date.parse('2026-08-03T11:00:00.000Z'))).toBe(true)
    expect(watchExpiryDue(due, { ...synced, syncEnabled: false }, now)).toBe(true)
    expect(watchExpiryDue({ ...due, deadlineAt: '2026-08-03T00:00:00.000Z' }, { ...synced, lastSyncAt: '2026-08-02T11:00:00.000Z' }, now)).toBe(false)
    expect(watchExpiryDue({ status: 'watching' }, synced, now)).toBe(false)
  })

  it('reads the Message-ID from built MIME buffers and Gmail base64url', () => {
    const mime = 'Date: x\r\nmessage-id: <abc@aerio.local>\r\nSubject: Hi\r\n\r\nMessage-ID: <body@x>'
    expect(messageIdFromMime(Buffer.from(mime))).toBe('<abc@aerio.local>')
    expect(messageIdFromMime(Buffer.from(mime).toString('base64url'))).toBe('<abc@aerio.local>')
    expect(messageIdFromMime(Buffer.from('Subject: none\r\n\r\nbody'))).toBeUndefined()
  })
})

describe('ReplyWatchStore', () => {
  it('activates a draft watch on delivery and notifies on a reply from a second recipient', () => {
    const { database } = setup()
    queueDraft(database)
    const watch = database.replyWatches.createForDraft('account-1', 'draft-1', '2026-09-01T00:00:00.000Z')
    expect(watch).toMatchObject({ status: 'pending', subject: 'Proposal', recipients: ['Ada <ada@example.com>', 'grace@example.com'] })
    // Re-arming the same outgoing message updates rather than duplicates.
    expect(database.replyWatches.createForDraft('account-1', 'draft-1').id).toBe(watch.id)
    expect(database.replyWatches.list()).toHaveLength(1)
    expect(database.replyWatches.process()).toEqual([])

    database.replyWatches.activateForDraft('draft-1', { messageIdHeader: '<sent@aerio.local>', sentAt: SENT_AT })
    // The provider's Sent copy reveals the thread; it never counts as a reply.
    database.upsertMessage(message({ id: 'sent-copy', threadId: 'thread-9', fromEmail: 'me@example.com', subject: 'Proposal', messageIdHeader: '<sent@aerio.local>', labelIds: ['SENT'], internalDate: SENT_AT }))
    // Unrelated mail, including a same-account message in another thread and same address in another account.
    database.upsertMessage(message({ id: 'unrelated', threadId: 'thread-2', fromEmail: 'grace@example.com', subject: 'Lunch?' }))
    database.upsertMessage(message({ accountId: 'account-2', id: 'other-account', threadId: 'thread-9', fromEmail: 'grace@example.com', references: ['<sent@aerio.local>'] }))
    expect(database.replyWatches.process()).toEqual([])
    expect(database.replyWatches.get(watch.id)).toMatchObject({ status: 'watching', threadId: 'thread-9', messageIdHeader: '<sent@aerio.local>' })

    // Gmail-style thread grouping is enough when the reply lacks References.
    database.upsertMessage(message({ id: 'reply', threadId: 'thread-9', fromName: 'Grace', fromEmail: 'grace@example.com' }))
    const events = database.replyWatches.process()
    expect(events).toEqual([{ reason: 'replied', watch: expect.objectContaining({ id: watch.id, status: 'replied', replyMessageId: 'reply', replyThreadId: 'thread-9', replyFrom: 'Grace <grace@example.com>' }) }])
    expect(database.replyWatches.process()).toEqual([])
    expect(database.replyWatches.cancel(watch.id)).toBe(false)
    database.close()
  })

  it('adopts a provider-assigned Sent copy by subject and send time when no Message-ID is known', () => {
    const { database } = setup()
    queueDraft(database)
    const watch = database.replyWatches.createForDraft('account-1', 'draft-1')
    database.replyWatches.activateForDraft('draft-1', { sentAt: SENT_AT })
    database.upsertMessage(message({ id: 'sent-copy', threadId: 'conversation-1', fromEmail: 'me@example.com', subject: 'Proposal', messageIdHeader: '<exchange@outlook.com>', labelIds: ['SENT'], internalDate: '2026-08-01T10:01:00.000Z' }))
    database.upsertMessage(message({ id: 'reply', threadId: 'other-conversation', fromEmail: 'stranger@example.com', references: ['<exchange@outlook.com>'] }))
    expect(database.replyWatches.process()).toMatchObject([{ reason: 'replied', watch: { id: watch.id, messageIdHeader: '<exchange@outlook.com>', replyMessageId: 'reply' } }])
    database.close()
  })

  it('persists across restart and matches replies synced while the app was closed', () => {
    const first = setup()
    queueDraft(first.database, 'draft-1', 'scheduled')
    const watch = first.database.replyWatches.createForDraft('account-1', 'draft-1')
    first.database.replyWatches.activateForDraft('draft-1', { messageIdHeader: '<sent@aerio.local>', threadId: 'thread-1', sentAt: SENT_AT })
    first.database.close()

    const second = setup(first.directory)
    expect(second.database.replyWatches.get(watch.id)).toMatchObject({ status: 'watching' })
    second.database.upsertMessage(message({ id: 'reply', references: ['<sent@aerio.local>'] }))
    expect(second.database.replyWatches.process()).toMatchObject([{ reason: 'replied', watch: { id: watch.id } }])
    second.database.close()
  })

  it('defers deadline expiry while offline and expires after the next completed sync', () => {
    const { database } = setup()
    database.upsertMessage(message({ id: 'sent', threadId: 'thread-1', fromEmail: 'me@example.com', subject: 'Proposal', messageIdHeader: '<sent@aerio.local>', labelIds: ['SENT'], internalDate: SENT_AT }))
    const deadline = new Date(Date.now() - 60_000).toISOString()
    const watch = database.replyWatches.createForMessage('account-1', 'sent', deadline)
    expect(watch).toMatchObject({ status: 'watching', recipients: ['me@example.com'], sentAt: SENT_AT })
    expect(database.replyWatches.process()).toEqual([])
    database.setAccountHistory('account-1', 'history-2', true)
    expect(database.replyWatches.process()).toMatchObject([{ reason: 'expired', watch: { id: watch.id, status: 'expired' } }])
    database.close()
  })

  it('finds earlier replies when watching an already sent message and rejects mail you did not send', () => {
    const { database } = setup()
    database.upsertMessage(message({ id: 'reply', threadId: 'thread-x', references: ['<sent@aerio.local>'] }))
    database.upsertMessage(message({ id: 'sent', threadId: 'thread-1', fromEmail: 'me@example.com', subject: 'Proposal', messageIdHeader: '<sent@aerio.local>', labelIds: ['SENT'], internalDate: SENT_AT }))
    expect(() => database.replyWatches.createForMessage('account-1', 'reply')).toThrow('Only messages you sent')
    expect(() => database.replyWatches.createForMessage('account-1', 'missing')).toThrow('not available offline')
    database.upsertMessage(message({ id: 'no-id', fromEmail: 'me@example.com', messageIdHeader: undefined, labelIds: ['SENT'] }))
    expect(() => database.replyWatches.createForMessage('account-1', 'no-id')).toThrow('no Message-ID')
    const watch = database.replyWatches.createForMessage('account-1', 'sent')
    expect(database.replyWatches.process()).toMatchObject([{ reason: 'replied', watch: { id: watch.id, replyMessageId: 'reply' } }])
    database.close()
  })

  it('cancels watches on request, undo send, discarded drafts, and account removal', () => {
    const { database } = setup()
    expect(() => database.replyWatches.createForDraft('account-1', 'missing')).toThrow('not found')
    database.saveDraft({ id: 'local', accountId: 'account-1', to: [], cc: [], bcc: [], subject: '', text: '', attachmentPaths: [] })
    expect(() => database.replyWatches.createForDraft('account-1', 'local')).toThrow('Send or schedule')
    queueDraft(database, 'undo')
    const undone = database.replyWatches.createForDraft('account-1', 'undo')
    database.cancelDraftDelivery('undo')
    expect(database.replyWatches.cancelForDraft('undo')).toBe(1)
    expect(database.replyWatches.get(undone.id)?.status).toBe('cancelled')

    queueDraft(database, 'discarded')
    const discarded = database.replyWatches.createForDraft('account-1', 'discarded')
    database.deleteDraftRecord('discarded')
    database.replyWatches.process()
    expect(database.replyWatches.get(discarded.id)?.status).toBe('cancelled')

    queueDraft(database, 'manual')
    const manual = database.replyWatches.createForDraft('account-1', 'manual')
    expect(database.replyWatches.cancel(manual.id)).toBe(true)
    expect(database.replyWatches.list(['account-1']).map((item) => item.status)).toEqual(['cancelled', 'cancelled', 'cancelled'])

    queueDraft(database, 'removed')
    database.replyWatches.createForDraft('account-1', 'removed')
    database.disconnectAccount('account-1', 'delete')
    expect(database.replyWatches.list()).toEqual([])
    database.close()
  })
})
