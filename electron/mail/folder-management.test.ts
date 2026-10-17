import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MailLabel, MailProviderId } from '../../src/mail-types'
import { MailDatabase, type ParsedMailMessage } from './database'
import { FOLDER_NOT_EMPTY_PATTERN, FolderNotEmptyError } from './folder-errors'
import { MailFolderManager, providerFolderError, type MailFolderManagerDeps } from './folder-management'
import { GmailApiError } from './gmail-client'
import { MicrosoftGraphError } from './microsoft-client'

const directories: string[] = []
const open: MailDatabase[] = []
afterEach(() => {
  for (const database of open.splice(0)) try { database.close() } catch { /* Already closed by the test. */ }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function setup(provider: MailProviderId, labels: MailLabel[]) {
  const directory = mkdtempSync(join(tmpdir(), 'aerio-folders-test-'))
  directories.push(directory)
  const path = join(directory, 'aerio.sqlite')
  const database = new MailDatabase(path, join(directory, 'mail'))
  open.push(database)
  database.upsertAccount({ id: 'a', provider, email: 'person@example.test', displayName: 'Person', color: '#6558e8', status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true })
  database.replaceLabels('a', labels)
  let online = true
  let remoteLabels = labels
  const gmail = {
    listLabels: vi.fn(async () => remoteLabels),
    getLabel: vi.fn(async (id: string) => ({ id, name: id, messagesTotal: 0 })),
    createLabel: vi.fn(async (name: string) => { remoteLabels = [...remoteLabels, { accountId: 'a', id: `Label_${name}`, name, type: 'user' as const }]; return { id: `Label_${name}`, name } }),
    patchLabel: vi.fn(async (id: string) => ({ id, name: id })),
    deleteLabel: vi.fn(async (id: string) => { remoteLabels = remoteLabels.filter((label) => label.id !== id) })
  }
  const microsoft = {
    listFolders: vi.fn(async () => remoteLabels.map((label) => ({ id: label.id.slice(7), displayName: label.name, parentMailFolderId: label.parentId?.slice(7), specialUse: label.type === 'system' ? 'inbox' : undefined }))),
    folder: vi.fn(async (id: string) => ({ id, displayName: id, childFolderCount: 0, totalItemCount: 0 })),
    createFolder: vi.fn(async (displayName: string, parentId?: string) => {
      remoteLabels = [...remoteLabels, { accountId: 'a', id: 'folder:new-id', name: displayName, type: 'user' as const, ...(parentId ? { parentId: `folder:${parentId}` } : {}) }]
      return { id: 'new-id', displayName }
    }),
    renameFolder: vi.fn(async (id: string, displayName: string) => ({ id, displayName })),
    moveFolder: vi.fn(async (id: string) => ({ id, displayName: id })),
    deleteFolder: vi.fn(async () => undefined)
  }
  const imap = {
    withConnection: vi.fn(async (callback: (connection: never) => unknown) => callback({} as never)),
    listFolders: vi.fn(async () => remoteLabels.map((label) => ({ path: label.id.slice(7), name: label.name, delimiter: '/', ...(label.type === 'system' ? { specialUse: label.id === 'folder:Trash' ? '\\Trash' : '\\Inbox' } : {}) }))),
    createFolder: vi.fn(async (parent: string | undefined, name: string) => {
      const path = parent ? `${parent}/${name}` : name
      remoteLabels = [...remoteLabels, { accountId: 'a', id: `folder:${path}`, name: path, type: 'user' as const }]
      return { path, delimiter: '/' }
    }),
    renameFolder: vi.fn(async (path: string, parent: string | undefined, name: string) => {
      const target = parent ? `${parent}/${name}` : name
      remoteLabels = remoteLabels.map((label) => label.id === `folder:${path}` || label.id.startsWith(`folder:${path}/`)
        ? { ...label, id: `folder:${target}${label.id.slice(7 + path.length)}`, name: `${target}${label.name.slice(path.length)}` } : label)
      return { path: target, delimiter: '/' }
    }),
    deleteFolder: vi.fn(async (path: string, allowNonEmpty: boolean) => {
      if (!allowNonEmpty && database.folderUsage('a', `folder:${path}`).messages) throw new FolderNotEmptyError(1)
      remoteLabels = remoteLabels.filter((label) => label.id !== `folder:${path}`)
      return { moved: 0 }
    })
  }
  const deps: MailFolderManagerDeps = { database, online: () => online, gmail: () => gmail, microsoft: () => microsoft, imap: async () => imap as never }
  return { database, path, manager: new MailFolderManager(deps), gmail, microsoft, imap, setOnline: (value: boolean) => { online = value } }
}

function message(overrides: Partial<ParsedMailMessage>): ParsedMailMessage {
  return {
    accountId: 'a', id: 'm1', threadId: 't1', historyId: '1', internalDate: '2026-10-01T10:00:00.000Z', fromName: 'Ada', fromEmail: 'ada@example.test',
    to: ['person@example.test'], cc: [], subject: 'Report', references: [], snippet: '', text: 'Body', html: '', labelIds: ['INBOX'],
    sizeEstimate: 10, rawPath: join(tmpdir(), 'missing.eml'), attachments: [], ...overrides
  }
}

const imapLabels: MailLabel[] = [
  { accountId: 'a', id: 'folder:INBOX', name: 'INBOX', type: 'system' },
  { accountId: 'a', id: 'folder:Trash', name: 'Trash', type: 'system' },
  { accountId: 'a', id: 'folder:Projects', name: 'Projects', type: 'user' },
  { accountId: 'a', id: 'folder:Projects/2026', name: 'Projects/2026', type: 'user', parentId: 'folder:Projects' }
]

describe('MailFolderManager', () => {
  it('creates nested Gmail labels with a palette color and journals the request', async () => {
    const { manager, gmail, database } = setup('gmail', [{ accountId: 'a', id: 'Label_1', name: 'Work', type: 'user' }])
    const result = await manager.create({ accountId: 'a', name: ' Clients ', parentId: 'Label_1', color: '#4a86e8' })
    expect(gmail.createLabel).toHaveBeenCalledWith('Work/Clients', { backgroundColor: '#4a86e8', textColor: '#ffffff' })
    expect(result.label).toEqual(expect.objectContaining({ id: 'Label_Work/Clients', name: 'Work/Clients' }))
    expect(database.listFolderOperations('a')).toEqual([expect.objectContaining({ kind: 'create', status: 'succeeded' })])
    await expect(manager.create({ accountId: 'a', name: 'Work', color: '#123456' })).rejects.toThrow('Choose one of the Gmail label colors')
    await expect(manager.create({ accountId: 'a', name: 'work' })).rejects.toThrow('already exists')
    expect(gmail.createLabel).toHaveBeenCalledOnce()
  })

  it('applies capability and system-folder restrictions before contacting the provider', async () => {
    const { manager, microsoft, setOnline } = setup('microsoft', [
      { accountId: 'a', id: 'folder:inbox-id', name: 'Inbox', type: 'system' },
      { accountId: 'a', id: 'folder:p', name: 'Projects', type: 'user' }
    ])
    await expect(manager.update({ accountId: 'a', labelId: 'folder:inbox-id', name: 'Mail' })).rejects.toThrow('system folder')
    await expect(manager.delete({ accountId: 'a', labelId: 'folder:inbox-id' })).rejects.toThrow('system folder')
    await expect(manager.update({ accountId: 'a', labelId: 'folder:p', color: '#4a86e8' })).rejects.toThrow('does not support folder colors')
    await expect(manager.update({ accountId: 'a', labelId: 'folder:p', parentId: 'folder:p' })).rejects.toThrow('inside itself')
    setOnline(false)
    await expect(manager.create({ accountId: 'a', name: 'Offline' })).rejects.toThrow('require an internet connection')
    expect(microsoft.createFolder).not.toHaveBeenCalled()
    expect(microsoft.renameFolder).not.toHaveBeenCalled()
    setOnline(true)
    await manager.create({ accountId: 'a', name: 'Receipts', parentId: 'folder:inbox-id' })
    expect(microsoft.createFolder).toHaveBeenCalledWith('Receipts', 'inbox-id')
  })

  it('renames and moves Microsoft folders by stable id', async () => {
    const { manager, microsoft } = setup('microsoft', [
      { accountId: 'a', id: 'folder:p', name: 'Projects', type: 'user' },
      { accountId: 'a', id: 'folder:q', name: 'Archive 2026', type: 'user' }
    ])
    const result = await manager.update({ accountId: 'a', labelId: 'folder:p', name: 'Clients', parentId: 'folder:q' })
    expect(microsoft.renameFolder).toHaveBeenCalledWith('p', 'Clients')
    expect(microsoft.moveFolder).toHaveBeenCalledWith('p', 'q')
    expect(result.renamed).toEqual({})
  })

  it('renames Gmail child labels with their parent', async () => {
    const { manager, gmail } = setup('gmail', [
      { accountId: 'a', id: 'L1', name: 'Work', type: 'user' },
      { accountId: 'a', id: 'L2', name: 'Work/Clients', type: 'user', parentId: 'L1' }
    ])
    await manager.update({ accountId: 'a', labelId: 'L1', name: 'Office' })
    expect(gmail.patchLabel).toHaveBeenNthCalledWith(1, 'L1', { name: 'Office' })
    expect(gmail.patchLabel).toHaveBeenNthCalledWith(2, 'L2', { name: 'Office/Clients' })
  })

  it('rewrites IMAP paths in messages, queued operations, undo snapshots, rules and checkpoints on rename', async () => {
    const { manager, database, imap } = setup('imap', imapLabels)
    await database.upsertMessage(message({ id: 'm1', labelIds: ['folder:Projects/2026'], remoteFolderId: 'Projects/2026', remoteUid: '4' }))
    await database.upsertMessage(message({ id: 'm2', threadId: 't2', labelIds: ['INBOX', 'folder:INBOX'], remoteFolderId: 'INBOX', remoteUid: '5' }))
    const operation = database.applyLocalAction({ accountId: 'a', threadIds: ['t2'], action: 'move', labelId: 'folder:Projects' })
    database.saveRule({ accountId: 'a', name: 'File', enabled: true, match: 'all', conditions: [{ field: 'from', operator: 'contains', value: 'ada' }], actions: [{ action: 'move', labelId: 'folder:Projects/2026' }] })
    database.setProviderState('a', { folders: { Projects: { uidValidity: '1' }, 'Projects/2026': { uidValidity: '2' } } })

    const result = await manager.update({ accountId: 'a', labelId: 'folder:Projects', name: 'Clients' })
    expect(imap.renameFolder).toHaveBeenCalledWith('Projects', undefined, 'Clients')
    expect(result.renamed).toEqual({ 'folder:Projects': 'folder:Clients', 'folder:Projects/2026': 'folder:Clients/2026' })
    expect(result.labels.map((label) => label.id)).toEqual(expect.arrayContaining(['folder:Clients', 'folder:Clients/2026']))
    expect(database.remoteMessagesForThreads('a', ['t1'])[0]).toEqual(expect.objectContaining({ remoteFolderId: 'Clients/2026', labelIds: ['folder:Clients/2026'] }))
    expect(database.pendingOperationsForLabel('a', 'folder:Clients')).toBe(1)
    expect(database.pendingOperationsForLabel('a', 'folder:Projects')).toBe(0)
    expect(database.listRules(['a'])[0].actions[0].labelId).toBe('folder:Clients/2026')
    expect(database.getProviderState('a', {})).toEqual({ folders: { Clients: { uidValidity: '1' }, 'Clients/2026': { uidValidity: '2' } } })
    // Undoing the queued move restores the rewritten (not stale) snapshot.
    expect(database.undoOperation(operation.id)).toBe(true)
    expect(database.remoteMessagesForThreads('a', ['t2'])[0].labelIds).toEqual(['INBOX', 'folder:INBOX'])
  })

  it('requires explicit confirmation before deleting a non-empty folder and blocks unsafe deletions', async () => {
    const { manager, database, imap } = setup('imap', imapLabels)
    await database.upsertMessage(message({ id: 'm1', labelIds: ['folder:Projects/2026'], remoteFolderId: 'Projects/2026', remoteUid: '4' }))
    await expect(manager.delete({ accountId: 'a', labelId: 'folder:Projects' })).rejects.toThrow('subfolders first')
    const preview = manager.preview('a', 'folder:Projects/2026')
    expect(preview).toEqual(expect.objectContaining({ messages: 1, threads: 1, childFolders: 0, deleteKeepsMessages: false, messagesMoveTo: 'Trash' }))
    const error = await manager.delete({ accountId: 'a', labelId: 'folder:Projects/2026' }).then(() => new Error('resolved'), (value: Error) => value)
    expect(error.message).toMatch(FOLDER_NOT_EMPTY_PATTERN)
    expect(imap.deleteFolder).not.toHaveBeenCalled()
    expect(database.hasMessage('a', 'm1')).toBe(true)

    await database.upsertMessage(message({ id: 'm3', threadId: 't3', labelIds: ['INBOX'], remoteFolderId: 'INBOX', remoteUid: '9' }))
    const operation = database.applyLocalAction({ accountId: 'a', threadIds: ['t3'], action: 'move', labelId: 'folder:Projects/2026' })
    await expect(manager.delete({ accountId: 'a', labelId: 'folder:Projects/2026', confirmNonEmpty: true })).rejects.toThrow('pending mail change still uses')
    database.undoOperation(operation.id)

    const result = await manager.delete({ accountId: 'a', labelId: 'folder:Projects/2026', confirmNonEmpty: true })
    expect(imap.deleteFolder).toHaveBeenCalledWith('Projects/2026', true)
    expect(result.deletedId).toBe('folder:Projects/2026')
    expect(result.labels.some((label) => label.id === 'folder:Projects/2026')).toBe(false)
  })

  it('keeps cached messages and labels when the provider refuses a deletion', async () => {
    const { manager, database, gmail } = setup('gmail', [{ accountId: 'a', id: 'L1', name: 'Receipts', type: 'user' }])
    await database.upsertMessage(message({ labelIds: ['INBOX', 'L1'] }))
    gmail.deleteLabel.mockRejectedValueOnce(new GmailApiError('Backend error', 400))
    await expect(manager.delete({ accountId: 'a', labelId: 'L1', confirmNonEmpty: true })).rejects.toThrow('Backend error')
    expect(database.remoteMessagesForThreads('a', ['t1'])[0].labelIds).toEqual(['INBOX', 'L1'])
    expect(database.listLabels(['a']).map((label) => label.id)).toEqual(['L1'])
    expect(database.listFolderOperations('a').at(-1)).toEqual(expect.objectContaining({ kind: 'delete', status: 'failed', error: 'Backend error' }))

    const result = await manager.delete({ accountId: 'a', labelId: 'L1', confirmNonEmpty: true })
    expect(result.deletedId).toBe('L1')
    expect(database.hasMessage('a', 'm1')).toBe(true)
    expect(database.remoteMessagesForThreads('a', ['t1'])[0].labelIds).toEqual(['INBOX'])
  })

  it('checks the live provider count when the cache believes a folder is empty', async () => {
    const gmailCase = setup('gmail', [{ accountId: 'a', id: 'L1', name: 'Receipts', type: 'user' }])
    gmailCase.gmail.getLabel.mockResolvedValueOnce({ id: 'L1', name: 'Receipts', messagesTotal: 12 })
    await expect(gmailCase.manager.delete({ accountId: 'a', labelId: 'L1' })).rejects.toThrow('contains 12 messages on the server')
    expect(gmailCase.gmail.deleteLabel).not.toHaveBeenCalled()

    const microsoftCase = setup('microsoft', [{ accountId: 'a', id: 'folder:p', name: 'Projects', type: 'user' }])
    microsoftCase.microsoft.folder.mockResolvedValueOnce({ id: 'p', displayName: 'Projects', childFolderCount: 1, totalItemCount: 0 })
    await expect(microsoftCase.manager.delete({ accountId: 'a', labelId: 'folder:p', confirmNonEmpty: true })).rejects.toThrow('subfolders first')
    microsoftCase.microsoft.folder.mockResolvedValueOnce({ id: 'p', displayName: 'Projects', childFolderCount: 0, totalItemCount: 3 })
    await expect(microsoftCase.manager.delete({ accountId: 'a', labelId: 'folder:p' })).rejects.toThrow('contains 3 messages')
    expect(microsoftCase.microsoft.deleteFolder).not.toHaveBeenCalled()
  })

  it('refreshes the folder list after a provider conflict', async () => {
    const { manager, database, microsoft } = setup('microsoft', [{ accountId: 'a', id: 'folder:p', name: 'Projects', type: 'user' }])
    microsoft.renameFolder.mockRejectedValueOnce(new MicrosoftGraphError('Not found', 404))
    microsoft.listFolders.mockResolvedValueOnce([])
    await expect(manager.update({ accountId: 'a', labelId: 'folder:p', name: 'Clients' })).rejects.toThrow('changed or removed on the server')
    expect(database.listLabels(['a'])).toEqual([])
    await expect(manager.update({ accountId: 'a', labelId: 'folder:p', name: 'Clients' })).rejects.toThrow('no longer exists')
  })

  it('adds the folder schema idempotently to an existing database', () => {
    const { database, path } = setup('gmail', [{ accountId: 'a', id: 'L2', name: 'Work/Clients', type: 'user', parentId: 'L1' }])
    database.close()
    const legacy = new DatabaseSync(path)
    legacy.exec('ALTER TABLE gmail_labels DROP COLUMN parent_id; DROP TABLE mail_folder_operations;')
    legacy.close()
    const migrated = new MailDatabase(path, join(path, '..', 'mail'))
    open.push(migrated)
    expect(migrated.listLabels(['a'])[0].parentId).toBeUndefined()
    migrated.replaceLabels('a', [{ accountId: 'a', id: 'L2', name: 'Work/Clients', type: 'user', parentId: 'L1' }])
    expect(migrated.listLabels(['a'])[0].parentId).toBe('L1')
    expect(migrated.listFolderOperations()).toEqual([])
    migrated.close()
    const again = new MailDatabase(path, join(path, '..', 'mail'))
    open.push(again)
    expect(again.listLabels(['a'])[0].parentId).toBe('L1')
  })

  it('recovers interrupted folder changes after a restart', () => {
    const { database, path } = setup('gmail', [])
    const id = database.beginFolderOperation('a', 'delete', 'L1', { accountId: 'a', labelId: 'L1' })
    database.close()
    const reopened = new MailDatabase(path, join(path, '..', 'mail'))
    open.push(reopened)
    expect(reopened.recoverInterruptedFolderOperations()).toEqual(['a'])
    expect(reopened.listFolderOperations('a')).toEqual([expect.objectContaining({ id, status: 'interrupted' })])
    expect(reopened.recoverInterruptedFolderOperations()).toEqual([])
  })
})

describe('providerFolderError', () => {
  it('maps provider conflicts to user-facing messages', () => {
    expect(providerFolderError(new GmailApiError('Label name exists or conflicts', 409)).message).toMatch('already exists')
    expect(providerFolderError(new MicrosoftGraphError('Missing', 404)).name).toBe('FolderConflictError')
    expect(providerFolderError(Object.assign(new Error('NO'), { serverResponseCode: 'ALREADYEXISTS' })).message).toMatch('already exists on the mail server')
    expect(providerFolderError(Object.assign(new Error('NO'), { serverResponseCode: 'NONEXISTENT' })).name).toBe('FolderConflictError')
    expect(providerFolderError('plain').message).toBe('plain')
  })
})
