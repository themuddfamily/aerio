import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import PostalMime from 'postal-mime'
import { afterEach, describe, expect, it } from 'vitest'
import { MailDatabase, type ParsedMailMessage } from '../mail/database'
import { MailFolderManager } from '../mail/folder-management'
import { FolderNotEmptyError } from '../mail/folder-errors'
import { EwsClient } from './ews-client'
import { EwsFixtureServer } from './ews-fixture-server'
import { applyExchangeAction, exchangeMessageId, ExchangeFolderApi, saveExchangeDraft, syncExchangeMail, type ExchangeProviderState, type StoredMessageInput } from './ews-mail'
import { EwsAuthError } from './ews-transport'

const ACCOUNT = 'exchange-account'
const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step() })

async function setup(options: { pageSize?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'aerio-ews-mail-'))
  const server = await new EwsFixtureServer({ auth: 'ntlm' }).start()
  let database = new MailDatabase(join(directory, 'aerio.sqlite'), join(directory, 'mail'))
  const client = new EwsClient({ url: server.url, credentials: { auth: 'ntlm', username: 'CONTOSO\\ada', password: 'Pa55w0rd!' }, sleep: async () => undefined })
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }), () => server.stop(), () => client.close(), () => database.close())
  database.upsertAccount({ id: ACCOUNT, provider: 'exchange', email: 'ada@contoso.test', displayName: 'Ada', color: '#0f6cbd', status: 'connecting', archived: false, signature: '', notifications: true, syncEnabled: true })
  // The same parse-and-store contract as the mail worker.
  const store = async (message: StoredMessageInput) => {
    const isNew = !database.hasMessage(ACCOUNT, message.id)
    const path = database.rawPath(ACCOUNT, message.id)
    writeFileSync(path, message.raw)
    const parsed = await PostalMime.parse(message.raw)
    const record: ParsedMailMessage = {
      accountId: ACCOUNT, id: message.id, threadId: message.threadId, historyId: message.historyId, internalDate: message.internalDate ?? new Date().toISOString(),
      fromName: parsed.from?.name ?? '', fromEmail: parsed.from?.address ?? '', to: [], cc: [], subject: parsed.subject ?? '', messageIdHeader: parsed.messageId,
      references: [], snippet: '', text: parsed.text ?? '', html: '', labelIds: message.labelIds, sizeEstimate: message.raw.length, rawPath: path, attachments: [],
      remoteFolderId: message.remoteFolderId, remoteUid: message.remoteUid
    }
    database.upsertMessage(record)
    return { record, isNew }
  }
  const sync = (checkpoint?: () => Promise<void>) => syncExchangeMail({ accountId: ACCOUNT, database, client, store, pageSize: options.pageSize ?? 100, ...(checkpoint ? { checkpoint } : {}) })
    .then((result) => { database.setAccountHistory(ACCOUNT, `ews:${Date.now()}`, true); return result })
  const messages = () => database.listThreads({ accountIds: [ACCOUNT], folder: 'all', pageSize: 100 }).items
  const reopen = () => { database.close(); database = new MailDatabase(join(directory, 'aerio.sqlite'), join(directory, 'mail')); return database }
  return { server, client, sync, messages, get database() { return database }, reopen }
}

describe('Exchange mail synchronization', () => {
  it('maps the folder hierarchy and downloads raw MIME with read, flag, and folder labels', async () => {
    const { server, sync, database } = await setup()
    const projects = server.addFolder('Projects')
    const nested = server.addFolder('Aerio', 'IPF.Note', projects.id)
    server.addFolder('Calendar subfolder', 'IPF.Appointment')
    server.addMessage(server.folder('inbox').id, { subject: 'Unread and flagged', flagged: true, importance: 'High' })
    server.addMessage(nested.id, { subject: 'Filed', isRead: true })
    const result = await sync()
    expect(result.firstSync).toBe(true)
    const labels = database.listLabels([ACCOUNT])
    expect(labels.find((label) => label.name === 'Inbox')).toMatchObject({ type: 'system' })
    expect(labels.find((label) => label.name === 'Aerio')).toMatchObject({ type: 'user', parentId: `folder:${projects.id}` })
    expect(labels.some((label) => label.name === 'Calendar subfolder' || label.name === 'Calendar')).toBe(false)
    const inbox = database.listThreads({ accountIds: [ACCOUNT], folder: 'inbox', pageSize: 10 }).items
    expect(inbox).toEqual([expect.objectContaining({ subject: 'Unread and flagged', unread: true, starred: true })])
    expect(database.listThreads({ accountIds: [ACCOUNT], folder: 'all', labelId: `folder:${nested.id}`, pageSize: 10 }).items).toEqual([expect.objectContaining({ subject: 'Filed', unread: false })])
  })

  it('pages SyncFolderItems and saves a checkpoint after every page, so an interrupted first sync resumes', async () => {
    const context = await setup({ pageSize: 2 })
    const inbox = context.server.folder('inbox')
    for (let index = 0; index < 5; index++) context.server.addMessage(inbox.id, { subject: `Message ${index}` })
    const inboxPages = () => context.server.log.filter((entry) => entry.operation === 'SyncFolderItems' && entry.body.includes(inbox.id)).length
    // Stop (as if Aerio quit) when the second inbox page is about to be requested.
    await expect(context.sync(async () => { if (inboxPages() === 1) throw new Error('stopped') })).rejects.toThrow('stopped')
    const state = context.database.getProviderState<ExchangeProviderState>(ACCOUNT, { folders: {}, special: {} })
    expect(state.folders[inbox.id]?.syncState).toBeTruthy()
    const logBefore = context.server.log.length
    context.reopen()
    await context.sync()
    expect(context.messages().map((thread) => thread.subject).sort()).toEqual(['Message 0', 'Message 1', 'Message 2', 'Message 3', 'Message 4'])
    // The resumed run continued from the saved inbox state instead of listing the inbox from the start.
    const resumedInbox = context.server.log.slice(logBefore).filter((entry) => entry.operation === 'SyncFolderItems' && entry.body.includes(inbox.id))
    expect(resumedInbox[0].body).toContain('<m:SyncState>')
  })

  it('applies incremental creates, read-flag changes, moves, and deletes from other clients', async () => {
    const { server, sync, database, messages } = await setup()
    const inbox = server.folder('inbox')
    const first = server.addMessage(inbox.id, { subject: 'First' })
    const second = server.addMessage(inbox.id, { subject: 'Second' })
    await sync()
    server.addMessage(inbox.id, { subject: 'New arrival' })
    server.touch(first.id, (item) => { item.isRead = true }, true)
    const archive = server.addFolder('Archive 2026')
    server.moveItem(second.id, archive.id)
    const result = await sync()
    expect(result.newRecords.map((record) => (record as ParsedMailMessage).subject)).toEqual(expect.arrayContaining(['New arrival', 'Second']))
    expect(server.log.some((entry) => entry.operation === 'SyncFolderItems' && entry.body.includes('<m:SyncState>'))).toBe(true)
    expect(database.listThreads({ accountIds: [ACCOUNT], folder: 'inbox', pageSize: 10 }).items.find((thread) => thread.subject === 'First')).toMatchObject({ unread: false })
    expect(database.listThreads({ accountIds: [ACCOUNT], folder: 'all', labelId: `folder:${archive.id}`, pageSize: 10 }).items).toEqual([expect.objectContaining({ subject: 'Second' })])
    server.removeItem(first.id)
    await sync()
    expect(messages().map((thread) => thread.subject).sort()).toEqual(['New arrival', 'Second'])
  })

  it('starts a folder over when Exchange rejects the stored sync state and drops messages it no longer lists', async () => {
    const { server, sync, messages } = await setup()
    const inbox = server.folder('inbox')
    const stale = server.addMessage(inbox.id, { subject: 'Will vanish' })
    server.addMessage(inbox.id, { subject: 'Stays' })
    await sync()
    server.invalidateSyncStates()
    // Removed while the old state is unusable: only a full listing can notice.
    server.items.delete(stale.id)
    await sync()
    expect(messages().map((thread) => thread.subject)).toEqual(['Stays'])
  })

  it('surfaces an expired session as an authentication error the worker turns into a reauth prompt', async () => {
    const { server, sync } = await setup()
    await sync()
    server.expireSessions()
    const error = await sync().catch((value) => value)
    expect(error).toBeInstanceOf(EwsAuthError)
    expect(error.message).toMatch(/unauthori[sz]ed/i)
  })

  it('sends queued mail actions from the durable operation queue, including after a restart', async () => {
    const context = await setup()
    const inbox = context.server.folder('inbox')
    const item = context.server.addMessage(inbox.id, { subject: 'Act on me' })
    await context.sync()
    const thread = context.messages()[0]
    context.database.applyLocalAction({ accountId: ACCOUNT, threadIds: [thread.id], action: 'read' }, 'op-read', 0)
    context.database.applyLocalAction({ accountId: ACCOUNT, threadIds: [thread.id], action: 'star' }, 'op-star', 0)
    // Offline: nothing was sent, and the queue survives reopening the database.
    const database = context.reopen()
    expect(database.dueOperations().map((row) => String(row.id))).toEqual(['op-read', 'op-star'])
    for (const row of database.dueOperations()) {
      const remote = database.remoteMessagesForThreads(ACCOUNT, JSON.parse(String(row.thread_ids_json))).flatMap((message) => message.remoteUid ? [message.remoteUid] : [])
      await applyExchangeAction(context.client, {}, remote, String(row.kind) as 'read' | 'star')
      database.updateOperation(String(row.id), 'succeeded')
    }
    expect(context.server.items.get(item.id)).toMatchObject({ isRead: true, flagged: true })
    const state = database.getProviderState<ExchangeProviderState>(ACCOUNT, { folders: {}, special: {} })
    await applyExchangeAction(context.client, state.special, [item.id], 'trash')
    expect([...context.server.items.values()].find((value) => value.mime?.toString().includes('Act on me'))?.folderId).toBe(context.server.folder('deleteditems').id)
    await expect(applyExchangeAction(context.client, {}, ['anything'], 'archive')).rejects.toThrow(/no Archive folder/)
  })

  it('saves drafts as unsent items and replaces the previous server copy', async () => {
    const { server, client } = await setup()
    const mime = (subject: string) => Buffer.from(`From: ada@contoso.test\r\nTo: grace@contoso.test\r\nSubject: ${subject}\r\nMessage-ID: <${subject}@contoso.test>\r\n\r\nDraft\r\n`)
    const first = await saveExchangeDraft(client, mime('v1'))
    const second = await saveExchangeDraft(client, mime('v2'), first.id)
    expect(server.items.has(first.id)).toBe(false)
    expect(server.items.get(second.id)).toMatchObject({ isDraft: true, folderId: server.folder('drafts').id })
    expect(second.revision).toBeTruthy()
    expect(exchangeMessageId(second.id)).toMatch(/^ews-/)
  })

  it('creates, renames, and deletes folders through the folder manager', async () => {
    const { server, client, sync, database } = await setup()
    await sync()
    const manager = new MailFolderManager({
      database, online: () => true,
      gmail: () => { throw new Error('unused') }, microsoft: () => { throw new Error('unused') }, imap: async () => { throw new Error('unused') },
      exchange: async () => new ExchangeFolderApi(client)
    })
    const created = await manager.create({ accountId: ACCOUNT, name: 'Receipts' })
    expect(created.label).toMatchObject({ name: 'Receipts', type: 'user' })
    const renamed = await manager.update({ accountId: ACCOUNT, labelId: created.label!.id, name: 'Invoices' })
    expect(renamed.label?.name).toBe('Invoices')
    const folderId = created.label!.id.slice(7)
    server.addMessage(folderId, { subject: 'Invoice 1' })
    await sync()
    await expect(manager.delete({ accountId: ACCOUNT, labelId: created.label!.id })).rejects.toBeInstanceOf(FolderNotEmptyError)
    const deleted = await manager.delete({ accountId: ACCOUNT, labelId: created.label!.id, confirmNonEmpty: true })
    expect(deleted.deletedId).toBe(created.label!.id)
    expect(server.folders.get(folderId)?.parentId).toBe(server.folder('deleteditems').id)
    expect(manager.preview).toBeDefined()
  })
})
