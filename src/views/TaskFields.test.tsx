// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextMenuProvider } from '../components/ContextMenu'
import TasksView, { toggleTaskWithRecurrence } from './TasksView'
import type { TaskEntity, TaskSnapshot } from '../task-provider-types'
import type { TaskReminder } from '../task-fields-types'
import type { AppState, Task } from '../types'

const managed = { id: 'file-1', name: 'invoice.pdf', size: 2048, path: 'C:/profile/task-attachments/1.pdf', mime: 'pdf' }
const localTask: Task = { id: 'local-1', listId: 'Today', title: 'Pay invoice', priority: 'normal', completed: false, subtasks: [], due: '2026-10-20T09:00:00.000Z' }
const state = (tasks: Task[] = [localTask]): AppState => ({ accounts: [], events: [], contacts: [], notes: [], tasks })
const googleList = { id: 'g:list', accountId: 'g', provider: 'gmail' as const, remoteId: 'list', title: 'Google home', readOnly: false }
const msList = { id: 'm:list', accountId: 'm', provider: 'microsoft' as const, remoteId: 'list', title: 'Microsoft work', readOnly: false }
const googleRemote = { id: 'g:list:t', accountId: 'g', provider: 'gmail' as const, remoteId: 't', listId: googleList.id, remoteListId: 'list', title: 'Buy soil', completed: false, revision: 'g1', readOnly: false }
const msNative = { priority: 'normal' as const, status: 'notStarted' as const, start: '2026-10-20T09:00:00', startTimeZone: 'Europe/London', reminder: '2026-10-20T07:45:00.000Z', categories: ['Finance'], attachments: [{ id: 'att-1', name: 'spec.pdf', size: 4096 }] }
const msRemote = { id: 'm:list:t', accountId: 'm', provider: 'microsoft' as const, remoteId: 't', listId: msList.id, remoteListId: 'list', title: 'Quarterly report', completed: false, revision: 'v1', readOnly: false, kind: 'task' as const, native: msNative }
let snapshot: TaskSnapshot
let reminders: TaskReminder[]
let reminderListener: ((items: TaskReminder[]) => void) | undefined
const api = {
  createList: vi.fn(), renameList: vi.fn(), deleteList: vi.fn(), resolveList: vi.fn(), exportData: vi.fn(), importData: vi.fn(),
  snapshot: vi.fn(async () => structuredClone(snapshot)), onChanged: vi.fn(() => () => {}),
  sync: vi.fn(async () => snapshot), create: vi.fn(async () => snapshot), update: vi.fn(async () => snapshot), delete: vi.fn(async () => snapshot),
  move: vi.fn(async () => snapshot), setLocal: vi.fn(async () => snapshot), undo: vi.fn(async () => snapshot), resolve: vi.fn(async () => snapshot),
  reminders: {
    list: vi.fn(async () => reminders),
    dismiss: vi.fn(async () => []), snooze: vi.fn(async () => []),
    onChanged: vi.fn((callback: (items: TaskReminder[]) => void) => { reminderListener = callback; return () => {} })
  },
  attachments: {
    choose: vi.fn(async () => [managed]), open: vi.fn(async () => ({})),
    uploadNative: vi.fn(async () => snapshot), removeNative: vi.fn(async () => snapshot), openNative: vi.fn(async () => ({}))
  }
}
const entity = (remote: typeof googleRemote | typeof msRemote, overrides: Partial<TaskEntity> = {}): TaskEntity => ({ id: `${remote.id}-local`, accountId: remote.accountId, provider: remote.provider, listId: remote.listId, fields: { title: remote.title, completed: false, ...('native' in remote ? { native: remote.native } : {}) }, local: { priority: 'normal', recurrence: 'none' }, remote, ...overrides })
const renderView = (tasks?: Task[], onChange = vi.fn()) => render(<ContextMenuProvider><TasksView state={state(tasks)} query="" onChange={onChange} onToast={vi.fn()} /></ContextMenuProvider>)
beforeEach(() => {
  vi.clearAllMocks()
  reminders = []
  snapshot = {
    lists: [googleList, msList], tasks: [entity(googleRemote), entity(msRemote)], remoteTasks: [googleRemote, msRemote], operations: [],
    accounts: [{ accountId: 'g', provider: 'gmail', canRead: true, canWrite: true, archived: false, phase: 'ready' }, { accountId: 'm', provider: 'microsoft', canRead: true, canWrite: true, archived: false, phase: 'ready' }]
  }
  window.confirm = vi.fn(() => true)
  Object.defineProperty(window, 'aerio', { configurable: true, value: { tasks: api, mail: { accounts: { reconnect: vi.fn() } } } })
})

describe('local task start, reminder, progress, tags and attachments', () => {
  it('saves every extended field on a local task, with managed attachments', async () => {
    const user = userEvent.setup(), onChange = vi.fn()
    renderView([], onChange)
    await user.click(screen.getByRole('button', { name: /New task/ }))
    await user.type(screen.getByPlaceholderText('What needs doing?'), 'File taxes')
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-10-19' } })
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '08:30' } })
    await user.selectOptions(screen.getByLabelText('Start time zone'), 'Asia/Tokyo')
    await user.click(screen.getByLabelText('Remind me'))
    fireEvent.change(screen.getByLabelText('Reminder time'), { target: { value: '2026-10-19T08:00' } })
    fireEvent.change(screen.getByLabelText('Percent complete'), { target: { value: '40' } })
    await user.type(screen.getByLabelText('Tags'), 'Money, home, money')
    await user.click(screen.getByRole('button', { name: /Add files/ }))
    expect(await screen.findByText('invoice.pdf')).toBeInTheDocument()
    expect(screen.queryByText('Aerio only')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save task' }))
    const saved = onChange.mock.calls.at(-1)![0].tasks[0] as Task
    expect(saved).toMatchObject({ title: 'File taxes', start: '2026-10-19T08:30:00', startTimeZone: 'Asia/Tokyo', percentComplete: 40, categories: ['Money', 'home'], attachments: [managed] })
    expect(new Date(saved.reminder!).getHours()).toBe(8)
  })

  it('shows extended fields on rows and removes cleared fields when saved', async () => {
    const user = userEvent.setup(), onChange = vi.fn()
    renderView([{ ...localTask, start: '2026-10-19', percentComplete: 50, categories: ['Bills'], attachments: [managed], reminder: '2026-10-20T08:00:00.000Z' }], onChange)
    expect(screen.getByText(/Starts 19 Oct 2026/)).toBeInTheDocument()
    expect(screen.getByText('50% done')).toBeInTheDocument()
    expect(screen.getByText('Bills')).toBeInTheDocument()
    expect(screen.getByLabelText('1 attachment')).toBeInTheDocument()
    await user.click(document.querySelector<HTMLButtonElement>('.task-main')!)
    await user.click(screen.getByLabelText('Remind me'))
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '' } })
    await user.click(screen.getByRole('button', { name: 'Remove invoice.pdf' }))
    await user.click(screen.getByRole('button', { name: 'Save task' }))
    const saved = onChange.mock.calls.at(-1)![0].tasks[0] as Task
    expect(saved).not.toHaveProperty('reminder'); expect(saved).not.toHaveProperty('start'); expect(saved).not.toHaveProperty('attachments')
    expect(saved).toMatchObject({ percentComplete: 50, categories: ['Bills'] })
  })

  it('opens managed attachments from the editor', async () => {
    const user = userEvent.setup()
    renderView([{ ...localTask, attachments: [managed] }])
    await user.click(document.querySelector<HTMLButtonElement>('.task-main')!)
    await user.click(screen.getByRole('button', { name: 'Open invoice.pdf' }))
    expect(api.attachments.open).toHaveBeenCalledWith(managed.path)
  })

  it('gives the next local occurrence an advanced start and the same local reminder offset', () => {
    // Saturday 28 March 2026 precedes the European daylight-saving change.
    const due = new Date(2026, 2, 28, 9, 0).toISOString(), reminder = new Date(2026, 2, 28, 8, 45).toISOString()
    const [completed, next] = toggleTaskWithRecurrence({ ...localTask, due, reminder, recurrence: 'daily', start: '2026-03-28', percentComplete: 70, categories: ['Daily'] })
    expect(completed).toMatchObject({ completed: true, percentComplete: 100 })
    expect(next).toMatchObject({ start: '2026-03-29', percentComplete: 0, categories: ['Daily'], completed: false })
    const nextReminder = new Date(next.reminder!), nextDue = new Date(next.due!)
    expect([nextReminder.getDate(), nextReminder.getHours(), nextReminder.getMinutes()]).toEqual([29, 8, 45])
    expect([nextDue.getDate(), nextDue.getHours()]).toEqual([29, 9])
  })
})

describe('connected task fields', () => {
  it('labels Google fields as Aerio-only and saves them as a local overlay', async () => {
    const user = userEvent.setup()
    renderView()
    await user.click(await screen.findByRole('button', { name: /Google home/ }))
    await user.click(screen.getByRole('button', { name: 'Open task Buy soil' }))
    const dialog = within(screen.getByRole('dialog', { name: 'Google task' }))
    expect(dialog.getAllByText('Aerio only')).toHaveLength(5)
    expect(dialog.getByText(/not supported by Google Tasks/)).toBeInTheDocument()
    fireEvent.change(dialog.getByLabelText('Start date'), { target: { value: '2026-10-21' } })
    fireEvent.change(dialog.getByLabelText('Percent complete'), { target: { value: '20' } })
    await user.type(dialog.getByLabelText('Tags'), 'Garden')
    await user.click(dialog.getByRole('button', { name: /Add files/ }))
    await dialog.findByText('invoice.pdf')
    await user.click(dialog.getByRole('button', { name: 'Save task' }))
    expect(api.update).toHaveBeenCalledWith('g:list:t-local', expect.objectContaining({ title: 'Buy soil' }), { priority: 'normal', recurrence: 'none', extended: { start: '2026-10-21', percentComplete: 20, categories: ['Garden'], attachments: [managed] } })
  })

  it('sends Microsoft start, reminder and categories natively and keeps percent complete local', async () => {
    const user = userEvent.setup()
    renderView()
    await user.click(await screen.findByRole('button', { name: /Microsoft work/ }))
    expect(screen.getByText('Finance')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Open task Quarterly report' }))
    const dialog = within(screen.getByRole('dialog', { name: 'Microsoft task' }))
    expect(dialog.getAllByText('Saved in Microsoft To Do')).toHaveLength(4)
    expect(dialog.getAllByText('Aerio only')).toHaveLength(1)
    expect((dialog.getByLabelText('Start time') as HTMLInputElement).value).toBe('09:00')
    fireEvent.change(dialog.getByLabelText('Start date'), { target: { value: '2026-10-22' } })
    await user.click(dialog.getByLabelText('Remind me'))
    await user.clear(dialog.getByLabelText('Tags')); await user.type(dialog.getByLabelText('Tags'), 'Finance, Board')
    fireEvent.change(dialog.getByLabelText('Percent complete'), { target: { value: '60' } })
    await user.click(dialog.getByRole('button', { name: 'Save task' }))
    expect(api.update).toHaveBeenCalledExactlyOnceWith('m:list:t-local', { native: { start: '2026-10-22T09:00:00', startTimeZone: 'Europe/London', reminder: null, categories: ['Finance', 'Board'] } }, { priority: 'normal', recurrence: 'none', extended: { percentComplete: 60 } })
  })

  it('saves only local Microsoft progress without a provider write', async () => {
    const user = userEvent.setup()
    renderView()
    await user.click(await screen.findByRole('button', { name: /Microsoft work/ }))
    await user.click(screen.getByRole('button', { name: 'Open task Quarterly report' }))
    const dialog = within(screen.getByRole('dialog', { name: 'Microsoft task' }))
    fireEvent.change(dialog.getByLabelText('Percent complete'), { target: { value: '30' } })
    await user.click(dialog.getByRole('button', { name: 'Save task' }))
    expect(api.update).not.toHaveBeenCalled()
    expect(api.setLocal).toHaveBeenCalledWith('m:list:t-local', { priority: 'normal', recurrence: 'none', extended: { percentComplete: 30 } })
  })

  it('adds, opens and removes Microsoft attachments immediately', async () => {
    const user = userEvent.setup()
    renderView()
    await user.click(await screen.findByRole('button', { name: /Microsoft work/ }))
    await user.click(screen.getByRole('button', { name: 'Open task Quarterly report' }))
    const dialog = within(screen.getByRole('dialog', { name: 'Microsoft task' }))
    await user.click(dialog.getByRole('button', { name: 'Open spec.pdf' }))
    expect(api.attachments.openNative).toHaveBeenCalledWith('m:list:t-local', 'att-1')
    await user.click(dialog.getByRole('button', { name: /Add files/ }))
    await waitFor(() => expect(api.attachments.uploadNative).toHaveBeenCalledWith('m:list:t-local'))
    await user.click(dialog.getByRole('button', { name: 'Remove spec.pdf' }))
    await waitFor(() => expect(api.attachments.removeNative).toHaveBeenCalledWith('m:list:t-local', 'att-1'))
    expect(api.update).not.toHaveBeenCalled()
  })

  it('asks new Microsoft tasks to be saved before attaching files', async () => {
    const user = userEvent.setup()
    renderView()
    await user.click(await screen.findByRole('button', { name: /Microsoft work/ }))
    await user.click(screen.getAllByRole('button', { name: /New task/ })[0])
    const dialog = within(screen.getByRole('dialog', { name: 'New Microsoft task' }))
    expect(dialog.getByText('Save this task before adding attachments.')).toBeInTheDocument()
    expect(dialog.getByRole('button', { name: /Add files/ })).toBeDisabled()
  })
})

describe('task reminders bar', () => {
  const fired = (overrides: Partial<TaskReminder> = {}): TaskReminder => ({ key: 'local:local-1:2026-10-20T08:00:00.000Z', source: 'local', taskId: 'local-1', title: 'Pay invoice', reminderAt: '2026-10-20T08:00:00.000Z', status: 'fired', firedAt: '2026-10-20T08:00:05.000Z', missed: true, ...overrides })

  it('lists fired reminders and dismisses or snoozes them', async () => {
    reminders = [fired()]
    const user = userEvent.setup()
    renderView()
    const bar = within(await screen.findByRole('region', { name: 'Task reminders' }))
    expect(bar.getByText(/Missed/)).toBeInTheDocument()
    await user.selectOptions(bar.getByLabelText('Snooze Pay invoice'), '1 hour')
    expect(api.reminders.snooze).toHaveBeenCalledWith(reminders[0].key, expect.stringMatching(/Z$/))
    const until = Date.parse((api.reminders.snooze.mock.calls[0] as unknown as string[])[1])
    expect(until - Date.now()).toBeGreaterThan(55 * 60_000)
    act(() => reminderListener!([fired()]))
    await user.click(await screen.findByRole('button', { name: 'Dismiss Pay invoice' }))
    expect(api.reminders.dismiss).toHaveBeenCalledWith(reminders[0].key)
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Task reminders' })).not.toBeInTheDocument())
  })

  it('opens the reminded local or connected task', async () => {
    reminders = [fired(), fired({ key: 'connected', source: 'connected', taskId: 'm:list:t-local', title: 'Quarterly report' })]
    const user = userEvent.setup()
    renderView()
    const bar = within(await screen.findByRole('region', { name: 'Task reminders' }))
    await user.click(bar.getByRole('button', { name: /^Pay invoice/ }))
    expect(screen.getByRole('dialog', { name: 'Edit task' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await user.click(bar.getByRole('button', { name: /^Quarterly report/ }))
    expect(await screen.findByRole('dialog', { name: 'Microsoft task' })).toBeInTheDocument()
  })
})
