import type { TaskEntity } from '../../src/task-provider-types'

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

// Calendar arithmetic is deterministic in UTC. Google dates stay date-only;
// time details remain a local overlay and never enter Google's due field.
export function recurringTaskFields(task: TaskEntity, now: number) {
  const base = task.fields.due ?? task.local.timedDue ?? new Date(now).toISOString()
  const next = advance(base, task.local.recurrence)
  return {
    fields: { ...task.fields, completed: false, due: task.provider === 'gmail' ? next.slice(0, 10) : next },
    local: { ...task.local, timedDue: task.local.timedDue ? advance(task.local.timedDue, task.local.recurrence) : undefined }
  }
}
