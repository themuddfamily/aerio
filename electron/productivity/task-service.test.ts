import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { TaskService } from './task-service'
import { TaskStore } from './task-store'
import type { MailAccountSummary } from '../../src/mail-types'
import type { ProviderTask, TaskProviderConnector, TaskSnapshot } from '../../src/task-provider-types'

const account: MailAccountSummary = { id: 'account', provider: 'gmail', email: 'test@example.test', displayName: 'Test', color: '#123456', status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true }
const list = { id: 'account:list', accountId: 'account', provider: 'gmail' as const, remoteId: 'list', title: 'Work', readOnly: false }
const remote: ProviderTask = { id: 'account:list:task', accountId: 'account', provider: 'gmail', remoteId: 'task', listId: list.id, remoteListId: 'list', title: 'Original', completed: false, revision: 'v1', readOnly: false }
let store: TaskStore
let service: TaskService
let connector: TaskProviderConnector
let accounts: MailAccountSummary[]
let access: { read: boolean; write: boolean }
let online: boolean
let changed: Mock<(snapshot: TaskSnapshot) => void>
beforeEach(() => {
  accounts = [account]; access = { read: true, write: true }; online = true
  store = new TaskStore(':memory:')
  store.replaceProviderSnapshot('account', 'gmail', { lists: [list], tasks: [remote], checkpoints: { [list.id]: '2026-10-01T00:00:00Z' } })
  connector = {
    provider: 'gmail', capabilities: { recurrence: 'local', priority: 'local', due: 'date', subtasks: 'tasks' },
    sync: vi.fn(async () => ({ lists: [list], tasks: [remote], checkpoints: {} })), createList: vi.fn(), updateList: vi.fn(), deleteList: vi.fn(),
    createTask: vi.fn(async (_list, input) => ({ ...remote, ...input, id: 'account:list:new', remoteId: 'new' })),
    updateTask: vi.fn(async (current, input) => ({ ...current, ...input, revision: 'v2' })), deleteTask: vi.fn(), moveTask: vi.fn()
  }
  changed = vi.fn()
  service = new TaskService(store, { accounts: async () => accounts, access: () => access, connector: () => connector, online: () => online, changed })
})
afterEach(async () => { await service.close() })
const taskId = () => store.entities('account', 'gmail')[0].id

describe('task service integration', () => {
  it('holds original queued writes when permission refresh fails, while an unrelated account can dispatch', async () => {
    const other = { ...account, id: 'other' }
    const otherList = { ...list, id: 'other:list', accountId: 'other', revision: 'other-list-v1' }
    const otherTask = { ...remote, id: 'other:list:task', accountId: 'other', listId: otherList.id }
    accounts.push(other)
    store.replaceProviderSnapshot('other', 'gmail', { lists: [otherList], tasks: [otherTask], checkpoints: {} })
    online = false
    await service.update(taskId(), { title: 'Held safely' })
    await service.update(store.entities('other', 'gmail')[0].id, { title: 'Independent change' })
    await service.flush()
    store.replaceProviderSnapshot('account', 'gmail', { lists: [{ ...list, readOnly: true }], tasks: [{ ...remote, readOnly: true }], checkpoints: {} })
    vi.mocked(connector.sync).mockRejectedValueOnce(new Error('secret refresh error'))
    online = true
    await service.flush()
    let snapshot = await service.snapshot()
    expect(snapshot.operations.find((operation) => operation.accountId === 'account')).toMatchObject({ status: 'queued', attempts: 0, base: { revision: 'v1' } })
    expect(snapshot.operations.find((operation) => operation.accountId === 'other')?.status).toBe('succeeded')
    expect(JSON.stringify(changed.mock.calls)).not.toContain('secret refresh error')
    vi.mocked(connector.sync).mockResolvedValueOnce({ lists: [list], tasks: [remote], checkpoints: {} })
    await service.flush()
    snapshot = await service.snapshot()
    expect(snapshot.operations.every((operation) => operation.status === 'succeeded')).toBe(true)
    expect(connector.updateTask).toHaveBeenCalledTimes(2)
  })

  it('refreshes read-only caches after write access is restored before dispatching pending task and list changes', async () => {
    const versionedList = { ...list, revision: 'list-v1' }
    store.replaceProviderSnapshot('account', 'gmail', { lists: [versionedList], tasks: [remote], checkpoints: {} })
    online = false
    const edit = await service.update(taskId(), { title: 'Queued before consent changed' })
    await service.renameList(list.id, 'Queued list rename')
    access = { read: true, write: false }; online = true
    vi.mocked(connector.sync).mockResolvedValueOnce({ lists: [{ ...versionedList, readOnly: true }], tasks: [{ ...remote, readOnly: true }], checkpoints: {} })
    await service.sync('account')
    expect((await service.snapshot()).operations[0].status).toBe('queued')
    access = { read: true, write: true }
    vi.mocked(connector.sync).mockResolvedValueOnce({ lists: [versionedList], tasks: [remote], checkpoints: {} })
    vi.mocked(connector.updateList).mockResolvedValueOnce({ ...versionedList, title: 'Queued list rename', revision: 'list-v2' })
    await service.flush()
    const restored = await service.snapshot()
    expect(restored.operations.find((operation) => operation.id === edit.operations[0].id)?.status).toBe('succeeded')
    expect(restored.listOperations?.[0].status).toBe('succeeded')
    expect(connector.sync).toHaveBeenCalledTimes(2)
    expect(connector.updateTask).toHaveBeenCalledWith(remote, expect.objectContaining({ title: 'Queued before consent changed' }))
  })

  it('publishes offline list intent, protects pending deletions, and serializes successful creation', async () => {
    online = false
    const snapshot = await service.createList('account', 'Created')
    expect(snapshot.listOperations?.[0]).toMatchObject({ title: 'Created', status: 'queued', attempts: 0 })
    expect(connector.createList).not.toHaveBeenCalled()
    vi.mocked(connector.createList).mockResolvedValueOnce({ ...list, id: 'account:new-list', remoteId: 'new-list', title: 'Created', revision: 'new-v1' })
    online = true
    await service.flush()
    expect((await service.snapshot()).lists.some((list) => list.title === 'Created')).toBe(true)
    expect(connector.createList).toHaveBeenCalledTimes(1)
    online = false
    const deletion = await service.deleteList('account:new-list')
    expect(deletion.lists.find((list) => list.id === 'account:new-list')?.readOnly).toBe(true)
    await expect(service.create('account', 'account:new-list', { title: 'Blocked', completed: false })).rejects.toThrow('pending list deletion')
    const pending = deletion.listOperations?.find((operation) => operation.kind === 'delete')
    const cancelled = await service.resolveList(pending!.id, { action: 'discard' })
    expect(cancelled.lists.find((list) => list.id === 'account:new-list')?.readOnly).toBe(false)
  })
  it('publishes archival immediately and removes a deleted account from the next emitted view', async () => {
    await service.snapshot()
    await service.stopAccount('account')
    accounts = [{ ...account, archived: true }]
    await service.accountChanged()
    expect(changed.mock.calls.at(-1)![0].accounts[0]).toMatchObject({ archived: true, canWrite: false })
    accounts = []
    await service.removeAccount('account')
    expect(changed.mock.calls.at(-1)![0].accounts).toEqual([])
    expect(changed.mock.calls.at(-1)![0].lists).toEqual([])
  })
  it('restores pending work into review and preserves caches as read-only recovered accounts when no account is connected', async () => {
    store.update(taskId(), { title: 'Recovered pending edit' })
    const backup = await service.exportBackup()
    accounts = []
    const restored = await service.restoreBackup(backup)
    expect(restored.accounts[0]).toMatchObject({ accountId: 'account', archived: true, recovered: true, canRead: false, canWrite: false })
    expect(restored.lists[0].readOnly).toBe(true)
    expect(restored.tasks[0].fields.title).toBe('Recovered pending edit')
    expect(restored.operations[0]).toMatchObject({ status: 'review', error: 'restored-write' })
    await service.poll(); await service.flush()
    expect(connector.updateTask).not.toHaveBeenCalled()
    accounts = [account]
    expect((await service.snapshot()).accounts[0]).toMatchObject({ archived: false, recovered: false, canWrite: true })
    await service.flush()
    expect(connector.updateTask).not.toHaveBeenCalled()
  })

  it('polls eligible accounts independently and skips accounts without task consent', async () => {
    accounts = [account, { ...account, id: 'other' }, { ...account, id: 'legacy' }]
    const otherList = { ...list, id: 'other:list', accountId: 'other' }
    const otherConnector = { ...connector, sync: vi.fn(async () => ({ lists: [otherList], tasks: [], checkpoints: {} })) }
    vi.mocked(connector.sync).mockRejectedValue(new Error('account failure'))
    service = new TaskService(store, {
      accounts: async () => accounts, access: (id) => ({ read: id !== 'legacy', write: id !== 'legacy' }),
      connector: (id) => id === 'other' ? otherConnector : connector, online: () => true, changed
    })
    await service.poll()
    expect(connector.sync).toHaveBeenCalledTimes(1)
    expect(otherConnector.sync).toHaveBeenCalledTimes(1)
    expect((await service.snapshot()).accounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: 'account', phase: 'error', error: 'sync-failed' }),
      expect.objectContaining({ accountId: 'other', phase: 'ready' }),
      expect.objectContaining({ accountId: 'legacy', canRead: false, phase: 'idle' })
    ]))
  })

  it('refreshes cached data and flushes previously persisted mutations during a startup poll', async () => {
    store.update(taskId(), { title: 'Persisted pending edit' })
    await service.poll()
    expect(connector.sync).toHaveBeenCalledTimes(1)
    expect(connector.updateTask).toHaveBeenCalledWith(remote, expect.objectContaining({ title: 'Persisted pending edit' }))
    expect(store.operations()[0].status).toBe('succeeded')
  })

  it('returns offline cached data, durable optimistic edits and operation state, then flushes on reconnect', async () => {
    online = false
    const result = await service.update(taskId(), { title: 'Offline' })
    expect(result.tasks[0].fields.title).toBe('Offline')
    expect(result.operations[0].status).toBe('queued')
    await service.flush()
    expect(connector.updateTask).not.toHaveBeenCalled()
    online = true
    await service.flush()
    expect((await service.snapshot()).operations[0].status).toBe('succeeded')
    expect(changed).toHaveBeenCalled()
  })

  it('preserves caches and records only a sanitized failure category when provider sync fails', async () => {
    vi.mocked(connector.sync).mockRejectedValue(new Error('secret-provider-payload'))
    await expect(service.sync('account')).rejects.toThrow('cached tasks are preserved')
    expect((await service.snapshot()).tasks[0].fields.title).toBe('Original')
    expect((await service.snapshot()).accounts[0]).toMatchObject({ phase: 'error', error: 'sync-failed' })
    expect(JSON.stringify(changed.mock.calls)).not.toContain('secret-provider-payload')
  })

  it('requires consent and active accounts without making unauthorized requests', async () => {
    access = { read: false, write: false }
    await expect(service.sync('account')).rejects.toThrow('Reconnect')
    await expect(service.update(taskId(), { title: 'Forbidden' })).rejects.toThrow('write access')
    const snapshot = await service.snapshot()
    expect(snapshot.lists[0].readOnly).toBe(true)
    expect(snapshot.accounts[0]).toMatchObject({ canRead: false, canWrite: false, error: 'needs-consent' })
    expect(connector.sync).not.toHaveBeenCalled()
    expect(store.operations()).toEqual([])
  })

  it('allows read-only refresh but rejects mutations', async () => {
    access = { read: true, write: false }
    expect((await service.sync('account')).accounts[0]).toMatchObject({ canRead: true, canWrite: false, phase: 'ready' })
    await expect(service.create('account', list.id, { title: 'Forbidden', completed: false })).rejects.toThrow('write access')
    expect(connector.createTask).not.toHaveBeenCalled()
  })

  it('refreshes with the stored incremental snapshot and prevents writes from racing refresh', async () => {
    let finish!: (snapshot: { lists: typeof list[]; tasks: ProviderTask[]; checkpoints: {} }) => void
    vi.mocked(connector.sync).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const syncing = service.sync('account')
    await vi.waitFor(() => expect(connector.sync).toHaveBeenCalledTimes(1))
    expect(connector.sync).toHaveBeenCalledWith(expect.objectContaining({ checkpoints: { [list.id]: '2026-10-01T00:00:00Z' } }))
    const editing = service.update(taskId(), { title: 'Mine' })
    expect(store.operations()).toEqual([])
    finish({ lists: [list], tasks: [{ ...remote, revision: 'external-v2' }], checkpoints: {} })
    await syncing; await editing; await service.flush()
    expect(connector.updateTask).toHaveBeenCalledWith(expect.objectContaining({ revision: 'external-v2' }), expect.objectContaining({ title: 'Mine' }))
  })

  it('performs a full refresh before reconciliation and preserves the reviewed revision when dispatching retry', async () => {
    const operation = store.update(taskId(), { title: 'Mine' })
    store.start(operation.id); store.fail(operation.id, 'conflict', 'revision-conflict')
    vi.mocked(connector.sync).mockResolvedValue({ lists: [list], tasks: [{ ...remote, title: 'Theirs', revision: 'v2' }], checkpoints: {} })
    const result = await service.resolve(operation.id, { action: 'retry', expectedRevision: 'v2' })
    expect(connector.sync).toHaveBeenCalledExactlyOnceWith(undefined)
    expect(connector.updateTask).toHaveBeenCalledWith(expect.objectContaining({ revision: 'v2', title: 'Theirs' }), expect.objectContaining({ title: 'Mine' }))
    expect(result.operations[0].status).toBe('succeeded')
  })

  it('rejects an obsolete reviewed revision after full refresh without writing', async () => {
    const operation = store.update(taskId(), { title: 'Mine' })
    store.start(operation.id); store.fail(operation.id, 'conflict', 'revision-conflict')
    vi.mocked(connector.sync).mockResolvedValue({ lists: [list], tasks: [{ ...remote, revision: 'v3' }], checkpoints: {} })
    await expect(service.resolve(operation.id, { action: 'retry', expectedRevision: 'v2' })).rejects.toThrow('revision changed')
    expect(connector.updateTask).not.toHaveBeenCalled()
    expect(store.operations()[0].status).toBe('conflict')
  })

  it('permits offline discarding of local intent without issuing provider requests', async () => {
    const operation = store.update(taskId(), { title: 'Mine' })
    store.start(operation.id); store.fail(operation.id, 'review', 'uncertain-write')
    online = false
    expect((await service.resolve(operation.id, { action: 'discard' })).operations[0].status).toBe('cancelled')
    expect(connector.sync).not.toHaveBeenCalled()
    expect(connector.updateTask).not.toHaveBeenCalled()
  })

  it('keeps archived caches read-only and leaves their queued writes untouched', async () => {
    online = false
    await service.update(taskId(), { title: 'Pending' })
    accounts = [{ ...account, archived: true }]
    online = true
    await service.flush()
    const snapshot = await service.snapshot()
    expect(snapshot.tasks[0].fields.title).toBe('Pending')
    expect(snapshot.lists[0].readOnly).toBe(true)
    expect(snapshot.operations[0].status).toBe('queued')
    expect(connector.updateTask).not.toHaveBeenCalled()
  })

  it('stops a disconnecting account before its next queued operation and permits explicit resume', async () => {
    online = false
    await service.update(taskId(), { title: 'Pending' })
    await service.stopAccount('account')
    online = true
    await service.flush()
    expect(connector.updateTask).not.toHaveBeenCalled()
    service.resumeAccount('account')
    await service.flush()
    expect(connector.updateTask).toHaveBeenCalledTimes(1)
  })

  it('deletes provider caches, recurrence links, pending intent and resolution history together', async () => {
    const id = taskId()
    store.setLocal(id, { priority: 'normal', recurrence: 'daily' })
    const operation = store.update(id, { completed: true })
    store.start(operation.id); store.fail(operation.id, 'conflict', 'revision-conflict')
    store.resolve(operation.id, { action: 'retry', expectedRevision: 'v1' })
    await service.removeAccount('account')
    expect(store.entities('account', 'gmail')).toEqual([])
    expect(store.operations()).toEqual([])
    expect(store.resolutionHistory(operation.id)).toEqual([])
    expect(store.providerSnapshot('account', 'gmail').lists).toEqual([])
  })
})
