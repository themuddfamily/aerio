import type { TaskNativeFields, TaskNativeRecurrence } from '../../src/task-provider-types'
import { CALDAV_SOURCE_LIMIT, type CalDavTaskInfo } from '../../src/caldav-task-types'
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
  if (!keys(value, ['priority', 'recurrence', 'dueTimeZone', 'status', 'body', 'start', 'startTimeZone', 'reminder', 'categories', 'attachments', 'percentComplete', 'caldav'])) return false
  // CalDAV PERCENT-COMPLETE and read-only VTODO metadata (E45).
  if (value.percentComplete !== undefined && value.percentComplete !== null && !integer(value.percentComplete, 0, 100)) return false
  if (value.caldav !== undefined && !validCalDavTaskInfo(value.caldav)) return false
  // Extended Microsoft fields (E44). Start is a wall clock read in startTimeZone; reminder is a UTC instant.
  if (value.start !== undefined && value.start !== null && (!parseTaskStart(value.start) || (value.start as string).length > 19)) return false
  if (value.startTimeZone !== undefined && (typeof value.startTimeZone !== 'string' || !value.startTimeZone.trim() || value.startTimeZone.length > 200)) return false
  if (value.reminder !== undefined && value.reminder !== null && !validTaskReminder(value.reminder)) return false
  if (value.categories !== undefined && !validTaskCategories(value.categories)) return false
  if (value.attachments !== undefined && !validTaskNativeAttachments(value.attachments)) return false
  if (value.priority !== undefined && !['low', 'normal', 'high'].includes(value.priority)) return false
  if (value.recurrence !== undefined && value.recurrence !== null && !validTaskRecurrence(value.recurrence)) return false
  if (value.dueTimeZone !== undefined && (typeof value.dueTimeZone !== 'string' || !value.dueTimeZone.trim() || value.dueTimeZone.length > 200)) return false
  if (value.status !== undefined && !['notStarted', 'inProgress', 'completed', 'waitingOnOthers', 'deferred', 'cancelled'].includes(value.status)) return false
  return value.body === undefined || (keys(value.body, ['contentType', 'content']) && ['text', 'html'].includes(value.body.contentType) && typeof value.body.content === 'string' && value.body.content.length <= 1_000_000)
}

export function validTaskNativeAttachments(value: unknown) {
  return Array.isArray(value) && value.length <= 1_000 && new Set(value.map((item) => item?.id)).size === value.length && value.every((item) =>
    keys(item, ['id', 'name', 'size', 'contentType']) && typeof item.id === 'string' && Boolean(item.id) && item.id.length <= 2048 &&
    typeof item.name === 'string' && Boolean(item.name.trim()) && item.name.length <= 1_000 && integer(item.size, 0, Number.MAX_SAFE_INTEGER) &&
    (item.contentType === undefined || (typeof item.contentType === 'string' && item.contentType.length <= 300)))
}

const shortText = (value: unknown, max: number) => typeof value === 'string' && value.length <= max
const optional = (value: unknown, max: number) => value === undefined || shortText(value, max)
/** CalDAV VTODO metadata (E45): bounded, and never more than the fields the connector produces. */
export function validCalDavTaskInfo(value: unknown): value is CalDavTaskInfo {
  if (!keys(value, ['uid', 'recurrenceId', 'recurrence', 'recurrenceNote', 'links', 'inlineAttachments', 'preserved', 'notesTruncated', 'readOnlyReason', 'source'])) return false
  if (!shortText(value.uid, 1_000) || !value.uid.trim() || !optional(value.recurrenceId, 200) || !optional(value.recurrence, 1_000) || !optional(value.recurrenceNote, 1_000) || !optional(value.readOnlyReason, 1_000) || !optional(value.source, CALDAV_SOURCE_LIMIT)) return false
  if (value.notesTruncated !== undefined && typeof value.notesTruncated !== 'boolean') return false
  if (value.preserved !== undefined && (!Array.isArray(value.preserved) || value.preserved.length > 500 || !value.preserved.every((name: unknown) => shortText(name, 200)))) return false
  if (value.links !== undefined && (!Array.isArray(value.links) || value.links.length > 500 || !value.links.every((link: unknown) => keys(link, ['uri', 'name', 'contentType']) && shortText(link.uri, 2048) && optional(link.name, 1_000) && optional(link.contentType, 300)))) return false
  return value.inlineAttachments === undefined || (Array.isArray(value.inlineAttachments) && value.inlineAttachments.length <= 500 && value.inlineAttachments.every((item: unknown) => keys(item, ['name', 'size', 'contentType']) && shortText(item.name, 1_000) && integer(item.size, 0, Number.MAX_SAFE_INTEGER) && optional(item.contentType, 300)))
}
