// Provider-neutral task start/reminder arithmetic and validation (E44), shared by the renderer and the
// main process. Starts are wall-clock values read in a named zone; reminders are absolute instants.
import type { Attachment } from '../types'
import type { TaskExtendedFieldName, TaskExtendedFields } from '../task-fields-types'
import { localTimeZone, resolveTimeZoneName, wallTimeInZone, wallTimeMs, wallTimeToUtc, type WallTime } from './time-zones'

export type TaskRepeat = 'daily' | 'weekly' | 'monthly'

export const TASK_CATEGORY_LIMIT = 50
export const TASK_CATEGORY_MAX_LENGTH = 255
export const TASK_ATTACHMENT_LIMIT = 50
export const TASK_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024

const START = /^(\d{4})-(\d{2})-(\d{2})(?:T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,7})?)?)?$/
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/
const pad = (value: number, length = 2) => String(value).padStart(length, '0')
const fromMs = (ms: number): WallTime => {
  const date = new Date(ms)
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: date.getUTCHours(), minute: date.getUTCMinutes(), second: date.getUTCSeconds() }
}

export function parseTaskStart(value: unknown): { wall: WallTime; dateOnly: boolean } | undefined {
  if (typeof value !== 'string' || value.length > 40) return undefined
  const match = START.exec(value)
  if (!match) return undefined
  const wall: WallTime = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), hour: Number(match[4] ?? 0), minute: Number(match[5] ?? 0), second: Number(match[6] ?? 0) }
  const check = fromMs(wallTimeMs(wall))
  if (check.year !== wall.year || check.month !== wall.month || check.day !== wall.day) return undefined
  return { wall, dateOnly: match[4] === undefined }
}

export function formatTaskStart(wall: WallTime, dateOnly: boolean) {
  const day = `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}`
  return dateOnly ? day : `${day}T${pad(wall.hour)}:${pad(wall.minute)}:${pad(wall.second)}`
}

/** IANA or Windows zone names resolve to IANA; anything else falls back to this computer's zone. */
export const taskZone = (zone?: string) => resolveTimeZoneName(zone) ?? localTimeZone()

/** The instant a start begins. All-day starts begin at midnight in the zone. */
export function taskStartInstant(start: string | undefined, zone?: string): number | undefined {
  const parsed = parseTaskStart(start)
  return parsed ? wallTimeToUtc(parsed.wall, taskZone(zone)) : undefined
}

/** Calendar arithmetic on wall-clock fields: monthly steps clamp to the last day of the month. */
export function addRepeat(wall: WallTime, repeat: TaskRepeat): WallTime {
  if (repeat === 'monthly') {
    const month = wall.month === 12 ? 1 : wall.month + 1
    const year = wall.month === 12 ? wall.year + 1 : wall.year
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
    return { ...wall, year, month, day: Math.min(wall.day, last) }
  }
  return fromMs(wallTimeMs(wall) + (repeat === 'weekly' ? 7 : 1) * 86_400_000)
}

export function advanceTaskStart(start: string, repeat: TaskRepeat) {
  const parsed = parseTaskStart(start)
  if (!parsed) throw new Error('Invalid task start')
  return formatTaskStart(addRepeat(parsed.wall, repeat), parsed.dateOnly)
}

/**
 * The next occurrence's reminder. With anchors (the old and new due or start instants), the reminder
 * keeps its wall-clock distance from the anchor in `zone`, so "15 minutes before 09:00" stays 08:45
 * across a daylight-saving change. Without anchors the reminder's own wall-clock time advances.
 */
export function nextTaskReminder(input: { reminder: string; repeat: TaskRepeat; anchor?: number; nextAnchor?: number; zone?: string }) {
  const zone = taskZone(input.zone)
  const reminder = Date.parse(input.reminder)
  if (!Number.isFinite(reminder)) throw new Error('Invalid task reminder')
  if (input.anchor !== undefined && input.nextAnchor !== undefined && Number.isFinite(input.anchor) && Number.isFinite(input.nextAnchor)) {
    const offset = wallTimeMs(wallTimeInZone(input.anchor, zone)) - wallTimeMs(wallTimeInZone(reminder, zone))
    return new Date(wallTimeToUtc(fromMs(wallTimeMs(wallTimeInZone(input.nextAnchor, zone)) - offset), zone)).toISOString()
  }
  return new Date(wallTimeToUtc(addRepeat(wallTimeInZone(reminder, zone), input.repeat), zone)).toISOString()
}

/**
 * Carries extended fields to a recurring task's next occurrence: the start advances by one step, the
 * reminder keeps its offset, progress resets, and tags and attachments stay.
 */
export function advanceExtendedFields(fields: TaskExtendedFields | undefined, input: { repeat: TaskRepeat; anchor?: number; nextAnchor?: number; zone?: string }): TaskExtendedFields | undefined {
  if (!fields) return undefined
  const next: TaskExtendedFields = { ...fields }
  if (fields.categories) next.categories = [...fields.categories]
  if (fields.attachments) next.attachments = fields.attachments.map((attachment) => ({ ...attachment }))
  if (fields.start) next.start = advanceTaskStart(fields.start, input.repeat)
  if (fields.percentComplete !== undefined) next.percentComplete = 0
  if (fields.reminder) {
    const startZone = fields.startTimeZone ?? input.zone
    const anchors = input.anchor !== undefined && input.nextAnchor !== undefined
      ? { anchor: input.anchor, nextAnchor: input.nextAnchor, zone: input.zone }
      : fields.start ? { anchor: taskStartInstant(fields.start, startZone), nextAnchor: taskStartInstant(next.start, startZone), zone: startZone } : { zone: startZone }
    next.reminder = nextTaskReminder({ reminder: fields.reminder, repeat: input.repeat, ...anchors })
  }
  return next
}

/** Drops empty values so unchanged tasks keep their original shape. */
export function compactExtendedFields(fields: TaskExtendedFields | undefined): TaskExtendedFields | undefined {
  if (!fields) return undefined
  const value: TaskExtendedFields = {}
  if (fields.start) {
    value.start = fields.start
    if (fields.startTimeZone && !parseTaskStart(fields.start)?.dateOnly) value.startTimeZone = fields.startTimeZone
  }
  if (fields.reminder) value.reminder = fields.reminder
  if (fields.percentComplete !== undefined && Number.isFinite(fields.percentComplete)) value.percentComplete = fields.percentComplete
  if (fields.categories?.length) value.categories = fields.categories
  if (fields.attachments?.length) value.attachments = fields.attachments
  return Object.keys(value).length ? value : undefined
}

/** Comma-separated tag input: trimmed, nonempty, unique ignoring case, first spelling kept. */
export function parseCategories(input: string) {
  const seen = new Set<string>()
  return input.split(',').map((value) => value.trim()).filter((value) => {
    const key = value.toLowerCase()
    if (!value || seen.has(key)) return false
    seen.add(key)
    return true
  }).map((value) => value.slice(0, TASK_CATEGORY_MAX_LENGTH)).slice(0, TASK_CATEGORY_LIMIT)
}

const text = (value: unknown, max: number, required = false) => typeof value === 'string' && value.length <= max && (!required || Boolean(value.trim()))

export function validTaskAttachment(value: unknown, path: (path: string) => boolean = () => true): value is Attachment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const attachment = value as Attachment
  return Object.keys(attachment).every((key) => ['id', 'name', 'size', 'path', 'mime'].includes(key)) && text(attachment.id, 300, true) && text(attachment.name, 1_000, true) &&
    Number.isSafeInteger(attachment.size) && attachment.size >= 0 && attachment.size <= TASK_ATTACHMENT_MAX_BYTES &&
    text(attachment.path, 32_767, true) && path(attachment.path!) && (attachment.mime === undefined || text(attachment.mime, 300))
}

const EXTENDED_KEYS: Record<string, TaskExtendedFieldName> = { start: 'start', startTimeZone: 'start', reminder: 'reminder', percentComplete: 'percentComplete', categories: 'categories', attachments: 'attachments' }

export function validTaskReminder(value: unknown): value is string {
  return typeof value === 'string' && UTC_INSTANT.test(value) && Number.isFinite(Date.parse(value))
}

export function validTaskCategories(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= TASK_CATEGORY_LIMIT && value.every((item) => text(item, TASK_CATEGORY_MAX_LENGTH, true) && item === item.trim()) &&
    new Set(value.map((item: string) => item.toLowerCase())).size === value.length
}

export function validTaskStartTimeZone(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 100 && Boolean(resolveTimeZoneName(value))
}

/** Validates extended fields, optionally limited to the fields a source may keep locally. */
export function validTaskExtendedFields(value: unknown, options: { allowed?: TaskExtendedFieldName[]; attachmentPath?: (path: string) => boolean } = {}): value is TaskExtendedFields {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const fields = value as Record<string, unknown>
  for (const key of Object.keys(fields)) {
    const group = EXTENDED_KEYS[key]
    if (!group || (options.allowed && !options.allowed.includes(group))) return false
  }
  if (fields.start !== undefined && !parseTaskStart(fields.start)) return false
  if (fields.startTimeZone !== undefined && !validTaskStartTimeZone(fields.startTimeZone)) return false
  if (fields.reminder !== undefined && !validTaskReminder(fields.reminder)) return false
  if (fields.percentComplete !== undefined && !(Number.isInteger(fields.percentComplete) && Number(fields.percentComplete) >= 0 && Number(fields.percentComplete) <= 100)) return false
  if (fields.categories !== undefined && !validTaskCategories(fields.categories)) return false
  if (fields.attachments !== undefined) {
    const attachments = fields.attachments
    if (!Array.isArray(attachments) || attachments.length > TASK_ATTACHMENT_LIMIT || new Set(attachments.map((item) => (item as Attachment)?.id)).size !== attachments.length) return false
    if (!attachments.every((item) => validTaskAttachment(item, options.attachmentPath))) return false
  }
  return true
}

/** The extended fields of a local Task record. */
export const localTaskExtendedFields = (task: TaskExtendedFields): TaskExtendedFields => {
  const value: TaskExtendedFields = {}
  for (const key of ['start', 'startTimeZone', 'reminder', 'percentComplete', 'categories', 'attachments'] as const) {
    if (task[key] !== undefined) (value as Record<string, unknown>)[key] = task[key]
  }
  return value
}

/** `yyyy-MM-ddTHH:mm` for a datetime-local input showing an instant in this computer's zone. */
export function instantInputValue(iso: string | undefined) {
  const ms = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(ms)) return ''
  const date = new Date(ms)
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** The instant a datetime-local value names in this computer's zone (DST gaps move forward). */
export function instantFromInput(value: string) {
  const parsed = parseTaskStart(value)
  if (!parsed || parsed.dateOnly) return undefined
  return new Date(wallTimeToUtc(parsed.wall, localTimeZone())).toISOString()
}

/** Human-readable start such as "12 Oct 2026" or "12 Oct 2026, 09:30 (Europe/London)". */
export function describeTaskStart(start: string | undefined, zone?: string) {
  const parsed = parseTaskStart(start)
  if (!parsed) return ''
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const day = `${parsed.wall.day} ${months[parsed.wall.month - 1]} ${parsed.wall.year}`
  return parsed.dateOnly ? day : `${day}, ${pad(parsed.wall.hour)}:${pad(parsed.wall.minute)}${zone ? ` (${zone})` : ''}`
}
