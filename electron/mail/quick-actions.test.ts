import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { MailQuickAction } from '../../src/mail-types'
import { MailDatabase, type ParsedMailMessage } from './database'
import { runMailQuickAction } from './quick-actions'

const directories: string[] = []
const databases: MailDatabase[] = []

function open(directory = mkdtempSync(join(tmpdir(), 'aerio-quick-action-test-'))) {
  if (!directories.includes(directory)) directories.push(directory)
  const database = new MailDatabase(join(directory, 'aerio.sqlite'), join(directory, 'mail'))
  databases.push(database)
  for (const [id, provider] of [['gmail-1', 'gmail'], ['gmail-2', 'gmail'], ['imap-1', 'imap']] as const) database.upsertAccount({
    id, provider, email: `${id}@example.com`, displayName: id, color: '#6558e8', status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true
  })
  database.replaceLabels('gmail-1', [{ accountId: 'gmail-1', id: 'Label_1', name: 'Receipts', type: 'user' }])
  database.replaceLabels('imap-1', [{ accountId: 'imap-1', id: 'folder:Done', name: 'Done', type: 'user' }])
  return { database, directory }
}

let sequence = 0
function message(overrides: Partial<ParsedMailMessage> = {}): ParsedMailMessage {
  sequence += 1
  return {
    accountId: 'gmail-1', id: `message-${sequence}`, threadId: `thread-${sequence}`, historyId: '1',
    internalDate: new Date(Date.UTC(2026, 6, 1) + sequence * 60_000).toISOString(),
    fromName: 'Ada', fromEmail: 'ada@example.com', to: ['me@example.com'], cc: [], subject: 'Hello',
    references: [], snippet: '', text: '', html: '', labelIds: ['INBOX', 'UNREAD'], sizeEstimate: 100, rawPath: `${sequence}.eml`, attachments: [],
    ...overrides
  }
}

const labelsOf = (database: MailDatabase, accountId: string, threadId: string) =>
  [...database.listThreads({ folder: 'all', accountIds: [accountId] }).items.find((item) => item.id === threadId)!.labelIds].sort()

const triage = (database: MailDatabase, overrides: Partial<MailQuickAction> = {}) => database.saveQuickAction({
  name: 'File receipt', accountId: 'gmail-1', showInToolbar: true, shortcut: 1,
  steps: [{ action: 'read' }, { action: 'star' }, { action: 'label', labelId: 'Label_1' }, { action: 'archive' }],
  ...overrides
})

afterEach(() => {
  for (const database of databases.splice(0)) { try { database.close() } catch { /* Already closed. */ } }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('Quick Action persistence', () => {
  it('saves, updates, reopens, and deletes quick actions with unique shortcuts', () => {
    const { database, directory } = open()
    const saved = triage(database)
    expect(saved).toMatchObject({ name: 'File receipt', accountId: 'gmail-1', shortcut: 1, showInToolbar: true })
    expect(saved.steps).toHaveLength(4)
    expect(() => database.saveQuickAction({ name: 'Other', steps: [{ action: 'read' }], shortcut: 1, showInToolbar: false })).toThrow(/already used by “File receipt”/)
    database.saveQuickAction({ ...saved, name: 'Renamed', shortcut: undefined, showInToolbar: false })
    database.close()

    const reopened = open(directory).database
    expect(reopened.listQuickActions()).toEqual([expect.objectContaining({ id: saved.id, name: 'Renamed', showInToolbar: false })])
    expect(reopened.getQuickAction(saved.id)?.shortcut).toBeUndefined()
    expect(() => reopened.saveQuickAction({ name: 'Ghost', accountId: 'missing', steps: [{ action: 'read' }], showInToolbar: false })).toThrow('Account not found')
    reopened.deleteQuickAction(saved.id)
    expect(reopened.listQuickActions()).toEqual([])
  })
})

describe('runMailQuickAction', () => {
  it('queues every step in order on a multi-selection and Undo in reverse restores the original state', () => {
    const { database } = open()
    database.upsertMessage(message({ threadId: 'a' }))
    database.upsertMessage(message({ threadId: 'b', labelIds: ['INBOX', 'UNREAD', 'IMPORTANT'] }))
    const { result, changed } = runMailQuickAction(database, triage(database), [{ accountId: 'gmail-1', threadIds: ['a', 'b'] }])

    expect(result.failures).toEqual([])
    expect(result.updatedThreads).toBe(2)
    expect(result.operations.map((operation) => operation.kind)).toEqual(['read', 'star', 'label', 'archive'])
    expect(result.operations.every((operation) => operation.status === 'queued' && operation.undoUntil)).toBe(true)
    expect(changed).toEqual([{ accountId: 'gmail-1', threadIds: ['a', 'b'] }])
    expect(labelsOf(database, 'gmail-1', 'a')).toEqual(['Label_1', 'STARRED'])
    expect(labelsOf(database, 'gmail-1', 'b')).toEqual(['IMPORTANT', 'Label_1', 'STARRED'])

    // Provider execution order follows step order even when every step shares one timestamp.
    ;(database as unknown as { db: { prepare(sql: string): { run(): unknown } } }).db.prepare(`UPDATE gmail_operations SET execute_after='2000-01-01T00:00:00.000Z',created_at='2000-01-01T00:00:00.000Z'`).run()
    expect(database.dueOperations().map((row) => row.kind)).toEqual(['read', 'star', 'label', 'archive'])

    for (const operation of [...result.operations].reverse()) expect(database.undoOperation(operation.id)).toBe(true)
    expect(labelsOf(database, 'gmail-1', 'a')).toEqual(['INBOX', 'UNREAD'])
    expect(labelsOf(database, 'gmail-1', 'b')).toEqual(['IMPORTANT', 'INBOX', 'UNREAD'])
  })

  it('skips read-only, out-of-scope, and stale-destination accounts without touching their mail', () => {
    const { database } = open()
    database.upsertMessage(message({ threadId: 'mine' }))
    database.upsertMessage(message({ accountId: 'gmail-2', threadId: 'other' }))
    database.upsertMessage(message({ accountId: 'imap-1', threadId: 'imap', labelIds: ['INBOX', 'UNREAD', 'folder:INBOX'] }))
    const global = database.saveQuickAction({ name: 'Read and star', steps: [{ action: 'read' }, { action: 'star' }], showInToolbar: false })
    database.disconnectAccount('gmail-2', 'archive')

    const first = runMailQuickAction(database, global, [{ accountId: 'gmail-1', threadIds: ['mine'] }, { accountId: 'gmail-2', threadIds: ['other'] }, { accountId: 'gone', threadIds: ['x'] }])
    expect(first.result.updatedThreads).toBe(1)
    expect(first.result.failures).toEqual([
      { accountId: 'gmail-2', threadCount: 1, appliedSteps: 0, error: 'Disconnected accounts are read-only' },
      { accountId: 'gone', threadCount: 1, appliedSteps: 0, error: 'The account is no longer connected' }
    ])
    expect(labelsOf(database, 'gmail-2', 'other')).toEqual(['INBOX', 'UNREAD'])

    const scoped = runMailQuickAction(database, triage(database), [{ accountId: 'imap-1', threadIds: ['imap'] }])
    expect(scoped.result.failures[0]).toMatchObject({ accountId: 'imap-1', error: 'This quick action only applies to gmail-1@example.com' })

    database.replaceLabels('gmail-1', [])
    const stale = runMailQuickAction(database, triage(database, { shortcut: 2 }), [{ accountId: 'gmail-1', threadIds: ['mine'] }])
    expect(stale.result.operations).toEqual([])
    expect(stale.result.failures).toEqual([{ accountId: 'gmail-1', threadCount: 1, step: 2, appliedSteps: 0, error: expect.stringMatching(/“Label_1” no longer exists/) }])

    const imapLabel = database.saveQuickAction({ name: 'IMAP label', accountId: 'imap-1', steps: [{ action: 'label', labelId: 'folder:Done' }], showInToolbar: false })
    expect(runMailQuickAction(database, imapLabel, [{ accountId: 'imap-1', threadIds: ['imap'] }]).result.failures[0].error).toMatch(/folders instead of labels/)
    const imapMove = database.saveQuickAction({ name: 'IMAP done', accountId: 'imap-1', steps: [{ action: 'read' }, { action: 'move', labelId: 'folder:Done' }], showInToolbar: false })
    expect(runMailQuickAction(database, imapMove, [{ accountId: 'imap-1', threadIds: ['imap'] }]).result).toMatchObject({ updatedThreads: 1, failures: [] })
    expect(labelsOf(database, 'imap-1', 'imap')).toEqual(['folder:Done'])
  })

  it('stops the remaining steps for an account when a step fails mid-sequence and reports what was applied', () => {
    const { database } = open()
    database.upsertMessage(message({ threadId: 'a' }))
    database.upsertMessage(message({ accountId: 'gmail-2', threadId: 'b' }))
    let calls = 0
    const flaky = {
      getAccount: database.getAccount.bind(database),
      listLabels: database.listLabels.bind(database),
      applyLocalAction: (...args: Parameters<MailDatabase['applyLocalAction']>) => {
        calls += 1
        if (calls === 2) throw new Error('Conversation a was not found')
        return database.applyLocalAction(...args)
      }
    }
    const global = database.saveQuickAction({ name: 'Three steps', steps: [{ action: 'read' }, { action: 'star' }, { action: 'archive' }], showInToolbar: false })
    const { result, changed } = runMailQuickAction(flaky, global, [{ accountId: 'gmail-1', threadIds: ['a'] }, { accountId: 'gmail-2', threadIds: ['b'] }])
    expect(result.failures).toEqual([{ accountId: 'gmail-1', threadCount: 1, step: 1, appliedSteps: 1, error: 'Conversation a was not found' }])
    expect(result.updatedThreads).toBe(1)
    expect(result.operations.map((operation) => [operation.accountId, operation.kind])).toEqual([['gmail-1', 'read'], ['gmail-2', 'read'], ['gmail-2', 'star'], ['gmail-2', 'archive']])
    expect(changed.map((target) => target.accountId)).toEqual(['gmail-1', 'gmail-2'])
    expect(labelsOf(database, 'gmail-1', 'a')).toEqual(['INBOX'])
  })
})
