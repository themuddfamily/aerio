import type { TaskEntity } from '../../src/task-provider-types'
import { advanceExtendedFields, taskStartInstant } from '../../src/lib/task-schedule'

function advance(value: string, recurrence: TaskEntity['local']['recurrence']) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid recurrence date')
  if (recurrence === 'monthly') {
    const day = date.getUTCDate()
    date.setUTCDate(1)
    date.setUTCMonth(date.getUTCMonth() + 1)
    const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()
    date.setUTCDate(Math.min(day, last))
  } else date.setUTCDate(date.getUTCDate() + (recurrence === 'weekly' ? 7 : 1))
  return date.toISOString()
}

// The instant a due value anchors a reminder: a timed due as given, a Google date at local midnight.
const dueAnchor = (value: string | undefined, zone?: string) => !value ? undefined : /^\d{4}-\d{2}-\d{2}$/.test(value) ? taskStartInstant(value, zone) : Date.parse(value)

// Calendar arithmetic is deterministic in UTC. Google dates stay date-only;
// time details remain a local overlay and never enter Google's due field.
export function recurringTaskFields(task: TaskEntity, now: number) {
  const base = task.fields.due ?? task.local.timedDue ?? new Date(now).toISOString()
  const next = advance(base, task.local.recurrence)
  const due = task.provider === 'gmail' ? next.slice(0, 10) : next
  const timedDue = task.local.timedDue ? advance(task.local.timedDue, task.local.recurrence) : undefined
  const local = { ...task.local, timedDue }
  // Local-only start/reminder/progress fields (E44) follow the occurrence. A reminder keeps its
  // wall-clock offset from the timed or dated due value, or from the start when there is no due.
  if (task.local.extended && task.local.recurrence !== 'none') {
    const zone = task.local.extended.startTimeZone
    const anchor = dueAnchor(task.local.timedDue ?? task.fields.due, zone)
    const nextAnchor = dueAnchor(timedDue ?? (task.fields.due ? due : undefined), zone)
    local.extended = advanceExtendedFields(task.local.extended, { repeat: task.local.recurrence, anchor, nextAnchor: anchor === undefined ? undefined : nextAnchor, zone })
  }
  if (!timedDue) delete local.timedDue
  return { fields: { ...task.fields, completed: false, due }, local }
}
