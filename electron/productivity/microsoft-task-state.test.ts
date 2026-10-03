import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskStore } from './task-store'
import { TaskSyncEngine } from './task-sync-engine'
import { MicrosoftTasksConnector } from './microsoft-tasks-connector'
import { parseTaskBackup } from './task-backup'
import type { ProviderTask, ProviderTaskList, ProviderTaskSnapshot } from '../../src/task-provider-types'

const base = 'https://graph.microsoft.com/v1.0/me/todo/lists'
const list: ProviderTaskList = { id: 'account:microsoft-task-list:list', accountId: 'account', provider: 'microsoft', remoteId: 'list', title: 'Work', readOnly: false, manageReadOnly: false, revisionMode: 'snapshot', revision: `snapshot:${'1'.repeat(64)}` }
const native = { priority: 'high' as const, status: 'inProgress' as const, dueTimeZone: 'GMT Standard Time', body: { contentType: 'html' as const, content: '<p><b>Original</b> &amp; notes</p>' }, recurrence: { pattern: { type: 'daily' as const, interval: 1 }, range: { type: 'noEnd' as const, startDate: '2026-10-01', recurrenceTimeZone: 'GMT Standard Time' } } }
const remote: ProviderTask = { id: 'account:microsoft-task:list:task', accountId: 'account', provider: 'microsoft', remoteId: 'task', listId: list.id, remoteListId: 'list', title: 'Task', notes: 'Original & notes', completed: false, revision: 'v1', revisionMode: 'etag', kind: 'task', due: '2026-10-05T09:00:00', native, readOnly: false }
const cached = (tasks = [remote]): ProviderTaskSnapshot => ({ lists: [list], tasks, checkpoints: { [list.id]: `${base}/list/tasks/delta()?$deltatoken=opaque%2Btoken` } })
const graph = (task: ProviderTask = remote) => ({ id: task.remoteId, title: task.title, '@odata.etag': task.revision, status: task.completed ? 'completed' : task.native?.status ?? 'notStarted', importance: task.native?.priority, body: task.native?.body, recurrence: task.native?.recurrence, dueDateTime: task.due ? { dateTime: task.due, timeZone: task.native?.dueTimeZone } : null })
const response = (value: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(value), { status })
let directory: string, path: string, store: TaskStore
const connector = () => new MicrosoftTasksConnector('account', async () => 'fixture-token', true)
const engine = (online = true) => new TaskSyncEngine(store, { online: () => online, connector: () => connector() })
const id = () => store.entities('account', 'microsoft')[0].id
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'aerio-ms-task-state-')); path = join(directory, 'tasks.sqlite')
  store = new TaskStore(path); store.replaceProviderSnapshot('account', 'microsoft', cached())
})
afterEach(() => { store.close(); vi.unstubAllGlobals(); rmSync(directory, { recursive: true, force: true }) })

describe('Microsoft native task state', () => {
  it('persists offline native edits, merges fields, and rebases only its own successful successors', async () => {
    const identity = id()
    store.update(identity, { native: { priority: 'low', recurrence: null } })
    store.update(identity, { notes: 'New <notes>' })
    expect(store.entity(identity)?.fields.native).toMatchObject({ priority: 'low', recurrence: null, status: 'inProgress', dueTimeZone: native.dueTimeZone })
    expect(store.entity(identity)?.fields.native?.body).toBeUndefined()
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    await engine(false).flush(); expect(fetch).not.toHaveBeenCalled()
    store.close(); store = new TaskStore(path)
    const first: ProviderTask = { ...remote, revision: 'v2', native: { ...native, priority: 'low', recurrence: null } }
    const second: ProviderTask = { ...first, revision: 'v3', notes: 'New <notes>', native: { ...first.native, body: { contentType: 'html', content: 'New &lt;notes&gt;' } } }
    fetch.mockResolvedValueOnce(response(graph())).mockResolvedValueOnce(response(graph(first))).mockResolvedValueOnce(response(graph(first))).mockResolvedValueOnce(response(graph(second)))
    await engine().flush()
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ title: 'Task', status: 'inProgress', importance: 'low', recurrence: null })
    expect(JSON.parse(fetch.mock.calls[3][1].body)).toEqual({ title: 'Task', status: 'inProgress', body: { contentType: 'html', content: 'New &lt;notes&gt;' } })
    expect(fetch.mock.calls[3][1].headers['If-Match']).toBe('v2')
    expect(store.operations().map((operation) => operation.status)).toEqual(['succeeded', 'succeeded'])
    expect(store.entity(identity)?.remote?.revision).toBe('v3')
  })

  it('undo restores rich notes, native priority/recurrence, and the original progress state', async () => {
    const identity = id()
    const operation = store.update(identity, { notes: 'Changed', completed: true, native: { priority: 'low', recurrence: null } })
    const changed: ProviderTask = { ...remote, revision: 'v2', notes: 'Changed', completed: true, native: { ...native, priority: 'low', status: 'completed', recurrence: null, body: { contentType: 'html', content: 'Changed' } } }
    const fetch = vi.fn().mockResolvedValueOnce(response(graph())).mockResolvedValueOnce(response(graph(changed)))
    vi.stubGlobal('fetch', fetch)
    await engine().flush()
    const undo = store.undo(operation.id)!
    expect(undo.patch).toMatchObject({ notes: remote.notes, completed: false, native: { priority: 'high', recurrence: native.recurrence, status: 'inProgress', body: native.body } })
    fetch.mockResolvedValueOnce(response(graph(changed))).mockResolvedValueOnce(response(graph({ ...remote, revision: 'v3' })))
    await engine().flush()
    expect(JSON.parse(fetch.mock.calls[3][1].body)).toEqual({ title: 'Task', status: 'inProgress', importance: 'high', recurrence: native.recurrence, body: native.body })
    expect(store.entity(identity)?.fields).toMatchObject({ notes: remote.notes, completed: false, native })
    expect(store.operations()).toHaveLength(2)
  })

  it('uses native recurrence without creating a local duplicate on completion', () => {
    store.update(id(), { completed: true })
    expect(store.entities('account', 'microsoft')).toHaveLength(1)
    expect(store.operations()).toHaveLength(1)
    expect(() => store.setLocal(id(), { priority: 'normal', recurrence: 'daily' })).toThrow(/native task fields/)
    expect(() => store.update(id(), { title: 'No change' }, Date.now(), { priority: 'high', recurrence: 'none' })).toThrow(/native task fields/)
    expect(store.operations()).toHaveLength(1)
  })

  it('undo of a native deletion restores rich content and recurrence under the same local identity', async () => {
    const identity = id(), deleted = store.delete(identity)
    const fetch = vi.fn().mockResolvedValueOnce(response(graph())).mockResolvedValueOnce(response(null, 204))
    vi.stubGlobal('fetch', fetch)
    await engine().flush()
    expect(store.entity(identity)).toBeUndefined()
    const undo = store.undo(deleted.id)!
    expect(undo.kind).toBe('create')
    const restored = { ...remote, id: 'account:microsoft-task:list:restored', remoteId: 'restored', revision: 'restored-v1' }
    fetch.mockResolvedValueOnce(response(graph(restored)))
    await engine().flush()
    expect(JSON.parse(fetch.mock.calls[2][1].body)).toMatchObject({ body: native.body, recurrence: native.recurrence, importance: 'high', status: 'inProgress', dueDateTime: { dateTime: remote.due, timeZone: native.dueTimeZone } })
    expect(store.entity(identity)?.remote?.remoteId).toBe('restored')
    expect(store.entities('account', 'microsoft')).toHaveLength(1)
    expect(parseTaskBackup(store.exportBackup()).operations).toHaveLength(2)
  })

  it('holds interrupted native intent after restart and never automatically sends it', async () => {
    const operation = store.update(id(), { native: { priority: 'low', recurrence: null } })
    store.start(operation.id)
    store.close(); store = new TaskStore(path)
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    await engine().flush()
    expect(fetch).not.toHaveBeenCalled()
    expect(store.operations()[0]).toMatchObject({ id: operation.id, status: 'review', error: 'interrupted-write', attempts: 1, patch: { native: { priority: 'low', recurrence: null } }, base: { native } })
  })

  it('retains original native baselines after external refresh and holds stale writes as conflicts', async () => {
    const operation = store.update(id(), { native: { priority: 'low' } })
    const external: ProviderTask = { ...remote, revision: 'external', native: { ...native, recurrence: null } }
    store.replaceProviderSnapshot('account', 'microsoft', cached([external]))
    const fetch = vi.fn().mockResolvedValue(response(graph(external))); vi.stubGlobal('fetch', fetch)
    await engine().flush()
    expect(store.operations()[0]).toMatchObject({ id: operation.id, status: 'conflict', base: { revision: 'v1', native } })
    expect(fetch).toHaveBeenCalledOnce()
    store.resolve(operation.id, { action: 'retry', expectedRevision: 'external' })
    expect(store.resolutionHistory(operation.id)[0].previousBase?.native).toEqual(native)
    expect(store.operations()[0].base?.native?.recurrence).toBeNull()
  })

  it('reconciles a lost native edit using only intended fields and treats an absent recurrence as cleared', () => {
    const operation = store.update(id(), { native: { priority: 'low', recurrence: null } })
    store.start(operation.id); store.fail(operation.id, 'review', 'uncertain-write')
    const applied: ProviderTask = { ...remote, revision: 'v2', native: { ...native, priority: 'low', recurrence: undefined, status: 'waitingOnOthers' } }
    store.replaceProviderSnapshot('account', 'microsoft', cached([applied]))
    expect(store.resolve(operation.id, { action: 'accept', remoteId: remote.id, expectedRevision: 'v2' }).status).toBe('succeeded')
    expect(store.entity(operation.entityId)?.fields.native?.status).toBe('waitingOnOthers')
  })

  it('refuses reconciliation to a different native value', () => {
    const operation = store.update(id(), { native: { priority: 'low' } })
    store.start(operation.id); store.fail(operation.id, 'review', 'uncertain-write')
    expect(() => store.resolve(operation.id, { action: 'accept', remoteId: remote.id, expectedRevision: 'v1' })).toThrow(/native fields/)
    expect(store.operations()[0].status).toBe('review')
  })

  it.each(['2026-10-06', '2026-10-06T10:00:00+02:00'])('matches normalized created due %s without replaying a lost response', (due) => {
    const created = store.create('account', 'microsoft', list.id, { title: 'Created', completed: false, due, native: { priority: 'low', ...(due.length > 10 ? { dueTimeZone: 'Eastern Standard Time' } : {}) } })
    store.start(created.operation.id); store.fail(created.operation.id, 'review', 'uncertain-write')
    const applied: ProviderTask = { ...remote, id: 'account:microsoft-task:list:new', remoteId: 'new', title: 'Created', notes: undefined, due: due.length === 10 ? '2026-10-06T00:00:00.0000000' : '2026-10-06T08:00:00', revision: 'new-v1', native: { priority: 'low', status: 'notStarted', dueTimeZone: 'UTC', recurrence: null } }
    store.replaceProviderSnapshot('account', 'microsoft', cached([remote, applied]))
    expect(store.resolve(created.operation.id, { action: 'accept', remoteId: applied.id, expectedRevision: 'new-v1' }).status).toBe('succeeded')
    expect(store.entity(created.entity.id)?.remote?.remoteId).toBe('new')
    expect(store.operations()).toHaveLength(1)
  })

  it('rejects a normalized due match in a different wall-clock time zone', () => {
    const operation = store.update(id(), { due: '2026-10-06T09:00:00' })
    store.start(operation.id); store.fail(operation.id, 'review', 'uncertain-write')
    store.replaceProviderSnapshot('account', 'microsoft', cached([{ ...remote, revision: 'v2', due: '2026-10-06T09:00:00', native: { ...native, dueTimeZone: 'UTC' } }]))
    expect(() => store.resolve(operation.id, { action: 'accept', remoteId: remote.id, expectedRevision: 'v2' })).toThrow(/due time/)
  })

  it('protects checklist field restrictions and nesting before creating durable work', () => {
    const child = store.create('account', 'microsoft', list.id, { title: 'Step', completed: false }, id())
    expect(() => store.update(child.entity.id, { notes: 'Unsupported' })).toThrow(/completion only/)
    expect(() => store.create('account', 'microsoft', list.id, { title: 'Nested', completed: false }, child.entity.id)).toThrow(/cannot be nested/)
    expect(() => store.move(child.entity.id)).toThrow(/reparenting/)
    expect(store.operations()).toHaveLength(1)
  })

  it('protects managed lists during enqueue and dispatch after permissions change', async () => {
    const operation = store.listQueue.enqueue('account', 'microsoft', 'update', 'Rename', list.id)
    store.replaceProviderSnapshot('account', 'microsoft', { ...cached(), lists: [{ ...list, manageReadOnly: true }] })
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    await engine().flush()
    expect(fetch).not.toHaveBeenCalled()
    expect(store.listQueue.operations()[0]).toMatchObject({ id: operation.id, status: 'failed', error: 'precondition' })
    expect(() => store.listQueue.resolve(operation.id, { action: 'retry', expectedRevision: list.revision })).toThrow(/revision changed/)
    store.listQueue.resolve(operation.id, { action: 'discard' })
    expect(() => store.listQueue.enqueue('account', 'microsoft', 'delete', undefined, list.id)).toThrow(/read-only/)
  })

  it('round trips native bodies, zones, checklist identities and intent while holding restored writes', () => {
    const child: ProviderTask = { ...remote, id: 'account:microsoft-checklist:list:task:child', remoteId: 'child', parentId: remote.id, remoteParentId: remote.remoteId, kind: 'checklist', title: 'Step', notes: undefined, due: undefined, native: undefined, revision: `snapshot:${'2'.repeat(64)}`, revisionMode: 'snapshot' }
    store.replaceProviderSnapshot('account', 'microsoft', cached([remote, child]))
    const identity = id()
    store.update(identity, { native: { priority: 'low', recurrence: null } })
    store.listQueue.enqueue('account', 'microsoft', 'update', 'Rename', list.id)
    const backup = JSON.parse(JSON.stringify(store.exportBackup()))
    expect(parseTaskBackup(backup)).toEqual(backup)
    store.restoreBackup(backup)
    expect(store.entity(identity)?.fields.native).toMatchObject({ priority: 'low', recurrence: null, body: native.body })
    expect(store.operations()[0]).toMatchObject({ status: 'review', error: 'restored-write', base: { native } })
    expect(store.listQueue.operations()[0]).toMatchObject({ status: 'review', error: 'restored-write' })
    expect(store.providerSnapshot('account', 'microsoft').checkpoints).toEqual({})
    store.close(); store = new TaskStore(path)
    expect(store.next()).toBeUndefined()
    expect(store.entity(identity)?.fields.native?.body).toEqual(native.body)
  })

  it('preserves a large cached rich body during title edits and backup without truncation', async () => {
    const content = 'x'.repeat(10_000), large: ProviderTask = { ...remote, notes: content, native: { ...native, body: { contentType: 'html', content: `<p>${content}</p>` } } }
    store.replaceProviderSnapshot('account', 'microsoft', cached([large]))
    store.update(id(), { title: 'Rename' })
    const fetch = vi.fn().mockResolvedValueOnce(response(graph(large))).mockResolvedValueOnce(response(graph({ ...large, title: 'Rename', revision: 'v2' })))
    vi.stubGlobal('fetch', fetch)
    await engine().flush()
    expect(JSON.parse(fetch.mock.calls[1][1].body)).not.toHaveProperty('body')
    expect(store.exportBackup().entities[0].fields.native?.body?.content).toBe(`<p>${content}</p>`)
  })

  it.each(['https://evil.test/token', `${base}/other/tasks/delta?$deltatoken=x`, `${base}/list/tasks/delta?$deltatoken=x#fragment`, `https://user:pass@graph.microsoft.com/v1.0/me/todo/lists/list/tasks/delta?$deltatoken=x`, '2026-10-01T00:00:00Z'])('rejects unsafe Microsoft backup checkpoint %s before replacing the database', (cursor) => {
    const backup = store.exportBackup(); backup.accounts[0].snapshot.checkpoints[list.id] = cursor
    expect(() => store.restoreBackup(backup)).toThrow(/invalid or unsupported/)
    expect(store.entity(id())?.fields.native).toEqual(native)
  })

  it('rejects credentials in native fields and malformed snapshot revision modes', () => {
    const backup = store.exportBackup()
    ;(backup.entities[0].fields.native as unknown as Record<string, unknown>).token = 'secret'
    expect(() => parseTaskBackup(backup)).toThrow(/invalid/)
    const other = store.exportBackup(); other.accounts[0].snapshot.lists[0].revision = 'invented-etag'
    expect(() => parseTaskBackup(other)).toThrow(/invalid/)
  })

  it('rejects restored local recurrence for Microsoft instead of allowing duplicate native occurrences', () => {
    const backup = store.exportBackup(); backup.entities[0].local.recurrence = 'daily'
    expect(() => store.restoreBackup(backup)).toThrow(/invalid/)
    expect(store.entity(id())?.local.recurrence).toBe('none')
  })
})
