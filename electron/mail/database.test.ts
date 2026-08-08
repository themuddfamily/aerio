import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { MailDatabase, mailRuleMatches, type ParsedMailMessage } from './database'

const directories: string[] = []

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'aerio-db-test-'))
  directories.push(directory)
  const path = join(directory, 'aerio.sqlite')
  const database = new MailDatabase(path, join(directory, 'mail'))
  database.upsertAccount({
    id: 'account-1',
    provider: 'gmail',
    email: 'person@example.com',
    displayName: 'Person',
    color: '#6558e8',
    status: 'ready',
    archived: false,
    signature: '',
    notifications: true,
    syncEnabled: true
  })
  return { database, directory, path }
}

function message(overrides: Partial<ParsedMailMessage> = {}): ParsedMailMessage {
  return {
    accountId: 'account-1',
    id: 'message-1',
    threadId: 'thread-1',
    historyId: '100',
    internalDate: '2026-07-27T10:00:00.000Z',
    fromName: 'Ada Lovelace',
    fromEmail: 'ada@example.com',
    to: ['person@example.com'],
    cc: [],
    subject: 'Aerio launch',
    messageIdHeader: '<message-1@example.com>',
    references: [],
    snippet: 'The offline mail engine is ready.',
    text: 'The offline mail engine is ready for launch.',
    html: '<p>The offline mail engine is ready for launch.</p>',
    labelIds: ['INBOX', 'UNREAD'],
    sizeEstimate: 1024,
    rawPath: 'message-1.eml',
    attachments: [],
    ...overrides
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('MailDatabase', () => {
  it('backs up a pre-v0.2 database before migration', () => {
    const directory = mkdtempSync(join(tmpdir(), 'aerio-migration-test-'))
    directories.push(directory)
    const path = join(directory, 'aerio.sqlite')
    const legacy = new DatabaseSync(path)
    legacy.exec('CREATE TABLE app_state(id INTEGER PRIMARY KEY, payload TEXT)')
    legacy.close()
    const migrated = new MailDatabase(path, join(directory, 'mail'))
    expect(existsSync(`${path}.v0.1.bak`)).toBe(true)
    migrated.close()
  })

  it('adds every column introduced by incremental schema migrations', () => {
    const { database, directory, path } = setup()
    database.close()
    const legacy = new DatabaseSync(path)
    for (const [table, column] of [
      ['gmail_messages', 'header_message_id'], ['gmail_messages', 'references_json'], ['gmail_messages', 'remote_folder_id'], ['gmail_messages', 'remote_uid'],
      ['gmail_threads', 'sender_email'], ['gmail_accounts', 'provider'], ['gmail_accounts', 'signature'], ['gmail_accounts', 'notifications'], ['gmail_accounts', 'sync_enabled'],
      ['gmail_sync_items', 'remote_folder_id'], ['gmail_sync_items', 'remote_uid'], ['gmail_sync_state', 'provider_state_json'], ['gmail_sync_state', 'inventory_complete'],
      ['gmail_operations', 'before_labels_json'], ['gmail_drafts', 'delivery_at']
    ]) legacy.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`)
    legacy.close()
    const migrated = new MailDatabase(path, join(directory, 'mail'))
    const verify = new DatabaseSync(path)
    for (const [table, column] of [
      ['gmail_messages', 'header_message_id'], ['gmail_messages', 'references_json'], ['gmail_messages', 'remote_folder_id'], ['gmail_messages', 'remote_uid'],
      ['gmail_threads', 'sender_email'], ['gmail_accounts', 'provider'], ['gmail_accounts', 'signature'], ['gmail_accounts', 'notifications'], ['gmail_accounts', 'sync_enabled'],
      ['gmail_sync_items', 'remote_folder_id'], ['gmail_sync_items', 'remote_uid'], ['gmail_sync_state', 'provider_state_json'], ['gmail_sync_state', 'inventory_complete'],
      ['gmail_operations', 'before_labels_json'], ['gmail_drafts', 'delivery_at']
    ]) expect((verify.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((item) => item.name === column)).toBe(true)
    verify.close()
    migrated.close()
  })

  it('matches every rule operator, field-specific equality, match mode, and empty condition', () => {
    const candidate = message()
    const matches = (field: 'from' | 'to' | 'subject' | 'body', operator: 'contains' | 'equals' | 'starts-with' | 'ends-with', value: string, match: 'all' | 'any' = 'all') => mailRuleMatches({
      accountId: 'account-1', name: 'Rule', enabled: true, match, conditions: [{ field, operator, value }], actions: [{ action: 'archive' }]
    }, candidate)
    expect(matches('from', 'equals', 'ada@example.com')).toBe(true)
    expect(matches('from', 'equals', 'Ada Lovelace')).toBe(true)
    expect(matches('from', 'equals', 'Ada Lovelace ada@example.com')).toBe(true)
    expect(matches('to', 'equals', 'person@example.com')).toBe(true)
    expect(matches('subject', 'starts-with', 'aerio')).toBe(true)
    expect(matches('body', 'ends-with', 'launch.')).toBe(true)
    expect(matches('subject', 'contains', 'launch')).toBe(true)
    expect(matches('subject', 'contains', '   ')).toBe(false)
    expect(mailRuleMatches({ accountId: 'account-1', name: 'None', enabled: true, match: 'all', conditions: [], actions: [] }, candidate)).toBe(false)
    expect(mailRuleMatches({ accountId: 'account-1', name: 'Any', enabled: true, match: 'any', conditions: [
      { field: 'subject', operator: 'equals', value: 'missing' }, { field: 'body', operator: 'contains', value: 'offline' }
    ], actions: [{ action: 'archive' }] }, candidate)).toBe(true)
    expect(mailRuleMatches({ accountId: 'account-1', name: 'All', enabled: true, match: 'all', conditions: [
      { field: 'subject', operator: 'contains', value: 'launch' }, { field: 'body', operator: 'contains', value: 'missing' }
    ], actions: [{ action: 'archive' }] }, candidate)).toBe(false)
  })

  it('indexes, pages, searches, and reads normalized messages', () => {
    const { database } = setup()
    database.addInventory('account-1', [{ id: 'message-1', threadId: 'thread-1' }])
    database.upsertMessage(message())

    const inbox = database.listThreads({ folder: 'inbox' })
    expect(inbox.total).toBe(1)
    expect(inbox.items[0]).toMatchObject({ id: 'thread-1', senderEmail: 'ada@example.com', unread: true, messageCount: 1 })
    expect(database.listThreads({ folder: 'all', search: 'offline engine' }).items).toHaveLength(1)

    const detail = database.getThread('account-1', 'thread-1')
    expect(detail.messages[0]).toMatchObject({
      messageIdHeader: '<message-1@example.com>',
      text: 'The offline mail engine is ready for launch.'
    })
    database.close()
  })

  it('applies optimistic labels and restores them during the undo window', () => {
    const { database } = setup()
    database.addInventory('account-1', [{ id: 'message-1', threadId: 'thread-1' }])
    database.upsertMessage(message())

    const operation = database.applyLocalAction({
      accountId: 'account-1',
      threadIds: ['thread-1'],
      action: 'archive'
    })
    expect(database.listThreads({ folder: 'inbox' }).total).toBe(0)
    expect(database.undoOperation(operation.id)).toBe(true)
    expect(database.listThreads({ folder: 'inbox' }).total).toBe(1)
    database.close()
  })

  it('combines advanced sender, recipient, subject, attachment, date, and status filters', () => {
    const { database } = setup()
    database.addInventory('account-1', [
      { id: 'message-1', threadId: 'thread-1' },
      { id: 'message-2', threadId: 'thread-2' }
    ])
    database.upsertMessage(message())
    database.upsertMessage(message({
      id: 'message-2',
      threadId: 'thread-2',
      internalDate: '2026-08-02T13:30:00.000Z',
      fromName: 'Grace Hopper',
      fromEmail: 'grace@example.com',
      to: ['billing@example.com'],
      cc: ['finance@example.com'],
      subject: 'August invoice report',
      messageIdHeader: '<message-2@example.com>',
      labelIds: ['INBOX', 'STARRED', 'IMPORTANT'],
      attachments: [{
        id: 'attachment-1',
        messageId: 'message-2',
        filename: 'invoice-august.pdf',
        mimeType: 'application/pdf',
        size: 4096
      }]
    }))

    const filtered = database.listThreads({
      folder: 'all',
      filters: {
        from: 'grace',
        to: 'finance@',
        subject: 'invoice',
        attachmentName: 'august.pdf',
        dateFrom: '2026-08-01',
        dateTo: '2026-08-03',
        hasAttachments: true,
        unread: false,
        starred: true,
        important: true
      }
    })

    expect(filtered.items.map((item) => item.id)).toEqual(['thread-2'])
    expect(database.listThreads({ folder: 'all', filters: { hasAttachments: false, unread: true } }).items.map((item) => item.id)).toEqual(['thread-1'])
    expect(database.listThreads({ folder: 'all', search: 'offline', filters: { from: 'ada@example.com', dateTo: '2026-07-27' } }).items.map((item) => item.id)).toEqual(['thread-1'])
    database.close()
  })

  it('rebuilds thread participants and combined labels after every upsert', () => {
    const { database } = setup()
    database.addInventory('account-1', [
      { id: 'message-1', threadId: 'thread-1' },
      { id: 'message-2', threadId: 'thread-1' }
    ])
    database.upsertMessage(message())
    database.upsertMessage(message({
      id: 'message-2',
      internalDate: '2026-07-27T11:00:00.000Z',
      fromName: 'Grace Hopper',
      fromEmail: 'grace@example.com',
      messageIdHeader: '<message-2@example.com>',
      labelIds: ['SENT'],
      subject: 'Re: Aerio launch'
    }))

    expect(database.listThreads({ folder: 'all' }).items[0]).toMatchObject({
      subject: 'Re: Aerio launch',
      participants: ['Ada Lovelace', 'Grace Hopper'],
      senderEmail: 'grace@example.com',
      unread: true,
      messageCount: 2
    })
    expect(database.listThreads({ folder: 'all' }).items[0].labelIds).toEqual(expect.arrayContaining(['INBOX', 'UNREAD', 'SENT']))
    database.close()
  })

  it('displays duplicate IMAP physical copies as one logical message while merging folders', () => {
    const { database } = setup()
    database.addInventory('account-1', [
      { id: 'inbox-copy', threadId: 'thread-1', remoteFolderId: 'INBOX', remoteUid: '10' },
      { id: 'all-copy', threadId: 'thread-1', remoteFolderId: 'All Mail', remoteUid: '20' }
    ])
    database.upsertMessage(message({ id: 'inbox-copy', rawPath: 'inbox.eml', remoteFolderId: 'INBOX', remoteUid: '10', labelIds: ['INBOX', 'UNREAD'] }))
    database.upsertMessage(message({ id: 'all-copy', rawPath: 'all.eml', remoteFolderId: 'All Mail', remoteUid: '20', labelIds: ['ARCHIVE'] }))

    const summary = database.listThreads({ folder: 'all' }).items[0]
    expect(summary.messageCount).toBe(1)
    expect(summary.labelIds).toEqual(expect.arrayContaining(['INBOX', 'UNREAD', 'ARCHIVE']))
    const detail = database.getThread('account-1', 'thread-1')
    expect(detail.messages).toHaveLength(1)
    expect(detail.messages[0].labelIds).toEqual(expect.arrayContaining(['INBOX', 'UNREAD', 'ARCHIVE']))
    expect(database.remoteMessagesForThreads('account-1', ['thread-1'])).toHaveLength(2)
    database.close()
  })

  it('undoes optimistic changes to the exact prior per-message state', () => {
    const { database } = setup()
    database.addInventory('account-1', [
      { id: 'message-1', threadId: 'thread-1' },
      { id: 'message-2', threadId: 'thread-1' }
    ])
    database.upsertMessage(message({ labelIds: ['INBOX'] }))
    database.upsertMessage(message({ id: 'message-2', messageIdHeader: '<message-2@example.com>', labelIds: ['INBOX', 'UNREAD'] }))
    const operation = database.applyLocalAction({ accountId: 'account-1', threadIds: ['thread-1'], action: 'read' })
    expect(database.undoOperation(operation.id)).toBe(true)
    const [first, second] = database.getThread('account-1', 'thread-1').messages
    expect(first.labelIds).not.toContain('UNREAD')
    expect(second.labelIds).toContain('UNREAD')
    database.close()
  })

  it('refuses operations for missing conversations instead of queueing a no-op', () => {
    const { database } = setup()
    expect(() => database.applyLocalAction({ accountId: 'account-1', threadIds: ['missing'], action: 'archive' })).toThrow(/not found/)
    database.close()
  })

  it('removes a deleted Gmail message from the pending initial-download queue', () => {
    const { database } = setup()
    database.addInventory('account-1', [{ id: 'deleted-before-download', threadId: 'thread-deleted' }])
    expect(database.pendingMessageIds('account-1', 10)).toHaveLength(1)
    database.deleteMessage('account-1', 'deleted-before-download')
    expect(database.pendingMessageIds('account-1', 10)).toHaveLength(0)
    database.close()
  })

  it('moves Gmail conversations out of Inbox into a user label and can undo exactly', () => {
    const { database } = setup()
    database.replaceLabels('account-1', [{ accountId: 'account-1', id: 'project-a', name: 'Project A', type: 'user' }])
    database.addInventory('account-1', [{ id: 'message-1', threadId: 'thread-1' }])
    database.upsertMessage(message())
    const operation = database.applyLocalAction({ accountId: 'account-1', threadIds: ['thread-1'], action: 'move', labelId: 'project-a' })
    expect(database.listThreads({ folder: 'inbox' }).total).toBe(0)
    expect(database.listThreads({ folder: 'all', labelId: 'project-a' }).total).toBe(1)
    expect(database.undoOperation(operation.id)).toBe(true)
    expect(database.listThreads({ folder: 'inbox' }).total).toBe(1)
    expect(database.listThreads({ folder: 'all', labelId: 'project-a' }).total).toBe(0)
    database.close()
  })

  it('keeps disconnected archives readable but removes deleted account data', () => {
    const { database } = setup()
    database.addInventory('account-1', [{ id: 'message-1', threadId: 'thread-1' }])
    database.upsertMessage(message())
    database.disconnectAccount('account-1', 'archive')
    expect(database.listThreads({ folder: 'all' }).total).toBe(1)
    database.disconnectAccount('account-1', 'delete')
    expect(database.listThreads({ folder: 'all' }).total).toBe(0)
    database.close()
  })

  it('preserves the remote Gmail draft id across local autosaves', () => {
    const { database } = setup()
    const input = {
      accountId: 'account-1',
      to: ['reader@example.com'],
      cc: [],
      bcc: [],
      subject: 'Draft',
      text: 'First version',
      attachmentPaths: []
    }
    const created = database.saveDraft(input, { remoteDraftId: 'gmail-draft-1', status: 'synced' })
    const updated = database.saveDraft({ ...input, id: created.id, text: 'Second version' }, { status: 'syncing' })
    expect(updated.remoteDraftId).toBe('gmail-draft-1')
    database.close()
  })

  it('refuses to overwrite a draft saved from a newer editor revision', () => {
    const { database } = setup()
    const input = { id: 'shared-draft', accountId: 'account-1', to: [], cc: [], bcc: [], subject: 'Draft', text: 'First', attachmentPaths: [] }
    const first = database.saveDraft(input)
    const second = database.saveDraft({ ...input, expectedUpdatedAt: first.updatedAt, text: 'Second' })
    expect(database.getDraftRecord(input.id)?.text).toBe('Second')
    expect(() => database.saveDraft({ ...input, expectedUpdatedAt: first.updatedAt, text: 'Stale editor' })).toThrow(/changed after it was opened/)
    expect(database.getDraftRecord(input.id)).toMatchObject({ text: 'Second', updatedAt: second.updatedAt })
    database.close()
  })

  it('lists complete editable draft records and queues provider-aware discard', () => {
    const { database } = setup()
    const created = database.saveDraft({
      id: 'draft-1',
      accountId: 'account-1',
      to: ['reader@example.com'],
      cc: ['copy@example.com'],
      bcc: [],
      subject: 'Editable draft',
      text: 'Plain body',
      html: '<p><strong>Rich body</strong></p>',
      attachmentPaths: ['staged-file.txt']
    }, { remoteDraftId: 'remote-1', status: 'synced' })
    expect(database.listDrafts()).toEqual([expect.objectContaining({
      id: created.id,
      remoteDraftId: 'remote-1',
      subject: 'Editable draft',
      html: '<p><strong>Rich body</strong></p>',
      attachmentPaths: ['staged-file.txt']
    })])
    expect(database.requestDraftDiscard(created.id)).toMatchObject({ status: 'discard-queued' })
    expect(database.draftsToDiscard()).toHaveLength(1)
    expect(database.listDrafts()).toHaveLength(0)
    database.close()
  })

  it('persists scheduled delivery, exposes due messages, and supports Undo Send', () => {
    const { database } = setup()
    const input = { id: 'scheduled-1', accountId: 'account-1', to: ['reader@example.com'], cc: [], bcc: [], subject: 'Later', text: 'Wait for it', attachmentPaths: [] }
    const future = new Date(Date.now() + 60_000).toISOString()
    const scheduled = database.saveDraft(input, { status: 'scheduled', deliveryAt: future })
    expect(scheduled).toMatchObject({ status: 'scheduled', deliveryAt: future })
    expect(database.listDrafts()[0]).toMatchObject({ status: 'scheduled', deliveryAt: future })
    expect(database.queuedDrafts()).toHaveLength(0)
    const cancelled = database.cancelDraftDelivery(scheduled.id)
    expect(cancelled.status).toBe('local')
    expect(cancelled.deliveryAt).toBeUndefined()

    database.saveDraft(input, { status: 'send-pending', deliveryAt: new Date(Date.now() - 1_000).toISOString() })
    expect(database.queuedDrafts()).toHaveLength(1)
    database.close()
  })

  it('retains an active scheduled delivery across ordinary content autosaves', () => {
    const { database } = setup()
    const future = new Date(Date.now() + 60_000).toISOString()
    const input = { id: 'scheduled-autosave', accountId: 'account-1', to: ['reader@example.com'], cc: [], bcc: [], subject: 'Later', text: 'First version', attachmentPaths: [] }
    database.saveDraft(input, { status: 'scheduled', deliveryAt: future })
    const updated = database.saveDraft({ ...input, text: 'Second version' })
    expect(updated).toMatchObject({ status: 'scheduled', deliveryAt: future })
    expect(database.getDraftRecord(input.id)).toMatchObject({ text: 'Second version', status: 'scheduled', deliveryAt: future })
    database.close()
  })

  it('returns a cancelled scheduled provider draft to synced status', () => {
    const { database } = setup()
    const scheduled = database.saveDraft({ id: 'remote-scheduled', accountId: 'account-1', to: ['reader@example.com'], cc: [], bcc: [], subject: 'Later', text: 'Body', attachmentPaths: [] }, {
      remoteDraftId: 'remote-draft-1', status: 'scheduled', deliveryAt: new Date(Date.now() + 60_000).toISOString()
    })
    expect(database.cancelDraftDelivery(scheduled.id)).toMatchObject({ status: 'synced', remoteDraftId: 'remote-draft-1' })
    expect(database.getDraftRecord(scheduled.id)?.deliveryAt).toBeUndefined()
    database.close()
  })

  it('refuses to cancel a message after delivery has completed', () => {
    const { database } = setup()
    database.saveDraft({ id: 'already-sent', accountId: 'account-1', to: ['reader@example.com'], cc: [], bcc: [], subject: 'Sent', text: 'Body', attachmentPaths: [] }, { status: 'sent' })
    expect(() => database.cancelDraftDelivery('already-sent')).toThrow(/can no longer be cancelled/)
    database.close()
  })

  it('restores scheduled delivery state after reopening the database', () => {
    const { database, directory, path } = setup()
    const future = new Date(Date.now() + 60_000).toISOString()
    database.saveDraft({ id: 'restart-scheduled', accountId: 'account-1', to: ['reader@example.com'], cc: [], bcc: [], subject: 'Restart', text: 'Body', attachmentPaths: [] }, { status: 'scheduled', deliveryAt: future })
    database.close()
    const reopened = new MailDatabase(path, join(directory, 'mail'))
    expect(reopened.getDraftRecord('restart-scheduled')).toMatchObject({ status: 'scheduled', deliveryAt: future })
    expect(reopened.queuedDrafts()).toHaveLength(0)
    reopened.close()
  })

  it('orders due deliveries by their intended send time', () => {
    const { database } = setup()
    const input = (id: string) => ({ id, accountId: 'account-1', to: ['reader@example.com'], cc: [], bcc: [], subject: id, text: 'Body', attachmentPaths: [] })
    database.saveDraft(input('middle'), { status: 'scheduled', deliveryAt: new Date(Date.now() - 2_000).toISOString() })
    database.saveDraft(input('latest'), { status: 'send-pending', deliveryAt: new Date(Date.now() - 1_000).toISOString() })
    database.saveDraft(input('earliest'), { status: 'queued', deliveryAt: new Date(Date.now() - 3_000).toISOString() })
    expect(database.queuedDrafts().map((row) => row.id)).toEqual(['earliest', 'middle', 'latest'])
    database.close()
  })

  it('hides snoozed conversations and releases them when their reminder is due', () => {
    const { database } = setup()
    database.addInventory('account-1', [{ id: 'message-1', threadId: 'thread-1' }])
    database.upsertMessage(message())
    const future = new Date(Date.now() + 60_000).toISOString()
    database.snoozeThreads('account-1', ['thread-1'], future)
    expect(database.listThreads({ folder: 'inbox' }).total).toBe(0)
    expect(database.listThreads({ folder: 'snoozed' }).items[0]).toMatchObject({ id: 'thread-1', snoozedUntil: future })
    expect(database.unsnoozeThreads('account-1', ['thread-1'])).toBe(true)
    expect(database.listThreads({ folder: 'inbox' }).total).toBe(1)

    database.snoozeThreads('account-1', ['thread-1'], new Date(Date.now() - 1_000).toISOString())
    expect(database.releaseDueSnoozes()).toEqual([expect.objectContaining({ threadId: 'thread-1' })])
    database.close()
  })

  it('reschedules an existing snooze without creating a duplicate', () => {
    const { database } = setup()
    database.addInventory('account-1', [{ id: 'message-1', threadId: 'thread-1' }])
    database.upsertMessage(message())
    database.snoozeThreads('account-1', ['thread-1'], new Date(Date.now() + 60_000).toISOString())
    const later = new Date(Date.now() + 120_000).toISOString()
    database.snoozeThreads('account-1', ['thread-1'], later)
    const snoozed = database.listThreads({ folder: 'snoozed' })
    expect(snoozed.total).toBe(1)
    expect(snoozed.items[0].snoozedUntil).toBe(later)
    database.close()
  })

  it('releases only expired snoozes while retaining future reminders', () => {
    const { database } = setup()
    database.addInventory('account-1', [{ id: 'message-1', threadId: 'thread-1' }, { id: 'message-2', threadId: 'thread-2' }])
    database.upsertMessage(message())
    database.upsertMessage(message({ id: 'message-2', threadId: 'thread-2', messageIdHeader: '<message-2@example.com>', rawPath: 'message-2.eml' }))
    database.snoozeThreads('account-1', ['thread-1'], new Date(Date.now() - 1_000).toISOString())
    database.snoozeThreads('account-1', ['thread-2'], new Date(Date.now() + 60_000).toISOString())
    expect(database.releaseDueSnoozes().map((item) => item.threadId)).toEqual(['thread-1'])
    expect(database.listThreads({ folder: 'snoozed' }).items.map((item) => item.id)).toEqual(['thread-2'])
    database.close()
  })

  it('persists mail rules and matches normalized message fields', () => {
    const { database } = setup()
    database.addInventory('account-1', [{ id: 'message-1', threadId: 'thread-1' }])
    database.upsertMessage(message())
    const rule = database.saveRule({
      accountId: 'account-1',
      name: 'Aerio updates',
      enabled: true,
      match: 'all',
      conditions: [
        { field: 'from', operator: 'ends-with', value: '@example.com' },
        { field: 'subject', operator: 'contains', value: 'launch' }
      ],
      actions: [{ action: 'archive' }, { action: 'star' }]
    })
    expect(mailRuleMatches(rule, message())).toBe(true)
    expect(database.matchingRulesForMessage(message())).toEqual([expect.objectContaining({ id: rule.id })])
    expect(database.matchingThreadIdsForRule(rule)).toEqual(['thread-1'])
    database.recordRuleMatch(rule.id)
    expect(database.getRule(rule.id)).toMatchObject({ matchCount: 1, lastMatchedAt: expect.any(String) })
    database.deleteRule(rule.id)
    expect(database.listRules()).toHaveLength(0)
    database.close()
  })

  it('keeps disabled rules out of automatic matching', () => {
    const { database } = setup()
    database.saveRule({ accountId: 'account-1', name: 'Disabled', enabled: false, match: 'all', conditions: [{ field: 'from', operator: 'contains', value: 'ada' }], actions: [{ action: 'archive' }] })
    expect(database.matchingRulesForMessage(message())).toEqual([])
    database.close()
  })

  it('preserves rule history when its definition is edited', () => {
    const { database } = setup()
    const created = database.saveRule({ accountId: 'account-1', name: 'Original', enabled: true, match: 'all', conditions: [{ field: 'from', operator: 'contains', value: 'ada' }], actions: [{ action: 'archive' }] })
    database.recordRuleMatch(created.id, 3)
    const updated = database.saveRule({ id: created.id, accountId: 'account-1', name: 'Renamed', enabled: true, match: 'any', conditions: [{ field: 'subject', operator: 'contains', value: 'launch' }], actions: [{ action: 'star' }] })
    expect(updated).toMatchObject({ id: created.id, name: 'Renamed', matchCount: 3, createdAt: created.createdAt, lastMatchedAt: expect.any(String) })
    database.close()
  })

  it('isolates rules and snoozes between accounts with identical thread ids', () => {
    const { database } = setup()
    database.upsertAccount({ id: 'account-2', provider: 'gmail', email: 'second@example.com', displayName: 'Second', color: '#445566', status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true })
    database.addInventory('account-1', [{ id: 'message-1', threadId: 'shared-thread' }])
    database.addInventory('account-2', [{ id: 'message-2', threadId: 'shared-thread' }])
    database.upsertMessage(message({ threadId: 'shared-thread' }))
    database.upsertMessage(message({ accountId: 'account-2', id: 'message-2', threadId: 'shared-thread', rawPath: 'account-2.eml' }))
    database.snoozeThreads('account-1', ['shared-thread'], new Date(Date.now() + 60_000).toISOString())
    database.saveRule({ accountId: 'account-1', name: 'First only', enabled: true, match: 'all', conditions: [{ field: 'from', operator: 'contains', value: 'ada' }], actions: [{ action: 'archive' }] })
    expect(database.listThreads({ folder: 'snoozed', accountIds: ['account-1'] }).total).toBe(1)
    expect(database.listThreads({ folder: 'snoozed', accountIds: ['account-2'] }).total).toBe(0)
    expect(database.listRules(['account-1'])).toHaveLength(1)
    expect(database.listRules(['account-2'])).toHaveLength(0)
    database.close()
  })

  it('cascades queued drafts, snoozes, and rules when local account data is deleted', () => {
    const { database } = setup()
    database.addInventory('account-1', [{ id: 'message-1', threadId: 'thread-1' }])
    database.upsertMessage(message())
    database.saveDraft({ id: 'draft-to-delete', accountId: 'account-1', to: [], cc: [], bcc: [], subject: 'Draft', text: '', attachmentPaths: [] })
    database.snoozeThreads('account-1', ['thread-1'], new Date(Date.now() + 60_000).toISOString())
    database.saveRule({ accountId: 'account-1', name: 'Delete me', enabled: true, match: 'all', conditions: [{ field: 'from', operator: 'contains', value: 'ada' }], actions: [{ action: 'archive' }] })
    database.disconnectAccount('account-1', 'delete')
    expect(database.listDrafts()).toEqual([])
    expect(database.listRules()).toEqual([])
    expect(database.listThreads({ folder: 'snoozed' }).total).toBe(0)
    database.close()
  })

  it('updates Microsoft immutable message locations before reconciling old folders', () => {
    const { database } = setup()
    database.addInventory('account-1', [{ id: 'message-1', threadId: 'thread-1', remoteFolderId: 'old-folder', remoteUid: 'message-1' }])
    database.upsertMessage(message({ remoteFolderId: 'old-folder', remoteUid: 'message-1' }))
    database.updateMessageLabels('account-1', 'message-1', ['ARCHIVE', 'folder:new-folder'], 'graph:200', { remoteFolderId: 'new-folder', remoteUid: 'message-1' })
    expect(database.reconcileRemoteFolder('account-1', 'old-folder', new Set())).toBe(0)
    expect(database.remoteMessagesForThreads('account-1', ['thread-1'])[0]).toMatchObject({ remoteFolderId: 'new-folder' })
    database.close()
  })

  it('marks an interrupted syncing draft for review instead of risking a duplicate send', () => {
    const { database, directory, path } = setup()
    database.saveDraft({ accountId: 'account-1', to: ['reader@example.com'], cc: [], bcc: [], subject: 'Interrupted', text: 'Review me', attachmentPaths: [] }, { status: 'syncing' })
    database.close()
    const reopened = new MailDatabase(path, join(directory, 'mail'))
    expect(reopened.listDrafts()[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/Review it before retrying/) })
    reopened.close()
  })

  it('persists account identity, signature, notification, and sync preferences', () => {
    const { database } = setup()
    const updated = database.updateAccountSettings({
      accountId: 'account-1',
      displayName: 'Aerio Person',
      color: '#3b6fd8',
      signature: 'Aerio Person\nStudio',
      notifications: false,
      syncEnabled: false
    })
    expect(updated).toMatchObject({ displayName: 'Aerio Person', color: '#3b6fd8', signature: 'Aerio Person\nStudio', notifications: false, syncEnabled: false })
    database.upsertAccount({ ...updated, displayName: 'Provider profile name', signature: '', notifications: true, syncEnabled: true })
    expect(database.getAccount('account-1')).toMatchObject({ displayName: 'Provider profile name', signature: 'Aerio Person\nStudio', notifications: false, syncEnabled: false })
    database.close()
  })

  it('persists account history, provider state, progress checkpoints, and reset state', () => {
    const { database } = setup()
    database.setAccountStatus('account-1', 'error', 'offline')
    expect(database.getAccount('account-1')).toMatchObject({ status: 'error', error: 'offline' })
    database.setAccountHistory('account-1', 'history-1')
    expect(database.getAccountHistory('account-1')).toBe('history-1')
    expect(database.getAccount('account-1')?.status).toBe('syncing')
    database.setAccountHistory('account-1', 'history-2', true)
    expect(database.getAccount('account-1')?.status).toBe('ready')

    const updatedAt = new Date(Date.now() - 10_000).toISOString()
    database.updateSyncProgress({
      accountId: 'account-1', phase: 'inventory', completed: 2, total: 10,
      transferredBytes: 2048, updatedAt, message: 'Indexing'
    }, { pageToken: 'page-2', initialHistoryId: 'initial-1' })
    expect(database.getSyncProgress('account-1')[0]).toMatchObject({
      accountId: 'account-1', phase: 'inventory', completed: 2, total: 10,
      transferredBytes: 2048, estimatedRemainingSeconds: undefined, message: 'Indexing'
    })
    expect(database.getSyncCheckpoint('account-1')).toMatchObject({ page_token: 'page-2', initial_history_id: 'initial-1' })
    database.updateSyncProgress({ accountId: 'account-1', phase: 'paused', completed: 2, total: 10, transferredBytes: 2048, updatedAt, pausedReason: 'user' }, { pageToken: null })
    expect(database.getSyncCheckpoint('account-1')?.page_token).toBeNull()

    expect(database.getProviderState('account-1', { cursor: 'fallback' })).toEqual({})
    database.setProviderState('account-1', { cursor: 'delta' })
    expect(database.getProviderState('account-1', {})).toEqual({ cursor: 'delta' })
    ;(database as unknown as { db: DatabaseSync }).db.prepare('UPDATE gmail_sync_state SET provider_state_json=? WHERE account_id=?').run('{broken', 'account-1')
    expect(database.getProviderState('account-1', { recovered: true })).toEqual({ recovered: true })
    database.resetForFullSync('account-1')
    expect(database.getAccountHistory('account-1')).toBeUndefined()
    expect(database.getProviderState('account-1', { reset: true })).toEqual({})
    expect(() => database.updateAccountSettings({
      accountId: 'missing', displayName: 'Missing', color: '#000', signature: '', notifications: true, syncEnabled: true
    })).toThrow('Account not found')
    database.close()
  })

  it('replaces and filters labels and suggests normalized recipients', () => {
    const { database } = setup()
    database.replaceLabels('account-1', [
      { accountId: 'account-1', id: 'INBOX', name: 'Inbox', type: 'system' },
      { accountId: 'account-1', id: 'project', name: 'Project', type: 'user', color: '#123456' }
    ])
    expect(database.listLabels()).toHaveLength(2)
    expect(database.listLabels(['account-1'])).toEqual([
      expect.objectContaining({ id: 'INBOX', color: undefined }),
      expect.objectContaining({ id: 'project', color: '#123456' })
    ])
    expect(database.listLabels(['missing'])).toEqual([])
    database.upsertMessage(message({
      to: ['Grace Hopper <grace@example.com>', 'invalid'],
      cc: ['team+mail@example.com'],
      fromName: '', fromEmail: 'ada@example.com'
    }))
    expect(database.suggestRecipients('', ['account-1']).map((item) => item.email)).toEqual(expect.arrayContaining(['ada@example.com', 'grace@example.com', 'team+mail@example.com']))
    expect(database.suggestRecipients('grace%_', ['account-1'])).toEqual([])
    expect(database.suggestRecipients('grace')).toEqual([expect.objectContaining({ email: 'grace@example.com', name: 'Grace Hopper' })])
    database.close()
  })

  it('tracks inventory completion, failures, retries, reconciliation, and remote references', () => {
    const { database } = setup()
    database.addInventory('account-1', [
      { id: 'message-1', threadId: 'thread-1', remoteFolderId: 'inbox', remoteUid: '11' },
      { id: 'message-2', threadId: 'thread-2' }
    ])
    expect(database.pendingMessageIds('account-1', 10)).toEqual([
      { id: 'message-1', threadId: 'thread-1', remoteFolderId: 'inbox', remoteUid: '11' },
      { id: 'message-2', threadId: 'thread-2', remoteFolderId: undefined, remoteUid: undefined }
    ])
    for (let attempt = 0; attempt < 5; attempt++) database.markSyncItem('account-1', 'message-2', 'failed', 'download failed')
    expect(database.syncFailureCount('account-1')).toBe(1)
    expect(database.pendingMessageIds('account-1', 10).map((item) => item.id)).toEqual(['message-1'])
    database.retryFailedSyncItems('account-1')
    expect(database.pendingMessageIds('account-1', 10).map((item) => item.id)).toEqual(['message-1', 'message-2'])
    database.completeInventory('account-1')
    expect(database.getSyncCheckpoint('account-1')?.inventory_complete).toBe(1)

    database.upsertMessage(message({ remoteFolderId: 'inbox', remoteUid: '11' }))
    expect(database.hasMessage('account-1', 'message-1')).toBe(true)
    expect(database.hasMessage('account-1', 'missing')).toBe(false)
    expect(database.remoteMessagesForThreads('account-1', [])).toEqual([])
    expect(database.remoteMessagesForThreads('account-1', ['thread-1'])[0]).toMatchObject({ remoteFolderId: 'inbox', remoteUid: '11' })
    database.resetInventory('account-1')
    expect(database.pendingMessageIds('account-1', 10)).toEqual([])
    expect(database.reconcileInventory('account-1')).toBe(1)
    expect(database.hasMessage('account-1', 'message-1')).toBe(false)
    database.close()
  })

  it('updates, reconciles, and deletes remote messages while tolerating missing records', () => {
    const { database } = setup()
    database.addInventory('account-1', [
      { id: 'message-1', threadId: 'thread-1', remoteFolderId: 'folder-a', remoteUid: '1' },
      { id: 'message-2', threadId: 'thread-2', remoteFolderId: 'folder-a', remoteUid: '2' }
    ])
    database.upsertMessage(message({ remoteFolderId: 'folder-a', remoteUid: '1' }))
    database.upsertMessage(message({ id: 'message-2', threadId: 'thread-2', rawPath: 'missing.eml', remoteFolderId: 'folder-a', remoteUid: '2' }))
    database.updateMessageLabels('account-1', 'message-1', ['INBOX', 'STARRED'], '101')
    expect(database.listThreads({ folder: 'starred' }).total).toBe(1)
    database.updateMessageLabels('account-1', 'missing', ['INBOX'], '102')
    expect(database.reconcileRemoteFolder('account-1', 'folder-a', new Set(['message-1']))).toBe(1)
    expect(database.hasMessage('account-1', 'message-2')).toBe(false)
    database.deleteMessage('account-1', 'message-1')
    expect(database.listThreads({ folder: 'all' }).total).toBe(0)
    database.deleteMessage('account-1', 'missing')
    database.close()
  })

  it('executes every folder query, account filter, label filter, and cursor branch', () => {
    const { database } = setup()
    const rows = [
      message({ id: 'inbox', threadId: 'inbox', labelIds: ['INBOX', 'STARRED', 'IMPORTANT'] }),
      message({ id: 'sent', threadId: 'sent', labelIds: ['SENT'] }),
      message({ id: 'draft', threadId: 'draft', labelIds: ['DRAFT'] }),
      message({ id: 'archive', threadId: 'archive', labelIds: ['ARCHIVE', 'project'] }),
      message({ id: 'spam', threadId: 'spam', labelIds: ['SPAM'] }),
      message({ id: 'trash', threadId: 'trash', labelIds: ['TRASH'] })
    ]
    for (const row of rows) database.upsertMessage(row)
    for (const folder of ['inbox', 'starred', 'important', 'sent', 'drafts', 'scheduled', 'archive', 'spam', 'trash', 'all'] as const) {
      expect(database.listThreads({ folder }).total).toBeGreaterThanOrEqual(folder === 'scheduled' ? 0 : 1)
    }
    expect(database.listThreads({ folder: 'archive', labelId: 'project', accountIds: ['account-1'] }).items[0].id).toBe('archive')
    const first = database.listThreads({ folder: 'all', pageSize: 1 })
    expect(first.nextCursor).toBeTruthy()
    expect(database.listThreads({ folder: 'all', pageSize: 1000, cursor: first.nextCursor }).items.length).toBeGreaterThan(0)
    expect(() => database.getThread('account-1', 'missing')).toThrow('Thread not found')
    database.close()
  })

  it('counts unread conversations across every folder in one mailbox summary', () => {
    const { database } = setup()
    for (const row of [
      message({ id: 'inbox', threadId: 'inbox', labelIds: ['INBOX', 'UNREAD', 'STARRED', 'IMPORTANT'] }),
      message({ id: 'sent', threadId: 'sent', labelIds: ['SENT', 'UNREAD'] }),
      message({ id: 'draft', threadId: 'draft', labelIds: ['DRAFT', 'UNREAD'] }),
      message({ id: 'archive', threadId: 'archive', labelIds: ['ARCHIVE', 'UNREAD'] }),
      message({ id: 'spam', threadId: 'spam', labelIds: ['SPAM', 'UNREAD'] }),
      message({ id: 'trash', threadId: 'trash', labelIds: ['TRASH', 'UNREAD'] }),
      message({ id: 'read', threadId: 'read', labelIds: ['INBOX'] }),
      message({ id: 'snoozed', threadId: 'snoozed', labelIds: ['INBOX', 'UNREAD'] })
    ]) database.upsertMessage(row)
    database.snoozeThreads('account-1', ['snoozed'], new Date(Date.now() + 60_000).toISOString())

    expect(database.folderUnreadCounts()).toEqual({
      inbox: 1, starred: 1, important: 1, sent: 1, drafts: 1, scheduled: 0,
      snoozed: 1, archive: 1, spam: 1, trash: 1, all: 4
    })
    expect(database.folderUnreadCounts(['missing'])).toEqual({
      inbox: 0, starred: 0, important: 0, sent: 0, drafts: 0, scheduled: 0,
      snoozed: 0, archive: 0, spam: 0, trash: 0, all: 0
    })
    expect(database.accountUnreadCounts()).toEqual({ 'account-1': 1 })
    database.close()
  })

  it('validates actions and exercises every optimistic label transition', () => {
    const { database } = setup()
    database.replaceLabels('account-1', [
      { accountId: 'account-1', id: 'project', name: 'Project', type: 'user' },
      { accountId: 'account-1', id: 'TRASH', name: 'Trash', type: 'system' }
    ])
    database.upsertMessage(message())
    expect(() => database.applyLocalAction({ accountId: 'missing', threadIds: ['thread-1'], action: 'read' })).toThrow('Account not found')
    expect(() => database.applyLocalAction({ accountId: 'account-1', threadIds: [], action: 'read' })).toThrow('Select at least one conversation')
    expect(() => database.applyLocalAction({ accountId: 'account-1', threadIds: ['thread-1'], action: 'label' })).toThrow('Choose a label')
    expect(() => database.applyLocalAction({ accountId: 'account-1', threadIds: ['thread-1'], action: 'move' })).toThrow('Choose a destination')

    const actions = ['read', 'unread', 'star', 'unstar', 'important', 'unimportant', 'archive', 'unarchive', 'trash', 'untrash'] as const
    for (const action of actions) database.applyLocalAction({ accountId: 'account-1', threadIds: ['thread-1'], action }, `operation-${action}`, 0)
    database.applyLocalAction({ accountId: 'account-1', threadIds: ['thread-1'], action: 'label', labelId: 'project' }, 'operation-label', 0)
    database.applyLocalAction({ accountId: 'account-1', threadIds: ['thread-1'], action: 'unlabel', labelId: 'project' }, 'operation-unlabel', 0)
    database.applyLocalAction({ accountId: 'account-1', threadIds: ['thread-1'], action: 'move', labelId: 'TRASH' }, 'operation-move', 0)
    expect(database.listThreads({ folder: 'trash' }).total).toBe(1)
    expect(database.dueOperations(100)).toHaveLength(13)
    database.close()
  })

  it('maps named move destinations and removes old provider folders for non-Gmail accounts', () => {
    const { database } = setup()
    database.upsertAccount({
      id: 'account-2', provider: 'microsoft', email: 'other@example.com', displayName: 'Other', avatarUrl: 'avatar', color: '#123456',
      status: 'error', archived: true, lastSyncAt: '2026-08-08T10:00:00Z', error: 'offline', signature: 'sig', notifications: false, syncEnabled: false
    })
    database.updateAccountSettings({ accountId: 'account-2', displayName: ' Other ', color: '#654321', signature: '', notifications: false, syncEnabled: false })
    expect(database.listAccounts()).toContainEqual(expect.objectContaining({ id: 'account-2', avatarUrl: 'avatar', archived: true, error: 'offline', notifications: false, syncEnabled: false }))
    database.replaceLabels('account-2', [
      { accountId: 'account-2', id: 'deleted', name: 'Deleted Items', type: 'system' },
      { accountId: 'account-2', id: 'junk', name: 'Junk Email', type: 'system' },
      { accountId: 'account-2', id: 'stored', name: 'Online Archive', type: 'system' }
    ])
    database.upsertMessage(message({ accountId: 'account-2', id: 'other-message', threadId: 'other-thread', labelIds: ['folder:old', 'INBOX'], messageIdHeader: undefined, remoteFolderId: undefined, remoteUid: undefined, attachments: [{ id: 'plain', messageId: 'other-message', filename: 'plain', mimeType: 'text/plain', size: 1 }] }))
    for (const [labelId, expected] of [['INBOX', 'INBOX'], ['deleted', 'TRASH'], ['junk', 'SPAM'], ['stored', 'ARCHIVE']] as const) {
      database.applyLocalAction({ accountId: 'account-2', threadIds: ['other-thread'], action: 'move', labelId }, `move-${labelId}`, 0)
      expect(database.getThread('account-2', 'other-thread').messages[0].labelIds).toContain(expected)
      expect(database.getThread('account-2', 'other-thread').messages[0].labelIds.some((label) => label.startsWith('folder:'))).toBe(false)
    }
    database.setAccountStatus('account-2', 'ready')
    database.close()
  })

  it('manages provider operation attempts, rescheduling, recovery, and post-send undo', () => {
    const { database } = setup()
    database.upsertMessage(message())
    const operation = database.applyLocalAction({ accountId: 'account-1', threadIds: ['thread-1'], action: 'archive' }, 'operation-1', 0)
    expect(database.operationAttempts(operation.id)).toBe(0)
    database.updateOperation(operation.id, 'running', 'working')
    expect(database.operationAttempts(operation.id)).toBe(1)
    database.rescheduleOperation(operation.id, 'retry', 60_000)
    expect(database.dueOperations()).toEqual([])
    database.updateOperation(operation.id, 'succeeded')
    expect(database.undoOperation(operation.id)).toBe(true)
    expect(database.dueOperations().some((row) => row.kind === 'unarchive')).toBe(true)
    expect(database.restoreOperationSnapshot('missing', 'failed')).toBe(false)
    expect(database.undoOperation('missing')).toBe(false)

    const interrupted = database.applyLocalAction({ accountId: 'account-1', threadIds: ['thread-1'], action: 'star' }, 'interrupted', 0)
    database.updateOperation(interrupted.id, 'running')
    database.recoverInterruptedWork()
    expect(database.dueOperations().some((row) => row.id === 'interrupted')).toBe(true)
    database.restoreOperationSnapshot(interrupted.id, 'failed', 'provider failed')
    expect(database.undoOperation(interrupted.id)).toBe(false)
    database.close()
  })

  it('covers draft selection, update, deletion, missing-record, and delivery-result paths', () => {
    const { database } = setup()
    expect(() => database.requestDraftDiscard('missing')).toThrow('Draft not found')
    expect(() => database.cancelDraftDelivery('missing')).toThrow('queued message was not found')
    const local = database.saveDraft({ accountId: 'account-1', to: [], cc: [], bcc: [], subject: '', text: '', attachmentPaths: [] }, { status: 'local' })
    const queued = database.saveDraft({ accountId: 'account-1', to: ['ada@example.com'], cc: [], bcc: [], subject: 'Queued', text: 'Body', attachmentPaths: [] }, { status: 'queued', deliveryAt: new Date(Date.now() - 1000).toISOString() })
    expect(database.listDrafts(['account-1'])).toHaveLength(2)
    expect(database.draftsToSync().map((row) => row.id)).toContain(local.id)
    expect(database.queuedDrafts().map((row) => row.id)).toContain(queued.id)
    database.updateDraftResult(local.id, { id: local.id, remoteDraftId: 'remote', status: 'synced', deliveryAt: undefined, error: undefined, updatedAt: new Date().toISOString() })
    expect(database.getDraftRecord(local.id)).toMatchObject({ remoteDraftId: 'remote', status: 'synced' })
    expect(database.requestDraftDiscard(local.id)).toMatchObject({ status: 'discard-queued', remoteDraftId: 'remote' })
    expect(database.draftsToDiscard().map((row) => row.id)).toContain(local.id)
    database.deleteDraftRecord(local.id)
    expect(database.getDraftRecord(local.id)).toBeUndefined()
    database.close()
  })

  it('reports rules, raw paths, attachments, storage usage, and diagnostic health', () => {
    const { database, directory } = setup()
    expect(() => database.saveRule({ accountId: 'missing', name: 'Missing', enabled: true, match: 'all', conditions: [], actions: [] })).toThrow('Account not found')
    const saved = database.saveRule({ accountId: 'account-1', name: 'Rule', enabled: true, match: 'all', conditions: [{ field: 'from', operator: 'contains', value: 'ada' }], actions: [{ action: 'archive' }] })
    database.recordRuleMatch(saved.id, 0)
    database.recordRuleMatch(saved.id, 2)
    expect(database.getRule(saved.id)).toMatchObject({ matchCount: 2, lastMatchedAt: expect.any(String) })
    database.deleteRule(saved.id)
    expect(database.getRule(saved.id)).toBeUndefined()

    const rawPath = database.rawPath('account/unsafe', 'ab-message')
    writeFileSync(rawPath, 'raw')
    expect(rawPath).toContain(join('account_unsafe', 'ab'))
    expect(database.rawExists(rawPath)).toBe(true)
    expect(database.rawExists(join(directory, 'missing'))).toBe(false)
    database.upsertMessage(message({ rawPath, attachments: [{ id: 'attachment-1', messageId: 'message-1', filename: 'file.txt', mimeType: 'text/plain', size: 3 }] }))
    expect(database.getMessageRaw('account-1', 'message-1')).toBe(rawPath)
    expect(database.getMessageRaw('account-1', 'missing')).toBeUndefined()
    expect(database.getAttachment('account-1', 'message-1', 'attachment-1')).toMatchObject({ filename: 'file.txt' })
    expect(database.getThread('account-1', 'thread-1').messages[0].attachments).toEqual([
      expect.objectContaining({ id: 'attachment-1', filename: 'file.txt', mimeType: 'text/plain', size: 3 })
    ])
    expect(database.storageStats(1234)).toMatchObject({ totalBytes: 1024, freeBytes: 1234, accounts: [expect.objectContaining({ accountId: 'account-1', messages: 1 })] })
    expect(database.diagnosticHealth()).toMatchObject({ integrity: 'ok', integrityMessage: 'ok', missingRawFiles: 0, orphanedMessages: 0, orphanedAttachments: 0 })
    database.close()
  })
})
