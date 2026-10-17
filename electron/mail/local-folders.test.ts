import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_FOLDERS_ACCOUNT_ID } from '../../src/lib/local-folders'
import { MailDatabase } from './database'
import { FolderNotEmptyError } from './folder-errors'
import { MailFolderManager } from './folder-management'
import { transferToLocalFolders } from './local-folders'
import { storeRawForTest } from './mail-import.fixtures'

const directories: string[] = []
const open: MailDatabase[] = []
afterEach(() => {
  for (const database of open.splice(0)) try { database.close() } catch { /* Already closed by the test. */ }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const raw = (subject: string, extra = '') => Buffer.from(`From: Ada <ada@example.test>\r\nSubject: ${subject}\r\nDate: Wed, 15 Oct 2025 12:00:00 +0000\r\nMessage-ID: <${subject}@example.test>\r\n${extra}\r\nBody of ${subject}\r\n`)

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'aerio-local-folders-test-'))
  directories.push(directory)
  const database = new MailDatabase(join(directory, 'aerio.sqlite'), join(directory, 'mail'))
  open.push(database)
  const local = database.localMail.ensureAccount()
  const manager = new MailFolderManager({
    database,
    online: () => false,
    gmail: () => { throw new Error('No provider calls for Local Folders') },
    microsoft: () => { throw new Error('No provider calls for Local Folders') },
    imap: async () => { throw new Error('No provider calls for Local Folders') }
  })
  const store = vi.fn((accountId: string, message: Parameters<typeof storeRawForTest>[2]) => storeRawForTest(database, accountId, message))
  return { database, local, manager, store, directory }
}

async function seedGmail(database: MailDatabase, messages: { id: string; threadId: string; raw: Buffer; labels: string[] }[]) {
  database.upsertAccount({ id: 'gmail', provider: 'gmail', email: 'person@example.test', displayName: 'Person', color: '#123456', status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true })
  for (const message of messages) {
    await storeRawForTest(database, 'gmail', { id: message.id, threadId: message.threadId, historyId: '1', raw: message.raw, labelIds: message.labels, sizeEstimate: message.raw.length })
  }
}

describe('Local Folders account', () => {
  it('is created once as a provider-free account', () => {
    const { database, local } = setup()
    expect(local).toMatchObject({ id: LOCAL_FOLDERS_ACCOUNT_ID, provider: 'local', archived: false, syncEnabled: false, status: 'ready' })
    expect(database.localMail.ensureAccount()).toEqual(local)
    expect(database.listAccounts().filter((account) => account.provider === 'local')).toHaveLength(1)
  })

  it('stays ready after a profile restore marks accounts for reauthorization', () => {
    const { database, directory } = setup()
    database.setAccountStatus(LOCAL_FOLDERS_ACCOUNT_ID, 'needs-auth', 'Sign in again')
    database.close()
    const reopened = new MailDatabase(join(directory, 'aerio.sqlite'), join(directory, 'mail'))
    open.push(reopened)
    expect(reopened.getAccount(LOCAL_FOLDERS_ACCOUNT_ID)).toMatchObject({ status: 'ready', error: undefined })
  })

  it('creates, renames, nests and deletes folders offline through the folder manager', async () => {
    const { database, manager } = setup()
    const archive = (await manager.create({ accountId: LOCAL_FOLDERS_ACCOUNT_ID, name: 'Archive' })).label!
    const year = (await manager.create({ accountId: LOCAL_FOLDERS_ACCOUNT_ID, name: '2024', parentId: archive.id })).label!
    const deep = (await manager.create({ accountId: LOCAL_FOLDERS_ACCOUNT_ID, name: 'Receipts', parentId: year.id })).label!
    expect(deep.name).toBe('Archive/2024/Receipts')
    await expect(manager.create({ accountId: LOCAL_FOLDERS_ACCOUNT_ID, name: 'archive' })).rejects.toThrow('already exists')
    await expect(manager.create({ accountId: LOCAL_FOLDERS_ACCOUNT_ID, name: 'a/b' })).rejects.toThrow('parent setting')
    await expect(manager.create({ accountId: LOCAL_FOLDERS_ACCOUNT_ID, name: 'Tinted', color: '#fb4c2f' })).rejects.toThrow('colors')

    const renamed = await manager.update({ accountId: LOCAL_FOLDERS_ACCOUNT_ID, labelId: archive.id, name: 'Old mail' })
    expect(renamed.renamed).toEqual({})
    expect(renamed.labels.map((label) => label.name).sort()).toEqual(['Old mail', 'Old mail/2024', 'Old mail/2024/Receipts'])
    await expect(manager.update({ accountId: LOCAL_FOLDERS_ACCOUNT_ID, labelId: archive.id, parentId: deep.id })).rejects.toThrow('inside itself')
    const moved = await manager.update({ accountId: LOCAL_FOLDERS_ACCOUNT_ID, labelId: deep.id, parentId: null })
    expect(moved.label).toMatchObject({ id: deep.id, name: 'Receipts' })
    expect(moved.label?.parentId).toBeUndefined()

    // Deleting a non-empty folder needs confirmation and moves its messages to Trash.
    await storeRawForTest(database, LOCAL_FOLDERS_ACCOUNT_ID, { id: 'm1', threadId: 't1', historyId: 'x', raw: raw('Kept'), labelIds: [deep.id], sizeEstimate: 10 })
    expect(manager.preview(LOCAL_FOLDERS_ACCOUNT_ID, deep.id)).toMatchObject({ messages: 1, messagesMoveTo: 'Trash' })
    await expect(manager.delete({ accountId: LOCAL_FOLDERS_ACCOUNT_ID, labelId: deep.id })).rejects.toBeInstanceOf(FolderNotEmptyError)
    const deleted = await manager.delete({ accountId: LOCAL_FOLDERS_ACCOUNT_ID, labelId: deep.id, confirmNonEmpty: true })
    expect(deleted.deletedId).toBe(deep.id)
    expect(database.listThreads({ accountIds: [LOCAL_FOLDERS_ACCOUNT_ID], folder: 'trash' }).items.map((item) => item.subject)).toEqual(['Kept'])
    await expect(manager.delete({ accountId: LOCAL_FOLDERS_ACCOUNT_ID, labelId: archive.id })).rejects.toThrow('subfolders first')
    expect(await manager.refresh(LOCAL_FOLDERS_ACCOUNT_ID)).toHaveLength(2)
  })

  it('rejects invalid folder changes and folders still used by queued changes', async () => {
    const { database } = setup()
    const store = database.localMail
    const work = store.createFolder({ accountId: LOCAL_FOLDERS_ACCOUNT_ID, name: 'Work' }).label!
    const other = store.createFolder({ accountId: LOCAL_FOLDERS_ACCOUNT_ID, name: 'Other' }).label!
    expect(() => store.createFolder({ accountId: LOCAL_FOLDERS_ACCOUNT_ID, name: 'Child', parentId: 'folder:missing' })).toThrow('parent folder no longer exists')
    expect(() => store.createFolder({ accountId: LOCAL_FOLDERS_ACCOUNT_ID, name: ' ' })).toThrow('Enter a name')
    expect(() => store.updateFolder({ accountId: LOCAL_FOLDERS_ACCOUNT_ID, labelId: 'folder:missing', name: 'X' })).toThrow('no longer exists')
    expect(() => store.updateFolder({ accountId: LOCAL_FOLDERS_ACCOUNT_ID, labelId: work.id, color: '#fb4c2f' })).toThrow('colors')
    expect(() => store.updateFolder({ accountId: LOCAL_FOLDERS_ACCOUNT_ID, labelId: work.id, name: 'other' })).toThrow('already exists')
    expect(() => store.updateFolder({ accountId: LOCAL_FOLDERS_ACCOUNT_ID, labelId: work.id, parentId: 'folder:missing' })).toThrow('parent folder no longer exists')
    expect(() => store.updateFolder({ accountId: LOCAL_FOLDERS_ACCOUNT_ID, labelId: work.id, name: '' })).toThrow('Enter a name')
    expect(store.updateFolder({ accountId: LOCAL_FOLDERS_ACCOUNT_ID, labelId: work.id, parentId: other.id }).label?.name).toBe('Other/Work')
    expect(() => store.deleteFolder({ accountId: LOCAL_FOLDERS_ACCOUNT_ID, labelId: 'folder:missing' })).toThrow('no longer exists')
    expect(() => store.ensureFolderPath(LOCAL_FOLDERS_ACCOUNT_ID, 'folder:missing', ['A'])).toThrow('destination folder no longer exists')
    expect(() => store.ensureFolderPath(LOCAL_FOLDERS_ACCOUNT_ID, undefined, [])).toThrow('Choose a destination folder')
    expect(store.ensureFolderPath(LOCAL_FOLDERS_ACCOUNT_ID, undefined, ['Other', 'Work'])).toBe(work.id)
    const sanitized = store.ensureFolderPath(LOCAL_FOLDERS_ACCOUNT_ID, undefined, ['a/b', '\u0001'])
    expect(database.listLabels([LOCAL_FOLDERS_ACCOUNT_ID]).find((label) => label.id === sanitized)?.name).toBe('a-b/Untitled')

    await storeRawForTest(database, LOCAL_FOLDERS_ACCOUNT_ID, { id: 'm1', threadId: 't1', historyId: 'x', raw: raw('Busy'), labelIds: [other.id], sizeEstimate: 10 })
    database.applyLocalAction({ accountId: LOCAL_FOLDERS_ACCOUNT_ID, threadIds: ['t1'], action: 'star' })
    store.createFolder({ accountId: LOCAL_FOLDERS_ACCOUNT_ID, name: 'Leaf', parentId: undefined })
    const leaf = database.listLabels([LOCAL_FOLDERS_ACCOUNT_ID]).find((label) => label.name === 'Leaf')!
    database.applyLocalAction({ accountId: LOCAL_FOLDERS_ACCOUNT_ID, threadIds: ['t1'], action: 'move', labelId: leaf.id })
    expect(() => store.deleteFolder({ accountId: LOCAL_FOLDERS_ACCOUNT_ID, labelId: leaf.id })).toThrow('1 pending mail change still uses this folder')
    expect(store.isLocal(LOCAL_FOLDERS_ACCOUNT_ID)).toBe(true)
    expect(store.isLocal('nobody')).toBe(false)
  })

  it('marks read, stars and moves between folders locally and completes the queued change without a server', async () => {
    const { database } = setup()
    const inbox = database.localMail.createFolder({ accountId: LOCAL_FOLDERS_ACCOUNT_ID, name: 'Inbox' }).label!
    const later = database.localMail.createFolder({ accountId: LOCAL_FOLDERS_ACCOUNT_ID, name: 'Later' }).label!
    await storeRawForTest(database, LOCAL_FOLDERS_ACCOUNT_ID, { id: 'm1', threadId: 't1', historyId: 'x', raw: raw('Hello'), labelIds: [inbox.id, 'UNREAD'], sizeEstimate: 10 })
    database.applyLocalAction({ accountId: LOCAL_FOLDERS_ACCOUNT_ID, threadIds: ['t1'], action: 'read' }, 'op-read', 0)
    database.applyLocalAction({ accountId: LOCAL_FOLDERS_ACCOUNT_ID, threadIds: ['t1'], action: 'star' }, 'op-star', 0)
    database.applyLocalAction({ accountId: LOCAL_FOLDERS_ACCOUNT_ID, threadIds: ['t1'], action: 'move', labelId: later.id }, 'op-move', 0)
    expect(database.listThreads({ accountIds: [LOCAL_FOLDERS_ACCOUNT_ID], folder: 'all', labelId: later.id }).items[0]).toMatchObject({ unread: false, starred: true })
    expect(database.listThreads({ accountIds: [LOCAL_FOLDERS_ACCOUNT_ID], folder: 'all', labelId: inbox.id }).items).toEqual([])
    expect(database.localMail.completeDueOperations().map((item) => item.id).sort()).toEqual(['op-move', 'op-read', 'op-star'])
    expect(database.dueOperations()).toEqual([])
  })
})

describe('transferToLocalFolders', () => {
  it('copies the original source with flags and dates, skips repeats and can move by trashing the source', async () => {
    const { database, store } = setup()
    const folder = database.localMail.createFolder({ accountId: LOCAL_FOLDERS_ACCOUNT_ID, name: 'Saved' }).label!
    const attachment = 'Content-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nHi\r\n--x\r\nContent-Type: application/pdf; name=a.pdf\r\nContent-Disposition: attachment; filename=a.pdf\r\n\r\n%PDF\r\n--x--\r\n'
    const source = Buffer.from(`From: Ada <ada@example.test>\r\nSubject: With file\r\nDate: Wed, 15 Oct 2025 12:00:00 +0000\r\nMessage-ID: <file@example.test>\r\nMIME-Version: 1.0\r\n${attachment}`)
    await seedGmail(database, [
      { id: 'g1', threadId: 'gt1', raw: source, labels: ['INBOX', 'UNREAD', 'STARRED', 'Label_1'] },
      { id: 'g2', threadId: 'gt2', raw: raw('Second'), labels: ['INBOX'] }
    ])

    const copied = await transferToLocalFolders({ database, store }, { sourceAccountId: 'gmail', threadIds: ['gt1'], destinationLabelId: folder.id, mode: 'copy' })
    expect(copied).toEqual({ copied: 1, skipped: 0, missing: 0 })
    const [item] = database.listThreads({ accountIds: [LOCAL_FOLDERS_ACCOUNT_ID], folder: 'all', labelId: folder.id }).items
    expect(item).toMatchObject({ subject: 'With file', unread: true, starred: true, hasAttachments: true, lastDate: '2025-10-15T12:00:00.000Z' })
    expect(item.labelIds.sort()).toEqual([folder.id, 'STARRED', 'UNREAD'].sort())
    const message = database.getThread(LOCAL_FOLDERS_ACCOUNT_ID, item.id).messages[0]
    expect(readFileSync(database.getMessageRaw(LOCAL_FOLDERS_ACCOUNT_ID, message.id)!).equals(source)).toBe(true)
    expect(database.listThreads({ accountIds: ['gmail'], folder: 'inbox' }).total).toBe(2)

    expect(await transferToLocalFolders({ database, store }, { sourceAccountId: 'gmail', threadIds: ['gt1'], destinationLabelId: folder.id, mode: 'copy' })).toEqual({ copied: 0, skipped: 1, missing: 0 })

    const moved = await transferToLocalFolders({ database, store }, { sourceAccountId: 'gmail', threadIds: ['gt2'], destinationLabelId: folder.id, mode: 'move' })
    expect(moved).toMatchObject({ copied: 1, trashOperation: { accountId: 'gmail', kind: 'trash', status: 'queued' } })
    expect(database.listThreads({ accountIds: ['gmail'], folder: 'trash' }).items.map((thread) => thread.id)).toEqual(['gt2'])
  })

  it('does not move when an original was never downloaded', async () => {
    const { database, store } = setup()
    const folder = database.localMail.createFolder({ accountId: LOCAL_FOLDERS_ACCOUNT_ID, name: 'Saved' }).label!
    await seedGmail(database, [{ id: 'g1', threadId: 'gt1', raw: raw('Gone'), labels: ['INBOX'] }])
    rmSync(database.getMessageRaw('gmail', 'g1')!)
    const result = await transferToLocalFolders({ database, store }, { sourceAccountId: 'gmail', threadIds: ['gt1'], destinationLabelId: folder.id, mode: 'move' })
    expect(result).toEqual({ copied: 0, skipped: 0, missing: 1 })
    expect(database.listThreads({ accountIds: ['gmail'], folder: 'inbox' }).total).toBe(1)
  })

  it('validates the destination and source', async () => {
    const { database, store } = setup()
    await seedGmail(database, [{ id: 'g1', threadId: 'gt1', raw: raw('A'), labels: ['INBOX'] }])
    database.replaceLabels('gmail', [{ accountId: 'gmail', id: 'Label_1', name: 'Work', type: 'user' }])
    await expect(transferToLocalFolders({ database, store }, { sourceAccountId: 'gmail', threadIds: ['gt1'], destinationLabelId: 'Label_1', mode: 'copy' })).rejects.toThrow('Local Folders folder')
    const folder = database.localMail.createFolder({ accountId: LOCAL_FOLDERS_ACCOUNT_ID, name: 'Saved' }).label!
    await expect(transferToLocalFolders({ database, store }, { sourceAccountId: LOCAL_FOLDERS_ACCOUNT_ID, threadIds: ['t'], destinationLabelId: folder.id, mode: 'move' })).rejects.toThrow('Use Move')
    database.disconnectAccount('gmail', 'archive')
    await expect(transferToLocalFolders({ database, store }, { sourceAccountId: 'gmail', threadIds: ['gt1'], destinationLabelId: folder.id, mode: 'move' })).rejects.toThrow('offline archive')
    // Disconnected-account archives can still be copied into Local Folders.
    expect(await transferToLocalFolders({ database, store }, { sourceAccountId: 'gmail', threadIds: ['gt1'], destinationLabelId: folder.id, mode: 'copy' })).toMatchObject({ copied: 1 })
  })
})
