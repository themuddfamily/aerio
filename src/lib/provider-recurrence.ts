// Conversions between RFC 5545 rules and provider recurrence formats: Google keeps RRULE/EXDATE lines,
// Microsoft Graph uses patternedRecurrence. Rules a provider cannot express are reported instead of dropped.
import { formatRecurrenceRule, newRecurrenceRule, parseRecurrenceRule, untilDate, type WeekdayRule } from './recurrence'

export interface GraphRecurrencePattern {
  type?: string
  interval?: number
  month?: number
  dayOfMonth?: number
  daysOfWeek?: string[]
  firstDayOfWeek?: string
  index?: string
}

export interface GraphRecurrenceRange {
  type?: string
  startDate?: string
  endDate?: string
  numberOfOccurrences?: number
  recurrenceTimeZone?: string
}

export interface GraphRecurrence {
  pattern?: GraphRecurrencePattern
  range?: GraphRecurrenceRange
}

export class UnsupportedRecurrenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedRecurrenceError'
  }
}

const GRAPH_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const GRAPH_INDEX: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, last: -1 }
const INDEX_NAMES: Record<number, string> = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', [-1]: 'last' }

// --- Google ---------------------------------------------------------------------------------

export function googleRecurrenceRule(lines: string[] | undefined) {
  const line = lines?.find((value) => /^RRULE:/i.test(value))
  const rule = line ? parseRecurrenceRule(line) : undefined
  return rule ? formatRecurrenceRule(rule) : undefined
}

// Replaces only the RRULE line, keeping EXDATE/RDATE lines Google already stores for the series.
export function replaceGoogleRecurrenceRule(lines: string[] | undefined, rule: string) {
  const others = (lines ?? []).filter((value) => !/^RRULE:/i.test(value))
  return [`RRULE:${rule}`, ...others]
}

// --- Microsoft Graph --------------------------------------------------------------------------

const graphDay = (value: string) => GRAPH_DAYS.indexOf(value.toLowerCase())

export function graphRecurrenceToRule(recurrence: GraphRecurrence | null | undefined): string | undefined {
  const pattern = recurrence?.pattern
  const type = pattern?.type
  if (!pattern || !type) return undefined
  const days = (pattern.daysOfWeek ?? []).map(graphDay).filter((day) => day >= 0)
  const ordinal = pattern.index ? GRAPH_INDEX[pattern.index.toLowerCase()] : undefined
  const interval = Math.max(1, Number(pattern.interval ?? 1))
  const ordinalDays = (): { byDay: WeekdayRule[]; bySetPos: number[] } => days.length === 1 || ordinal === undefined
    ? { byDay: days.map((weekday) => ({ weekday, ...(ordinal !== undefined ? { ordinal } : {}) })), bySetPos: [] }
    : { byDay: days.map((weekday) => ({ weekday })), bySetPos: [ordinal] }
  let rule
  if (type === 'daily') rule = newRecurrenceRule('DAILY', { interval })
  else if (type === 'weekly') {
    rule = newRecurrenceRule('WEEKLY', { interval, byDay: days.map((weekday) => ({ weekday })) })
    const weekStart = pattern.firstDayOfWeek ? graphDay(pattern.firstDayOfWeek) : 0
    rule.weekStart = weekStart >= 0 ? weekStart : 0
  } else if (type === 'absoluteMonthly') rule = newRecurrenceRule('MONTHLY', { interval, byMonthDay: pattern.dayOfMonth ? [pattern.dayOfMonth] : [] })
  else if (type === 'relativeMonthly') rule = newRecurrenceRule('MONTHLY', { interval, ...ordinalDays() })
  else if (type === 'absoluteYearly') {
    rule = newRecurrenceRule('YEARLY', { interval, byMonth: pattern.month ? [pattern.month] : [], byMonthDay: pattern.dayOfMonth ? [pattern.dayOfMonth] : [] })
  } else if (type === 'relativeYearly') rule = newRecurrenceRule('YEARLY', { interval, byMonth: pattern.month ? [pattern.month] : [], ...ordinalDays() })
  else return undefined
  const range = recurrence?.range
  if (range?.type === 'endDate' && range.endDate) rule.until = range.endDate.replace(/-/g, '')
  else if (range?.type === 'numbered' && range.numberOfOccurrences) rule.count = range.numberOfOccurrences
  return formatRecurrenceRule(rule)
}

// Builds Graph patternedRecurrence for a rule. `startDate` is the first occurrence's date in `timeZone`.
export function ruleToGraphRecurrence(value: string, startDate: string, timeZone: string): GraphRecurrence {
  const rule = parseRecurrenceRule(value)
  if (!rule) throw new UnsupportedRecurrenceError('This repeat rule could not be read')
  const reject = (reason: string): never => { throw new UnsupportedRecurrenceError(`Microsoft Calendar cannot store this repeat rule (${reason}); it was left unchanged`) }
  if (rule.unsupported.length) reject(rule.unsupported.join(', '))
  const [year, month, day] = startDate.split('-').map(Number)
  const startWeekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  const names = (items: WeekdayRule[]) => items.map((item) => GRAPH_DAYS[item.weekday])
  const plainDays = rule.byDay.every((item) => item.ordinal === undefined)
  const relative = (): Pick<GraphRecurrencePattern, 'daysOfWeek' | 'index'> => {
    if (rule.bySetPos.length > 1 || rule.byMonthDay.length) reject('combined day rules')
    if (rule.bySetPos.length) {
      if (!plainDays || !INDEX_NAMES[rule.bySetPos[0]]) reject('position')
      return { daysOfWeek: names(rule.byDay), index: INDEX_NAMES[rule.bySetPos[0]] }
    }
    const ordinals = [...new Set(rule.byDay.map((item) => item.ordinal))]
    if (ordinals.length !== 1 || ordinals[0] === undefined || !INDEX_NAMES[ordinals[0]]) reject('weekday position')
    return { daysOfWeek: names(rule.byDay), index: INDEX_NAMES[ordinals[0]!] }
  }
  let pattern: GraphRecurrencePattern
  if (rule.byMonth.length > 1 || rule.byMonthDay.length > 1) reject('multiple months or days')
  if (rule.freq === 'DAILY') {
    if (rule.byMonth.length || rule.byMonthDay.length || rule.bySetPos.length) reject('daily filters')
    pattern = rule.byDay.length
      ? rule.interval === 1 ? { type: 'weekly', interval: 1, daysOfWeek: names(rule.byDay), firstDayOfWeek: GRAPH_DAYS[rule.weekStart] } : reject('daily weekday interval')
      : { type: 'daily', interval: rule.interval }
  } else if (rule.freq === 'WEEKLY') {
    if (rule.byMonth.length || rule.bySetPos.length || !plainDays) reject('weekly filters')
    pattern = { type: 'weekly', interval: rule.interval, daysOfWeek: rule.byDay.length ? names(rule.byDay) : [GRAPH_DAYS[startWeekday]], firstDayOfWeek: GRAPH_DAYS[rule.weekStart] }
  } else if (rule.freq === 'MONTHLY') {
    if (rule.byMonth.length) reject('monthly month filter')
    if (rule.byDay.length) pattern = { type: 'relativeMonthly', interval: rule.interval, ...relative() }
    else {
      const dayOfMonth = rule.byMonthDay[0] ?? day
      if (dayOfMonth < 1) reject('days counted from month end')
      if (rule.bySetPos.length) reject('position')
      pattern = { type: 'absoluteMonthly', interval: rule.interval, dayOfMonth }
    }
  } else if (rule.freq === 'YEARLY') {
    const targetMonth = rule.byMonth[0] ?? month
    if (rule.byDay.length) pattern = { type: 'relativeYearly', interval: rule.interval, month: targetMonth, ...relative() }
    else {
      const dayOfMonth = rule.byMonthDay[0] ?? day
      if (dayOfMonth < 1) reject('days counted from month end')
      if (rule.bySetPos.length) reject('position')
      pattern = { type: 'absoluteYearly', interval: rule.interval, month: targetMonth, dayOfMonth }
    }
  } else reject(rule.freq)
  const range: GraphRecurrenceRange = { type: 'noEnd', startDate, recurrenceTimeZone: timeZone }
  if (rule.count !== undefined) Object.assign(range, { type: 'numbered', numberOfOccurrences: rule.count })
  else if (rule.until) Object.assign(range, { type: 'endDate', endDate: untilDate(rule.until) })
  return { pattern: pattern!, range }
}
