import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { MailDatabase } from './mail/database'
import { ProductivityStore } from './productivity/store'

describe('populated upgrade fixtures', () => {
  it('upgrades older mail columns while preserving message bodies, editable drafts, and interrupted operations', () => {
    const directory = mkdtempSync(join(tmpdir(), 'aerio-upgrade-test-'))
    const path = join(directory, 'mail.sqlite'), content = join(directory, 'mail')
    let database: MailDatabase | undefined
    try {
      database = new MailDatabase(path, content)
      database.upsertAccount({ id: 'account', provider: 'gmail', email: 'fixture@example.test', displayName: 'Upgrade fixture', color: '#6558e8', status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true })
      database.addInventory('account', [{ id: 'message', threadId: 'thread' }])
      database.upsertMessage({ accountId: 'account', id: 'message', threadId: 'thread', historyId: '1', internalDate: '2026-10-01T09:00:00Z', fromName: 'Sender', fromEmail: 'sender@example.test', to: ['fixture@example.test'], cc: [], subject: 'Keep this message', messageIdHeader: '<fixture@example.test>', references: [], snippet: 'Body', text: 'Preserved body', html: '<p>Preserved body</p>', labelIds: ['INBOX', 'UNREAD'], sizeEstimate: 100, rawPath: 'fixture.eml', attachments: [] })
      const draft = { id: 'draft', accountId: 'account', to: ['reader@example.test'], cc: [], bcc: [], subject: 'Unfinished draft', text: 'Preserved draft', html: '<p>Preserved draft</p>', attachmentPaths: ['managed-file.txt'] }
      database.saveDraft(draft, { status: 'local' })
      database.applyLocalAction({ accountId: 'account', threadIds: ['thread'], action: 'star' }, 'interrupted', 0)
      database.updateOperation('interrupted', 'running')
      database.close(); database = undefined
      const legacy = new DatabaseSync(path)
      try {
        for (const [table, column] of [['gmail_threads', 'sender_email'], ['gmail_drafts', 'delivery_at'], ['gmail_drafts', 'remote_revision'], ['gmail_accounts', 'provider'], ['gmail_sync_state', 'provider_state_json']]) legacy.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`)
      } finally { legacy.close() }
      database = new MailDatabase(path, content)
      expect(database.listAccounts()[0]).toMatchObject({ provider: 'gmail', email: 'fixture@example.test' })
      expect(database.getDraftRecord('draft')).toMatchObject(draft)
      expect(database.getThread('account', 'thread')?.messages[0]).toMatchObject({ text: 'Preserved body', html: '<p>Preserved body</p>' })
      expect(database.listThreads({ folder: 'inbox' }).items[0]).toMatchObject({ senderEmail: 'sender@example.test', starred: true, unread: true })
      expect(database.dueOperations()).toEqual([expect.objectContaining({ id: 'interrupted', status: 'queued', attempts: 1 })])
      expect(database.restoreOperationSnapshot('interrupted', 'failed')).toBe(true)
      expect(database.listThreads({ folder: 'inbox' }).items[0].starred).toBe(false)
    } finally { database?.close(); rmSync(directory, { recursive: true, force: true }) }
  })

  it('adds provider/checkpoint tables without replacing existing local Tasks, Notes, Contacts, or attachment references', () => {
    const directory = mkdtempSync(join(tmpdir(), 'aerio-productivity-upgrade-'))
    const path = join(directory, 'productivity.sqlite')
    let store: ProductivityStore | undefined
    try {
      const snapshot = {
        tasks: [{ id: 'task', listId: 'Work', title: 'Keep task', priority: 'normal' as const, completed: false, subtasks: [] }],
        notes: [{ id: 'note', folder: 'Work', title: 'Keep note', content: 'Body', tags: ['migration'], pinned: true, archived: false, updatedAt: '2026-10-01T09:00:00Z', attachments: [{ id: 'file', name: 'brief.txt', size: 4, path: 'managed/brief.txt', mime: 'txt' }] }],
        contacts: [{ id: 'contact', name: 'Keep contact', email: 'contact@example.test', group: 'Friends', favorite: true, color: '#6558e8' }]
      }
      const legacy = new DatabaseSync(path)
      try {
        legacy.exec('CREATE TABLE local_module_state(module TEXT PRIMARY KEY, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE local_contacts(id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL)')
        for (const module of ['tasks', 'notes'] as const) legacy.prepare('INSERT INTO local_module_state VALUES(?,?,?)').run(module, JSON.stringify(snapshot[module]), '2026-10-01T09:00:00Z')
        legacy.prepare('INSERT INTO local_contacts VALUES(?,?,?)').run('contact', JSON.stringify(snapshot.contacts[0]), '2026-10-01T09:00:00Z')
      } finally { legacy.close() }
      store = new ProductivityStore(path)
      expect(store.localSnapshot()).toEqual(snapshot)
      expect(store.snapshot()).toEqual({ calendars: [], events: [], contacts: [], sync: [] })
      store.close(); store = new ProductivityStore(path)
      expect(store.localSnapshot()).toEqual(snapshot)
    } finally { store?.close(); rmSync(directory, { recursive: true, force: true }) }
  })
})
