import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MailAttachment } from '../../src/mail-types'
import { MailDatabase, type ParsedMailMessage } from './database'
import { AttachmentContentIndexer } from './attachment-index'
import { extractAttachmentText } from './attachment-text-extract'
import { MAX_MESSAGE_ATTACHMENT_TEXT } from './attachment-text-store'
import type { AttachmentTextInput, AttachmentTextResult } from './attachment-text-types'
import { docxFixture, simplePdf } from './attachment-test-fixtures'

const directories: string[] = []
const databases: MailDatabase[] = []

function open() {
  const directory = mkdtempSync(join(tmpdir(), 'aerio-attachment-index-'))
  directories.push(directory)
  const path = join(directory, 'aerio.sqlite')
  const database = new MailDatabase(path, join(directory, 'mail'))
  databases.push(database)
  for (const id of ['account-1', 'account-2']) database.upsertAccount({
    id, provider: 'gmail', email: `${id}@example.com`, displayName: id, color: '#6558e8', status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true
  })
  return { database, path }
}

let sequence = 0
function message(attachments: Omit<MailAttachment, 'messageId'>[], overrides: Partial<ParsedMailMessage> = {}): ParsedMailMessage {
  sequence += 1
  const id = overrides.id ?? `message-${sequence}`
  return {
    accountId: 'account-1', id, threadId: `thread-${sequence}`, historyId: '1',
    internalDate: new Date(Date.UTC(2026, 6, 1) + sequence * 60_000).toISOString(),
    fromName: 'Ada', fromEmail: 'ada@example.com', to: ['person@example.com'], cc: [], subject: 'Files',
    references: [], snippet: '', text: 'See attached.', html: '', labelIds: ['INBOX'], sizeEstimate: 100, rawPath: `${id}.eml`,
    attachments: attachments.map((attachment) => ({ ...attachment, messageId: id })),
    ...overrides
  }
}

/** Attachment bytes by message and attachment id, standing in for the stored raw messages. */
type Contents = Map<string, Map<string, Buffer>>

function indexer(database: MailDatabase, contents: Contents, extract?: (input: AttachmentTextInput, signal: AbortSignal) => Promise<AttachmentTextResult>) {
  const readAttachments = vi.fn(async (_accountId: string, messageId: string) => contents.get(messageId))
  const extractor = vi.fn(extract ?? (async (input: AttachmentTextInput) => extractAttachmentText(input)))
  const created = new AttachmentContentIndexer({ store: database.attachmentText, readAttachments, extract: extractor, batchSize: 3 })
  return { indexer: created, readAttachments, extract: extractor }
}

const search = (database: MailDatabase, query: string) => database.listThreads({ folder: 'all', search: query }).items.map((item) => item.id).sort()
const textIndex = (database: MailDatabase, threadId: string) =>
  Object.fromEntries(database.getThread('account-1', threadId).messages.flatMap((item) => item.attachments).map((item) => [item.filename, item.textIndex?.status]))

afterEach(() => {
  for (const database of databases.splice(0)) { try { database.close() } catch { /* Already closed. */ } }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('AttachmentContentIndexer', () => {
  it('indexes supported attachment content for attachment: and unscoped searches', async () => {
    const { database } = open()
    const report = message([
      { id: 'pdf', filename: 'q3.pdf', mimeType: 'application/pdf', size: 0 },
      { id: 'doc', filename: 'plan.docx', mimeType: '', size: 0 }
    ])
    const pdf = simplePdf('BT /F1 12 Tf (Zeppelin manifest) Tj ET', true)
    const docx = docxFixture(['Falcon roadmap'])
    report.attachments[0].size = pdf.length
    report.attachments[1].size = docx.length
    database.upsertMessage(report)
    database.upsertMessage(message([], { text: 'Nothing attached here' }))
    expect(textIndex(database, report.threadId)).toEqual({ 'q3.pdf': 'pending', 'plan.docx': 'pending' })
    expect(search(database, 'zeppelin')).toEqual([])

    const run = indexer(database, new Map([[report.id, new Map([['pdf', pdf], ['doc', docx]])]]))
    run.indexer.schedule()
    await run.indexer.idle()

    expect(run.readAttachments).toHaveBeenCalledTimes(1)
    expect(search(database, 'attachment:zeppelin')).toEqual([report.threadId])
    expect(search(database, 'file:"falcon roadmap"')).toEqual([report.threadId])
    expect(search(database, 'manifest')).toEqual([report.threadId])
    // Filenames stay searchable alongside the content, and other fields don't see attachment text.
    expect(search(database, 'attachment:q3')).toEqual([report.threadId])
    expect(search(database, 'body:zeppelin')).toEqual([])
    expect(search(database, 'attached -attachment:falcon')).toEqual([`thread-${sequence}`])
    expect(textIndex(database, report.threadId)).toEqual({ 'q3.pdf': 'indexed', 'plan.docx': 'indexed' })
    expect(database.attachmentText.stats()).toMatchObject({ pending: 0, indexed: 2 })
  })

  it('records unsupported, oversized, encrypted, and missing attachments without retrying them', async () => {
    const { database } = open()
    const encrypted = simplePdf('').toString('latin1').replace('/Root 1 0 R', '/Root 1 0 R /Encrypt 9 0 R')
    const item = message([
      { id: 'img', filename: 'photo.png', mimeType: 'image/png', size: 10 },
      { id: 'big', filename: 'huge.txt', mimeType: 'text/plain', size: 30 * 1024 * 1024 },
      { id: 'enc', filename: 'locked.pdf', mimeType: 'application/pdf', size: encrypted.length },
      { id: 'gone', filename: 'missing.txt', mimeType: 'text/plain', size: 5 }
    ])
    database.upsertMessage(item)
    const run = indexer(database, new Map([[item.id, new Map([['enc', Buffer.from(encrypted, 'latin1')]])]]))
    run.indexer.schedule()
    await run.indexer.idle()

    expect(run.extract).toHaveBeenCalledTimes(1)
    expect(textIndex(database, item.threadId)).toEqual({ 'photo.png': 'unsupported', 'huge.txt': 'too-large', 'locked.pdf': 'encrypted', 'missing.txt': 'failed' })
    const locked = database.getThread('account-1', item.threadId).messages[0].attachments.find((attachment) => attachment.id === 'enc')
    expect(locked?.textIndex).toMatchObject({ status: 'encrypted', detail: 'The PDF is encrypted or password-protected', indexedAt: expect.any(String) })
    expect(database.attachmentText.stats()).toMatchObject({ pending: 0, unsupported: 1, 'too-large': 1, encrypted: 1, failed: 1 })

    run.indexer.schedule()
    await run.indexer.idle()
    expect(run.extract).toHaveBeenCalledTimes(1)
  })

  it('reindexes incrementally: new mail, changed attachments, and extractor upgrades only', async () => {
    const { database, path } = open()
    const first = message([{ id: 'a', filename: 'a.txt', mimeType: 'text/plain', size: 5 }])
    database.upsertMessage(first)
    const contents: Contents = new Map([[first.id, new Map([['a', Buffer.from('alpha')]])]])
    const run = indexer(database, contents)
    run.indexer.schedule()
    await run.indexer.idle()
    expect(run.extract).toHaveBeenCalledTimes(1)

    // A re-download of the same message keeps its text without extracting again.
    database.upsertMessage({ ...first, labelIds: ['INBOX', 'STARRED'] })
    expect(search(database, 'attachment:alpha')).toEqual([first.threadId])
    run.indexer.schedule()
    await run.indexer.idle()
    expect(run.extract).toHaveBeenCalledTimes(1)

    const second = message([{ id: 'b', filename: 'b.txt', mimeType: 'text/plain', size: 5 }])
    database.upsertMessage(second)
    contents.set(second.id, new Map([['b', Buffer.from('bravo')]]))
    run.indexer.schedule()
    await run.indexer.idle()
    expect(run.extract).toHaveBeenCalledTimes(2)
    expect(search(database, 'attachment:bravo')).toEqual([second.threadId])

    // A changed attachment (different size) drops the stale text until it is re-extracted.
    database.upsertMessage({ ...first, attachments: [{ ...first.attachments[0], size: 7 }] })
    contents.set(first.id, new Map([['a', Buffer.from('charlie')]]))
    expect(search(database, 'attachment:alpha')).toEqual([])
    run.indexer.schedule()
    await run.indexer.idle()
    expect(run.extract).toHaveBeenCalledTimes(3)
    expect(search(database, 'attachment:charlie')).toEqual([first.threadId])

    // Rows from an older extractor version are pending again.
    const raw = new DatabaseSync(path)
    raw.prepare('UPDATE mail_attachment_text SET extractor_version=0 WHERE message_id=?').run(second.id)
    raw.close()
    expect(database.attachmentText.stats().pending).toBe(1)
    run.indexer.schedule()
    await run.indexer.idle()
    expect(run.extract).toHaveBeenCalledTimes(4)
    expect(database.attachmentText.stats()).toMatchObject({ pending: 0, indexed: 2 })
  })

  it('processes newest mail first in bounded batches and picks up work scheduled mid-run', async () => {
    const { database } = open()
    const contents: Contents = new Map()
    const messages = Array.from({ length: 7 }, (_, index) => {
      const item = message([{ id: 'a', filename: `n${index}.txt`, mimeType: 'text/plain', size: 4 }])
      contents.set(item.id, new Map([['a', Buffer.from(`w${index}xx`.slice(0, 4))]]))
      database.upsertMessage(item)
      return item
    })
    const order: string[] = []
    const run = indexer(database, contents, async (input) => {
      order.push(input.filename)
      if (order.length === 2) {
        const late = message([{ id: 'a', filename: 'late.txt', mimeType: 'text/plain', size: 4 }])
        contents.set(late.id, new Map([['a', Buffer.from('late')]]))
        database.upsertMessage(late)
        run.indexer.schedule()
      }
      return extractAttachmentText(input)
    })
    run.indexer.schedule()
    await run.indexer.idle()
    expect(order.slice(0, 3)).toEqual(['n6.txt', 'n5.txt', 'n4.txt'])
    expect(order).toHaveLength(messages.length + 1)
    expect(order).toContain('late.txt')
    expect(database.attachmentText.stats().pending).toBe(0)
  })

  it('cancels in-flight extraction for a deleted account and removes its index', async () => {
    const { database } = open()
    const doomed = message([{ id: 'a', filename: 'a.txt', mimeType: 'text/plain', size: 5 }])
    const kept = message([{ id: 'a', filename: 'k.txt', mimeType: 'text/plain', size: 4 }], { accountId: 'account-2' })
    const indexed = message([{ id: 'b', filename: 'b.txt', mimeType: 'text/plain', size: 5 }], { internalDate: '2020-01-01T00:00:00.000Z' })
    database.upsertMessage(indexed)
    const contents: Contents = new Map([[doomed.id, new Map([['a', Buffer.from('doomy')]])], [kept.id, new Map([['a', Buffer.from('kept')]])], [indexed.id, new Map([['b', Buffer.from('older')]])]])
    const first = indexer(database, contents)
    first.indexer.schedule()
    await first.indexer.idle()
    expect(database.attachmentText.stats('account-1').indexed).toBe(1)

    database.upsertMessage(doomed)
    database.upsertMessage(kept)
    let started!: () => void
    const extracting = new Promise<void>((resolve) => { started = resolve })
    const run = indexer(database, contents, (input, signal) => {
      if (input.filename !== 'a.txt') return Promise.resolve(extractAttachmentText(input))
      started()
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }))))
    })
    run.indexer.schedule()
    await extracting
    run.indexer.cancelAccount('account-1')
    database.disconnectAccount('account-1', 'delete')
    await run.indexer.idle()

    expect(database.attachmentText.stats('account-1')).toMatchObject({ pending: 0, indexed: 0 })
    expect(database.attachmentText.stats('account-2')).toMatchObject({ indexed: 1 })
    expect(search(database, 'attachment:kept')).toEqual([kept.threadId])
    expect(search(database, 'attachment:older')).toEqual([])
    expect(database.attachmentText.searchValue('account-1', indexed.id)).toBe('')
  })

  it('removes extracted text with its message and never saves results for deleted messages', async () => {
    const { database, path } = open()
    const item = message([{ id: 'a', filename: 'a.txt', mimeType: 'text/plain', size: 5 }])
    database.upsertMessage(item)
    const run = indexer(database, new Map([[item.id, new Map([['a', Buffer.from('ghost')]])]]), async (input) => {
      database.deleteMessage('account-1', item.id)
      return extractAttachmentText(input)
    })
    run.indexer.schedule()
    await run.indexer.idle()
    const raw = new DatabaseSync(path)
    expect(raw.prepare('SELECT COUNT(*) count FROM mail_attachment_text').get()).toEqual({ count: 0 })

    const again = message([{ id: 'a', filename: 'a.txt', mimeType: 'text/plain', size: 5 }])
    database.upsertMessage(again)
    const second = indexer(database, new Map([[again.id, new Map([['a', Buffer.from('ghost')]])]]))
    second.indexer.schedule()
    await second.indexer.idle()
    expect(raw.prepare('SELECT COUNT(*) count FROM mail_attachment_text').get()).toEqual({ count: 1 })
    database.deleteMessage('account-1', again.id)
    expect(raw.prepare('SELECT COUNT(*) count FROM mail_attachment_text').get()).toEqual({ count: 0 })
    raw.close()
  })

  it('stops on shutdown without saving the cancelled result, and resumes skipped accounts', async () => {
    const { database } = open()
    const item = message([{ id: 'a', filename: 'a.txt', mimeType: 'text/plain', size: 5 }])
    database.upsertMessage(item)
    const contents: Contents = new Map([[item.id, new Map([['a', Buffer.from('later')]])]])
    let started!: () => void
    const extracting = new Promise<void>((resolve) => { started = resolve })
    const run = indexer(database, contents, (_input, signal) => {
      started()
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }))))
    })
    run.indexer.schedule()
    await extracting
    await run.indexer.stop()
    expect(database.attachmentText.stats().pending).toBe(1)
    run.indexer.schedule()
    expect(run.extract).toHaveBeenCalledTimes(1)

    const next = indexer(database, contents)
    next.indexer.cancelAccount('account-1')
    next.indexer.schedule()
    await next.indexer.idle()
    expect(next.extract).not.toHaveBeenCalled()
    next.indexer.resumeAccount('account-1')
    await next.indexer.idle()
    expect(search(database, 'attachment:later')).toEqual([item.threadId])
  })

  it('reports extraction errors and caps the text stored per message', async () => {
    const { database } = open()
    const item = message([
      { id: 'a', filename: 'a.txt', mimeType: 'text/plain', size: 1 },
      { id: 'b', filename: 'b.txt', mimeType: 'text/plain', size: 1 }
    ])
    database.upsertMessage(item)
    const onError = vi.fn()
    const failing = new AttachmentContentIndexer({
      store: database.attachmentText,
      readAttachments: async () => new Map([['a', Buffer.from('x')], ['b', Buffer.from('y')]]),
      extract: async () => { throw new Error('worker exploded') },
      onError
    })
    failing.schedule()
    await failing.idle()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'worker exploded' }))

    const huge = 'z'.repeat(MAX_MESSAGE_ATTACHMENT_TEXT)
    const filling = new AttachmentContentIndexer({
      store: database.attachmentText,
      readAttachments: async () => new Map([['a', Buffer.from('x')], ['b', Buffer.from('y')]]),
      extract: async () => ({ status: 'indexed', text: huge, truncated: false })
    })
    filling.schedule()
    await filling.idle()
    expect(database.attachmentText.searchValue('account-1', item.id)).toHaveLength(MAX_MESSAGE_ATTACHMENT_TEXT)
  })
})
