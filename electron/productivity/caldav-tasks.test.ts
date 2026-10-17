import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ICS, VTODO, type FixtureCollection } from './dav-fixture-server'
import { createDavHarness, type DavHarness } from './dav-test-harness'
import { CalDavTasksConnector, davTaskAccounts } from './caldav-tasks'
import { TaskService } from './task-service'
import { TaskStore } from './task-store'
import { parseTaskBackup } from './task-backup'
import { connectedImportInput, taskIcsItems } from '../../src/lib/task-ics'
import { parseVTodos } from '../../src/lib/vtodo'

let harness: DavHarness | undefined
let service: TaskService | undefined
const directories: string[] = []
afterEach(async () => {
  await service?.close().catch(() => undefined)
  service = undefined
  await harness?.close()
  harness = undefined
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

interface Ready { h: DavHarness; accountId: string; tasks: TaskStore; service: TaskService; network: { online: boolean }; home: FixtureCollection }

async function ready(options: Parameters<typeof createDavHarness>[0] = {}, path = ':memory:', seed?: (h: DavHarness, home: FixtureCollection) => void): Promise<Ready> {
  harness = await createDavHarness(options)
  const h = harness
  const home = h.server.addCollection({ slug: 'home', kind: 'calendar', name: 'Home', components: ['VEVENT', 'VTODO'] })
  seed?.(h, home)
  const account = await h.add()
  return start(h, account.id, home, path)
}

async function start(h: DavHarness, accountId: string, home: FixtureCollection, path: string): Promise<Ready> {
  const tasks = new TaskStore(path)
  const network = { online: true }
  service = new TaskService(tasks, {
    accounts: async () => davTaskAccounts(h.service),
    access: () => ({ read: true, write: true }),
    connector: (id) => new CalDavTasksConnector(id, h.service, h.store),
    online: () => network.online,
    changed: () => undefined
  })
  await service.sync(accountId)
  return { h, accountId, tasks, service, network, home }
}

const named = (r: Ready, title: string) => r.tasks.entities(r.accountId, 'dav').find((task) => task.fields.title === title)
const list = (r: Ready, name: string) => r.tasks.providerSnapshot(r.accountId, 'dav').lists.find((item) => item.title === name)!
const setOnline = (r: Ready, online: boolean) => { r.network.online = online; r.h.state.online = online }

describe('CalDAV tasks: routing and synchronization', () => {
  it('sends VTODOs to Tasks and VEVENTs to Calendar, for task-only and mixed calendars', async () => {
    const r = await ready({}, ':memory:', (h, home) => {
      h.server.write(h.tasks, 'milk.ics', VTODO('milk', 'Buy milk', 'DUE;VALUE=DATE:20261020'))
      h.server.write(home, 'party.ics', ICS('party', 'House party'))
      h.server.write(home, 'clean.ics', VTODO('clean', 'Clean kitchen', 'PRIORITY:1'))
      h.server.write(h.work, 'standup.ics', ICS('standup', 'Standup'))
    })
    const calendars = r.h.productivity.snapshot().calendars.map((calendar) => calendar.name).sort()
    expect(calendars).toEqual(['Holidays', 'Home', 'Work'])
    expect(r.h.productivity.snapshot().events.map((event) => event.title).sort()).toEqual(['House party', 'Standup'])
    const snapshot = await r.service.snapshot()
    expect(snapshot.lists.map((item) => [item.title, item.readOnly, item.manageReadOnly ?? false])).toEqual([['Reminders', false, false], ['Home', false, true]])
    expect(snapshot.tasks.map((task) => task.fields.title).sort()).toEqual(['Buy milk', 'Clean kitchen'])
    expect(snapshot.accounts[0]).toMatchObject({ provider: 'dav', canWrite: true, name: expect.stringContaining('ada@example.com') })
    expect(named(r, 'Clean kitchen')!.fields.native).toMatchObject({ priority: 'high', status: 'notStarted', caldav: { uid: 'clean' } })
  })

  it('never deletes tasks when an event in the same calendar object is deleted', async () => {
    const r = await ready({}, ':memory:', (h, home) => {
      h.server.write(home, 'both.ics', ICS('both', 'Combined').replace('END:VEVENT', 'END:VEVENT\r\nBEGIN:VTODO\r\nUID:both-todo\r\nSUMMARY:Hidden todo\r\nEND:VTODO'))
    })
    const task = named(r, 'Hidden todo')!
    expect(task.remote).toMatchObject({ readOnly: true, native: { caldav: { readOnlyReason: expect.stringMatching(/also holds events/) } } })
    await expect(r.service.update(task.id, { title: 'Changed' })).rejects.toThrow(/read-only/)
    const event = r.h.productivity.snapshot().events.find((item) => item.title === 'Combined')!
    await r.h.service.deleteEvent(event)
    const stored = r.h.server.resource(r.home, 'both.ics')!.data
    expect(stored).toContain('SUMMARY:Hidden todo')
    expect(stored).not.toContain('VEVENT')
  })

  it('pulls incrementally with sync-collection and multiget, and removes deleted tasks', async () => {
    const r = await ready()
    r.h.server.requests.length = 0
    r.h.server.write(r.h.tasks, 'new.ics', VTODO('new', 'Renew passport'))
    await r.service.sync(r.accountId)
    expect(named(r, 'Renew passport')).toBeDefined()
    expect(r.h.requests('REPORT').map((request) => request.body.match(/sync-collection|calendar-multiget/)?.[0])).toEqual(expect.arrayContaining(['sync-collection', 'calendar-multiget']))
    expect(r.h.requests('REPORT').find((request) => request.body.includes('sync-collection') && request.path.includes('/tasks/'))?.body).toMatch(/<d:sync-token>http:\/\/fixture\/sync\/\d+</)
    r.h.server.remove(r.h.tasks, 'new.ics')
    await r.service.sync(r.accountId)
    expect(named(r, 'Renew passport')).toBeUndefined()
  })

  it('falls back to ctag and ETag listing when sync-collection is unavailable', async () => {
    const r = await ready({ syncCollection: false }, ':memory:', (h) => { h.server.write(h.tasks, 'a.ics', VTODO('a', 'First')) })
    expect(named(r, 'First')).toBeDefined()
    r.h.server.requests.length = 0
    await r.service.sync(r.accountId)
    // Unchanged ctag: one Depth 0 PROPFIND per task calendar and no listing.
    expect(r.h.requests('PROPFIND').filter((request) => request.headers.depth === '1' && request.path.endsWith('/tasks/'))).toHaveLength(0)
    r.h.server.write(r.h.tasks, 'b.ics', VTODO('b', 'Second'))
    await r.service.sync(r.accountId)
    expect(named(r, 'Second')).toBeDefined()
    expect(r.tasks.providerSnapshot(r.accountId, 'dav').lists.find((item) => item.title === 'Reminders')).toBeDefined()
  })
})

describe('CalDAV tasks: writes, conflicts, and recovery', () => {
  it('queues offline edits and sends them with If-Match, patching only edited properties', async () => {
    const r = await ready({}, ':memory:', (h) => {
      h.server.write(h.tasks, 'report.ics', VTODO('report', 'Write report', 'DUE;TZID=Europe/Paris:20261021T170000\nX-CUSTOM;X-P=1:keep me\nATTACH;ENCODING=BASE64;VALUE=BINARY;FILENAME=a.txt:SGk=\nBEGIN:VALARM\nACTION:DISPLAY\nTRIGGER;RELATED=END:-PT1H\nEND:VALARM'))
    })
    const task = named(r, 'Write report')!
    expect(task.fields).toMatchObject({ due: '2026-10-21T17:00:00', native: { dueTimeZone: 'Europe/Paris', reminder: '2026-10-21T14:00:00.000Z', caldav: { inlineAttachments: [{ name: 'a.txt' }], preserved: ['X-CUSTOM'] } } })
    const etag = r.h.server.resource(r.h.tasks, 'report.ics')!.etag
    setOnline(r, false)
    await r.service.update(task.id, { title: 'Write final report', completed: true, native: { percentComplete: 100, categories: ['Work'] } })
    await r.service.flush()
    expect(r.h.requests('PUT')).toHaveLength(0)
    expect(r.tasks.operations()[0]).toMatchObject({ status: 'queued', attempts: 0 })
    setOnline(r, true)
    await r.service.flush()
    const put = r.h.requests('PUT')[0]
    expect(put.headers['if-match']).toBe(etag)
    const stored = r.h.server.resource(r.h.tasks, 'report.ics')!.data
    for (const kept of ['DUE;TZID=Europe/Paris:20261021T170000', 'X-CUSTOM;X-P=1:keep me', 'ATTACH;ENCODING=BASE64;VALUE=BINARY;FILENAME=a.txt:SGk=', 'TRIGGER;RELATED=END:-PT1H']) expect(stored).toContain(kept)
    for (const edited of ['SUMMARY:Write final report', 'STATUS:COMPLETED', 'PERCENT-COMPLETE:100', 'CATEGORIES:Work']) expect(stored).toContain(edited)
    expect(r.tasks.operations()[0].status).toBe('succeeded')
    expect(named(r, 'Write final report')!.remote!.revision).toBe(r.h.server.resource(r.h.tasks, 'report.ics')!.etag)
  })

  it('sends a 412 to conflict review and retries on top of the other client’s version', async () => {
    const r = await ready({}, ':memory:', (h) => { h.server.write(h.tasks, 't.ics', VTODO('t', 'Shared task', 'PRIORITY:5')) })
    const task = named(r, 'Shared task')!
    setOnline(r, false)
    await r.service.update(task.id, { title: 'My title' })
    r.h.server.write(r.h.tasks, 't.ics', VTODO('t', 'Shared task', 'PRIORITY:1\nX-OTHER:theirs'))
    setOnline(r, true)
    await r.service.flush()
    const operation = r.tasks.operations()[0]
    expect(operation).toMatchObject({ status: 'conflict', error: 'revision-conflict' })
    await r.service.sync(r.accountId)
    const current = (await r.service.snapshot()).remoteTasks.find((item) => item.id === operation.base!.id)!
    expect(current.native?.priority).toBe('high')
    await r.service.resolve(operation.id, { action: 'retry', expectedRevision: current.revision })
    await r.service.flush()
    const stored = r.h.server.resource(r.h.tasks, 't.ics')!.data
    expect(stored).toContain('SUMMARY:My title')
    expect(stored).toContain('PRIORITY:1')
    expect(stored).toContain('X-OTHER:theirs')
  })

  it('reviews edits to tasks deleted on the server and lets the user discard them', async () => {
    const r = await ready({}, ':memory:', (h) => { h.server.write(h.tasks, 'gone.ics', VTODO('gone', 'Soon gone')) })
    const task = named(r, 'Soon gone')!
    setOnline(r, false)
    await r.service.update(task.id, { notes: 'Too late' })
    r.h.server.remove(r.h.tasks, 'gone.ics')
    setOnline(r, true)
    await r.service.flush()
    const operation = r.tasks.operations()[0]
    expect(operation.status).toBe('conflict')
    expect(r.h.server.resource(r.h.tasks, 'gone.ics')).toBeUndefined()
    await r.service.resolve(operation.id, { action: 'discard' })
    await r.service.sync(r.accountId)
    expect(named(r, 'Soon gone')).toBeUndefined()
    // Deleting a task that is already gone on the server completes quietly.
    r.h.server.write(r.h.tasks, 'x.ics', VTODO('x', 'Delete me'))
    await r.service.sync(r.accountId)
    const doomed = named(r, 'Delete me')!
    setOnline(r, false)
    await r.service.delete(doomed.id)
    r.h.server.remove(r.h.tasks, 'x.ics')
    setOnline(r, true)
    await r.service.flush()
    expect(r.tasks.operations().at(-1)!.status).toBe('succeeded')
  })

  it('edits and deletes only one occurrence of a repeating task', async () => {
    const r = await ready({}, ':memory:', (h) => {
      h.server.write(h.tasks, 'series.ics', VTODO('series', 'Water plants', 'DUE;VALUE=DATE:20261019\nRRULE:FREQ=WEEKLY', 'BEGIN:VTODO\r\nUID:series\r\nRECURRENCE-ID;VALUE=DATE:20261026\r\nDUE;VALUE=DATE:20261027\r\nSUMMARY:Water plants (late)\r\nEND:VTODO'))
    })
    const master = named(r, 'Water plants')!
    const occurrence = named(r, 'Water plants (late)')!
    expect(master.remote!.native!.caldav).toMatchObject({ recurrence: 'FREQ=WEEKLY', recurrenceNote: expect.stringMatching(/kept as they are/) })
    expect(occurrence.remote!.native!.caldav).toMatchObject({ recurrenceId: '20261026', recurrenceNote: expect.stringMatching(/this occurrence only/) })
    await expect(r.service.move(occurrence.id, master.id)).rejects.toThrow(/occurrence/)
    await expect(r.service.update(master.id, { native: { recurrence: null } })).rejects.toThrow(/do not support/)
    await r.service.update(occurrence.id, { title: 'Water plants (balcony)', completed: true })
    await r.service.flush()
    let stored = r.h.server.resource(r.h.tasks, 'series.ics')!.data
    expect(stored).toContain('SUMMARY:Water plants\r\n')
    expect(stored).toContain('SUMMARY:Water plants (balcony)')
    expect(stored.match(/STATUS:COMPLETED/g)).toHaveLength(1)
    expect(stored).toContain('RRULE:FREQ=WEEKLY')
    await r.service.delete(named(r, 'Water plants (balcony)')!.id)
    await r.service.flush()
    stored = r.h.server.resource(r.h.tasks, 'series.ics')!.data
    expect(stored).toContain('EXDATE;VALUE=DATE:20261026')
    expect(stored).not.toContain('balcony')
    expect(named(r, 'Water plants')).toBeDefined()
  })

  it('detects read-only task lists from privileges and blocks edits before sending', async () => {
    const r = await ready({}, ':memory:', (h) => {
      const shared = h.server.addCollection({ slug: 'shared-tasks', kind: 'calendar', name: 'Team tasks', components: ['VTODO'], readOnly: true })
      h.server.write(shared, 's.ics', VTODO('s', 'Team item'))
    })
    expect(list(r, 'Team tasks')).toMatchObject({ readOnly: true, manageReadOnly: true })
    const task = named(r, 'Team item')!
    expect(task.remote!.readOnly).toBe(true)
    await expect(r.service.update(task.id, { title: 'x' })).rejects.toThrow(/read-only/)
    await expect(r.service.create(r.accountId, list(r, 'Team tasks').id, { title: 'New', completed: false })).rejects.toThrow(/read-only/)
    expect(r.h.requests('PUT')).toHaveLength(0)
  })

  it('creates lists with MKCALENDAR and tasks and subtasks with If-None-Match', async () => {
    const r = await ready()
    await r.service.createList(r.accountId, 'Groceries')
    await r.service.flush()
    const created = list(r, 'Groceries')
    expect(r.h.requests('MKCALENDAR')[0].body).toContain('<c:comp name="VTODO"/>')
    await r.service.create(r.accountId, created.id, { title: 'Shopping', completed: false, due: '2026-10-22T18:00:00', native: { dueTimeZone: 'Europe/Berlin', priority: 'low', status: 'notStarted', reminder: '2026-10-22T15:00:00.000Z' } })
    await r.service.flush()
    const parent = named(r, 'Shopping')!
    await r.service.create(r.accountId, created.id, { title: 'Eggs', completed: false, native: { priority: 'normal', status: 'notStarted' } }, parent.id)
    await r.service.flush()
    const puts = r.h.requests('PUT')
    expect(puts.map((put) => put.headers['if-none-match'])).toEqual(['*', '*'])
    expect(puts[0].body).toContain('DUE;TZID=Europe/Berlin:20261022T180000')
    expect(puts[0].body).toContain('BEGIN:VTIMEZONE')
    expect(puts[0].body).toContain('TRIGGER;VALUE=DATE-TIME:20261022T150000Z')
    expect(puts[1].body).toContain(`RELATED-TO:${parent.remote!.native!.caldav!.uid}`)
    expect(named(r, 'Eggs')!.parentId).toBe(parent.id)
    await r.service.renameList(created.id, 'Weekly groceries')
    await r.service.flush()
    expect(list(r, 'Weekly groceries')).toBeDefined()
  })

  it('keeps queued writes across a restart and reviews writes interrupted mid-flight', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aerio-caldav-tasks-'))
    directories.push(directory)
    const path = join(directory, 'provider-tasks.sqlite')
    const r = await ready({}, path, (h) => { h.server.write(h.tasks, 'r.ics', VTODO('r', 'Survive restart')) })
    setOnline(r, false)
    await r.service.update(named(r, 'Survive restart')!.id, { title: 'Survived restart' })
    await r.service.close()
    service = undefined
    // The next launch opens the same file: the queued write is still there and is sent once online.
    const reopened = new TaskStore(path)
    expect(reopened.operations()).toMatchObject([{ kind: 'update', status: 'queued', attempts: 0, patch: { title: 'Survived restart' } }])
    service = new TaskService(reopened, { accounts: async () => davTaskAccounts(r.h.service), access: () => ({ read: true, write: true }), connector: (id) => new CalDavTasksConnector(id, r.h.service, r.h.store), online: () => true, changed: () => undefined })
    r.h.state.online = true
    await service.flush()
    expect(reopened.operations()[0].status).toBe('succeeded')
    expect(r.h.server.resource(r.h.tasks, 'r.ics')!.data).toContain('SUMMARY:Survived restart')
    // A write that was running when Aerio stopped is never resent automatically.
    setOnline(r, false)
    await service.update(reopened.entities(r.accountId, 'dav')[0].id, { title: 'Interrupted' })
    reopened.start(reopened.operations().at(-1)!.id)
    await service.close()
    service = undefined
    const recovered = new TaskStore(path)
    expect(recovered.operations().at(-1)).toMatchObject({ status: 'review', error: 'interrupted-write' })
    recovered.close()
  })

  it('backs up and restores the CalDAV task cache with pending writes held for review', async () => {
    const r = await ready({}, ':memory:', (h) => { h.server.write(h.tasks, 'b.ics', VTODO('b', 'Backed up', 'X-KEEP:1')) })
    setOnline(r, false)
    await r.service.update(named(r, 'Backed up')!.id, { title: 'Pending change' })
    const backup = parseTaskBackup(JSON.parse(JSON.stringify(r.tasks.exportBackup())))
    expect(backup.accounts[0].provider).toBe('dav')
    const restored = new TaskStore(':memory:')
    restored.restoreBackup(backup)
    expect(restored.operations()[0]).toMatchObject({ status: 'review', error: 'restored-write' })
    expect(restored.entities(r.accountId, 'dav').map((task) => task.fields.title)).toEqual(['Pending change'])
    restored.close()
  })

  it('imports .ics tasks with their full source and skips duplicates by UID', async () => {
    const r = await ready()
    const file = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Other//EN', 'BEGIN:VTODO', 'UID:imported-1', 'SUMMARY:From file', 'X-VENDOR:kept', 'CATEGORIES:Imported', 'END:VTODO', 'END:VCALENDAR', ''].join('\r\n')
    const items = taskIcsItems(parseVTodos(file))
    const target = list(r, 'Reminders')
    const toImport = items.map((item) => ({ uid: item.uid, build: (provider: 'dav' | 'gmail' | 'microsoft') => connectedImportInput(provider, item) }))
    expect(await r.service.importTasks(target.id, toImport, 'skip', () => 'copy@aerio.local')).toMatchObject({ created: 1, skipped: 0 })
    await r.service.flush()
    const stored = [...r.h.tasks.resources.values()].map((resource) => resource.data).join('\n')
    expect(stored).toContain('UID:imported-1')
    expect(stored).toContain('X-VENDOR:kept')
    expect(await r.service.duplicateUids(target.id, ['imported-1', 'other'])).toEqual(['imported-1'])
    expect(await r.service.importTasks(target.id, toImport, 'skip', () => 'copy@aerio.local')).toMatchObject({ created: 0, skipped: 1 })
    expect(await r.service.importTasks(target.id, toImport, 'copy', () => 'copy@aerio.local')).toMatchObject({ created: 1 })
    await r.service.flush()
    expect([...r.h.tasks.resources.values()].map((resource) => resource.data).join('\n')).toContain('UID:copy@aerio.local')
  })
})
