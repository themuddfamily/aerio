import { Bell, CalendarClock, ExternalLink, FileText, Paperclip, Percent, Plus, Tag, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { Attachment } from '../types'
import type { TaskExtendedFieldName, TaskExtendedFields, TaskFieldCapabilities, TaskNativeAttachment } from '../task-fields-types'
import { describeTaskStart, instantFromInput, instantInputValue, parseCategories, parseTaskStart } from '../lib/task-schedule'
import { localTimeZone, timeZoneOptions } from '../lib/time-zones'

const formatSize = (size: number) => size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`

/** Provider attachments shown in place of local files (Microsoft To Do). Changes apply immediately. */
export interface NativeAttachmentControls {
  items: TaskNativeAttachment[]
  /** Explains why changes are unavailable, for example on an unsaved task. */
  unavailable?: string
  busy?: boolean
  onAdd(): void
  onOpen(item: TaskNativeAttachment): void
  onRemove(item: TaskNativeAttachment): void
}

interface Props {
  value: TaskExtendedFields
  onChange(value: TaskExtendedFields): void
  support: TaskFieldCapabilities
  /** Provider name for source labels; omitted for local tasks, where every field is stored in Aerio. */
  provider?: string
  disabled?: boolean
  onError?(message: string): void
  nativeAttachments?: NativeAttachmentControls
}

function SourceLabel({ field, support, provider }: { field: TaskExtendedFieldName; support: TaskFieldCapabilities; provider?: string }) {
  if (!provider) return null
  return support[field] === 'native'
    ? <span className="task-field-source native">Saved in {provider}</span>
    : <span className="task-field-source local" title={`${provider} cannot store this field. Aerio keeps it on this device, beside the cached task, and includes it in Aerio backups.`}>Aerio only</span>
}

/** Start date/time and zone, reminder, percent complete, tags, and attachments for any task source (E44). */
export default function TaskFieldsEditor({ value, onChange, support, provider, disabled, onError, nativeAttachments }: Props) {
  const parsed = parseTaskStart(value.start)
  const startDate = value.start?.slice(0, 10) ?? ''
  const startTime = parsed && !parsed.dateOnly ? value.start!.slice(11, 16) : ''
  const zone = value.startTimeZone ?? localTimeZone()
  const zones = useMemo(() => { const options = timeZoneOptions(zone); return options.includes(zone) ? options : [zone, ...options] }, [zone])
  const [categoryText, setCategoryText] = useState((value.categories ?? []).join(', '))
  const [attaching, setAttaching] = useState(false)
  const update = (patch: Partial<TaskExtendedFields>) => onChange({ ...value, ...patch })
  const setStart = (date: string, time: string, nextZone = zone) => {
    if (!date) { update({ start: undefined, startTimeZone: undefined }); return }
    update(time ? { start: `${date}T${time}:00`, startTimeZone: nextZone } : { start: date, startTimeZone: undefined })
  }
  const localAttachments = value.attachments ?? []
  const addLocalAttachments = async () => {
    const api = window.aerio?.tasks?.attachments
    if (!api) { onError?.('Attachments are unavailable'); return }
    setAttaching(true)
    try {
      const chosen = await api.choose()
      if (!chosen.length) return
      if (localAttachments.length + chosen.length > 50) throw new Error('A task can contain up to 50 attachments')
      update({ attachments: [...localAttachments, ...chosen] })
    } catch (error) { onError?.(error instanceof Error ? error.message : 'Attachments could not be added') }
    finally { setAttaching(false) }
  }
  const openLocalAttachment = async (attachment: Attachment) => {
    try {
      if (!attachment.path) throw new Error('That attachment is unavailable')
      const result = await window.aerio.tasks.attachments!.open(attachment.path)
      if (result.error) throw new Error(result.error)
    } catch (error) { onError?.(error instanceof Error ? error.message : 'Attachment could not be opened') }
  }
  const reminderInput = instantInputValue(value.reminder)
  return <div className="task-fields"><fieldset disabled={disabled}>
    <legend>Schedule and details</legend>
    <div className="form-grid-2">
      <label className="field-label"><span className="task-field-heading"><CalendarClock size={13} /> Start date <SourceLabel field="start" support={support} provider={provider} /></span>
        <input type="date" aria-label="Start date" value={startDate} onChange={(event) => setStart(event.target.value, startTime)} /></label>
      <label className="field-label">Start time
        <input type="time" aria-label="Start time" value={startTime} disabled={disabled || !startDate} onChange={(event) => setStart(startDate, event.target.value)} /></label>
      {startTime && <label className="field-label">Start time zone
        <select aria-label="Start time zone" value={zone} onChange={(event) => setStart(startDate, startTime, event.target.value)}>{zones.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>}
      <label className="field-label"><span className="task-field-heading"><Bell size={13} /> Reminder <SourceLabel field="reminder" support={support} provider={provider} /></span>
        <span className="task-reminder-input">
          <input type="checkbox" aria-label="Remind me" checked={Boolean(value.reminder)} onChange={(event) => {
            if (!event.target.checked) { update({ reminder: undefined }); return }
            const next = new Date(Date.now() + 3_600_000); next.setMinutes(0, 0, 0)
            update({ reminder: next.toISOString() })
          }} />
          <input type="datetime-local" aria-label="Reminder time" value={reminderInput} disabled={disabled || !value.reminder} onChange={(event) => { const instant = instantFromInput(event.target.value); if (instant) update({ reminder: instant }) }} />
        </span></label>
      <label className="field-label"><span className="task-field-heading"><Percent size={13} /> Percent complete <SourceLabel field="percentComplete" support={support} provider={provider} /></span>
        <input type="number" aria-label="Percent complete" min={0} max={100} step={5} value={value.percentComplete ?? ''} placeholder="Not tracked" onChange={(event) => {
          const raw = event.target.value
          update({ percentComplete: raw === '' ? undefined : Math.max(0, Math.min(100, Math.round(Number(raw)))) })
        }} /></label>
      <label className="field-label"><span className="task-field-heading"><Tag size={13} /> Tags <SourceLabel field="categories" support={support} provider={provider} /></span>
        <input aria-label="Tags" value={categoryText} placeholder="Separate tags with commas" onChange={(event) => {
          setCategoryText(event.target.value)
          const categories = parseCategories(event.target.value)
          update({ categories: categories.length ? categories : undefined })
        }} /></label>
    </div>
    {value.start && <p className="task-field-summary">Starts {describeTaskStart(value.start, startTime ? zone : undefined)}{value.reminder ? ` · Reminder ${new Date(value.reminder).toLocaleString()}` : ''}</p>}
    </fieldset>
    <section className="note-attachments task-attachments" aria-label="Task attachments">
      <header><Paperclip size={14} /><strong>Attachments</strong><SourceLabel field="attachments" support={support} provider={provider} />
        <span>{nativeAttachments ? nativeAttachments.items.length : localAttachments.length}</span>
        {nativeAttachments
          ? <button type="button" className="button ghost small" disabled={disabled || nativeAttachments.busy || Boolean(nativeAttachments.unavailable)} onClick={nativeAttachments.onAdd}><Plus size={13} /> Add files</button>
          : <button type="button" className="button ghost small" disabled={disabled || attaching} onClick={() => void addLocalAttachments()}><Plus size={13} /> Add files</button>}
      </header>
      {nativeAttachments?.unavailable && <p className="task-field-summary">{nativeAttachments.unavailable}</p>}
      {(nativeAttachments ? nativeAttachments.items : localAttachments).map((attachment) => <div className="note-attachment" key={attachment.id}>
        <button type="button" aria-label={`Open ${attachment.name}`} onClick={() => nativeAttachments ? nativeAttachments.onOpen(attachment as TaskNativeAttachment) : void openLocalAttachment(attachment as Attachment)}><FileText size={16} /><span><strong>{attachment.name}</strong><small>{formatSize(attachment.size)}</small></span><ExternalLink size={13} /></button>
        <button type="button" className="icon-button" aria-label={`Remove ${attachment.name}`} title="Remove attachment" disabled={disabled || nativeAttachments?.busy || Boolean(nativeAttachments?.unavailable)} onClick={() => nativeAttachments ? nativeAttachments.onRemove(attachment as TaskNativeAttachment) : update({ attachments: localAttachments.filter((item) => item.id !== attachment.id) })}><X size={15} /></button>
      </div>)}
    </section>
    {provider && Object.values(support).includes('local') && <p className="provider-task-notice">Fields marked “Aerio only” are not supported by {provider}. Aerio keeps them on this device with the cached task and in Aerio backups; other apps will not see them.</p>}
  </div>
}
