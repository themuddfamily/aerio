import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import PostalMime from 'postal-mime'
import { generate } from 'selfsigned'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Pop3ConnectionConfig, Pop3Destination, Pop3RetentionPolicy } from '../../src/pop3-types'
import { MailDatabase, type ParsedMailMessage } from './database'
import { pop3MessageId, Pop3Service, type Pop3StoreInput } from './pop3-sync'
import { FakePop3Server, type FakePop3Options } from './pop3-test-server'

let certificate: { key: string; cert: string }
const servers: FakePop3Server[] = []
const directories: string[] = []
const open: MailDatabase[] = []

beforeAll(async () => {
  const pems = await generate([{ name: 'commonName', value: 'localhost' }], { keySize: 2048, algorithm: 'sha256', extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }] })
  certificate = { key: pems.private, cert: pems.cert }
}, 60_000)

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const database of open.splice(0)) try { database.close() } catch { /* Already closed by the test. */ }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const ACCOUNT = 'pop3-account'
const DAY = 24 * 60 * 60 * 1000
const raw = (id: string, extra = '') => `From: Ada <ada@example.test>\r\nTo: me@example.test\r\nSubject: ${id}\r\nMessage-ID: <${id}@example.test>\r\nDate: Wed, 15 Oct 2025 12:00:00 +0000\r\n${extra}\r\nBody of ${id}\r\n`

/** Mirrors the worker's parse-and-store path, including the commit hook inside the message transaction. */
async function store(database: MailDatabase, accountId: string, message: Pop3StoreInput, commit: (record: ParsedMailMessage) => void, failCommit?: () => boolean) {
  const isNew = !database.hasMessage(accountId, message.id)
  const parsed = await PostalMime.parse(message.raw)
  const rawPath = database.rawPath(accountId, message.id)
  writeFileSync(rawPath, message.raw)
  const record: ParsedMailMessage = {
    accountId, id: message.id, threadId: message.threadId, historyId: message.historyId,
    internalDate: message.internalDate ?? new Date().toISOString(),
    fromName: parsed.from?.name ?? '', fromEmail: parsed.from?.address ?? '', to: [], cc: [],
    subject: parsed.subject ?? '(No subject)', messageIdHeader: parsed.messageId, references: [],
    snippet: '', text: parsed.text ?? '', html: '', labelIds: message.labelIds,
    sizeEstimate: message.raw.length, rawPath, attachments: []
  }
  database.transaction(() => {
    database.upsertMessage(record)
    commit(record)
    if (failCommit?.()) throw new Error('Simulated crash before commit')
  })
  return { record, isNew }
}

function profile() {
  const directory = mkdtempSync(join(tmpdir(), 'aerio-pop3-test-'))
  directories.push(directory)
  return directory
}

function openDatabase(directory: string) {
  const database = new MailDatabase(join(directory, 'aerio.sqlite'), join(directory, 'mail'))
  open.push(database)
  return database
}

async function setup(options: { server?: Partial<FakePop3Options>; retention?: Pop3RetentionPolicy; destination?: Pop3Destination; directory?: string } = {}) {
  const server = new FakePop3Server({ mode: 'tls', certificate, messages: [{ uidl: 'u1', raw: raw('one') }, { uidl: 'u2', raw: raw('two') }, { uidl: 'u3', raw: raw('three') }], ...options.server })
  servers.push(server)
  await server.start()
  const directory = options.directory ?? profile()
  const database = openDatabase(directory)
  database.upsertAccount({ id: ACCOUNT, provider: 'pop3', email: 'me@example.test', displayName: 'Me', color: '#123456', status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true })
  const config: Pop3ConnectionConfig = { email: 'me@example.test', username: 'ada', password: 'secret', pop3Host: '127.0.0.1', pop3Port: server.port, pop3Security: 'tls', auth: 'auto', smtpHost: '127.0.0.1', smtpPort: 465, smtpSecurity: 'tls' }
  database.pop3.saveSettings(ACCOUNT, { server: config, retention: options.retention ?? { leaveOnServer: true, removeWhenDeleted: false }, destination: options.destination ?? { kind: 'account' } })
  return { server, database, directory, service: service(database, config) }
}

function service(database: MailDatabase, config: Pop3ConnectionConfig, extra: { now?: () => number; failCommit?: () => boolean; maxMessageBytes?: number } = {}) {
  return new Pop3Service({
    database,
    credential: async () => config,
    store: (accountId, message, commit) => store(database, accountId, message, commit, extra.failCommit),
    assertCanSync: async () => undefined,
    emitProgress: () => undefined,
    changed: () => undefined,
    clientOptions: { tls: { ca: certificate.cert }, timeoutMs: 3_000 },
    ...(extra.now ? { now: extra.now } : {}),
    ...(extra.maxMessageBytes ? { maxMessageBytes: extra.maxMessageBytes } : {})
  })
}

const subjects = (database: MailDatabase, accountId = ACCOUNT) => database.listThreads({ accountIds: [accountId], folder: 'all', pageSize: 100 } as never).items.map((item) => item.subject).sort()
const configOf = (server: FakePop3Server): Pop3ConnectionConfig => ({ email: 'me@example.test', username: 'ada', password: 'secret', pop3Host: '127.0.0.1', pop3Port: server.port, pop3Security: 'tls', auth: 'auto', smtpHost: '127.0.0.1', smtpPort: 465, smtpSecurity: 'tls' })
const retrCount = (server: FakePop3Server) => server.commands.filter((command) => command.startsWith('RETR')).length

describe('POP3 download model', () => {
  it('downloads every message into the account Inbox once, keyed by UIDL', async () => {
    const { server, database, service: pop3 } = await setup()
    const result = await pop3.sync(ACCOUNT)
    expect(result.downloaded).toBe(3)
    expect(subjects(database)).toEqual(['one', 'three', 'two'])
    const stored = database.getThread(ACCOUNT, result.newMessages[0].threadId).messages[0]
    expect(stored.labelIds).toEqual(expect.arrayContaining(['INBOX', 'UNREAD']))
    expect(database.pop3.row(ACCOUNT, 'u1')).toMatchObject({ state: 'stored', messageAccountId: ACCOUNT, messageId: pop3MessageId(ACCOUNT, 'u1'), onServer: true })
    // Nothing is removed from the server by default.
    expect(server.uidls()).toEqual(['u1', 'u2', 'u3'])
    expect(server.commands.some((command) => command.startsWith('DELE'))).toBe(false)
  })

  it('keeps UIDLs stable across sessions: repeated checks download only new messages, even when message numbers shift', async () => {
    const { server, database, service: pop3 } = await setup()
    await pop3.sync(ACCOUNT)
    expect((await pop3.sync(ACCOUNT)).downloaded).toBe(0)
    // Another client removes u1, so u2 and u3 are renumbered, and new mail arrives.
    server.maildrop.splice(0, 1)
    server.add({ uidl: 'u4', raw: raw('four') })
    const third = await pop3.sync(ACCOUNT)
    expect(third.downloaded).toBe(1)
    expect(third.newMessages.map((message) => message.subject)).toEqual(['four'])
    expect(retrCount(server)).toBe(4)
    expect(subjects(database)).toEqual(['four', 'one', 'three', 'two'])
    expect(database.pop3.row(ACCOUNT, 'u1')).toMatchObject({ state: 'stored', onServer: false })
  })

  it('never downloads a message again after its local copy is deleted', async () => {
    const { server, database, service: pop3 } = await setup()
    await pop3.sync(ACCOUNT)
    database.deleteMessage(ACCOUNT, pop3MessageId(ACCOUNT, 'u2'))
    expect((await pop3.sync(ACCOUNT)).downloaded).toBe(0)
    expect(retrCount(server)).toBe(3)
    expect(subjects(database)).toEqual(['one', 'three'])
  })

  it('survives a restart: the checkpoint is durable and nothing is duplicated', async () => {
    const { server, database, directory } = await setup()
    await service(database, configOf(server)).sync(ACCOUNT)
    database.close()
    const reopened = openDatabase(directory)
    server.add({ uidl: 'u4', raw: raw('four') })
    const result = await service(reopened, configOf(server)).sync(ACCOUNT)
    expect(result.downloaded).toBe(1)
    expect(subjects(reopened)).toEqual(['four', 'one', 'three', 'two'])
  })

  it('resumes after the connection drops mid-message without storing a partial or duplicate message', async () => {
    const { server, database, service: pop3 } = await setup({ retention: { leaveOnServer: false, removeWhenDeleted: false } })
    server.failures.dropDuringRetr = 'u2'
    await expect(pop3.sync(ACCOUNT)).rejects.toMatchObject({ kind: 'connection' })
    expect(subjects(database)).toEqual(['one'])
    expect(database.pop3.row(ACCOUNT, 'u2')).toBeUndefined()
    // The session ended without QUIT, so nothing was removed from the server.
    expect(server.uidls()).toEqual(['u1', 'u2', 'u3'])
    const result = await pop3.sync(ACCOUNT)
    expect(result.downloaded).toBe(2)
    expect(subjects(database)).toEqual(['one', 'three', 'two'])
    expect(server.uidls()).toEqual([])
  })

  it('rolls back a message whose checkpoint commit fails, then stores it exactly once on the next check', async () => {
    const { server, database } = await setup()
    let crash = true
    const failing = service(database, configOf(server), { failCommit: () => crash })
    await expect(failing.sync(ACCOUNT)).rejects.toThrow(/Simulated crash/)
    expect(subjects(database)).toEqual([])
    expect(database.pop3.rows(ACCOUNT).size).toBe(0)
    crash = false
    expect((await failing.sync(ACCOUNT)).downloaded).toBe(3)
    expect(subjects(database)).toEqual(['one', 'three', 'two'])
  })

  it('keeps going when the server refuses one message and retries it later', async () => {
    const { server, database, service: pop3 } = await setup()
    server.failures.errorOnRetr = 'u2'
    const first = await pop3.sync(ACCOUNT)
    expect(first).toMatchObject({ downloaded: 2, failed: 1 })
    expect(database.pop3.status(ACCOUNT).lastError).toMatch(/will be retried/)
    server.failures.errorOnRetr = undefined
    expect((await pop3.sync(ACCOUNT)).downloaded).toBe(1)
    expect(subjects(database)).toEqual(['one', 'three', 'two'])
    expect(database.pop3.status(ACCOUNT).lastError).toBeUndefined()
  })

  it('skips messages over the size limit and leaves them on the server', async () => {
    const { server, database } = await setup({ server: { messages: [{ uidl: 'big', raw: raw('big', `X-Pad: ${'p'.repeat(5_000)}\r\n`) }, { uidl: 'small', raw: raw('small') }] }, retention: { leaveOnServer: false, removeWhenDeleted: false } })
    const result = await service(database, configOf(server), { maxMessageBytes: 2_000 }).sync(ACCOUNT)
    expect(result).toMatchObject({ downloaded: 1, skipped: 1 })
    expect(server.uidls()).toEqual(['big'])
    expect(database.pop3.status(ACCOUNT)).toMatchObject({ skipped: 1, downloaded: 1, removedFromServer: 1 })
  })

  it('stores mail in a chosen Local Folders folder and refuses a destination that no longer exists', async () => {
    const directory = profile()
    const database = openDatabase(directory)
    const local = database.localMail.ensureAccount()
    const folder = database.localMail.createFolder({ accountId: local.id, name: 'Old POP mail' }).label!
    database.close()
    const { database: db, service: pop3 } = await setup({ directory, destination: { kind: 'local-folder', labelId: folder.id } })
    const result = await pop3.sync(ACCOUNT)
    expect(result.changedAccounts).toEqual([ACCOUNT, local.id])
    expect(subjects(db, local.id)).toEqual(['one', 'three', 'two'])
    expect(subjects(db)).toEqual([])
    expect(db.pop3.row(ACCOUNT, 'u1')).toMatchObject({ messageAccountId: local.id })
    expect(db.localMail.messagesWithHash(local.id, (await import('./import-headers')).sha256(Buffer.from(raw('one')))).length).toBe(1)
    db.localMail.deleteFolder({ accountId: local.id, labelId: folder.id, confirmNonEmpty: true })
    await expect(pop3.sync(ACCOUNT)).rejects.toThrow(/no longer exists/)
  })

  it('reports authentication failures so the account asks for its password', async () => {
    const { server, database } = await setup()
    await expect(service(database, { ...configOf(server), password: 'wrong' }).sync(ACCOUNT)).rejects.toMatchObject({ kind: 'auth', message: expect.stringMatching(/^Authentication failed/) })
    expect(database.pop3.status(ACCOUNT).lastError).toMatch(/Authentication failed/)
  })

  it('reports TLS errors without downloading anything', async () => {
    const { database, server } = await setup()
    const untrusted = new Pop3Service({ database, credential: async () => configOf(server), store: () => { throw new Error('must not store') }, assertCanSync: async () => undefined, emitProgress: () => undefined, changed: () => undefined, clientOptions: { timeoutMs: 3_000 } })
    await expect(untrusted.sync(ACCOUNT)).rejects.toMatchObject({ kind: 'tls' })
    expect(server.sessions).toBe(0)
  })

  it('verifies a connection without changing the mailbox', async () => {
    const { server, service: pop3 } = await setup()
    await pop3.verify(ACCOUNT)
    expect(server.commands).not.toContain('RETR 1')
    expect(server.uidls()).toEqual(['u1', 'u2', 'u3'])
  })

  it('keeps a sent copy in the account Sent folder', async () => {
    const { database, service: pop3 } = await setup()
    const mime = Buffer.from(raw('sent-reply', 'In-Reply-To: <one@example.test>\r\nReferences: <one@example.test>\r\n'))
    await pop3.recordSent(ACCOUNT, mime)
    await pop3.recordSent(ACCOUNT, mime)
    const page = database.listThreads({ accountIds: [ACCOUNT], folder: 'sent', pageSize: 10 } as never)
    expect(page.items.map((item) => item.subject)).toEqual(['sent-reply'])
  })
})

describe('POP3 retention policies', () => {
  it('removes each message after download only once it is stored, and DELE follows RETR', async () => {
    const { server, database, service: pop3 } = await setup({ retention: { leaveOnServer: false, removeWhenDeleted: false } })
    const result = await pop3.sync(ACCOUNT)
    expect(result).toMatchObject({ downloaded: 3, removed: 3 })
    expect(server.uidls()).toEqual([])
    expect(server.commands.findIndex((command) => command.startsWith('DELE'))).toBeGreaterThan(server.commands.lastIndexOf('RETR 3'))
    expect(database.pop3.status(ACCOUNT)).toMatchObject({ downloaded: 3, onServer: 0, removedFromServer: 3, pendingRemoval: 0 })
    expect(subjects(database)).toEqual(['one', 'three', 'two'])
  })

  it('leaves messages until they are N days old', async () => {
    const { server, database } = await setup({ retention: { leaveOnServer: true, deleteAfterDays: 7, removeWhenDeleted: false } })
    let now = Date.now()
    const pop3 = service(database, configOf(server), { now: () => now })
    await pop3.sync(ACCOUNT)
    expect(server.uidls()).toHaveLength(3)
    now += 6 * DAY
    expect((await pop3.sync(ACCOUNT)).removed).toBe(0)
    now += 2 * DAY
    expect((await pop3.sync(ACCOUNT)).removed).toBe(3)
    expect(server.uidls()).toEqual([])
    // Removing them from the server never deletes the local copies.
    expect(subjects(database)).toEqual(['one', 'three', 'two'])
  })

  it('removes a message from the server when it is deleted in Aerio, but not during its Undo window', async () => {
    const { server, database, service: pop3 } = await setup({ retention: { leaveOnServer: true, removeWhenDeleted: true } })
    const first = await pop3.sync(ACCOUNT)
    const two = first.newMessages.find((message) => message.subject === 'two')!
    const three = first.newMessages.find((message) => message.subject === 'three')!
    database.applyLocalAction({ accountId: ACCOUNT, threadIds: [two.threadId], action: 'trash' })
    expect((await pop3.sync(ACCOUNT)).removed).toBe(0)
    expect(server.uidls()).toEqual(['u1', 'u2', 'u3'])
    // The Undo window passes and the change completes locally.
    database.applyLocalAction({ accountId: ACCOUNT, threadIds: [three.threadId], action: 'trash' }, crypto.randomUUID(), 0)
    database.localMail.completeDueOperations()
    database.deleteMessage(ACCOUNT, pop3MessageId(ACCOUNT, 'u1'))
    const result = await pop3.sync(ACCOUNT)
    expect(result.removed).toBe(2)
    expect(server.uidls()).toEqual(['u2'])
    expect(database.pop3.row(ACCOUNT, 'u3')).toMatchObject({ state: 'deleted', removalReason: 'deleted-in-aerio' })
  })

  it('keeps removals pending when the server drops the session before QUIT, and finishes them next time', async () => {
    const { server, database, service: pop3 } = await setup({ retention: { leaveOnServer: false, removeWhenDeleted: false } })
    server.failures.dropOnQuit = true
    await pop3.sync(ACCOUNT)
    expect(server.uidls()).toEqual(['u1', 'u2', 'u3'])
    expect(database.pop3.status(ACCOUNT)).toMatchObject({ pendingRemoval: 3, removedFromServer: 0 })
    server.failures.dropOnQuit = false
    const result = await pop3.sync(ACCOUNT)
    expect(result).toMatchObject({ downloaded: 0, removed: 3 })
    expect(server.uidls()).toEqual([])
    expect(database.pop3.status(ACCOUNT)).toMatchObject({ pendingRemoval: 0, removedFromServer: 3 })
  })

  it('cancels a pending removal when the message is restored from Trash before it happened', async () => {
    const { server, database, service: pop3 } = await setup({ retention: { leaveOnServer: true, removeWhenDeleted: true } })
    const first = await pop3.sync(ACCOUNT)
    const one = first.newMessages.find((message) => message.subject === 'one')!
    database.applyLocalAction({ accountId: ACCOUNT, threadIds: [one.threadId], action: 'trash' }, crypto.randomUUID(), 0)
    database.localMail.completeDueOperations()
    server.failures.dropOnQuit = true
    await pop3.sync(ACCOUNT)
    expect(database.pop3.row(ACCOUNT, 'u1')?.state).toBe('delete-pending')
    database.applyLocalAction({ accountId: ACCOUNT, threadIds: [one.threadId], action: 'untrash' }, crypto.randomUUID(), 0)
    database.localMail.completeDueOperations()
    server.failures.dropOnQuit = false
    expect((await pop3.sync(ACCOUNT)).removed).toBe(0)
    expect(database.pop3.row(ACCOUNT, 'u1')?.state).toBe('stored')
    expect(server.uidls()).toEqual(['u1', 'u2', 'u3'])
  })

  it('treats a message removed from the server by another client as removed', async () => {
    const { server, database, service: pop3 } = await setup({ retention: { leaveOnServer: false, removeWhenDeleted: false } })
    server.failures.dropOnQuit = true
    await pop3.sync(ACCOUNT)
    server.failures.dropOnQuit = false
    server.maildrop.splice(0, 3)
    await pop3.sync(ACCOUNT)
    expect(database.pop3.status(ACCOUNT)).toMatchObject({ pendingRemoval: 0, removedFromServer: 3 })
  })
})
