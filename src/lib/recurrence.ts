// Bounded RFC 5545 recurrence engine shared by calendar views, the event editor, and provider connectors.
// Rules are evaluated on wall-clock dates in the event's named zone, so a 09:00 weekly meeting stays at
// 09:00 across daylight-saving transitions. Rules Aerio cannot evaluate are reported, never dropped.
import type { CalendarEvent } from '../types'
import { normalizeRecurrenceRule } from './ics'
import { localTimeZone, resolveTimeZoneName, wallTimeInZone, wallTimeToUtc, type WallTime } from './time-zones'

export type RecurrenceFrequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'

export interface WeekdayRule {
  weekday: number
  ordinal?: number
}

export interface RecurrenceRule {
  freq: RecurrenceFrequency | 'HOURLY' | 'MINUTELY' | 'SECONDLY'
  interval: number
  count?: number
  until?: string
  byDay: WeekdayRule[]
  byMonthDay: number[]
  byMonth: number[]
  bySetPos: number[]
  weekStart: number
  // Parts the expander cannot evaluate (sub-daily frequencies, BYHOUR, BYWEEKNO, ...). Such rules are
  // kept verbatim and shown read-only.
  unsupported: string[]
  // Every normalized part, so parts Aerio does not interpret survive a rebuild.
  parts: Record<string, string>
}

export interface Occurrence {
  start: string
  end: string
  originalStart: string
}

export interface ExpansionOptions {
  // Zone used for floating (zone-less) times and for placing all-day dates; defaults to this computer's zone.
  timeZone?: string
  maxOccurrences?: number
}

export const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const ORDINAL_NAMES: Record<number, string> = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', 5: 'fifth', [-1]: 'last', [-2]: 'second-to-last' }
const SUPPORTED_FREQUENCIES = new Set(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'])
const UNSUPPORTED_PARTS = ['BYSECOND', 'BYMINUTE', 'BYHOUR', 'BYYEARDAY', 'BYWEEKNO', 'RSCALE', 'SKIP']
export const MAX_EXPANDED_OCCURRENCES = 1_000
const MAX_PERIODS = 50_000
const DAY_MS = 86_400_000
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

const pad = (value: number, size = 2) => String(value).padStart(size, '0')
const dayNumber = (year: number, month: number, day: number) => Math.floor(Date.UTC(year, month - 1, day) / DAY_MS)
const civil = (day: number) => {
  const date = new Date(day * DAY_MS)
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }
}
const weekdayOf = (day: number) => (((day + 4) % 7) + 7) % 7
const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate()
export const isoDay = (day: number) => {
  const { year, month, day: date } = civil(day)
  return `${pad(year, 4)}-${pad(month)}-${pad(date)}`
}
const dayFromIso = (value: string) => {
  const [year, month, day] = value.slice(0, 10).split('-').map(Number)
  return dayNumber(year, month, day)
}
const wallDay = (wall: WallTime) => dayNumber(wall.year, wall.month, wall.day)

export const isAllDayEvent = (event: Pick<CalendarEvent, 'allDay' | 'start' | 'end'>) =>
  Boolean(event.allDay) || (DATE_ONLY.test(event.start) && DATE_ONLY.test(event.end))

function numberList(value: string | undefined, min: number, max: number, unsupported: string[], key: string) {
  if (!value) return []
  const values = value.split(',').map(Number)
  if (values.some((item) => !Number.isInteger(item) || item === 0 || item < min || item > max)) {
    unsupported.push(key)
    return []
  }
  return [...new Set(values)]
}

export function parseRecurrenceRule(value: string | undefined): RecurrenceRule | undefined {
  const normalized = value ? normalizeRecurrenceRule(value) : undefined
  if (!normalized) return undefined
  const parts = Object.fromEntries(normalized.split(';').map((segment) => segment.split('=') as [string, string]))
  const unsupported: string[] = []
  const freq = parts.FREQ as RecurrenceRule['freq']
  if (!SUPPORTED_FREQUENCIES.has(freq)) unsupported.push(`FREQ=${freq}`)
  for (const key of UNSUPPORTED_PARTS) if (parts[key]) unsupported.push(key)
  const byDay: WeekdayRule[] = []
  for (const item of parts.BYDAY?.split(',') ?? []) {
    const match = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(item)
    const ordinal = match?.[1] ? Number(match[1]) : undefined
    if (!match || ordinal === 0 || (ordinal !== undefined && Math.abs(ordinal) > 53)) {
      unsupported.push('BYDAY')
      break
    }
    byDay.push({ weekday: WEEKDAY_CODES.indexOf(match[2]), ...(ordinal !== undefined ? { ordinal } : {}) })
  }
  // Ordinal weekdays only have meaning inside months and years (RFC 5545 §3.3.10).
  if (byDay.some((day) => day.ordinal !== undefined) && (freq === 'DAILY' || freq === 'WEEKLY')) unsupported.push('BYDAY')
  if (byDay.some((day) => day.ordinal !== undefined && Math.abs(day.ordinal) > 5) && freq === 'MONTHLY') unsupported.push('BYDAY')
  const byMonthDay = numberList(parts.BYMONTHDAY, -31, 31, unsupported, 'BYMONTHDAY')
  if (byMonthDay.length && freq === 'WEEKLY') unsupported.push('BYMONTHDAY')
  const byMonth = numberList(parts.BYMONTH, 1, 12, unsupported, 'BYMONTH')
  const bySetPos = numberList(parts.BYSETPOS, -366, 366, unsupported, 'BYSETPOS')
  const weekStart = parts.WKST ? WEEKDAY_CODES.indexOf(parts.WKST) : 1
  if (weekStart < 0) unsupported.push('WKST')
  return {
    freq, interval: Math.max(1, Number(parts.INTERVAL ?? 1)),
    ...(parts.COUNT ? { count: Math.max(1, Number(parts.COUNT)) } : {}),
    ...(parts.UNTIL ? { until: parts.UNTIL } : {}),
    byDay, byMonthDay, byMonth, bySetPos, weekStart: Math.max(0, weekStart),
    unsupported: [...new Set(unsupported)], parts
  }
}

const weekdayCode = (day: WeekdayRule) => `${day.ordinal ?? ''}${WEEKDAY_CODES[day.weekday]}`

// Serializes a rule. Interpreted parts come from the structured fields; uninterpreted parts are kept as parsed.
export function formatRecurrenceRule(rule: RecurrenceRule) {
  const interpreted = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'BYSETPOS', 'WKST'])
  const segments = [`FREQ=${rule.freq}`]
  if (rule.interval > 1) segments.push(`INTERVAL=${rule.interval}`)
  if (rule.count !== undefined) segments.push(`COUNT=${rule.count}`)
  else if (rule.until) segments.push(`UNTIL=${rule.until}`)
  if (rule.byMonth.length) segments.push(`BYMONTH=${rule.byMonth.join(',')}`)
  if (rule.byMonthDay.length) segments.push(`BYMONTHDAY=${rule.byMonthDay.join(',')}`)
  if (rule.byDay.length) segments.push(`BYDAY=${rule.byDay.map(weekdayCode).join(',')}`)
  if (rule.bySetPos.length) segments.push(`BYSETPOS=${rule.bySetPos.join(',')}`)
  if (rule.parts.WKST || rule.weekStart !== 1) segments.push(`WKST=${WEEKDAY_CODES[rule.weekStart]}`)
  for (const [key, value] of Object.entries(rule.parts)) if (!interpreted.has(key)) segments.push(`${key}=${value}`)
  return segments.join(';')
}

export function newRecurrenceRule(freq: RecurrenceFrequency, fields: Partial<Omit<RecurrenceRule, 'freq' | 'parts' | 'unsupported'>> = {}): RecurrenceRule {
  return { freq, interval: 1, byDay: [], byMonthDay: [], byMonth: [], bySetPos: [], weekStart: 1, unsupported: [], parts: {}, ...fields }
}

// The effective rule of an event: the preserved RRULE when present, otherwise the simple repeat choice.
export function eventRecurrenceRule(event: Pick<CalendarEvent, 'recurrence' | 'recurrenceRule'>) {
  if (event.recurrenceRule) return parseRecurrenceRule(event.recurrenceRule)
  return event.recurrence && event.recurrence !== 'none' ? parseRecurrenceRule(`FREQ=${event.recurrence.toUpperCase()}`) : undefined
}

export const isRecurringEvent = (event: Pick<CalendarEvent, 'recurrence' | 'recurrenceRule'>) => Boolean(eventRecurrenceRule(event))

// The legacy simple repeat value that exactly matches a rule, or 'none' when the rule is richer.
export function simpleRecurrenceFor(rule: RecurrenceRule | undefined): NonNullable<CalendarEvent['recurrence']> {
  if (!rule || rule.interval !== 1 || rule.count !== undefined || rule.until || rule.byDay.length || rule.byMonthDay.length ||
    rule.byMonth.length || rule.bySetPos.length || rule.unsupported.length || Object.keys(rule.parts).some((key) => !['FREQ', 'INTERVAL', 'WKST'].includes(key))) return 'none'
  return rule.freq === 'DAILY' ? 'daily' : rule.freq === 'WEEKLY' ? 'weekly' : rule.freq === 'MONTHLY' ? 'monthly' : 'none'
}

// --- Description -------------------------------------------------------------------------------

const listText = (items: string[]) => items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
const ordinalText = (value: number) => ORDINAL_NAMES[value] ?? (value > 0 ? `${value}th` : `${Math.abs(value)}th-to-last`)
const monthDayText = (value: number) => value === -1 ? 'the last day' : value < 0 ? `${Math.abs(value)} days before month end` : `day ${value}`

export function untilDate(value: string) {
  const match = /^(\d{4})(\d{2})(\d{2})/.exec(value)
  return match ? `${match[1]}-${match[2]}-${match[3]}` : undefined
}

export function describeRecurrence(rule: RecurrenceRule | undefined) {
  if (!rule) return 'Doesn’t repeat'
  if (rule.unsupported.length) return `Custom rule (${formatRecurrenceRule(rule)})`
  const unit = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' }[rule.freq as RecurrenceFrequency]
  let text = rule.interval === 1 ? `Every ${unit}` : `Every ${rule.interval} ${unit}s`
  const weekdays = rule.byDay.filter((day) => day.ordinal === undefined).map((day) => WEEKDAY_NAMES[day.weekday].slice(0, 3))
  const ordinals = rule.byDay.filter((day) => day.ordinal !== undefined).map((day) => `the ${ordinalText(day.ordinal!)} ${WEEKDAY_NAMES[day.weekday]}`)
  const isWeekdays = rule.byDay.length === 5 && [1, 2, 3, 4, 5].every((day) => rule.byDay.some((item) => item.weekday === day && item.ordinal === undefined))
  const months = rule.byMonth.map((month) => MONTH_NAMES[month - 1])
  if (rule.bySetPos.length && rule.byDay.length) {
    text += ` on the ${listText(rule.bySetPos.map(ordinalText))} ${isWeekdays ? 'weekday' : `of ${listText(weekdays)}`}`
  } else {
    if (weekdays.length) text += ` on ${isWeekdays ? 'weekdays' : listText(weekdays)}`
    if (ordinals.length) text += ` on ${listText(ordinals)}`
    if (rule.byMonthDay.length) text += ` on ${listText(rule.byMonthDay.map(monthDayText))}`
  }
  if (months.length) text += ` in ${listText(months)}`
  if (rule.count !== undefined) text += `, ${rule.count} time${rule.count === 1 ? '' : 's'}`
  else if (rule.until) {
    const date = untilDate(rule.until)
    text += date ? `, until ${new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}` : ''
  }
  return text
}

// --- Expansion ---------------------------------------------------------------------------------

interface RuleStart {
  day: number
  year: number
  month: number
  date: number
  weekday: number
  weekStart: number
}

function setPositions(days: number[], positions: number[]) {
  if (!positions.length) return days
  const picked = positions.flatMap((position) => {
    const day = position > 0 ? days[position - 1] : days[days.length + position]
    return day === undefined ? [] : [day]
  })
  return [...new Set(picked)].sort((a, b) => a - b)
}

function monthDays(year: number, month: number, rule: RecurrenceRule, defaultDate: number) {
  const length = daysInMonth(year, month)
  const first = dayNumber(year, month, 1)
  let dates: number[] | undefined
  if (rule.byMonthDay.length) dates = rule.byMonthDay.map((day) => day > 0 ? day : length + day + 1).filter((day) => day >= 1 && day <= length)
  if (rule.byDay.length) {
    const fromWeekdays: number[] = []
    for (const { weekday, ordinal } of rule.byDay) {
      const matches: number[] = []
      for (let date = 1 + ((weekday - weekdayOf(first) + 7) % 7); date <= length; date += 7) matches.push(date)
      if (ordinal === undefined) fromWeekdays.push(...matches)
      else {
        const pick = ordinal > 0 ? matches[ordinal - 1] : matches[matches.length + ordinal]
        if (pick) fromWeekdays.push(pick)
      }
    }
    dates = dates ? dates.filter((date) => fromWeekdays.includes(date)) : fromWeekdays
  }
  if (!dates) dates = defaultDate <= length ? [defaultDate] : []
  return [...new Set(dates)].sort((a, b) => a - b).map((date) => first + date - 1)
}

function yearDays(year: number, rule: RecurrenceRule, start: RuleStart) {
  const hasDayParts = rule.byMonthDay.length > 0 || rule.byDay.length > 0
  if (rule.byMonth.length) {
    return [...rule.byMonth].sort((a, b) => a - b).flatMap((month) => hasDayParts
      ? monthDays(year, month, rule, start.date)
      : start.date <= daysInMonth(year, month) ? [dayNumber(year, month, start.date)] : [])
  }
  if (rule.byDay.length) {
    // Without BYMONTH, ordinal weekdays count through the whole year (e.g. the 20th Monday).
    const first = dayNumber(year, 1, 1)
    const last = dayNumber(year, 12, 31)
    const days: number[] = []
    for (const { weekday, ordinal } of rule.byDay) {
      const matches: number[] = []
      for (let day = first + ((weekday - weekdayOf(first) + 7) % 7); day <= last; day += 7) matches.push(day)
      if (ordinal === undefined) days.push(...matches)
      else {
        const pick = ordinal > 0 ? matches[ordinal - 1] : matches[matches.length + ordinal]
        if (pick !== undefined) days.push(pick)
      }
    }
    const filtered = rule.byMonthDay.length ? days.filter((day) => {
      const { year: y, month, day: date } = civil(day)
      const length = daysInMonth(y, month)
      return rule.byMonthDay.some((value) => (value > 0 ? value : length + value + 1) === date)
    }) : days
    return [...new Set(filtered)].sort((a, b) => a - b)
  }
  if (rule.byMonthDay.length) return Array.from({ length: 12 }, (_, index) => monthDays(year, index + 1, rule, start.date)).flat()
  return start.date <= daysInMonth(year, start.month) ? [dayNumber(year, start.month, start.date)] : []
}

function periodStartDay(rule: RecurrenceRule, start: RuleStart, period: number) {
  if (rule.freq === 'DAILY') return start.day + period * rule.interval
  if (rule.freq === 'WEEKLY') return start.day - ((start.weekday - start.weekStart + 7) % 7) + period * rule.interval * 7
  if (rule.freq === 'MONTHLY') {
    const index = start.year * 12 + start.month - 1 + period * rule.interval
    return dayNumber(Math.floor(index / 12), (index % 12) + 1, 1)
  }
  return dayNumber(start.year + period * rule.interval, 1, 1)
}

function periodDays(rule: RecurrenceRule, start: RuleStart, period: number) {
  const periodStart = periodStartDay(rule, start, period)
  let days: number[]
  if (rule.freq === 'DAILY') {
    const { month, day } = civil(periodStart)
    const length = daysInMonth(civil(periodStart).year, month)
    const matches = (!rule.byMonth.length || rule.byMonth.includes(month)) &&
      (!rule.byMonthDay.length || rule.byMonthDay.some((value) => (value > 0 ? value : length + value + 1) === day)) &&
      (!rule.byDay.length || rule.byDay.some((item) => item.weekday === weekdayOf(periodStart)))
    days = matches ? [periodStart] : []
  } else if (rule.freq === 'WEEKLY') {
    const weekdays = rule.byDay.length ? rule.byDay.map((item) => item.weekday) : [start.weekday]
    days = [...new Set(weekdays.map((weekday) => periodStart + ((weekday - start.weekStart + 7) % 7)))]
      .sort((a, b) => a - b)
      .filter((day) => !rule.byMonth.length || rule.byMonth.includes(civil(day).month))
  } else if (rule.freq === 'MONTHLY') {
    const { year, month } = civil(periodStart)
    days = rule.byMonth.length && !rule.byMonth.includes(month) ? [] : monthDays(year, month, rule, start.date)
  } else {
    days = yearDays(civil(periodStart).year, rule, start)
  }
  return { periodStart, days: setPositions(days, rule.bySetPos) }
}

// First period worth evaluating for a day; only used when COUNT does not require counting from the start.
function periodNear(rule: RecurrenceRule, start: RuleStart, day: number) {
  if (day <= start.day) return 0
  let period: number
  if (rule.freq === 'DAILY') period = Math.floor((day - start.day) / rule.interval)
  else if (rule.freq === 'WEEKLY') period = Math.floor((day - periodStartDay(rule, start, 0)) / (rule.interval * 7))
  else if (rule.freq === 'MONTHLY') {
    const target = civil(day)
    period = Math.floor(((target.year - start.year) * 12 + target.month - start.month) / rule.interval)
  } else period = Math.floor((civil(day).year - start.year) / rule.interval)
  return Math.max(0, period - 1)
}

// Yields occurrence days in order, beginning with the DTSTART day, which RFC 5545 always counts as the
// first instance. Stops after `toDay`, or after MAX_PERIODS periods for rules that rarely match.
function* recurrenceDays(rule: RecurrenceRule, startDay: number, fromDay: number, toDay: number): Generator<number> {
  const { year, month, day: date } = civil(startDay)
  const start: RuleStart = { day: startDay, year, month, date, weekday: weekdayOf(startDay), weekStart: rule.weekStart }
  yield startDay
  const first = rule.count === undefined ? periodNear(rule, start, fromDay) : 0
  for (let period = first; period < first + MAX_PERIODS; period++) {
    const { periodStart, days } = periodDays(rule, start, period)
    if (periodStart > toDay) return
    for (const day of days) {
      if (day > toDay) return
      if (day > startDay) yield day
    }
  }
}

function untilLimit(until: string | undefined, zone: string) {
  if (!until) return undefined
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(until)
  if (!match) return undefined
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (match[4] === undefined) return { day: dayNumber(year, month, day) }
  const wall = { year, month, day, hour: Number(match[4]), minute: Number(match[5]), second: Number(match[6]) }
  return { ms: match[7] ? Date.UTC(year, month - 1, day, wall.hour, wall.minute, wall.second) : wallTimeToUtc(wall, zone) }
}

const toMs = (value: Date | number | string) => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : value.getTime()

// Expands one event's occurrences overlapping [rangeStart, rangeEnd). Returns undefined when the event has no
// rule or its rule uses parts the engine cannot evaluate, so callers show the stored event unchanged.
export function expandEventOccurrences(
  event: CalendarEvent,
  rangeStart: Date | number | string,
  rangeEnd: Date | number | string,
  options: ExpansionOptions = {}
): Occurrence[] | undefined {
  const rule = eventRecurrenceRule(event)
  if (!rule || rule.unsupported.length) return undefined
  const fromMs = toMs(rangeStart)
  const endMs = toMs(rangeEnd)
  const limit = Math.min(options.maxOccurrences ?? MAX_EXPANDED_OCCURRENCES, MAX_EXPANDED_OCCURRENCES)
  const displayZone = resolveTimeZoneName(options.timeZone) ?? localTimeZone()
  const occurrences: Occurrence[] = []
  const exceptionMs = new Set<number>()
  const exceptionDays = new Set<string>()
  for (const value of event.recurrenceExceptions ?? []) {
    if (DATE_ONLY.test(value)) exceptionDays.add(value)
    else if (Number.isFinite(Date.parse(value))) exceptionMs.add(Date.parse(value))
  }
  let generated = 0
  if (isAllDayEvent(event)) {
    const startDay = dayFromIso(event.start)
    const length = Math.max(1, (DATE_ONLY.test(event.end) ? dayFromIso(event.end) : startDay + 1) - startDay)
    const fromDay = wallDay(wallTimeInZone(fromMs, displayZone)) - length
    const toDay = wallDay(wallTimeInZone(endMs, displayZone))
    const until = untilLimit(rule.until, displayZone)
    const untilDay = until?.day ?? (until?.ms !== undefined ? wallDay(wallTimeInZone(until.ms, displayZone)) : undefined)
    for (const day of recurrenceDays(rule, startDay, fromDay, toDay)) {
      if (untilDay !== undefined && day > untilDay) break
      if (rule.count !== undefined && ++generated > rule.count) break
      const start = isoDay(day)
      if (exceptionDays.has(start)) continue
      const startMs = wallTimeToUtc({ ...civilWall(day), hour: 0, minute: 0, second: 0 }, displayZone)
      const endAt = wallTimeToUtc({ ...civilWall(day + length), hour: 0, minute: 0, second: 0 }, displayZone)
      if (endAt <= fromMs || startMs >= endMs) continue
      occurrences.push({ start, end: isoDay(day + length), originalStart: start })
      if (occurrences.length >= limit) break
    }
    return occurrences
  }
  const zone = resolveTimeZoneName(event.timeZone) ?? displayZone
  const startMs = Date.parse(event.start)
  const duration = Math.max(0, Date.parse(event.end) - startMs)
  if (!Number.isFinite(startMs) || !Number.isFinite(duration)) return undefined
  const wall = wallTimeInZone(startMs, zone)
  const fromDay = wallDay(wallTimeInZone(fromMs - duration, zone)) - 1
  const toDay = wallDay(wallTimeInZone(endMs, zone)) + 1
  const until = untilLimit(rule.until, zone)
  for (const day of recurrenceDays(rule, wallDay(wall), fromDay, toDay)) {
    const occurrenceMs = day === wallDay(wall) ? startMs : wallTimeToUtc({ ...civilWall(day), hour: wall.hour, minute: wall.minute, second: wall.second }, zone)
    if (until?.day !== undefined && day > until.day) break
    if (until?.ms !== undefined && occurrenceMs > until.ms) break
    if (rule.count !== undefined && ++generated > rule.count) break
    if (occurrenceMs + duration <= fromMs || occurrenceMs >= endMs) continue
    if (exceptionMs.has(occurrenceMs) || exceptionDays.has(isoDay(day))) continue
    const start = new Date(occurrenceMs).toISOString()
    occurrences.push({ start, end: new Date(occurrenceMs + duration).toISOString(), originalStart: start })
    if (occurrences.length >= limit) break
  }
  return occurrences
}

function civilWall(day: number) {
  const { year, month, day: date } = civil(day)
  return { year, month, day: date }
}

// Number of occurrences a rule produces strictly before `before`, ignoring exceptions as COUNT does.
export function occurrencesBefore(event: CalendarEvent, before: string, options: ExpansionOptions = {}) {
  const rule = eventRecurrenceRule(event)
  if (!rule || rule.unsupported.length) return 0
  const unbounded = { ...event, recurrenceExceptions: [], recurrenceRule: formatRecurrenceRule({ ...rule, count: undefined, until: undefined }) }
  const dateOnly = DATE_ONLY.test(before)
  const limitMs = dateOnly ? Date.parse(`${before}T00:00:00Z`) + DAY_MS : Date.parse(before)
  const occurrences = expandEventOccurrences(unbounded, Date.parse(event.start) - 2 * DAY_MS, limitMs, { ...options, maxOccurrences: MAX_EXPANDED_OCCURRENCES })
  return (occurrences ?? []).filter((occurrence) => dateOnly
    ? occurrence.originalStart.slice(0, 10) < before
    : Date.parse(occurrence.originalStart) < Date.parse(before)).length
}

export const occurrenceKey = (value: string) => DATE_ONLY.test(value) ? value : String(Date.parse(value))
export const occurrenceEventId = (masterId: string, originalStart: string) => `${masterId}::${occurrenceKey(originalStart)}`

// True when `override` replaces an occurrence of `master` (same series identity and calendar).
export function isOverrideOf(override: CalendarEvent, master: CalendarEvent) {
  if (!override.recurrenceId || override.id === master.id || override.calendarId !== master.calendarId) return false
  return override.seriesId === master.id || Boolean(master.sourceUid && override.sourceUid === master.sourceUid)
}

// Expands recurring events for a visible range. Non-recurring events, overrides, and events whose rules
// cannot be evaluated pass through unchanged; overridden occurrences are replaced by their override.
export function expandCalendarEvents(
  events: CalendarEvent[],
  rangeStart: Date | number | string,
  rangeEnd: Date | number | string,
  options: ExpansionOptions & { expand?(event: CalendarEvent): boolean } = {}
): CalendarEvent[] {
  const overrides = events.filter((event) => event.recurrenceId)
  const result: CalendarEvent[] = []
  for (const event of events) {
    const occurrences = !event.recurrenceId && !event.occurrenceOf && (options.expand?.(event) ?? true)
      ? expandEventOccurrences(event, rangeStart, rangeEnd, options)
      : undefined
    if (!occurrences) {
      result.push(event)
      continue
    }
    const replaced = new Set(overrides.filter((override) => isOverrideOf(override, event)).map((override) => occurrenceKey(override.recurrenceId!)))
    for (const occurrence of occurrences) {
      if (replaced.has(occurrenceKey(occurrence.originalStart))) continue
      result.push({
        ...event, id: occurrenceEventId(event.id, occurrence.originalStart), start: occurrence.start, end: occurrence.end,
        originalStart: occurrence.originalStart, occurrenceOf: event.id, seriesId: event.id
      })
    }
  }
  return result
}

// Wall-clock helpers used to apply an occurrence edit to a whole series in the event's own zone.
export function eventZone(event: Pick<CalendarEvent, 'timeZone'>, fallback?: string) {
  return resolveTimeZoneName(event.timeZone) ?? resolveTimeZoneName(fallback) ?? localTimeZone()
}

export function wallParts(value: string, zone: string) {
  if (DATE_ONLY.test(value)) return { day: dayFromIso(value), hour: 0, minute: 0, second: 0 }
  const wall = wallTimeInZone(Date.parse(value), zone)
  return { day: wallDay(wall), hour: wall.hour, minute: wall.minute, second: wall.second }
}

export function instantFromParts(parts: { day: number; hour: number; minute: number; second: number }, zone: string) {
  return new Date(wallTimeToUtc({ ...civilWall(parts.day), hour: parts.hour, minute: parts.minute, second: parts.second }, zone)).toISOString()
}

export const addDaysIso = (value: string, days: number) => isoDay(dayFromIso(value) + days)

// RRULE UNTIL value that ends a series just before `originalStart`.
export function untilBefore(originalStart: string, allDay: boolean) {
  if (allDay || DATE_ONLY.test(originalStart)) return addDaysIso(originalStart.slice(0, 10), -1).replace(/-/g, '')
  return new Date(Date.parse(originalStart) - 1_000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}
