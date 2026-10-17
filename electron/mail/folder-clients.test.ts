import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImapAccountInput } from '../../src/mail-types'

const mocks = vi.hoisted(() => ({ imapConstructor: vi.fn() }))
vi.mock('imapflow', () => ({ ImapFlow: mocks.imapConstructor }))
vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn() } }))

import { validateCreateFolder, validateDeleteFolder, validateFolderReference, validateUpdateFolder } from './folder-validation'
import { GmailClient, gmailLabelsWithParents } from './gmail-client'
import { ImapSmtpClient, labelsForImapFolders } from './imap-client'
import { MicrosoftGraphClient, microsoftLabels } from './microsoft-client'

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('provider folder parents', () => {
  it('derives Gmail nesting from label names and Microsoft/IMAP nesting from parents and paths', () => {
    expect(gmailLabelsWithParents([
      { accountId: 'a', id: 'INBOX', name: 'INBOX', type: 'system' },
      { accountId: 'a', id: 'L1', name: 'Work', type: 'user' },
      { accountId: 'a', id: 'L2', name: 'Work/Clients/Acme', type: 'user' }
    ]).map((label) => label.parentId)).toEqual([undefined, undefined, 'L1'])
    expect(microsoftLabels('a', [
      { id: 'root-child', displayName: 'Projects', parentMailFolderId: 'msgfolderroot-id' },
      { id: 'nested', displayName: 'Acme', parentMailFolderId: 'root-child' }
    ]).map((label) => label.parentId)).toEqual([undefined, 'folder:root-child'])
    expect(labelsForImapFolders('a', [
      { path: 'INBOX', name: 'INBOX', delimiter: '.' },
      { path: 'INBOX.Work', name: 'Work', delimiter: '.' },
      { path: 'Orphan/Child', name: 'Child', delimiter: '/' }
    ]).map((label) => label.parentId)).toEqual([undefined, 'folder:INBOX', undefined])
  })
})

describe('GmailClient label management', () => {
  it('creates, patches, reads and deletes labels', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(json({ id: 'L1', name: 'Work', messagesTotal: 2 })))
    vi.stubGlobal('fetch', fetchMock)
    const client = new GmailClient('a', async () => 'token')
    await client.createLabel('Work', { backgroundColor: '#4a86e8', textColor: '#ffffff' })
    await client.patchLabel('L/1', { name: 'Office' })
    expect((await client.getLabel('L1')).messagesTotal).toBe(2)
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    await client.deleteLabel('L1')
    expect(fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${String(url).split('/users/me')[1]}`)).toEqual(['POST /labels', 'PATCH /labels/L%2F1', 'GET /labels/L1', 'DELETE /labels/L1'])
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ name: 'Work', labelListVisibility: 'labelShow', messageListVisibility: 'show', color: { backgroundColor: '#4a86e8', textColor: '#ffffff' } })
  })
})

describe('MicrosoftGraphClient folder management', () => {
  it('creates top-level and child folders, renames, moves and deletes', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(json({ id: 'f1', displayName: 'Work' })))
    vi.stubGlobal('fetch', fetchMock)
    const client = new MicrosoftGraphClient(async () => 'token')
    await client.createFolder('Work')
    await client.createFolder('Acme', 'parent')
    await client.renameFolder('f1', 'Office')
    await client.moveFolder('f1')
    await client.moveFolder('f1', 'parent')
    await client.folder('f1')
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    await client.deleteFolder('f1')
    expect(fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${String(url).replace('https://graph.microsoft.com/v1.0', '').split('?')[0]}`)).toEqual([
      'POST /me/mailFolders', 'POST /me/mailFolders/parent/childFolders', 'PATCH /me/mailFolders/f1', 'POST /me/mailFolders/f1/move', 'POST /me/mailFolders/f1/move', 'GET /me/mailFolders/f1', 'DELETE /me/mailFolders/f1'
    ])
    expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toEqual({ destinationId: 'msgfolderroot' })
    expect(JSON.parse(fetchMock.mock.calls[4][1].body)).toEqual({ destinationId: 'parent' })
  })
})

describe('ImapSmtpClient folder management', () => {
  const config: ImapAccountInput = { provider: 'imap', email: 'p@example.test', username: 'p', password: 's', imapHost: 'imap.example.test', imapPort: 993, imapSecurity: 'tls', smtpHost: 'smtp.example.test', smtpPort: 587, smtpSecurity: 'starttls' }
  let subject: ImapSmtpClient
  let client: Record<string, ReturnType<typeof vi.fn>>
  const lock = { release: vi.fn() }

  beforeEach(() => {
    subject = new ImapSmtpClient(config)
    lock.release.mockClear()
    client = {
      list: vi.fn().mockResolvedValue([
        { path: 'INBOX', name: 'INBOX', delimiter: '/', flags: new Set(), specialUse: '\\Inbox' },
        { path: 'Trash', name: 'Trash', delimiter: '/', flags: new Set(), specialUse: '\\Trash' },
        { path: 'Work', name: 'Work', delimiter: '/', flags: new Set() },
        { path: 'Work/Acme', name: 'Acme', delimiter: '/', flags: new Set() }
      ]),
      mailboxCreate: vi.fn().mockImplementation(async (path: string | string[]) => ({ path: Array.isArray(path) ? path.join('/') : path, created: true })),
      mailboxRename: vi.fn().mockImplementation(async (path: string, newPath: string | string[]) => ({ path, newPath: Array.isArray(newPath) ? newPath.join('/') : newPath })),
      mailboxDelete: vi.fn().mockResolvedValue({ path: 'x' }),
      status: vi.fn().mockResolvedValue({ messages: 0 }),
      getMailboxLock: vi.fn().mockResolvedValue(lock),
      messageMove: vi.fn().mockResolvedValue({ uidMap: new Map() })
    }
    vi.spyOn(subject, 'withConnection').mockImplementation(async (callback) => callback(client as never))
  })

  it('creates top-level folders through the namespace-aware array form and nested folders by path', async () => {
    await expect(subject.createFolder(undefined, 'Receipts')).resolves.toEqual({ path: 'Receipts', delimiter: '/' })
    expect(client.mailboxCreate).toHaveBeenCalledWith(['Receipts'])
    await subject.createFolder('Work', 'Beta')
    expect(client.mailboxCreate).toHaveBeenLastCalledWith('Work/Beta')
    await expect(subject.createFolder('Missing', 'Beta')).rejects.toThrow('parent folder no longer exists')
    await expect(subject.createFolder('Work', 'a/b')).rejects.toThrow('separator')
    client.mailboxCreate.mockResolvedValueOnce({ path: 'Dup', created: false })
    await expect(subject.createFolder(undefined, 'Dup')).rejects.toThrow('already exists')
  })

  it('renames and moves folders and refuses stale or conflicting targets', async () => {
    await expect(subject.renameFolder('Work/Acme', undefined, 'Acme Corp')).resolves.toEqual({ path: 'Acme Corp', delimiter: '/' })
    expect(client.mailboxRename).toHaveBeenCalledWith('Work/Acme', ['Acme Corp'])
    await subject.renameFolder('Work/Acme', 'INBOX', 'Acme')
    expect(client.mailboxRename).toHaveBeenLastCalledWith('Work/Acme', 'INBOX/Acme')
    await expect(subject.renameFolder('Gone', undefined, 'X')).rejects.toThrow('renamed or removed')
    await expect(subject.renameFolder('Work/Acme', undefined, 'work')).rejects.toThrow('already exists')
    await expect(subject.renameFolder('Work/Acme', 'Work', 'Acme')).resolves.toEqual({ path: 'Work/Acme', delimiter: '/' })
    expect(client.mailboxRename).toHaveBeenCalledTimes(2)
  })

  it('never deletes a non-empty folder without confirmation and empties it into Trash first', async () => {
    await expect(subject.deleteFolder('Work', true)).rejects.toThrow('subfolders first')
    client.status.mockResolvedValueOnce({ messages: 3 })
    await expect(subject.deleteFolder('Work/Acme', false)).rejects.toThrow('contains 3 messages on the server')
    expect(client.mailboxDelete).not.toHaveBeenCalled()

    client.status.mockResolvedValueOnce({ messages: 3 }).mockResolvedValueOnce({ messages: 1 })
    await expect(subject.deleteFolder('Work/Acme', true)).rejects.toThrow('1 message could not be moved to Trash, so the folder was kept')
    expect(client.messageMove).toHaveBeenCalledWith('1:*', 'Trash')
    expect(lock.release).toHaveBeenCalledOnce()
    expect(client.mailboxDelete).not.toHaveBeenCalled()

    client.status.mockResolvedValueOnce({ messages: 3 }).mockResolvedValueOnce({ messages: 0 })
    await expect(subject.deleteFolder('Work/Acme', true)).resolves.toEqual({ moved: 3, movedTo: 'Trash' })
    expect(client.mailboxDelete).toHaveBeenCalledWith('Work/Acme')
  })

  it('refuses to delete a non-empty folder when no Trash exists', async () => {
    client.list.mockResolvedValue([{ path: 'Work', name: 'Work', delimiter: '/', flags: new Set() }])
    client.status.mockResolvedValueOnce({ messages: 2 })
    await expect(subject.deleteFolder('Work', true)).rejects.toThrow('does not expose a Trash folder')
    expect(client.messageMove).not.toHaveBeenCalled()
    expect(client.mailboxDelete).not.toHaveBeenCalled()
  })
})

describe('folder request validation', () => {
  it('normalizes valid requests and rejects malformed ones', () => {
    expect(validateCreateFolder({ accountId: 'a', name: ' Work ', color: '#4A86E8' })).toEqual({ accountId: 'a', name: 'Work', color: '#4a86e8' })
    expect(validateUpdateFolder({ accountId: 'a', labelId: 'L1', parentId: null })).toEqual({ accountId: 'a', labelId: 'L1', parentId: null })
    expect(validateDeleteFolder({ accountId: 'a', labelId: 'L1' })).toEqual({ accountId: 'a', labelId: 'L1', confirmNonEmpty: false })
    expect(validateFolderReference('a', 'L1')).toEqual({ accountId: 'a', labelId: 'L1' })
    expect(() => validateCreateFolder({ accountId: 'a', name: '  ' })).toThrow('Enter a folder name')
    expect(() => validateCreateFolder({ accountId: 'a', name: 'x', color: 'red' })).toThrow('valid color')
    expect(() => validateUpdateFolder({ accountId: '', labelId: 'L1' })).toThrow('account')
    expect(() => validateDeleteFolder({ accountId: 'a', labelId: 'L1', confirmNonEmpty: 'yes' as never })).toThrow('confirmation')
    expect(() => validateCreateFolder(null as never)).toThrow('invalid')
  })
})
