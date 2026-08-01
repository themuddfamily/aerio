import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { MailDatabase, type ParsedMailMessage } from './database'

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
    expect(inbox.items[0]).toMatchObject({ id: 'thread-1', unread: true, messageCount: 1 })
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
    const created = database.saveDraft(input, { gmailDraftId: 'gmail-draft-1', status: 'synced' })
    const updated = database.saveDraft({ ...input, id: created.id, text: 'Second version' }, { status: 'syncing' })
    expect(updated.gmailDraftId).toBe('gmail-draft-1')
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
    }, { gmailDraftId: 'remote-1', status: 'synced' })
    expect(database.listDrafts()).toEqual([expect.objectContaining({
      id: created.id,
      gmailDraftId: 'remote-1',
      subject: 'Editable draft',
      html: '<p><strong>Rich body</strong></p>',
      attachmentPaths: ['staged-file.txt']
    })])
    expect(database.requestDraftDiscard(created.id)).toMatchObject({ status: 'discard-queued' })
    expect(database.draftsToDiscard()).toHaveLength(1)
    expect(database.listDrafts()).toHaveLength(0)
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
