import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MailProviderId } from '../../src/mail-types'
import type { MailArchivePolicyInput } from '../../src/mail-archive-types'
import { defaultMailArchivePolicy, mailArchiveCutoff, nextMailArchiveRun, validateMailArchivePolicy } from '../../src/lib/mail-archive'
import { LOCAL_FOLDERS_ACCOUNT_ID } from '../../src/lib/local-folders'
import { MailDatabase } from './database'
import { MailArchiveService, MAIL_ARCHIVE_DISK_RESERVE_BYTES } from './mail-archive'
import { removeArchivedMessages } from './mail-archive-removal'
import { mime, storeRawForTest } from './mail-import.fixtures'
import type { ImportedMessageInput } from './mail-import'

const DAY = 24 * 60 * 60_000
const T0 = new Date('2026-10-17T12:00:00.000Z')
const daysAgo = (days: number, from = T0) => new Date(from.getTime() - days * DAY).toISOString()

const directories: string[] = []
const open: MailDatabase[] = []
afterEach(() => {
  for (const database of open.splice(0)) try { database.close() } catch { /* Closed by the test. */ }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

interface Seed { id: string; threadId: string; received: string; labels?: string[]; attachment?: boolean; remoteFolderId?: string; remoteUid?: string }

function openDatabase(directory: string) {
  const database = new MailDatabase(join(directory, 'aerio.sqlite'), join(directory, 'mail'))
  open.push(database)
  return database
}

async function setup(provider: MailProviderId = 'gmail', seeds: Seed[] = []) {
  const directory = mkdtempSync(join(tmpdir(), 'aerio-archive-test-'))
  directories.push(directory)
  const database = openDatabase(directory)
  database.localMail.ensureAccount()
  const archive = database.localMail.createFolder({ accountId: LOCAL_FOLDERS_ACCOUNT_ID, name: 'Archive' }).label!
  database.upsertAccount({ id: 'acct', provider, email: 'person@example.test', displayName: 'Person', color: '#123456', status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true })
  database.replaceLabels('acct', [
    { accountId: 'acct', id: 'INBOX', name: 'INBOX', type: 'system' },
    { accountId: 'acct', id: 'Label_projects', name: 'Projects', type: 'user' },
    { accountId: 'acct', id: 'Label_keep', name: 'Keep', type: 'user' }
  ])
  await seed(database, seeds)
  return { directory, database, destination: archive.id }
}

async function seed(database: MailDatabase, seeds: Seed[]) {
  for (const item of seeds) {
    const raw = Buffer.from(mime({ subject: `Message ${item.id}`, messageId: `${item.id}`, ...(item.attachment ? { attachment: { name: 'report.txt', content: `Report for ${item.id}` } } : {}) }))
    await storeRawForTest(database, 'acct', { id: item.id, threadId: item.threadId, historyId: '1', raw, labelIds: item.labels ?? ['INBOX'], internalDate: item.received, sizeEstimate: raw.length })
    if (item.remoteFolderId) database.updateMessageLabels('acct', item.id, item.labels ?? ['INBOX'], '1', { remoteFolderId: item.remoteFolderId, remoteUid: item.remoteUid ?? '1' })
  }
}

function policy(destination: string, overrides: Partial<MailArchivePolicyInput> = {}): MailArchivePolicyInput {
  const base = defaultMailArchivePolicy('acct')
  return {
    ...base,
    enabled: true,
    olderThan: 30,
    unit: 'days',
    frequency: 'daily',
    destinationLabelId: destination,
    subfolders: { perAccount: false, perYear: false, mirrorSourcePath: false },
    ...overrides,
    exclude: { ...base.exclude, ...overrides.exclude }
  }
}

function service(database: MailDatabase, options: { now?: () => Date; freeBytes?: () => number; store?: (accountId: string, message: ImportedMessageInput) => Promise<unknown>; readRaw?: (path: string) => Buffer } = {}) {
  const store = vi.fn(options.store ?? ((accountId: string, message: ImportedMessageInput) => storeRawForTest(database, accountId, message)))
  const instance = new MailArchiveService({
    database,
    store,
    freeBytes: options.freeBytes ?? (() => 10 * 1024 ** 3),
    now: options.now ?? (() => T0),
    ...(options.readRaw ? { readRaw: options.readRaw } : {})
  })
  return { instance, store }
}

/** Waits for a run's copy phase to settle. */
async function settle(instance: MailArchiveService, jobId: string) {
  await instance.pump(jobId)
  await instance.pump(jobId)
}

/** Mirrors the worker's operation queue for archive removals, with fake provider clients. */
async function runProviderQueue(database: MailDatabase, clients: Parameters<typeof removeArchivedMessages>[0], fail?: string) {
  for (const row of database.dueOperations()) {
    const request = database.archive.removalFor(row)
    if (!request) throw new Error('Expected only message-level archive removals')
    if (fail) {
      database.restoreOperationSnapshot(String(row.id), 'failed', fail)
      continue
    }
    await removeArchivedMessages(clients, request)
    database.updateOperation(String(row.id), 'succeeded')
  }
}

const gmailClients = () => {
  const gmail = { trashMessages: vi.fn(async () => undefined), trashThreads: vi.fn() }
  return { gmail, clients: { provider: 'gmail' as const, gmail: () => gmail, microsoft: () => { throw new Error('unused') }, imap: async () => { throw new Error('unused') } } }
}

const localMessages = (database: MailDatabase) => database.storageStats(0).accounts.find((account) => account.accountId === LOCAL_FOLDERS_ACCOUNT_ID)?.messages ?? 0
const labelsOf = (database: MailDatabase, threadId: string, id: string) => database.remoteMessagesForThreads('acct', [threadId]).find((message) => message.id === id)!.labelIds

describe('archive policy helpers', () => {
  it('computes day and calendar-month cutoffs and next runs', () => {
    expect(mailArchiveCutoff({ olderThan: 10, unit: 'days' }, T0).toISOString()).toBe(daysAgo(10))
    expect(mailArchiveCutoff({ olderThan: 1, unit: 'months' }, new Date('2026-03-31T08:00:00Z')).toISOString()).toBe('2026-02-28T08:00:00.000Z')
    expect(nextMailArchiveRun(T0, 'weekly').toISOString()).toBe(new Date(T0.getTime() + 7 * DAY).toISOString())
    expect(nextMailArchiveRun(new Date('2026-01-31T00:00:00Z'), 'monthly').toISOString()).toBe('2026-02-28T00:00:00.000Z')
  })

  it('validates untrusted policies and refuses Gmail permanent deletion', () => {
    const valid = policy('folder:local-1')
    expect(validateMailArchivePolicy(valid, 'imap')).toEqual(valid)
    expect(() => validateMailArchivePolicy({ ...valid, olderThan: 0 })).toThrow(/between 1/)
    expect(() => validateMailArchivePolicy({ ...valid, scope: 'folders', folderIds: [] })).toThrow(/at least one folder/)
    expect(() => validateMailArchivePolicy({ ...valid, destinationLabelId: '' })).toThrow(/Local Folders folder/)
    expect(() => validateMailArchivePolicy({ ...valid, exclude: { ...valid.exclude, starred: 'yes' } })).toThrow(/starred/)
    expect(() => validateMailArchivePolicy({ ...valid, removal: 'delete' }, 'gmail')).toThrow(/Gmail permanent deletion/)
    expect(validateMailArchivePolicy({ ...valid, removal: 'delete' }, 'microsoft').removal).toBe('delete')
  })
})

describe('automatic archiving', () => {
  it('archives a message that crosses the cutoff later without any new mail arriving', async () => {
    const { database, destination } = await setup('gmail', [{ id: 'm1', threadId: 't1', received: daysAgo(20) }])
    let now = T0
    const { instance } = service(database, { now: () => now })
    instance.savePolicy(policy(destination))
    expect(database.archive.policy('acct')?.nextRunAt).toBe(T0.toISOString())

    instance.tick()
    const first = database.archive.jobs('acct')[0]
    await settle(instance, first.id)
    expect(database.archive.job(first.id)).toMatchObject({ status: 'completed', total: 0 })
    expect(database.archive.policy('acct')?.nextRunAt).toBe(new Date(T0.getTime() + DAY).toISOString())

    // Fifteen days later the same, unchanged message is 35 days old.
    now = new Date(T0.getTime() + 15 * DAY)
    instance.tick()
    const second = database.archive.jobs('acct')[0]
    expect(second.id).not.toBe(first.id)
    await settle(instance, second.id)
    expect(database.archive.job(second.id)).toMatchObject({ status: 'running', total: 1, removalQueued: 1 })

    const { gmail, clients } = gmailClients()
    await runProviderQueue(database, clients)
    instance.reconcile()
    expect(gmail.trashMessages).toHaveBeenCalledWith(['m1'])
    expect(gmail.trashThreads).not.toHaveBeenCalled()
    expect(database.archive.job(second.id)).toMatchObject({ status: 'completed', done: 1, failed: 0 })
    expect(database.archive.policy('acct')).toMatchObject({ lastRunStatus: 'completed', lastRunAt: now.toISOString() })
    expect(localMessages(database)).toBe(1)
  })

  it('catches up on a run that was due while Aerio was closed', async () => {
    const { database, destination, directory } = await setup('gmail', [{ id: 'm1', threadId: 't1', received: daysAgo(10) }])
    const first = service(database)
    first.instance.savePolicy(policy(destination, { frequency: 'weekly' }))
    const empty = first.instance.runNow('acct')
    await settle(first.instance, empty.id)
    expect(database.archive.job(empty.id)).toMatchObject({ status: 'completed', total: 0 })
    expect(database.archive.policy('acct')?.nextRunAt).toBe(new Date(T0.getTime() + 7 * DAY).toISOString())
    database.close()
    // Aerio stays closed for a month; the first scheduler pass after launch runs once.
    const reopened = openDatabase(directory)
    const later = new Date(T0.getTime() + 30 * DAY)
    const { instance } = service(reopened, { now: () => later })
    instance.tick()
    instance.tick()
    const jobs = reopened.archive.jobs('acct')
    expect(jobs).toHaveLength(2)
    expect(jobs[0]).toMatchObject({ trigger: 'schedule', total: 1 })
    expect(reopened.archive.policy('acct')?.nextRunAt).toBe(new Date(later.getTime() + 7 * DAY).toISOString())
  })

  it('moves only the old messages of a mixed-age conversation', async () => {
    const { database, destination } = await setup('gmail', [
      { id: 'old', threadId: 't1', received: daysAgo(400) },
      { id: 'new', threadId: 't1', received: daysAgo(5) }
    ])
    const { instance } = service(database)
    instance.savePolicy(policy(destination, { olderThan: 12, unit: 'months' }))
    const job = instance.runNow('acct')
    await settle(instance, job.id)
    const operation = database.dueOperations()[0]
    expect(JSON.parse(String(operation.message_ids_json))).toEqual(['old'])
    expect(labelsOf(database, 't1', 'old')).toContain('TRASH')
    expect(labelsOf(database, 't1', 'new')).not.toContain('TRASH')
    const thread = database.getThread('acct', 't1')
    expect(thread.messages.map((message) => message.id)).toEqual(['old', 'new'])
    const { gmail, clients } = gmailClients()
    await runProviderQueue(database, clients)
    instance.reconcile()
    expect(gmail.trashMessages).toHaveBeenCalledTimes(1)
    expect(gmail.trashMessages).toHaveBeenCalledWith(['old'])
  })

  it('applies folder scope, exclusions and subfolder placement in the preview and the run', async () => {
    const { database, destination } = await setup('gmail', [
      { id: 'eligible', threadId: 't1', received: '2024-05-01T10:00:00.000Z', labels: ['Label_projects'], attachment: true },
      { id: 'outside', threadId: 't2', received: daysAgo(400), labels: ['INBOX'] },
      { id: 'starred', threadId: 't3', received: daysAgo(400), labels: ['Label_projects', 'STARRED'] },
      { id: 'unread', threadId: 't4', received: daysAgo(400), labels: ['Label_projects', 'UNREAD'] },
      { id: 'pinned', threadId: 't5', received: daysAgo(400), labels: ['Label_projects'] },
      { id: 'kept-folder', threadId: 't6', received: daysAgo(400), labels: ['Label_projects', 'Label_keep'] },
      { id: 'draft', threadId: 't7', received: daysAgo(400), labels: ['Label_projects', 'DRAFT'] },
      { id: 'sent', threadId: 't8', received: daysAgo(400), labels: ['Label_projects', 'SENT'] },
      { id: 'trashed', threadId: 't9', received: daysAgo(400), labels: ['Label_projects', 'TRASH'] }
    ])
    database.pins.set('acct', ['t5'], true)
    const { instance } = service(database)
    const scoped = policy(destination, {
      scope: 'folders',
      folderIds: ['Label_projects'],
      olderThan: 6,
      unit: 'months',
      exclude: { starred: true, unread: true, pinned: true, drafts: true, sent: true, folderIds: ['Label_keep'] },
      subfolders: { perAccount: true, perYear: true, mirrorSourcePath: true }
    })
    const preview = instance.preview(scoped)
    expect(preview.count).toBe(1)
    expect(preview.sample[0]).toMatchObject({ messageId: 'eligible', folder: 'Projects', destination: 'Local Folders/Archive/person@example.test/2024/Projects' })
    expect(preview.excluded).toMatchObject({ starred: 1, unread: 1, pinned: 1, drafts: 1, sent: 1, folders: 1, notDownloaded: 0 })
    expect(preview.bytes).toBeGreaterThan(0)

    instance.savePolicy(scoped)
    const job = instance.runNow('acct')
    await settle(instance, job.id)
    expect(database.archive.job(job.id)).toMatchObject({ total: 1, removalQueued: 1 })
    const local = database.listLabels([LOCAL_FOLDERS_ACCOUNT_ID]).map((label) => label.name)
    expect(local).toEqual(expect.arrayContaining(['Archive/person@example.test/2024/Projects']))
    // The attachment survives in the copy.
    const copy = database.archive.items(job.id)[0]
    expect(database.archive.attachmentCount(LOCAL_FOLDERS_ACCOUNT_ID, copy.localMessageId!)).toBe(1)
  })

  it('skips a message that became excluded after the run was planned', async () => {
    const { database, destination } = await setup('gmail', [{ id: 'm1', threadId: 't1', received: daysAgo(90) }])
    const { instance } = service(database)
    instance.savePolicy(policy(destination))
    const plan = database.archive.select(policy(destination), T0)
    const job = database.archive.createJob({ accountId: 'acct', trigger: 'manual', policy: policy(destination), candidates: plan.eligible, cutoff: plan.cutoff })
    database.updateMessageLabels('acct', 'm1', ['INBOX', 'STARRED'], '2')
    await settle(instance, job.id)
    expect(database.archive.items(job.id)[0]).toMatchObject({ state: 'skipped', reason: 'The message was starred or flagged' })
    expect(database.dueOperations()).toHaveLength(0)
  })

  it('resumes an interrupted copy after restart without duplicating it', async () => {
    const { database, destination, directory } = await setup('gmail', [
      { id: 'm1', threadId: 't1', received: daysAgo(90) },
      { id: 'm2', threadId: 't2', received: daysAgo(80) }
    ])
    // The first copy is written, then Aerio "crashes" before recording it.
    let calls = 0
    const { instance } = service(database, {
      store: async (accountId, message) => {
        calls += 1
        await storeRawForTest(database, accountId, message)
        await new Promise(() => undefined)
      }
    })
    instance.savePolicy(policy(destination))
    const job = instance.runNow('acct')
    await vi.waitFor(() => expect(localMessages(database)).toBe(1))
    expect(calls).toBe(1)
    expect(database.archive.items(job.id).map((item) => item.state)).toEqual(['pending', 'pending'])
    instance.halt()
    database.close()

    const reopened = openDatabase(directory)
    const restarted = service(reopened)
    restarted.instance.tick()
    await settle(restarted.instance, job.id)
    expect(restarted.store).toHaveBeenCalledTimes(1)
    expect(restarted.store.mock.calls[0][1].id).not.toBe(undefined)
    expect(reopened.archive.job(job.id)).toMatchObject({ removalQueued: 2, pending: 0 })
    expect(localMessages(reopened)).toBe(2)
    expect(reopened.dueOperations()).toHaveLength(1)
  })

  it('queues copies verified before a crash exactly once', async () => {
    const { database, destination, directory } = await setup('gmail', [{ id: 'm1', threadId: 't1', received: daysAgo(90) }])
    const { instance } = service(database)
    instance.savePolicy(policy(destination))
    const plan = database.archive.select(policy(destination), T0)
    const job = database.archive.createJob({ accountId: 'acct', trigger: 'manual', policy: policy(destination), candidates: plan.eligible, cutoff: plan.cutoff })
    // Copied and verified, but the removal was never queued.
    database.archive.markCopied(job.id, 'm1', { sha256: 'x', destinationLabelId: destination, localMessageId: 'local-1' })
    database.close()
    const reopened = openDatabase(directory)
    const restarted = service(reopened)
    restarted.instance.tick()
    await settle(restarted.instance, job.id)
    restarted.instance.tick()
    await settle(restarted.instance, job.id)
    expect(reopened.dueOperations()).toHaveLength(1)
    expect(restarted.store).not.toHaveBeenCalled()
  })

  it('does not copy again when a failed server removal is retried by the next run', async () => {
    const { database, destination } = await setup('gmail', [{ id: 'm1', threadId: 't1', received: daysAgo(90), attachment: true }])
    const { instance, store } = service(database)
    instance.savePolicy(policy(destination))
    const first = instance.runNow('acct')
    await settle(instance, first.id)
    await runProviderQueue(database, gmailClients().clients, 'Gmail is unavailable')
    instance.reconcile()
    const failed = database.archive.items(first.id)[0]
    expect(failed.state).toBe('failed')
    expect(failed.reason).toMatch(/Gmail is unavailable\. The server copy was kept/)
    // The provider queue restored the server-side labels locally.
    expect(labelsOf(database, 't1', 'm1')).not.toContain('TRASH')
    expect(database.archive.job(first.id)).toMatchObject({ status: 'completed', failed: 1 })

    const second = instance.runNow('acct')
    await settle(instance, second.id)
    expect(store).toHaveBeenCalledTimes(1)
    expect(database.archive.job(second.id)).toMatchObject({ removalQueued: 1 })
    expect(localMessages(database)).toBe(1)
  })

  it('pauses on a full disk without removing server copies, then resumes', async () => {
    const { database, destination } = await setup('gmail', [
      { id: 'm1', threadId: 't1', received: daysAgo(90) },
      { id: 'm2', threadId: 't2', received: daysAgo(80) }
    ])
    let free = MAIL_ARCHIVE_DISK_RESERVE_BYTES
    const { instance } = service(database, { freeBytes: () => free })
    instance.savePolicy(policy(destination))
    const job = instance.runNow('acct')
    await settle(instance, job.id)
    expect(database.archive.job(job.id)).toMatchObject({ status: 'paused', pending: 2 })
    expect(database.archive.job(job.id)?.error).toMatch(/not enough free disk space.*no server copies were removed/)
    expect(database.archive.policy('acct')?.lastRunStatus).toBe('paused')
    expect(database.dueOperations()).toHaveLength(0)
    expect(labelsOf(database, 't1', 'm1')).not.toContain('TRASH')

    free = 10 * 1024 ** 3
    instance.resume(job.id)
    await settle(instance, job.id)
    expect(database.archive.job(job.id)).toMatchObject({ status: 'running', removalQueued: 2 })
  })

  it('treats an ENOSPC write failure as a pause and keeps the item pending', async () => {
    const { database, destination } = await setup('gmail', [{ id: 'm1', threadId: 't1', received: daysAgo(90) }])
    const { instance } = service(database, { store: async () => { throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }) } })
    instance.savePolicy(policy(destination))
    const job = instance.runNow('acct')
    await settle(instance, job.id)
    expect(database.archive.job(job.id)).toMatchObject({ status: 'paused', pending: 1, failed: 0 })
    expect(database.dueOperations()).toHaveLength(0)
  })

  it('fails an item whose copy does not verify and keeps the server copy', async () => {
    const { database, destination } = await setup('gmail', [{ id: 'm1', threadId: 't1', received: daysAgo(90) }])
    const { instance } = service(database, {
      readRaw: (path) => path.includes(LOCAL_FOLDERS_ACCOUNT_ID) ? readFileSync(path).subarray(1) : readFileSync(path)
    })
    instance.savePolicy(policy(destination))
    const job = instance.runNow('acct')
    await settle(instance, job.id)
    expect(database.archive.items(job.id)[0]).toMatchObject({ state: 'failed' })
    expect(database.archive.items(job.id)[0].reason).toMatch(/could not be verified \(size .*The server copy was kept/)
    expect(localMessages(database)).toBe(0)
    expect(database.dueOperations()).toHaveLength(0)
    expect(database.archive.job(job.id)).toMatchObject({ status: 'completed', failed: 1 })
  })

  it('cancels unqueued work while keeping server copies', async () => {
    const { database, destination } = await setup('gmail', [{ id: 'm1', threadId: 't1', received: daysAgo(90) }])
    const { instance } = service(database, { freeBytes: () => 0 })
    instance.savePolicy(policy(destination))
    const job = instance.runNow('acct')
    await settle(instance, job.id)
    expect(instance.cancel(job.id)).toMatchObject({ status: 'cancelled', skipped: 1 })
    expect(database.dueOperations()).toHaveLength(0)
  })

  it('removes the cached copy after a permanent deletion succeeds', async () => {
    const { database, destination } = await setup('imap', [{ id: 'm1', threadId: 't1', received: daysAgo(90), labels: ['folder:INBOX', 'INBOX'], remoteFolderId: 'INBOX', remoteUid: '42' }])
    const { instance } = service(database)
    instance.savePolicy(policy(destination, { removal: 'delete' }))
    const job = instance.runNow('acct')
    await settle(instance, job.id)
    const imap = { applyAction: vi.fn(async () => undefined), deleteMessages: vi.fn(async () => undefined) }
    await runProviderQueue(database, { provider: 'imap', gmail: () => { throw new Error('unused') }, microsoft: () => { throw new Error('unused') }, imap: async () => imap })
    instance.reconcile()
    expect(imap.deleteMessages).toHaveBeenCalledWith([{ folder: 'INBOX', uid: 42 }])
    expect(database.hasMessage('acct', 'm1')).toBe(false)
    expect(database.archive.job(job.id)).toMatchObject({ status: 'completed', done: 1 })
    expect(localMessages(database)).toBe(1)
  })

  it('refuses policies for Local Folders and missing destinations', async () => {
    const { database, destination } = await setup('gmail')
    const { instance } = service(database)
    expect(() => instance.savePolicy({ ...policy(destination), accountId: LOCAL_FOLDERS_ACCOUNT_ID })).toThrow(/already stored/)
    expect(() => instance.savePolicy(policy('folder:local-missing'))).toThrow(/no longer exists/)
    expect(() => instance.runNow('acct')).toThrow(/Save an archive policy/)
  })
})

describe('message-level server removal', () => {
  it('uses per-message provider operations', async () => {
    const graph = { applyAction: vi.fn(async () => undefined), permanentDeleteMessages: vi.fn(async () => undefined) }
    const microsoft = { provider: 'microsoft' as const, gmail: () => { throw new Error('unused') }, microsoft: () => graph, imap: async () => { throw new Error('unused') }, microsoftDeletedItems: 'deleted-id' }
    await removeArchivedMessages(microsoft, { accountId: 'a', mode: 'trash', messages: [{ id: 'g1' }, { id: 'g2' }] })
    expect(graph.applyAction).toHaveBeenCalledWith(['g1', 'g2'], 'trash', 'deleted-id')
    await removeArchivedMessages(microsoft, { accountId: 'a', mode: 'delete', messages: [{ id: 'g1' }] })
    expect(graph.permanentDeleteMessages).toHaveBeenCalledWith(['g1'])
    await expect(removeArchivedMessages({ ...microsoft, microsoftDeletedItems: undefined }, { accountId: 'a', mode: 'trash', messages: [{ id: 'g1' }] })).rejects.toThrow(/Deleted Items/)

    const imap = { applyAction: vi.fn(async () => undefined), deleteMessages: vi.fn(async () => undefined) }
    const imapClients = { provider: 'imap' as const, gmail: () => { throw new Error('unused') }, microsoft: () => { throw new Error('unused') }, imap: async () => imap }
    await removeArchivedMessages(imapClients, { accountId: 'a', mode: 'trash', messages: [{ id: 'x', remoteFolderId: 'Projects', remoteUid: '7' }, { id: 'y' }] })
    expect(imap.applyAction).toHaveBeenCalledWith([{ folder: 'Projects', uid: 7 }], 'trash')

    const { gmail, clients } = gmailClients()
    await removeArchivedMessages(clients, { accountId: 'a', mode: 'trash', messages: [{ id: 'm1' }] })
    expect(gmail.trashMessages).toHaveBeenCalledWith(['m1'])
    await expect(removeArchivedMessages(clients, { accountId: 'a', mode: 'delete', messages: [{ id: 'm1' }] })).rejects.toThrow(/Gmail permanent deletion/)
  })
})
