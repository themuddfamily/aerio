// RFC 5545 VTODO mapping (E45), shared by CalDAV task synchronization in the main process and by
// .ics task import/export. Reading maps the properties Aerio edits onto provider-neutral fields;
// writing patches only the properties whose mapped value changed, so every other property and
// parameter on the original component (X- properties, ATTACH, ORGANIZER, other alarms, ...) is kept.
import {
  allProperties, escapeText, firstProperty, foldLine, formatParam, paramValue, parseComponents, splitEscaped, unescapeText,
  type Component, type ContentLimits, type ContentLine
} from './content-lines'
import { buildVTimeZone, ICS_LIMITS } from './ics'
import { parseTaskStart } from './task-schedule'
import { localTimeZone, resolveTimeZoneName, wallTimeToUtc } from './time-zones'

export type VTodoStatus = 'notStarted' | 'inProgress' | 'completed' | 'cancelled'
export type VTodoPriority = 'low' | 'normal' | 'high'

/** The VTODO properties Aerio reads and edits, in task-field form. */
export interface VTodoFields {
  title: string
  notes?: string
  /** DUE: `YYYY-MM-DD`, a wall clock `YYYY-MM-DDTHH:mm:ss` read in `dueTimeZone` (absent: floating), or a UTC instant ending in `Z`. */
  due?: string
  dueTimeZone?: string
  /** DTSTART in the E44 start form: `YYYY-MM-DD` or a wall clock read in `startTimeZone`. */
  start?: string
  startTimeZone?: string
  completed: boolean
  status: VTodoStatus
  percentComplete?: number
  priority: VTodoPriority
  categories: string[]
  /** The first VALARM as an absolute UTC instant (relative triggers are resolved against DTSTART/DUE). */
  reminder?: string
  /** RELATED-TO with RELTYPE=PARENT (or no RELTYPE). */
  parentUid?: string
}

export interface VTodoLink { uri: string; name?: string; contentType?: string }
export interface VTodoInlineAttachment { name: string; size: number; contentType?: string }

export interface VTodoItem {
  uid: string
  /** The raw RECURRENCE-ID value of an overridden occurrence; absent on a series master or a single task. */
  recurrenceId?: string
  fields: VTodoFields
  /** The RRULE of a series master, as written by the source. */
  recurrence?: string
  /** RDATE/EXDATE present on a series master. */
  recurrenceDates: boolean
  links: VTodoLink[]
  inlineAttachments: VTodoInlineAttachment[]
  /** Unmapped property names kept unchanged on every write. */
  preserved: string[]
  /** DESCRIPTION longer than Aerio's 8,192-character note limit; notes are then read-only. */
  notesTruncated: boolean
  component: Component
  calendar: Component
}

export interface VTodoParseResult {
  calendars: Component[]
  items: VTodoItem[]
  calendarName?: string
  /** Components other than VTODO/VTIMEZONE (VEVENT, VJOURNAL, ...) found in the input. */
  otherComponents: string[]
  warnings: string[]
}

export const VTODO_NOTES_LIMIT = 8192
const TITLE_LIMIT = 1024
const CATEGORY_LIMIT = 50
const CATEGORY_LENGTH = 255
const URI_LIMIT = 2048
const MAPPED = new Set([
  'UID', 'DTSTAMP', 'CREATED', 'LAST-MODIFIED', 'SEQUENCE', 'SUMMARY', 'DESCRIPTION', 'DUE', 'DTSTART', 'COMPLETED', 'STATUS',
  'PERCENT-COMPLETE', 'PRIORITY', 'CATEGORIES', 'RRULE', 'RDATE', 'EXDATE', 'RECURRENCE-ID', 'ATTACH'
])
const DATE_VALUE = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/i
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const pad = (value: number, size = 2) => String(value).padStart(size, '0')
const utcCompact = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')

const textOf = (component: Component, name: string) => {
  const line = firstProperty(component, name)
  return line === undefined ? undefined : unescapeText(line.value)
}

interface Moment { value: string; zone?: string }

/** Reads DUE/DTSTART/RECURRENCE-ID into the task date form. Unknown TZIDs read as floating times. */
function readMoment(line: ContentLine | undefined): Moment | undefined {
  if (!line) return undefined
  const match = DATE_VALUE.exec(line.value.trim())
  if (!match) return undefined
  const day = `${match[1]}-${match[2]}-${match[3]}`
  if (!match[4] || paramValue(line, 'VALUE')?.toUpperCase() === 'DATE') return parseTaskStart(day) ? { value: day } : undefined
  const wall = `${day}T${match[4]}:${match[5]}:${match[6]}`
  if (!parseTaskStart(wall)) return undefined
  if (match[7]) return { value: `${wall}Z` }
  const zone = resolveTimeZoneName(paramValue(line, 'TZID'))
  return zone ? { value: wall, zone } : { value: wall }
}

/** The instant a task date names: dates at local midnight, floating times in this computer's zone. */
export function vtodoInstant(value: string | undefined, zone?: string): number | undefined {
  if (!value) return undefined
  if (/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? ms : undefined
  }
  const parsed = parseTaskStart(value)
  return parsed ? wallTimeToUtc(parsed.wall, resolveTimeZoneName(zone) ?? localTimeZone()) : undefined
}

function parseDuration(value: string) {
  const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(value.trim())
  if (!match || /^[+-]?PT?$/i.test(value.trim())) return undefined
  const [, sign, weeks, days, hours, minutes, seconds] = match
  const total = (((Number(weeks ?? 0) * 7 + Number(days ?? 0)) * 24 + Number(hours ?? 0)) * 60 + Number(minutes ?? 0)) * 60 + Number(seconds ?? 0)
  return (sign === '-' ? -total : total) * 1_000
}

function readReminder(component: Component, start?: Moment, due?: Moment) {
  for (const alarm of component.children.filter((child) => child.name === 'VALARM')) {
    const trigger = firstProperty(alarm, 'TRIGGER')
    if (!trigger) continue
    if (paramValue(trigger, 'VALUE')?.toUpperCase() === 'DATE-TIME') {
      const moment = readMoment({ ...trigger, params: {} })
      const ms = moment ? vtodoInstant(moment.value.endsWith('Z') ? moment.value : `${moment.value}Z`) : undefined
      if (ms !== undefined) return new Date(ms).toISOString()
      continue
    }
    const offset = parseDuration(trigger.value)
    if (offset === undefined) continue
    // RFC 5545: RELATED=END on a VTODO means DUE. A START trigger without DTSTART falls back to DUE.
    const anchor = paramValue(trigger, 'RELATED')?.toUpperCase() === 'END' ? due ?? start : start ?? due
    const base = anchor ? vtodoInstant(anchor.value, anchor.zone) : undefined
    if (base !== undefined) return new Date(base + offset).toISOString()
  }
  return undefined
}

export const priorityFromValue = (value: number | undefined): VTodoPriority => !value ? 'normal' : value < 5 ? 'high' : value === 5 ? 'normal' : 'low'
const PRIORITY_VALUE: Record<VTodoPriority, number> = { high: 1, normal: 5, low: 9 }
const STATUS_FROM: Record<string, VTodoStatus> = { 'NEEDS-ACTION': 'notStarted', 'IN-PROCESS': 'inProgress', COMPLETED: 'completed', CANCELLED: 'cancelled' }
const STATUS_TO: Record<VTodoStatus, string> = { notStarted: 'NEEDS-ACTION', inProgress: 'IN-PROCESS', completed: 'COMPLETED', cancelled: 'CANCELLED' }

/** Keeps the completion flag and STATUS consistent: completing sets COMPLETED, reopening clears it. */
export function normalizeVTodoStatus(fields: VTodoFields, previous?: VTodoStatus): VTodoFields {
  if (fields.completed && fields.status !== 'completed') return { ...fields, status: 'completed' }
  if (!fields.completed && fields.status === 'completed') return { ...fields, status: previous && previous !== 'completed' ? previous : 'notStarted' }
  return fields
}

function readCategories(component: Component) {
  const seen = new Set<string>()
  const values: string[] = []
  for (const line of allProperties(component, 'CATEGORIES')) {
    for (const part of splitEscaped(line.value, ',')) {
      const value = part.trim().slice(0, CATEGORY_LENGTH).trim()
      if (!value || seen.has(value.toLowerCase()) || values.length >= CATEGORY_LIMIT) continue
      seen.add(value.toLowerCase())
      values.push(value)
    }
  }
  return values
}

const isParentRelation = (line: ContentLine) => (paramValue(line, 'RELTYPE')?.toUpperCase() ?? 'PARENT') === 'PARENT'

function readItem(calendar: Component, component: Component): Omit<VTodoItem, 'uid'> & { uid?: string } {
  const start = readMoment(firstProperty(component, 'DTSTART'))
  const due = readMoment(firstProperty(component, 'DUE'))
  const statusText = textOf(component, 'STATUS')?.trim().toUpperCase()
  const status: VTodoStatus = statusText && STATUS_FROM[statusText] ? STATUS_FROM[statusText] : firstProperty(component, 'COMPLETED') ? 'completed' : 'notStarted'
  const percent = Number(textOf(component, 'PERCENT-COMPLETE')?.trim())
  const priority = Number(textOf(component, 'PRIORITY')?.trim())
  const description = textOf(component, 'DESCRIPTION')
  const reminder = readReminder(component, start, due)
  const parent = allProperties(component, 'RELATED-TO').find(isParentRelation)
  const parentUid = parent ? unescapeText(parent.value).trim().slice(0, 1_000) : ''
  const links: VTodoLink[] = []
  const inlineAttachments: VTodoInlineAttachment[] = []
  for (const line of allProperties(component, 'ATTACH')) {
    const name = paramValue(line, 'FILENAME') ?? paramValue(line, 'X-FILENAME') ?? paramValue(line, 'X-APPLE-FILENAME')
    const contentType = paramValue(line, 'FMTTYPE')
    if (paramValue(line, 'VALUE')?.toUpperCase() === 'BINARY' || paramValue(line, 'ENCODING')?.toUpperCase() === 'BASE64') {
      inlineAttachments.push({ name: (name || 'Embedded attachment').slice(0, 1_000), size: Math.floor(line.value.replace(/[\s=]/g, '').length * 3 / 4), ...(contentType ? { contentType: contentType.slice(0, 300) } : {}) })
    } else if (line.value.trim() && line.value.trim().length <= URI_LIMIT) {
      links.push({ uri: line.value.trim(), ...(name ? { name: name.slice(0, 1_000) } : {}), ...(contentType ? { contentType: contentType.slice(0, 300) } : {}) })
    }
  }
  const preserved = [...new Set(component.properties.filter((line) => !MAPPED.has(line.name) && !(line.name === 'RELATED-TO' && line === parent)).map((line) => line.name))]
  if (component.children.filter((child) => child.name === 'VALARM').length > 1) preserved.push('VALARM')
  const rule = textOf(component, 'RRULE')?.trim()
  const fields: VTodoFields = {
    title: (textOf(component, 'SUMMARY')?.trim() || 'Untitled task').slice(0, TITLE_LIMIT),
    ...(description ? { notes: description.slice(0, VTODO_NOTES_LIMIT) } : {}),
    ...(due ? { due: due.value, ...(due.zone ? { dueTimeZone: due.zone } : {}) } : {}),
    ...(start ? (start.value.endsWith('Z') ? { start: start.value.slice(0, -1), startTimeZone: 'UTC' } : { start: start.value, ...(start.zone ? { startTimeZone: start.zone } : {}) }) : {}),
    completed: status === 'completed',
    status,
    ...(Number.isInteger(percent) && percent >= 0 && percent <= 100 && textOf(component, 'PERCENT-COMPLETE') !== undefined ? { percentComplete: percent } : {}),
    priority: priorityFromValue(Number.isInteger(priority) && priority >= 0 && priority <= 9 ? priority : undefined),
    categories: readCategories(component),
    ...(reminder ? { reminder } : {}),
    ...(parentUid ? { parentUid } : {})
  }
  const recurrenceLine = firstProperty(component, 'RECURRENCE-ID')
  const uid = textOf(component, 'UID')?.trim().slice(0, 1_000)
  return {
    ...(uid ? { uid } : {}),
    ...(recurrenceLine ? { recurrenceId: recurrenceLine.value.trim().toUpperCase() } : {}),
    fields,
    ...(rule ? { recurrence: rule.slice(0, 1_000) } : {}),
    recurrenceDates: Boolean(firstProperty(component, 'RDATE') || firstProperty(component, 'EXDATE')),
    links, inlineAttachments, preserved,
    notesTruncated: (description?.length ?? 0) > VTODO_NOTES_LIMIT,
    component, calendar
  }
}

export interface VTodoParseOptions {
  limits?: ContentLimits
  /** Assigns a UID to VTODOs that have none (adding the UID property). Without it they are skipped. */
  uid?: () => string
}

/** Parses every VTODO in an iCalendar stream. VEVENTs and other components are counted, never read. */
export function parseVTodos(text: string, options: VTodoParseOptions = {}): VTodoParseResult {
  const { roots, warnings } = parseComponents(text, options.limits ?? ICS_LIMITS)
  const calendars = roots.filter((root) => root.name === 'VCALENDAR')
  if (!calendars.length) throw new Error('The file does not contain an iCalendar (VCALENDAR) object')
  const items: VTodoItem[] = []
  const others = new Set<string>()
  let missingUid = 0
  for (const calendar of calendars) {
    for (const child of calendar.children) {
      if (child.name === 'VTIMEZONE') continue
      if (child.name !== 'VTODO') { others.add(child.name); continue }
      const item = readItem(calendar, child)
      let uid = item.uid
      if (!uid) {
        if (!options.uid) { missingUid++; continue }
        uid = options.uid()
        child.properties.unshift({ name: 'UID', params: {}, value: escapeText(uid) })
      }
      items.push({ ...item, uid })
    }
  }
  if (missingUid) warnings.push(`${missingUid} task${missingUid === 1 ? ' without a UID was' : 's without a UID were'} skipped`)
  const name = calendars.map((calendar) => textOf(calendar, 'X-WR-CALNAME')?.trim()).find(Boolean)
  return { calendars, items, ...(name ? { calendarName: name.slice(0, 200) } : {}), otherComponents: [...others], warnings }
}

// --- Writing ----------------------------------------------------------------------------------

const formatLine = (line: ContentLine) =>
  `${line.group ? `${line.group}.` : ''}${line.name}${Object.entries(line.params).map(([name, values]) => formatParam(name, values)).join('')}:${line.value}`

function emitComponent(component: Component): string[] {
  return [`BEGIN:${component.name}`, ...component.properties.map(formatLine), ...component.children.flatMap(emitComponent), `END:${component.name}`]
}

/** Serializes components with folded CRLF lines. */
export const emitComponents = (roots: Component[]) => `${roots.flatMap(emitComponent).map(foldLine).join('\r\n')}\r\n`

const textLine = (name: string, value: string): ContentLine => ({ name, params: {}, value: escapeText(value) })

/** A DUE/DTSTART line for a task date; unknown zones write a floating time. */
function momentLine(name: string, value: string, zone: string | undefined): ContentLine | undefined {
  if (DATE_ONLY.test(value)) return { name, params: { VALUE: ['DATE'] }, value: value.replace(/-/g, '') }
  if (/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? { name, params: {}, value: utcCompact(ms) } : undefined
  }
  const parsed = parseTaskStart(value)
  if (!parsed) return undefined
  const { wall } = parsed
  const compact = `${pad(wall.year, 4)}${pad(wall.month)}${pad(wall.day)}T${pad(wall.hour)}${pad(wall.minute)}${pad(wall.second)}`
  const iana = resolveTimeZoneName(zone)
  if (iana === 'UTC' || iana === 'Etc/UTC' || zone === 'UTC') return { name, params: {}, value: `${compact}Z` }
  return iana ? { name, params: { TZID: [iana] }, value: compact } : { name, params: {}, value: compact }
}

/** Replaces every `name` property with `lines`, keeping the first one's position. */
function setProperty(component: Component, name: string, lines: ContentLine[]) {
  const index = component.properties.findIndex((line) => line.name === name)
  component.properties = component.properties.filter((line) => line.name !== name)
  component.properties.splice(index < 0 ? component.properties.length : Math.min(index, component.properties.length), 0, ...lines)
}

const sameList = (left: string[], right: string[]) => left.length === right.length && left.every((value, index) => value === right[index])

/**
 * Applies the changes between `before` and `after` to a VTODO in place. Properties whose mapped
 * value did not change are left exactly as they were, including their parameters.
 */
export function patchVTodo(component: Component, before: VTodoFields, after: VTodoFields, now = new Date()) {
  const changed: string[] = []
  if (before.title !== after.title) { setProperty(component, 'SUMMARY', [textLine('SUMMARY', after.title)]); changed.push('SUMMARY') }
  if ((before.notes ?? '') !== (after.notes ?? '')) { setProperty(component, 'DESCRIPTION', after.notes ? [textLine('DESCRIPTION', after.notes)] : []); changed.push('DESCRIPTION') }
  const timing = before.due !== after.due || (after.due && before.dueTimeZone !== after.dueTimeZone) || before.start !== after.start || (after.start && before.startTimeZone !== after.startTimeZone)
  if (before.due !== after.due || (after.due && before.dueTimeZone !== after.dueTimeZone)) {
    const line = after.due ? momentLine('DUE', after.due, after.dueTimeZone) : undefined
    setProperty(component, 'DUE', line ? [line] : [])
    // DUE and DURATION cannot both appear (RFC 5545 §3.6.2).
    if (line) setProperty(component, 'DURATION', [])
    changed.push('DUE')
  }
  if (before.start !== after.start || (after.start && before.startTimeZone !== after.startTimeZone)) {
    const line = after.start ? momentLine('DTSTART', after.start, after.startTimeZone) : undefined
    setProperty(component, 'DTSTART', line ? [line] : [])
    changed.push('DTSTART')
  }
  if (before.status !== after.status || before.completed !== after.completed) {
    setProperty(component, 'STATUS', [textLine('STATUS', STATUS_TO[after.status])])
    if (after.status === 'completed' && !firstProperty(component, 'COMPLETED')) setProperty(component, 'COMPLETED', [{ name: 'COMPLETED', params: {}, value: utcCompact(now.getTime()) }])
    if (after.status !== 'completed') setProperty(component, 'COMPLETED', [])
    changed.push('STATUS')
  }
  if (before.percentComplete !== after.percentComplete) {
    setProperty(component, 'PERCENT-COMPLETE', after.percentComplete === undefined ? [] : [{ name: 'PERCENT-COMPLETE', params: {}, value: String(after.percentComplete) }])
    changed.push('PERCENT-COMPLETE')
  }
  if (before.priority !== after.priority) {
    setProperty(component, 'PRIORITY', [{ name: 'PRIORITY', params: {}, value: String(PRIORITY_VALUE[after.priority]) }])
    changed.push('PRIORITY')
  }
  if (!sameList(before.categories, after.categories)) {
    setProperty(component, 'CATEGORIES', after.categories.length ? [{ name: 'CATEGORIES', params: {}, value: after.categories.map(escapeText).join(',') }] : [])
    changed.push('CATEGORIES')
  }
  if ((before.parentUid ?? '') !== (after.parentUid ?? '')) {
    const others = allProperties(component, 'RELATED-TO').filter((line) => !isParentRelation(line))
    setProperty(component, 'RELATED-TO', [...(after.parentUid ? [textLine('RELATED-TO', after.parentUid)] : []), ...others])
    changed.push('RELATED-TO')
  }
  if ((before.reminder ?? '') !== (after.reminder ?? '')) {
    const alarms = component.children.filter((child) => child.name === 'VALARM')
    if (!after.reminder) component.children = component.children.filter((child) => child.name !== 'VALARM')
    else {
      const trigger: ContentLine = { name: 'TRIGGER', params: { VALUE: ['DATE-TIME'] }, value: utcCompact(Date.parse(after.reminder)) }
      if (alarms.length) setProperty(alarms[0], 'TRIGGER', [trigger])
      else component.children.push({ name: 'VALARM', properties: [textLine('ACTION', 'DISPLAY'), textLine('DESCRIPTION', after.title || 'Task reminder'), trigger], children: [] })
    }
    changed.push('VALARM')
  }
  if (changed.length) {
    const stamp = utcCompact(now.getTime())
    setProperty(component, 'DTSTAMP', [{ name: 'DTSTAMP', params: {}, value: stamp }])
    if (firstProperty(component, 'LAST-MODIFIED')) setProperty(component, 'LAST-MODIFIED', [{ name: 'LAST-MODIFIED', params: {}, value: stamp }])
    const sequence = firstProperty(component, 'SEQUENCE')
    if (sequence && timing) setProperty(component, 'SEQUENCE', [{ ...sequence, value: String((Number(sequence.value) || 0) + 1) }])
  }
  return changed
}

const EMPTY: VTodoFields = { title: '', completed: false, status: 'notStarted', priority: 'normal', categories: [] }

/** A new VTODO with the given UID and fields. */
export function newVTodo(uid: string, fields: VTodoFields, now = new Date()): Component {
  const stamp = utcCompact(now.getTime())
  const component: Component = { name: 'VTODO', properties: [textLine('UID', uid), { name: 'DTSTAMP', params: {}, value: stamp }, { name: 'CREATED', params: {}, value: stamp }, { name: 'LAST-MODIFIED', params: {}, value: stamp }], children: [] }
  patchVTodo(component, EMPTY, fields, now)
  if (!firstProperty(component, 'STATUS')) component.properties.push(textLine('STATUS', STATUS_TO[fields.status]))
  return component
}

/** A VCALENDAR container with Aerio's PRODID. */
export function newCalendar(children: Component[], name?: string): Component {
  return {
    name: 'VCALENDAR',
    properties: [textLine('VERSION', '2.0'), { name: 'PRODID', params: {}, value: '-//Aerio//Tasks//EN' }, textLine('CALSCALE', 'GREGORIAN'), ...(name ? [textLine('X-WR-CALNAME', name)] : [])],
    children
  }
}

const zoneReferences = (component: Component) => component.properties.flatMap((line) => line.params.TZID ?? [])

/** Adds a VTIMEZONE for every IANA TZID the calendar's tasks use but do not define. */
export function ensureTimeZones(calendar: Component) {
  const defined = new Set(calendar.children.filter((child) => child.name === 'VTIMEZONE').map((child) => textOf(child, 'TZID')))
  const added: Component[] = []
  for (const tzid of new Set(calendar.children.filter((child) => child.name !== 'VTIMEZONE').flatMap(zoneReferences))) {
    if (defined.has(tzid) || resolveTimeZoneName(tzid) !== tzid) continue
    const zone = parseComponents(buildVTimeZone(tzid, new Date().getUTCFullYear()).join('\r\n'), ICS_LIMITS).roots[0]
    if (zone) { added.push(zone); defined.add(tzid) }
  }
  calendar.children.unshift(...added)
}

/** A standalone VCALENDAR holding `components` and the VTIMEZONEs they reference from `calendar`. */
export function standaloneCalendar(calendar: Component, components: Component[]): Component {
  const references = new Set(components.flatMap(zoneReferences))
  const zones = calendar.children.filter((child) => child.name === 'VTIMEZONE' && references.has(textOf(child, 'TZID') ?? ''))
  const properties = calendar.properties.filter((line) => line.name !== 'METHOD' && line.name !== 'X-WR-CALNAME')
  return { name: 'VCALENDAR', properties: properties.length ? properties : newCalendar([]).properties, children: [...zones.map((zone) => structuredClone(zone)), ...components.map((component) => structuredClone(component))] }
}

/** Sets the UID of every component in a calendar (used to import a task as a copy). */
export function replaceUid(calendar: Component, uid: string) {
  for (const child of calendar.children) if (child.name === 'VTODO') setProperty(child, 'UID', [textLine('UID', uid)])
}

/** Removes one overridden occurrence and adds an EXDATE for it to the series master. */
export function removeOccurrence(calendar: Component, uid: string, recurrenceId: string) {
  const todos = calendar.children.filter((child) => child.name === 'VTODO' && textOf(child, 'UID')?.trim() === uid)
  const override = todos.find((child) => firstProperty(child, 'RECURRENCE-ID')?.value.trim().toUpperCase() === recurrenceId)
  const master = todos.find((child) => !firstProperty(child, 'RECURRENCE-ID'))
  if (!override) return false
  if (master && firstProperty(master, 'RRULE')) master.properties.push({ ...firstProperty(override, 'RECURRENCE-ID')!, name: 'EXDATE' })
  calendar.children = calendar.children.filter((child) => child !== override)
  return true
}

/** Maps a simple RRULE (daily/weekly/monthly, interval 1) to a local task repeat. */
export function simpleTaskRepeat(rule: string | undefined): 'daily' | 'weekly' | 'monthly' | undefined {
  if (!rule) return undefined
  const parts = Object.fromEntries(rule.split(';').map((part) => part.split('=')).map(([key, value]) => [key?.trim().toUpperCase(), value?.trim().toUpperCase()]))
  if (Object.keys(parts).some((key) => !['FREQ', 'INTERVAL', 'WKST'].includes(key)) || (parts.INTERVAL && parts.INTERVAL !== '1')) return undefined
  return parts.FREQ === 'DAILY' ? 'daily' : parts.FREQ === 'WEEKLY' ? 'weekly' : parts.FREQ === 'MONTHLY' ? 'monthly' : undefined
}

/** Sets or removes the RRULE of a series master. */
export function setRecurrenceRule(component: Component, rule: string | undefined) {
  setProperty(component, 'RRULE', rule ? [{ name: 'RRULE', params: {}, value: rule }] : [])
}

const DAYS: Record<string, string> = { MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday', FR: 'Friday', SA: 'Saturday', SU: 'Sunday' }
/** A short description of an RRULE, such as "Repeats weekly on Monday, until 2026-12-31". */
export function describeRecurrenceRule(rule: string) {
  const parts = Object.fromEntries(rule.split(';').map((part) => part.split('=')).map(([key, value]) => [key?.trim().toUpperCase(), value?.trim() ?? '']))
  const frequency = (parts.FREQ ?? '').toLowerCase()
  const interval = Number(parts.INTERVAL || 1)
  const unit: Record<string, string> = { daily: 'days', weekly: 'weeks', monthly: 'months', yearly: 'years', hourly: 'hours', minutely: 'minutes', secondly: 'seconds' }
  const days = parts.BYDAY ? parts.BYDAY.split(',').map((day) => { const match = /^([+-]?\d+)?([A-Z]{2})$/i.exec(day); return match ? `${match[1] ? `${match[1]} ` : ''}${DAYS[match[2].toUpperCase()] ?? match[2]}` : day }).join(', ') : ''
  const until = parts.UNTIL ? /^(\d{4})(\d{2})(\d{2})/.exec(parts.UNTIL) : undefined
  return [
    interval > 1 && unit[frequency] ? `Repeats every ${interval} ${unit[frequency]}` : `Repeats ${frequency || 'on a custom schedule'}`,
    days ? ` on ${days}` : '', parts.BYMONTHDAY ? ` on day ${parts.BYMONTHDAY}` : '',
    parts.COUNT ? `, ${parts.COUNT} times` : '', until ? `, until ${until[1]}-${until[2]}-${until[3]}` : ''
  ].join('')
}
