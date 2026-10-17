import { afterEach, describe, expect, it, vi } from 'vitest'
import { MicrosoftTasksConnector } from './microsoft-tasks-connector'

// Controlled Graph fixtures for the E44 fields: startDateTime, reminderDateTime/isReminderOn,
// categories and taskFileAttachment. No real Microsoft account or network is used.
const base = 'https://graph.microsoft.com/v1.0/me/todo/lists'
const cursor = `${base}/list/tasks/delta?$deltatoken=opaque`
const graphList = { id: 'list', displayName: 'Work', isOwner: true, wellknownListName: 'none' }
const graphTask = {
  id: 'task', title: 'Quarterly report', '@odata.etag': 'v1', status: 'inProgress', importance: 'normal',
  startDateTime: { dateTime: '2026-10-20T09:00:00.0000000', timeZone: 'Europe/London' },
  reminderDateTime: { dateTime: '2026-10-20T07:45:00.0000000', timeZone: 'UTC' }, isReminderOn: true,
  categories: ['Finance', 'Q4'], hasAttachments: true
}
const attachment = { '@odata.type': '#microsoft.graph.taskFileAttachment', id: 'file-1', name: 'draft.pdf', size: 1200, contentType: 'application/pdf', lastModifiedDateTime: '2026-10-01T00:00:00Z' }
const response = (value: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const connector = (write = true) => new MicrosoftTasksConnector('account', async () => 'synthetic-token', write)
async function cached(task: Record<string, unknown> = graphTask) {
  const fetch = vi.fn().mockResolvedValueOnce(response({ value: [graphList] })).mockResolvedValueOnce(response({ value: [{ id: 'task' }], '@odata.deltaLink': cursor })).mockResolvedValueOnce(response(task))
  if (task.hasAttachments) fetch.mockResolvedValueOnce(response({ value: [attachment] }))
  fetch.mockResolvedValueOnce(response({ value: [] }))
  vi.stubGlobal('fetch', fetch)
  return (await connector().sync()).tasks[0]
}
afterEach(() => vi.unstubAllGlobals())

describe('Microsoft To Do start, reminder, category and attachment mapping', () => {
  it('maps native start, reminder instant, categories and attachment metadata', async () => {
    const task = await cached()
    expect(task.native).toMatchObject({ start: '2026-10-20T09:00:00', startTimeZone: 'Europe/London', reminder: '2026-10-20T07:45:00.000Z', categories: ['Finance', 'Q4'], attachments: [{ id: 'file-1', name: 'draft.pdf', size: 1200, contentType: 'application/pdf' }] })
    expect(task.native).not.toHaveProperty('attachments.0.contentBytes')
  })

  it('converts reminders stored in a provider zone and ignores reminders that are switched off', async () => {
    const zoned = await cached({ ...graphTask, hasAttachments: false, reminderDateTime: { dateTime: '2026-03-08T08:45:00.0000000', timeZone: 'Eastern Standard Time' } })
    expect(zoned.native?.reminder).toBe('2026-03-08T12:45:00.000Z')
    const off = await cached({ ...graphTask, hasAttachments: false, isReminderOn: false })
    expect(off.native).not.toHaveProperty('reminder')
    const plain = await cached({ id: 'task', title: 'Plain', '@odata.etag': 'v1' })
    expect(Object.keys(plain.native!).sort()).toEqual(['body', 'dueTimeZone', 'priority', 'recurrence', 'status'])
  })

  it('rejects malformed start values instead of caching them', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ value: [graphList] })).mockResolvedValueOnce(response({ value: [{ id: 'task' }], '@odata.deltaLink': cursor })).mockResolvedValueOnce(response({ ...graphTask, startDateTime: { dateTime: '2026-02-30T09:00:00', timeZone: 'UTC' } }))
    vi.stubGlobal('fetch', fetch)
    await expect(connector().sync()).rejects.toThrow()
  })

  it('writes only changed extended fields and preserves the rest on unrelated edits', async () => {
    const current = await cached()
    const fetch = vi.fn().mockImplementation(async () => response({ ...graphTask, hasAttachments: false }))
    vi.stubGlobal('fetch', fetch)
    await connector().updateTask(current, { title: 'Renamed', completed: false, notes: current.notes, due: current.due, native: { ...current.native } })
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ title: 'Renamed', status: 'inProgress' })
    fetch.mockClear()
    await connector().updateTask(current, { title: current.title, completed: false, notes: current.notes, native: { start: '2026-10-21', reminder: '2026-10-21T08:00:00.000Z', categories: ['Finance'] } })
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ title: 'Quarterly report', status: 'inProgress', startDateTime: { dateTime: '2026-10-21T00:00:00', timeZone: 'Europe/London' }, reminderDateTime: { dateTime: '2026-10-21T08:00:00', timeZone: 'UTC' }, isReminderOn: true, categories: ['Finance'] })
    fetch.mockClear()
    await connector().updateTask(current, { title: current.title, completed: false, notes: current.notes, native: { start: null, reminder: null, categories: [] } })
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ title: 'Quarterly report', status: 'inProgress', startDateTime: null, isReminderOn: false, categories: [] })
    fetch.mockClear()
    await connector().updateTask(current, { title: current.title, completed: false, notes: current.notes, native: { startTimeZone: 'Asia/Tokyo' } })
    expect(JSON.parse(fetch.mock.calls[1][1].body).startDateTime).toEqual({ dateTime: '2026-10-20T09:00:00', timeZone: 'Asia/Tokyo' })
  })

  it('creates tasks with a timed start, reminder and categories', async () => {
    const list = { id: 'account:microsoft-task-list:list', accountId: 'account', provider: 'microsoft' as const, remoteId: 'list', title: 'Work', readOnly: false, revision: 'r', revisionMode: 'snapshot' as const }
    const fetch = vi.fn().mockResolvedValueOnce(response({ ...graphTask, hasAttachments: false }))
    vi.stubGlobal('fetch', fetch)
    await connector().createTask(list, { title: 'New', completed: false, native: { start: '2026-10-22T14:30', startTimeZone: 'America/New_York', reminder: '2026-10-22T18:00:00.000Z', categories: ['Calls'] } })
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ startDateTime: { dateTime: '2026-10-22T14:30:00', timeZone: 'America/New_York' }, reminderDateTime: { dateTime: '2026-10-22T18:00:00', timeZone: 'UTC' }, isReminderOn: true, categories: ['Calls'] })
  })

  it('uploads small file attachments after a revision check and returns the re-read task', async () => {
    const current = await cached()
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(graphTask))
      .mockResolvedValueOnce(response({ ...attachment, id: 'file-2', name: 'notes.txt' }, 201))
      .mockResolvedValueOnce(response({ ...graphTask, '@odata.etag': 'v2' }))
      .mockResolvedValueOnce(response({ value: [attachment, { ...attachment, id: 'file-2', name: 'notes.txt', size: 5, contentType: 'text/plain' }] }))
    vi.stubGlobal('fetch', fetch)
    const result = await connector().addAttachment(current, { name: ' notes.txt ', contentType: 'text/plain', bytes: new Uint8Array(Buffer.from('hello')) })
    expect(fetch.mock.calls[1][0]).toBe(`${base}/list/tasks/task/attachments`)
    expect(fetch.mock.calls[1][1].method).toBe('POST')
    expect(fetch.mock.calls[1][1].headers).not.toHaveProperty('If-Match')
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ '@odata.type': '#microsoft.graph.taskFileAttachment', name: 'notes.txt', contentType: 'text/plain', contentBytes: 'aGVsbG8=' })
    expect(result.revision).toBe('v2')
    expect(result.native?.attachments?.map((item) => item.id)).toEqual(['file-1', 'file-2'])
  })

  it('refuses large, checklist, stale, or read-only attachment writes', async () => {
    const current = await cached()
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => response({ ...graphTask, '@odata.etag': 'newer' })))
    await expect(connector().addAttachment(current, { name: 'big.bin', bytes: new Uint8Array(3 * 1024 * 1024 + 1) })).rejects.toThrow('3 MB')
    await expect(connector().addAttachment(current, { name: 'a.txt', bytes: new Uint8Array(1) })).rejects.toMatchObject({ status: 412 })
    await expect(connector().deleteAttachment(current, 'file-1')).rejects.toMatchObject({ status: 412 })
    await expect(connector(false).addAttachment(current, { name: 'a.txt', bytes: new Uint8Array(1) })).rejects.toThrow('Reconnect')
    await expect(connector().addAttachment({ ...current, kind: 'checklist' }, { name: 'a.txt', bytes: new Uint8Array(1) })).rejects.toThrow()
  })

  it('deletes attachments and downloads attachment contents', async () => {
    const current = await cached()
    const fetch = vi.fn().mockResolvedValueOnce(response(graphTask)).mockResolvedValueOnce(response(undefined, 204)).mockResolvedValueOnce(response({ ...graphTask, hasAttachments: false, '@odata.etag': 'v3' }))
    vi.stubGlobal('fetch', fetch)
    const result = await connector().deleteAttachment(current, 'file-1')
    expect(fetch.mock.calls[1]).toEqual([`${base}/list/tasks/task/attachments/file-1`, expect.objectContaining({ method: 'DELETE' })])
    expect(result.native).not.toHaveProperty('attachments')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(Buffer.from('pdf-bytes'), { status: 200 })))
    expect(Buffer.from(await connector().readAttachment(current, 'file-1')).toString()).toBe('pdf-bytes')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 })))
    await expect(connector().readAttachment(current, 'file-1')).rejects.toMatchObject({ status: 404 })
  })
})
