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
    archived: false
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
})
