import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MailDatabase } from './database'
import { taskItip, parseTaskItip } from '../../src/lib/task-delegation-itip'
import type { DelegatedTask } from '../../src/task-delegation-types'
const roots: string[] = [], databases: MailDatabase[] = []
function device(email: string) {
  const root = mkdtempSync(join(tmpdir(), 'aerio-delegation-')); roots.push(root)
  const open = () => { const db = new MailDatabase(join(root, 'mail.sqlite'), join(root, 'mail')); databases.push(db); return db }
  const db = open()
  db.upsertAccount({ id: email, email, provider: 'imap', displayName: email, color: '#6558e8', status: 'paused', archived: false, signature: '', notifications: false, syncEnabled: false })
  return { db, root, open, accountId: email, receive: (source: MailDatabase, task: DelegatedTask) => db.taskDelegations.observe(email, task.role === 'organizer' ? task.organizer : task.assignee, [email], [source.taskDelegations.calendar(task.deliveries[0].id)!.ics])! }
}
afterEach(() => { for (const db of databases.splice(0)) { try { db.close() } catch {} } for (const root of roots.splice(0)) { expect(relative(tmpdir(), root)).toMatch(/^aerio-delegation-[^\\/]+$/); rmSync(root, { recursive: true, force: true }) } })
describe('durable standards task delegation', () => {
  it('queues real VTODO request/replies and tracks acceptance, progress, completion, updates and cancellation', () => {
    const a = device('organizer@example.test'), b = device('recipient@example.test')
    let sent = a.db.taskDelegations.assign({ accountId: a.accountId, assignee: b.accountId, title: 'Review report', notes: 'Details', due: '2026-12-01', source: { kind: 'local', id: 'source-task' } })
    expect(a.db.getDraftRecord(sent.deliveries[0].id)).toMatchObject({ status: 'send-pending', to: [b.accountId] })
    let received = b.receive(a.db, sent)
    expect(received).toMatchObject({ role: 'assignee', title: 'Review report', participation: 'NEEDS-ACTION' })
    for (const [response, percent, expectedStatus] of [['accept', undefined, 'NEEDS-ACTION'], ['progress', 45, 'IN-PROCESS'], ['complete', undefined, 'COMPLETED']] as const) {
      received = b.db.taskDelegations.respond({ id: received.id, expectedUpdatedAt: received.updatedAt, response, percent })
      const updated = a.receive(b.db, received)
      expect(updated).toMatchObject({ participation: 'ACCEPTED', status: expectedStatus, percent: response === 'complete' ? 100 : percent ?? 0 })
      sent = updated
    }
    sent = a.db.taskDelegations.update({ id: sent.id, expectedUpdatedAt: sent.updatedAt, title: 'Revised report', due: '' })
    received = b.receive(a.db, sent)
    expect(received).toMatchObject({ title: 'Revised report', sequence: 1, participation: 'NEEDS-ACTION' })
    expect(received.due).toBeUndefined()
    received = b.db.taskDelegations.respond({ id: received.id, expectedUpdatedAt: received.updatedAt, response: 'decline', comment: 'Unavailable' })
    sent = a.receive(b.db, received)
    expect(sent).toMatchObject({ participation: 'DECLINED', comment: 'Unavailable' })
    sent = a.db.taskDelegations.update({ id: sent.id, expectedUpdatedAt: sent.updatedAt, cancel: true })
    expect(b.receive(a.db, sent).status).toBe('CANCELLED')
    expect(() => b.db.taskDelegations.respond({ id: received.id, expectedUpdatedAt: received.updatedAt, response: 'accept' })).toThrow()
  })
  it('retains queued calendar payloads and original task links across a database restart', () => {
    const a = device('a@example.test')
    const sent = a.db.taskDelegations.assign({ accountId: a.accountId, assignee: 'b@example.test', title: 'Offline request', source: { kind: 'provider', id: 'provider-task' } })
    a.db.close()
    const restored = a.open(), task = restored.taskDelegations.list()[0]
    expect(task.source).toEqual({ kind: 'provider', id: 'provider-task' })
    expect(restored.queuedDrafts()).toHaveLength(1)
    expect(parseTaskItip(restored.taskDelegations.calendar(sent.deliveries[0].id)!.ics)).toMatchObject({ method: 'REQUEST', title: 'Offline request' })
  })
  it('isolates accounts, rejects forged senders and ignores duplicate/out-of-order updates and replies', () => {
    const a = device('a@example.test'), b = device('b@example.test')
    let sent = a.db.taskDelegations.assign({ accountId: a.accountId, assignee: b.accountId, title: 'Original' })
    const oldIcs = a.db.taskDelegations.calendar(sent.deliveries[0].id)!.ics
    expect(b.db.taskDelegations.observe(b.accountId, 'attacker@example.test', [b.accountId], [oldIcs])).toBeUndefined()
    let received = b.receive(a.db, sent)
    const initialRevision = received.updatedAt
    expect(b.receive(a.db, sent).updatedAt).toBe(initialRevision)
    received = b.db.taskDelegations.respond({ id: received.id, expectedUpdatedAt: received.updatedAt, response: 'accept' })
    const oldReply = b.db.taskDelegations.calendar(received.deliveries[0].id)!.ics
    sent = a.receive(b.db, received)
    const replyRevision = sent.updatedAt
    expect(a.receive(b.db, received)).toBeUndefined()
    expect(a.db.taskDelegations.list()[0].updatedAt).toBe(replyRevision)
    sent = a.db.taskDelegations.update({ id: sent.id, expectedUpdatedAt: sent.updatedAt, title: 'New request' })
    b.receive(a.db, sent)
    expect(b.db.taskDelegations.observe(b.accountId, a.accountId, [b.accountId], [oldIcs])?.title).toBe('New request')
    expect(a.db.taskDelegations.observe(a.accountId, b.accountId, [a.accountId], [oldReply])).toBeUndefined()
    const different = taskItip({ ...parseTaskItip(oldIcs)!, assignee: 'other@example.test' })
    expect(b.db.taskDelegations.observe(b.accountId, a.accountId, [b.accountId], [different])).toBeUndefined()
  })
  it('retains cancellation tombstones when cancellation arrives before the request', () => {
    const a = device('a@example.test'), b = device('b@example.test')
    let sent = a.db.taskDelegations.assign({ accountId: a.accountId, assignee: b.accountId, title: 'Cancelled' })
    const old = a.db.taskDelegations.calendar(sent.deliveries[0].id)!.ics
    sent = a.db.taskDelegations.update({ id: sent.id, expectedUpdatedAt: sent.updatedAt, cancel: true })
    expect(b.receive(a.db, sent).status).toBe('CANCELLED')
    expect(b.db.taskDelegations.observe(b.accountId, a.accountId, [b.accountId], [old])?.status).toBe('CANCELLED')
  })
  it('atomically rolls back the ledger/calendar when durable draft creation fails', () => {
    const a = device('a@example.test')
    vi.spyOn(a.db, 'saveDraft').mockImplementationOnce(() => { throw new Error('Disk failure') })
    expect(() => a.db.taskDelegations.assign({ accountId: a.accountId, assignee: 'b@example.test', title: 'Atomic request' })).toThrow('Disk failure')
    expect(a.db.taskDelegations.list()).toEqual([])
    expect(a.db.queuedDrafts()).toEqual([])
  })
  it('refuses stale edits and progress before acceptance, and only retries failed messages', () => {
    const a = device('a@example.test'), b = device('b@example.test')
    const task = a.db.taskDelegations.assign({ accountId: a.accountId, assignee: b.accountId, title: 'Task' })
    const received = b.receive(a.db, task)
    expect(() => b.db.taskDelegations.respond({ id: received.id, expectedUpdatedAt: received.updatedAt, response: 'progress', percent: 40 })).toThrow('Accept')
    expect(() => a.db.taskDelegations.update({ id: task.id, expectedUpdatedAt: 'stale', title: 'Stale' })).toThrow('Refresh')
    expect(() => a.db.taskDelegations.update({ id: task.id, expectedUpdatedAt: task.updatedAt, cancel: 'yes' as unknown as boolean })).toThrow('Choose whether')
    expect(a.db.taskDelegations.list()[0].status).toBe('NEEDS-ACTION')
    expect(a.db.queuedDrafts()).toHaveLength(1)
    expect(() => a.db.taskDelegations.retry(task.deliveries[0].id)).toThrow('Only failed')
    a.db.updateDraftResult(task.deliveries[0].id, { id: task.deliveries[0].id, status: 'failed', error: 'Connection lost', updatedAt: new Date().toISOString() })
    a.db.taskDelegations.retry(task.deliveries[0].id)
    expect(a.db.getDraftRecord(task.deliveries[0].id)?.status).toBe('send-pending')
  })
})
