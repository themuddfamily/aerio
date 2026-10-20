import { useEffect, useState } from 'react'
import Modal from './Modal'
import type { MailAccountSummary } from '../mail-types'
import type { DelegateTaskInput, DelegatedTask, DelegationSource, TaskDelegationApi } from '../task-delegation-types'
import './TaskDelegation.css'
const deliveryLabel = (status: string) => ({ 'send-pending': 'Waiting in Outbox', queued: 'Waiting in Outbox', syncing: 'Sending', sent: 'Sent', failed: 'Failed', discarded: 'Discarded', cancelled: 'Cancelled', missing: 'Removed from Outbox' }[status] ?? status)
const failure = (error: unknown) => error instanceof Error ? error.message : 'The task request could not be saved.'
export function DelegateTaskButton({ title, notes, due, source }: { title: string; notes?: string; due?: string; source: DelegationSource }) {
  const [open, setOpen] = useState(false)
  if (!window.aerio?.taskDelegations) return null
  return <><button className="button ghost small" aria-label={`Delegate ${title}`} onClick={() => setOpen(true)}>Delegate</button>{open && <DelegateTaskForm initial={{ title, notes, due: due?.slice(0, 10), source }} onClose={() => setOpen(false)} />}</>
}
function DelegateTaskForm({ initial, onClose, onSaved }: { initial?: Partial<DelegateTaskInput>; onClose(): void; onSaved?(): void }) {
  const [accounts, setAccounts] = useState<MailAccountSummary[]>([]), [accountId, setAccountId] = useState('')
  const [title, setTitle] = useState(initial?.title ?? ''), [notes, setNotes] = useState(initial?.notes ?? ''), [due, setDue] = useState(initial?.due ?? ''), [assignee, setAssignee] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => { let active = true; void window.aerio.mail.accounts.list().then((items) => { if (active) { const usable = items.filter((item) => !item.archived && item.provider !== 'local'); setAccounts(usable); setAccountId(usable[0]?.id ?? '') } }).catch((error) => setError(failure(error))); return () => { active = false } }, [])
  return <Modal title="Delegate task" onClose={onClose} closeEnabled={!busy}><form className="delegation-form" onSubmit={(event) => { event.preventDefault(); setBusy(true); setError(''); void window.aerio.taskDelegations!.assign({ accountId, assignee, title, notes, due, source: initial?.source }).then(() => { onSaved?.(); onClose() }).catch((error) => setError(failure(error))).finally(() => setBusy(false)) }}>
    <p>A task request will be emailed to the recipient. Their mail app must support VTODO task requests. Your original task stays independent.</p>
    <label>Send from<select value={accountId} onChange={(event) => setAccountId(event.target.value)}>{accounts.map((account) => <option key={account.id} value={account.id}>{account.email}</option>)}</select></label>
    <label>Assign to<input required type="email" value={assignee} onChange={(event) => setAssignee(event.target.value)} /></label>
    <label>Task title<input required maxLength={1024} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
    <label>Notes<textarea maxLength={8192} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
    <label>Due date<input type="date" value={due} onChange={(event) => setDue(event.target.value)} /></label>
    {error && <p role="alert">{error}</p>}<button className="button primary" disabled={busy || !accountId}>Send task request</button>
  </form></Modal>
}
export function DelegationDetails({ task, onChanged, onOpenSource }: { task: DelegatedTask; onChanged(task: DelegatedTask): void; onOpenSource?(source: DelegationSource): void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [comment, setComment] = useState(''), [percent, setPercent] = useState(50), [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(task.title), [notes, setNotes] = useState(task.notes), [due, setDue] = useState(task.due ?? '')
  const run = async (work: (api: TaskDelegationApi) => Promise<DelegatedTask>) => { setBusy(true); setError(''); try { onChanged(await work(window.aerio.taskDelegations!)); setEditing(false) } catch (error) { setError(failure(error)) } finally { setBusy(false) } }
  const reply = (response: 'accept' | 'decline' | 'progress' | 'complete') => run((api) => api.respond({ id: task.id, expectedUpdatedAt: task.updatedAt, response, percent, comment }))
  return <article className="delegation-card"><h3>{task.title}</h3><p>{task.organizer} → {task.assignee}{task.due ? ` · Due ${task.due}` : ''}</p><strong>{task.status === 'CANCELLED' ? 'Cancelled' : `${task.participation.toLowerCase().replace('-', ' ')} · ${task.status.toLowerCase().replace('-', ' ')} · ${task.percent}%`}</strong>{task.notes && <p className="delegation-notes">{task.notes}</p>}{task.comment && <p>Response: {task.comment}</p>}
    {task.source && onOpenSource && <button className="button ghost small" onClick={() => onOpenSource(task.source!)}>Open original task</button>}
    {task.status !== 'CANCELLED' && <fieldset disabled={busy}>
      {task.role === 'organizer' ? <>{editing ? <div className="delegation-form"><label>Task title<input value={title} maxLength={1024} onChange={(event) => setTitle(event.target.value)} /></label><label>Notes<textarea value={notes} maxLength={8192} onChange={(event) => setNotes(event.target.value)} /></label><label>Due date<input type="date" value={due} onChange={(event) => setDue(event.target.value)} /></label><button className="button primary small" onClick={() => void run((api) => api.update({ id: task.id, expectedUpdatedAt: task.updatedAt, title, notes, due }))}>Send updated request</button></div> : <button className="button ghost small" onClick={() => { setTitle(task.title); setNotes(task.notes); setDue(task.due ?? ''); setEditing(true) }}>Update request</button>}<button className="button ghost small" onClick={() => { if (window.confirm(`Email cancellation of “${task.title}”?`)) void run((api) => api.update({ id: task.id, expectedUpdatedAt: task.updatedAt, cancel: true })) }}>Cancel assignment</button></> : <><label>Reply comment<textarea maxLength={2000} value={comment} onChange={(event) => setComment(event.target.value)} /></label>{task.participation !== 'ACCEPTED' ? <><button className="button primary small" onClick={() => void reply('accept')}>Accept and send reply</button><button className="button ghost small" onClick={() => void reply('decline')}>Decline and send reply</button></> : <><label>Progress (%)<input type="number" min={0} max={99} value={percent} onChange={(event) => setPercent(Number(event.target.value))} /></label><button className="button ghost small" onClick={() => void reply('progress')}>Send progress</button><button className="button primary small" onClick={() => void reply('complete')}>Complete and send reply</button></>}</>}
    </fieldset>}
    {task.deliveries.map((delivery) => <p key={delivery.id} className="delegation-delivery">{delivery.method}: {deliveryLabel(delivery.status)}{delivery.error && ` — ${delivery.error}`}{delivery.status === 'failed' && <button disabled={busy} onClick={() => { if (window.confirm('Check Sent mail first: a connection error may occur after delivery. Retry this task message?')) { setBusy(true); void window.aerio.taskDelegations!.retry(delivery.id).then(() => window.aerio.taskDelegations!.list()).then((items) => { const next = items.find((item) => item.id === task.id); if (next) onChanged(next) }).catch((error) => setError(failure(error))).finally(() => setBusy(false)) } }}>Retry message</button>}</p>)}
    {error && <p role="alert">{error}</p>}
  </article>
}
export function TaskDelegationPanel({ onOpenSource }: { onOpenSource(source: DelegationSource): void }) {
  const [tasks, setTasks] = useState<DelegatedTask[]>([]), [creating, setCreating] = useState(false), [error, setError] = useState('')
  const refresh = () => window.aerio.taskDelegations!.list().then(setTasks).catch((error) => setError(failure(error)))
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 10000); return () => clearInterval(timer) }, [])
  return <section className="module-panel tasks-panel"><header className="module-header"><div><h1>Delegated tasks</h1><p>Task requests and replies sent by email</p></div><button className="button primary" onClick={() => setCreating(true)}>Delegate task</button><button className="button ghost" onClick={() => void refresh()}>Refresh assignments</button></header><p className="delegation-explanation">Google Tasks and Microsoft To Do do not expose native assignment APIs. These requests use iCalendar VTODO mail. Status updates require a reply from a compatible app. Requests saved offline wait in Outbox.</p>{error && <p role="alert">{error}</p>}{tasks.map((task) => <DelegationDetails key={task.id} task={task} onChanged={(next) => setTasks((items) => items.map((item) => item.id === next.id ? next : item))} onOpenSource={onOpenSource} />)}{!tasks.length && <p>No task requests yet. Delegate a task, or open a received task request in Mail.</p>}{creating && <DelegateTaskForm onClose={() => setCreating(false)} onSaved={() => void refresh()} />}</section>
}
export function TaskDelegationMessage({ accountId, messageId }: { accountId: string; messageId: string }) {
  const [task, setTask] = useState<DelegatedTask>()
  useEffect(() => { let active = true; setTask(undefined); void window.aerio?.taskDelegations?.inspect(accountId, messageId).then((next) => { if (active) setTask(next) }).catch(() => {}); return () => { active = false } }, [accountId, messageId])
  return task ? <section aria-label="Task request"><DelegationDetails task={task} onChanged={setTask} /></section> : null
}
