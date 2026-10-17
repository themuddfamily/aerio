import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { MailDatabase, type ParsedMailMessage } from './database'

const ACCOUNT = 'account-1'
const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

const message = (database: MailDatabase, id: string, labelIds: string[], extra: Partial<ParsedMailMessage> = {}): ParsedMailMessage => ({
  accountId: ACCOUNT, id, threadId: `thread-${id}`, historyId: '1', internalDate: '2026-10-01T09:00:00.000Z', fromName: '', fromEmail: 'a@example.test', to: [], cc: [],
  subject: id, references: [], snippet: '', text: '', html: '', labelIds, sizeEstimate: 1, rawPath: database.rawPath(ACCOUNT, id), attachments: [], ...extra
})

function open() {
  const directory = mkdtempSync(join(tmpdir(), 'aerio-owner-store-'))
  directories.push(directory)
  const paths = [join(directory, 'aerio.sqlite'), join(directory, 'mail')] as const
  const database = new MailDatabase(...paths)
  database.upsertAccount({ id: ACCOUNT, provider: 'exchange', email: 'ada@contoso.test', displayName: 'Ada', color: '#000', status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true })
  return { database, paths }
}

describe('mailbox owner storage (E40)', () => {
  it('migrates a pre-E40 database: every existing label, message, inventory row, and queued action belongs to the primary owner', () => {
    const { database, paths } = open()
    database.replaceLabels(ACCOUNT, [{ accountId: ACCOUNT, id: 'folder:inbox', name: 'Inbox', type: 'system' }])
    database.upsertMessage(message(database, 'm1', ['folder:inbox', 'INBOX']))
    database.addInventory(ACCOUNT, [{ id: 'm2', threadId: 'thread-m2' }])
    database.applyLocalAction({ accountId: ACCOUNT, threadIds: ['thread-m1'], action: 'read' })
    database.close()
    // Recreate the pre-E40 layout: no owner columns or owner tables.
    const raw = new DatabaseSync(paths[0])
    raw.exec('DROP INDEX gmail_messages_owner; DROP INDEX gmail_sync_items_owner; DROP TABLE mail_mailbox_owner_folders; DROP TABLE mail_mailbox_owners')
    for (const table of ['gmail_labels', 'gmail_messages', 'gmail_sync_items', 'gmail_operations']) raw.exec(`ALTER TABLE ${table} DROP COLUMN owner_id`)
    raw.close()

    const reopened = new MailDatabase(...paths)
    const check = new DatabaseSync(paths[0])
    for (const table of ['gmail_labels', 'gmail_messages', 'gmail_sync_items', 'gmail_operations']) {
      expect((check.prepare(`SELECT DISTINCT owner_id FROM ${table}`).all() as { owner_id: string }[]).map((row) => row.owner_id)).toEqual(['primary'])
    }
    check.close()
    expect(reopened.mailboxOwners.list()).toEqual([])
    expect(reopened.listLabels([ACCOUNT])).toEqual([{ accountId: ACCOUNT, id: 'folder:inbox', name: 'Inbox', type: 'system' }])
    expect(reopened.pendingMessageIds(ACCOUNT, 10).map((item) => item.id)).toEqual(['m2'])
    reopened.close()
  })

  it('scopes label replacement, inventory, downloads, and reconciliation of the own mailbox to the primary owner', () => {
    const { database } = open()
    const owners = database.mailboxOwners
    const owner = owners.save({ id: 'mbx-1', accountId: ACCOUNT, provider: 'exchange', kind: 'shared', address: 'team@contoso.test', displayName: 'Team', status: 'active', sendMode: 'none', discoveredBy: 'manual' })
    owners.replaceFolders(ACCOUNT, owner.id, [{ folderId: 'F1', labelId: 'owner:mbx-1:F1', name: 'Inbox', kind: 'mail', distinguished: 'inbox', access: 'read', canCreate: false, canModify: false, canDelete: false }])
    owners.replaceLabels(ACCOUNT, owner.id, [{ accountId: ACCOUNT, id: 'owner:mbx-1', name: 'Team', type: 'user' }, { accountId: ACCOUNT, id: 'owner:mbx-1:F1', name: 'Inbox', type: 'user', parentId: 'owner:mbx-1' }])
    owners.addInventory(ACCOUNT, owner.id, [{ id: 'shared-1', threadId: 'thread-shared-1', remoteFolderId: 'owner:mbx-1:F1', remoteUid: 'ITEM1' }, { id: 'shared-2', threadId: 'thread-shared-2', remoteFolderId: 'owner:mbx-1:F1', remoteUid: 'ITEM2' }])
    database.upsertMessage(message(database, 'shared-1', ['owner:mbx-1:F1', 'UNREAD'], { remoteFolderId: 'owner:mbx-1:F1', remoteUid: 'ITEM1' }))
    owners.tagMessage(ACCOUNT, owner.id, 'shared-1')

    // The own mailbox's sync replaces only its labels and never downloads or reconciles the owner's rows.
    database.replaceLabels(ACCOUNT, [{ accountId: ACCOUNT, id: 'folder:inbox', name: 'Inbox', type: 'system' }])
    database.resetInventory(ACCOUNT)
    expect(database.reconcileInventory(ACCOUNT)).toBe(0)
    expect(database.pendingMessageIds(ACCOUNT, 10)).toEqual([])
    expect(owners.pending(ACCOUNT, owner.id, 10).map((item) => item.id)).toEqual(['shared-2'])
    const labels = database.listLabels([ACCOUNT])
    expect(labels.map((label) => label.id).sort()).toEqual(['folder:inbox', 'owner:mbx-1', 'owner:mbx-1:F1'])
    expect(labels.find((label) => label.id === 'owner:mbx-1:F1')?.owner).toMatchObject({ id: 'mbx-1', address: 'team@contoso.test', access: 'read' })
    expect(labels.find((label) => label.id === 'owner:mbx-1')?.owner).toMatchObject({ root: true, access: 'read' })
    expect(database.hasMessage(ACCOUNT, 'shared-1')).toBe(true)
    expect([...owners.ownersOfThreads(ACCOUNT, ['thread-shared-1'])]).toEqual(['mbx-1'])

    // Removing the owner removes its cache, labels, and folders, and nothing else.
    database.upsertMessage(message(database, 'own-1', ['folder:inbox', 'INBOX']))
    owners.purge(ACCOUNT, owner.id)
    expect(database.hasMessage(ACCOUNT, 'shared-1')).toBe(false)
    expect(database.hasMessage(ACCOUNT, 'own-1')).toBe(true)
    expect(database.listLabels([ACCOUNT]).map((label) => label.id)).toEqual(['folder:inbox'])
    expect(owners.folders(ACCOUNT, owner.id)).toEqual([])
    database.close()
  })

  it('holds, lists, releases, and cascades owner actions with the account', () => {
    const { database } = open()
    const owners = database.mailboxOwners
    owners.save({ id: 'mbx-1', accountId: ACCOUNT, provider: 'exchange', kind: 'shared', address: 'team@contoso.test', displayName: 'Team', status: 'active', sendMode: 'none', discoveredBy: 'manual' })
    database.upsertMessage(message(database, 'shared-1', ['owner:mbx-1:F1', 'UNREAD']))
    owners.tagMessage(ACCOUNT, 'mbx-1', 'shared-1')
    const operation = database.applyLocalAction({ accountId: ACCOUNT, threadIds: ['thread-shared-1'], action: 'read' }, 'op-1', 0)
    owners.tagOperation(operation.id, 'mbx-1')
    expect(owners.holdOperations(ACCOUNT, 'mbx-1', 'Access removed')).toBe(1)
    expect(database.dueOperations()).toEqual([])
    expect(owners.held(ACCOUNT)).toEqual([expect.objectContaining({ id: 'op-1', ownerName: 'Team', kind: 'read', threadCount: 1, error: 'Access removed' })])
    owners.releaseHeld('op-1')
    expect(database.dueOperations().map((row) => row.id)).toEqual(['op-1'])
    database.disconnectAccount(ACCOUNT, 'delete')
    expect(owners.list()).toEqual([])
    database.close()
  })
})
