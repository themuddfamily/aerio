import { useState } from 'react'
import Modal from '../components/Modal'
import type { ProviderTaskList, TaskEntity, TaskLocalMetadata, TaskNativeFields, TaskNativeRecurrence } from '../task-provider-types'

export interface ProviderTaskEditorProps {
  task?: TaskEntity; list: ProviderTaskList; tasks: TaskEntity[]; writable: boolean; busy: boolean; error: string; onClose(): void
  onSave(fields: TaskEntity['fields'], local: TaskLocalMetadata, parentId?: string): Promise<void>
  onMove?(parentId?: string): Promise<void>; onDelete?(): void
}
const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const patterns: [TaskNativeRecurrence['pattern']['type'], string][] = [['daily', 'Daily'], ['weekly', 'Weekly'], ['absoluteMonthly', 'Monthly on a date'], ['relativeMonthly', 'Monthly on a weekday'], ['absoluteYearly', 'Yearly on a date'], ['relativeYearly', 'Yearly on a weekday']]
const dueInput = (value?: string) => value ? value.slice(0, 19) : ''

export default function MicrosoftTaskEditor({ task, list, tasks, writable, busy, error, onClose, onSave, onDelete }: ProviderTaskEditorProps) {
  const initial = task?.fields
  const [title, setTitle] = useState(initial?.title ?? '')
  const [notes, setNotes] = useState(initial?.notes ?? '')
  const [due, setDue] = useState(dueInput(initial?.due))
  const [zone, setZone] = useState(initial?.native?.dueTimeZone ?? 'UTC')
  const [priority, setPriority] = useState<TaskNativeFields['priority']>(initial?.native?.priority ?? 'normal')
  const [status, setStatus] = useState<TaskNativeFields['status']>(initial?.completed ? 'completed' : initial?.native?.status ?? 'notStarted')
  const [recurrence, setRecurrence] = useState<TaskNativeRecurrence | null>(initial?.native?.recurrence ? structuredClone(initial.native.recurrence) : null)
  const [parentId, setParentId] = useState(task?.parentId ?? '')
  const checklist = Boolean(parentId || task?.remote?.kind === 'checklist')
  const disabled = !writable || busy
  const relative = recurrence?.pattern.type === 'relativeMonthly' || recurrence?.pattern.type === 'relativeYearly'
  const needsDays = relative || recurrence?.pattern.type === 'weekly'
  const recurrenceValid = !recurrence || (recurrence.pattern.interval >= 1 && (!needsDays || Boolean(recurrence.pattern.daysOfWeek?.length)) && Boolean(recurrence.range.startDate) && (recurrence.range.type !== 'endDate' || Boolean(recurrence.range.endDate && recurrence.range.endDate >= recurrence.range.startDate)) && (recurrence.range.type !== 'numbered' || Number(recurrence.range.numberOfOccurrences) > 0))
  const changePattern = (type: TaskNativeRecurrence['pattern']['type'] | '') => {
    if (!type) { setRecurrence(null); return }
    const pattern: TaskNativeRecurrence['pattern'] = { type, interval: recurrence?.pattern.interval ?? 1 }
    if (type === 'weekly' || type.startsWith('relative')) pattern.daysOfWeek = recurrence?.pattern.daysOfWeek?.length ? recurrence.pattern.daysOfWeek : ['monday']
    if (type === 'weekly') pattern.firstDayOfWeek = recurrence?.pattern.firstDayOfWeek ?? 'monday'
    if (type.startsWith('absolute')) pattern.dayOfMonth = recurrence?.pattern.dayOfMonth || 1
    if (type.endsWith('Yearly')) pattern.month = recurrence?.pattern.month || 1
    if (type.startsWith('relative')) pattern.index = recurrence?.pattern.index ?? 'first'
    setRecurrence({ pattern, range: recurrence?.range ?? { type: 'noEnd', startDate: (due || new Date().toISOString()).slice(0, 10), recurrenceTimeZone: zone } })
  }
  const updatePattern = (patch: Partial<TaskNativeRecurrence['pattern']>) => setRecurrence((value) => value ? { ...value, pattern: { ...value.pattern, ...patch } } : value)
  const updateRange = (patch: Partial<TaskNativeRecurrence['range']>) => setRecurrence((value) => value ? { ...value, range: { ...value.range, ...patch } } : value)
  const save = () => {
    const fields: TaskEntity['fields'] = { title: title.trim(), completed: status === 'completed' }
    if (!checklist) {
      fields.notes = notes || undefined
      fields.due = due === dueInput(initial?.due) ? initial?.due : due ? due.length === 16 ? `${due}:00` : due : undefined
      fields.native = {}
      if (!task || priority !== initial?.native?.priority) fields.native.priority = priority
      if (!task || status !== initial?.native?.status) fields.native.status = status
      if (!task || JSON.stringify(recurrence) !== JSON.stringify(initial?.native?.recurrence ?? null)) fields.native.recurrence = recurrence
      if (fields.due && (!task || zone !== initial?.native?.dueTimeZone)) fields.native.dueTimeZone = zone.trim()
    }
    void onSave(fields, { priority: 'normal', recurrence: 'none' }, parentId || undefined)
  }
  return <Modal title={task ? checklist ? 'Microsoft checklist item' : 'Microsoft task' : 'New Microsoft task'} onClose={onClose}><form className="form-stack" onSubmit={(event) => { event.preventDefault(); save() }}>
    <p>{list.title}{!writable ? ' · Read-only' : ''}</p>{error && <p role="alert" className="provider-task-error">{error}</p>}
    <label className="field-label">Task<input autoFocus value={title} required maxLength={1024} disabled={disabled} onChange={(event) => setTitle(event.target.value)} /></label>
    <label className="field-label">Progress<select aria-label="Progress" value={status} disabled={disabled} onChange={(event) => setStatus(event.target.value as TaskNativeFields['status'])}><option value="notStarted">Not started</option>{!checklist && <><option value="inProgress">In progress</option><option value="waitingOnOthers">Waiting on others</option><option value="deferred">Deferred</option></>}<option value="completed">Completed</option></select></label>
    {!task && <label className="field-label">Parent task<select aria-label="Parent task" value={parentId} disabled={disabled} onChange={(event) => { setParentId(event.target.value); if (event.target.value && status !== 'completed') setStatus('notStarted') }}><option value="">No parent</option>{tasks.filter((item) => !item.parentId && item.remote?.kind !== 'checklist' && !item.remote?.readOnly && !item.remote?.assigned).map((item) => <option key={item.id} value={item.id}>{item.fields.title}</option>)}</select></label>}
    {checklist ? <p className="provider-task-notice">Microsoft checklist items have a name and completion state. They stay with their parent task.</p> : <>
      <label className="field-label">Notes<textarea aria-label="Notes" value={notes} disabled={disabled} maxLength={Math.max(8192, initial?.notes?.length ?? 0)} onChange={(event) => setNotes(event.target.value)} /></label>
      <div className="form-grid-2"><label className="field-label">Due date and time<input type="datetime-local" step="1" value={due} disabled={disabled} onChange={(event) => setDue(event.target.value)} /></label><label className="field-label">Time zone<input value={zone} required={Boolean(due)} maxLength={200} disabled={disabled || !due} onChange={(event) => setZone(event.target.value)} placeholder="UTC or a Microsoft time zone" /></label>
        <label className="field-label">Priority in Microsoft<select aria-label="Priority in Microsoft" value={priority} disabled={disabled} onChange={(event) => setPriority(event.target.value as TaskNativeFields['priority'])}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option></select></label>
        <label className="field-label">Repeat in Microsoft<select aria-label="Repeat in Microsoft" value={recurrence?.pattern.type ?? ''} disabled={disabled} onChange={(event) => changePattern(event.target.value as TaskNativeRecurrence['pattern']['type'] | '')}><option value="">Never</option>{patterns.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
      {recurrence && <fieldset disabled={disabled} className="form-stack"><legend>Recurrence</legend><div className="form-grid-2">
        <label className="field-label">Repeat interval<input type="number" min="1" max="2147483647" required value={recurrence.pattern.interval} onChange={(event) => updatePattern({ interval: Number(event.target.value) })} /></label>
        {recurrence.pattern.type.startsWith('absolute') && <label className="field-label">Day of month<input type="number" min="1" max="31" required value={recurrence.pattern.dayOfMonth ?? 1} onChange={(event) => updatePattern({ dayOfMonth: Number(event.target.value) })} /></label>}
        {recurrence.pattern.type.endsWith('Yearly') && <label className="field-label">Month<input type="number" min="1" max="12" required value={recurrence.pattern.month ?? 1} onChange={(event) => updatePattern({ month: Number(event.target.value) })} /></label>}
        {relative && <label className="field-label">Week of month<select aria-label="Week of month" value={recurrence.pattern.index ?? 'first'} onChange={(event) => updatePattern({ index: event.target.value as TaskNativeRecurrence['pattern']['index'] })}>{['first', 'second', 'third', 'fourth', 'last'].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>}
        {recurrence.pattern.type === 'weekly' && <label className="field-label">First day of week<select aria-label="First day of week" value={recurrence.pattern.firstDayOfWeek ?? 'monday'} onChange={(event) => updatePattern({ firstDayOfWeek: event.target.value })}>{weekdays.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>}
      </div>{needsDays && <div role="group" aria-label="Repeat weekdays">{weekdays.map((day) => <label className="check-label" key={day}><input type="checkbox" checked={recurrence.pattern.daysOfWeek?.includes(day) ?? false} onChange={(event) => updatePattern({ daysOfWeek: event.target.checked ? [...recurrence.pattern.daysOfWeek ?? [], day] : recurrence.pattern.daysOfWeek?.filter((value) => value !== day) })} />{day}</label>)}</div>}
      <div className="form-grid-2"><label className="field-label">Repeat starts<input type="date" required value={recurrence.range.startDate} onChange={(event) => updateRange({ startDate: event.target.value })} /></label>
        <label className="field-label">Repeat ends<select aria-label="Repeat ends" value={recurrence.range.type} onChange={(event) => updateRange({ type: event.target.value as TaskNativeRecurrence['range']['type'], ...(event.target.value === 'endDate' ? { endDate: recurrence.range.endDate && recurrence.range.endDate >= recurrence.range.startDate ? recurrence.range.endDate : recurrence.range.startDate } : event.target.value === 'numbered' ? { numberOfOccurrences: recurrence.range.numberOfOccurrences || 1 } : {}) })}><option value="noEnd">Never</option><option value="endDate">On a date</option><option value="numbered">After a number of occurrences</option></select></label>
        {recurrence.range.type === 'endDate' && <label className="field-label">Last repeat date<input type="date" min={recurrence.range.startDate} required value={recurrence.range.endDate ?? ''} onChange={(event) => updateRange({ endDate: event.target.value })} /></label>}
        {recurrence.range.type === 'numbered' && <label className="field-label">Number of occurrences<input type="number" min="1" max="2147483647" required value={recurrence.range.numberOfOccurrences ?? 1} onChange={(event) => updateRange({ numberOfOccurrences: Number(event.target.value) })} /></label>}
        <label className="field-label">Repeat time zone<input maxLength={200} value={recurrence.range.recurrenceTimeZone ?? ''} onChange={(event) => updateRange({ recurrenceTimeZone: event.target.value || undefined })} /></label></div></fieldset>}
      <p className="provider-task-notice">Microsoft stores priority, repeat settings, and due times. A due time uses the time zone shown above.</p>
    </>}
    <footer className="modal-footer">{onDelete && <button type="button" className="button danger-subtle" disabled={busy} onClick={onDelete}>Delete task</button>}<span className="spacer" /><button type="button" className="button ghost" onClick={onClose}>Close</button><button type="submit" className="button primary" disabled={disabled || !title.trim() || (!checklist && (!recurrenceValid || Boolean(due && !zone.trim())))}>Save task</button></footer>
  </form></Modal>
}
