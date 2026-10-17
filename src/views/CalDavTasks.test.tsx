// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextMenuProvider } from '../components/ContextMenu'
import TasksView from './TasksView'
import type { ProviderTask, TaskEntity, TaskSnapshot } from '../task-provider-types'
import type { TaskIcsPreview } from '../task-interchange-types'
import type { AppState, Task } from '../types'
import { parseVTodos } from '../lib/vtodo'
import { taskIcsItems } from '../lib/task-ics'

const davList = { id: 'dav-1:c1', accountId: 'dav-1', provider: 'dav' as const, remoteId: 'https://dav.example.com/cal/tasks/', title: 'Reminders', readOnly: false, revision: 'ctag-1' }
const remote: ProviderTask = {
  id: 'dav-1:c1:todo:1', accountId: 'dav-1', provider: 'dav', remoteId: 'https://dav.example.com/cal/tasks/a.ics', listId: davList.id, remoteListId: davList.remoteId,
  title: 'Water plants', completed: false, revision: '"e1"', readOnly: false, due: '2026-10-20',
  native: {
    priority: 'normal', status: 'notStarted', categories: ['Home'], percentComplete: 20,
    caldav: { uid: 'plants', recurrence: 'FREQ=WEEKLY;BYDAY=MO', recurrenceNote: 'Repeat rules from the server are kept as they are.', links: [{ uri: 'https://example.com/guide', name: 'Care guide' }], inlineAttachments: [{ name: 'photo.jpg', size: 2048 }], preserved: ['X-APPLE-SORT-ORDER'] }
  }
}
const entity: TaskEntity = { id: 'entity-1', accountId: 'dav-1', provider: 'dav', listId: davList.id, fields: { title: remote.title, completed: false, due: remote.due, native: remote.native }, local: { priority: 'normal', recurrence: 'none' }, remote }
const localTask: Task = { id: 'local-1', listId: 'Today', title: 'Existing', priority: 'normal', completed: false, subtasks: [], icalendar: { uid: 'dup-1' } }
const FILE = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Other//EN', 'BEGIN:VTODO', 'UID:dup-1', 'SUMMARY:From the file', 'X-KEEP:1', 'END:VTODO', 'BEGIN:VTODO', 'UID:new-1', 'SUMMARY:Brand new', 'RRULE:FREQ=DAILY', 'END:VTODO', 'END:VCALENDAR', ''].join('\r\n')
const preview: TaskIcsPreview = { fileName: 'export.ics', items: taskIcsItems(parseVTodos(FILE)), warnings: [] }

let snapshot: TaskSnapshot
const api = {
  createList: vi.fn(), renameList: vi.fn(), deleteList: vi.fn(), resolveList: vi.fn(), exportData: vi.fn(), importData: vi.fn(),
  snapshot: vi.fn(async () => structuredClone(snapshot)), onChanged: vi.fn(() => () => {}),
  sync: vi.fn(async () => snapshot), create: vi.fn(async () => snapshot), update: vi.fn(async () => snapshot), delete: vi.fn(async () => snapshot),
  move: vi.fn(async () => snapshot), setLocal: vi.fn(async () => snapshot), undo: vi.fn(async () => snapshot), resolve: vi.fn(async () => snapshot),
  reminders: { list: vi.fn(async () => []), dismiss: vi.fn(), snooze: vi.fn(), onChanged: vi.fn(() => () => {}) },
  ics: {
    choose: vi.fn(async () => preview), duplicates: vi.fn(async () => ['dup-1']),
    importConnected: vi.fn(async () => ({ created: 1, replaced: 0, skipped: 1, snapshot, warnings: [] })),
    exportList: vi.fn(async () => ({ savedPath: 'C:/out/Reminders.ics', count: 1 }))
  }
}
const state = (tasks: Task[]): AppState => ({ accounts: [], events: [], contacts: [], notes: [], tasks })
beforeEach(() => {
  vi.clearAllMocks()
  snapshot = { lists: [davList], tasks: [entity], remoteTasks: [remote], operations: [], accounts: [{ accountId: 'dav-1', provider: 'dav', name: 'Fastmail · ada', canRead: true, canWrite: true, archived: false, syncEnabled: true, phase: 'ready' }] }
  Object.defineProperty(window, 'aerio', { configurable: true, value: { tasks: api, mail: { accounts: { reconnect: vi.fn() } } } })
})
const renderView = (tasks: Task[] = [localTask], onChange = vi.fn(), onToast = vi.fn()) => render(<ContextMenuProvider><TasksView state={state(tasks)} query="" onChange={onChange} onToast={onToast} /></ContextMenuProvider>)

describe('CalDAV tasks in the Tasks view', () => {
  it('lists the CalDAV account and edits VTODO fields, showing what is kept read-only', async () => {
    const user = userEvent.setup()
    renderView()
    await user.click(await screen.findByRole('button', { name: /Reminders/ }))
    expect(screen.getByText(/CalDAV tasks · 1 still open/)).toBeInTheDocument()
    expect(screen.getByText('Fastmail · ada')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Connect/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Open task Water plants' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/Repeats weekly on Monday/)).toBeInTheDocument()
    expect(within(dialog).getByText('Care guide')).toBeInTheDocument()
    expect(within(dialog).getByText(/kept on the server, read-only in Aerio/)).toBeInTheDocument()
    expect(within(dialog).getByText(/Kept unchanged on every save: X-APPLE-SORT-ORDER/)).toBeInTheDocument()
    await user.selectOptions(within(dialog).getByLabelText('Status'), 'inProgress')
    await user.selectOptions(within(dialog).getByLabelText('Priority'), 'high')
    fireEvent.change(within(dialog).getByLabelText('Percent complete'), { target: { value: '60' } })
    fireEvent.change(within(dialog).getByLabelText('Due time'), { target: { value: '17:30' } })
    await user.click(within(dialog).getByRole('button', { name: 'Save task' }))
    await waitFor(() => expect(api.update).toHaveBeenCalled())
    const [id, patch] = api.update.mock.calls[0] as unknown as [string, Record<string, any>]
    expect(id).toBe('entity-1')
    expect(patch.due).toBe('2026-10-20T17:30:00')
    expect(patch.native).toMatchObject({ status: 'inProgress', priority: 'high', percentComplete: 60 })
    expect(patch.native.caldav).toBeUndefined()
  })

  it('previews an .ics file and imports into a local list with duplicates replaced', async () => {
    const user = userEvent.setup(), onChange = vi.fn()
    renderView([localTask], onChange)
    await user.click(await screen.findByRole('button', { name: 'Import tasks' }))
    const dialog = await screen.findByRole('dialog', { name: /Import tasks/ })
    expect(within(dialog).getByText(/1 task in this file already exist/)).toBeInTheDocument()
    expect(within(dialog).getAllByText(/Repeats daily/).length).toBeGreaterThan(0)
    await user.click(within(dialog).getByLabelText(/Replace them/))
    await user.click(within(dialog).getByRole('button', { name: 'Import 2 tasks' }))
    const tasks = onChange.mock.calls[0][0].tasks as Task[]
    expect(tasks.map((task) => [task.title, task.listId])).toEqual([['Brand new', 'Today'], ['From the file', 'Today']])
    expect(tasks.find((task) => task.title === 'From the file')).toMatchObject({ id: 'local-1', icalendar: { uid: 'dup-1', source: expect.stringContaining('X-KEEP:1') } })
    expect(tasks.find((task) => task.title === 'Brand new')!.recurrence).toBe('daily')
  })

  it('imports into a connected list with the chosen duplicate handling and exports the open list', async () => {
    const user = userEvent.setup(), onToast = vi.fn()
    renderView([localTask], vi.fn(), onToast)
    await user.click(await screen.findByRole('button', { name: /Reminders/ }))
    await user.click(screen.getByRole('button', { name: 'Import tasks' }))
    const dialog = await screen.findByRole('dialog', { name: /Import tasks/ })
    expect(within(dialog).getByLabelText('Import into')).toHaveValue(`connected:${davList.id}`)
    await waitFor(() => expect(api.ics.duplicates).toHaveBeenCalledWith(davList.id, ['dup-1', 'new-1']))
    await user.click(within(dialog).getByLabelText(/Import them as copies/))
    await user.click(within(dialog).getByRole('button', { name: 'Import 2 tasks' }))
    expect(api.ics.importConnected).toHaveBeenCalledWith(davList.id, preview.items.map((item) => item.source), 'copy')
    await user.click(screen.getByRole('button', { name: 'Export Reminders as .ics' }))
    expect(api.ics.exportList).toHaveBeenCalledWith({ kind: 'connected', listId: davList.id })
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('1 task exported'))
  })
})
