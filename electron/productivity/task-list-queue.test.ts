import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskStore } from './task-store'
import { TaskSyncEngine } from './task-sync-engine'
import { ProductivityApiError } from './connector'
import type { ProviderTask, TaskProviderConnector } from '../../src/task-provider-types'

const list = { id: 'account:list', accountId: 'account', provider: 'gmail' as const, remoteId: 'list', title: 'Work', revision: 'list-v1', readOnly: false }
const task: ProviderTask = { id: 'account:list:task', accountId: 'account', provider: 'gmail', remoteId: 'task', listId: list.id, remoteListId: 'list', title: 'Task', completed: false, revision: 'v1', readOnly: false }
let directory: string, path: string, store: TaskStore, connector: TaskProviderConnector, engine: TaskSyncEngine, online: boolean
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'aerio-task-list-')); path = join(directory, 'tasks.sqlite')
  store = new TaskStore(path)
  store.replaceProviderSnapshot('account', 'gmail', { lists: [list], tasks: [task], checkpoints: { [list.id]: '2026-10-01T00:00:00Z' } })
  connector = { provider: 'gmail', capabilities: { recurrence: 'local', priority: 'local', due: 'date', subtasks: 'tasks' }, sync: vi.fn(), createList: vi.fn(async (title) => ({ ...list, id: 'account:created', remoteId: 'created', title, revision: 'created-v1' })), updateList: vi.fn(async (base, title) => ({ ...base, title, revision: 'list-v2' })), deleteList: vi.fn(async () => {}), createTask: vi.fn(), updateTask: vi.fn(), deleteTask: vi.fn(), moveTask: vi.fn() }
  online = true
  engine = new TaskSyncEngine(store, { online: () => online, connector: () => connector })
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

describe('durable provider list changes', () => {
  it('persists offline creation without inventing a remote list and dispatches it once when online', async () => {
    online = false
    const operation = store.listQueue.enqueue('account', 'gmail', 'create', '  New list  ')
    await engine.flush()
    expect(connector.createList).not.toHaveBeenCalled()
    expect(store.providerSnapshot('account', 'gmail').lists).toEqual([list])
    store.close(); store = new TaskStore(path)
    expect(store.listQueue.operations()[0]).toMatchObject({ id: operation.id, title: 'New list', status: 'queued', attempts: 0 })
    engine = new TaskSyncEngine(store, { online: () => true, connector: () => connector })
    await engine.flush(); await engine.flush()
    expect(connector.createList).toHaveBeenCalledExactlyOnceWith('New list')
    expect(store.providerSnapshot('account', 'gmail').lists.map((list) => list.title)).toEqual(['Work', 'New list'])
    expect(store.listQueue.operations()[0].status).toBe('succeeded')
  })

  it('retains the original revision after external refresh and records explicit conflict retry history', async () => {
    const operation = store.listQueue.enqueue('account', 'gmail', 'update', 'My name', list.id)
    store.replaceProviderSnapshot('account', 'gmail', { lists: [{ ...list, title: 'Their name', revision: 'external-v2' }], tasks: [task], checkpoints: {} })
    vi.mocked(connector.updateList).mockRejectedValueOnce(new ProductivityApiError('conflict', 'gmail', 412))
    await engine.flush()
    expect(connector.updateList).toHaveBeenCalledWith(list, 'My name')
    expect(store.listQueue.operations()[0].status).toBe('conflict')
    expect(() => store.listQueue.resolve(operation.id, { action: 'retry', expectedRevision: 'list-v1' })).toThrow('revision changed')
    store.listQueue.resolve(operation.id, { action: 'retry', expectedRevision: 'external-v2' })
    await engine.flush()
    expect(store.listQueue.operations()[0]).toMatchObject({ status: 'succeeded', attempts: 2, history: [{ previousStatus: 'conflict', previousBase: { revision: 'list-v1' } }] })
    expect(store.providerSnapshot('account', 'gmail').lists[0].title).toBe('My name')
  })

  it('holds interrupted writes on restart and refuses a blind retry of an uncertain creation', () => {
    const operation = store.listQueue.enqueue('account', 'gmail', 'create', 'Maybe created')
    store.listQueue.start(operation.id)
    store.close(); store = new TaskStore(path)
    expect(store.listQueue.operations()[0]).toMatchObject({ status: 'review', error: 'interrupted-write', attempts: 1 })
    expect(() => store.listQueue.resolve(operation.id, { action: 'retry' })).toThrow('Confirm')
    store.listQueue.resolve(operation.id, { action: 'retry', confirmedNotApplied: true })
    expect(store.listQueue.operations()[0].status).toBe('queued')
  })

  it('confirms a matching lost create response without issuing another request and rejects old or already claimed lists', async () => {
    const operation = store.listQueue.enqueue('account', 'gmail', 'create', 'Work')
    vi.mocked(connector.createList).mockRejectedValueOnce(new Error('lost response'))
    await engine.flush(); await engine.flush()
    expect(connector.createList).toHaveBeenCalledTimes(1)
    expect(() => store.listQueue.resolve(operation.id, { action: 'accept', remoteId: list.id, expectedRevision: list.revision })).toThrow('newly created')
    const created = { ...list, id: 'account:created', remoteId: 'created', revision: 'new-v1' }
    store.replaceProviderSnapshot('account', 'gmail', { lists: [list, created], tasks: [task], checkpoints: {} })
    expect(() => store.listQueue.resolve(operation.id, { action: 'accept', remoteId: created.id, expectedRevision: 'wrong' })).toThrow('matching')
    store.listQueue.resolve(operation.id, { action: 'accept', remoteId: created.id, expectedRevision: created.revision })
    await engine.flush()
    expect(connector.createList).toHaveBeenCalledTimes(1)
    expect(store.listQueue.operations()[0].result?.id).toBe(created.id)
  })

  it('rejects list deletion with pending task changes and prevents edits or another list change during a queued deletion', () => {
    const id = store.entities('account', 'gmail')[0].id
    const edit = store.update(id, { title: 'Pending' })
    expect(() => store.listQueue.enqueue('account', 'gmail', 'delete', undefined, list.id)).toThrow('pending task changes')
    store.undo(edit.id)
    const deletion = store.listQueue.enqueue('account', 'gmail', 'delete', undefined, list.id)
    expect(() => store.update(id, { title: 'Too late' })).toThrow('pending list deletion')
    expect(() => store.create('account', 'gmail', list.id, { title: 'Too late', completed: false })).toThrow('pending list deletion')
    expect(() => store.listQueue.enqueue('account', 'gmail', 'update', 'Rename', list.id)).toThrow('pending change')
    store.listQueue.resolve(deletion.id, { action: 'discard' })
    expect(store.update(id, { title: 'Allowed again' }).status).toBe('queued')
  })

  it('does not claim one remote list for two uncertain creations with the same title', () => {
    const first = store.listQueue.enqueue('account', 'gmail', 'create', 'Repeated name')
    const second = store.listQueue.enqueue('account', 'gmail', 'create', 'Repeated name')
    for (const operation of [first, second]) { store.listQueue.start(operation.id); store.listQueue.fail(operation.id, 'review', 'uncertain-write') }
    const created = { ...list, id: 'account:created', remoteId: 'created', title: 'Repeated name', revision: 'new-v1' }
    store.replaceProviderSnapshot('account', 'gmail', { lists: [list, created], tasks: [task], checkpoints: {} })
    store.listQueue.resolve(first.id, { action: 'accept', remoteId: created.id, expectedRevision: created.revision })
    expect(() => store.listQueue.resolve(second.id, { action: 'accept', remoteId: created.id, expectedRevision: created.revision })).toThrow('another creation')
    expect(store.listQueue.operations()[1].status).toBe('review')
  })

  it('does not delete lists containing assigned or read-only tasks, including protection gained after enqueue', async () => {
    store.replaceProviderSnapshot('account', 'gmail', { lists: [list], tasks: [{ ...task, assigned: true }], checkpoints: {} })
    expect(() => store.listQueue.enqueue('account', 'gmail', 'delete', undefined, list.id)).toThrow('read-only tasks')
    store.replaceProviderSnapshot('account', 'gmail', { lists: [list], tasks: [task], checkpoints: {} })
    store.listQueue.enqueue('account', 'gmail', 'delete', undefined, list.id)
    store.replaceProviderSnapshot('account', 'gmail', { lists: [list], tasks: [{ ...task, readOnly: true }], checkpoints: {} })
    await engine.flush()
    expect(connector.deleteList).not.toHaveBeenCalled()
    expect(store.listQueue.operations()[0]).toMatchObject({ status: 'failed', error: 'precondition' })
    expect(store.entities('account', 'gmail')).toHaveLength(1)
  })

  it.each([undefined, 404])('deletes list caches and child visibility atomically after provider acceptance (%s)', async (status) => {
    if (status) vi.mocked(connector.deleteList).mockRejectedValueOnce(new ProductivityApiError('missing', 'gmail', status))
    store.listQueue.enqueue('account', 'gmail', 'delete', undefined, list.id)
    await engine.flush()
    expect(store.providerSnapshot('account', 'gmail')).toEqual({ lists: [], tasks: [], checkpoints: {} })
    expect(store.entities('account', 'gmail')).toEqual([])
    expect(store.listQueue.operations()[0].status).toBe('succeeded')
    expect(store.exportBackup().entities).toHaveLength(1)
  })

  it('holds accepted list writes when saving the result fails and rolls back cache changes', async () => {
    store.listQueue.enqueue('account', 'gmail', 'create', 'Created')
    const db = new DatabaseSync(path)
    db.exec("CREATE TRIGGER fail_list_acceptance BEFORE UPDATE ON task_list_operations WHEN NEW.status='succeeded' BEGIN SELECT RAISE(ABORT,'fixture'); END")
    db.close()
    await engine.flush(); await engine.flush()
    expect(connector.createList).toHaveBeenCalledTimes(1)
    expect(store.listQueue.operations()[0].status).toBe('review')
    expect(store.providerSnapshot('account', 'gmail').lists).toEqual([list])
  })

  it('backs up list original revisions and review history, holds restored writes, and accepts legacy backups', () => {
    const operation = store.listQueue.enqueue('account', 'gmail', 'update', 'Renamed', list.id)
    store.listQueue.start(operation.id); store.listQueue.fail(operation.id, 'conflict', 'revision-conflict')
    store.listQueue.resolve(operation.id, { action: 'retry', expectedRevision: list.revision })
    const backup = store.exportBackup()
    store.restoreBackup(backup)
    expect(store.listQueue.operations()[0]).toMatchObject({ id: operation.id, status: 'review', error: 'restored-write', base: { revision: 'list-v1' }, history: [{ previousStatus: 'conflict' }] })
    expect(store.listQueue.next(Date.now(), () => true)).toBeUndefined()
    delete backup.listOperations
    store.restoreBackup(backup)
    expect(store.listQueue.operations()).toEqual([])
  })

  it.each([
    (backup: any) => { backup.listOperations[0].base.accountId = 'foreign' },
    (backup: any) => { backup.listOperations[0].title = '' },
    (backup: any) => { backup.listOperations[0].sequence = 0 },
    (backup: any) => { backup.listOperations[0].attempts = -1 },
    (backup: any) => { backup.listOperations.push(structuredClone(backup.listOperations[0])) },
    (backup: any) => { backup.listOperations[0].credentials = 'unexpected' },
    (backup: any) => { backup.listOperations[0].history = [{ resolvedAt: '2026-10-01T00:00:00Z', previousStatus: 'conflict', previousBase: { ...list, provider: 'microsoft' }, resolution: { action: 'discard' } }] },
    (backup: any) => { backup.listOperations[0].status = 'succeeded' },
  ])('rejects malformed list backup state without changing existing tasks or queue (%#)', (mutate) => {
    store.listQueue.enqueue('account', 'gmail', 'update', 'Preserved', list.id)
    const backup = store.exportBackup(), previous = store.listQueue.operations()
    mutate(backup)
    expect(() => store.restoreBackup(backup)).toThrow('invalid or unsupported')
    expect(store.listQueue.operations()).toEqual(previous)
    expect(store.entities('account', 'gmail')[0].fields.title).toBe('Task')
  })

  it('rolls back a failed restore including the original list queue', () => {
    const original = store.listQueue.enqueue('account', 'gmail', 'create', 'Original intent')
    const backup = store.exportBackup()
    const db = new DatabaseSync(path)
    db.exec("CREATE TRIGGER fail_restore_list BEFORE INSERT ON task_list_operations BEGIN SELECT RAISE(ABORT,'restore fixture'); END")
    db.close()
    expect(() => store.restoreBackup(backup)).toThrow('restore fixture')
    expect(store.listQueue.operations()[0]).toMatchObject({ id: original.id, title: 'Original intent', status: 'queued' })
    expect(store.entities('account', 'gmail')[0].fields.title).toBe('Task')
  })

  it('removes list operation history together with a deleted account', () => {
    store.listQueue.enqueue('account', 'gmail', 'create', 'Pending')
    store.removeAccount('account')
    expect(store.listQueue.operations()).toEqual([])
    expect(store.exportBackup().accounts).toEqual([])
  })

  it.each([401, 403, 500, 408, 412])('classifies HTTP %s without silently retrying', async (status) => {
    store.listQueue.enqueue('account', 'gmail', 'create', 'New')
    vi.mocked(connector.createList).mockRejectedValue(new ProductivityApiError('secret provider payload', 'gmail', status))
    await engine.flush(); await engine.flush()
    expect(connector.createList).toHaveBeenCalledTimes(1)
    expect(store.listQueue.operations()[0].status).toBe([401, 403].includes(status) ? 'failed' : status === 412 ? 'conflict' : 'review')
    expect(JSON.stringify(store.listQueue.operations())).not.toContain('secret provider payload')
  })
})
