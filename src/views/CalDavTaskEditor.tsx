import { useMemo, useState } from 'react'
import { Link2, Lock, Repeat2 } from 'lucide-react'
import Modal from '../components/Modal'
import TaskFieldsEditor from '../components/TaskFieldsEditor'
import { TASK_FIELD_CAPABILITIES, type TaskExtendedFields } from '../task-fields-types'
import type { TaskLocalMetadata, TaskNativeFields } from '../task-provider-types'
import { describeRecurrenceRule } from '../lib/vtodo'
import { localTimeZone, timeZoneOptions } from '../lib/time-zones'
import type { ProviderTaskEditorProps } from './MicrosoftTaskEditor'

type DavStatus = 'notStarted' | 'inProgress' | 'completed' | 'cancelled'
const sameList = (left?: string[], right?: string[]) => JSON.stringify(left ?? []) === JSON.stringify(right ?? [])
const FLOATING = ''

/** Splits a stored due value into date, time, and zone ('UTC' for an instant, '' for floating). */
function dueParts(due: string | undefined, zone: string | undefined) {
  if (!due) return { date: '', time: '', zone: localTimeZone() }
  if (due.length === 10) return { date: due, time: '', zone: zone ?? localTimeZone() }
  return { date: due.slice(0, 10), time: due.slice(11, 16), zone: due.endsWith('Z') ? 'UTC' : zone ?? FLOATING }
}

/** Editor for CalDAV VTODOs (E45). Repeat rules and server-only properties are shown, not edited. */
export default function CalDavTaskEditor({ task, list, tasks, writable, busy, error, onClose, onSave, onMove, onDelete }: ProviderTaskEditorProps) {
  const initial = task?.fields
  const caldav = task?.remote?.native?.caldav
  const initialDue = dueParts(initial?.due, initial?.native?.dueTimeZone)
  const [title, setTitle] = useState(initial?.title ?? '')
  const [notes, setNotes] = useState(initial?.notes ?? '')
  const [dueDate, setDueDate] = useState(initialDue.date)
  const [dueTime, setDueTime] = useState(initialDue.time)
  const [dueZone, setDueZone] = useState(initialDue.zone)
  const [priority, setPriority] = useState<NonNullable<TaskNativeFields['priority']>>(initial?.native?.priority ?? 'normal')
  const [status, setStatus] = useState<DavStatus>(initial?.completed ? 'completed' : (initial?.native?.status as DavStatus | undefined) ?? 'notStarted')
  const [parentId, setParentId] = useState(task?.parentId ?? '')
  const [extended, setExtended] = useState<TaskExtendedFields>(() => ({
    ...(initial?.native?.start ? { start: initial.native.start, ...(initial.native.startTimeZone ? { startTimeZone: initial.native.startTimeZone } : {}) } : {}),
    ...(initial?.native?.reminder ? { reminder: initial.native.reminder } : {}),
    ...(typeof initial?.native?.percentComplete === 'number' ? { percentComplete: initial.native.percentComplete } : {}),
    ...(initial?.native?.categories?.length ? { categories: initial.native.categories } : {}),
    ...(task?.local.extended?.attachments ? { attachments: task.local.extended.attachments } : {})
  }))
  const [fieldError, setFieldError] = useState('')
  const zones = useMemo(() => {
    const options = timeZoneOptions(dueZone || undefined)
    return [...(initialDue.zone === FLOATING ? [FLOATING] : []), ...(options.includes('UTC') ? options : ['UTC', ...options])]
  }, [dueZone, initialDue.zone])
  const disabled = !writable || busy
  const occurrence = Boolean(caldav?.recurrenceId)
  const composeDue = () => {
    if (!dueDate) return undefined
    if (dueDate === initialDue.date && dueTime === initialDue.time && dueZone === initialDue.zone) return initial?.due
    if (!dueTime) return dueDate
    return dueZone === 'UTC' ? `${dueDate}T${dueTime}:00Z` : `${dueDate}T${dueTime}:00`
  }
  const save = () => {
    const due = composeDue()
    const fields: NonNullable<typeof initial> = { title: title.trim(), notes: notes || undefined, due, completed: status === 'completed', native: {} }
    const native = fields.native!
    if (!task || priority !== initial?.native?.priority) native.priority = priority
    if (!task || status !== initial?.native?.status) native.status = status
    if (due && dueTime && dueZone && dueZone !== 'UTC' && (!task || due !== initial?.due || dueZone !== initial?.native?.dueTimeZone)) native.dueTimeZone = dueZone
    const start = extended.start ?? null
    const startZone = extended.start && extended.start.length > 10 ? extended.startTimeZone : undefined
    if ((task && (start !== (initial?.native?.start ?? null) || (start !== null && startZone !== initial?.native?.startTimeZone))) || (!task && start !== null)) {
      native.start = start
      if (startZone) native.startTimeZone = startZone
    }
    if ((extended.reminder ?? null) !== (initial?.native?.reminder ?? null)) native.reminder = extended.reminder ?? null
    if (!sameList(extended.categories, initial?.native?.categories)) native.categories = extended.categories ?? []
    if ((extended.percentComplete ?? null) !== (initial?.native?.percentComplete ?? null)) native.percentComplete = extended.percentComplete ?? null
    const local: TaskLocalMetadata = { priority: 'normal', recurrence: 'none', ...(extended.attachments?.length ? { extended: { attachments: extended.attachments } } : {}) }
    void onSave(fields, local, parentId || undefined)
  }
  const parentChanged = Boolean(task && parentId !== (task.parentId ?? ''))
  return <Modal title={task ? occurrence ? 'CalDAV task occurrence' : 'CalDAV task' : 'New CalDAV task'} onClose={onClose}><form className="form-stack" onSubmit={(event) => { event.preventDefault(); save() }}>
    <p>{list.title}{!writable ? ' · Read-only' : ''}</p>{error && <p role="alert" className="provider-task-error">{error}</p>}
    {caldav?.readOnlyReason && <p className="provider-task-notice" role="status"><Lock size={13} /> {caldav.readOnlyReason}</p>}
    <label className="field-label">Task<input autoFocus value={title} required maxLength={1024} disabled={disabled} onChange={(event) => setTitle(event.target.value)} /></label>
    <div className="form-grid-2">
      <label className="field-label">Status<select aria-label="Status" value={status} disabled={disabled} onChange={(event) => setStatus(event.target.value as DavStatus)}><option value="notStarted">Needs action</option><option value="inProgress">In process</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option></select></label>
      <label className="field-label">Priority<select aria-label="Priority" value={priority} disabled={disabled} onChange={(event) => setPriority(event.target.value as NonNullable<TaskNativeFields['priority']>)}><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option></select></label>
      <label className="field-label">Due date<input type="date" aria-label="Due date" value={dueDate} disabled={disabled} onChange={(event) => { setDueDate(event.target.value); if (!event.target.value) setDueTime('') }} /></label>
      <label className="field-label">Due time<input type="time" aria-label="Due time" value={dueTime} disabled={disabled || !dueDate} onChange={(event) => setDueTime(event.target.value)} /></label>
      {dueTime && <label className="field-label">Due time zone<select aria-label="Due time zone" value={dueZone} disabled={disabled} onChange={(event) => setDueZone(event.target.value)}>{zones.map((zone) => <option key={zone || 'floating'} value={zone}>{zone || 'Floating (no time zone)'}</option>)}</select></label>}
      {!occurrence && <label className="field-label">Parent task<select aria-label="Parent task" value={parentId} disabled={disabled} onChange={(event) => setParentId(event.target.value)}><option value="">No parent</option>{tasks.filter((item) => item.id !== task?.id && !item.remote?.readOnly && !item.remote?.native?.caldav?.recurrenceId).map((item) => <option key={item.id} value={item.id}>{item.fields.title}</option>)}</select></label>}
    </div>
    <label className="field-label">Notes<textarea aria-label="Notes" value={notes} disabled={disabled || caldav?.notesTruncated} maxLength={8192} onChange={(event) => setNotes(event.target.value)} /></label>
    {caldav?.notesTruncated && <p className="provider-task-notice">These notes are longer than Aerio can edit. The full text stays on the server unchanged.</p>}
    {(caldav?.recurrence || caldav?.recurrenceNote) && <p className="provider-task-notice"><Repeat2 size={13} /> {caldav.recurrence ? `${describeRecurrenceRule(caldav.recurrence)}. ` : ''}{caldav.recurrenceNote}</p>}
    <TaskFieldsEditor value={extended} onChange={setExtended} support={TASK_FIELD_CAPABILITIES.dav} provider="CalDAV" disabled={disabled} onError={setFieldError} />
    {fieldError && <p role="alert" className="provider-task-error">{fieldError}</p>}
    {(caldav?.links?.length || caldav?.inlineAttachments?.length) ? <section className="provider-task-history" aria-label="Server attachments"><h2>Server attachments</h2>
      {caldav.links?.map((link) => <div key={link.uri}><span><Link2 size={13} /> {link.name ?? link.uri}<small>{link.name ? link.uri : link.contentType ?? 'Link'}</small></span></div>)}
      {caldav.inlineAttachments?.map((item, index) => <div key={`${item.name}-${index}`}><span><Lock size={13} /> {item.name}<small>Embedded file · kept on the server, read-only in Aerio</small></span></div>)}
    </section> : null}
    {caldav?.preserved?.length ? <p className="provider-task-notice">Kept unchanged on every save: {caldav.preserved.slice(0, 12).join(', ')}{caldav.preserved.length > 12 ? '…' : ''}</p> : null}
    <footer className="modal-footer">{onDelete && <button type="button" className="button danger-subtle" disabled={busy} onClick={onDelete}>{occurrence ? 'Delete occurrence' : 'Delete task'}</button>}<span className="spacer" /><button type="button" className="button ghost" onClick={onClose}>Close</button>
      {onMove && parentChanged && <button type="button" className="button ghost" disabled={disabled} onClick={() => void onMove(parentId || undefined)}>Move task</button>}
      <button type="submit" className="button primary" disabled={disabled || !title.trim() || parentChanged}>Save task</button></footer>
  </form></Modal>
}
