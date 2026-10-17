import { Bell, Paperclip, Play, Tag } from 'lucide-react'
import type { TaskExtendedFields } from '../task-fields-types'
import type { TaskEntity } from '../task-provider-types'
import { describeTaskStart, parseTaskStart } from '../lib/task-schedule'

/** The neutral view of a connected task: native Microsoft fields first, then the local overlay. */
export function connectedTaskFields(task: TaskEntity): TaskExtendedFields & { attachmentCount: number } {
  // Microsoft and CalDAV (E45) store these natively; Google keeps them in the local overlay.
  const native = task.provider !== 'gmail' ? task.fields.native : undefined
  const local = task.local.extended ?? {}
  const value: TaskExtendedFields = { ...local }
  if (native) {
    if (native.start) { value.start = native.start; value.startTimeZone = native.startTimeZone } else { delete value.start; delete value.startTimeZone }
    if (native.reminder) value.reminder = native.reminder; else delete value.reminder
    if (native.categories?.length) value.categories = native.categories; else delete value.categories
    if (task.provider === 'dav') { if (typeof native.percentComplete === 'number') value.percentComplete = native.percentComplete; else delete value.percentComplete }
  }
  const links = task.provider === 'dav' ? (task.remote?.native?.caldav?.links?.length ?? 0) + (task.remote?.native?.caldav?.inlineAttachments?.length ?? 0) : 0
  return { ...value, attachmentCount: task.provider === 'microsoft' ? native?.attachments?.length ?? 0 : (local.attachments?.length ?? 0) + links }
}

/** Compact row metadata for start, reminder, progress, tags, and attachments. */
export default function TaskFieldChips({ fields, completed }: { fields: TaskExtendedFields & { attachmentCount?: number }; completed?: boolean }) {
  const count = fields.attachmentCount ?? fields.attachments?.length ?? 0
  const start = parseTaskStart(fields.start)
  return <>
    {start && <em title={`Starts ${describeTaskStart(fields.start, fields.startTimeZone)}`}><Play size={11} /> Starts {describeTaskStart(fields.start).split(',')[0]}</em>}
    {fields.reminder && !completed && <em title={`Reminder ${new Date(fields.reminder).toLocaleString()}`}><Bell size={12} /> {new Date(fields.reminder).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</em>}
    {fields.percentComplete !== undefined && <em>{fields.percentComplete}% done</em>}
    {fields.categories?.slice(0, 3).map((category) => <em key={category} className="task-category"><Tag size={11} /> {category}</em>)}
    {count > 0 && <em aria-label={`${count} attachment${count === 1 ? '' : 's'}`}><Paperclip size={12} /> {count}</em>}
  </>
}
