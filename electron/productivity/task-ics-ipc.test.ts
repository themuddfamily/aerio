import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { Task } from '../../src/types'
import type { ProviderTask, TaskProviderConnector } from '../../src/task-provider-types'
import { parseVTodos } from '../../src/lib/vtodo'
import { taskIcsItems } from '../../src/lib/task-ics'
import { microsoftRecurrenceRule, registerTaskIcs } from './task-ics-ipc'
import { TaskService } from './task-service'
import { TaskStore } from './task-store'

const FILE = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Other//EN',
  'BEGIN:VTODO', 'UID:t-1', 'SUMMARY:Pay rent', 'DUE;VALUE=DATE:20261101', 'X-KEEP:yes', 'END:VTODO',
  'BEGIN:VTODO', 'UID:t-2', 'SUMMARY:Call bank', 'RELATED-TO:t-1', 'END:VTODO',
  'BEGIN:VEVENT', 'UID:e-1', 'DTSTART:20261101T090000Z', 'SUMMARY:Ignored event', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n')

let directory: string
let handlers: Map<string, (event: IpcMainInvokeEvent, ...args: any[]) => any>
let locked: boolean
let localTasks: Task[]
let store: TaskStore
let service: TaskService
let connector: TaskProviderConnector
const event = {} as IpcMainInvokeEvent
const list = { id: 'g:list', accountId: 'g', provider: 'gmail' as const, remoteId: 'list', title: 'Errands', readOnly: false, revision: 'l1' }
const remote: ProviderTask = { id: 'g:list:task', accountId: 'g', provider: 'gmail', remoteId: 'task', listId: list.id, remoteListId: 'list', title: 'Existing', completed: false, revision: 'v1', readOnly: false, due: '2026-10-30' }

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'aerio-task-ics-'))
  writeFileSync(join(directory, 'tasks.ics'), FILE)
  handlers = new Map()
  locked = false
  localTasks = [{ id: 'local-1', listId: 'Today', title: 'Local thing', priority: 'normal', completed: false, subtasks: [] }]
  store = new TaskStore(':memory:')
  store.replaceProviderSnapshot('g', 'gmail', { lists: [list], tasks: [remote], checkpoints: {} })
  let created = 0
  connector = {
    provider: 'gmail', capabilities: { recurrence: 'local', priority: 'local', due: 'date', subtasks: 'tasks' },
    sync: vi.fn(async () => ({ lists: [list], tasks: [remote], checkpoints: {} })), createList: vi.fn(), updateList: vi.fn(), deleteList: vi.fn(),
    createTask: vi.fn(async (_list, input, parent) => ({ ...remote, ...input, id: `g:list:new-${++created}`, remoteId: `new-${created}`, parentId: parent?.id })),
    updateTask: vi.fn(), deleteTask: vi.fn(), moveTask: vi.fn()
  }
  service = new TaskService(store, {
    accounts: async () => [{ id: 'g', provider: 'gmail', email: 'g@example.com', displayName: 'G', color: '#000', status: 'ready', archived: false, signature: '', notifications: false, syncEnabled: true }],
    access: () => ({ read: true, write: true }), connector: () => connector, online: () => true, changed: () => undefined
  })
  registerTaskIcs({
    ipcMain: { handle: (channel: string, handler: any) => { handlers.set(channel, handler) } } as any,
    service: () => service, localTasks: () => localTasks, davStore: () => undefined, isLocked: () => locked,
    openFile: async () => join(directory, 'tasks.ics'), saveFile: async (_event, name) => join(directory, `out-${name}`)
  })
})
afterEach(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }) })
const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args)

describe('.ics task IPC', () => {
  it('refuses every channel while Aerio is locked', async () => {
    locked = true
    for (const channel of ['tasks:ics:choose', 'tasks:ics:duplicates', 'tasks:ics:import-connected', 'tasks:ics:export']) {
      expect(() => invoke(channel)).toThrow(/Unlock Aerio/)
    }
  })

  it('previews the file’s tasks, ignoring events', async () => {
    const preview = await invoke('tasks:ics:choose')
    expect(preview).toMatchObject({ fileName: 'tasks.ics', items: [{ uid: 't-1', title: 'Pay rent', preserved: ['X-KEEP'] }, { uid: 't-2', parentUid: 't-1' }] })
    expect(preview.warnings).toContain('Events in this file were ignored; import them from Calendar')
  })

  it('validates input, imports into a connected list through the queue, and detects duplicates by UID', async () => {
    await expect(invoke('tasks:ics:import-connected', list.id, ['x'], 'merge')).rejects.toThrow(/duplicates/)
    await expect(invoke('tasks:ics:import-connected', list.id, [], 'skip')).rejects.toThrow(/Choose tasks/)
    const items = taskIcsItems(parseVTodos(FILE))
    const result = await invoke('tasks:ics:import-connected', list.id, items.map((item) => item.source), 'skip')
    expect(result).toMatchObject({ created: 2, skipped: 0 })
    expect(result.warnings.join('\n')).toMatch(/X-KEEP cannot be stored in Google Tasks/)
    await service.flush()
    expect(connector.createTask).toHaveBeenCalledTimes(2)
    // The subtask was created under its imported parent.
    expect(vi.mocked(connector.createTask).mock.calls[1][2]).toMatchObject({ title: 'Pay rent' })
    expect(await invoke('tasks:ics:duplicates', list.id, ['t-1', 't-2', 'unknown'])).toEqual(['t-1', 't-2'])
    expect(await invoke('tasks:ics:import-connected', list.id, items.map((item) => item.source), 'skip')).toMatchObject({ created: 0, skipped: 2 })
    // Exported tasks keep their imported UID, so a re-import is recognized.
    const exported = await invoke('tasks:ics:export', { kind: 'connected', listId: list.id })
    expect(exported.count).toBe(3)
    const text = readFileSync(exported.savedPath, 'utf8')
    expect(text).toContain('UID:t-1')
    expect(text).toContain('UID:task@gmail.tasks.aerio')
    expect(text).toContain('X-WR-CALNAME:Errands')
  })

  it('exports a local list to the chosen file', async () => {
    const result = await invoke('tasks:ics:export', { kind: 'local', listId: 'Today' })
    expect(result).toMatchObject({ savedPath: join(directory, 'out-Today.ics'), count: 1 })
    expect(readFileSync(result.savedPath, 'utf8')).toContain('SUMMARY:Local thing')
    await expect(invoke('tasks:ics:export', { kind: 'other', listId: 'x' })).rejects.toThrow(/Choose a task list/)
  })

  it('writes Microsoft recurrence patterns as RRULEs', () => {
    expect(microsoftRecurrenceRule({ pattern: { type: 'weekly', interval: 2, daysOfWeek: ['monday', 'friday'], firstDayOfWeek: 'monday' }, range: { type: 'endDate', startDate: '2026-10-01', endDate: '2026-12-31' } })).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;UNTIL=20261231')
    expect(microsoftRecurrenceRule({ pattern: { type: 'relativeMonthly', interval: 1, daysOfWeek: ['thursday'], index: 'last' }, range: { type: 'numbered', startDate: '2026-10-01', numberOfOccurrences: 6 } })).toBe('FREQ=MONTHLY;BYDAY=-1TH;COUNT=6')
  })
})
