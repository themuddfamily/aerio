import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { MailAccountSummary, MailAttachment } from '../../src/mail-types'
import { MailDatabase, type ParsedMailMessage } from './database'
import { normalizeContactHistoryQuery } from './contact-history'
import { normalizeAttachmentQuery } from './attachment-index'

const directories: string[] = []

const account = (id: string, overrides: Partial<MailAccountSummary> = {}): MailAccountSummary => ({
  id, provider: 'gmail', email: `${id}@example.com`, displayName: id, color: '#6558e8', status: 'ready',
  archived: false, signature: '', notifications: true, syncEnabled: true, ...overrides
})

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'aerio-contact-history-test-'))
  directories.push(directory)
  const database = new MailDatabase(join(directory, 'aerio.sqlite'), join(directory, 'mail'))
  database.upsertAccount(account('account-1'))
  database.upsertAccount(account('account-2'))
  return { database, directory }
}

const file = (id: string, filename: string): MailAttachment => ({ id, messageId: '', filename, mimeType: 'application/pdf', size: 1_000 })

function store(database: MailDatabase, directory: string, overrides: Partial<ParsedMailMessage> & { id: string }) {
  const accountId = overrides.accountId ?? 'account-1'
  const rawPath = join(directory, `${accountId}-${overrides.id}.eml`)
  writeFileSync(rawPath, 'Subject: test\r\n\r\nbody')
  const message: ParsedMailMessage = {
    accountId, threadId: `thread-${overrides.id}`, historyId: '1', internalDate: '2026-07-27T10:00:00.000Z',
    fromName: 'Someone', fromEmail: 'someone@example.com', to: ['me@example.com'], cc: [], subject: `Subject ${overrides.id}`,
    messageIdHeader: `<${overrides.id}@example.com>`, references: [], snippet: 'Hello', text: '', html: '', labelIds: ['INBOX'],
    sizeEstimate: 1_000, rawPath, attachments: [], ...overrides
  }
  database.addInventory(accountId, [{ id: message.id, threadId: message.threadId }])
  database.upsertMessage(message)
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('normalizeContactHistoryQuery', () => {
  it('keeps complete addresses only and clamps paging', () => {
    expect(normalizeContactHistoryQuery({ addresses: [' Ada@Example.com ', 'ada@example.com', 'not an address', 7, '%@x'], pageSize: 500, accountIds: ['a', 3] })).toEqual({
      addresses: ['ada@example.com', '%@x'], accountIds: ['a'], includeArchivedAccounts: true, cursor: undefined, pageSize: 100
    })
    expect(normalizeContactHistoryQuery(null)).toMatchObject({ addresses: [], pageSize: 25 })
  })
})

describe('contact history listing', () => {
  it('matches the sender, To, and Cc exactly, never by substring', () => {
    const { database, directory } = setup()
    store(database, directory, { id: 'from', fromEmail: 'ADA@example.com', internalDate: '2026-07-01T10:00:00.000Z' })
    store(database, directory, { id: 'to', to: ['Ada Lovelace <ada@example.com>'], internalDate: '2026-07-02T10:00:00.000Z' })
    store(database, directory, { id: 'cc', cc: ['ada@example.com'], internalDate: '2026-07-03T10:00:00.000Z' })
    store(database, directory, { id: 'second-address', to: ['Ada <a.lovelace@work.test>'], internalDate: '2026-07-04T10:00:00.000Z' })
    store(database, directory, { id: 'substring', fromEmail: 'bada@example.com', to: ['Ada <ada@example.com.evil>', 'nada@example.com'], cc: ['"ada@example.com" <other@example.com>'] })
    store(database, directory, { id: 'trash', fromEmail: 'ada@example.com', labelIds: ['TRASH'] })
    store(database, directory, { id: 'spam', fromEmail: 'ada@example.com', labelIds: ['SPAM'] })
    const page = database.listContactHistory({ addresses: ['ada@example.com', 'a.lovelace@work.test'] })
    expect(page.items.map((item) => [item.messageId, item.direction])).toEqual([['second-address', 'to'], ['cc', 'to'], ['to', 'to'], ['from', 'from']])
    expect(page.total).toBe(4)
    expect(page.items[0]).toMatchObject({ accountEmail: 'account-1@example.com', accountArchived: false, subject: 'Subject second-address', snippet: 'Hello' })
    expect(database.listContactHistory({ addresses: [] })).toEqual({ items: [], total: 0 })
    database.close()
  })

  it('pages with a keyset cursor across tied timestamps and accounts', () => {
    const { database, directory } = setup()
    for (let index = 0; index < 23; index += 1) {
      store(database, directory, { id: `m-${String(index).padStart(2, '0')}`, accountId: index % 2 ? 'account-2' : 'account-1', fromEmail: 'ada@example.com', internalDate: index < 10 ? '2026-07-01T10:00:00.000Z' : `2026-07-${String(index).padStart(2, '0')}T10:00:00.000Z` })
    }
    const seen: string[] = []
    let cursor: string | undefined
    do {
      const page = database.listContactHistory({ addresses: ['ada@example.com'], pageSize: 5, cursor })
      expect(page.total).toBe(23)
      seen.push(...page.items.map((item) => `${item.accountId}:${item.messageId}`))
      cursor = page.nextCursor
    } while (cursor)
    expect(seen).toHaveLength(23)
    expect(new Set(seen).size).toBe(23)
    expect(() => database.listContactHistory({ addresses: ['ada@example.com'], cursor: 'broken' })).toThrow(/no longer valid/)
    database.close()
  })

  it('filters to selected accounts, labels archived accounts, and drops deleted ones', () => {
    const { database, directory } = setup()
    store(database, directory, { id: 'one', fromEmail: 'ada@example.com', attachments: [file('part-0', 'one.pdf')] })
    store(database, directory, { id: 'two', accountId: 'account-2', fromEmail: 'ada@example.com', attachments: [file('part-0', 'two.pdf')] })
    expect(database.listContactHistory({ addresses: ['ada@example.com'], accountIds: ['account-2'] }).items.map((item) => item.messageId)).toEqual(['two'])
    expect(database.listContactHistory({ addresses: ['ada@example.com'], accountIds: [] }).total).toBe(0)
    expect(database.listContactHistory({ addresses: ['ada@example.com'] }).items.every((item) => item.attachmentCount === 1)).toBe(true)

    database.disconnectAccount('account-2', 'archive')
    expect(database.listContactHistory({ addresses: ['ada@example.com'] }).items.find((item) => item.messageId === 'two')?.accountArchived).toBe(true)
    expect(database.listContactHistory({ addresses: ['ada@example.com'], includeArchivedAccounts: false }).total).toBe(1)

    database.disconnectAccount('account-1', 'delete')
    expect(database.listContactHistory({ addresses: ['ada@example.com'] }).items.map((item) => item.messageId)).toEqual(['two'])
    database.close()
  })
})

describe('attachment history for a contact', () => {
  it('filters the attachment index by exact participant addresses', () => {
    const { database, directory } = setup()
    store(database, directory, { id: 'from', fromEmail: 'ada@example.com', attachments: [file('part-0', 'from.pdf')] })
    store(database, directory, { id: 'to', to: ['Ada <ada@example.com>'], attachments: [file('part-0', 'to.pdf')] })
    store(database, directory, { id: 'unrelated', fromEmail: 'bada@example.com', attachments: [file('part-0', 'unrelated.pdf')] })
    const page = database.listAttachments({ participants: ['Ada@Example.com'] })
    expect(page.items.map((item) => item.filename).sort()).toEqual(['from.pdf', 'to.pdf'])
    expect(page.total).toBe(2)
    expect(normalizeAttachmentQuery({ participants: ['nope', 'ada@example.com'] }).participants).toEqual(['ada@example.com'])
    expect(normalizeAttachmentQuery({ participants: [] }).participants).toBeUndefined()
    database.close()
  })
})
