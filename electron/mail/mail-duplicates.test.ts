import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { MailAccountSummary } from '../../src/mail-types'
import { MailDatabase, type ParsedMailMessage } from './database'
import { normalizedContentHash, scanMailDuplicates } from './mail-duplicates'

const directories: string[] = []
const open: MailDatabase[] = []
afterEach(() => {
  for (const database of open.splice(0)) database.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const account = (id: string, provider: MailAccountSummary['provider'], extra: Partial<MailAccountSummary> = {}): MailAccountSummary => ({
  id, provider, email: `${id}@example.com`, displayName: id, color: '#6558e8', status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true, ...extra
})

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'aerio-mail-dupes-'))
  directories.push(directory)
  const path = join(directory, 'aerio.sqlite')
  const database = new MailDatabase(path, join(directory, 'mail'))
  open.push(database)
  database.upsertAccount(account('gmail-1', 'gmail'))
  database.upsertAccount(account('imap-1', 'imap'))
  database.upsertAccount(account('old-1', 'imap', { archived: true }))
  database.replaceLabels('imap-1', [
    { accountId: 'imap-1', id: 'folder:INBOX', name: 'INBOX', type: 'system' },
    { accountId: 'imap-1', id: 'folder:Archive', name: 'Archive', type: 'user' }
  ])
  return { database, directory, path }
}

interface Fixture {
  messageId?: string
  subject?: string
  from?: string
  date?: string
  body?: string
  received?: string
  attachment?: { name: string; content: string }
}

// A raw RFC 5322 message, optionally with one attachment.
function eml(fixture: Fixture) {
  const headers = [
    ...(fixture.received ? [`Received: ${fixture.received}`] : []),
    `From: Ada <${fixture.from ?? 'ada@example.com'}>`,
    'To: person@example.com',
    `Subject: ${fixture.subject ?? 'Quarterly report'}`,
    `Date: ${fixture.date ?? 'Mon, 05 Oct 2026 10:00:00 +0000'}`,
    ...(fixture.messageId ? [`Message-ID: <${fixture.messageId}>`] : []),
    'MIME-Version: 1.0'
  ]
  if (!fixture.attachment) return `${headers.join('\r\n')}\r\nContent-Type: text/plain\r\n\r\n${fixture.body ?? 'Numbers attached.'}\r\n`
  return [
    ...headers,
    'Content-Type: multipart/mixed; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/plain',
    '',
    fixture.body ?? 'Numbers attached.',
    '--b1',
    `Content-Type: application/octet-stream; name="${fixture.attachment.name}"`,
    `Content-Disposition: attachment; filename="${fixture.attachment.name}"`,
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(fixture.attachment.content).toString('base64'),
    '--b1--',
    ''
  ].join('\r\n')
}

let counter = 0
function store(database: MailDatabase, directory: string, input: Partial<ParsedMailMessage> & { accountId: string; id: string }, fixture: Fixture = {}) {
  const rawPath = join(directory, `${input.id}-${counter += 1}.eml`)
  const raw = eml(fixture)
  writeFileSync(rawPath, raw)
  database.upsertMessage({
    threadId: input.id,
    historyId: '1',
    internalDate: '2026-10-05T10:00:00.000Z',
    fromName: 'Ada',
    fromEmail: fixture.from ?? 'ada@example.com',
    to: ['person@example.com'],
    cc: [],
    subject: fixture.subject ?? 'Quarterly report',
    messageIdHeader: fixture.messageId ? `<${fixture.messageId}>` : undefined,
    references: [],
    snippet: '',
    text: fixture.body ?? 'Numbers attached.',
    html: '',
    labelIds: ['INBOX'],
    sizeEstimate: raw.length,
    rawPath,
    attachments: fixture.attachment ? [{ id: 'a1', messageId: input.id, filename: fixture.attachment.name, mimeType: 'application/octet-stream', size: fixture.attachment.content.length }] : [],
    ...input
  })
}

const scan = (database: MailDatabase, scopes: { accountId: string; labelIds?: string[] }[]) => scanMailDuplicates(database.duplicates, database, scopes)

describe('mail duplicate scanner', () => {
  it('groups the same Message-ID and identical content in one Gmail account, ignoring transport headers', async () => {
    const { database, directory } = setup()
    store(database, directory, { accountId: 'gmail-1', id: 'm1', internalDate: '2026-10-05T10:00:00.000Z', labelIds: ['INBOX', 'Label_1'] }, { messageId: 'report@example.com', received: 'from a.example by mx1; Mon, 05 Oct 2026 10:00:01 +0000' })
    store(database, directory, { accountId: 'gmail-1', id: 'm2', internalDate: '2026-10-05T10:00:03.000Z' }, { messageId: 'report@example.com', received: 'from b.example by mx2; Mon, 05 Oct 2026 10:00:03 +0000' })
    const result = await scan(database, [{ accountId: 'gmail-1' }])
    expect(result.scanned).toBe(2)
    expect(result.groups).toHaveLength(1)
    const [group] = result.groups
    expect(group).toMatchObject({ confidence: 'high', codes: ['message-id', 'content-hash'] })
    expect(group.items.map((item) => item.messageId).sort()).toEqual(['m1', 'm2'])
    // The copy with more labels is the more complete one, so it is suggested as the keeper.
    expect(group.keeperId).toBe('mail:gmail-1:m1')
    expect(group.items[0].details.map((detail) => detail.label)).toContain('Message-ID')
  })

  it('never treats Gmail labels or several IMAP folder locations of one message as duplicates', async () => {
    const { database, directory } = setup()
    // One Gmail record carrying several labels is one message.
    store(database, directory, { accountId: 'gmail-1', id: 'labelled', labelIds: ['INBOX', 'Label_1', 'Label_2', 'IMPORTANT'] }, { messageId: 'one@example.com' })
    // The same logical message in INBOX and Archive is one message in two places.
    store(database, directory, { accountId: 'imap-1', id: 'inbox-1', labelIds: ['folder:INBOX'], remoteFolderId: 'INBOX', remoteUid: '1' }, { messageId: 'two@example.com' })
    store(database, directory, { accountId: 'imap-1', id: 'archive-9', labelIds: ['folder:Archive'], remoteFolderId: 'Archive', remoteUid: '9' }, { messageId: 'two@example.com' })
    const result = await scan(database, [{ accountId: 'gmail-1' }, { accountId: 'imap-1' }])
    expect(result.groups).toEqual([])
  })

  it('groups two copies of one message inside the same IMAP folder', async () => {
    const { database, directory } = setup()
    store(database, directory, { accountId: 'imap-1', id: 'inbox-1', labelIds: ['folder:INBOX'], remoteFolderId: 'INBOX', remoteUid: '1' }, { messageId: 'two@example.com' })
    store(database, directory, { accountId: 'imap-1', id: 'inbox-2', labelIds: ['folder:INBOX'], remoteFolderId: 'INBOX', remoteUid: '2' }, { messageId: 'two@example.com' })
    store(database, directory, { accountId: 'imap-1', id: 'archive-9', labelIds: ['folder:Archive'], remoteFolderId: 'Archive', remoteUid: '9' }, { messageId: 'two@example.com' })
    const result = await scan(database, [{ accountId: 'imap-1' }])
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0].items.map((item) => item.messageId).sort()).toEqual(['inbox-1', 'inbox-2'])
    expect(result.groups[0].items[0].containerLabel).toBe('INBOX')
    // A folder scope limits the scan to that folder.
    expect((await scan(database, [{ accountId: 'imap-1', labelIds: ['folder:Archive'] }])).groups).toEqual([])
  })

  it('keeps copies with different attachments apart even with the same Message-ID', async () => {
    const { database, directory } = setup()
    store(database, directory, { accountId: 'gmail-1', id: 'v1' }, { messageId: 'contract@example.com', attachment: { name: 'contract.pdf', content: 'draft one' } })
    store(database, directory, { accountId: 'gmail-1', id: 'v2' }, { messageId: 'contract@example.com', attachment: { name: 'contract.pdf', content: 'draft two' } })
    const result = await scan(database, [{ accountId: 'gmail-1' }])
    expect(result.groups).toEqual([])
  })

  it('matches same sender, subject, size, and time with different Message-IDs at low confidence only within 2 seconds', async () => {
    const { database, directory } = setup()
    store(database, directory, { accountId: 'gmail-1', id: 'a', internalDate: '2026-10-05T10:00:00.000Z', sizeEstimate: 900 }, { messageId: 'a@example.com' })
    store(database, directory, { accountId: 'gmail-1', id: 'b', internalDate: '2026-10-05T10:00:01.500Z', sizeEstimate: 900 }, { messageId: 'b@example.com' })
    // Three seconds later is outside the window.
    store(database, directory, { accountId: 'gmail-1', id: 'c', internalDate: '2026-10-05T10:00:05.000Z', sizeEstimate: 900 }, { messageId: 'c@example.com' })
    const result = await scan(database, [{ accountId: 'gmail-1' }])
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0]).toMatchObject({ confidence: 'low', codes: ['message-fingerprint'] })
    expect(result.groups[0].items.map((item) => item.messageId).sort()).toEqual(['a', 'b'])
    expect(result.groups[0].notes.join(' ')).toMatch(/Message-IDs differ/)
  })

  it('does not group look-alike messages (false-positive fixtures)', async () => {
    const { database, directory } = setup()
    // A daily newsletter: same sender and subject, different days.
    store(database, directory, { accountId: 'gmail-1', id: 'monday', internalDate: '2026-10-05T07:00:00.000Z' }, { messageId: 'n1@news.example', subject: 'Daily digest', body: 'Monday news' })
    store(database, directory, { accountId: 'gmail-1', id: 'tuesday', internalDate: '2026-10-06T07:00:00.000Z' }, { messageId: 'n2@news.example', subject: 'Daily digest', body: 'Tuesday news' })
    // Same second and sender, different sizes.
    store(database, directory, { accountId: 'gmail-1', id: 'alert-1', internalDate: '2026-10-05T09:00:00.000Z', sizeEstimate: 400 }, { messageId: 'x1@example.com', subject: 'Alert' })
    store(database, directory, { accountId: 'gmail-1', id: 'alert-2', internalDate: '2026-10-05T09:00:01.000Z', sizeEstimate: 410 }, { messageId: 'x2@example.com', subject: 'Alert' })
    // Same Message-ID in different accounts is never compared.
    store(database, directory, { accountId: 'gmail-1', id: 'shared-g' }, { messageId: 'shared@example.com', subject: 'Shared' })
    store(database, directory, { accountId: 'imap-1', id: 'shared-i', labelIds: ['folder:INBOX'], remoteFolderId: 'INBOX', remoteUid: '3' }, { messageId: 'shared@example.com', subject: 'Shared' })
    // Messages in Trash are not candidates.
    store(database, directory, { accountId: 'gmail-1', id: 'trashed', labelIds: ['TRASH'] }, { messageId: 'shared@example.com', subject: 'Shared' })
    const result = await scan(database, [{ accountId: 'gmail-1' }, { accountId: 'imap-1' }])
    expect(result.groups).toEqual([])
  })

  it('excludes archived (read-only) accounts with an explanation', async () => {
    const { database } = setup()
    const result = await scan(database, [{ accountId: 'old-1' }])
    expect(result.excluded).toEqual([{ label: 'old-1@example.com', reason: expect.stringMatching(/read-only/) }])
  })

  it('normalizes line endings, folded headers, and trace headers in the content hash', () => {
    const first = Buffer.from('Received: from a\r\nSubject: Hi\r\n there\r\nMessage-ID: <x@y>\r\n\r\nBody  \r\n\r\n')
    const second = Buffer.from('Received: from b\nX-Received: by c\nSubject: Hi there\nMessage-ID: <x@y>\n\nBody\n')
    expect(normalizedContentHash(first)).toBe(normalizedContentHash(second))
    expect(normalizedContentHash(Buffer.from('Subject: Hi there\n\nOther body\n'))).not.toBe(normalizedContentHash(second))
  })
})

describe('mail duplicate removal', () => {
  it('trashes only the duplicate message through the queued pipeline and undoes it', async () => {
    const { database, directory, path } = setup()
    // Both copies are in one conversation; trashing must not touch the kept copy.
    store(database, directory, { accountId: 'gmail-1', id: 'keep', threadId: 'thread-1' }, { messageId: 'same@example.com' })
    store(database, directory, { accountId: 'gmail-1', id: 'extra', threadId: 'thread-1' }, { messageId: 'same@example.com' })
    const [group] = (await scan(database, [{ accountId: 'gmail-1' }])).groups
    const keep = group.items.find((item) => item.messageId === 'keep')!
    const extra = group.items.find((item) => item.messageId === 'extra')!
    const result = database.duplicates.trash({ accountId: 'gmail-1', items: [{ messageId: 'extra', revision: extra.revision, keeper: { messageId: 'keep', revision: keep.revision } }] })
    expect(result.results).toEqual([{ messageId: 'extra', outcome: 'removed' }])
    expect(result.operation).toMatchObject({ kind: 'trash', status: 'queued' })
    const db = new DatabaseSync(path)
    const labels = (id: string) => JSON.parse(String((db.prepare('SELECT label_ids_json FROM gmail_messages WHERE id=?').get(id) as { label_ids_json: string }).label_ids_json)) as string[]
    expect(labels('extra')).toContain('TRASH')
    expect(labels('keep')).not.toContain('TRASH')
    const operation = db.prepare('SELECT message_ids_json FROM gmail_operations WHERE id=?').get(result.operation!.id) as { message_ids_json: string }
    expect(JSON.parse(operation.message_ids_json)).toEqual(['extra'])
    // Undo before dispatch restores the snapshot.
    expect(database.undoOperation(result.operation!.id)).toBe(true)
    expect(labels('extra')).not.toContain('TRASH')
    db.close()
  })

  it('undoes a dispatched message-level trash with a message-level untrash', async () => {
    const { database, directory, path } = setup()
    store(database, directory, { accountId: 'gmail-1', id: 'keep', threadId: 'thread-1' }, { messageId: 'same@example.com' })
    store(database, directory, { accountId: 'gmail-1', id: 'extra', threadId: 'thread-1' }, { messageId: 'same@example.com' })
    const [group] = (await scan(database, [{ accountId: 'gmail-1' }])).groups
    const extra = group.items.find((item) => item.messageId === 'extra')!
    const { operation } = database.duplicates.trash({ accountId: 'gmail-1', items: [{ messageId: 'extra', revision: extra.revision }] })
    database.updateOperation(operation!.id, 'succeeded')
    expect(database.undoOperation(operation!.id)).toBe(true)
    const db = new DatabaseSync(path)
    const inverse = db.prepare(`SELECT kind,message_ids_json FROM gmail_operations WHERE id<>? ORDER BY created_at DESC, rowid DESC`).get(operation!.id) as { kind: string; message_ids_json: string }
    expect(inverse.kind).toBe('untrash')
    expect(JSON.parse(inverse.message_ids_json)).toEqual(['extra'])
    db.close()
  })

  it('skips and reports stale messages and stale kept copies', async () => {
    const { database, directory } = setup()
    store(database, directory, { accountId: 'gmail-1', id: 'keep' }, { messageId: 'same@example.com' })
    store(database, directory, { accountId: 'gmail-1', id: 'extra' }, { messageId: 'same@example.com' })
    store(database, directory, { accountId: 'gmail-1', id: 'extra-2' }, { messageId: 'same@example.com' })
    const [group] = (await scan(database, [{ accountId: 'gmail-1' }])).groups
    const revision = (id: string) => group.items.find((item) => item.messageId === id)!.revision
    // A sync changed one copy after the scan.
    database.updateMessageLabels('gmail-1', 'extra', ['INBOX', 'STARRED'], '2')
    const changed = database.duplicates.trash({ accountId: 'gmail-1', items: [{ messageId: 'extra', revision: revision('extra') }, { messageId: 'gone', revision: '1|live' }] })
    expect(changed.operation).toBeUndefined()
    expect(changed.results).toEqual([
      { messageId: 'extra', outcome: 'stale', message: expect.stringMatching(/changed since the scan/) },
      { messageId: 'gone', outcome: 'stale', message: expect.stringMatching(/no longer/) }
    ])
    database.updateMessageLabels('gmail-1', 'keep', ['INBOX', 'Label_9'], '3')
    const keeperChanged = database.duplicates.trash({ accountId: 'gmail-1', items: [{ messageId: 'extra-2', revision: revision('extra-2'), keeper: { messageId: 'keep', revision: revision('keep') } }] })
    expect(keeperChanged.results).toEqual([{ messageId: 'extra-2', outcome: 'stale', message: expect.stringMatching(/copy you chose to keep/) }])
  })
})
