import { afterEach, describe, expect, it, vi } from 'vitest'
import { MicrosoftTasksConnector } from './microsoft-tasks-connector'
import { validTaskRecurrence } from './task-native-validation'

const base = 'https://graph.microsoft.com/v1.0/me/todo/lists'
const delta = `${base}/list/tasks/delta`
const cursor = `${delta}?$deltatoken=opaque`
const graphList = { id: 'list', displayName: 'Work', isOwner: true, wellknownListName: 'none' }
const recurrence = { pattern: { type: 'daily' as const, interval: 1, dayOfMonth: 0, month: 0, daysOfWeek: [], firstDayOfWeek: 'sunday', index: 'first' as const }, range: { type: 'noEnd' as const, startDate: '2026-10-01', endDate: '0001-01-01', numberOfOccurrences: 0, recurrenceTimeZone: 'GMT Standard Time' } }
const graphTask = { id: 'task', title: 'Task', '@odata.etag': 'v1', status: 'inProgress', importance: 'high', body: { contentType: 'html', content: '<p>Hello &amp; <b>world</b></p><script>secret()</script>' }, dueDateTime: { dateTime: '2026-10-05T09:30:00.0000000', timeZone: 'GMT Standard Time' }, recurrence }
const graphChild = { id: 'child', displayName: 'Step', isChecked: false, createdDateTime: '2026-10-01T00:00:00Z' }
const response = (value: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const connector = (write = true) => new MicrosoftTasksConnector('account', async () => 'synthetic-token', write)
function fixture(child = graphChild, task = graphTask) {
  const fetch = vi.fn().mockResolvedValueOnce(response({ value: [graphList] })).mockResolvedValueOnce(response({ value: [{ id: task.id }], '@odata.deltaLink': cursor })).mockResolvedValueOnce(response(task)).mockResolvedValueOnce(response({ value: [child] }))
  vi.stubGlobal('fetch', fetch)
  return fetch
}
async function snapshot() { fixture(); return connector().sync() }
afterEach(() => vi.unstubAllGlobals())

describe('Microsoft To Do adapter', () => {
  it('preserves native recurrence, rich body and wall-clock zone and gives checklists separate identities', async () => {
    const fetch = fixture(), next = await connector().sync()
    expect(fetch.mock.calls.every(([, init]) => !init.headers.Prefer)).toBe(true)
    expect(next.tasks[0]).toMatchObject({ id: 'account:microsoft-task:list:task', notes: 'Hello & world', due: graphTask.dueDateTime.dateTime, native: { recurrence, body: graphTask.body, priority: 'high', status: 'inProgress', dueTimeZone: 'GMT Standard Time' }, revision: 'v1', readOnly: false })
    expect(next.tasks[1]).toMatchObject({ id: 'account:microsoft-checklist:list:task:child', parentId: next.tasks[0].id, remoteParentId: 'task', kind: 'checklist', revisionMode: 'snapshot', readOnly: false })
    expect(next.tasks[1].revision).toMatch(/^snapshot:[a-f0-9]{64}$/)
    expect(next.lists[0]).toMatchObject({ revisionMode: 'snapshot', manageReadOnly: false })
    expect(next.checkpoints).toEqual({ [next.lists[0].id]: cursor })
    expect(connector().capabilities).toEqual({ recurrence: 'native', priority: 'native', due: 'date-time', subtasks: 'checklist', reparent: false })
  })

  it('paginates lists, delta tasks and checklist items before committing a checkpoint', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ value: [], '@odata.nextLink': `${base}?$skiptoken=l` }))
      .mockResolvedValueOnce(response({ value: [graphList] }))
      .mockResolvedValueOnce(response({ value: [], '@odata.nextLink': `${delta}?$skiptoken=t` }))
      .mockResolvedValueOnce(response({ value: [{ id: 'task' }], '@odata.deltaLink': cursor }))
      .mockResolvedValueOnce(response(graphTask))
      .mockResolvedValueOnce(response({ value: [graphChild], '@odata.nextLink': `${base}/list/tasks/task/checklistItems?$skiptoken=c` }))
      .mockResolvedValueOnce(response({ value: [{ ...graphChild, id: 'second' }] }))
    vi.stubGlobal('fetch', fetch)
    const next = await connector().sync()
    expect(next.tasks.map((item) => item.remoteId)).toEqual(['task', 'child', 'second'])
    expect(fetch).toHaveBeenCalledTimes(7)
  })

  it('refreshes checklist changes even when the parent delta is empty without mutating its input', async () => {
    const previous = await snapshot(), original = structuredClone(previous)
    const fetch = vi.fn().mockResolvedValueOnce(response({ value: [graphList] })).mockResolvedValueOnce(response({ value: [], '@odata.deltaLink': `${delta}?$deltatoken=new` })).mockResolvedValueOnce(response({ value: [{ ...graphChild, isChecked: true }] }))
    vi.stubGlobal('fetch', fetch)
    const next = await connector().sync(previous)
    expect(fetch.mock.calls[1][0]).toBe(cursor)
    expect(next.tasks[0]).toEqual(previous.tasks[0])
    expect(next.tasks[1].completed).toBe(true)
    expect(next.tasks[1].revision).not.toBe(previous.tasks[1].revision)
    expect(previous).toEqual(original)
  })

  it('hydrates partial deltas and drops children of a deleted parent', async () => {
    const previous = await snapshot()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response({ value: [graphList] })).mockResolvedValueOnce(response({ value: [{ id: 'task', '@removed': { reason: 'deleted' } }], '@odata.deltaLink': cursor })))
    expect((await connector().sync(previous)).tasks).toEqual([])
  })

  it.each([400, 404, 410])('rebuilds expired delta HTTP %s without retaining stale parents', async (status) => {
    const previous = await snapshot()
    const fetch = vi.fn().mockResolvedValueOnce(response({ value: [graphList] })).mockResolvedValueOnce(response({}, status)).mockResolvedValueOnce(response({ value: [], '@odata.deltaLink': cursor }))
    vi.stubGlobal('fetch', fetch)
    expect((await connector().sync(previous)).tasks).toEqual([])
    expect(fetch.mock.calls[2][0]).toBe(delta)
  })

  it('drops removed lists and rejects foreign account cache before requesting a token', async () => {
    const previous = await snapshot()
    const fetch = vi.fn().mockResolvedValue(response({ value: [] }))
    vi.stubGlobal('fetch', fetch)
    expect(await connector().sync(previous)).toEqual({ lists: [], tasks: [], checkpoints: {} })
    fetch.mockClear()
    await expect(connector().sync({ ...previous, lists: [{ ...previous.lists[0], accountId: 'other' }] })).rejects.toThrow(/another account/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['https://evil.test/steal', `${base}/other/tasks/delta?x=y`, `${delta}#fragment`, 'https://user:password@graph.microsoft.com/v1.0/me/todo/lists/list/tasks/delta'])('rejects unsafe continuation %s before attaching credentials', async (link) => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ value: [graphList] })).mockResolvedValueOnce(response({ value: [], '@odata.nextLink': link }))
    vi.stubGlobal('fetch', fetch)
    await expect(connector().sync()).rejects.toThrow(/unexpected/)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('rejects a repeated page, incomplete delta, and mixed next/delta response', async () => {
    for (const page of [{ value: [], '@odata.nextLink': delta }, { value: [] }, { value: [], '@odata.nextLink': `${delta}?x=1`, '@odata.deltaLink': cursor }]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response({ value: [graphList] })).mockResolvedValue(response(page)))
      await expect(connector().sync()).rejects.toThrow()
    }
  })

  it('keeps cache and cursors unchanged on a failed checklist refresh', async () => {
    const previous = await snapshot(), original = structuredClone(previous)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response({ value: [graphList] })).mockResolvedValueOnce(response({ value: [], '@odata.deltaLink': cursor })).mockResolvedValueOnce(response({}, 403)))
    await expect(connector().sync(previous)).rejects.toMatchObject({ status: 403 })
    expect(previous).toEqual(original)
  })

  it('preserves rich notes, progress, recurrence and due zone on unrelated edits and sends the real original ETag', async () => {
    const current = (await snapshot()).tasks[0]
    const fetch = vi.fn().mockResolvedValueOnce(response(graphTask)).mockResolvedValueOnce(response({ ...graphTask, title: 'Renamed', '@odata.etag': 'v2' }))
    vi.stubGlobal('fetch', fetch)
    const result = await connector().updateTask(current, { title: 'Renamed', completed: false, notes: current.notes, due: current.due })
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ title: 'Renamed', status: 'inProgress' })
    expect(fetch.mock.calls[1][1].headers['If-Match']).toBe('v1')
    expect(result.native?.body).toEqual(graphTask.body)
  })

  it('escapes edited notes, preserves a supplied native zone, and can clear recurrence and due', async () => {
    const current = (await snapshot()).tasks[0]
    const fetch = vi.fn().mockResolvedValueOnce(response(graphTask)).mockResolvedValueOnce(response(graphTask))
    vi.stubGlobal('fetch', fetch)
    await connector().updateTask(current, { title: 'Task', completed: true, notes: '<img onerror=x>\n&', native: { recurrence: null, priority: 'low' } })
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ title: 'Task', status: 'completed', body: { contentType: 'html', content: '&lt;img onerror=x&gt;<br>&amp;' }, dueDateTime: null, recurrence: null, importance: 'low' })
    fetch.mockReset().mockResolvedValueOnce(response(graphTask)).mockResolvedValueOnce(response(graphTask))
    await connector().updateTask(current, { title: 'Task', completed: false, notes: current.notes, due: '2026-10-06T08:00:00', native: { dueTimeZone: 'Eastern Standard Time' } })
    expect(JSON.parse(fetch.mock.calls[1][1].body).dueDateTime).toEqual({ dateTime: '2026-10-06T08:00:00', timeZone: 'Eastern Standard Time' })
  })

  it('creates native tasks, normalizes explicit offsets and reads text notes', async () => {
    const list = (await snapshot()).lists[0]
    const fetch = vi.fn().mockResolvedValueOnce(response({ ...graphTask, body: { contentType: 'text', content: '<literal> & text' } }))
    vi.stubGlobal('fetch', fetch)
    const result = await connector().createTask(list, { title: ' New ', completed: false, notes: 'N', due: '2026-10-06T10:00:00+02:00', native: { priority: 'high', recurrence } })
    expect(result.notes).toBe('<literal> & text')
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ title: 'New', importance: 'high', recurrence, dueDateTime: { dateTime: '2026-10-06T08:00:00.000', timeZone: 'UTC' } })
  })

  it.each(['update', 'delete'])('blocks a stale original task revision before %s', async (kind) => {
    const current = (await snapshot()).tasks[0]
    const fetch = vi.fn().mockResolvedValue(response({ ...graphTask, '@odata.etag': 'newer' }))
    vi.stubGlobal('fetch', fetch)
    await expect(kind === 'delete' ? connector().deleteTask(current) : connector().updateTask(current, { title: 'X', completed: false })).rejects.toMatchObject({ status: 412 })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('compares checklist snapshots without pretending the hash is a server ETag', async () => {
    const current = (await snapshot()).tasks[1]
    const fetch = vi.fn().mockResolvedValueOnce(response(graphChild)).mockResolvedValueOnce(response({ ...graphChild, isChecked: true }))
    vi.stubGlobal('fetch', fetch)
    expect((await connector().updateTask(current, { title: 'Step', completed: true })).completed).toBe(true)
    expect(fetch.mock.calls[1][1].headers).not.toHaveProperty('If-Match')
    expect(fetch.mock.calls[1][0]).toBe(`${base}/list/tasks/task/checklistItems/child`)
    fetch.mockReset().mockResolvedValue(response({ ...graphChild, displayName: 'Other edit' }))
    await expect(connector().deleteTask(current)).rejects.toMatchObject({ status: 412 })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('supports list CRUD with snapshot comparisons and protects system/shared lists', async () => {
    const current = (await snapshot()).lists[0]
    const fetch = vi.fn().mockResolvedValueOnce(response(graphList)).mockResolvedValueOnce(response({ ...graphList, displayName: 'Renamed' }))
    vi.stubGlobal('fetch', fetch)
    const renamed = await connector().updateList(current, 'Renamed')
    expect(renamed.title).toBe('Renamed')
    expect(fetch.mock.calls[1][1].headers).not.toHaveProperty('If-Match')
    fetch.mockReset().mockResolvedValueOnce(response({ ...graphList, displayName: 'Renamed' })).mockResolvedValueOnce(response(null, 204))
    await connector().deleteList(renamed)
    expect(fetch.mock.calls[1][1].method).toBe('DELETE')
    fetch.mockReset().mockResolvedValueOnce(response(graphList))
    expect((await connector().createList('Work')).title).toBe('Work')
    expect(fetch.mock.calls[0][1].method).toBe('POST')
    fetch.mockClear()
    await expect(connector().deleteList({ ...current, manageReadOnly: true })).rejects.toThrow(/cannot be changed/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('creates checklist children and rejects unsupported fields, nesting and reparenting before network I/O', async () => {
    const cached = await snapshot(), parent = cached.tasks[0], child = cached.tasks[1]
    const fetch = vi.fn().mockResolvedValueOnce(response(graphChild))
    vi.stubGlobal('fetch', fetch)
    expect((await connector().createTask(cached.lists[0], { title: 'Step', completed: false }, parent)).parentId).toBe(parent.id)
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ displayName: 'Step', isChecked: false })
    fetch.mockClear()
    await expect(connector().createTask(cached.lists[0], { title: 'X', completed: false, due: '2026-10-01' }, parent)).rejects.toThrow(/completion only/)
    await expect(connector().createTask(cached.lists[0], { title: 'X', completed: false }, child)).rejects.toThrow(/parent task/)
    await expect(connector().moveTask(child, parent)).rejects.toThrow(/reparent/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('holds read-only grants and tasks without ETags and never retries ambiguous writes', async () => {
    fixture(graphChild, { ...graphTask, '@odata.etag': '' })
    const cached = await connector().sync()
    expect(cached.tasks.every((task) => task.readOnly)).toBe(true)
    const fetch = vi.fn().mockRejectedValue(new Error('lost response'))
    vi.stubGlobal('fetch', fetch)
    await expect(connector().updateTask(cached.tasks[0], { title: 'X', completed: false })).rejects.toThrow(/not writable/)
    await expect(connector(false).createList('X')).rejects.toThrow(/Reconnect/)
    expect(fetch).not.toHaveBeenCalled()
    await expect(connector().createList('X')).rejects.toThrow(/lost response/)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('sanitizes rejected write errors rather than propagating provider response text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ error: 'token=secret account@example.test' }, 403)))
    await expect(connector().createList('X')).rejects.toThrow('Microsoft To Do write failed (403)')
  })
})

describe('native recurrence validation', () => {
  it('accepts Graph unused default fields but requires valid fields for each recurrence type', () => {
    expect(validTaskRecurrence(recurrence)).toBe(true)
    expect(validTaskRecurrence({ ...recurrence, pattern: { ...recurrence.pattern, type: 'absoluteMonthly' } })).toBe(false)
    expect(validTaskRecurrence({ ...recurrence, pattern: { ...recurrence.pattern, type: 'weekly' } })).toBe(false)
    expect(validTaskRecurrence({ ...recurrence, range: { ...recurrence.range, type: 'numbered' } })).toBe(false)
    expect(validTaskRecurrence({ ...recurrence, range: { ...recurrence.range, type: 'endDate' } })).toBe(false)
    expect(validTaskRecurrence({ ...recurrence, pattern: { type: 'relativeMonthly', interval: 1, daysOfWeek: ['monday'] } })).toBe(false)
    expect(validTaskRecurrence({ ...recurrence, pattern: { type: 'weekly', interval: 2, daysOfWeek: ['monday'], firstDayOfWeek: 'sunday' } })).toBe(true)
    expect(validTaskRecurrence({ ...recurrence, extra: 'secret' })).toBe(false)
  })
})
