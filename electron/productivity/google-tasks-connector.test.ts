import { afterEach, describe, expect, it, vi } from 'vitest'
import { GoogleTasksConnector } from './google-tasks-connector'
import { ProductivityApiError } from './connector'
import type { ProviderTaskSnapshot } from '../../src/task-provider-types'

const response = (data: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
const list = { id: 'account:google-task-list:list', accountId: 'account', provider: 'gmail' as const, remoteId: 'list', title: 'Work', revision: 'list-v1', readOnly: false }
const task = { id: 'account:google-task:list:task', accountId: 'account', provider: 'gmail' as const, remoteId: 'task', listId: list.id, remoteListId: 'list', title: 'Task', revision: 'task-v1', completed: false, readOnly: false, updatedAt: '2026-10-01T10:00:00Z' }
const connector = () => new GoogleTasksConnector('account', async () => 'test-token', true)
afterEach(() => vi.unstubAllGlobals())

describe('Google Tasks provider adapter', () => {
  it('paginates lists/tasks, preserves completed hidden tasks and parent identities, and uses date-only due values', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ items: [{ id: 'list', title: 'Work', etag: 'list-v1' }], nextPageToken: 'lists-next' }))
      .mockResolvedValueOnce(response({ items: [{ id: 'list', title: 'Work', etag: 'list-v1' }] }))
      .mockResolvedValueOnce(response({ items: [{ id: 'parent', etag: 'p1', title: 'Parent', updated: '2026-10-01T10:00:00Z' }], nextPageToken: 'tasks-next' }))
      .mockResolvedValueOnce(response({ items: [{ id: 'child', etag: 'c1', title: 'Child', parent: 'parent', status: 'completed', hidden: true, due: '2026-10-04T00:00:00.000Z', updated: '2026-10-01T10:00:01Z' }] }))
    vi.stubGlobal('fetch', fetch)
    const snapshot = await connector().sync()
    expect(snapshot.lists).toHaveLength(1)
    expect(snapshot.tasks).toHaveLength(2)
    expect(snapshot.tasks[1]).toMatchObject({ parentId: snapshot.tasks[0].id, completed: true, due: '2026-10-04', revision: 'c1', readOnly: false })
    expect(snapshot.checkpoints[list.id]).toBe('2026-10-01T10:00:00.000Z')
    const query = new URL(fetch.mock.calls[2][0]).searchParams
    expect(Object.fromEntries(query)).toMatchObject({ showCompleted: 'true', showHidden: 'true', showDeleted: 'true', showAssigned: 'true' })
    expect(connector().capabilities).toEqual({ recurrence: 'local', priority: 'local', due: 'date', subtasks: 'tasks' })
  })

  it('merges incremental changes and tombstones without dropping unchanged tasks or mutating the cached snapshot', async () => {
    const previous: ProviderTaskSnapshot = { lists: [list], tasks: [task, { ...task, id: 'account:google-task:list:deleted', remoteId: 'deleted' }, { ...task, id: 'account:google-task:list:kept', remoteId: 'kept' }], checkpoints: { [list.id]: '2026-10-01T09:59:59Z' } }
    const original = structuredClone(previous)
    const fetch = vi.fn().mockResolvedValueOnce(response({ items: [{ id: 'list', etag: 'l2' }] })).mockResolvedValueOnce(response({ items: [{ id: 'task', etag: 'v2', title: 'Changed', updated: '2026-10-01T11:00:00Z' }, { id: 'deleted', deleted: true, updated: '2026-10-01T11:00:01Z' }] }))
    vi.stubGlobal('fetch', fetch)
    const next = await connector().sync(previous)
    expect(next.tasks.map((item) => item.remoteId)).toEqual(['task', 'kept'])
    expect(next.tasks[0].title).toBe('Changed')
    expect(new URL(fetch.mock.calls[1][0]).searchParams.get('updatedMin')).toBe(previous.checkpoints[list.id])
    expect(next.checkpoints[list.id]).toBe('2026-10-01T11:00:00.000Z')
    expect(previous).toEqual(original)
  })

  it('drops removed lists and their records/checkpoints and keeps another account out of this snapshot', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ items: [] })))
    expect(await connector().sync({ lists: [list], tasks: [task], checkpoints: { [list.id]: '2026-10-01T00:00:00Z' } })).toEqual({ lists: [], tasks: [], checkpoints: {} })
  })

  it.each([400, 410])('rebuilds an invalid incremental checkpoint after HTTP %s', async (status) => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ items: [{ id: 'list', etag: 'l1' }] })).mockResolvedValueOnce(response({}, status)).mockResolvedValueOnce(response({ items: [{ id: 'fresh', etag: 't1', updated: '2026-10-01T00:00:00Z' }] }))
    vi.stubGlobal('fetch', fetch)
    const next = await connector().sync({ lists: [list], tasks: [task], checkpoints: { [list.id]: '2026-09-01T00:00:00Z' } })
    expect(next.tasks.map((item) => item.remoteId)).toEqual(['fresh'])
    expect(new URL(fetch.mock.calls[2][0]).searchParams.has('updatedMin')).toBe(false)
  })

  it('retains the checkpoint on an empty delta instead of advancing the desktop clock', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ items: [{ id: 'list', etag: 'l1' }] })).mockResolvedValueOnce(response({ items: [] }))
    vi.stubGlobal('fetch', fetch)
    const next = await connector().sync({ lists: [list], tasks: [task], checkpoints: { [list.id]: '2026-10-01T00:00:00Z' } })
    expect(next.checkpoints[list.id]).toBe('2026-10-01T00:00:00Z')
    expect(next.tasks).toHaveLength(1)
  })

  it('fails a refresh without changing cache/checkpoints when a provider page fails', async () => {
    const previous = { lists: [list], tasks: [task], checkpoints: { [list.id]: '2026-10-01T00:00:00Z' } }
    const original = structuredClone(previous)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response({ items: [{ id: 'list', etag: 'l1' }] })).mockResolvedValueOnce(response({}, 403)))
    await expect(connector().sync(previous)).rejects.toMatchObject({ status: 403 })
    expect(previous).toEqual(original)
  })

  it('rejects a repeated pagination token rather than looping forever', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => response({ items: [], nextPageToken: 'repeated' })))
    await expect(connector().sync()).rejects.toThrow(/repeated/)
  })

  it('creates a subtask under its remote parent and sends only supported fields', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ id: 'child', etag: 'v1', parent: 'task', title: 'Child' }))
    vi.stubGlobal('fetch', fetch)
    const written = await connector().createTask(list, { title: ' Child ', notes: 'Notes', completed: false, due: '2026-10-02' }, task)
    expect(written.parentId).toBe(task.id)
    const [url, init] = fetch.mock.calls[0]
    expect(new URL(url).searchParams.get('parent')).toBe('task')
    expect(JSON.parse(init.body)).toEqual({ title: 'Child', notes: 'Notes', due: '2026-10-02T00:00:00.000Z', status: 'needsAction', completed: null })
  })

  it('updates with the original revision after verifying the current remote ETag', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ etag: 'task-v1' })).mockResolvedValueOnce(response({ id: 'task', etag: 'task-v2', title: 'Changed', status: 'completed' }))
    vi.stubGlobal('fetch', fetch)
    expect(await connector().updateTask(task, { title: 'Changed', completed: true })).toMatchObject({ revision: 'task-v2', completed: true })
    expect(fetch.mock.calls[1][1].headers['If-Match']).toBe('task-v1')
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toMatchObject({ due: null, notes: '', status: 'completed' })
  })

  it.each(['update', 'delete'])('blocks a stale revision before attempting %s', async (operation) => {
    const fetch = vi.fn().mockResolvedValue(response({ etag: 'changed-remotely' }))
    vi.stubGlobal('fetch', fetch)
    const pending = operation === 'update' ? connector().updateTask(task, { title: 'Changed', completed: false }) : connector().deleteTask(task)
    await expect(pending).rejects.toMatchObject({ status: 412 })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('rejects a server-side race after the revision check without fetching a newer revision and retrying', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ etag: 'task-v1' })).mockResolvedValueOnce(response({}, 412))
    vi.stubGlobal('fetch', fetch)
    await expect(connector().updateTask(task, { title: 'Changed', completed: false })).rejects.toBeInstanceOf(ProductivityApiError)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('does not repeat a task creation after an uncertain server failure', async () => {
    const fetch = vi.fn().mockResolvedValue(response({}, 503))
    vi.stubGlobal('fetch', fetch)
    await expect(connector().createTask(list, { title: 'Create', completed: false })).rejects.toMatchObject({ status: 503 })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('enforces permission, account ownership, and cached revisions before any request', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    await expect(new GoogleTasksConnector('account', async () => 'token').createList('New')).rejects.toThrow(/Reconnect/)
    for (const current of [{ ...task, accountId: 'other' }, { ...task, readOnly: true }, { ...task, revision: undefined }, { ...task, id: 'forged-id' }]) await expect(connector().deleteTask(current)).rejects.toThrow()
    await expect(connector().createTask(list, { title: 'Child', completed: false }, { ...task, remoteListId: 'other', id: 'account:google-task:other:task' })).rejects.toThrow(/parent task list/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['2026-02-30', '2026-10-01T15:00:00Z', 'bad'])('rejects unsupported or invalid due date %s before creating', async (due) => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    await expect(connector().createTask(list, { title: 'Task', completed: false, due })).rejects.toThrow(/calendar dates/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('treats assigned tasks and missing revisions as read-only and respects missing write consent', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ items: [{ id: 'list', etag: 'l1' }] })).mockResolvedValueOnce(response({ items: [{ id: 'assigned', etag: 't1', assignmentInfo: { surfaceType: 'DOCUMENT' } }, { id: 'no-revision' }] }))
    vi.stubGlobal('fetch', fetch)
    expect((await connector().sync()).tasks.every((item) => item.readOnly)).toBe(true)
  })

  it('creates, renames, and deletes task lists with revision protection', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ id: 'list', title: 'New', etag: 'list-v1' })).mockResolvedValueOnce(response({ etag: 'list-v1' })).mockResolvedValueOnce(response({ id: 'list', title: 'Renamed', etag: 'list-v2' })).mockResolvedValueOnce(response({ etag: 'list-v2' })).mockResolvedValueOnce(response(null, 204))
    vi.stubGlobal('fetch', fetch)
    const created = await connector().createList('New')
    const renamed = await connector().updateList(created, 'Renamed')
    await connector().deleteList(renamed)
    expect(fetch.mock.calls[4][1]).toMatchObject({ method: 'DELETE', headers: { 'If-Match': 'list-v2' } })
  })

  it('deletes a task using its checked original ETag', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ etag: 'task-v1' })).mockResolvedValueOnce(response(null, 204))
    vi.stubGlobal('fetch', fetch)
    await connector().deleteTask(task)
    expect(fetch.mock.calls[1][1]).toMatchObject({ method: 'DELETE', headers: { 'If-Match': 'task-v1' } })
  })

  it('moves tasks under a parent and back to the top level using protected writes', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ etag: 'task-v1' })).mockResolvedValueOnce(response({ id: 'task', etag: 'v2', parent: 'parent' })).mockResolvedValueOnce(response({ etag: 'v2' })).mockResolvedValueOnce(response({ id: 'task', etag: 'v3' }))
    vi.stubGlobal('fetch', fetch)
    const parent = { ...task, id: 'account:google-task:list:parent', remoteId: 'parent' }
    const child = await connector().moveTask(task, parent)
    expect(child.parentId).toBe(parent.id)
    expect(new URL(fetch.mock.calls[1][0]).searchParams.get('parent')).toBe('parent')
    expect((await connector().moveTask(child)).parentId).toBeUndefined()
    expect(new URL(fetch.mock.calls[3][0]).searchParams.has('parent')).toBe(false)
    expect(fetch.mock.calls[3][1].headers['If-Match']).toBe('v2')
  })

  it('rejects self-parenting and assigned-task mutations before reaching Google', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    await expect(connector().moveTask(task, task)).rejects.toThrow(/different parent/)
    await expect(connector().deleteTask({ ...task, assigned: true })).rejects.toThrow(/not writable/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('encodes remote path segments and produces unambiguous stable identities', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ items: [{ id: 'list/a:b', etag: 'l1' }] })).mockResolvedValueOnce(response({ items: [{ id: 'task/x:y', etag: 't1' }] })).mockResolvedValueOnce(response({ etag: 't1' })).mockResolvedValueOnce(response(null, 204))
    vi.stubGlobal('fetch', fetch)
    const current = (await connector().sync()).tasks[0]
    expect(current.id).toBe('account:google-task:list%2Fa%3Ab:task%2Fx%3Ay')
    await connector().deleteTask(current)
    expect(fetch.mock.calls[3][0]).toContain('/lists/list%2Fa%3Ab/tasks/task%2Fx%3Ay')
  })
})
