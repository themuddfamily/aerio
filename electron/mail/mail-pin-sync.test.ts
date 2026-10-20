import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { MailDatabase, type ParsedMailMessage } from './database'
import { AERIO_PIN_LABEL, imapPinSupport } from '../../src/mail-pin-sync-types'

const directories: string[] = [], open: MailDatabase[] = []
const supported = imapPinSupport({ permanentFlags: new Set(['\\*']) })
function setup(provider: 'imap' | 'gmail' | 'microsoft' | 'exchange' | 'local' = 'imap', capable = true) {
  const directory = mkdtempSync(join(tmpdir(), 'aerio-pin-sync-')); directories.push(directory)
  const path = join(directory, 'aerio.sqlite'), db = new MailDatabase(path, join(directory, 'mail')); open.push(db)
  db.upsertAccount({ id: 'a', provider, email: 'a@example.test', displayName: 'A', color: '#000', status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true })
  if (capable) db.pinSync.recordFolder('a', 'INBOX', supported)
  const message = (id: string, labels = ['INBOX']): ParsedMailMessage => ({ accountId: 'a', id, threadId: id, historyId: `1:${id === 'one' ? 7 : 8}`, references: [], internalDate: '2026-10-20T09:00:00Z', fromName: 'Sender', fromEmail: 'sender@example.test', to: ['a@example.test'], cc: [], subject: id, snippet: 'text', text: 'text', html: '', labelIds: labels, rawPath: `${id}.eml`, sizeEstimate: 10, attachments: [], remoteFolderId: 'INBOX', remoteUid: id === 'one' ? '7' : '8' })
  db.upsertMessage(message('one')); db.upsertMessage(message('two'))
  return { db, path, directory, message }
}
afterEach(() => { for (const db of open.splice(0)) db.close(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('dedicated IMAP pin synchronization', () => {
  it('reports permanent keyword support without treating star, importance, or read-only flags as pins', () => {
    expect(supported.mode).toBe('imap-keyword')
    expect(imapPinSupport({ permanentFlags: new Set(['$AerioPinned']) }).mode).toBe('imap-keyword')
    expect(imapPinSupport({ permanentFlags: new Set(['\\Flagged', '$Important']) }).mode).toBe('local-only')
    expect(imapPinSupport({ permanentFlags: new Set(['\\*']), readOnly: true }).mode).toBe('local-only')
  })

  it('queues supported pins durably, restores interrupted work, and keeps flags independent', () => {
    const { db, path, directory } = setup(); db.reconcileImapPins('a')
    const operation = db.applyLocalAction({ accountId: 'a', threadIds: ['one'], action: 'pin' }, 'pin', 0)
    expect(operation.status).toBe('queued')
    expect(db.listThreads({ folder: 'all' }).items.find((row) => row.id === 'one')).toMatchObject({ pinned: true, starred: false, important: false, pinSync: { mode: 'imap-keyword' } })
    db.updateOperation('pin', 'running')
    const reopened = new MailDatabase(path, join(directory, 'mail')); open.push(reopened)
    reopened.recoverInterruptedWork()
    expect(reopened.dueOperations()).toContainEqual(expect.objectContaining({ id: 'pin', status: 'queued' }))
    expect(reopened.pins.pinnedAt('a', 'one')).toBeTruthy()
  })

  it.each(['gmail', 'microsoft', 'exchange', 'local'] as const)('keeps %s pins explicitly local and out of the provider queue', (provider) => {
    const { db } = setup(provider)
    expect(db.applyLocalAction({ accountId: 'a', threadIds: ['one'], action: 'pin' }, 'pin', 0).status).toBe('succeeded')
    expect(db.dueOperations()).toEqual([])
    expect(db.listThreads({ folder: 'all' }).items.find((row) => row.id === 'one')?.pinSync?.mode).toBe('local-only')
  })

  it('reads remote pins and external unpins while protecting pending local intent', () => {
    const { db, message } = setup()
    db.upsertMessage(message('one', ['INBOX', AERIO_PIN_LABEL, 'STARRED']))
    db.reconcileImapPins('a')
    expect(db.pins.pinnedAt('a', 'one')).toBeTruthy()
    db.applyLocalAction({ accountId: 'a', threadIds: ['one'], action: 'unpin' }, 'unpin', 0)
    db.reconcileImapPins('a')
    expect(db.pins.pinnedAt('a', 'one')).toBeUndefined()
    db.pinSync.acknowledge('a', [{ folder: 'INBOX', uid: 7, pinned: false }]); db.updateOperation('unpin', 'succeeded'); db.reconcileImapPins('a')
    expect(db.pins.pinnedAt('a', 'one')).toBeUndefined()
    db.updateMessageLabels('a', 'one', ['INBOX', AERIO_PIN_LABEL], '1:7'); db.reconcileImapPins('a')
    expect(db.pins.pinnedAt('a', 'one')).toBeTruthy()
    db.updateMessageLabels('a', 'one', ['INBOX', 'STARRED', 'IMPORTANT'], '1:7'); db.reconcileImapPins('a')
    expect(db.pins.pinnedAt('a', 'one')).toBeUndefined()
  })

  it('migrates existing local pins once when permanent keyword capability is first verified', () => {
    const { db } = setup('imap', false)
    db.applyLocalAction({ accountId: 'a', threadIds: ['one'], action: 'pin' }, 'local', 0)
    const at = db.pins.pinnedAt('a', 'one')
    db.pinSync.recordFolder('a', 'INBOX', supported); db.reconcileImapPins('a'); db.reconcileImapPins('a')
    expect(db.dueOperations()).toHaveLength(1)
    expect(db.pins.pinnedAt('a', 'one')).toBe(at)
  })

  it('undo cancels an unsent pin and compensates sent writes with exact mixed prior state', () => {
    const { db } = setup(); db.reconcileImapPins('a')
    db.applyLocalAction({ accountId: 'a', threadIds: ['one'], action: 'pin' }, 'unsent', 0)
    expect(db.undoOperation('unsent')).toBe(true); expect(db.dueOperations()).toHaveLength(0)
    db.pins.set('a', ['one'], true, '2026-10-01T00:00:00Z')
    db.applyLocalAction({ accountId: 'a', threadIds: ['one', 'two'], action: 'pin' }, 'sent', 0)
    db.pinSync.acknowledge('a', [{ folder: 'INBOX', uid: 7, pinned: true }, { folder: 'INBOX', uid: 8, pinned: true }]); db.updateOperation('sent', 'succeeded')
    expect(db.undoOperation('sent')).toBe(true)
    expect(db.pins.pinnedAt('a', 'one')).toBe('2026-10-01T00:00:00Z'); expect(db.pins.pinnedAt('a', 'two')).toBeUndefined()
    expect(db.dueOperations().map((row) => [row.kind, JSON.parse(String(row.thread_ids_json))])).toEqual([['pin', ['one']], ['unpin', ['two']]])
  })

  it('provider failure restores its snapshot while a later local change remains authoritative', () => {
    const { db } = setup(); db.reconcileImapPins('a')
    db.applyLocalAction({ accountId: 'a', threadIds: ['one'], action: 'pin' }, 'failed', 0)
    db.restoreOperationSnapshot('failed', 'failed', 'IMAP refused STORE')
    expect(db.pins.pinnedAt('a', 'one')).toBeUndefined()
    db.applyLocalAction({ accountId: 'a', threadIds: ['one'], action: 'pin' }, 'older', 0)
    db.applyLocalAction({ accountId: 'a', threadIds: ['one'], action: 'pin' }, 'newer', 0)
    db.restoreOperationSnapshot('older', 'failed', 'IMAP unavailable')
    expect(db.pins.pinnedAt('a', 'one')).toBeTruthy()
    expect(db.dueOperations().map((row) => row.id)).toEqual(['newer'])
  })

  it('suppresses old retries after a newer pin decision so stale writes cannot win', () => {
    const { db } = setup(); db.reconcileImapPins('a')
    db.applyLocalAction({ accountId: 'a', threadIds: ['one', 'two'], action: 'pin' }, 'older', 0)
    db.applyLocalAction({ accountId: 'a', threadIds: ['one'], action: 'unpin' }, 'newer', 0)
    expect(db.pinSync.activeThreadIds('a', 'older', ['one', 'two'])).toEqual(['two'])
    db.updateOperation('newer', 'succeeded')
    expect(db.pinSync.activeThreadIds('a', 'older', ['one'])).toEqual([])
    expect(db.pinSync.activeThreadIds('a', 'newer', ['one'])).toEqual(['one'])
  })
})
