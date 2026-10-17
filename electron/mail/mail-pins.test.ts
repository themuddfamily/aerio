import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { MailAccountSummary, MailQuery } from '../../src/mail-types'
import { MailDatabase, type ParsedMailMessage } from './database'
import { decodeMailThreadCursor, encodeMailThreadCursor } from './mail-pins'
import { applyPendingProfileRestore, createProfileBackup, previewProfileBackup, stageProfileRestore } from '../profile-backup'
import { PROFILE_BACKUP_LAYOUT } from '../profile-backup-layout'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) })
const temporary = (name: string) => { const directory = mkdtempSync(join(tmpdir(), `aerio-pins-${name}-`)); directories.push(directory); return directory }

const account = (id: string, email: string): Omit<MailAccountSummary, 'lastSyncAt' | 'error'> => ({
  id, provider: 'gmail', email, displayName: email, color: '#6558e8', status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true
})

function message(threadId: string, date: string, overrides: Partial<ParsedMailMessage> = {}): ParsedMailMessage {
  return {
    accountId: 'account-1', id: `${threadId}-m`, threadId, historyId: '1', internalDate: date, fromName: 'Ada', fromEmail: 'ada@example.com',
    to: ['person@example.com'], cc: [], subject: `Subject ${threadId}`, messageIdHeader: `<${threadId}@example.com>`, references: [], snippet: threadId,
    text: threadId, html: `<p>${threadId}</p>`, labelIds: ['INBOX'], sizeEstimate: 10, rawPath: `${threadId}.eml`, attachments: [], ...overrides
  }
}

function open(directory: string) {
  return new MailDatabase(join(directory, 'aerio.sqlite'), join(directory, 'mail'))
}

/** Five inbox conversations, t1 oldest through t5 newest. */
function setup() {
  const directory = temporary('db')
  const database = open(directory)
  database.upsertAccount(account('account-1', 'person@example.com'))
  for (let index = 1; index <= 5; index++) database.upsertMessage(message(`t${index}`, `2026-09-0${index}T10:00:00.000Z`))
  return { database, directory }
}

const ids = (database: MailDatabase, query: MailQuery = { folder: 'inbox' }) => database.listThreads(query).items.map((item) => item.id)

function allPages(database: MailDatabase, query: MailQuery) {
  const seen: string[] = []
  let cursor: string | undefined
  do {
    const page = database.listThreads({ ...query, cursor })
    seen.push(...page.items.map((item) => item.id))
    cursor = page.nextCursor
  } while (cursor)
  return seen
}

describe('mail conversation pins', () => {
  it('lists pinned conversations first, most recently pinned on top, then newest-first date order', () => {
    const { database } = setup()
    database.applyLocalAction({ accountId: 'account-1', threadIds: ['t1'], action: 'pin' })
    database.pins.set('account-1', ['t3'], true, new Date(Date.now() + 1_000).toISOString())
    const page = database.listThreads({ folder: 'inbox' })
    expect(page.items.map((item) => [item.id, item.pinned])).toEqual([['t3', true], ['t1', true], ['t5', false], ['t4', false], ['t2', false]])
    expect(page.items[0].pinnedAt).toBeTruthy()
    expect(page.total).toBe(5)
    database.close()
  })

  it('pages through mixed pinned and unpinned conversations without gaps or duplicates', () => {
    const { database } = setup()
    database.pins.set('account-1', ['t2'], true, '2026-10-01T00:00:00.000Z')
    database.pins.set('account-1', ['t4'], true, '2026-10-02T00:00:00.000Z')
    for (const pageSize of [1, 2, 3]) {
      expect(allPages(database, { folder: 'inbox', pageSize })).toEqual(['t4', 't2', 't5', 't3', 't1'])
    }
    // A page boundary inside the pinned partition continues into it, and totals ignore the cursor.
    const first = database.listThreads({ folder: 'inbox', pageSize: 1 })
    expect(decodeMailThreadCursor(first.nextCursor!)).toMatchObject({ pinnedAt: '2026-10-02T00:00:00.000Z', id: 't4' })
    const second = database.listThreads({ folder: 'inbox', pageSize: 2, cursor: first.nextCursor })
    expect(second.items.map((item) => item.id)).toEqual(['t2', 't5'])
    expect(second.total).toBe(5)
    database.close()
  })

  it('pins the same thread id independently in each account and in the unified view', () => {
    const { database } = setup()
    database.upsertAccount(account('account-2', 'second@example.com'))
    database.upsertMessage(message('t1', '2026-09-09T10:00:00.000Z', { accountId: 'account-2', id: 'other-t1', rawPath: 'other.eml' }))
    database.applyLocalAction({ accountId: 'account-1', threadIds: ['t1'], action: 'pin' })
    const unified = database.listThreads({ folder: 'inbox' }).items.map((item) => `${item.accountId}:${item.id}:${item.pinned}`)
    expect(unified.slice(0, 2)).toEqual(['account-1:t1:true', 'account-2:t1:false'])
    expect(database.listThreads({ folder: 'inbox', accountIds: ['account-2'] }).items[0].pinned).toBe(false)
    expect(allPages(database, { folder: 'inbox', pageSize: 2 })).toHaveLength(6)
    expect(() => database.applyLocalAction({ accountId: 'account-2', threadIds: ['missing'], action: 'pin' })).toThrow('was not found')
    database.close()
  })

  it('keeps pinned ordering when new mail arrives in pinned or unpinned conversations', () => {
    const { database } = setup()
    database.pins.set('account-1', ['t1'], true, '2026-10-01T00:00:00.000Z')
    database.pins.set('account-1', ['t2'], true, '2026-10-02T00:00:00.000Z')
    expect(ids(database)).toEqual(['t2', 't1', 't5', 't4', 't3'])
    // A reply in the older pin and a brand-new conversation both arrive.
    database.upsertMessage(message('t1', '2026-09-20T10:00:00.000Z', { id: 't1-reply', rawPath: 't1-reply.eml' }))
    database.upsertMessage(message('t6', '2026-09-21T10:00:00.000Z'))
    expect(ids(database)).toEqual(['t2', 't1', 't6', 't5', 't4', 't3'])
    database.close()
  })

  it('undoes pin and unpin exactly, preserving conversations that were already pinned', () => {
    const { database } = setup()
    database.pins.set('account-1', ['t1'], true, '2026-10-01T00:00:00.000Z')
    const pin = database.applyLocalAction({ accountId: 'account-1', threadIds: ['t1', 't2'], action: 'pin' })
    expect(pin).toMatchObject({ kind: 'pin', status: 'succeeded' })
    expect(pin.undoUntil).toBeTruthy()
    expect(database.pins.pinnedAt('account-1', 't1')).toBe('2026-10-01T00:00:00.000Z')
    expect(database.undoOperation(pin.id)).toBe(true)
    expect(database.pins.pinnedAt('account-1', 't1')).toBe('2026-10-01T00:00:00.000Z')
    expect(database.pins.pinnedAt('account-1', 't2')).toBeUndefined()
    expect(database.undoOperation(pin.id)).toBe(false)

    const unpin = database.applyLocalAction({ accountId: 'account-1', threadIds: ['t1'], action: 'unpin' })
    expect(ids(database)[0]).toBe('t5')
    expect(database.undoOperation(unpin.id)).toBe(true)
    expect(database.listThreads({ folder: 'inbox' }).items[0]).toMatchObject({ id: 't1', pinnedAt: '2026-10-01T00:00:00.000Z' })
    database.close()
  })

  it('never queues pins for a provider and leaves stars and importance untouched', () => {
    const { database } = setup()
    database.applyLocalAction({ accountId: 'account-1', threadIds: ['t3'], action: 'star' }, crypto.randomUUID(), 0)
    database.applyLocalAction({ accountId: 'account-1', threadIds: ['t3', 't4'], action: 'pin' }, crypto.randomUUID(), 0)
    expect(database.dueOperations(100).map((row) => String(row.kind))).toEqual(['star'])
    const byId = Object.fromEntries(database.listThreads({ folder: 'inbox' }).items.map((item) => [item.id, item]))
    expect(byId.t3).toMatchObject({ pinned: true, starred: true, important: false })
    expect(byId.t4).toMatchObject({ pinned: true, starred: false })
    expect(database.getThread('account-1', 't4').messages[0].labelIds).toEqual(['INBOX'])
    database.applyLocalAction({ accountId: 'account-1', threadIds: ['t3'], action: 'unstar' }, crypto.randomUUID(), 0)
    database.applyLocalAction({ accountId: 'account-1', threadIds: ['t4'], action: 'important' }, crypto.randomUUID(), 0)
    const after = Object.fromEntries(database.listThreads({ folder: 'inbox' }).items.map((item) => [item.id, item]))
    expect(after.t3).toMatchObject({ pinned: true, starred: false })
    expect(after.t4).toMatchObject({ pinned: true, important: true })
    expect(database.listThreads({ folder: 'starred' }).total).toBe(0)
    database.close()
  })

  it('survives a restart, a resync that rebuilds the conversation, and archiving the account', () => {
    const { database, directory } = setup()
    database.applyLocalAction({ accountId: 'account-1', threadIds: ['t2'], action: 'pin' })
    database.close()
    const reopened = open(directory)
    expect(ids(reopened)[0]).toBe('t2')
    // Resync drops the cached thread and downloads it again.
    reopened.deleteMessage('account-1', 't2-m')
    expect(ids(reopened)).not.toContain('t2')
    reopened.upsertMessage(message('t2', '2026-09-02T10:00:00.000Z'))
    expect(reopened.listThreads({ folder: 'inbox' }).items[0]).toMatchObject({ id: 't2', pinned: true })
    reopened.disconnectAccount('account-1', 'archive')
    expect(reopened.listThreads({ folder: 'inbox' }).items[0]).toMatchObject({ id: 't2', pinned: true })
    reopened.disconnectAccount('account-1', 'delete')
    expect(reopened.pins.count()).toBe(0)
    reopened.close()
  })

  it('reads cursors issued before pinning as the unpinned partition and tolerates malformed cursors', () => {
    const legacy = Buffer.from(JSON.stringify({ date: '2026-09-04T10:00:00.000Z', id: 't4', accountId: 'account-1' })).toString('base64url')
    expect(decodeMailThreadCursor(legacy)).toEqual({ pinnedAt: '', date: '2026-09-04T10:00:00.000Z', id: 't4', accountId: 'account-1' })
    expect(decodeMailThreadCursor('not json')).toEqual({ pinnedAt: '', date: '', id: '', accountId: '' })
    const round = { pinnedAt: '2026-10-01T00:00:00.000Z', date: 'd', id: 'i', accountId: 'a' }
    expect(decodeMailThreadCursor(encodeMailThreadCursor(round))).toEqual(round)
    const { database } = setup()
    expect(database.listThreads({ folder: 'inbox', cursor: legacy }).items.map((item) => item.id)).toEqual(['t3', 't2', 't1'])
    database.close()
  })

  it('is included in profile backups and restored with the mail database', async () => {
    const profile = temporary('profile')
    const state = new DatabaseSync(join(profile, 'aerio-state.sqlite'))
    state.exec(`CREATE TABLE app_preferences (id INTEGER PRIMARY KEY CHECK (id = 1), schema_version INTEGER NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL)`)
    state.prepare('INSERT INTO app_preferences VALUES(1,1,?,?)').run('{"settings":{}}', '2026-10-01T00:00:00Z')
    state.close()
    const database = open(profile)
    database.upsertAccount(account('account-1', 'person@example.com'))
    database.upsertMessage(message('t1', '2026-09-01T10:00:00.000Z'))
    database.upsertMessage(message('t2', '2026-09-02T10:00:00.000Z'))
    database.applyLocalAction({ accountId: 'account-1', threadIds: ['t1'], action: 'pin' })
    database.close()
    const { path } = await createProfileBackup({ userData: profile, directory: temporary('target'), layout: PROFILE_BACKUP_LAYOUT, appVersion: '0.6.0', trigger: 'manual' })
    const preview = await previewProfileBackup(path, profile, PROFILE_BACKUP_LAYOUT)
    expect(preview.counts.find((item) => item.label === 'Pinned conversations')?.count).toBe(1)

    const live = open(profile)
    live.applyLocalAction({ accountId: 'account-1', threadIds: ['t1'], action: 'unpin' })
    live.close()
    await stageProfileRestore({ backupPath: path, userData: profile, layout: PROFILE_BACKUP_LAYOUT })
    expect(applyPendingProfileRestore(profile)).toMatchObject({ status: 'applied' })
    const restored = open(profile)
    try {
      expect(restored.listThreads({ folder: 'inbox' }).items.map((item) => [item.id, item.pinned])).toEqual([['t1', true], ['t2', false]])
    } finally { restored.close() }
  })
})
