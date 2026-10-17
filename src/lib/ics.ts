// Dependency-free RFC 5545 iCalendar parser and serializer for calendar import, export, and
// read-only internet subscriptions. Parsing is bounded by ContentLimits; serialization folds lines.
import type { CalendarEvent } from '../types'
import {
  allProperties, escapeText, firstProperty, foldLine, formatParam, InterchangeFormatError, paramValue,
  parseComponents, unescapeText, type Component, type ContentLimits, type ContentLine
} from './content-lines'
import { isIanaTimeZone, resolveTimeZoneName, timeZoneOffsetMinutes, wallTimeInZone, wallTimeMs, wallTimeToUtc, type WallTime } from './time-zones'

export { InterchangeFormatError } from './content-lines'

export const ICS_LIMITS: ContentLimits = {
  maxChars: 20 * 1024 * 1024,
  maxLines: 1_000_000,
  maxLineLength: 256 * 1024,
  maxComponents: 50_000,
  maxPropertiesPerComponent: 2_000,
  maxDepth: 6
}
export const ICS_MAX_EVENTS = 20_000
const MAX_TEXT = 100_000
const MAX_ATTENDEES = 1_000

export interface IcsEvent {
  uid?: string
  recurrenceId?: string
  title: string
  description?: string
  location?: string
  start: string
  end: string
  allDay: boolean
  timeZone?: string
  recurrenceRule?: string
  recurrenceExceptions: string[]
  attendees: string[]
  reminderMinutes?: number
}

export interface IcsParseResult {
  calendarName?: string
  timeZone?: string
  events: IcsEvent[]
  warnings: string[]
}

type DateValue = { kind: 'date'; date: string } | { kind: 'datetime'; utcMs: number; timeZone?: string }

interface Observance {
  offsetFrom: number
  offsetTo: number
  start: number
  rule?: { month: number; weekday: number; ordinal?: number; monthDays?: number[]; until?: number }
  dates: number[]
}

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
const RRULE_KEYS = new Set(['FREQ', 'UNTIL', 'COUNT', 'INTERVAL', 'BYSECOND', 'BYMINUTE', 'BYHOUR', 'BYDAY', 'BYMONTHDAY', 'BYYEARDAY', 'BYWEEKNO', 'BYMONTH', 'BYSETPOS', 'WKST', 'RSCALE', 'SKIP'])
const FREQUENCIES = new Set(['SECONDLY', 'MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'])

const pad = (value: number, size = 2) => String(value).padStart(size, '0')
const isoDate = (year: number, month: number, day: number) => `${pad(year, 4)}-${pad(month)}-${pad(day)}`
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

function validWall(wall: WallTime) {
  const value = new Date(wallTimeMs(wall))
  return wall.year >= 1 && wall.year <= 9999 && value.getUTCFullYear() === wall.year && value.getUTCMonth() + 1 === wall.month &&
    value.getUTCDate() === wall.day && wall.hour < 24 && wall.minute < 60 && wall.second <= 60
}

function parseWall(value: string): { wall: WallTime; utc: boolean; dateOnly: boolean } | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/i.exec(value.trim())
  if (!match) return undefined
  const wall = {
    year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
    hour: Number(match[4] ?? 0), minute: Number(match[5] ?? 0), second: Math.min(59, Number(match[6] ?? 0))
  }
  if (!validWall(wall)) return undefined
  return { wall, utc: Boolean(match[7]), dateOnly: match[4] === undefined }
}

function parseUtcOffset(value: string | undefined) {
  const match = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(value?.trim() ?? '')
  if (!match) return undefined
  const minutes = Number(match[2]) * 60 + Number(match[3])
  return minutes > 24 * 60 ? undefined : (match[1] === '-' ? -minutes : minutes)
}

function parseDuration(value: string | undefined) {
  const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(value?.trim() ?? '')
  if (!match || value!.trim().replace(/^[+-]/, '').toUpperCase() === 'P' || /T$/i.test(value!.trim())) return undefined
  const [, sign, weeks, days, hours, minutes, seconds] = match
  const total = (((Number(weeks ?? 0) * 7 + Number(days ?? 0)) * 24 + Number(hours ?? 0)) * 60 + Number(minutes ?? 0)) * 60 + Number(seconds ?? 0)
  return (sign === '-' ? -total : total) * 1_000
}

function nthWeekday(year: number, month: number, weekday: number, ordinal: number) {
  if (ordinal > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay()
    return 1 + ((weekday - first + 7) % 7) + (ordinal - 1) * 7
  }
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const last = new Date(Date.UTC(year, month - 1, lastDay)).getUTCDay()
  return lastDay - ((last - weekday + 7) % 7) + (ordinal + 1) * 7
}

// Evaluates VTIMEZONE observances for TZIDs that the Intl database does not know.
class VTimeZone {
  constructor(private readonly observances: Observance[]) {}

  static parse(component: Component) {
    const observances: Observance[] = []
    for (const child of component.children) {
      if (child.name !== 'STANDARD' && child.name !== 'DAYLIGHT') continue
      const start = parseWall(firstProperty(child, 'DTSTART')?.value ?? '')
      const offsetFrom = parseUtcOffset(firstProperty(child, 'TZOFFSETFROM')?.value)
      const offsetTo = parseUtcOffset(firstProperty(child, 'TZOFFSETTO')?.value)
      if (!start || offsetTo === undefined) continue
      const observance: Observance = { offsetFrom: offsetFrom ?? offsetTo, offsetTo, start: wallTimeMs(start.wall), dates: [] }
      const rule = parseRuleParts(firstProperty(child, 'RRULE')?.value ?? '')
      if (rule?.FREQ === 'YEARLY') {
        const month = Number(rule.BYMONTH ?? start.wall.month)
        const day = /^([+-]?\d)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(rule.BYDAY ?? '')
        const until = rule.UNTIL ? parseWall(rule.UNTIL) : undefined
        if (month >= 1 && month <= 12 && day) {
          observance.rule = {
            month, weekday: WEEKDAYS.indexOf(day[2]),
            ordinal: day[1] ? Number(day[1]) : undefined,
            monthDays: rule.BYMONTHDAY ? rule.BYMONTHDAY.split(',').map(Number).filter((value) => value >= 1 && value <= 31) : undefined,
            until: until ? wallTimeMs(until.wall) + (until.utc ? offsetFrom ?? 0 : 0) * 60_000 : undefined
          }
        }
      }
      for (const rdate of allProperties(child, 'RDATE')) {
        for (const value of rdate.value.split(',')) {
          const parsed = parseWall(value)
          if (parsed) observance.dates.push(wallTimeMs(parsed.wall))
        }
      }
      observances.push(observance)
    }
    return observances.length ? new VTimeZone(observances) : undefined
  }

  private onset(observance: Observance, year: number) {
    const rule = observance.rule
    if (!rule) return undefined
    const time = new Date(observance.start)
    let day: number | undefined
    if (rule.ordinal) day = nthWeekday(year, rule.month, rule.weekday, rule.ordinal)
    else if (rule.monthDays?.length) {
      day = rule.monthDays.find((candidate) => new Date(Date.UTC(year, rule.month - 1, candidate)).getUTCDay() === rule.weekday)
    } else day = nthWeekday(year, rule.month, rule.weekday, 1)
    if (!day) return undefined
    const value = Date.UTC(year, rule.month - 1, day, time.getUTCHours(), time.getUTCMinutes(), time.getUTCSeconds())
    if (value < observance.start || (rule.until !== undefined && value > rule.until)) return undefined
    return value
  }

  offsetAt(wall: number) {
    const year = new Date(wall).getUTCFullYear()
    let best: { onset: number; offset: number } | undefined
    for (const observance of this.observances) {
      const candidates = [observance.start, ...observance.dates, this.onset(observance, year), this.onset(observance, year - 1)]
      for (const onset of candidates) {
        if (onset === undefined || onset > wall) continue
        if (!best || onset > best.onset) best = { onset, offset: observance.offsetTo }
      }
    }
    if (best) return best.offset
    return [...this.observances].sort((a, b) => a.start - b.start)[0].offsetFrom
  }
}

function parseRuleParts(value: string): Record<string, string> | undefined {
  if (!value || value.length > 1_000) return undefined
  const parts: Record<string, string> = {}
  for (const segment of value.trim().replace(/^RRULE:/i, '').split(';')) {
    if (!segment) continue
    const [key, part, ...rest] = segment.split('=')
    const name = key?.trim().toUpperCase()
    if (!name || part === undefined || rest.length || !RRULE_KEYS.has(name) || !/^[A-Za-z0-9,+\-:]+$/.test(part) || parts[name]) return undefined
    parts[name] = part.toUpperCase()
  }
  if (!parts.FREQ || !FREQUENCIES.has(parts.FREQ)) return undefined
  if (parts.COUNT && parts.UNTIL) return undefined
  if (parts.COUNT && !/^\d{1,6}$/.test(parts.COUNT)) return undefined
  if (parts.INTERVAL && !/^\d{1,4}$/.test(parts.INTERVAL)) return undefined
  if (parts.UNTIL && !parseWall(parts.UNTIL)) return undefined
  return parts
}

export function normalizeRecurrenceRule(value: string) {
  const parts = parseRuleParts(value)
  return parts ? Object.entries(parts).map(([key, part]) => `${key}=${part}`).join(';') : undefined
}

export function simpleRecurrence(rule: string | undefined): NonNullable<CalendarEvent['recurrence']> {
  const parts = rule ? parseRuleParts(rule) : undefined
  if (!parts || (parts.INTERVAL && parts.INTERVAL !== '1')) return 'none'
  return parts.FREQ === 'DAILY' ? 'daily' : parts.FREQ === 'WEEKLY' ? 'weekly' : parts.FREQ === 'MONTHLY' ? 'monthly' : 'none'
}

interface ZoneContext {
  zones: Map<string, VTimeZone>
  defaultZone?: string
  warn(message: string): void
}

function parseDateValue(line: ContentLine, context: ZoneContext, raw = line.value): DateValue | undefined {
  const parsed = parseWall(raw)
  if (!parsed) return undefined
  if (parsed.dateOnly || paramValue(line, 'VALUE')?.toUpperCase() === 'DATE') {
    return { kind: 'date', date: isoDate(parsed.wall.year, parsed.wall.month, parsed.wall.day) }
  }
  if (parsed.utc) return { kind: 'datetime', utcMs: wallTimeMs(parsed.wall) }
  const tzid = paramValue(line, 'TZID')
  if (tzid) {
    const iana = resolveTimeZoneName(tzid)
    if (iana) return { kind: 'datetime', utcMs: wallTimeToUtc(parsed.wall, iana), timeZone: iana }
    const custom = context.zones.get(tzid)
    if (custom) return { kind: 'datetime', utcMs: wallTimeMs(parsed.wall) - custom.offsetAt(wallTimeMs(parsed.wall)) * 60_000, timeZone: tzid }
    context.warn(`Unknown time zone “${tzid.slice(0, 80)}” was treated as local time`)
  }
  // Floating time: use the calendar's declared zone, otherwise this computer's zone.
  if (context.defaultZone) return { kind: 'datetime', utcMs: wallTimeToUtc(parsed.wall, context.defaultZone) }
  const { year, month, day, hour, minute, second } = parsed.wall
  return { kind: 'datetime', utcMs: new Date(year, month - 1, day, hour, minute, second).getTime() }
}

const dateValueString = (value: DateValue) => value.kind === 'date' ? value.date : new Date(value.utcMs).toISOString()
const text = (component: Component, name: string) => {
  const value = firstProperty(component, name)?.value
  return value === undefined ? undefined : unescapeText(value).slice(0, MAX_TEXT)
}

function reminderFor(component: Component) {
  for (const alarm of component.children.filter((child) => child.name === 'VALARM')) {
    const trigger = firstProperty(alarm, 'TRIGGER')
    if (!trigger || paramValue(trigger, 'VALUE')?.toUpperCase() === 'DATE-TIME') continue
    if (paramValue(trigger, 'RELATED')?.toUpperCase() === 'END') continue
    const duration = parseDuration(trigger.value)
    if (duration !== undefined && duration <= 0) return Math.min(40_320, Math.round(-duration / 60_000))
  }
  return undefined
}

function parseEvent(component: Component, context: ZoneContext): IcsEvent | undefined {
  const startLine = firstProperty(component, 'DTSTART')
  const start = startLine ? parseDateValue(startLine, context) : undefined
  if (!start) {
    context.warn('An event without a valid start time was skipped')
    return undefined
  }
  if (text(component, 'STATUS')?.toUpperCase() === 'CANCELLED') return undefined
  const endLine = firstProperty(component, 'DTEND')
  let end = endLine ? parseDateValue(endLine, context) : undefined
  if (end && end.kind !== start.kind) end = undefined
  if (!end) {
    const duration = parseDuration(firstProperty(component, 'DURATION')?.value)
    if (start.kind === 'date') {
      const days = duration && duration > 0 ? Math.max(1, Math.round(duration / 86_400_000)) : 1
      const [year, month, day] = start.date.split('-').map(Number)
      const next = new Date(Date.UTC(year, month - 1, day + days))
      end = { kind: 'date', date: isoDate(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()) }
    } else {
      // Events without an end or duration use the editor's default one-hour length.
      end = { kind: 'datetime', utcMs: start.utcMs + (duration && duration > 0 ? duration : 3_600_000), timeZone: start.timeZone }
    }
  }
  const startValue = dateValueString(start)
  let endValue = dateValueString(end)
  if (start.kind === 'date' && end.kind === 'date' && end.date <= start.date) {
    const [year, month, day] = start.date.split('-').map(Number)
    const next = new Date(Date.UTC(year, month - 1, day + 1))
    endValue = isoDate(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate())
  } else if (start.kind === 'datetime' && end.kind === 'datetime' && end.utcMs <= start.utcMs) {
    endValue = new Date(start.utcMs + 3_600_000).toISOString()
  }
  const ruleLine = firstProperty(component, 'RRULE')
  const recurrenceRule = ruleLine ? normalizeRecurrenceRule(ruleLine.value) : undefined
  if (ruleLine && !recurrenceRule) context.warn('An unreadable repeat rule was ignored')
  const exceptions: string[] = []
  for (const line of allProperties(component, 'EXDATE')) {
    for (const value of line.value.split(',')) {
      const parsed = parseDateValue(line, context, value)
      if (parsed && exceptions.length < 5_000) exceptions.push(dateValueString(parsed))
    }
  }
  const recurrenceLine = firstProperty(component, 'RECURRENCE-ID')
  const recurrenceId = recurrenceLine ? parseDateValue(recurrenceLine, context) : undefined
  const attendees = allProperties(component, 'ATTENDEE')
    .map((line) => line.value.replace(/^mailto:/i, '').trim())
    .filter((value) => value && value.length <= 500)
    .slice(0, MAX_ATTENDEES)
  const uid = text(component, 'UID')?.trim().slice(0, 1_000)
  return {
    ...(uid ? { uid } : {}),
    ...(recurrenceId ? { recurrenceId: dateValueString(recurrenceId) } : {}),
    title: (text(component, 'SUMMARY')?.trim() || 'Untitled event').slice(0, 500),
    ...(text(component, 'DESCRIPTION') ? { description: text(component, 'DESCRIPTION') } : {}),
    ...(text(component, 'LOCATION') ? { location: text(component, 'LOCATION')!.slice(0, 2_000) } : {}),
    start: startValue,
    end: endValue,
    allDay: start.kind === 'date',
    ...(start.kind === 'datetime' && start.timeZone ? { timeZone: start.timeZone } : {}),
    ...(recurrenceRule ? { recurrenceRule } : {}),
    recurrenceExceptions: exceptions,
    attendees,
    ...(reminderFor(component) !== undefined ? { reminderMinutes: reminderFor(component) } : {})
  }
}

export function parseIcs(input: string, limits: ContentLimits = ICS_LIMITS, maxEvents = ICS_MAX_EVENTS): IcsParseResult {
  const { roots, warnings } = parseComponents(input, limits)
  const calendars = roots.filter((root) => root.name === 'VCALENDAR')
  if (!calendars.length) throw new InterchangeFormatError('This is not an iCalendar (.ics) file: no VCALENDAR was found')
  const warningCounts = new Map<string, number>()
  const warn = (message: string) => warningCounts.set(message, (warningCounts.get(message) ?? 0) + 1)
  const events: IcsEvent[] = []
  let calendarName: string | undefined
  let declaredZone: string | undefined
  for (const calendar of calendars) {
    calendarName ??= text(calendar, 'X-WR-CALNAME')?.trim().slice(0, 200) || text(calendar, 'NAME')?.trim().slice(0, 200)
    const zoneName = text(calendar, 'X-WR-TIMEZONE')?.trim()
    const defaultZone = zoneName ? resolveTimeZoneName(zoneName) : undefined
    declaredZone ??= defaultZone
    const zones = new Map<string, VTimeZone>()
    for (const child of calendar.children.filter((item) => item.name === 'VTIMEZONE')) {
      const tzid = text(child, 'TZID')
      const zone = tzid ? VTimeZone.parse(child) : undefined
      if (tzid && zone) zones.set(tzid, zone)
    }
    const context: ZoneContext = { zones, defaultZone, warn }
    for (const child of calendar.children.filter((item) => item.name === 'VEVENT')) {
      if (events.length >= maxEvents) throw new InterchangeFormatError(`The calendar contains more than ${maxEvents.toLocaleString('en-US')} events`)
      const event = parseEvent(child, context)
      if (event) events.push(event)
    }
  }
  const allWarnings = [...warnings, ...[...warningCounts].map(([message, count]) => count > 1 ? `${message} (${count} times)` : message)]
  return { ...(calendarName ? { calendarName } : {}), ...(declaredZone ? { timeZone: declaredZone } : {}), events, warnings: allWarnings }
}

export function icsEventToCalendarEvent(event: IcsEvent, calendarId: string, color: string, id: string): CalendarEvent {
  return {
    id, calendarId, title: event.title, start: event.start, end: event.end,
    ...(event.location ? { location: event.location } : {}),
    ...(event.description ? { description: event.description } : {}),
    color, attendees: event.attendees, reminderMinutes: event.reminderMinutes ?? 0,
    recurrence: simpleRecurrence(event.recurrenceRule),
    ...(event.allDay ? { allDay: true } : {}),
    ...(event.timeZone ? { timeZone: event.timeZone } : {}),
    ...(event.recurrenceRule ? { recurrenceRule: event.recurrenceRule } : {}),
    ...(event.recurrenceExceptions.length ? { recurrenceExceptions: event.recurrenceExceptions } : {}),
    ...(event.recurrenceId ? { recurrenceId: event.recurrenceId } : {}),
    ...(event.uid ? { sourceUid: event.uid } : {})
  }
}

// --- Serialization ---------------------------------------------------------------------------

const icsDate = (value: string) => value.slice(0, 10).replace(/-/g, '')
const icsUtc = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
const icsWall = (wall: WallTime) => `${pad(wall.year, 4)}${pad(wall.month)}${pad(wall.day)}T${pad(wall.hour)}${pad(wall.minute)}${pad(wall.second)}`
const isAllDay = (event: CalendarEvent) => Boolean(event.allDay) || (DATE_ONLY.test(event.start) && DATE_ONLY.test(event.end))

function dateProperty(name: string, value: string, allDay: boolean, timeZone: string | undefined) {
  if (allDay || DATE_ONLY.test(value)) return `${name};VALUE=DATE:${icsDate(value)}`
  const ms = Date.parse(value)
  if (timeZone && timeZone !== 'UTC' && isIanaTimeZone(timeZone)) return `${name}${formatParam('TZID', [timeZone])}:${icsWall(wallTimeInZone(ms, timeZone))}`
  return `${name}:${icsUtc(ms)}`
}

function ruleDay(year: number, month: number, day: number) {
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return day + 7 > lastDay ? `-1${weekday}` : `${Math.ceil(day / 7)}${weekday}`
}

const formatOffset = (minutes: number) => `${minutes < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(minutes) / 60))}${pad(Math.abs(minutes) % 60)}`

// Builds a VTIMEZONE from the Intl database: the transitions observed in `year`, expressed as yearly rules.
export function buildVTimeZone(timeZone: string, year: number) {
  const transitions: { at: number; from: number; to: number }[] = []
  let previous = timeZoneOffsetMinutes(Date.UTC(year, 0, 1), timeZone)
  for (let day = 1; day <= 366; day++) {
    const at = Date.UTC(year, 0, 1) + day * 86_400_000
    const offset = timeZoneOffsetMinutes(at, timeZone)
    if (offset !== previous) {
      let low = at - 86_400_000
      let high = at
      while (high - low > 60_000) {
        const middle = Math.floor((low + high) / 2 / 60_000) * 60_000
        if (timeZoneOffsetMinutes(middle, timeZone) === previous) low = middle
        else high = middle
      }
      transitions.push({ at: high, from: previous, to: offset })
      previous = offset
    }
  }
  const lines = ['BEGIN:VTIMEZONE', `TZID:${timeZone}`]
  if (!transitions.length) {
    lines.push('BEGIN:STANDARD', 'DTSTART:19700101T000000', `TZOFFSETFROM:${formatOffset(previous)}`, `TZOFFSETTO:${formatOffset(previous)}`, 'END:STANDARD')
  } else {
    const minimum = Math.min(...transitions.map((transition) => transition.to))
    for (const transition of transitions) {
      const wall = new Date(transition.at + transition.from * 60_000)
      const month = wall.getUTCMonth() + 1
      const kind = transition.to > minimum || (transitions.length === 1 && transition.to > transition.from) ? 'DAYLIGHT' : 'STANDARD'
      lines.push(
        `BEGIN:${kind}`,
        `DTSTART:${icsWall({ year: 1970, month, day: wall.getUTCDate(), hour: wall.getUTCHours(), minute: wall.getUTCMinutes(), second: 0 })}`,
        `RRULE:FREQ=YEARLY;BYMONTH=${month};BYDAY=${ruleDay(wall.getUTCFullYear(), month, wall.getUTCDate())}`,
        `TZOFFSETFROM:${formatOffset(transition.from)}`,
        `TZOFFSETTO:${formatOffset(transition.to)}`,
        `END:${kind}`
      )
    }
  }
  lines.push('END:VTIMEZONE')
  return lines
}

export interface IcsSerializeOptions {
  calendarName?: string
  now?: Date
}

export function serializeIcs(events: CalendarEvent[], options: IcsSerializeOptions = {}) {
  const stamp = icsUtc((options.now ?? new Date()).getTime())
  const zones = new Map<string, number>()
  for (const event of events) {
    if (!isAllDay(event) && event.timeZone && event.timeZone !== 'UTC' && isIanaTimeZone(event.timeZone)) {
      const year = new Date(Date.parse(event.start)).getUTCFullYear()
      zones.set(event.timeZone, Math.min(zones.get(event.timeZone) ?? year, year))
    }
  }
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Aerio//Calendar Export//EN', 'CALSCALE:GREGORIAN']
  if (options.calendarName) lines.push(`X-WR-CALNAME:${escapeText(options.calendarName)}`)
  for (const [zone, year] of zones) lines.push(...buildVTimeZone(zone, year))
  for (const event of events) {
    const allDay = isAllDay(event)
    const zone = allDay ? undefined : event.timeZone
    lines.push('BEGIN:VEVENT', `UID:${escapeText(event.sourceUid ?? `${event.id}@aerio.local`)}`, `DTSTAMP:${stamp}`)
    lines.push(dateProperty('DTSTART', event.start, allDay, zone), dateProperty('DTEND', event.end, allDay, zone))
    if (event.recurrenceId) lines.push(dateProperty('RECURRENCE-ID', event.recurrenceId, DATE_ONLY.test(event.recurrenceId), zone))
    lines.push(`SUMMARY:${escapeText(event.title)}`)
    if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`)
    if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`)
    const rule = event.recurrenceRule
      ? normalizeRecurrenceRule(event.recurrenceRule)
      : event.recurrence && event.recurrence !== 'none' ? `FREQ=${event.recurrence.toUpperCase()}` : undefined
    if (rule) lines.push(`RRULE:${rule}`)
    const exceptions = event.recurrenceExceptions ?? []
    const dateExceptions = exceptions.filter((value) => DATE_ONLY.test(value))
    const timeExceptions = exceptions.filter((value) => !DATE_ONLY.test(value) && Number.isFinite(Date.parse(value)))
    if (dateExceptions.length) lines.push(`EXDATE;VALUE=DATE:${dateExceptions.map(icsDate).join(',')}`)
    if (timeExceptions.length) {
      lines.push(zone && zone !== 'UTC' && isIanaTimeZone(zone)
        ? `EXDATE${formatParam('TZID', [zone])}:${timeExceptions.map((value) => icsWall(wallTimeInZone(Date.parse(value), zone))).join(',')}`
        : `EXDATE:${timeExceptions.map((value) => icsUtc(Date.parse(value))).join(',')}`)
    }
    for (const attendee of event.attendees) lines.push(`ATTENDEE:mailto:${attendee.replace(/[\r\n;:,]/g, '')}`)
    if (event.reminderMinutes > 0) {
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeText(event.title)}`, `TRIGGER:-PT${event.reminderMinutes}M`, 'END:VALARM')
    }
    lines.push('END:VEVENT')
  }
  lines.push('END:VCALENDAR')
  return `${lines.map(foldLine).join('\r\n')}\r\n`
}

// Identity used to detect re-imports and to keep subscription event ids stable across refreshes.
export const eventIdentity = (event: Pick<CalendarEvent, 'sourceUid' | 'recurrenceId'>) =>
  event.sourceUid ? `${event.sourceUid}\u0000${event.recurrenceId ?? ''}` : undefined
