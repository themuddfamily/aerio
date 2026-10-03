import { Check, Copy, Edit3, Plus, RefreshCw, Repeat2, Trash2, Undo2 } from 'lucide-react'
import { useState } from 'react'
import Modal from '../components/Modal'
import { copyText, useContextMenu } from '../components/ContextMenu'
import MicrosoftTaskEditor, { type ProviderTaskEditorProps } from './MicrosoftTaskEditor'
import type { ProviderTaskList, TaskDesktopApi, TaskEntity, TaskLocalMetadata, TaskNativeFields, TaskOperation, TaskSnapshot } from '../task-provider-types'

export const taskNeedsReview = (operation: TaskOperation) => ['failed', 'conflict', 'review'].includes(operation.status)
const statusLabel = (operation?: TaskOperation) => operation?.status === 'queued' ? 'Pending sync' : operation?.status === 'running' ? 'Syncing' : operation?.status === 'conflict' ? 'Conflict' : operation?.status === 'review' ? 'Needs review' : operation?.status === 'failed' ? 'Sync failed' : ''

interface Props {
  snapshot: TaskSnapshot
  listId: string
  query: string
  showCompleted: boolean
  setShowCompleted(value: boolean): void
  editing: TaskEntity | 'new' | null
  setEditing(value: TaskEntity | 'new' | null): void
  onSnapshot(snapshot: TaskSnapshot): void
  onToast(message: string): void
}

export default function ProviderTasksPanel({ snapshot, listId, query, showCompleted, setShowCompleted, editing, setEditing, onSnapshot, onToast }: Props) {
  const { showContextMenu } = useContextMenu()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [review, setReview] = useState<string>()
  const list = snapshot.lists.find((item) => item.id === listId)
  const account = snapshot.accounts.find((item) => item.accountId === list?.accountId)
  const writable = Boolean(list && !list.readOnly && account?.canWrite)
  const operations = snapshot.operations.filter((item) => item.before.listId === listId)
  const recentIds = new Set(operations.filter((operation) => operation.status !== 'cancelled').slice(-8).map((operation) => operation.id))
  const history = operations.filter((operation) => taskNeedsReview(operation) || recentIds.has(operation.id)).reverse()
  const latest = (id: string) => operations.filter((item) => item.entityId === id && !['succeeded', 'cancelled'].includes(item.status)).at(-1)
  const canEdit = (task: TaskEntity) => writable && !task.remote?.readOnly && !task.remote?.assigned && !operations.some((item) => item.entityId === task.id && taskNeedsReview(item))
  const allTasks = snapshot.tasks.filter((task) => task.listId === listId)
  const depth = (task: TaskEntity) => {
    const visited = new Set([task.id]); let count = 0, parent = task.parentId
    while (parent && !visited.has(parent)) { visited.add(parent); count++; parent = allTasks.find((item) => item.id === parent)?.parentId }
    return Math.min(count, 8)
  }
  const tasks = allTasks.filter((task) => (showCompleted || !task.fields.completed) && (!query || `${task.fields.title} ${task.fields.notes ?? ''}`.toLowerCase().includes(query.toLowerCase())))
    .sort((a, b) => Number(a.fields.completed) - Number(b.fields.completed) || (a.remote?.position ?? a.id).localeCompare(b.remote?.position ?? b.id))
  const run = async (command: (api: TaskDesktopApi) => Promise<TaskSnapshot>, message?: string) => {
    if (busy) return false
    setBusy(true); setError('')
    try {
      await command(window.aerio.tasks)
      onSnapshot(await window.aerio.tasks.snapshot())
      if (message) onToast(message)
      return true
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'This task change could not be saved'); return false }
    finally { setBusy(false) }
  }
  const deleteTask = (task: TaskEntity) => {
    if (window.confirm(`Delete “${task.fields.title}”?`)) void run((api) => api.delete(task.id), 'Task deletion saved')
  }
  const reviewing = operations.find((operation) => operation.id === review && taskNeedsReview(operation))
  if (!list) return <section className="module-panel tasks-panel"><div className="empty-state"><h2>This task list is no longer available</h2><p>Select another list from the sidebar.</p></div></section>
  return <section className="module-panel tasks-panel">
    <header className="module-header"><div><h1>{list.title}</h1><p>{list.provider === 'microsoft' ? 'Microsoft To Do' : 'Google Tasks'} · {allTasks.filter((task) => !task.fields.completed).length} still open{list.readOnly ? ' · Read-only' : ''}</p></div>
      <div className="provider-task-actions"><label className="check-label"><input type="checkbox" checked={showCompleted} onChange={(event) => setShowCompleted(event.target.checked)} /> Show completed</label>
        <button className="button ghost small" disabled={busy || account?.archived || account?.syncEnabled === false} onClick={() => void run((api) => api.sync(list.accountId))}><RefreshCw size={15} /> Sync now</button></div>
    </header>
    {error && !editing && !reviewing && <p className="provider-task-error" role="alert">{error}</p>}
    {account?.error && <p className="provider-task-notice" role="status">{account.error === 'offline' ? 'Offline. Saved changes will synchronize when you reconnect.' : account.error === 'needs-consent' ? 'Reconnect this account to grant Tasks access.' : 'Synchronization failed. Your cached tasks are available.'}</p>}
    <div className="task-list">
      {tasks.map((task) => <div className={`task-row ${task.fields.completed ? 'completed' : ''}`} key={task.id} style={{ marginLeft: `${depth(task) * 20}px` }} onContextMenu={(event) => showContextMenu(event, [
        { label: 'Edit task', icon: Edit3, disabled: !canEdit(task) || busy, action: () => setEditing(task) },
        { label: task.fields.completed ? 'Reopen task' : 'Complete task', icon: Check, disabled: !canEdit(task) || busy, action: () => void run((api) => api.update(task.id, { completed: !task.fields.completed })) },
        { label: 'Copy task title', icon: Copy, action: () => copyText(task.fields.title) },
        { label: 'Delete task', icon: Trash2, danger: true, disabled: !canEdit(task) || busy, action: () => deleteTask(task) }
      ], task.fields.title)}>
        <button className={`task-check ${task.fields.completed ? 'checked' : ''}`} aria-label={`${task.fields.completed ? 'Reopen' : 'Complete'} ${task.fields.title}`} disabled={!canEdit(task) || busy} onClick={() => void run((api) => api.update(task.id, { completed: !task.fields.completed }))}>{task.fields.completed && <Check size={15} />}</button>
        <button className="task-main" aria-label={`Open task ${task.fields.title}`} onClick={() => setEditing(task)}><span><strong>{task.fields.title}</strong>{task.fields.notes && <small>{task.fields.notes}</small>}</span><span className="task-meta">
          {task.fields.due && <em>Due {task.fields.due}</em>}{task.parentId && <em>Subtask of {allTasks.find((parent) => parent.id === task.parentId)?.fields.title ?? 'another task'}</em>}
          {task.local.recurrence !== 'none' && <em><Repeat2 size={13} /> {task.local.recurrence} in Aerio</em>}{statusLabel(latest(task.id)) && <em>{statusLabel(latest(task.id))}</em>}{task.remote?.readOnly && <em>Read-only</em>}
          {task.fields.native?.recurrence && <em><Repeat2 size={13} /> {task.fields.native.recurrence.pattern.type} in Microsoft</em>}{task.fields.due && task.fields.native?.dueTimeZone && <em>{task.fields.native.dueTimeZone}</em>}
        </span></button><span className={`priority-dot ${task.fields.native?.priority ?? task.local.priority}`} title={`${task.fields.native?.priority ?? task.local.priority} priority`} />
      </div>)}
      {!tasks.length && <div className="empty-state"><h3>No tasks on this list</h3><p>{query ? 'Try another search.' : 'Create a task or synchronize this list.'}</p></div>}
    </div>
    {operations.some((operation) => operation.status !== 'cancelled') && <section className="provider-task-history" aria-label="Task changes"><h2>Recent changes</h2>
      {history.map((operation) => {
        const alreadyUndone = operations.some((item) => item.undoOf === operation.id && item.status !== 'cancelled')
        const newer = operations.some((item) => item.entityId === operation.entityId && item.sequence > operation.sequence && item.status !== 'cancelled')
        const undoable = !alreadyUndone && ((operation.status === 'queued' && !operation.attempts) || (operation.status === 'succeeded' && !newer))
        return <div key={operation.id}><span>{operation.kind === 'create' ? 'Created' : operation.kind === 'delete' ? 'Deleted' : operation.kind === 'move' ? 'Moved' : 'Updated'} {operation.before.fields.title}<small>{statusLabel(operation) || (alreadyUndone ? 'Undone' : 'Synchronized')}</small></span>
          {taskNeedsReview(operation) ? <button className="button ghost small" disabled={busy} onClick={() => setReview(operation.id)}>Review change</button> : <button className="button ghost small" aria-label={`Undo ${operation.kind} ${operation.before.fields.title}`} disabled={busy || !writable || !undoable} onClick={() => void run((api) => api.undo(operation.id), 'Task change undone')}><Undo2 size={14} /> Undo</button>}
        </div>
      })}
    </section>}
    {editing && <ProviderTaskEditor key={editing === 'new' ? 'new' : editing.id} task={editing === 'new' ? undefined : editing} list={list} tasks={allTasks} writable={editing === 'new' ? writable : canEdit(editing)} busy={busy} error={error} onClose={() => setEditing(null)} onSave={async (fields, local, parentId) => {
      const success = await run((api) => {
        if (editing === 'new') return api.create(list.accountId, list.id, fields, parentId, local)
        if (list.provider !== 'microsoft') return api.update(editing.id, { ...fields, notes: fields.notes ?? null, due: fields.due ?? null }, local)
        const patch: Parameters<TaskDesktopApi['update']>[1] = {}
        for (const key of ['title', 'notes', 'due', 'completed'] as const) if (fields[key] !== editing.fields[key]) (patch as Record<string, unknown>)[key] = fields[key] ?? null
        if (fields.native && Object.keys(fields.native).length) patch.native = fields.native
        return Object.keys(patch).length ? api.update(editing.id, patch) : api.snapshot()
      }, 'Task saved')
      if (success) setEditing(null)
    }} onMove={editing === 'new' ? undefined : async (parentId) => {
      let moved: TaskEntity | undefined
      if (await run(async (api) => {
        const next = await api.move(editing.id, parentId)
        moved = next.tasks.find((task) => task.id === editing.id)
        return next
      }, 'Task moved')) { if (moved) setEditing(moved) }
    }} onDelete={editing === 'new' || !canEdit(editing) ? undefined : () => { if (window.confirm(`Delete “${editing.fields.title}”?`)) void run((api) => api.delete(editing.id), 'Task deletion saved').then((success) => { if (success) setEditing(null) }) }} />}
    {reviewing && <TaskReview operation={reviewing} snapshot={snapshot} busy={busy} error={error} writable={writable} onClose={() => setReview(undefined)} onResolve={async (resolution) => { if (await run((api) => api.resolve(reviewing.id, resolution), 'Task change resolved')) setReview(undefined) }} onRefresh={() => void run((api) => api.sync(list.accountId))} />}
  </section>
}

function ProviderTaskEditor(props: ProviderTaskEditorProps) {
  return props.list.provider === 'microsoft' ? <MicrosoftTaskEditor {...props} /> : <GoogleTaskEditor {...props} />
}

function GoogleTaskEditor({ task, list, tasks, writable, busy, error, onClose, onSave, onMove, onDelete }: {
  task?: TaskEntity; list: ProviderTaskList; tasks: TaskEntity[]; writable: boolean; busy: boolean; error: string; onClose(): void
  onSave(fields: TaskEntity['fields'], local: TaskLocalMetadata, parentId?: string): Promise<void>
  onMove?(parentId?: string): Promise<void>; onDelete?(): void
}) {
  const [title, setTitle] = useState(task?.fields.title ?? '')
  const [notes, setNotes] = useState(task?.fields.notes ?? '')
  const [due, setDue] = useState(task?.fields.due ?? '')
  const [priority, setPriority] = useState(task?.local.priority ?? 'normal')
  const [recurrence, setRecurrence] = useState(task?.local.recurrence ?? 'none')
  const [parentId, setParentId] = useState(task?.parentId ?? '')
  return <Modal title={task ? 'Google task' : 'New Google task'} onClose={onClose}>
    <div className="form-stack"><p>{list.title}{!writable ? ' · Read-only' : ''}</p>{error && <p role="alert" className="provider-task-error">{error}</p>}
      <label className="field-label">Task<input autoFocus value={title} disabled={!writable || busy} maxLength={1024} onChange={(event) => setTitle(event.target.value)} /></label>
      <label className="field-label">Notes<textarea value={notes} disabled={!writable || busy} maxLength={8192} onChange={(event) => setNotes(event.target.value)} /></label>
      <div className="form-grid-2"><label className="field-label">Due date<input type="date" value={due} disabled={!writable || busy} onChange={(event) => setDue(event.target.value)} /></label>
        <label className="field-label">Priority in Aerio<select value={priority} disabled={!writable || busy} onChange={(event) => setPriority(event.target.value as TaskLocalMetadata['priority'])}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option></select></label>
        <label className="field-label">Repeat in Aerio<select value={recurrence} disabled={!writable || busy} onChange={(event) => setRecurrence(event.target.value as TaskLocalMetadata['recurrence'])}><option value="none">Never</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></label>
        <label className="field-label">Parent task<select value={parentId} disabled={!writable || busy} onChange={(event) => setParentId(event.target.value)}><option value="">No parent</option>{tasks.filter((item) => item.id !== task?.id && !item.remote?.readOnly && !item.remote?.assigned).map((item) => <option key={item.id} value={item.id}>{item.fields.title}</option>)}</select></label>
      </div><p className="provider-task-notice">Google stores due dates without a time. Priority and repeat settings are saved in Aerio. Repeating tasks advance by calendar days in UTC.</p>
      <footer className="modal-footer">{onDelete && <button className="button danger-subtle" disabled={busy} onClick={onDelete}>Delete task</button>}<span className="spacer" /><button className="button ghost" onClick={onClose}>Close</button>
        {onMove && parentId !== (task?.parentId ?? '') && <button className="button ghost" disabled={busy || !writable} onClick={() => void onMove(parentId || undefined)}>Move task</button>}
        <button className="button primary" disabled={busy || !writable || !title.trim() || Boolean(task && parentId !== (task.parentId ?? ''))} onClick={() => void onSave({ title: title.trim(), notes: notes || undefined, due: due || undefined, completed: task?.fields.completed ?? false }, { ...task?.local, priority, recurrence }, parentId || undefined)}>Save task</button>
      </footer></div>
  </Modal>
}

function TaskReview({ operation, snapshot, busy, error, writable, onClose, onResolve, onRefresh }: { operation: TaskOperation; snapshot: TaskSnapshot; busy: boolean; error: string; writable: boolean; onClose(): void; onResolve(resolution: Parameters<TaskDesktopApi['resolve']>[1]): Promise<void>; onRefresh(): void }) {
  const providerName = operation.provider === 'microsoft' ? 'Microsoft' : 'Google'
  const nativeDescription = (value?: TaskNativeFields) => value ? [value.priority && `Priority: ${value.priority}`, value.status && `Progress: ${{ notStarted: 'Not started', inProgress: 'In progress', completed: 'Completed', waitingOnOthers: 'Waiting on others', deferred: 'Deferred' }[value.status]}`, value.dueTimeZone && `Time zone: ${value.dueTimeZone}`, value.recurrence !== undefined && (value.recurrence ? `Repeat: ${value.recurrence.pattern.type}, every ${value.recurrence.pattern.interval}${value.recurrence.pattern.daysOfWeek?.length ? ` (${value.recurrence.pattern.daysOfWeek.join(', ')})` : ''}, from ${value.recurrence.range.startDate}${value.recurrence.range.type === 'endDate' ? ` through ${value.recurrence.range.endDate}` : value.recurrence.range.type === 'numbered' ? ` for ${value.recurrence.range.numberOfOccurrences} occurrences` : ''}` : 'Repeat: Never'), value.body && 'Rich notes restored'].filter(Boolean).join(' · ') : ''
  const current = snapshot.remoteTasks.find((task) => task.id === operation.base?.id)
  const candidates = snapshot.remoteTasks.filter((task) => task.accountId === operation.accountId && task.listId === operation.before.listId)
  const [candidateId, setCandidateId] = useState('')
  const [notApplied, setNotApplied] = useState(false)
  const candidate = candidates.find((task) => task.id === candidateId)
  const expected = operation.kind === 'create' ? candidate : current
  return <Modal title="Review task change" onClose={onClose}><div className="form-stack">
    <p>{operation.before.fields.title} · {operation.error === 'restored-write' ? 'This change was restored from backup. Review it before sending.' : operation.status === 'conflict' ? 'Another client changed this task.' : operation.status === 'review' ? 'The connection ended before Aerio could confirm the change.' : `${providerName} did not accept this change.`}</p>{error && <p role="alert" className="provider-task-error">{error}</p>}
    <dl className="provider-task-review"><dt>Your change</dt><dd>{operation.kind === 'delete' ? 'Delete task' : operation.kind === 'move' ? 'Move task' : Object.entries(operation.patch).filter(([, value]) => value !== undefined).map(([key, value]) => key === 'native' ? nativeDescription(value as TaskNativeFields) : `${key === 'completed' ? 'Status' : key === 'due' ? 'Due date' : key === 'notes' ? 'Notes' : 'Title'}: ${key === 'completed' ? value ? 'Completed' : 'Open' : value === null ? 'Cleared' : value}`).join(' · ')}</dd><dt>{providerName} version</dt><dd>{current ? `${current.title}${current.completed ? ' · Completed' : ' · Open'}${current.notes ? ` · ${current.notes}` : ''}${current.due ? ` · Due: ${current.due}` : ''}${current.native ? ` · ${nativeDescription({ ...current.native, body: undefined })}` : ''}` : 'No matching task in the latest cache'}</dd></dl>
    <button className="button ghost" disabled={busy} onClick={onRefresh}>Refresh {providerName} tasks</button>
    {operation.kind === 'create' && <label className="field-label">Task created in {providerName}<select aria-label={`Task created in ${providerName}`} value={candidateId} disabled={busy} onChange={(event) => setCandidateId(event.target.value)}><option value="">Select the matching task</option>{candidates.map((task) => <option value={task.id} key={task.id}>{task.title}</option>)}</select></label>}
    {operation.status === 'review' && <label className="check-label"><input type="checkbox" checked={notApplied} disabled={busy} onChange={(event) => setNotApplied(event.target.checked)} /> I checked {providerName} and this change was not applied</label>}
    <p className="provider-task-notice">Discarding removes this change and later pending edits. Retrying applies your change to the {providerName} version you reviewed. Confirming a matching result prevents the change from being sent again.</p>
    <footer className="modal-footer"><button className="button danger-subtle" disabled={busy || !writable} onClick={() => void onResolve({ action: 'discard' })}>Discard local change</button><span className="spacer" />
      <button className="button ghost" disabled={busy || !writable || (operation.kind === 'delete' ? Boolean(current) : !expected?.revision)} onClick={() => void onResolve({ action: 'accept', remoteId: expected?.id, expectedRevision: expected?.revision })}>Confirm applied</button>
      <button className="button primary" disabled={busy || !writable || (operation.status === 'review' && !notApplied) || (operation.kind !== 'create' && !current?.revision)} onClick={() => void onResolve({ action: 'retry', expectedRevision: current?.revision, confirmedNotApplied: notApplied })}>Retry my change</button>
    </footer></div></Modal>
}
