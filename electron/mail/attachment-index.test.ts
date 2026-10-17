import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { MailAccountSummary, MailAttachment, MailAttachmentFileType } from '../../src/mail-types'
import { MailDatabase, type ParsedMailMessage } from './database'
import { MAIL_ATTACHMENT_FILE_TYPES, attachmentFileType, normalizeAttachmentQuery } from './attachment-index'

const directories: string[] = []

const account = (id: string, overrides: Partial<MailAccountSummary> = {}): MailAccountSummary => ({
  id, provider: 'gmail', email: `${id}@example.com`, displayName: id, color: '#6558e8', status: 'ready',
  archived: false, signature: '', notifications: true, syncEnabled: true, ...overrides
})

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'aerio-attachments-test-'))
  directories.push(directory)
  const database = new MailDatabase(join(directory, 'aerio.sqlite'), join(directory, 'mail'))
  database.upsertAccount(account('account-1'))
  database.upsertAccount(account('account-2'))
  return { database, directory }
}

const file = (id: string, filename: string, mimeType: string, size = 1_000, contentId?: string): MailAttachment => ({ id, messageId: '', filename, mimeType, size, contentId })

function store(database: MailDatabase, directory: string, overrides: Partial<ParsedMailMessage> & { id: string }, writeRaw = true) {
  const accountId = overrides.accountId ?? 'account-1'
  const rawPath = join(directory, `${accountId}-${overrides.id}.eml`)
  if (writeRaw) writeFileSync(rawPath, 'Subject: test\r\n\r\nbody')
  const message: ParsedMailMessage = {
    accountId, threadId: `thread-${overrides.id}`, historyId: '1', internalDate: '2026-07-27T10:00:00.000Z',
    fromName: 'Ada Lovelace', fromEmail: 'ada@example.com', to: ['person@example.com'], cc: [], subject: 'Quarterly report',
    messageIdHeader: `<${overrides.id}@example.com>`, references: [], snippet: '', text: '', html: '', labelIds: ['INBOX'],
    sizeEstimate: 1_000, rawPath, attachments: [], ...overrides
  }
  database.addInventory(accountId, [{ id: message.id, threadId: message.threadId }])
  database.upsertMessage(message)
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('attachmentFileType', () => {
  it('prefers extensions over generic MIME types and falls back to MIME families', () => {
    expect(attachmentFileType('application/octet-stream', 'Invoice.PDF')).toBe('pdf')
    expect(attachmentFileType('text/plain', 'export.csv')).toBe('spreadsheet')
    expect(attachmentFileType('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'letter')).toBe('document')
    expect(attachmentFileType('image/heic', 'IMG_0001')).toBe('image')
    expect(attachmentFileType('text/calendar', 'invite.ics')).toBe('calendar')
    expect(attachmentFileType('application/x-msdownload', 'setup.exe')).toBe('other')
  })

  it('agrees with the SQL classifier used for filtering', () => {
    const { database, directory } = setup()
    const samples: Array<[string, string]> = [
      ['application/pdf', 'a'], ['application/octet-stream', 'b.docx'], ['application/vnd.ms-excel', 'c'], ['text/csv', 'd'],
      ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'e'], ['application/zip', 'f'], ['image/png', 'g'],
      ['audio/mpeg', 'h'], ['video/mp4', 'i'], ['text/calendar', 'j'], ['application/json', 'k.json'], ['IMAGE/JPEG', ' L.JPG ']
    ]
    store(database, directory, { id: 'mixed', attachments: samples.map(([mime, name], index) => file(`part-${index}`, name, mime)) })
    const items = database.listAttachments({ pageSize: 100 }).items
    expect(items).toHaveLength(samples.length)
    for (const item of items) expect(item.fileType).toBe(attachmentFileType(item.mimeType, item.filename))
    for (const type of MAIL_ATTACHMENT_FILE_TYPES) {
      const expected = items.filter((item) => item.fileType === type).length
      expect(database.listAttachments({ fileTypes: [type] }).total, type).toBe(expected)
    }
    database.close()
  })
})

describe('normalizeAttachmentQuery', () => {
  it('clamps and drops malformed renderer input', () => {
    expect(normalizeAttachmentQuery({
      accountIds: ['a', 7, ''], fileTypes: ['pdf', 'pdf', 'exe'], pageSize: 5_000, minSize: -1, maxSize: 10.7,
      search: '   ', sender: ` ${'x'.repeat(500)} `, dateFrom: 'not a date', dateTo: '2026-08-01', includeArchivedAccounts: 'no'
    })).toEqual({
      accountIds: ['a'], includeArchivedAccounts: true, includeInline: false, search: undefined, sender: 'x'.repeat(200), recipient: undefined,
      dateFrom: undefined, dateTo: '2026-08-01', fileTypes: ['pdf'], minSize: undefined, maxSize: 10, cursor: undefined, pageSize: 100
    })
    expect(normalizeAttachmentQuery(null)).toMatchObject({ pageSize: 50, includeArchivedAccounts: true })
  })
})

describe('MailDatabase.listAttachments', () => {
  it('pages across accounts newest first with a stable keyset cursor', () => {
    const { database, directory } = setup()
    for (let index = 0; index < 7; index += 1) {
      store(database, directory, {
        id: `message-${index}`,
        accountId: index % 2 ? 'account-2' : 'account-1',
        // Two messages share each timestamp so ties must be broken by the cursor.
        internalDate: `2026-07-${String(10 + Math.floor(index / 2)).padStart(2, '0')}T10:00:00.000Z`,
        attachments: [file('part-0', `file-${index}-a.pdf`, 'application/pdf'), file('part-1', `file-${index}-b.png`, 'image/png')]
      })
    }
    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const page = database.listAttachments({ pageSize: 3, cursor })
      expect(page.total).toBe(14)
      seen.push(...page.items.map((item) => `${item.accountId}/${item.messageId}/${item.attachmentId}`))
      cursor = page.nextCursor
      pages += 1
    } while (cursor && pages < 10)
    expect(pages).toBe(5)
    expect(new Set(seen).size).toBe(14)
    const dates = seen.map((key) => database.listAttachments({ pageSize: 100 }).items.find((item) => `${item.accountId}/${item.messageId}/${item.attachmentId}` === key)!.date)
    expect([...dates].sort().reverse()).toEqual(dates)
    expect(() => database.listAttachments({ cursor: 'garbage' })).toThrow(/no longer valid/)
    database.close()
  })

  it('filters by name, sender, recipient, date, type, size, and account', () => {
    const { database, directory } = setup()
    store(database, directory, { id: 'report', internalDate: '2026-07-01T09:00:00.000Z', attachments: [file('part-0', 'Q2_report.pdf', 'application/pdf', 2_000_000)] })
    store(database, directory, { id: 'photos', accountId: 'account-2', internalDate: '2026-07-15T09:00:00.000Z', fromName: 'Grace Hopper', fromEmail: 'grace@navy.test', to: ['team@example.com'], cc: ['boss@example.com'], attachments: [file('part-0', 'beach.jpg', 'image/jpeg', 300_000)] })
    store(database, directory, { id: 'sheet', internalDate: '2026-07-31T23:30:00.000Z', attachments: [file('part-0', 'budget.xlsx', 'application/octet-stream', 40_000)] })
    const names = (query: Parameters<MailDatabase['listAttachments']>[0]) => database.listAttachments(query).items.map((item) => item.filename)
    expect(names({ search: '2_r' })).toEqual(['Q2_report.pdf'])
    expect(names({ search: '%' })).toEqual([])
    expect(names({ sender: 'grace' })).toEqual(['beach.jpg'])
    expect(names({ recipient: 'BOSS@' })).toEqual(['beach.jpg'])
    expect(names({ dateFrom: '2026-07-15', dateTo: '2026-07-31' })).toEqual(['budget.xlsx', 'beach.jpg'])
    expect(names({ fileTypes: ['spreadsheet', 'pdf'] })).toEqual(['budget.xlsx', 'Q2_report.pdf'])
    expect(names({ minSize: 100_000, maxSize: 1_000_000 })).toEqual(['beach.jpg'])
    expect(names({ accountIds: ['account-2'] })).toEqual(['beach.jpg'])
    const [photo] = database.listAttachments({ sender: 'grace' }).items
    expect(photo).toMatchObject({ accountId: 'account-2', threadId: 'thread-photos', messageId: 'photos', attachmentId: 'part-0', fileType: 'image', to: ['team@example.com'], cc: ['boss@example.com'], available: true, accountArchived: false })
    database.close()
  })

  it('hides inline images, trash, spam, and duplicate provider copies by default', () => {
    const { database, directory } = setup()
    store(database, directory, { id: 'inline', attachments: [file('part-0', 'logo.png', 'image/png', 4_000, 'logo@cid'), file('part-1', 'terms.pdf', 'application/pdf', 4_000, 'terms@cid')] })
    store(database, directory, { id: 'trash', labelIds: ['TRASH'], attachments: [file('part-0', 'trashed.pdf', 'application/pdf')] })
    store(database, directory, { id: 'spam', labelIds: ['SPAM'], attachments: [file('part-0', 'spam.zip', 'application/zip')] })
    store(database, directory, { id: 'copy-a', threadId: 'thread-copy', messageIdHeader: '<same@example.com>', labelIds: ['INBOX'], attachments: [file('part-0', 'shared.docx', 'application/msword')] })
    store(database, directory, { id: 'copy-b', threadId: 'thread-copy', messageIdHeader: '<same@example.com>', labelIds: ['folder:Projects'], attachments: [file('part-0', 'shared.docx', 'application/msword')] })
    expect(database.listAttachments({}).items.map((item) => item.filename).sort()).toEqual(['shared.docx', 'terms.pdf'])
    expect(database.listAttachments({ includeInline: true }).items.map((item) => item.filename).sort()).toEqual(['logo.png', 'shared.docx', 'terms.pdf'])
    expect(database.listAttachments({}).items.find((item) => item.filename === 'shared.docx')?.messageId).toBe('copy-b')
    database.close()
  })

  it('reports unavailable originals and keeps archived accounts until they are deleted', () => {
    const { database, directory } = setup()
    store(database, directory, { id: 'present', attachments: [file('part-0', 'present.pdf', 'application/pdf')] })
    store(database, directory, { id: 'missing', attachments: [file('part-0', 'missing.pdf', 'application/pdf')] }, false)
    store(database, directory, { id: 'other', accountId: 'account-2', attachments: [file('part-0', 'other.pdf', 'application/pdf')] })
    const availability = Object.fromEntries(database.listAttachments({}).items.map((item) => [item.filename, item.available]))
    expect(availability).toEqual({ 'present.pdf': true, 'missing.pdf': false, 'other.pdf': true })

    database.disconnectAccount('account-2', 'archive')
    expect(database.listAttachments({}).items.find((item) => item.filename === 'other.pdf')?.accountArchived).toBe(true)
    expect(database.listAttachments({ includeArchivedAccounts: false }).total).toBe(2)

    database.disconnectAccount('account-1', 'delete')
    const remaining = database.listAttachments({})
    expect(remaining.items.map((item) => item.filename)).toEqual(['other.pdf'])
    expect(remaining.total).toBe(1)
    expect(database.diagnosticHealth().orphanedAttachments).toBe(0)
    database.close()
  })

  it('pages a large attachment cache without loading it all', () => {
    const { database, directory } = setup()
    const path = join(directory, 'aerio.sqlite')
    database.close()
    // Bulk-insert directly; going through upsertMessage for thousands of rows is slow and not under test.
    const raw = new DatabaseSync(path)
    raw.exec('BEGIN')
    const thread = raw.prepare(`INSERT INTO gmail_threads(account_id,id,subject,last_date) VALUES('account-1',?,'Bulk',?)`)
    const messageRow = raw.prepare(`INSERT INTO gmail_messages(account_id,id,thread_id,history_id,internal_date,raw_path) VALUES('account-1',?,?,'1',?,'')`)
    const attachment = raw.prepare(`INSERT INTO gmail_attachments(account_id,message_id,id,filename,mime_type,size) VALUES('account-1',?,?,?,?,?)`)
    for (let index = 0; index < 4_000; index += 1) {
      const date = new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString()
      thread.run(`t${index}`, date)
      messageRow.run(`m${index}`, `t${index}`, date)
      attachment.run(`m${index}`, 'part-0', `file-${index}.pdf`, 'application/pdf', index)
      attachment.run(`m${index}`, 'part-1', `photo-${index}.jpg`, 'image/jpeg', index)
    }
    raw.exec('COMMIT')
    raw.close()
    const reopened = new MailDatabase(path, join(directory, 'mail'))
    const started = performance.now()
    const first = reopened.listAttachments({ pageSize: 100, fileTypes: ['pdf'] as MailAttachmentFileType[] })
    const second = reopened.listAttachments({ pageSize: 100, fileTypes: ['pdf'], cursor: first.nextCursor })
    expect(performance.now() - started).toBeLessThan(5_000)
    expect(first.total).toBe(4_000)
    expect(first.items[0].filename).toBe('file-3999.pdf')
    expect(second.items[0].filename).toBe('file-3899.pdf')
    expect(first.items.every((item) => !item.available)).toBe(true)
    reopened.close()
  })
})
