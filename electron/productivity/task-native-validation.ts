import type { TaskNativeFields, TaskNativeRecurrence } from '../../src/task-provider-types'
import { parseTaskStart, validTaskCategories, validTaskReminder } from '../../src/lib/task-schedule'

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const keys = (value: unknown, allowed: string[]): value is Record<string, any> => record(value) && Object.keys(value).every((key) => allowed.includes(key))
const integer = (value: unknown, min: number, max: number) => Number.isInteger(value) && Number(value) >= min && Number(value) <= max
const day = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
export function validTaskRecurrence(value: unknown): value is TaskNativeRecurrence {
  if (!keys(value, ['pattern', 'range']) || !keys(value.pattern, ['type', 'interval', 'dayOfMonth', 'daysOfWeek', 'firstDayOfWeek', 'index', 'month']) || !keys(value.range, ['type', 'startDate', 'endDate', 'numberOfOccurrences', 'recurrenceTimeZone'])) return false
  const { pattern, range } = value
  if (!['daily', 'weekly', 'absoluteMonthly', 'relativeMonthly', 'absoluteYearly', 'relativeYearly'].includes(pattern.type) || !integer(pattern.interval, 1, 2_147_483_647)) return false
  // Graph includes zero/empty defaults for fields unused by the pattern type.
  if (pattern.dayOfMonth !== undefined && !integer(pattern.dayOfMonth, 0, 31)) return false
  if (pattern.month !== undefined && !integer(pattern.month, 0, 12)) return false
  if (pattern.daysOfWeek !== undefined && (!Array.isArray(pattern.daysOfWeek) || pattern.daysOfWeek.length > 7 || new Set(pattern.daysOfWeek).size !== pattern.daysOfWeek.length || pattern.daysOfWeek.some((day: unknown) => !weekdays.includes(day as string)))) return false
  if (pattern.firstDayOfWeek !== undefined && !weekdays.includes(pattern.firstDayOfWeek)) return false
  if (pattern.index !== undefined && !['first', 'second', 'third', 'fourth', 'last'].includes(pattern.index)) return false
  if (['absoluteMonthly', 'absoluteYearly'].includes(pattern.type) && !integer(pattern.dayOfMonth, 1, 31)) return false
  if (['weekly', 'relativeMonthly', 'relativeYearly'].includes(pattern.type) && !pattern.daysOfWeek?.length) return false
  if (['relativeMonthly', 'relativeYearly'].includes(pattern.type) && pattern.index === undefined) return false
  if (pattern.type === 'weekly' && pattern.firstDayOfWeek === undefined) return false
  if (['absoluteYearly', 'relativeYearly'].includes(pattern.type) && !integer(pattern.month, 1, 12)) return false
  if (!['endDate', 'noEnd', 'numbered'].includes(range.type) || !day(range.startDate)) return false
  if (range.endDate !== undefined && !day(range.endDate)) return false
  if (range.type === 'endDate' && (!day(range.endDate) || range.endDate < range.startDate)) return false
  if (range.numberOfOccurrences !== undefined && !integer(range.numberOfOccurrences, 0, 2_147_483_647)) return false
  if (range.recurrenceTimeZone !== undefined && (typeof range.recurrenceTimeZone !== 'string' || !range.recurrenceTimeZone.trim() || range.recurrenceTimeZone.length > 200)) return false
  return range.type !== 'numbered' || integer(range.numberOfOccurrences, 1, 2_147_483_647)
}
export function validTaskNativeFields(value: unknown): value is TaskNativeFields {
  if (!keys(value, ['priority', 'recurrence', 'dueTimeZone', 'status', 'body', 'start', 'startTimeZone', 'reminder', 'categories', 'attachments'])) return false
  // Extended Microsoft fields (E44). Start is a wall clock read in startTimeZone; reminder is a UTC instant.
  if (value.start !== undefined && value.start !== null && (!parseTaskStart(value.start) || (value.start as string).length > 19)) return false
  if (value.startTimeZone !== undefined && (typeof value.startTimeZone !== 'string' || !value.startTimeZone.trim() || value.startTimeZone.length > 200)) return false
  if (value.reminder !== undefined && value.reminder !== null && !validTaskReminder(value.reminder)) return false
  if (value.categories !== undefined && !validTaskCategories(value.categories)) return false
  if (value.attachments !== undefined && !validTaskNativeAttachments(value.attachments)) return false
  if (value.priority !== undefined && !['low', 'normal', 'high'].includes(value.priority)) return false
  if (value.recurrence !== undefined && value.recurrence !== null && !validTaskRecurrence(value.recurrence)) return false
  if (value.dueTimeZone !== undefined && (typeof value.dueTimeZone !== 'string' || !value.dueTimeZone.trim() || value.dueTimeZone.length > 200)) return false
  if (value.status !== undefined && !['notStarted', 'inProgress', 'completed', 'waitingOnOthers', 'deferred'].includes(value.status)) return false
  return value.body === undefined || (keys(value.body, ['contentType', 'content']) && ['text', 'html'].includes(value.body.contentType) && typeof value.body.content === 'string' && value.body.content.length <= 1_000_000)
}

export function validTaskNativeAttachments(value: unknown) {
  return Array.isArray(value) && value.length <= 1_000 && new Set(value.map((item) => item?.id)).size === value.length && value.every((item) =>
    keys(item, ['id', 'name', 'size', 'contentType']) && typeof item.id === 'string' && Boolean(item.id) && item.id.length <= 2048 &&
    typeof item.name === 'string' && Boolean(item.name.trim()) && item.name.length <= 1_000 && integer(item.size, 0, Number.MAX_SAFE_INTEGER) &&
    (item.contentType === undefined || (typeof item.contentType === 'string' && item.contentType.length <= 300)))
}
