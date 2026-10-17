import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import PostalMime from 'postal-mime'
import { afterEach, describe, expect, it } from 'vitest'
import type { MailWorkerEvent } from '../../src/mail-types'
import { ownerRootLabel, PUBLIC_FOLDERS_OWNER } from '../../src/mailbox-owner-types'
import { MailDatabase, type ParsedMailMessage } from '../mail/database'
import { MailboxOwnerService } from '../mail/mailbox-owner-worker'
import type { StoredOwnerMessage } from '../mail/mailbox-owner-sync'
import { SenderIdentityError } from '../mail/sender-identity'
import { EwsClient } from './ews-client'
import { EwsFixtureServer } from './ews-fixture-server'
import { syncExchangeMail } from './ews-mail'
import { sendExchangeDelegated, withSenderHeader } from './ews-shared-mailbox'

const ACCOUNT = 'exchange-account'
const SHARED = 'team@contoso.test'
const BOSS = 'grace@contoso.test'
const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step() })

const mime = (subject: string, from = 'Ada <ada@contoso.test>') => Buffer.from([`From: ${from}`, 'To: Bob <bob@example.test>', `Subject: ${subject}`, 'Message-ID: <m@contoso.test>', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', 'Hello', ''].join('\r\n'))

async function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'aerio-ews-owners-'))
  const server = await new EwsFixtureServer({ auth: 'basic', username: 'ada@contoso.test', password: 'Pa55w0rd!' }).start()
  const database = new MailDatabase(join(directory, 'aerio.sqlite'), join(directory, 'mail'))
  const client = new EwsClient({ url: server.url, credentials: { auth: 'basic', username: 'ada@contoso.test', password: 'Pa55w0rd!' }, sleep: async () => undefined })
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }), () => server.stop(), () => client.close(), () => database.close())
  database.upsertAccount({ id: ACCOUNT, provider: 'exchange', email: 'ada@contoso.test', displayName: 'Ada', color: '#0f6cbd', status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true })
  const store = async (message: StoredOwnerMessage) => {
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
  const events: MailWorkerEvent[] = []
  const service = new MailboxOwnerService({
    database,
    exchangeClient: async () => client,
    exchangeConfig: async () => ({ email: 'ada@contoso.test', username: 'ada@contoso.test', password: 'Pa55w0rd!', ewsUrl: server.url, auth: 'basic' }),
    microsoftClient: () => { throw new Error('not used') },
    store: (_accountId, message) => store(message),
    emit: (event) => events.push(event)
  })
  const primarySync = () => syncExchangeMail({ accountId: ACCOUNT, database, client, store }).then(() => database.setAccountHistory(ACCOUNT, `ews:${Date.now()}`, true))
  const threads = (labelId?: string, folder: 'all' | 'inbox' = 'all') => database.listThreads({ accountIds: [ACCOUNT], folder, ...(labelId ? { labelId } : {}), pageSize: 100 }).items
  const labelFor = (ownerId: string, name: string) => database.listLabels([ACCOUNT]).find((label) => label.owner?.id === ownerId && label.name === name)!
  /** Queues an action like the mail:action IPC does and runs it like the worker's queue. */
  const act = async (threadId: string, action: Parameters<MailboxOwnerService['planAction']>[0]['action'], labelId?: string, plan = true) => {
    const input = { accountId: ACCOUNT, threadIds: [threadId], action, ...(labelId ? { labelId } : {}) }
    const planned = plan ? service.planAction(input) : { input, ownerId: '' }
    const operation = database.applyLocalAction(planned.input, crypto.randomUUID(), 0)
    if (planned.ownerId) database.mailboxOwners.tagOperation(operation.id, planned.ownerId)
    const row = database.dueOperations().find((item) => item.id === operation.id)!
    database.updateOperation(operation.id, 'running')
    return { operation, outcome: await service.runOperation(row) }
  }
  return { server, client, database, service, events, primarySync, threads, labelFor, act }
}

describe('Exchange shared and delegated mailboxes', () => {
  it('attaches writable and read-only mailboxes with effective rights and keeps same-named folders apart', async () => {
    const { server, database, service, primarySync, threads, labelFor } = await setup()
    server.addMailbox(SHARED, { access: 'write', sendAs: true })
    server.addMailbox(BOSS, { access: 'read', sendOnBehalf: true })
    server.addMessage(server.folder('inbox').id, { subject: 'Own inbox mail' })
    server.addMessage(server.mailboxFolder(SHARED, 'inbox').id, { subject: 'Team inbox mail' })
    const projects = server.addFolder('Projects', 'IPF.Note', server.mailboxFolder(SHARED, 'msgfolderroot').id)
    server.addMessage(projects.id, { subject: 'Team project mail', isRead: true })
    server.addMessage(server.mailboxFolder(BOSS, 'inbox').id, { subject: 'Boss inbox mail' })
    await primarySync()

    const team = await service.attach({ accountId: ACCOUNT, address: SHARED, displayName: 'Team', kind: 'shared' })
    const boss = await service.attach({ accountId: ACCOUNT, address: BOSS, kind: 'delegated' })
    await service.sync(ACCOUNT)

    const [teamSummary, bossSummary] = [service.list(ACCOUNT).find((owner) => owner.id === team.id)!, service.list(ACCOUNT).find((owner) => owner.id === boss.id)!]
    expect(teamSummary).toMatchObject({ access: 'write', status: 'active', kind: 'shared' })
    expect(bossSummary).toMatchObject({ access: 'read', status: 'active', kind: 'delegated' })
    expect(bossSummary.folders.find((folder) => folder.distinguished === 'calendar')).toMatchObject({ kind: 'calendar', access: 'read' })

    // Three folders called Inbox: the account's own and one per mailbox, each with its own label id.
    const inboxes = database.listLabels([ACCOUNT]).filter((label) => label.name === 'Inbox')
    expect(inboxes).toHaveLength(3)
    expect(new Set(inboxes.map((label) => label.id)).size).toBe(3)
    expect(labelFor(team.id, 'Inbox').owner).toMatchObject({ address: SHARED, access: 'write' })
    expect(labelFor(boss.id, 'Inbox').owner).toMatchObject({ access: 'read' })
    expect(labelFor(team.id, 'Projects').parentId).toBe(ownerRootLabel(team.id))
    expect(database.listLabels([ACCOUNT]).find((label) => label.id === ownerRootLabel(team.id))).toMatchObject({ name: 'Team', owner: { root: true } })

    // The unified Inbox shows only the account's own mail; each owner folder shows its own.
    expect(threads(undefined, 'inbox').map((thread) => thread.subject)).toEqual(['Own inbox mail'])
    expect(threads(labelFor(team.id, 'Inbox').id).map((thread) => thread.subject)).toEqual(['Team inbox mail'])
    expect(threads(labelFor(boss.id, 'Inbox').id).map((thread) => thread.subject)).toEqual(['Boss inbox mail'])

    // Synchronizing the own mailbox again leaves the other owners' labels and messages alone.
    await primarySync()
    expect(database.listLabels([ACCOUNT]).filter((label) => label.name === 'Inbox')).toHaveLength(3)
    expect(threads().map((thread) => thread.subject).sort()).toEqual(['Boss inbox mail', 'Own inbox mail', 'Team inbox mail', 'Team project mail'])
  })

  it('refuses changes to read-only folders in the UI path and in the queued action, and maps Trash to the mailbox’s own folder', async () => {
    const { server, service, threads, labelFor, act } = await setup()
    server.addMailbox(SHARED, { access: 'write' })
    server.addMailbox(BOSS, { access: 'read' })
    const teamItem = server.addMessage(server.mailboxFolder(SHARED, 'inbox').id, { subject: 'Team mail' })
    server.addMessage(server.mailboxFolder(BOSS, 'inbox').id, { subject: 'Boss mail' })
    const team = await service.attach({ accountId: ACCOUNT, address: SHARED, kind: 'shared' })
    const boss = await service.attach({ accountId: ACCOUNT, address: BOSS, kind: 'delegated' })
    await service.sync(ACCOUNT)
    const bossThread = threads(labelFor(boss.id, 'Inbox').id)[0]
    const teamThread = threads(labelFor(team.id, 'Inbox').id)[0]

    expect(() => service.planAction({ accountId: ACCOUNT, threadIds: [bossThread.id], action: 'read' })).toThrow(/read-only access to Inbox/)
    // A rule or quick action that bypasses the UI check is refused by the worker and rolled back.
    const forced = await act(bossThread.id, 'star', undefined, false)
    expect(forced.outcome).toMatchObject({ status: 'failed', error: expect.stringMatching(/read-only/) })
    expect(threads(labelFor(boss.id, 'Inbox').id)[0].starred).toBe(false)
    expect(server.operations()).not.toContain('UpdateItem')

    const planned = service.planAction({ accountId: ACCOUNT, threadIds: [teamThread.id], action: 'trash' })
    expect(planned.input).toMatchObject({ action: 'move', labelId: labelFor(team.id, 'Deleted Items').id })
    const trashed = await act(teamThread.id, 'trash')
    expect(trashed.outcome).toEqual({ status: 'succeeded' })
    expect(server.items.has(teamItem.id)).toBe(false)
    expect([...server.items.values()].some((item) => item.folderId === server.mailboxFolder(SHARED, 'deleteditems').id)).toBe(true)
    // A shared message never lands in the account's own Trash view.
    expect(threads().find((thread) => thread.subject === 'Team mail')?.trashed).toBe(false)
    expect(() => service.planAction({ accountId: ACCOUNT, threadIds: [teamThread.id], action: 'move', labelId: 'INBOX' })).not.toThrow()
  })

  it('downgrades a folder to read-only when Exchange refuses a write after permissions changed', async () => {
    const { server, service, threads, labelFor, act } = await setup()
    server.addMailbox(SHARED, { access: 'write' })
    server.addMessage(server.mailboxFolder(SHARED, 'inbox').id, { subject: 'Team mail' })
    const team = await service.attach({ accountId: ACCOUNT, address: SHARED, kind: 'shared' })
    await service.sync(ACCOUNT)
    server.setMailboxAccess(SHARED, 'read')
    const thread = threads(labelFor(team.id, 'Inbox').id)[0]
    const result = await act(thread.id, 'read')
    expect(result.outcome).toMatchObject({ status: 'failed', error: expect.stringMatching(/refused the change: you have read-only access/) })
    expect(threads(labelFor(team.id, 'Inbox').id)[0].unread).toBe(true)
    expect(service.list(ACCOUNT)[0].folders.find((folder) => folder.distinguished === 'inbox')?.access).toBe('read')
    expect(() => service.planAction({ accountId: ACCOUNT, threadIds: [thread.id], action: 'unread' })).toThrow(/read-only/)
  })

  it('marks a revoked mailbox "access removed", holds its queued actions, and keeps the cache read-only until removed', async () => {
    const { server, database, service, threads, labelFor, act } = await setup()
    server.addMailbox(SHARED, { access: 'write' })
    server.addMessage(server.mailboxFolder(SHARED, 'inbox').id, { subject: 'Team mail' })
    const team = await service.attach({ accountId: ACCOUNT, address: SHARED, kind: 'shared' })
    await service.sync(ACCOUNT)
    const thread = threads(labelFor(team.id, 'Inbox').id)[0]

    // A queued change that meets the revocation is held, not retried or lost.
    const input = { accountId: ACCOUNT, threadIds: [thread.id], action: 'read' as const }
    const planned = service.planAction(input)
    const operation = database.applyLocalAction(planned.input, crypto.randomUUID(), 0)
    database.mailboxOwners.tagOperation(operation.id, planned.ownerId)
    server.setMailboxAccess(SHARED, 'none')
    const row = database.dueOperations().find((item) => item.id === operation.id)!
    database.updateOperation(operation.id, 'running')
    await expect(service.runOperation(row)).resolves.toMatchObject({ status: 'held' })

    const owner = service.list(ACCOUNT)[0]
    expect(owner).toMatchObject({ status: 'access-removed', access: 'none', heldOperations: 1, error: expect.stringMatching(/access to .* was removed/i) })
    expect(database.dueOperations().some((item) => item.id === operation.id)).toBe(false)
    expect(database.mailboxOwners.held(ACCOUNT)).toEqual([expect.objectContaining({ id: operation.id, kind: 'read', threadCount: 1 })])
    // Cached mail stays readable but every change is refused with an explanation.
    expect(threads(labelFor(team.id, 'Inbox').id).map((item) => item.subject)).toEqual(['Team mail'])
    expect(labelFor(team.id, 'Inbox').owner).toMatchObject({ status: 'access-removed', access: 'none' })
    expect(() => service.planAction(input)).toThrow(/Access to .* was removed/)
    // Background syncs skip the mailbox; retrying a held change needs access first.
    const before = server.log.length
    await service.syncAccount(ACCOUNT)
    expect(server.log.length).toBe(before)
    expect(() => service.resolveHeld(operation.id, 'retry')).toThrow(/still removed/)
    service.resolveHeld(operation.id, 'discard')
    expect(threads(labelFor(team.id, 'Inbox').id)[0].unread).toBe(true)

    service.remove(ACCOUNT, team.id)
    expect(threads()).toEqual([])
    expect(database.listLabels([ACCOUNT]).some((label) => label.owner)).toBe(false)
  })

  it('reports a deleted mailbox and keeps other owners and folders synchronizing (partial failures)', async () => {
    const { server, service, threads, labelFor } = await setup()
    server.addMailbox(SHARED, { access: 'write' })
    server.addMailbox(BOSS, { access: 'write' })
    const reports = server.addFolder('Reports', 'IPF.Note', server.mailboxFolder(SHARED, 'msgfolderroot').id)
    server.addMessage(reports.id, { subject: 'Quarterly report' })
    server.addMessage(server.mailboxFolder(SHARED, 'inbox').id, { subject: 'Team mail' })
    server.addMessage(server.mailboxFolder(BOSS, 'inbox').id, { subject: 'Boss mail' })
    const team = await service.attach({ accountId: ACCOUNT, address: SHARED, kind: 'shared' })
    const boss = await service.attach({ accountId: ACCOUNT, address: BOSS, kind: 'delegated' })
    await service.sync(ACCOUNT)
    server.setMailboxAccess(BOSS, 'missing')
    // The first folder listing of the shared mailbox is refused; the rest of it still synchronizes.
    server.failNext('SyncFolderItems', 'ErrorAccessDenied')
    await service.sync(ACCOUNT)

    const owners = service.list(ACCOUNT)
    expect(owners.find((owner) => owner.id === boss.id)).toMatchObject({ status: 'access-removed', error: expect.stringMatching(/no longer exists/) })
    const teamSummary = owners.find((owner) => owner.id === team.id)!
    expect(teamSummary.status).toBe('active')
    expect(teamSummary.error).toMatch(/Aerio has no access to: /)
    expect(teamSummary.folders.filter((folder) => folder.access === 'none')).toHaveLength(1)
    // The removed mailbox keeps its cached copy (read-only); the shared mailbox kept synchronizing.
    expect(threads().map((thread) => thread.subject).sort()).toEqual(['Boss mail', 'Quarterly report', 'Team mail'])
    expect(labelFor(boss.id, 'Inbox').owner).toMatchObject({ status: 'access-removed', access: 'none' })
    expect(labelFor(team.id, 'Reports')).toBeDefined()
    await expect(service.attach({ accountId: ACCOUNT, address: 'nobody@contoso.test', kind: 'shared' })).rejects.toThrow(/does not exist or the address is wrong/)
  })

  it('sends as a shared mailbox and on behalf of a delegator, and keeps the draft with an explanation when refused', async () => {
    const { server, database, service } = await setup()
    server.addMailbox(SHARED, { access: 'write', sendAs: true, sendOnBehalf: false })
    server.addMailbox(BOSS, { access: 'read', sendAs: false, sendOnBehalf: true })
    const account = database.getAccount(ACCOUNT)!
    await service.attach({ accountId: ACCOUNT, address: SHARED, displayName: 'Team', kind: 'shared', sendMode: 'send-as' })
    const boss = await service.attach({ accountId: ACCOUNT, address: BOSS, displayName: 'Grace', kind: 'delegated', sendMode: 'send-on-behalf' })
    const identities = database.identities.list([account], [ACCOUNT])
    const teamIdentity = identities.find((identity) => identity.email === SHARED)!
    const bossIdentity = identities.find((identity) => identity.email === BOSS)!
    expect(teamIdentity.delegation).toBe('send-as')
    expect(bossIdentity.delegation).toBe('send-on-behalf')

    await service.sendDelegated(account, teamIdentity, mime('As the team', `Team <${SHARED}>`))
    expect(server.sent.at(-1)).toMatchObject({ from: SHARED, savedFolderId: server.mailboxFolder(SHARED, 'sentitems').id })
    expect(server.sent.at(-1)!.sender).toBeFalsy()

    // On behalf: From is the delegator, Sender is Ada; Grace's Sent Items is read-only, so the copy stays in Ada's.
    await service.sendDelegated(account, bossIdentity, mime('For Grace', `Grace <${BOSS}>`))
    const onBehalf = server.sent.at(-1)!
    expect(onBehalf).toMatchObject({ from: BOSS, sender: 'ada@contoso.test', savedFolderId: server.folder('sentitems').id })
    expect(onBehalf.mime.toString()).toMatch(/^Sender: Ada <ada@contoso\.test>$/m)

    // Send on behalf of the team mailbox is not granted: a clear error, nothing sent.
    const count = server.sent.length
    const refused = service.sendDelegated(account, { ...teamIdentity, delegation: 'send-on-behalf' }, mime('Not allowed', `Team <${SHARED}>`))
    await expect(refused).rejects.toBeInstanceOf(SenderIdentityError)
    await expect(refused).rejects.toThrow(/Send on Behalf permission .* kept as a draft/)
    expect(server.sent.length).toBe(count)

    // Removing the mailbox removes its delegated From address.
    service.remove(ACCOUNT, boss.id)
    expect(database.identities.list([account], [ACCOUNT]).some((identity) => identity.email === BOSS)).toBe(false)
  })

  it('falls back to the delegate’s own Sent Items when the owner’s folder refuses the copy', async () => {
    const { server, client } = await setup()
    server.addMailbox(SHARED, { access: 'write', sendAs: true })
    server.mailboxFolder(SHARED, 'sentitems').canWrite = false
    await expect(sendExchangeDelegated(client, { mode: 'send-as', ownerAddress: SHARED, delegateAddress: 'ada@contoso.test', delegateSender: 'Ada <ada@contoso.test>', mime: mime('Copy', SHARED), saveToOwnerSentItems: true }))
      .resolves.toEqual({ savedTo: 'delegate' })
    expect(server.sent).toHaveLength(1)
    expect(withSenderHeader(Buffer.from('From: a@b.test\r\nSender: old\r\nSubject: x\r\n\r\nBody'), 'Ada <ada@contoso.test>').toString()).toBe('From: a@b.test\r\nSubject: x\r\nSender: Ada <ada@contoso.test>\r\n\r\nBody')
  })

  it('finds delegated and shared mailboxes with Autodiscover AlternativeMailbox entries', async () => {
    const { server, service } = await setup()
    server.addMailbox(SHARED, { access: 'write' })
    server.autodiscover.set(new URL(server.url).host, {
      alternativeMailboxes: [{ type: 'Delegate', displayName: 'Grace Hopper', smtpAddress: BOSS }, { type: 'TeamMailbox', displayName: 'Team', smtpAddress: SHARED }, { type: 'Archive', displayName: 'Archive', smtpAddress: 'archive@contoso.test' }],
      publicFolderMailbox: 'pf@contoso.test'
    })
    await service.attach({ accountId: ACCOUNT, address: SHARED, kind: 'shared' })
    const found = await service.discover(ACCOUNT)
    expect(found).toMatchObject({ supported: true, publicFolderMailbox: 'pf@contoso.test' })
    expect(found.mailboxes).toEqual([
      { address: BOSS, displayName: 'Grace Hopper', kind: 'delegated', attached: false },
      { address: SHARED, displayName: 'Team', kind: 'shared', attached: true }
    ])
  })
})

describe('Exchange public folders', () => {
  it('browses the public folder tree with routing headers, subscribes folders read-only or writable, and unsubscribes', async () => {
    const { server, database, service, threads, act } = await setup()
    server.autodiscover.set(new URL(server.url).host, { publicFolderMailbox: 'PFMailbox1@contoso.test' })
    server.enablePublicFolders('pfmailbox1@contoso.test')
    const news = server.addPublicFolder('Announcements')
    const projects = server.addPublicFolder('Projects', 'IPF.Note', undefined, true)
    const aerio = server.addPublicFolder('Aerio', 'IPF.Note', projects.id, true)
    const calendar = server.addPublicFolder('Holidays', 'IPF.Appointment')
    server.addMessage(news.id, { subject: 'Office closed Friday' })
    server.addMessage(aerio.id, { subject: 'Release plan' })
    server.addItem(calendar.id, 'calendar', { Subject: '<t:Subject>Holiday</t:Subject>' })

    const root = await service.browsePublicFolders(ACCOUNT)
    expect(root.map((node) => [node.name, node.kind, node.access, node.childCount])).toEqual([
      ['Announcements', 'mail', 'read', 0], ['Holidays', 'calendar', 'read', 0], ['Projects', 'mail', 'write', 1]
    ])
    const findFolder = server.log.filter((entry) => entry.operation === 'FindFolder').at(-1)!
    expect(findFolder.headers['x-publicfoldermailbox']).toBe('PFMailbox1@contoso.test')
    expect(findFolder.headers['x-anchormailbox']).toBe('PFMailbox1@contoso.test')
    expect((await service.browsePublicFolders(ACCOUNT, projects.id)).map((node) => node.name)).toEqual(['Aerio'])

    await service.subscribePublicFolder(ACCOUNT, news.id, true)
    await service.subscribePublicFolder(ACCOUNT, aerio.id, true)
    await service.subscribePublicFolder(ACCOUNT, calendar.id, true)
    await service.sync(ACCOUNT, PUBLIC_FOLDERS_OWNER)
    expect(server.operations()).toContain('FindItem')
    expect(server.operations()).not.toContain('SyncFolderItems')

    const labels = database.listLabels([ACCOUNT]).filter((label) => label.owner?.id === PUBLIC_FOLDERS_OWNER)
    expect(labels.map((label) => [label.name, label.owner!.access])).toEqual(expect.arrayContaining([['Public Folders', 'write'], ['Announcements', 'read'], ['Aerio', 'write']]))
    const newsLabel = labels.find((label) => label.name === 'Announcements')!
    const aerioLabel = labels.find((label) => label.name === 'Aerio')!
    const newsThread = threads(newsLabel.id)[0]
    expect(newsThread.subject).toBe('Office closed Friday')
    expect(() => service.planAction({ accountId: ACCOUNT, threadIds: [newsThread.id], action: 'read' })).toThrow(/read-only/)
    const flagged = await act(threads(aerioLabel.id)[0].id, 'star')
    expect(flagged.outcome).toEqual({ status: 'succeeded' })
    expect([...server.items.values()].find((item) => item.folderId === aerio.id)?.flagged).toBe(true)

    // The calendar folder is offered to Calendar read-only, with the public folder routing headers.
    expect(service.productivityFolders(ACCOUNT)).toEqual([{ ref: { id: calendar.id, distinguished: false }, name: 'Holidays (Public Folders)', kind: 'calendar', headers: { 'X-AnchorMailbox': 'PFMailbox1@contoso.test', 'X-PublicFolderMailbox': 'PFMailbox1@contoso.test' }, readOnly: true }])

    await service.subscribePublicFolder(ACCOUNT, news.id, false)
    expect(threads(newsLabel.id)).toEqual([])
    await service.subscribePublicFolder(ACCOUNT, aerio.id, false)
    await service.subscribePublicFolder(ACCOUNT, calendar.id, false)
    expect(service.list(ACCOUNT)).toEqual([])
    expect(threads()).toEqual([])
  })

  it('explains when public folder requests are not routed or no public folders exist', async () => {
    const { server, service } = await setup()
    await expect(service.browsePublicFolders(ACCOUNT)).rejects.toThrow(/no public folders/)
    server.enablePublicFolders('pf@contoso.test')
    // Without Autodiscover public folder information Aerio routes through the user's own mailbox, which this server refuses.
    await expect(service.browsePublicFolders(ACCOUNT)).rejects.toThrow(/no public folders, or none are available/)
  })
})

describe('Exchange delegate management', () => {
  it('reads, adds, updates, and removes delegates with folder permissions and meeting delivery', async () => {
    const { server, service } = await setup()
    expect(await service.delegates(ACCOUNT)).toMatchObject({ supported: true, delegates: [], deliverMeetingRequests: 'DelegatesAndSendInformationToMe' })
    const delegate = { address: 'bob@contoso.test', permissions: { calendar: 'Editor' as const, tasks: 'Reviewer' as const, inbox: 'None' as const, contacts: 'Author' as const, notes: 'None' as const }, receiveCopiesOfMeetingMessages: true, viewPrivateItems: false }
    const added = await service.saveDelegate({ accountId: ACCOUNT, mode: 'add', delegate, deliverMeetingRequests: 'DelegatesAndMe' })
    expect(added.delegates).toEqual([delegate])
    expect(added.deliverMeetingRequests).toBe('DelegatesAndMe')
    const addBody = server.log.find((entry) => entry.operation === 'AddDelegate')!.body
    expect(addBody).toContain('<t:CalendarFolderPermissionLevel>Editor</t:CalendarFolderPermissionLevel><t:TasksFolderPermissionLevel>Reviewer</t:TasksFolderPermissionLevel>')
    expect(addBody).toContain('<m:Mailbox><t:EmailAddress>ada@contoso.test</t:EmailAddress></m:Mailbox>')

    await expect(service.saveDelegate({ accountId: ACCOUNT, mode: 'add', delegate })).rejects.toThrow(/already a delegate/)
    const updated = await service.saveDelegate({ accountId: ACCOUNT, mode: 'update', delegate: { ...delegate, permissions: { ...delegate.permissions, inbox: 'Reviewer' }, viewPrivateItems: true } })
    expect(updated.delegates[0]).toMatchObject({ permissions: { inbox: 'Reviewer' }, viewPrivateItems: true })
    expect((await service.setMeetingDelivery(ACCOUNT, 'DelegatesOnly')).deliverMeetingRequests).toBe('DelegatesOnly')
    expect((await service.removeDelegate(ACCOUNT, 'bob@contoso.test')).delegates).toEqual([])
    await expect(service.removeDelegate(ACCOUNT, 'bob@contoso.test')).rejects.toThrow(/does not know that address as a delegate/)
  })
})
