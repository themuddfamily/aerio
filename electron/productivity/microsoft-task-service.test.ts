import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskStore } from './task-store'
import { TaskService } from './task-service'
import type { MailAccountSummary } from '../../src/mail-types'
import type { ProviderTask, ProviderTaskList, TaskProvider, TaskProviderConnector } from '../../src/task-provider-types'

const account: MailAccountSummary = { id: 'ms', provider: 'microsoft', email: 'ms@example.test', displayName: 'MS', color: '#123456', status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true }
const list: ProviderTaskList = { id: 'ms:microsoft-task-list:list', accountId: 'ms', provider: 'microsoft', remoteId: 'list', title: 'Work', readOnly: false, manageReadOnly: false, revisionMode: 'snapshot', revision: `snapshot:${'1'.repeat(64)}` }
const task: ProviderTask = { id: 'ms:microsoft-task:list:task', accountId: 'ms', provider: 'microsoft', remoteId: 'task', listId: list.id, remoteListId: 'list', title: 'Task', completed: false, readOnly: false, revision: 'v1', kind: 'task', native: { priority: 'high', recurrence: null, status: 'inProgress' } }
let store: TaskStore, service: TaskService, accounts: MailAccountSummary[], access: { read: boolean; write: boolean }, online: boolean, ms: TaskProviderConnector, google: TaskProviderConnector
const id = () => store.entities('ms', 'microsoft')[0].id
beforeEach(() => {
  accounts = [account]; access = { read: true, write: true }; online = false
  store = new TaskStore(':memory:'); store.replaceProviderSnapshot('ms', 'microsoft', { lists: [list], tasks: [task], checkpoints: {} })
  ms = { provider: 'microsoft', capabilities: { recurrence: 'native', priority: 'native', due: 'date-time', subtasks: 'checklist', reparent: false }, sync: vi.fn(async () => ({ lists: [{ ...list, readOnly: !access.write }], tasks: [{ ...task, readOnly: !access.write }], checkpoints: {} })), createList: vi.fn(async (title) => ({ ...list, id: 'ms:microsoft-task-list:new', remoteId: 'new', title })), updateList: vi.fn(async (base, title) => ({ ...base, title })), deleteList: vi.fn(), createTask: vi.fn(async (_list, input, parent) => ({ ...task, ...input, id: 'ms:microsoft-task:list:new', remoteId: 'new', parentId: parent?.id })), updateTask: vi.fn(async (current, input) => ({ ...current, ...input, revision: 'v2' })), deleteTask: vi.fn(), moveTask: vi.fn() }
  google = { ...ms, provider: 'gmail', capabilities: { recurrence: 'local', priority: 'local', due: 'date', subtasks: 'tasks' }, sync: vi.fn(), updateTask: vi.fn(async (current, input) => ({ ...current, ...input, revision: 'g2' })) }
  service = new TaskService(store, { accounts: async () => accounts, access: (_id, provider) => provider === 'microsoft' ? access : { read: true, write: true }, connector: (_id, provider) => provider === 'microsoft' ? ms : google, online: () => online, changed: vi.fn() })
})
afterEach(async () => { await service.close() })

describe('Microsoft task service routing and lifecycle', () => {
  it('routes native task/list intent offline and sends through the Microsoft connector once', async () => {
    await service.update(id(), { native: { priority: 'low' } }); await service.createList('ms', 'New')
    await service.flush()
    expect(ms.updateTask).not.toHaveBeenCalled()
    online = true; await service.flush(); await service.flush()
    expect(ms.updateTask).toHaveBeenCalledExactlyOnceWith(task, expect.objectContaining({ native: { ...task.native, priority: 'low' } }))
    expect(ms.createList).toHaveBeenCalledExactlyOnceWith('New')
    expect(google.updateTask).not.toHaveBeenCalled()
    expect((await service.snapshot()).accounts[0]).toMatchObject({ provider: 'microsoft', canWrite: true })
  })

  it('shows Microsoft read-only grants and blocks editing without discarding queued native intent', async () => {
    await service.update(id(), { native: { priority: 'low' } })
    access = { read: true, write: false }; online = true
    await service.sync('ms')
    const cached = await service.snapshot()
    expect(cached.accounts[0]).toMatchObject({ canRead: true, canWrite: false })
    expect(cached.lists[0].readOnly).toBe(true)
    expect(cached.operations[0]).toMatchObject({ status: 'queued', attempts: 0 })
    await expect(service.update(id(), { title: 'Denied' })).rejects.toThrow(/write access/)
    expect(ms.updateTask).not.toHaveBeenCalled()
    access = { read: true, write: true }; await service.flush()
    expect(ms.sync).toHaveBeenCalledTimes(2)
    expect(ms.updateTask).toHaveBeenCalledOnce()
  })

  it('holds revoked or absent Tasks access while keeping the cached data', async () => {
    await service.update(id(), { title: 'Queued' }); access = { read: false, write: false }; online = true
    await service.poll(); await service.flush()
    await expect(service.sync('ms')).rejects.toThrow(/Reconnect/)
    expect((await service.snapshot()).operations[0].status).toBe('queued')
    expect(ms.sync).not.toHaveBeenCalled(); expect(ms.updateTask).not.toHaveBeenCalled()
  })

  it('preserves archived queues and purges a deleted account without provider writes', async () => {
    await service.update(id(), { title: 'Queued' }); await service.stopAccount('ms')
    accounts = [{ ...account, archived: true }]; await service.accountChanged(); online = true
    await service.poll()
    expect((await service.snapshot()).accounts[0]).toMatchObject({ archived: true, canWrite: false })
    expect((await service.snapshot()).operations[0].status).toBe('queued')
    accounts = []; await service.removeAccount('ms')
    expect((await service.snapshot()).tasks).toEqual([])
    expect(store.cachedAccounts()).toEqual([])
    expect(ms.updateTask).not.toHaveBeenCalled()
  })

  it('keeps recovered Microsoft backup caches viewable and restored writes under review after reconnect', async () => {
    await service.update(id(), { native: { priority: 'low' } }); const backup = await service.exportBackup()
    accounts = []; await service.restoreBackup(backup)
    const recovered = await service.snapshot()
    expect(recovered.accounts[0]).toMatchObject({ provider: 'microsoft', recovered: true, archived: true, canWrite: false })
    expect(recovered.tasks[0].fields.native?.priority).toBe('low')
    accounts = [account]; online = true; service.resumeAccount('ms'); await service.poll()
    expect((await service.snapshot()).operations[0]).toMatchObject({ status: 'review', error: 'restored-write' })
    expect(ms.updateTask).not.toHaveBeenCalled()
  })

  it.each(['needs-auth', 'error', 'paused'] as const)('saves cached intent while status %s separately controls dispatch', async (status) => {
    await service.update(id(), { title: 'Queued' }); accounts = [{ ...account, status }]; online = true
    await service.flush()
    const writable = status === 'paused'
    expect((await service.snapshot()).accounts[0].canWrite).toBe(true)
    expect(ms.updateTask).toHaveBeenCalledTimes(writable ? 1 : 0)
    if (!writable) {
      await service.update(id(), { native: { priority: 'low' } }); await service.flush()
      expect(store.operations().every((operation) => operation.attempts === 0)).toBe(true)
    }
  })

  it('keeps Google account progress independent of a Microsoft refresh failure', async () => {
    const gAccount = { ...account, id: 'g', provider: 'gmail' as const }, gList = { ...list, id: 'g:list', accountId: 'g', provider: 'gmail' as const, revisionMode: undefined }, gTask = { ...task, id: 'g:task', accountId: 'g', provider: 'gmail' as const, listId: gList.id, kind: undefined, native: undefined }
    accounts.push(gAccount); store.replaceProviderSnapshot('g', 'gmail', { lists: [gList], tasks: [gTask], checkpoints: {} })
    await service.update(id(), { title: 'MS queued' }); await service.update(store.entities('g', 'gmail')[0].id, { title: 'Google queued' })
    store.replaceProviderSnapshot('ms', 'microsoft', { lists: [{ ...list, readOnly: true }], tasks: [{ ...task, readOnly: true }], checkpoints: {} })
    vi.mocked(ms.sync).mockRejectedValue(new Error('private provider failure')); online = true
    await service.flush()
    expect(store.operations().find((operation) => operation.provider === 'microsoft')).toMatchObject({ status: 'queued', attempts: 0 })
    expect(store.operations().find((operation) => operation.provider === 'gmail')?.status).toBe('succeeded')
    expect(google.updateTask).toHaveBeenCalledOnce()
  })
})
