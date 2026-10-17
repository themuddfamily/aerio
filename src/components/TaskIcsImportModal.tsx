import { useEffect, useMemo, useState } from 'react'
import { FileUp, Repeat2 } from 'lucide-react'
import Modal from './Modal'
import type { Task } from '../types'
import type { ProviderTaskList, TaskSnapshot } from '../task-provider-types'
import type { TaskIcsDuplicateMode, TaskIcsPreview } from '../task-interchange-types'
import { importLocalTasks, localTaskUid } from '../lib/task-ics'
import { describeRecurrenceRule } from '../lib/vtodo'
import { taskProviderName } from '../lib/task-providers'

interface Props {
  preview: TaskIcsPreview
  localLists: string[]
  connectedLists: ProviderTaskList[]
  /** `local:<list>` or `connected:<list id>`. */
  defaultTarget: string
  localTasks: Task[]
  newId(): string
  onLocalImport(tasks: Task[]): void
  onConnectedImport(snapshot: TaskSnapshot): void
  onToast(message: string): void
  onClose(): void
}

const describeDue = (due?: string) => !due ? '' : due.length === 10 ? due : due.endsWith('Z') ? new Date(due).toLocaleString() : due.replace('T', ' ').slice(0, 16)

/** Preview and options for importing .ics tasks into a local or connected list (E45). */
export default function TaskIcsImportModal({ preview, localLists, connectedLists, defaultTarget, localTasks, newId, onLocalImport, onConnectedImport, onToast, onClose }: Props) {
  const [target, setTarget] = useState(defaultTarget)
  const [mode, setMode] = useState<TaskIcsDuplicateMode>('skip')
  const [connectedDuplicates, setConnectedDuplicates] = useState<string[]>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [warnings, setWarnings] = useState<string[]>([])
  const [kind, id] = [target.slice(0, target.indexOf(':')), target.slice(target.indexOf(':') + 1)]
  const connected = kind === 'connected' ? connectedLists.find((list) => list.id === id) : undefined
  const uids = useMemo(() => preview.items.map((item) => item.uid), [preview.items])
  useEffect(() => {
    if (kind !== 'connected' || !window.aerio?.tasks?.ics) { setConnectedDuplicates(undefined); return }
    let active = true
    setConnectedDuplicates(undefined)
    void window.aerio.tasks.ics.duplicates(id, uids).then((found) => { if (active) setConnectedDuplicates(found) }).catch(() => { if (active) setConnectedDuplicates([]) })
    return () => { active = false }
  }, [kind, id, uids])
  const duplicates = kind === 'local' ? (() => { const known = new Set(localTasks.map(localTaskUid)); return uids.filter((uid) => known.has(uid)) })() : connectedDuplicates ?? []
  const titles = new Map(preview.items.map((item) => [item.uid, item.title]))
  const run = async () => {
    if (busy) return
    setBusy(true); setError(''); setWarnings([])
    try {
      if (kind === 'local') {
        const result = importLocalTasks(localTasks, preview.items, id, mode, newId)
        onLocalImport(result.tasks)
        onToast(`${result.created} task${result.created === 1 ? '' : 's'} imported${result.replaced ? `, ${result.replaced} replaced` : ''}${result.skipped ? `, ${result.skipped} skipped` : ''}`)
        onClose()
        return
      }
      const result = await window.aerio.tasks.ics!.importConnected(id, preview.items.map((item) => item.source), mode)
      onConnectedImport(result.snapshot)
      onToast(`${result.created} task${result.created === 1 ? '' : 's'} queued for ${connected ? taskProviderName(connected.provider) : 'the list'}${result.replaced ? `, ${result.replaced} replaced` : ''}${result.skipped ? `, ${result.skipped} skipped` : ''}`)
      if (result.warnings.length) setWarnings(result.warnings)
      else onClose()
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'The tasks could not be imported') }
    finally { setBusy(false) }
  }
  return <Modal title="Import tasks" onClose={onClose}><div className="form-stack task-ics-import">
    <p><FileUp size={14} /> {preview.fileName}{preview.calendarName ? ` · ${preview.calendarName}` : ''} · {preview.items.length} task{preview.items.length === 1 ? '' : 's'}</p>
    {error && <p role="alert" className="provider-task-error">{error}</p>}
    <label className="field-label">Import into<select aria-label="Import into" value={target} disabled={busy} onChange={(event) => setTarget(event.target.value)}>
      <optgroup label="Local lists">{localLists.map((list) => <option key={list} value={`local:${list}`}>{list}</option>)}</optgroup>
      {connectedLists.length > 0 && <optgroup label="Connected lists">{connectedLists.map((list) => <option key={list.id} value={`connected:${list.id}`}>{list.title} · {taskProviderName(list.provider)}</option>)}</optgroup>}
    </select></label>
    <fieldset className="form-stack" disabled={busy}><legend>Tasks that already exist (same UID)</legend>
      <p className="provider-task-notice" role="status">{kind === 'connected' && connectedDuplicates === undefined ? 'Checking for duplicates…' : duplicates.length ? `${duplicates.length} task${duplicates.length === 1 ? '' : 's'} in this file already exist${kind === 'local' ? ' in your local tasks' : ' in this list'}: ${duplicates.slice(0, 3).map((uid) => `“${titles.get(uid)}”`).join(', ')}${duplicates.length > 3 ? '…' : ''}` : 'No duplicates found.'}</p>
      <label className="check-label"><input type="radio" name="task-ics-mode" checked={mode === 'skip'} onChange={() => setMode('skip')} /> Skip them</label>
      <label className="check-label"><input type="radio" name="task-ics-mode" checked={mode === 'replace'} onChange={() => setMode('replace')} /> Replace them with the file’s version</label>
      <label className="check-label"><input type="radio" name="task-ics-mode" checked={mode === 'copy'} onChange={() => setMode('copy')} /> Import them as copies (new UID)</label>
    </fieldset>
    {connected && connected.provider !== 'dav' && <p className="provider-task-notice">{taskProviderName(connected.provider)} stores fewer task fields than iCalendar. Fields it cannot store are kept in Aerio where possible; repeat rules, links, and other properties it cannot store are not imported.</p>}
    {connected?.provider === 'dav' && <p className="provider-task-notice">Each task is uploaded with all of its properties, including ones Aerio does not edit. Replacing updates the fields Aerio maps and keeps the server’s other properties.</p>}
    {kind === 'local' && <p className="provider-task-notice">Local tasks keep the original iCalendar data, so exporting them again retains properties Aerio does not edit. Repeat rules other than daily, weekly, or monthly are kept in that data but not applied in Aerio.</p>}
    <section className="provider-task-history" aria-label="Tasks in the file"><h2>Tasks in the file</h2>
      {preview.items.slice(0, 50).map((item) => <div key={item.uid}><span>{item.title}<small>{[
        item.completed ? 'Completed' : item.status === 'cancelled' ? 'Cancelled' : item.status === 'inProgress' ? 'In process' : '',
        item.due ? `Due ${describeDue(item.due)}` : '', item.parentUid && titles.has(item.parentUid) ? `Subtask of ${titles.get(item.parentUid)}` : '',
        item.percentComplete !== undefined ? `${item.percentComplete}% done` : '', item.categories.join(', '),
        item.links.length ? `${item.links.length} link${item.links.length === 1 ? '' : 's'}` : '', item.inlineAttachments ? `${item.inlineAttachments} embedded file${item.inlineAttachments === 1 ? '' : 's'}` : '',
        item.occurrences ? `${item.occurrences} changed occurrence${item.occurrences === 1 ? '' : 's'}` : '',
        item.preserved.length ? `Also keeps ${item.preserved.slice(0, 4).join(', ')}${item.preserved.length > 4 ? '…' : ''}` : ''
      ].filter(Boolean).join(' · ')}</small></span>{item.recurrence && <em title={describeRecurrenceRule(item.recurrence)}><Repeat2 size={13} /> {describeRecurrenceRule(item.recurrence)}</em>}</div>)}
      {preview.items.length > 50 && <p className="task-field-summary">and {preview.items.length - 50} more</p>}
    </section>
    {[...preview.warnings, ...warnings].length > 0 && <ul className="provider-task-notice" aria-label="Import notes">{[...preview.warnings, ...warnings].slice(0, 20).map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
    <footer className="modal-footer"><span className="spacer" /><button className="button ghost" onClick={onClose}>{warnings.length ? 'Done' : 'Cancel'}</button>
      {!warnings.length && <button className="button primary" disabled={busy || (kind === 'connected' && (!connected || connected.readOnly))} onClick={() => void run()}>Import {preview.items.length} task{preview.items.length === 1 ? '' : 's'}</button>}</footer>
  </div></Modal>
}
