import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MailDatabase, type ParsedMailMessage } from './database'

const directories: string[] = []
const databases: MailDatabase[] = []

function open(directory = mkdtempSync(join(tmpdir(), 'aerio-search-test-'))) {
  if (!directories.includes(directory)) directories.push(directory)
  const database = new MailDatabase(join(directory, 'aerio.sqlite'), join(directory, 'mail'))
  databases.push(database)
  for (const id of ['account-1', 'account-2']) database.upsertAccount({
    id, provider: 'gmail', email: `${id}@example.com`, displayName: id, color: '#6558e8', status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true
  })
  return { database, directory }
}

let sequence = 0
function message(overrides: Partial<ParsedMailMessage> = {}): ParsedMailMessage {
  sequence += 1
  return {
    accountId: 'account-1', id: `message-${sequence}`, threadId: `thread-${sequence}`, historyId: '1',
    internalDate: new Date(Date.UTC(2026, 6, 1) + sequence * 60_000).toISOString(),
    fromName: 'Ada Lovelace', fromEmail: 'ada@example.com', to: ['person@example.com'], cc: [], subject: 'Hello',
    references: [], snippet: '', text: '', html: '', labelIds: ['INBOX'], sizeEstimate: 100, rawPath: `${sequence}.eml`, attachments: [],
    ...overrides
  }
}

const ids = (database: MailDatabase, search: string, extra: Record<string, unknown> = {}) =>
  database.listThreads({ folder: 'all', search, ...extra }).items.map((item) => item.id).sort()

afterEach(() => {
  for (const database of databases.splice(0)) { try { database.close() } catch { /* Already closed. */ } }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('MailDatabase Boolean search', () => {
  function seeded() {
    const context = open()
    const { database } = context
    database.upsertMessage(message({ threadId: 'invoice-paid', subject: 'Invoice 42', text: 'The invoice has been paid in full.' }))
    database.upsertMessage(message({ threadId: 'invoice-open', subject: 'Invoice 43', text: 'Reminder: the invoice is still open.' }))
    database.upsertMessage(message({ threadId: 'receipt', subject: 'Your receipt', text: 'Thanks for shopping.', fromName: 'Shop', fromEmail: 'orders@shop.test' }))
    database.upsertMessage(message({ threadId: 'newsletter', subject: 'Weekly digest', text: 'Quarterly report highlights and invoice tips.', fromName: 'News', fromEmail: 'news@letters.test' }))
    database.upsertMessage(message({ threadId: 'report', subject: 'Report draft', text: 'The report for this quarter is attached.', attachments: [{ id: 'a', messageId: '', filename: 'q3-report.pdf', mimeType: 'application/pdf', size: 1 }] }))
    return context
  }

  it('supports AND, OR, NOT, parentheses, phrases, and field prefixes', () => {
    const { database } = seeded()
    expect(ids(database, 'invoice')).toEqual(['invoice-open', 'invoice-paid', 'newsletter'])
    expect(ids(database, 'invoice -paid')).toEqual(['invoice-open', 'newsletter'])
    expect(ids(database, 'invoice NOT paid NOT from:news')).toEqual(['invoice-open'])
    expect(ids(database, 'receipt OR subject:report')).toEqual(['receipt', 'report'])
    expect(ids(database, '(receipt OR digest) AND from:shop')).toEqual(['receipt'])
    expect(ids(database, '"quarterly report"')).toEqual(['newsletter'])
    expect(ids(database, '"report quarterly"')).toEqual([])
    expect(ids(database, 'attachment:q3')).toEqual(['report'])
    expect(ids(database, '(invoice -paid) OR receipt')).toEqual(['invoice-open', 'newsletter', 'receipt'])
  })

  it('allows a search made only of exclusions and combines it with folders and filters', () => {
    const { database } = seeded()
    expect(ids(database, '-invoice')).toEqual(['receipt', 'report'])
    expect(ids(database, 'NOT from:ada')).toEqual(['newsletter', 'receipt'])
    expect(ids(database, '-invoice', { filters: { hasAttachments: true } })).toEqual(['report'])
  })

  it('rejects invalid searches with a user-facing error instead of an SQLite error', () => {
    const { database } = seeded()
    expect(() => database.listThreads({ folder: 'all', search: 'invoice AND' })).toThrow('Add a search term after AND')
    expect(() => database.listThreads({ folder: 'all', search: '(invoice' })).toThrow(/closing parenthesis/)
    expect(() => database.listThreads({ folder: 'all', search: 'invoice OR -paid' })).toThrow(/Combine NOT/)
  })

  it('treats FTS and SQL syntax in the search box as literal words', () => {
    const { database } = seeded()
    for (const search of [`invoice' OR 1=1 --`, 'NEAR invoice', 'subject* : ^invoice', '{subject}:invoice', 'invoice;DROP TABLE gmail_threads']) {
      expect(() => database.listThreads({ folder: 'all', search })).not.toThrow()
    }
    expect(ids(database, `"' OR 1=1 --"`)).toEqual([])
    expect(database.listThreads({ folder: 'all' }).total).toBe(5)
  })

  it('pages exclusion searches with stable totals and cursors', () => {
    const { database } = open()
    for (let index = 0; index < 7; index += 1) database.upsertMessage(message({ threadId: `keep-${index}`, text: 'project update' }))
    for (let index = 0; index < 3; index += 1) database.upsertMessage(message({ threadId: `drop-${index}`, text: 'project spam' }))
    const first = database.listThreads({ folder: 'all', search: 'project -spam', pageSize: 4 })
    expect(first).toMatchObject({ total: 7 })
    expect(first.items).toHaveLength(4)
    const second = database.listThreads({ folder: 'all', search: 'project -spam', pageSize: 4, cursor: first.nextCursor })
    expect(second.total).toBe(7)
    expect(second.items).toHaveLength(3)
    expect(second.nextCursor).toBeUndefined()
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(7)
    expect([...first.items, ...second.items].every((item) => item.id.startsWith('keep-'))).toBe(true)
  })

  it('reflects newly indexed mail in the next query for live result updates', () => {
    const { database } = seeded()
    expect(ids(database, 'invoice -paid')).toEqual(['invoice-open', 'newsletter'])
    database.upsertMessage(message({ threadId: 'invoice-new', subject: 'Invoice 44', text: 'New invoice' }))
    database.upsertMessage(message({ threadId: 'invoice-open', id: 'invoice-open-reply', subject: 'Re: Invoice 43', text: 'Now paid, thanks.' }))
    expect(ids(database, 'invoice -paid')).toEqual(['invoice-new', 'newsletter'])
  })
})

describe('MailDatabase saved searches', () => {
  it('creates, updates, lists, and deletes saved searches', () => {
    const { database } = open()
    const saved = database.saveSavedSearch({ name: 'Unpaid', query: 'invoice -paid', folder: 'all', accountId: 'account-1', filters: { unread: true } })
    expect(saved).toMatchObject({ name: 'Unpaid', query: 'invoice -paid', folder: 'all', accountId: 'account-1', filters: { unread: true } })
    expect(saved.labelId).toBeUndefined()
    const global = database.saveSavedSearch({ name: 'all receipts', query: 'receipt', folder: 'inbox', filters: {} })
    expect(global.accountId).toBeUndefined()
    expect(database.listSavedSearches().map((item) => item.name)).toEqual(['all receipts', 'Unpaid'])
    const updated = database.saveSavedSearch({ ...saved, name: 'Unpaid invoices', query: 'invoice NOT paid' })
    expect(updated).toMatchObject({ id: saved.id, name: 'Unpaid invoices', query: 'invoice NOT paid', createdAt: saved.createdAt })
    database.deleteSavedSearch(global.id)
    expect(database.listSavedSearches().map((item) => item.id)).toEqual([saved.id])
  })

  it('rejects invalid queries and unknown accounts', () => {
    const { database } = open()
    expect(() => database.saveSavedSearch({ name: 'Broken', query: 'a OR', folder: 'all', filters: {} })).toThrow(/after OR/)
    expect(() => database.saveSavedSearch({ name: 'Missing', query: 'a', folder: 'all', accountId: 'missing', filters: {} })).toThrow(/Account not found/)
  })

  it('persists across restart, migrates idempotently, and is removed with its account', () => {
    const first = open()
    const saved = first.database.saveSavedSearch({ name: 'Label search', query: '', folder: 'all', accountId: 'account-2', labelId: 'Label_1', filters: { starred: true } })
    first.database.saveSavedSearch({ name: 'Everywhere', query: 'from:ada', folder: 'all', filters: {} })
    first.database.close()
    const reopened = open(first.directory)
    expect(reopened.database.listSavedSearches()).toEqual(expect.arrayContaining([expect.objectContaining({ id: saved.id, labelId: 'Label_1', filters: { starred: true } })]))
    reopened.database.disconnectAccount('account-2', 'delete')
    expect(reopened.database.listSavedSearches().map((item) => item.name)).toEqual(['Everywhere'])
    reopened.database.close()
    const third = open(first.directory)
    expect(third.database.listSavedSearches()).toHaveLength(1)
    third.database.close()
  })
})
