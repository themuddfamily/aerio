import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskStore } from './task-store'
import { TaskService } from './task-service'
import type { MailAccountSummary } from '../../src/mail-types'
import type { ProviderTask, ProviderTaskList, TaskProviderConnector } from '../../src/task-provider-types'

const account = (id: string, provider: 'gmail' | 'microsoft', overrides: Partial<MailAccountSummary> = {}): MailAccountSummary => ({ id, provider, email: `${id}@example.test`, displayName: id, color: '#123456', status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true, ...overrides })
const list: ProviderTaskList = { id: 'ms:microsoft-task-list:list', accountId: 'ms', provider: 'microsoft', remoteId: 'list', title: 'Work', readOnly: false, revisionMode: 'snapshot', revision: `snapshot:${'1'.repeat(64)}` }
const task: ProviderTask = { id: 'ms:microsoft-task:list:task', accountId: 'ms', provider: 'microsoft', remoteId: 'task', listId: list.id, remoteListId: 'list', title: 'Report', completed: false, readOnly: false, revision: 'v1', kind: 'task', native: { priority: 'normal', status: 'notStarted', reminder: '2026-10-20T08:00:00.000Z', attachments: [{ id: 'a1', name: 'spec.pdf', size: 3 }] } }
const googleList: ProviderTaskList = { id: 'g:list', accountId: 'g', provider: 'gmail', remoteId: 'list', title: 'Home', readOnly: false }
const googleTask: ProviderTask = { id: 'g:list:task', accountId: 'g', provider: 'gmail', remoteId: 'task', listId: googleList.id, remoteListId: 'list', title: 'Groceries', completed: false, readOnly: false, revision: 'g1' }
let store: TaskStore, service: TaskService, accounts: MailAccountSummary[], online: boolean, connector: TaskProviderConnector
const msId = () => store.entities('ms', 'microsoft')[0].id
beforeEach(() => {
  accounts = [account('ms', 'microsoft'), account('g', 'gmail')]; online = true
  store = new TaskStore(':memory:')
  store.replaceProviderSnapshot('ms', 'microsoft', { lists: [list], tasks: [task], checkpoints: {} })
  store.replaceProviderSnapshot('g', 'gmail', { lists: [googleList], tasks: [googleTask], checkpoints: {} })
  connector = {
    provider: 'microsoft', capabilities: { recurrence: 'native', priority: 'native', due: 'date-time', subtasks: 'checklist', reparent: false },
    sync: vi.fn(), createList: vi.fn(), updateList: vi.fn(), deleteList: vi.fn(), createTask: vi.fn(), updateTask: vi.fn(async (current, input) => ({ ...current, ...input, revision: 'v2' })), deleteTask: vi.fn(), moveTask: vi.fn(),
    addAttachment: vi.fn(async (current: ProviderTask) => ({ ...current, revision: 'v5', native: { ...current.native, attachments: [...current.native!.attachments!, { id: 'a2', name: 'new.txt', size: 1 }] } })),
    deleteAttachment: vi.fn(async (current: ProviderTask, attachmentId: string) => ({ ...current, revision: 'v6', native: { ...current.native, attachments: current.native!.attachments!.filter((item) => item.id !== attachmentId) } })),
    readAttachment: vi.fn(async () => new Uint8Array([7]))
  }
  service = new TaskService(store, { accounts: async () => accounts, access: () => ({ read: true, write: true }), connector: () => connector, online: () => online, changed: vi.fn() })
})
afterEach(async () => { await service.close() })

describe('task service extended fields', () => {
  it('adds and removes Microsoft attachments immediately and stores the new revision', async () => {
    const added = await service.nativeAttachment(msId(), { kind: 'add', file: { name: 'new.txt', bytes: new Uint8Array([1]) } })
    expect(connector.addAttachment).toHaveBeenCalledWith(expect.objectContaining({ revision: 'v1' }), { name: 'new.txt', bytes: new Uint8Array([1]) })
    expect(added.tasks.find((item) => item.provider === 'microsoft')?.remote).toMatchObject({ revision: 'v5', native: { attachments: [{ id: 'a1' }, { id: 'a2' }] } })
    await service.nativeAttachment(msId(), { kind: 'remove', attachmentId: 'a1' })
    expect(connector.deleteAttachment).toHaveBeenCalledWith(expect.objectContaining({ revision: 'v5' }), 'a1')
    // A later field edit uses the re-read revision rather than conflicting with it.
    await service.update(msId(), { title: 'Report v2' })
    await service.flush()
    expect(connector.updateTask).toHaveBeenCalledWith(expect.objectContaining({ revision: 'v6' }), expect.objectContaining({ title: 'Report v2' }))
    await expect(service.readNativeAttachment(msId(), 'a2')).resolves.toEqual({ name: 'new.txt', bytes: new Uint8Array([7]) })
    await expect(service.readNativeAttachment(msId(), 'missing')).rejects.toThrow('no longer on this task')
  })

  it('refuses attachment changes offline, with pending edits, or for Google tasks', async () => {
    online = false
    await expect(service.nativeAttachment(msId(), { kind: 'remove', attachmentId: 'a1' })).rejects.toThrow('network connection')
    await service.update(msId(), { title: 'Queued offline' })
    online = true
    connector.updateTask = vi.fn(async () => { throw new Error('offline') })
    await expect(service.nativeAttachment(msId(), { kind: 'remove', attachmentId: 'a1' })).rejects.toThrow('pending changes')
    const google = store.entities('g', 'gmail')[0].id
    await expect(service.nativeAttachment(google, { kind: 'remove', attachmentId: 'a1' })).rejects.toThrow('does not support provider attachments')
    expect(connector.deleteAttachment).not.toHaveBeenCalled()
  })

  it('collects reminders from Microsoft natively and Google overlays for active accounts only', async () => {
    await service.setLocal(store.entities('g', 'gmail')[0].id, { priority: 'normal', recurrence: 'none', extended: { reminder: '2026-10-19T09:00:00.000Z' } })
    expect(service.reminderCandidates().map((item) => [item.taskId === msId() ? 'ms' : 'g', item.reminder])).toEqual([['ms', '2026-10-20T08:00:00.000Z'], ['g', '2026-10-19T09:00:00.000Z']])
    expect(service.referencedAttachmentPaths()).toEqual([])
    accounts = [account('ms', 'microsoft', { archived: true }), account('g', 'gmail')]
    await service.snapshot()
    expect(service.reminderCandidates().map((item) => item.reminder)).toEqual(['2026-10-19T09:00:00.000Z'])
  })
})
