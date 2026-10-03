// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextMenuProvider } from '../components/ContextMenu'
import TasksView from './TasksView'
import type { TaskEntity, TaskOperation, TaskSnapshot } from '../task-provider-types'
import type { AppState } from '../types'

const list = { id: 'account:list', accountId: 'account', provider: 'gmail' as const, remoteId: 'list', title: 'Google work', readOnly: false }
const remote = { id: 'account:list:remote', accountId: 'account', provider: 'gmail' as const, remoteId: 'remote', listId: list.id, remoteListId: 'list', title: 'Provider task', notes: 'Provider notes', completed: false, revision: 'v1', readOnly: false }
const task: TaskEntity = { id: 'local-id', accountId: 'account', provider: 'gmail', listId: list.id, fields: { title: remote.title, notes: remote.notes, completed: false }, local: { priority: 'normal', recurrence: 'none' }, remote }
const state: AppState = { accounts: [], events: [], contacts: [], notes: [], tasks: [{ id: 'local-task', title: 'Local task', listId: 'Today', completed: false, priority: 'normal', subtasks: [] }] }
let snapshot: TaskSnapshot
let listener: (next: TaskSnapshot) => void
const unsubscribe = vi.fn()
const onChange = vi.fn(), onToast = vi.fn()
const api = {
  createList: vi.fn(async () => snapshot), renameList: vi.fn(async () => snapshot), deleteList: vi.fn(async () => snapshot), resolveList: vi.fn(async () => snapshot),
  exportData: vi.fn(async () => ({ savedPath: 'backup.json' })), importData: vi.fn(async () => snapshot),
  snapshot: vi.fn(async () => structuredClone(snapshot)),
  onChanged: vi.fn((callback: typeof listener) => { listener = callback; return unsubscribe }),
  sync: vi.fn(async () => snapshot), create: vi.fn(async () => snapshot), update: vi.fn(async () => snapshot),
  delete: vi.fn(async () => snapshot), move: vi.fn(async () => snapshot), setLocal: vi.fn(async () => snapshot),
  undo: vi.fn(async () => snapshot), resolve: vi.fn(async () => snapshot)
}
const reconnect = vi.fn(async () => {})
beforeEach(() => {
  vi.clearAllMocks()
  snapshot = { lists: [list], tasks: [structuredClone(task)], remoteTasks: [remote], operations: [], accounts: [{ accountId: 'account', provider: 'gmail', canRead: true, canWrite: true, archived: false, phase: 'ready' }] }
  for (const key of ['sync', 'create', 'update', 'delete', 'move', 'setLocal', 'undo', 'resolve'] as const) api[key].mockImplementation(async () => snapshot)
  window.confirm = vi.fn(() => true)
  Object.defineProperty(window, 'aerio', { configurable: true, value: { tasks: api, mail: { accounts: { reconnect } } } })
})
const renderView = (query = '') => render(<ContextMenuProvider><TasksView state={state} query={query} onChange={onChange} onToast={onToast} /></ContextMenuProvider>)
const selectList = async (user: ReturnType<typeof userEvent.setup>) => { await user.click(await screen.findByRole('button', { name: /Google work/ })) }
const operation = (overrides: Partial<TaskOperation> = {}): TaskOperation => ({ id: 'operation', sequence: 1, entityId: task.id, accountId: 'account', provider: 'gmail', kind: 'update', status: 'conflict', patch: { title: 'My change' }, before: task, base: remote, attempts: 1, retryAt: 0, ...overrides })

describe('Microsoft task interface', () => {
  beforeEach(() => {
    snapshot.accounts[0].provider = 'microsoft'
    snapshot.lists[0] = { ...list, provider: 'microsoft', title: 'Microsoft work' }
    const native = { priority: 'high' as const, status: 'inProgress' as const, dueTimeZone: 'GMT Standard Time', recurrence: { pattern: { type: 'daily' as const, interval: 2 }, range: { type: 'noEnd' as const, startDate: '2026-10-01', recurrenceTimeZone: 'GMT Standard Time' } }, body: { contentType: 'html' as const, content: '<p>Provider notes</p>' } }
    snapshot.tasks[0] = { ...task, provider: 'microsoft', fields: { ...task.fields, due: '2026-10-05T09:00:00.0000000', native }, remote: { ...remote, provider: 'microsoft', kind: 'task', due: '2026-10-05T09:00:00.0000000', native } }
    snapshot.remoteTasks = [snapshot.tasks[0].remote!]
  })
  const open = async (user: ReturnType<typeof userEvent.setup>) => { renderView(); await user.click(await screen.findByRole('button', { name: /Microsoft work/ })); await user.click(screen.getByRole('button', { name: 'Open task Provider task' })); return within(screen.getByRole('dialog', { name: 'Microsoft task' })) }

  it('sends only changed fields while preserving long notes, rich HTML, and exact due timestamps', async () => {
    snapshot.tasks[0].fields.notes = 'x'.repeat(10_000)
    const user = userEvent.setup(), dialog = await open(user)
    await user.clear(dialog.getByLabelText('Task')); await user.type(dialog.getByLabelText('Task'), 'Renamed')
    await user.click(dialog.getByRole('button', { name: 'Save task' }))
    expect(api.update).toHaveBeenCalledExactlyOnceWith(task.id, { title: 'Renamed' })
    expect(api.move).not.toHaveBeenCalled(); expect(onChange).not.toHaveBeenCalled()
  })

  it('edits native priority and progress without local metadata', async () => {
    const user = userEvent.setup(), dialog = await open(user)
    await user.selectOptions(dialog.getByLabelText('Priority in Microsoft'), 'low')
    await user.selectOptions(dialog.getByLabelText('Progress'), 'deferred')
    await user.click(dialog.getByRole('button', { name: 'Save task' }))
    expect(api.update).toHaveBeenCalledExactlyOnceWith(task.id, { native: { priority: 'low', status: 'deferred' } })
    expect(api.setLocal).not.toHaveBeenCalled()
  })

  it('clears due and native recurrence explicitly without rewriting notes or priority', async () => {
    const user = userEvent.setup(), dialog = await open(user)
    fireEvent.change(dialog.getByLabelText('Due date and time'), { target: { value: '' } })
    await user.selectOptions(dialog.getByLabelText('Repeat in Microsoft'), '')
    await user.click(dialog.getByRole('button', { name: 'Save task' }))
    expect(api.update).toHaveBeenCalledExactlyOnceWith(task.id, { due: null, native: { recurrence: null } })
  })

  it('creates an annual weekday recurrence with bounded range and a native time zone', async () => {
    const user = userEvent.setup(); renderView(); await user.click(await screen.findByRole('button', { name: /Microsoft work/ }))
    await user.click(screen.getByRole('button', { name: 'New task' }))
    const dialog = within(screen.getByRole('dialog', { name: 'New Microsoft task' }))
    await user.type(dialog.getByLabelText('Task'), 'Annual review')
    fireEvent.change(dialog.getByLabelText('Due date and time'), { target: { value: '2026-10-10T10:30' } })
    await user.clear(dialog.getByLabelText('Time zone')); await user.type(dialog.getByLabelText('Time zone'), 'Eastern Standard Time')
    await user.selectOptions(dialog.getByLabelText('Repeat in Microsoft'), 'relativeYearly')
    fireEvent.change(dialog.getByLabelText('Month'), { target: { value: '10' } })
    await user.selectOptions(dialog.getByLabelText('Week of month'), 'last')
    await user.selectOptions(dialog.getByLabelText('Repeat ends'), 'numbered')
    fireEvent.change(dialog.getByLabelText('Number of occurrences'), { target: { value: '3' } })
    await user.click(dialog.getByRole('button', { name: 'Save task' }))
    expect(api.create).toHaveBeenCalledExactlyOnceWith('account', list.id, expect.objectContaining({ title: 'Annual review', due: '2026-10-10T10:30:00', native: expect.objectContaining({ dueTimeZone: 'Eastern Standard Time', recurrence: { pattern: { type: 'relativeYearly', interval: 1, daysOfWeek: ['monday'], index: 'last', month: 10 }, range: { type: 'numbered', startDate: '2026-10-10', recurrenceTimeZone: 'Eastern Standard Time', numberOfOccurrences: 3 } } }) }), undefined, { priority: 'normal', recurrence: 'none' })
  })

  it('creates a checklist without leaking hidden native fields or notes and excludes checklist parents', async () => {
    snapshot.tasks.push({ ...snapshot.tasks[0], id: 'child', parentId: task.id, fields: { title: 'Existing step', completed: false }, remote: { ...remote, provider: 'microsoft', kind: 'checklist' } })
    const user = userEvent.setup(); renderView(); await user.click(await screen.findByRole('button', { name: /Microsoft work/ })); await user.click(screen.getByRole('button', { name: 'New task' }))
    const dialog = within(screen.getByRole('dialog', { name: 'New Microsoft task' }))
    await user.type(dialog.getByLabelText('Task'), 'Step'); await user.type(dialog.getByLabelText('Notes'), 'Hidden')
    await user.selectOptions(dialog.getByLabelText('Priority in Microsoft'), 'high')
    expect(dialog.getByLabelText('Parent task')).not.toHaveTextContent('Existing step')
    await user.selectOptions(dialog.getByLabelText('Parent task'), task.id)
    expect(dialog.queryByLabelText('Notes')).not.toBeInTheDocument()
    expect(dialog.queryByLabelText('Repeat in Microsoft')).not.toBeInTheDocument()
    await user.click(dialog.getByRole('button', { name: 'Save task' }))
    expect(api.create).toHaveBeenCalledExactlyOnceWith('account', list.id, { title: 'Step', completed: false }, task.id, { priority: 'normal', recurrence: 'none' })
  })

  it('protects system lists in the Microsoft list manager while leaving task access available', async () => {
    snapshot.lists[0].manageReadOnly = true
    const user = userEvent.setup(); renderView()
    await user.click(await screen.findByRole('button', { name: /Manage Microsoft lists/ }))
    const dialog = within(screen.getByRole('dialog', { name: 'Microsoft task lists' }))
    expect(dialog.getByRole('button', { name: 'Rename Microsoft list Microsoft work' })).toBeDisabled()
    expect(dialog.getByRole('button', { name: 'Delete Microsoft list Microsoft work' })).toBeDisabled()
    expect(dialog.getByText('List managed by Microsoft')).toBeInTheDocument()
    expect(dialog.getByRole('button', { name: 'Create Microsoft list' })).toBeDisabled()
    await user.type(dialog.getByLabelText('List name'), 'New')
    expect(dialog.getByRole('button', { name: 'Create Microsoft list' })).toBeEnabled()
  })

  it('shows provider-specific reconnect controls for read-only Microsoft access', async () => {
    snapshot.accounts[0].canWrite = false
    const user = userEvent.setup(); renderView()
    await user.click(await screen.findByRole('button', { name: 'Connect Microsoft To Do' }))
    expect(reconnect).toHaveBeenCalledWith('account'); expect(api.sync).toHaveBeenCalledWith('account')
    expect(onToast).toHaveBeenCalledWith('Microsoft To Do connected')
  })

  it('reviews native intent and provider values without rendering object placeholders', async () => {
    snapshot.operations = [operation({ provider: 'microsoft', before: snapshot.tasks[0], base: snapshot.remoteTasks[0], patch: { native: { priority: 'low', recurrence: null } } })]
    const user = userEvent.setup(); renderView(); await user.click(await screen.findByRole('button', { name: /Microsoft work/ })); await user.click(screen.getByRole('button', { name: 'Review change' }))
    const dialog = within(screen.getByRole('dialog', { name: 'Review task change' }))
    expect(dialog.getByText('Priority: low · Repeat: Never')).toBeInTheDocument()
    expect(dialog.getByText('Microsoft version')).toBeInTheDocument()
    expect(dialog.getByRole('button', { name: 'Refresh Microsoft tasks' })).toBeInTheDocument()
    expect(screen.queryByText(/\[object Object\]/)).not.toBeInTheDocument()
  })
})

describe('connected Tasks view', () => {
  it('routes provider list creation, rename and confirmed deletion through the desktop API', async () => {
    const user = userEvent.setup()
    renderView()
    await user.click(await screen.findByRole('button', { name: /Manage Google lists for/ }))
    const manager = within(screen.getByRole('dialog', { name: 'Google task lists' }))
    await user.type(manager.getByLabelText('List name', { exact: true }), 'New provider list')
    await user.click(manager.getByRole('button', { name: 'Create Google list' }))
    expect(api.createList).toHaveBeenCalledWith('account', 'New provider list')
    await user.click(manager.getByRole('button', { name: 'Rename Google list Google work' }))
    await user.clear(manager.getByLabelText('New list name'))
    await user.type(manager.getByLabelText('New list name'), 'Renamed provider list')
    await user.click(manager.getByRole('button', { name: 'Save list name' }))
    expect(api.renameList).toHaveBeenCalledWith(list.id, 'Renamed provider list')
    await user.click(manager.getByRole('button', { name: 'Delete Google list Google work' }))
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('all its tasks'))
    expect(api.deleteList).toHaveBeenCalledWith(list.id)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('retains a rejected list name and respects cancellation of list deletion', async () => {
    api.createList.mockRejectedValueOnce(new Error('List could not be saved'))
    window.confirm = vi.fn(() => false)
    const user = userEvent.setup()
    renderView()
    await user.click(await screen.findByRole('button', { name: /Manage Google lists for/ }))
    const manager = within(screen.getByRole('dialog', { name: 'Google task lists' }))
    await user.type(manager.getByLabelText('List name', { exact: true }), 'Keep my input')
    await user.click(manager.getByRole('button', { name: 'Create Google list' }))
    expect(await manager.findByRole('alert')).toHaveTextContent('List could not be saved')
    expect(manager.getByLabelText('List name', { exact: true })).toHaveValue('Keep my input')
    await user.click(manager.getByRole('button', { name: 'Delete Google list Google work' }))
    expect(api.deleteList).not.toHaveBeenCalled()
  })

  it('disables provider list mutations when the account is read-only', async () => {
    snapshot.accounts[0].canWrite = false
    const user = userEvent.setup()
    renderView()
    await user.click(await screen.findByRole('button', { name: /Manage Google lists for/ }))
    const manager = within(screen.getByRole('dialog', { name: 'Google task lists' }))
    expect(manager.getByRole('button', { name: 'Create Google list' })).toBeDisabled()
    expect(manager.getByRole('button', { name: 'Rename Google list Google work' })).toBeDisabled()
    expect(manager.getByRole('button', { name: 'Delete Google list Google work' })).toBeDisabled()
  })
  it('exports and restores provider tasks without writing local task state', async () => {
    const user = userEvent.setup()
    renderView()
    await user.click(screen.getByRole('button', { name: 'Back up connected tasks' }))
    expect(api.exportData).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Connected tasks backup saved'))
    await user.click(screen.getByRole('button', { name: 'Restore connected tasks' }))
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Restored pending changes will require review'))
    expect(api.importData).toHaveBeenCalledTimes(1)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('keeps restore cancelled when its replacement confirmation is declined', async () => {
    window.confirm = vi.fn(() => false)
    const user = userEvent.setup()
    renderView()
    await user.click(screen.getByRole('button', { name: 'Restore connected tasks' }))
    expect(api.importData).not.toHaveBeenCalled()
  })

  it('does not overwrite a newer change event with a delayed initial snapshot', async () => {
    let finish!: (value: TaskSnapshot) => void
    api.snapshot.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const initial = structuredClone(snapshot)
    renderView()
    const newer = { ...snapshot, lists: [{ ...list, title: 'Updated provider list' }] }
    await act(async () => listener(newer))
    expect(screen.getByRole('button', { name: /Updated provider list/ })).toBeInTheDocument()
    await act(async () => finish(initial))
    expect(screen.getByRole('button', { name: /Updated provider list/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Google work/ })).not.toBeInTheDocument()
  })

  it('keeps local tasks separate and loads provider tasks when their list is selected', async () => {
    const user = userEvent.setup()
    const view = renderView()
    expect(screen.getByText('Local task')).toBeInTheDocument()
    await selectList(user)
    expect(screen.getByText('Provider task')).toBeInTheDocument()
    expect(screen.queryByText('Local task')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Today/ }))
    expect(screen.getByText('Local task')).toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
    view.unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('saves a dated repeating provider subtask with local settings in one API request', async () => {
    const user = userEvent.setup()
    renderView(); await selectList(user)
    await user.click(screen.getByRole('button', { name: 'New task' }))
    const dialog = screen.getByRole('dialog', { name: 'New Google task' })
    await user.type(within(dialog).getByLabelText('Task'), 'Child task')
    fireEvent.change(within(dialog).getByLabelText('Due date'), { target: { value: '2026-10-10' } })
    await user.selectOptions(within(dialog).getByLabelText('Priority in Aerio'), 'high')
    await user.selectOptions(within(dialog).getByLabelText('Repeat in Aerio'), 'weekly')
    await user.selectOptions(within(dialog).getByLabelText('Parent task'), task.id)
    await user.click(within(dialog).getByRole('button', { name: 'Save task' }))
    expect(api.create).toHaveBeenCalledExactlyOnceWith('account', list.id, { title: 'Child task', notes: undefined, due: '2026-10-10', completed: false }, task.id, { priority: 'high', recurrence: 'weekly' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(onChange).not.toHaveBeenCalled()
  })

  it('edits provider fields, clears optional values explicitly, and never changes local task storage', async () => {
    const user = userEvent.setup()
    renderView(); await selectList(user)
    await user.click(screen.getByRole('button', { name: 'Open task Provider task' }))
    const dialog = screen.getByRole('dialog', { name: 'Google task' })
    await user.clear(within(dialog).getByLabelText('Task')); await user.type(within(dialog).getByLabelText('Task'), 'Updated')
    await user.clear(within(dialog).getByLabelText('Notes'))
    await user.click(within(dialog).getByRole('button', { name: 'Save task' }))
    expect(api.update).toHaveBeenCalledWith(task.id, { title: 'Updated', notes: null, due: null, completed: false }, { priority: 'normal', recurrence: 'none' })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('keeps unsaved field edits in the dialog when changing a parent', async () => {
    const parent = { ...task, id: 'parent-id', fields: { title: 'Parent task', completed: false } }
    snapshot.tasks.push(parent)
    api.move.mockImplementationOnce(async () => {
      snapshot.tasks[0] = { ...snapshot.tasks[0], parentId: parent.id }
      return snapshot
    })
    const user = userEvent.setup()
    renderView(); await selectList(user)
    await user.click(screen.getByRole('button', { name: 'Open task Provider task' }))
    const dialog = screen.getByRole('dialog', { name: 'Google task' })
    await user.type(within(dialog).getByLabelText('Task'), ' unsaved')
    await user.selectOptions(within(dialog).getByLabelText('Parent task'), parent.id)
    expect(within(dialog).getByRole('button', { name: 'Save task' })).toBeDisabled()
    await user.click(within(dialog).getByRole('button', { name: 'Move task' }))
    expect(api.move).toHaveBeenCalledWith(task.id, parent.id)
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Save task' })).toBeEnabled())
    expect(within(dialog).getByLabelText('Task')).toHaveValue('Provider task unsaved')
    expect(api.update).not.toHaveBeenCalled()
  })

  it('completes provider tasks and receives pending state through change events', async () => {
    const user = userEvent.setup()
    renderView(); await selectList(user)
    await user.click(screen.getByRole('button', { name: 'Complete Provider task' }))
    expect(api.update).toHaveBeenCalledExactlyOnceWith(task.id, { completed: true })
    snapshot.operations = [operation({ status: 'queued', attempts: 0 })]
    await act(async () => listener(snapshot))
    expect(screen.getAllByText('Pending sync').length).toBeGreaterThan(0)
    await user.click(screen.getByRole('button', { name: 'Undo update Provider task' }))
    expect(api.undo).toHaveBeenCalledWith('operation')
  })

  it('shows assigned/read-only tasks while disabling completion, editing, deletion and creation', async () => {
    snapshot.lists[0] = { ...list, readOnly: true }
    snapshot.accounts[0].canWrite = false
    snapshot.tasks[0].remote = { ...remote, assigned: true, readOnly: true }
    const user = userEvent.setup()
    renderView(); await selectList(user)
    expect(screen.getByRole('button', { name: 'Complete Provider task' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'New task' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Open task Provider task' }))
    expect(screen.getByLabelText('Task')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save task' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Delete task' })).not.toBeInTheDocument()
    expect(api.update).not.toHaveBeenCalled()
  })

  it('retries a conflict against the current reviewed revision and displays readable changes', async () => {
    snapshot.operations = [operation()]
    snapshot.remoteTasks = [{ ...remote, title: 'Their change', revision: 'v2' }]
    const user = userEvent.setup()
    renderView(); await selectList(user)
    expect(screen.getByRole('button', { name: 'Complete Provider task' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Review change' }))
    expect(screen.getByText('Title: My change')).toBeInTheDocument()
    expect(screen.getByText('Their change · Open · Provider notes')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry my change' }))
    expect(api.resolve).toHaveBeenCalledExactlyOnceWith('operation', { action: 'retry', expectedRevision: 'v2', confirmedNotApplied: false })
  })

  it('keeps an older unresolved conflict visible even when newer history fills the recent-change limit', async () => {
    snapshot.operations = [operation(), ...Array.from({ length: 10 }, (_, index) => operation({ id: `later-${index}`, sequence: index + 2, entityId: `other-${index}`, status: 'succeeded' }))]
    const user = userEvent.setup()
    renderView(); await selectList(user)
    expect(screen.getByRole('button', { name: 'Review change' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Review change' }))
    expect(screen.getByRole('dialog', { name: 'Review task change' })).toBeInTheDocument()
  })

  it('requires a not-applied confirmation before retrying an uncertain write', async () => {
    snapshot.operations = [operation({ status: 'review' })]
    const user = userEvent.setup()
    renderView(); await selectList(user)
    await user.click(screen.getByRole('button', { name: 'Review change' }))
    expect(screen.getByRole('button', { name: 'Retry my change' })).toBeDisabled()
    await user.click(screen.getByLabelText('I checked Google and this change was not applied'))
    await user.click(screen.getByRole('button', { name: 'Retry my change' }))
    expect(api.resolve).toHaveBeenCalledWith('operation', { action: 'retry', expectedRevision: 'v1', confirmedNotApplied: true })
  })

  it('matches an uncertain creation to a selected provider identity without creating it again', async () => {
    snapshot.operations = [operation({ status: 'review', kind: 'create', base: undefined, patch: task.fields })]
    const user = userEvent.setup()
    renderView(); await selectList(user)
    await user.click(screen.getByRole('button', { name: 'Review change' }))
    expect(screen.getByRole('button', { name: 'Confirm applied' })).toBeDisabled()
    await user.selectOptions(screen.getByLabelText('Task created in Google'), remote.id)
    await user.click(screen.getByRole('button', { name: 'Confirm applied' }))
    expect(api.resolve).toHaveBeenCalledWith('operation', { action: 'accept', remoteId: remote.id, expectedRevision: 'v1' })
    expect(api.create).not.toHaveBeenCalled()
  })

  it('keeps editor input and an inline error when saving fails', async () => {
    api.update.mockRejectedValueOnce(new Error('Task revision changed'))
    const user = userEvent.setup()
    renderView(); await selectList(user)
    await user.click(screen.getByRole('button', { name: 'Open task Provider task' }))
    const dialog = screen.getByRole('dialog', { name: 'Google task' })
    await user.type(within(dialog).getByLabelText('Task'), ' edited')
    await user.click(within(dialog).getByRole('button', { name: 'Save task' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Task revision changed')
    expect(within(dialog).getByLabelText('Task')).toHaveValue('Provider task edited')
    expect(onToast).not.toHaveBeenCalledWith('Task saved')
  })

  it('requests Tasks consent through the existing account reconnect flow', async () => {
    snapshot.accounts[0] = { ...snapshot.accounts[0], canRead: false, canWrite: false }
    snapshot.lists = []; snapshot.tasks = []; snapshot.remoteTasks = []
    const user = userEvent.setup()
    renderView()
    await user.click(await screen.findByRole('button', { name: 'Connect Google Tasks' }))
    expect(reconnect).toHaveBeenCalledWith('account')
    await waitFor(() => expect(api.sync).toHaveBeenCalledWith('account'))
  })

  it('identifies paused synchronization without suggesting an unnecessary consent reconnect', async () => {
    snapshot.accounts[0] = { ...snapshot.accounts[0], syncEnabled: false, canRead: false, canWrite: false }
    snapshot.lists[0] = { ...list, readOnly: true }
    const user = userEvent.setup()
    renderView(); await selectList(user)
    expect(screen.getByText('Synchronization paused')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Connect Google Tasks' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeDisabled()
  })

  it('filters provider search and forwards refresh and deletion through provider APIs', async () => {
    const user = userEvent.setup()
    renderView('Provider'); await selectList(user)
    await user.click(screen.getByRole('button', { name: 'Sync now' }))
    expect(api.sync).toHaveBeenCalledWith('account')
    await user.click(screen.getByRole('button', { name: 'Open task Provider task' }))
    await user.click(screen.getByRole('button', { name: 'Delete task' }))
    expect(window.confirm).toHaveBeenCalledWith('Delete “Provider task”?')
    expect(api.delete).toHaveBeenCalledWith(task.id)
    expect(onChange).not.toHaveBeenCalled()
  })
})
