import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { MailDatabase, type ParsedMailMessage } from './database'
import { parseHeaderBlock, readRawHeaders, ruleLedgerKey } from './rule-ledger'

const directories: string[] = []

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'aerio-rule-ledger-'))
  directories.push(directory)
  const path = join(directory, 'aerio.sqlite')
  const database = new MailDatabase(path, join(directory, 'mail'))
  database.upsertAccount({ id: 'account-1', provider: 'imap', email: 'person@example.com', displayName: 'Person', color: '#6558e8', status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true })
  return { database, directory, path }
}

const message = (overrides: Partial<ParsedMailMessage> = {}): ParsedMailMessage => ({
  accountId: 'account-1', id: 'message-1', threadId: 'thread-1', historyId: '1', internalDate: '2026-10-01T10:00:00.000Z',
  fromName: 'Person', fromEmail: 'person@example.com', to: ['client@example.org'], cc: [], subject: 'Proposal',
  messageIdHeader: '<Proposal-1@example.com>', references: [], snippet: '', text: 'Attached is the proposal.', html: '',
  labelIds: ['SENT'], sizeEstimate: 2048, rawPath: 'missing.eml', attachments: [], ...overrides
})

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('rule run ledger', () => {
  it('keys messages by normalized Message-ID, falling back to the provider id', () => {
    expect(ruleLedgerKey({ id: 'a', messageIdHeader: ' <ABC@example.com> ' })).toBe(ruleLedgerKey({ id: 'b', messageIdHeader: '<abc@example.com>' }))
    expect(ruleLedgerKey({ id: 'a' })).toBe('id:a')
  })

  it('claims a message once per trigger, including a copy with a new local id', () => {
    const { database } = setup()
    expect(database.ruleLedger.claim('account-1', message(), 'outgoing')).toBe(true)
    expect(database.ruleLedger.claim('account-1', message(), 'outgoing')).toBe(false)
    // An IMAP move assigns a new folder/UID id but keeps the Message-ID.
    expect(database.ruleLedger.claim('account-1', message({ id: 'moved-copy' }), 'outgoing')).toBe(false)
    expect(database.ruleLedger.processed('account-1', message({ id: 'moved-copy' }), 'outgoing')).toBe(true)
    // A message sent to yourself is processed once as outgoing and once as incoming.
    expect(database.ruleLedger.claim('account-1', message(), 'incoming')).toBe(true)
    expect(database.ruleLedger.claim('account-1', message({ id: 'other', messageIdHeader: undefined }), 'incoming')).toBe(true)
    database.close()
  })

  it('prunes old entries and survives a reopen', () => {
    const { database, directory, path } = setup()
    database.ruleLedger.claim('account-1', message(), 'incoming')
    database.close()
    const reopened = new MailDatabase(path, join(directory, 'mail'))
    expect(reopened.ruleLedger.claim('account-1', message(), 'incoming')).toBe(false)
    reopened.ruleLedger.prune(Date.now() + 365 * 24 * 60 * 60_000)
    expect(reopened.ruleLedger.claim('account-1', message(), 'incoming')).toBe(true)
    reopened.close()
  })

  it('parses folded header blocks and reads only stored headers', () => {
    expect(parseHeaderBlock('Subject: Hi\r\nList-Id: Project\r\n <list.example.com>\r\nX-Tag: a\r\nX-Tag: b\r\nbad line\r\n\r\nBody: not a header')).toEqual({
      subject: ['Hi'], 'list-id': ['Project <list.example.com>'], 'x-tag': ['a', 'b']
    })
    const directory = mkdtempSync(join(tmpdir(), 'aerio-raw-headers-'))
    directories.push(directory)
    const raw = join(directory, 'message.eml')
    writeFileSync(raw, 'Importance: High\nFrom: a@example.com\n\nImportance: Low\n')
    expect(readRawHeaders(raw)).toEqual({ importance: ['High'], from: ['a@example.com'] })
    expect(readRawHeaders(join(directory, 'missing.eml'))).toBeUndefined()
  })
})

describe('advanced rule persistence and matching', () => {
  it('persists archive rules and matches selected conversations before archive, with exceptions and source labels', () => {
    const { database, path, directory } = setup()
    const records = [
      message({ id: 'inbox', threadId: 'inbox', labelIds: ['INBOX'], messageIdHeader: '<inbox@test>' }),
      message({ id: 'old', threadId: 'old', labelIds: [], messageIdHeader: '<old@test>' }),
      message({ id: 'spam', threadId: 'spam', labelIds: ['SPAM'], messageIdHeader: '<spam@test>' })
    ]
    database.addInventory('account-1', records.map(({ id, threadId }) => ({ id, threadId })))
    records.forEach((record) => database.upsertMessage(record))
    const rule = database.saveRule({ accountId: 'account-1', name: 'Archive projects', enabled: true, match: 'all', trigger: 'archive', conditions: [{ field: 'subject', operator: 'contains', value: 'proposal' }], actions: [{ action: 'star' }] })
    expect(database.matchingThreadIdsForRule(rule)).toEqual(['old'])
    expect(database.matchingArchiveRules('account-1', ['inbox', 'inbox'])).toEqual([{ rule, threadIds: ['inbox'] }])
    expect(database.matchingArchiveRules('account-1', [])).toEqual([])
    expect(database.matchingArchiveRules('other', ['inbox'])).toEqual([])
    expect(database.matchingRulesForMessage(records[0], 'incoming')).toEqual([])
    const withSource = database.saveRule({ ...rule, conditions: [{ field: 'label', operator: 'is', value: 'INBOX' }] })
    expect(database.matchingArchiveRules('account-1', ['inbox', 'old'])[0].threadIds).toEqual(['inbox'])
    database.saveRule({ ...withSource, exceptions: [{ field: 'subject', operator: 'contains', value: 'proposal' }] })
    expect(database.matchingArchiveRules('account-1', ['inbox'])).toEqual([])
    database.saveRule({ ...withSource, enabled: false })
    expect(database.matchingArchiveRules('account-1', ['inbox'])).toEqual([])
    database.close()
    const reopened = new MailDatabase(path, join(directory, 'mail'))
    expect(reopened.getRule(rule.id)?.trigger).toBe('archive')
    reopened.close()
  })
  it('adds the advanced rule columns to an existing rules table and keeps old rules incoming and local', () => {
    const { database, directory, path } = setup()
    const legacyRule = database.saveRule({ accountId: 'account-1', name: 'Legacy', enabled: true, match: 'all', conditions: [{ field: 'subject', operator: 'contains', value: 'proposal' }], actions: [{ action: 'star' }] })
    database.close()
    const legacy = new DatabaseSync(path)
    for (const column of ['exceptions_json', 'trigger_mode', 'execution', 'server_rule_id']) legacy.exec(`ALTER TABLE mail_rules DROP COLUMN ${column}`)
    legacy.close()
    const migrated = new MailDatabase(path, join(directory, 'mail'))
    expect(migrated.getRule(legacyRule.id)).toMatchObject({ name: 'Legacy', exceptions: [], trigger: 'incoming', execution: 'local' })
    expect(migrated.getRule(legacyRule.id)).not.toHaveProperty('serverRuleId')
    migrated.close()
  })

  it('persists exceptions, triggers, and server links, and only links server execution with a server id', () => {
    const { database } = setup()
    const saved = database.saveRule({
      accountId: 'account-1', name: 'Sent proposals', enabled: true, match: 'all', trigger: 'outgoing', execution: 'server', serverRuleId: 'filter-1',
      conditions: [{ field: 'subject', operator: 'contains', value: 'proposal' }],
      exceptions: [{ field: 'header', headerName: 'X-Internal', operator: 'contains', value: 'yes' }],
      actions: [{ action: 'label', labelId: 'folder:Proposals' }]
    })
    expect(database.getRule(saved.id)).toMatchObject({ trigger: 'outgoing', execution: 'server', serverRuleId: 'filter-1', exceptions: [{ field: 'header', headerName: 'X-Internal' }] })
    const unlinked = database.saveRule({ ...saved, execution: 'server', serverRuleId: undefined })
    expect(unlinked).toMatchObject({ execution: 'local' })
    database.close()
  })

  it('runs only enabled local rules for the matching trigger, reading headers from the raw file on demand', () => {
    const { database, directory } = setup()
    const raw = join(directory, 'sent.eml')
    writeFileSync(raw, 'Importance: high\r\nX-Internal: no\r\n\r\nbody')
    const outgoing = database.saveRule({ accountId: 'account-1', name: 'Outgoing', enabled: true, match: 'all', trigger: 'outgoing', conditions: [{ field: 'importance', operator: 'is', value: 'high' }], exceptions: [{ field: 'header', headerName: 'X-Internal', operator: 'equals', value: 'yes' }], actions: [{ action: 'star' }] })
    database.saveRule({ accountId: 'account-1', name: 'Incoming', enabled: true, match: 'all', conditions: [{ field: 'subject', operator: 'contains', value: 'proposal' }], actions: [{ action: 'archive' }] })
    database.saveRule({ accountId: 'account-1', name: 'Server', enabled: true, match: 'all', trigger: 'outgoing', execution: 'server', serverRuleId: 'rule-x', conditions: [{ field: 'subject', operator: 'contains', value: 'proposal' }], actions: [{ action: 'archive' }] })
    expect(database.matchingRulesForMessage(message({ rawPath: raw }), 'outgoing').map((rule) => rule.name)).toEqual([outgoing.name])
    expect(database.matchingRulesForMessage(message({ rawPath: raw }), 'incoming').map((rule) => rule.name)).toEqual(['Incoming'])
    expect(database.matchingRulesForMessage(message({ rawPath: 'missing.eml' }), 'outgoing')).toEqual([])
    expect(database.hasLocalRules('account-1', 'outgoing')).toBe(true)
    database.saveRule({ ...outgoing, enabled: false })
    expect(database.hasLocalRules('account-1', 'outgoing')).toBe(false)
    database.close()
  })

  it('runs outgoing rules on existing Sent conversations with size, age, and attachment data', () => {
    const { database } = setup()
    database.addInventory('account-1', [{ id: 'sent-1', threadId: 'thread-sent' }, { id: 'inbox-1', threadId: 'thread-inbox' }])
    database.upsertMessage(message({ id: 'sent-1', threadId: 'thread-sent', sizeEstimate: 500 * 1024, attachments: [{ id: 'a', messageId: 'sent-1', filename: 'p.pdf', mimeType: 'application/pdf', size: 10 }] }))
    database.upsertMessage(message({ id: 'inbox-1', threadId: 'thread-inbox', labelIds: ['INBOX'], messageIdHeader: '<other@example.com>', sizeEstimate: 500 * 1024 }))
    const rule = database.saveRule({ accountId: 'account-1', name: 'Large sent', enabled: true, match: 'all', trigger: 'outgoing',
      conditions: [{ field: 'size', operator: 'greater-than', value: '100' }, { field: 'has-attachment', operator: 'is', value: 'yes' }, { field: 'age', operator: 'greater-than', value: '1' }],
      actions: [{ action: 'star' }] })
    expect(database.matchingThreadIdsForRule(rule)).toEqual(['thread-sent'])
    const incoming = database.saveRule({ ...rule, trigger: 'incoming', conditions: [{ field: 'size', operator: 'greater-than', value: '100' }] })
    expect(database.matchingThreadIdsForRule(incoming)).toEqual(['thread-inbox'])
    database.close()
  })
})
