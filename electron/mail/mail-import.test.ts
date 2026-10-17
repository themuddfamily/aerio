import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { MailImportJob, MailImportStartInput } from '../../src/mail-types'
import { LOCAL_FOLDERS_ACCOUNT_ID } from '../../src/lib/local-folders'
import { MailDatabase } from './database'
import { MailImportService, planMailImport, type MailImportDeps } from './mail-import'
import { ENRON_PST, mbox, mime, OUTLOOK_OST, PDF_OST, pstHeader, storeRawForTest } from './mail-import.fixtures'

const directories: string[] = []
const open: MailDatabase[] = []
afterEach(() => {
  for (const database of open.splice(0)) try { database.close() } catch { /* Already closed by the test. */ }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function temp(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

function setup(overrides: Partial<MailImportDeps> = {}) {
  const directory = temp('aerio-import-test-')
  const databasePath = join(directory, 'aerio.sqlite')
  const contentPath = join(directory, 'mail')
  let database = new MailDatabase(databasePath, contentPath)
  open.push(database)
  const events: MailImportJob[] = []
  const deps = (): MailImportDeps => ({
    database,
    store: (accountId, message) => storeRawForTest(database, accountId, message),
    freeBytes: () => 10 * 1024 * 1024 * 1024,
    emit: (job) => events.push(job),
    changed: () => undefined,
    ...overrides
  })
  let service = new MailImportService(deps())
  const run = async (input: Partial<MailImportStartInput> & { paths: string[] }) => {
    const job = service.start({ duplicates: 'review', mboxVariant: 'mboxrd', ...input })
    await service.pump()
    return database.localMail.getJob(job.id)!
  }
  const reopen = () => {
    database.close()
    database = new MailDatabase(databasePath, contentPath)
    open.push(database)
    service = new MailImportService(deps())
    return database
  }
  const folder = (name: string) => database.listLabels([LOCAL_FOLDERS_ACCOUNT_ID]).find((label) => label.name === name)
  const messagesIn = (name: string) => {
    const label = folder(name)
    if (!label) return []
    return database.listThreads({ accountIds: [LOCAL_FOLDERS_ACCOUNT_ID], folder: 'all', labelId: label.id, pageSize: 100 }).items
  }
  const messageCount = () => database.storageStats(0).accounts.find((item) => item.accountId === LOCAL_FOLDERS_ACCOUNT_ID)?.messages ?? 0
  return { directory, databasePath, events, run, reopen, folder, messagesIn, messageCount, get database() { return database }, get service() { return service } }
}

describe('planMailImport', () => {
  it('keeps Thunderbird, Apple Mail, Outlook and EML directory hierarchies and reports unsupported files', () => {
    const root = join(temp('aerio-plan-test-'), 'Archive')
    mkdirSync(join(root, 'Inbox.sbd'), { recursive: true })
    mkdirSync(join(root, 'Saved', 'Deep'), { recursive: true })
    mkdirSync(join(root, 'Exported.mbox'), { recursive: true })
    writeFileSync(join(root, 'Inbox'), mbox([mime({ subject: 'In' })]))
    writeFileSync(join(root, 'Inbox.msf'), '// index')
    writeFileSync(join(root, 'Inbox.sbd', 'Projects'), mbox([mime({ subject: 'Project' })]))
    writeFileSync(join(root, 'Saved', 'one.eml'), mime({ subject: 'One' }))
    writeFileSync(join(root, 'Saved', 'Deep', 'two.eml'), mime({ subject: 'Two' }))
    writeFileSync(join(root, 'Saved', 'notes.txt'), 'not mail')
    writeFileSync(join(root, 'Exported.mbox', 'mbox'), mbox([mime({ subject: 'Apple' })]))
    writeFileSync(join(root, 'Exported.mbox', 'table_of_contents'), 'binary')
    writeFileSync(join(root, 'Old.pst'), pstHeader())
    writeFileSync(join(root, 'Saved', 'Cache.OST'), pstHeader({ version: 36 }))
    writeFileSync(join(root, 'Saved', 'note.msg'), 'MSG')

    const plan = planMailImport([root])
    expect(plan.entries.map((entry) => [entry.kind, entry.folder.join('/')])).toEqual([
      ['mbox', 'Archive/Exported'],
      ['mbox', 'Archive/Inbox'],
      ['mbox', 'Archive/Inbox/Projects'],
      ['pst', 'Archive/Old'],
      ['pst', 'Archive/Saved/Cache'],
      ['eml', 'Archive/Saved/Deep'],
      ['eml', 'Archive/Saved']
    ])
    expect(plan.unsupported).toEqual([{ path: join(root, 'Saved', 'note.msg'), reason: expect.stringMatching(/\.msg files cannot be imported yet/) }])

    // An explicitly chosen file without an extension is recognised by its PST signature.
    const bare = join(root, 'outlook-backup')
    writeFileSync(bare, pstHeader())
    expect(planMailImport([bare]).entries).toEqual([{ kind: 'pst', path: bare, folder: ['outlook-backup'], size: 564 }])
  })

  it('names loose files after the file and caps the number of sources', () => {
    const directory = temp('aerio-plan-test-')
    writeFileSync(join(directory, 'Work.mbox'), mbox([mime({ subject: 'A' })]))
    writeFileSync(join(directory, 'note.eml'), mime({ subject: 'B' }))
    const plan = planMailImport([join(directory, 'Work.mbox'), join(directory, 'note.eml')])
    expect(plan.entries.map((entry) => entry.folder)).toEqual([['Work'], ['Imported messages']])
    expect(() => planMailImport([directory], { maxMessageBytes: 1, maxEntries: 1, maxDepth: 5, minFreeBytes: 0 })).toThrow(/at most 1 files/)
  })
})

describe('MailImportService', () => {
  it('imports MBOX and EML into Local Folders with hierarchy, dates, flags, MIME and attachments', async () => {
    const context = setup()
    const root = join(context.directory, 'Takeout')
    mkdirSync(join(root, 'Inbox.sbd'), { recursive: true })
    mkdirSync(join(root, 'Saved'), { recursive: true })
    const inboxMessages = [
      mime({ subject: 'Read report', status: 'RO', attachment: { name: 'report.pdf', content: '%PDF-1.4 fixture' } }),
      mime({ subject: 'Unread note', status: 'O', body: 'From now on\n>From the archive' }),
      mime({ subject: 'Flagged item', xStatus: 'F', status: 'RO' }),
      mime({ subject: 'Thunderbird deleted', mozilla: '0009' }),
      mime({ subject: 'No date', date: '' })
    ]
    writeFileSync(join(root, 'Inbox'), mbox(inboxMessages))
    writeFileSync(join(root, 'Inbox.sbd', 'Projects'), mbox([mime({ subject: 'Thunderbird starred', mozilla: '0005' })]))
    writeFileSync(join(root, 'Saved', 'kept.eml'), mime({ subject: 'Saved message' }))

    const job = await context.run({ paths: [root] })

    expect(job).toMatchObject({ status: 'completed', imported: 6, skipped: 1, failed: 0, duplicates: 0, processedBytes: job.totalBytes })
    expect(context.database.getAccount(LOCAL_FOLDERS_ACCOUNT_ID)).toMatchObject({ provider: 'local', email: 'Local Folders' })
    const names = context.database.listLabels([LOCAL_FOLDERS_ACCOUNT_ID]).map((label) => label.name).sort()
    expect(names).toEqual(['Takeout', 'Takeout/Inbox', 'Takeout/Inbox/Projects', 'Takeout/Saved'])
    const projects = context.folder('Takeout/Inbox/Projects')!
    expect(projects.parentId).toBe(context.folder('Takeout/Inbox')!.id)

    const inbox = context.messagesIn('Takeout/Inbox')
    const bySubject = Object.fromEntries(inbox.map((item) => [item.subject, item]))
    expect(Object.keys(bySubject).sort()).toEqual(['Flagged item', 'No date', 'Read report', 'Unread note'])
    expect(bySubject['Read report']).toMatchObject({ unread: false, hasAttachments: true })
    expect(bySubject['Unread note'].unread).toBe(true)
    expect(bySubject['Flagged item'].starred).toBe(true)
    expect(bySubject['Read report'].lastDate).toBe('2025-10-16T09:30:00.000Z')
    // Without a Date header the mbox envelope date is used.
    expect(bySubject['No date'].lastDate).toBe(new Date('Thu Oct 14 08:00:00 2025').toISOString())
    expect(context.messagesIn('Takeout/Inbox/Projects')[0]).toMatchObject({ subject: 'Thunderbird starred', starred: true, unread: false })
    expect(context.messagesIn('Takeout/Saved')[0]).toMatchObject({ subject: 'Saved message', unread: false })

    // The original MIME source is stored unchanged (after mbox unquoting).
    const thread = context.database.getThread(LOCAL_FOLDERS_ACCOUNT_ID, bySubject['Unread note'].id)
    const raw = readFileSync(context.database.getMessageRaw(LOCAL_FOLDERS_ACCOUNT_ID, thread.messages[0].id)!, 'utf8')
    expect(raw).toBe(inboxMessages[1])
    const report = context.database.getThread(LOCAL_FOLDERS_ACCOUNT_ID, bySubject['Read report'].id).messages[0]
    expect(report.attachments).toEqual([expect.objectContaining({ filename: 'report.pdf', mimeType: 'application/octet-stream' })])
    expect(context.events.at(-1)).toMatchObject({ id: job.id, status: 'completed' })
  })

  it('holds Message-ID and identical-content duplicates for review', async () => {
    const context = setup()
    const path = join(context.directory, 'Mail.mbox')
    writeFileSync(path, mbox([mime({ subject: 'Alpha' }), mime({ subject: 'Beta' })]))
    const first = await context.run({ paths: [path] })
    expect(first.imported).toBe(2)

    const editedPath = join(context.directory, 'Again.mbox')
    writeFileSync(editedPath, mbox([mime({ subject: 'Alpha' }), mime({ subject: 'Beta', body: 'Edited copy' }), mime({ subject: 'Gamma' })]))
    const second = await context.run({ paths: [editedPath] })
    expect(second).toMatchObject({ status: 'completed', imported: 1, duplicates: 2, pendingReview: 2 })
    const items = context.service.items(second.id)
    expect(items.map((item) => [item.subject, item.status, item.reason, item.duplicateOf?.subject])).toEqual([
      ['Alpha', 'duplicate', 'An identical copy is already in Local Folders', 'Alpha'],
      ['Beta', 'duplicate', 'A message with the same Message-ID but different content is already in Local Folders', 'Beta']
    ])

    const afterImport = await context.service.resolve(second.id, [items[1].key], 'import')
    expect(afterImport).toMatchObject({ imported: 2, pendingReview: 1 })
    expect(context.messagesIn('Again').map((item) => item.subject).sort()).toEqual(['Beta', 'Gamma'])
    const afterDiscard = await context.service.resolve(second.id, [items[0].key], 'discard')
    expect(afterDiscard.pendingReview).toBe(0)
    expect(context.service.items(second.id).map((item) => [item.subject, item.status])).toEqual([['Alpha', 'discarded'], ['Beta', 'imported']])

    const forced = await context.run({ paths: [path], duplicates: 'import' })
    expect(forced).toMatchObject({ imported: 2, duplicates: 0 })
    expect(context.messageCount()).toBe(6)
  })

  it('refuses to import a held duplicate whose source file changed', async () => {
    const context = setup()
    const path = join(context.directory, 'Mail.mbox')
    writeFileSync(path, mbox([mime({ subject: 'Alpha' })]))
    await context.run({ paths: [path] })
    const second = await context.run({ paths: [path] })
    const [item] = context.service.items(second.id)
    writeFileSync(path, mbox([mime({ subject: 'Alpha', body: 'Rewritten' })]))
    await context.service.resolve(second.id, [item.key], 'import')
    expect(context.service.items(second.id)[0]).toMatchObject({ status: 'failed', reason: 'The source file changed since it was imported' })
  })

  it('pauses, resumes and cancels without losing or repeating messages', async () => {
    let stored = 0
    let pauseAfter = 2
    let jobId = ''
    const context = setup({
      store: async (accountId, message) => {
        await storeRawForTest(context.database, accountId, message)
        stored += 1
        if (stored === pauseAfter) context.service.pause(jobId)
      }
    })
    const path = join(context.directory, 'Big.mbox')
    writeFileSync(path, mbox(Array.from({ length: 6 }, (_, index) => mime({ subject: `Message ${index}` }))))
    const job = context.service.start({ paths: [path], duplicates: 'review', mboxVariant: 'mboxrd' })
    jobId = job.id
    await context.service.pump()
    const paused = context.database.localMail.getJob(job.id)!
    expect(paused).toMatchObject({ status: 'paused', imported: 2 })
    expect(paused.processedBytes).toBeGreaterThan(0)
    expect(paused.processedBytes).toBeLessThan(paused.totalBytes)

    pauseAfter = 4
    context.service.resume(job.id)
    await context.service.pump()
    expect(context.database.localMail.getJob(job.id)).toMatchObject({ status: 'paused', imported: 4 })

    context.service.cancel(job.id)
    expect(context.database.localMail.getJob(job.id)?.status).toBe('cancelled')
    expect(context.messageCount()).toBe(4)
    expect(context.service.resume(job.id).status).toBe('cancelled')
    context.service.dismiss(job.id)
    expect(context.service.list()).toEqual([])
  })

  it('recovers an import interrupted by a restart and replays the uncommitted message safely', async () => {
    let stored = 0
    let jobId = ''
    const context = setup({
      store: async (accountId, message) => {
        await storeRawForTest(context.database, accountId, message)
        stored += 1
        if (stored === 3) context.service.pause(jobId)
      }
    })
    const path = join(context.directory, 'Archive.mbox')
    writeFileSync(path, mbox(Array.from({ length: 5 }, (_, index) => mime({ subject: `Item ${index}`, attachment: index === 2 ? { name: 'a.txt', content: 'attachment' } : undefined }))))
    jobId = context.service.start({ paths: [path], duplicates: 'review', mboxVariant: 'mboxrd' }).id
    await context.service.pump()
    expect(context.messageCount()).toBe(3)

    // Simulate a crash in the window after a message was stored but before
    // the cursor moved: the job is left "running" with an older cursor.
    const raw = new DatabaseSync(context.databasePath)
    raw.prepare(`UPDATE mail_import_jobs SET status='running',cursor_json=?,imported=0 WHERE id=?`).run(JSON.stringify({ entry: 0, offset: 0 }), jobId)
    raw.close()
    const reopened = context.reopen()
    expect(reopened.localMail.getJob(jobId)).toMatchObject({ status: 'interrupted', error: expect.stringMatching(/Resume to continue/) })

    context.service.resume(jobId)
    await context.service.pump()
    expect(reopened.localMail.getJob(jobId)).toMatchObject({ status: 'completed', imported: 5, duplicates: 0 })
    expect(context.messageCount()).toBe(5)
  })

  it('retries a message whose failure was recorded just before a crash instead of counting it as a duplicate', async () => {
    let failOnce = true
    const context = setup({
      store: async (accountId, message) => {
        if (failOnce && message.raw.includes('Subject: Item 1')) {
          failOnce = false
          throw new Error('Disk hiccup')
        }
        await storeRawForTest(context.database, accountId, message)
      }
    })
    const path = join(context.directory, 'Retry.mbox')
    writeFileSync(path, mbox([0, 1, 2].map((index) => mime({ subject: `Item ${index}` }))))
    const first = await context.run({ paths: [path] })
    expect(first).toMatchObject({ imported: 2, failed: 1 })

    const raw = new DatabaseSync(context.databasePath)
    raw.prepare(`UPDATE mail_import_jobs SET status='running',cursor_json=?,imported=0,failed=0 WHERE id=?`).run(JSON.stringify({ entry: 0, offset: 0 }), first.id)
    raw.close()
    context.reopen()
    context.service.resume(first.id)
    await context.service.pump()
    expect(context.database.localMail.getJob(first.id)).toMatchObject({ status: 'completed', imported: 3, failed: 0, duplicates: 0 })
    expect(context.service.items(first.id)).toEqual([expect.objectContaining({ subject: 'Item 1', status: 'imported', reason: 'Imported when the import resumed' })])
  })

  it('reports oversized and unreadable sources and pauses when the disk is nearly full', async () => {
    const context = setup({ limits: { maxMessageBytes: 400 } })
    const path = join(context.directory, 'Mixed.mbox')
    writeFileSync(path, mbox([mime({ subject: 'Small' }), mime({ subject: 'Huge', body: 'x'.repeat(2_000) })]))
    const broken = join(context.directory, 'broken.mbox')
    writeFileSync(broken, 'Subject: not an mbox\n\nbody\n')
    const job = await context.run({ paths: [path, broken] })
    expect(job).toMatchObject({ status: 'completed', imported: 1, failed: 2 })
    expect(context.service.items(job.id).map((item) => item.reason)).toEqual([
      'The message is larger than the 1 KB import limit',
      expect.stringMatching(/not an mbox mailbox/)
    ])

    const full = setup({ freeBytes: () => 1024 })
    const fullPath = join(full.directory, 'Mail.mbox')
    writeFileSync(fullPath, mbox([mime({ subject: 'Waiting' })]))
    expect(await full.run({ paths: [fullPath] })).toMatchObject({ status: 'paused', imported: 0, error: expect.stringMatching(/disk space/) })
  })

  it('reads mboxo files and imports into a chosen parent folder', async () => {
    const context = setup()
    context.database.localMail.ensureAccount()
    const parent = context.database.localMail.createFolder({ accountId: LOCAL_FOLDERS_ACCOUNT_ID, name: 'Old mail' }).label!
    const path = join(context.directory, 'Legacy.mbox')
    // mboxo only quotes "From " itself, so a deeper ">>From " line is left alone.
    writeFileSync(path, mbox([mime({ subject: 'Quoted', body: 'From here\n>>From there' })], 'mboxo'))
    await context.run({ paths: [path], mboxVariant: 'mboxo', parentLabelId: parent.id })
    const [item] = context.messagesIn('Old mail/Legacy')
    const message = context.database.getThread(LOCAL_FOLDERS_ACCOUNT_ID, item.id).messages[0]
    expect(readFileSync(context.database.getMessageRaw(LOCAL_FOLDERS_ACCOUNT_ID, message.id)!, 'utf8')).toContain('\nFrom here\n>>From there\n')
  })

  it('controls queued jobs and reports sources that disappear before they are read', async () => {
    const context = setup({ limits: { maxMessageBytes: 300 } })
    const first = join(context.directory, 'First.mbox')
    const second = join(context.directory, 'Second.mbox')
    const vanishing = join(context.directory, 'gone.eml')
    const big = join(context.directory, 'big.eml')
    writeFileSync(first, mbox([mime({ subject: 'One' })]))
    writeFileSync(second, mbox([mime({ subject: 'Two' })]))
    writeFileSync(vanishing, mime({ subject: 'Gone' }))
    writeFileSync(big, mime({ subject: 'Big', body: 'y'.repeat(1_000) }))
    const running = context.service.start({ paths: [first], duplicates: 'review', mboxVariant: 'mboxrd' })
    const queued = context.service.start({ paths: [second], duplicates: 'review', mboxVariant: 'mboxrd' })
    expect(context.service.pause(queued.id).status).toBe('paused')
    expect(() => context.service.dismiss(running.id)).toThrow('Pause or cancel')
    expect(context.service.cancel(queued.id).status).toBe('cancelled')
    expect(context.service.cancel(queued.id).status).toBe('cancelled')
    expect(context.service.pause(queued.id).status).toBe('cancelled')
    await context.service.pump()
    expect(context.service.resume(running.id).status).toBe('completed')

    const job = context.service.start({ paths: [vanishing, big], duplicates: 'review', mboxVariant: 'mboxrd' })
    rmSync(vanishing)
    await context.service.pump()
    expect(context.service.items(job.id).map((item) => item.reason)).toEqual(['The file is no longer available', 'The message is larger than the 1 KB import limit'])
    expect(() => context.service.items('missing')).toThrow('no longer exists')
    expect(() => context.service.start({ paths: [first], duplicates: 'review', mboxVariant: 'mboxrd', parentLabelId: 'folder:nope' })).toThrow('destination folder no longer exists')
    const empty = join(context.directory, 'empty')
    mkdirSync(empty)
    expect(() => context.service.start({ paths: [empty], duplicates: 'review', mboxVariant: 'mboxrd' })).toThrow('No MBOX, EML or Outlook data files')
  })

  it('fails a held duplicate whose destination folder was deleted', async () => {
    const context = setup()
    const path = join(context.directory, 'Mail.mbox')
    writeFileSync(path, mbox([mime({ subject: 'Alpha' })]))
    await context.run({ paths: [path] })
    const parent = context.database.localMail.createFolder({ accountId: LOCAL_FOLDERS_ACCOUNT_ID, name: 'Elsewhere' }).label!
    const second = await context.run({ paths: [path], parentLabelId: parent.id })
    const folder = context.folder('Elsewhere/Mail')!
    context.database.localMail.deleteFolder({ accountId: LOCAL_FOLDERS_ACCOUNT_ID, labelId: folder.id })
    await context.service.resolve(second.id, context.service.items(second.id).map((item) => item.key), 'import')
    expect(context.service.items(second.id)[0]).toMatchObject({ status: 'failed', reason: 'The destination folder no longer exists' })
  })

})

// These run against the real sample PST/OST files shipped with pst-extractor.
describe('MailImportService with Outlook data files', () => {
  it('imports PST and OST folders with read state, dates, bodies and attachments', async () => {
    const context = setup()
    const job = await context.run({ paths: [ENRON_PST, PDF_OST] })
    // The OST's calendar, contact and task items are not mail and are skipped.
    expect(job).toMatchObject({ status: 'completed', imported: 73, failed: 0, duplicates: 0, skipped: 160, processedBytes: job.totalBytes })
    const names = context.database.listLabels([LOCAL_FOLDERS_ACCOUNT_ID]).map((label) => label.name)
    expect(names).toEqual(expect.arrayContaining([
      'enron', 'enron/Deleted Items', 'enron/lokay-m/MLOKAY (Non-Privileged)/Personal', 'enron/lokay-m/MLOKAY (Non-Privileged)/Sent Items',
      'pstextractortestpdf@outlook.com/Inbox', 'pstextractortestpdf@outlook.com/Drafts', 'pstextractortestpdf@outlook.com/Sync Issues/Conflicts'
    ]))
    expect(names.some((name) => /Calendar|Contacts|Search/.test(name))).toBe(false)
    expect(context.folder('enron/lokay-m/MLOKAY (Non-Privileged)')!.parentId).toBe(context.folder('enron/lokay-m')!.id)
    expect(context.messagesIn('enron/lokay-m/MLOKAY (Non-Privileged)/Personal')).toHaveLength(47)

    const [report] = context.messagesIn('enron/lokay-m/MLOKAY (Non-Privileged)/TW-Commercial Group').filter((item) => item.subject === "New OBA's")
    expect(report).toMatchObject({ unread: false, starred: false, hasAttachments: true, lastDate: '2001-10-22T20:06:22.000Z' })
    const message = context.database.getThread(LOCAL_FOLDERS_ACCOUNT_ID, report.id).messages[0]
    expect(message.attachments).toHaveLength(11)
    expect(message.attachments[0]).toMatchObject({ filename: 'OBA_27602_Citizens.doc', mimeType: 'application/msword', size: 53_760 })
    const raw = readFileSync(context.database.getMessageRaw(LOCAL_FOLDERS_ACCOUNT_ID, message.id)!, 'utf8')
    expect(raw).toMatch(/^Date: Mon, 22 Oct 2001 20:06:22 \+0000\r\nFrom: Lee Dennis <Dennis\.Lee@ENRON\.com>\r\n/)
    expect(raw).toContain('Received: from NAHOU-MSMBX07V.corp.enron.com')

    // Outlook's unread state is kept.
    const pdf = context.messagesIn('pstextractortestpdf@outlook.com/Inbox')
    expect(pdf.map((item) => [item.subject, item.unread, item.hasAttachments])).toEqual(expect.arrayContaining([['single PDF', true, true]]))
  })

  it('pauses, resumes and replays a PST import from its folder and item cursor', async () => {
    let stored = 0
    let pauseAt = 5
    let jobId = ''
    const context = setup({
      store: async (accountId, message) => {
        await storeRawForTest(context.database, accountId, message)
        stored += 1
        if (stored === pauseAt) context.service.pause(jobId)
      }
    })
    jobId = context.service.start({ paths: [ENRON_PST], duplicates: 'review', mboxVariant: 'mboxrd' }).id
    await context.service.pump()
    const paused = context.database.localMail.getJob(jobId)!
    expect(paused).toMatchObject({ status: 'paused', imported: 5 })
    expect(paused.cursor).toMatchObject({ entry: 0, folder: 4, message: 4 })
    expect(paused.processedBytes).toBeGreaterThan(0)
    expect(paused.processedBytes).toBeLessThan(paused.totalBytes)

    pauseAt = 30
    context.service.resume(jobId)
    await context.service.pump()
    expect(context.database.localMail.getJob(jobId)).toMatchObject({ status: 'paused', imported: 30 })

    // A crash after messages were stored but before the cursor moved.
    const raw = new DatabaseSync(context.databasePath)
    raw.prepare(`UPDATE mail_import_jobs SET status='running',cursor_json=?,imported=0 WHERE id=?`).run(JSON.stringify({ entry: 0, offset: 0, folder: 4, message: 2 }), jobId)
    raw.close()
    const reopened = context.reopen()
    expect(reopened.localMail.getJob(jobId)?.status).toBe('interrupted')
    pauseAt = 0
    context.service.resume(jobId)
    await context.service.pump()
    // Items before the cursor are not counted again; everything after it is, once.
    expect(reopened.localMail.getJob(jobId)).toMatchObject({ status: 'completed', imported: 71 - 1 - 2, duplicates: 0 })
    expect(context.messageCount()).toBe(71)
  })

  it('holds re-imported Outlook messages for review and re-reads them from the file', async () => {
    const context = setup()
    await context.run({ paths: [PDF_OST] })
    const second = await context.run({ paths: [PDF_OST] })
    expect(second).toMatchObject({ imported: 0, duplicates: 2, pendingReview: 2 })
    const items = context.service.items(second.id)
    expect(items.map((item) => [item.subject, item.reason])).toEqual(expect.arrayContaining([['single PDF', 'An identical copy is already in Local Folders']]))
    const resolved = await context.service.resolve(second.id, [items[0].key], 'import')
    expect(resolved).toMatchObject({ imported: 1, pendingReview: 1 })
    expect(context.service.items(second.id).find((item) => item.key === items[0].key)).toMatchObject({ status: 'imported', reason: 'Imported after review' })
    await context.service.resolve(second.id, [items[1].key], 'discard')
    expect(context.messageCount()).toBe(3)
  })

  it('reports unreadable Outlook files and oversized items while importing the rest', async () => {
    const context = setup({ limits: { maxMessageBytes: 1024 } })
    const damaged = join(context.directory, 'Damaged.pst')
    const text = join(context.directory, 'notes.pst')
    const encrypted = join(context.directory, 'Secret.pst')
    const mailbox = join(context.directory, 'Mail.mbox')
    writeFileSync(damaged, pstHeader())
    writeFileSync(text, 'PST')
    writeFileSync(encrypted, pstHeader({ encryption: 2 }))
    writeFileSync(mailbox, mbox([mime({ subject: 'Small' })]))
    const job = await context.run({ paths: [damaged, text, encrypted, PDF_OST, mailbox] })
    expect(job).toMatchObject({ status: 'completed', imported: 1, failed: 5 })
    expect(context.service.items(job.id).map((item) => [item.subject, item.reason])).toEqual([
      ['Damaged.pst', expect.stringMatching(/isn’t an Outlook data file/)],
      ['notes.pst', expect.stringMatching(/isn’t an Outlook data file/)],
      ['Secret.pst', expect.stringMatching(/high encryption/)],
      ['single PDF', 'The message is larger than the 1 KB import limit'],
      ['Welcome to your new Outlook.com account', 'The message is larger than the 1 KB import limit']
    ])
  })
})
