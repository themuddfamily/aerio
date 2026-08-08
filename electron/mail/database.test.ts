import { existsSync, mkdtempSync, rmSync } from 'node:fs'
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
})
