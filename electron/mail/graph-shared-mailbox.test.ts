import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MailDatabase, type ParsedMailMessage } from './database'
import { MailboxOwnerService } from './mailbox-owner-worker'
import type { StoredOwnerMessage } from './mailbox-owner-sync'
import { MicrosoftGraphClient } from './microsoft-client'
import { SenderIdentityError } from './sender-identity'

const ACCOUNT = 'microsoft-account'
const SHARED = 'sales@contoso.test'
const cleanup: (() => void)[] = []
afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step()
  vi.unstubAllGlobals()
})

type Route = { status?: number; body?: unknown; raw?: string }

/** A Microsoft Graph fake: routes by method and path (query ignored), recording every request. */
function graphFake() {
  const routes = new Map<string, Route | ((body: unknown) => Route)>()
  const requests: { method: string; path: string; body?: unknown }[] = []
  const fetchMock = vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input)
    const path = decodeURIComponent(url.pathname.replace('/v1.0', ''))
    const method = init.method ?? 'GET'
    const body = typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : init.body
    requests.push({ method, path, ...(body ? { body } : {}) })
    const route = routes.get(`${method} ${path}`)
    const value = typeof route === 'function' ? route(body) : route
    if (!value) return new Response(JSON.stringify({ error: { code: 'ErrorItemNotFound', message: 'Not found' } }), { status: 404 })
    if (value.raw !== undefined) return new Response(value.raw, { status: value.status ?? 200 })
    return new Response(value.body === undefined ? '' : JSON.stringify(value.body), { status: value.status ?? 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return { routes, requests }
}

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'aerio-graph-owners-'))
  const database = new MailDatabase(join(directory, 'aerio.sqlite'), join(directory, 'mail'))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }), () => database.close())
  database.upsertAccount({ id: ACCOUNT, provider: 'microsoft', email: 'ada@contoso.test', displayName: 'Ada', color: '#0f6cbd', status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true })
  const store = async (message: StoredOwnerMessage) => {
    const path = database.rawPath(ACCOUNT, message.id)
    writeFileSync(path, message.raw)
    const subject = /^Subject: (.*)$/m.exec(message.raw.toString())?.[1] ?? ''
    const record: ParsedMailMessage = {
      accountId: ACCOUNT, id: message.id, threadId: message.threadId, historyId: message.historyId, internalDate: message.internalDate ?? new Date().toISOString(),
      fromName: '', fromEmail: 'sender@example.test', to: [], cc: [], subject, references: [], snippet: '', text: '', html: '', labelIds: message.labelIds,
      sizeEstimate: message.raw.length, rawPath: path, attachments: [], remoteFolderId: message.remoteFolderId, remoteUid: message.remoteUid
    }
    const isNew = !database.hasMessage(ACCOUNT, message.id)
    database.upsertMessage(record)
    return { isNew }
  }
  const service = new MailboxOwnerService({
    database,
    exchangeClient: async () => { throw new Error('not used') },
    exchangeConfig: async () => { throw new Error('not used') },
    microsoftClient: (_accountId, mailbox) => new MicrosoftGraphClient(async () => 'token', mailbox ? { mailbox } : {}),
    store: (_accountId, message) => store(message),
    emit: () => undefined
  })
  const threads = (labelId?: string) => database.listThreads({ accountIds: [ACCOUNT], folder: 'all', ...(labelId ? { labelId } : {}), pageSize: 50 }).items
  return { database, service, threads }
}

function sharedMailbox(fake: ReturnType<typeof graphFake>) {
  const base = `/users/${SHARED}`
  fake.routes.set(`GET ${base}/mailFolders`, { body: { value: [{ id: 'inbox-id', displayName: 'Inbox', childFolderCount: 0 }, { id: 'deleted-id', displayName: 'Deleted Items', childFolderCount: 0 }] } })
  fake.routes.set(`GET ${base}/mailFolders/inbox`, { body: { id: 'inbox-id', displayName: 'Inbox' } })
  fake.routes.set(`GET ${base}/mailFolders/deleteditems`, { body: { id: 'deleted-id', displayName: 'Deleted Items' } })
  fake.routes.set(`GET ${base}/calendars`, { body: { value: [{ id: 'cal-1', name: 'Calendar', canEdit: false, isDefaultCalendar: true }] } })
  fake.routes.set(`GET ${base}/mailFolders/inbox-id/messages/delta`, { body: { value: [{ id: 'msg-1', conversationId: 'conv-1', isRead: false, importance: 'high' }], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta-inbox' } })
  fake.routes.set(`GET ${base}/mailFolders/deleted-id/messages/delta`, { body: { value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta-deleted' } })
  fake.routes.set('GET /delta-inbox', { body: { value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta-inbox' } })
  fake.routes.set('GET /delta-deleted', { body: { value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta-deleted' } })
  fake.routes.set(`GET ${base}/messages/msg-1/$value`, { raw: 'From: Customer <c@example.test>\r\nSubject: Quote request\r\n\r\nHello' })
}

describe('Microsoft Graph shared mailboxes', () => {
  it('reads a shared mailbox through /users/{address} and keeps its folders apart from the own mailbox', async () => {
    const fake = graphFake()
    sharedMailbox(fake)
    const { database, service, threads } = setup()
    const owner = await service.attach({ accountId: ACCOUNT, address: SHARED, displayName: 'Sales', kind: 'shared' })
    await service.sync(ACCOUNT, owner.id)
    const summary = service.list(ACCOUNT)[0]
    expect(summary).toMatchObject({ provider: 'microsoft', status: 'active', access: 'write' })
    expect(summary.folders.find((folder) => folder.kind === 'calendar')).toMatchObject({ name: 'Calendar', access: 'read' })
    const inbox = database.listLabels([ACCOUNT]).find((label) => label.owner && label.name === 'Inbox')!
    expect(threads(inbox.id)).toEqual([expect.objectContaining({ subject: 'Quote request', unread: true, important: true })])
    expect(threads(undefined).every((thread) => !thread.labelIds.includes('INBOX'))).toBe(true)
    expect(fake.requests.some((request) => request.path.startsWith('/me/mailFolders'))).toBe(false)

    // Incremental: the stored delta link is used next time.
    fake.routes.set('GET /delta-inbox', { body: { value: [{ id: 'msg-1', '@removed': { reason: 'deleted' } }], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta-inbox-2' } })
    await service.sync(ACCOUNT, owner.id)
    expect(threads(inbox.id)).toEqual([])
  })

  it('moves and flags shared messages, and turns a 403 on a change into a read-only folder', async () => {
    const fake = graphFake()
    sharedMailbox(fake)
    const { database, service, threads } = setup()
    const owner = await service.attach({ accountId: ACCOUNT, address: SHARED, kind: 'shared' })
    await service.sync(ACCOUNT, owner.id)
    const inbox = database.listLabels([ACCOUNT]).find((label) => label.owner && label.name === 'Inbox')!
    const thread = threads(inbox.id)[0]
    const run = async (action: 'trash' | 'star') => {
      const planned = service.planAction({ accountId: ACCOUNT, threadIds: [thread.id], action })
      const operation = database.applyLocalAction(planned.input, crypto.randomUUID(), 0)
      database.mailboxOwners.tagOperation(operation.id, planned.ownerId)
      return service.runOperation(database.dueOperations().find((row) => row.id === operation.id)!)
    }
    fake.routes.set(`POST /users/${SHARED}/messages/msg-1/move`, { body: { id: 'msg-1b' } })
    await expect(run('trash')).resolves.toEqual({ status: 'succeeded' })
    expect(fake.requests.find((request) => request.method === 'POST' && request.path.endsWith('/move'))?.body).toEqual({ destinationId: 'deleted-id' })

    fake.routes.set(`PATCH /users/${SHARED}/messages/msg-1`, { status: 403, body: { error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } } })
    const refused = await run('star')
    expect(refused).toMatchObject({ status: 'failed', error: expect.stringMatching(/Microsoft 365 refused the change: you have read-only access/) })
    expect(service.list(ACCOUNT)[0].folders.find((folder) => folder.name === 'Deleted Items')?.access).toBe('read')
    // The downgrade survives the next sync, which has no rights to read.
    await service.sync(ACCOUNT, owner.id)
    expect(service.list(ACCOUNT)[0].folders.find((folder) => folder.name === 'Deleted Items')?.access).toBe('read')
  })

  it('treats 403 or 404 for the mailbox as access removed and holds queued changes', async () => {
    const fake = graphFake()
    sharedMailbox(fake)
    const { database, service, threads } = setup()
    const owner = await service.attach({ accountId: ACCOUNT, address: SHARED, kind: 'shared' })
    await service.sync(ACCOUNT, owner.id)
    const thread = threads()[0]
    const planned = service.planAction({ accountId: ACCOUNT, threadIds: [thread.id], action: 'read' })
    const operation = database.applyLocalAction(planned.input, crypto.randomUUID(), 0)
    database.mailboxOwners.tagOperation(operation.id, planned.ownerId)
    fake.routes.set(`GET /users/${SHARED}/mailFolders`, { status: 403, body: { error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } } })
    await service.sync(ACCOUNT, owner.id)
    expect(service.list(ACCOUNT)[0]).toMatchObject({ status: 'access-removed', heldOperations: 1 })
    expect(threads()).toHaveLength(1)
    fake.routes.set(`GET /users/${SHARED}/mailFolders`, { status: 404, body: { error: { code: 'ErrorInvalidUser', message: 'The requested user is invalid.' } } })
    await expect(service.attach({ accountId: ACCOUNT, address: 'other@contoso.test', kind: 'shared' })).rejects.toThrow(/does not exist/)
    expect((await service.discover(ACCOUNT)).supported).toBe(false)
    expect((await service.delegates(ACCOUNT)).supported).toBe(false)
  })

  it('sends as a shared mailbox and on behalf of it with Graph from/sender, and deletes the staged copy when refused', async () => {
    const fake = graphFake()
    sharedMailbox(fake)
    const { database, service } = setup()
    const account = database.getAccount(ACCOUNT)!
    await service.attach({ accountId: ACCOUNT, address: SHARED, kind: 'shared', sendMode: 'send-as' })
    const identity = database.identities.list([account], [ACCOUNT]).find((item) => item.email === SHARED)!
    expect(identity.delegation).toBe('send-as')
    fake.routes.set('POST /me/messages', { status: 201, body: { id: 'staged-1', changeKey: 'ck' } })
    fake.routes.set('PATCH /me/messages/staged-1', { body: { id: 'staged-1' } })
    fake.routes.set('POST /me/messages/staged-1/send', { status: 202 })
    await service.sendDelegated(account, identity, Buffer.from('From: sales@contoso.test\r\nSubject: Offer\r\n\r\nHi'))
    expect(fake.requests.find((request) => request.method === 'PATCH')?.body).toEqual({ from: { emailAddress: { address: SHARED } } })

    fake.requests.length = 0
    await service.sendDelegated(account, { ...identity, delegation: 'send-on-behalf' }, Buffer.from('From: sales@contoso.test\r\nSubject: Offer\r\n\r\nHi'))
    expect(fake.requests.find((request) => request.method === 'PATCH')?.body).toEqual({ from: { emailAddress: { address: SHARED } }, sender: { emailAddress: { address: 'ada@contoso.test' } } })

    fake.requests.length = 0
    fake.routes.set('POST /me/messages/staged-1/send', { status: 403, body: { error: { code: 'ErrorSendAsDenied', message: 'The user account which was used to submit this request does not have the right to send mail on behalf of the specified sending account.' } } })
    fake.routes.set('DELETE /me/messages/staged-1', { status: 204 })
    const refused = service.sendDelegated(account, identity, Buffer.from('From: sales@contoso.test\r\nSubject: Offer\r\n\r\nHi'))
    await expect(refused).rejects.toBeInstanceOf(SenderIdentityError)
    await expect(refused).rejects.toThrow(/refused to send as sales@contoso.test.*kept as a draft/)
    expect(fake.requests.some((request) => request.method === 'DELETE' && request.path === '/me/messages/staged-1')).toBe(true)
  })
})
