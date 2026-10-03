import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskStore } from './task-store'
import { TaskSyncEngine } from './task-sync-engine'
import { ProductivityApiError } from './connector'
import type { ProviderTask, TaskProviderConnector } from '../../src/task-provider-types'

const list = { id: 'account:list', accountId: 'account', provider: 'gmail' as const, remoteId: 'list', title: 'Work', readOnly: false }
const remote: ProviderTask = { id: 'account:list:task', accountId: 'account', provider: 'gmail', remoteId: 'task', listId: list.id, remoteListId: 'list', title: 'Original', notes: 'Notes', completed: false, revision: 'v1', readOnly: false }
let store: TaskStore
let connector: TaskProviderConnector
let online: boolean
let now: number
let engine: TaskSyncEngine
beforeEach(() => {
  store = new TaskStore(':memory:')
  store.replaceProviderSnapshot('account', 'gmail', { lists: [list], tasks: [remote], checkpoints: {} })
  connector = {
    provider: 'gmail', capabilities: { recurrence: 'local', priority: 'local', due: 'date', subtasks: 'tasks' },
    sync: vi.fn(), createList: vi.fn(), updateList: vi.fn(), deleteList: vi.fn(),
    createTask: vi.fn(async (_list, input, parent) => ({ ...remote, ...input, id: 'account:list:new', remoteId: 'new', parentId: parent?.id, revision: 'new-v1' })),
    updateTask: vi.fn(async (current, input) => ({ ...current, ...input, revision: `${current.revision}-next` })),
    deleteTask: vi.fn(async () => {}), moveTask: vi.fn(async (current, parent) => ({ ...current, parentId: parent?.id, revision: `${current.revision}-next` }))
  }
  online = true; now = 1000
  engine = new TaskSyncEngine(store, { online: () => online, connector: () => connector, now: () => now })
})
afterEach(() => store.close())
const id = () => store.entities('account', 'gmail')[0].id

describe('task mutation queue processing', () => {
  it('holds recurring successors when the completion response is uncertain', async () => {
    store.setLocal(id(), { priority: 'normal', recurrence: 'daily' })
    store.update(id(), { completed: true })
    vi.mocked(connector.updateTask).mockRejectedValue(new Error('lost completion response'))
    await engine.flush(); await engine.flush()
    expect(connector.createTask).not.toHaveBeenCalled()
    expect(store.operations().map((operation) => operation.status)).toEqual(['review', 'queued'])
  })

  it('sends a recurring successor only after completion and keeps its local recurrence metadata', async () => {
    const taskId = id()
    store.setLocal(taskId, { priority: 'high', recurrence: 'weekly' })
    store.update(taskId, { completed: true }, Date.parse('2026-10-01T10:00:00Z'))
    const next = store.entities('account', 'gmail').find((task) => task.id !== taskId)!
    await engine.flush()
    expect(connector.updateTask).toHaveBeenCalledExactlyOnceWith(remote, expect.objectContaining({ completed: true }))
    expect(connector.createTask).toHaveBeenCalledExactlyOnceWith(list, expect.objectContaining({ completed: false, due: '2026-10-08' }), undefined)
    expect(store.entity(next.id)).toMatchObject({ remote: { remoteId: 'new' }, local: { priority: 'high', recurrence: 'weekly' } })
    await engine.flush()
    expect(connector.createTask).toHaveBeenCalledTimes(1)
  })

  it('leaves offline operations untouched, then writes successive edits using revisions from its own preceding results', async () => {
    const first = store.update(id(), { title: 'First' })
    store.update(id(), { completed: true })
    online = false
    await engine.flush()
    expect(connector.updateTask).not.toHaveBeenCalled()
    expect(store.operations()[0].attempts).toBe(0)
    online = true
    await engine.flush()
    expect(connector.updateTask).toHaveBeenNthCalledWith(1, remote, { title: 'First', notes: 'Notes', due: undefined, completed: false })
    expect(connector.updateTask).toHaveBeenNthCalledWith(2, expect.objectContaining({ revision: 'v1-next', title: 'First' }), expect.objectContaining({ title: 'First', completed: true }))
    expect(store.operations().map((operation) => operation.status)).toEqual(['succeeded', 'succeeded'])
    expect(() => store.undo(first.id)).toThrow('newer')
  })

  it('runs overlapping flushes once and observes going offline before the next operation', async () => {
    let finish!: (task: ProviderTask) => void
    vi.mocked(connector.updateTask).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    store.update(id(), { title: 'First' })
    store.update(id(), { completed: true })
    const first = engine.flush()
    expect(engine.flush()).toBe(first)
    await vi.waitFor(() => expect(connector.updateTask).toHaveBeenCalledTimes(1))
    online = false
    finish({ ...remote, title: 'First', revision: 'v2' })
    await first
    expect(store.operations().map((operation) => operation.status)).toEqual(['succeeded', 'queued'])
  })

  it('uses the original revision after external refresh and records conflicts without retrying or blocking other tasks', async () => {
    const operation = store.update(id(), { title: 'Offline' })
    store.replaceProviderSnapshot('account', 'gmail', { lists: [list], tasks: [{ ...remote, revision: 'external-v2' }], checkpoints: {} })
    store.create('account', 'gmail', list.id, { title: 'Other', completed: false })
    vi.mocked(connector.updateTask).mockRejectedValue(new ProductivityApiError('private provider details', 'gmail', 412))
    await engine.flush(); await engine.flush()
    expect(connector.updateTask).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ revision: 'v1' }), expect.anything())
    expect(store.operations().find((item) => item.id === operation.id)).toMatchObject({ status: 'conflict', error: 'revision-conflict' })
    expect(connector.createTask).toHaveBeenCalledTimes(1)
  })

  it.each([new Error('socket lost'), new ProductivityApiError('private response', 'gmail', 503), new ProductivityApiError('timeout', 'gmail', 408)])('holds uncertain creations for review without resending (%s)', async (error) => {
    store.create('account', 'gmail', list.id, { title: 'Maybe created', completed: false })
    vi.mocked(connector.createTask).mockRejectedValue(error)
    await engine.flush(); await engine.flush()
    expect(connector.createTask).toHaveBeenCalledTimes(1)
    expect(store.operations()[0]).toMatchObject({ status: 'review', error: 'uncertain-write', attempts: 1 })
    expect(store.entities('account', 'gmail')).toHaveLength(2)
  })

  it('backs off a definite rate-limit rejection and caps retries', async () => {
    store.update(id(), { completed: true })
    vi.mocked(connector.updateTask).mockRejectedValue(new ProductivityApiError('limit', 'gmail', 429))
    await engine.flush()
    expect(store.operations()[0]).toMatchObject({ status: 'queued', retryAt: 2000, attempts: 1 })
    await engine.flush()
    expect(connector.updateTask).toHaveBeenCalledTimes(1)
    for (let attempt = 2; attempt <= 5; attempt++) { now = store.operations()[0].retryAt; await engine.flush() }
    expect(connector.updateTask).toHaveBeenCalledTimes(5)
    expect(store.operations()[0]).toMatchObject({ status: 'failed', error: 'rate-limit-exhausted' })
  })

  it('treats an already absent deletion as success and restores it through a compensating creation', async () => {
    const taskId = id()
    const deletion = store.delete(taskId)
    vi.mocked(connector.deleteTask).mockRejectedValue(new ProductivityApiError('gone', 'gmail', 404))
    await engine.flush()
    expect(store.operations()[0].status).toBe('succeeded')
    store.undo(deletion.id)
    await engine.flush()
    expect(store.entity(taskId)).toMatchObject({ id: taskId, remote: { remoteId: 'new' }, fields: { title: 'Original' } })
  })

  it('creates a parent before its child and supplies the actual remote parent identity', async () => {
    const parent = store.create('account', 'gmail', list.id, { title: 'Parent', completed: false })
    store.create('account', 'gmail', list.id, { title: 'Child', completed: false }, parent.entity.id)
    vi.mocked(connector.createTask)
      .mockResolvedValueOnce({ ...remote, id: 'account:list:parent', remoteId: 'parent', title: 'Parent' })
      .mockResolvedValueOnce({ ...remote, id: 'account:list:child', remoteId: 'child', title: 'Child', parentId: 'account:list:parent' })
    await engine.flush()
    expect(connector.createTask).toHaveBeenNthCalledWith(2, list, expect.objectContaining({ title: 'Child' }), expect.objectContaining({ remoteId: 'parent' }))
    expect(store.operations().every((operation) => operation.status === 'succeeded')).toBe(true)
    expect(() => store.undo(parent.operation.id)).toThrow('subtasks')
  })

  it('does not include cancelled optimistic edits in another write or its undo', async () => {
    const cancelled = store.update(id(), { title: 'Cancelled' })
    const completion = store.update(id(), { completed: true })
    store.undo(cancelled.id)
    await engine.flush()
    expect(connector.updateTask).toHaveBeenCalledWith(remote, expect.objectContaining({ title: 'Original', completed: true }))
    store.undo(completion.id)
    await engine.flush()
    expect(store.entity(id())?.fields).toMatchObject({ title: 'Original', completed: false })
  })

  it('rejects permissions revoked during refresh before making any remote write', async () => {
    store.update(id(), { title: 'Queued' })
    store.replaceProviderSnapshot('account', 'gmail', { lists: [{ ...list, readOnly: true }], tasks: [remote], checkpoints: {} })
    await engine.flush()
    expect(connector.updateTask).not.toHaveBeenCalled()
    expect(store.operations()[0]).toMatchObject({ status: 'failed', error: 'precondition' })
  })

  it('holds a remotely accepted write for review if persisting the result fails', async () => {
    store.update(id(), { title: 'Accepted' })
    vi.spyOn(store, 'succeed').mockImplementationOnce(() => { throw new Error('disk fixture') })
    await engine.flush(); await engine.flush()
    expect(connector.updateTask).toHaveBeenCalledTimes(1)
    expect(store.operations()[0]).toMatchObject({ status: 'review', error: 'uncertain-write' })
  })

  it('keeps disconnected accounts queued without attempting a write', async () => {
    store.update(id(), { title: 'Offline account' })
    engine = new TaskSyncEngine(store, { online: () => true, connector: () => undefined })
    await engine.flush()
    expect(connector.updateTask).not.toHaveBeenCalled()
    expect(store.operations()[0]).toMatchObject({ status: 'queued', attempts: 0 })
  })
})
