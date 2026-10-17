import { describe, expect, it } from 'vitest'
import type { CalendarEvent } from '../types'
import {
  describeRecurrence, expandCalendarEvents, expandEventOccurrences, formatRecurrenceRule, occurrencesBefore,
  parseRecurrenceRule, simpleRecurrenceFor, untilBefore
} from './recurrence'
import { wallTimeInZone } from './time-zones'

const event = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 'master', calendarId: 'local', title: 'Standup', start: '2026-03-02T14:00:00.000Z', end: '2026-03-02T14:30:00.000Z',
  color: '#000', attendees: [], reminderMinutes: 0, recurrence: 'none', ...overrides
})
const starts = (value: CalendarEvent, from: string, to: string, timeZone = 'UTC') =>
  expandEventOccurrences(value, from, to, { timeZone })?.map((occurrence) => occurrence.start)
const wall = (iso: string, zone: string) => {
  const value = wallTimeInZone(Date.parse(iso), zone)
  return `${value.year}-${String(value.month).padStart(2, '0')}-${String(value.day).padStart(2, '0')} ${String(value.hour).padStart(2, '0')}:${String(value.minute).padStart(2, '0')}`
}

describe('recurrence rules', () => {
  it('parses, formats, and describes supported rules', () => {
    const rule = parseRecurrenceRule('RRULE:FREQ=MONTHLY;INTERVAL=2;BYDAY=-1FR;COUNT=6')!
    expect(rule).toMatchObject({ freq: 'MONTHLY', interval: 2, count: 6, byDay: [{ weekday: 5, ordinal: -1 }], unsupported: [] })
    expect(formatRecurrenceRule(rule)).toBe('FREQ=MONTHLY;INTERVAL=2;COUNT=6;BYDAY=-1FR')
    expect(describeRecurrence(rule)).toBe('Every 2 months on the last Friday, 6 times')
    expect(describeRecurrence(parseRecurrenceRule('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;UNTIL=20261231'))).toBe('Every week on weekdays, until 31 Dec 2026')
    expect(describeRecurrence(parseRecurrenceRule('FREQ=YEARLY;BYMONTH=11;BYDAY=4TH'))).toBe('Every year on the fourth Thursday in November')
    expect(describeRecurrence(parseRecurrenceRule('FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1'))).toBe('Every month on the last weekday')
    expect(describeRecurrence(undefined)).toBe('Doesn’t repeat')
  })

  it('reports and preserves parts it cannot evaluate', () => {
    const rule = parseRecurrenceRule('FREQ=DAILY;BYHOUR=9,17')!
    expect(rule.unsupported).toEqual(['BYHOUR'])
    expect(formatRecurrenceRule(rule)).toBe('FREQ=DAILY;BYHOUR=9,17')
    expect(describeRecurrence(rule)).toMatch(/^Custom rule/)
    expect(parseRecurrenceRule('FREQ=HOURLY')!.unsupported).toEqual(['FREQ=HOURLY'])
    expect(parseRecurrenceRule('FREQ=WEEKLY;BYDAY=2MO')!.unsupported).toEqual(['BYDAY'])
    expect(parseRecurrenceRule('FREQ=WEEKLY;COUNT=2;UNTIL=20260101')).toBeUndefined()
    expect(expandEventOccurrences(event({ recurrenceRule: 'FREQ=HOURLY;COUNT=3' }), '2026-03-01', '2026-04-01')).toBeUndefined()
  })

  it('maps only exactly equivalent rules to the legacy repeat value', () => {
    expect(simpleRecurrenceFor(parseRecurrenceRule('FREQ=WEEKLY'))).toBe('weekly')
    expect(simpleRecurrenceFor(parseRecurrenceRule('FREQ=WEEKLY;INTERVAL=2'))).toBe('none')
    expect(simpleRecurrenceFor(parseRecurrenceRule('FREQ=YEARLY'))).toBe('none')
    expect(simpleRecurrenceFor(parseRecurrenceRule('FREQ=DAILY;COUNT=3'))).toBe('none')
  })
})

describe('recurrence expansion', () => {
  it('expands intervals, weekdays, COUNT, and UNTIL', () => {
    const weekly = event({ recurrenceRule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;COUNT=5', timeZone: 'UTC' })
    expect(starts(weekly, '2026-03-01T00:00:00Z', '2026-06-01T00:00:00Z')).toEqual([
      '2026-03-02T14:00:00.000Z', '2026-03-05T14:00:00.000Z', '2026-03-16T14:00:00.000Z', '2026-03-19T14:00:00.000Z', '2026-03-30T14:00:00.000Z'
    ])
    const until = event({ recurrenceRule: 'FREQ=DAILY;UNTIL=20260304T140000Z', timeZone: 'UTC' })
    expect(starts(until, '2026-03-01T00:00:00Z', '2026-04-01T00:00:00Z')).toHaveLength(3)
    const dateUntil = event({ recurrenceRule: 'FREQ=DAILY;UNTIL=20260304', timeZone: 'UTC' })
    expect(starts(dateUntil, '2026-03-01T00:00:00Z', '2026-04-01T00:00:00Z')).toHaveLength(3)
    // A window far from the start does not require walking every earlier period.
    expect(starts(event({ recurrence: 'daily', timeZone: 'UTC' }), '2036-03-02T00:00:00Z', '2036-03-04T00:00:00Z')).toEqual([
      '2036-03-02T14:00:00.000Z', '2036-03-03T14:00:00.000Z'
    ])
  })

  it('expands monthly and yearly day rules, skipping dates that do not exist', () => {
    const monthEnd = event({ start: '2026-01-31T09:00:00.000Z', end: '2026-01-31T10:00:00.000Z', recurrence: 'monthly', timeZone: 'UTC' })
    expect(starts(monthEnd, '2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z')!.map((value) => value.slice(0, 10))).toEqual(['2026-01-31', '2026-03-31', '2026-05-31'])
    const lastDay = event({ start: '2026-01-31T09:00:00.000Z', end: '2026-01-31T10:00:00.000Z', recurrenceRule: 'FREQ=MONTHLY;BYMONTHDAY=-1', timeZone: 'UTC' })
    expect(starts(lastDay, '2026-01-01T00:00:00Z', '2026-04-01T00:00:00Z')!.map((value) => value.slice(0, 10))).toEqual(['2026-01-31', '2026-02-28', '2026-03-31'])
    const thanksgiving = event({ start: '2026-11-26T17:00:00.000Z', end: '2026-11-26T18:00:00.000Z', recurrenceRule: 'FREQ=YEARLY;BYMONTH=11;BYDAY=4TH', timeZone: 'UTC' })
    expect(starts(thanksgiving, '2026-01-01T00:00:00Z', '2029-12-31T00:00:00Z')!.map((value) => value.slice(0, 10))).toEqual(['2026-11-26', '2027-11-25', '2028-11-23', '2029-11-22'])
    const leap = event({ allDay: true, start: '2024-02-29', end: '2024-03-01', recurrenceRule: 'FREQ=YEARLY' })
    expect(starts(leap, '2024-01-01T00:00:00Z', '2033-01-01T00:00:00Z')).toEqual(['2024-02-29', '2028-02-29', '2032-02-29'])
    const lastWeekday = event({ start: '2026-01-30T09:00:00.000Z', end: '2026-01-30T10:00:00.000Z', recurrenceRule: 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1', timeZone: 'UTC' })
    expect(starts(lastWeekday, '2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z')!.map((value) => value.slice(0, 10))).toEqual(['2026-01-30', '2026-02-27', '2026-03-31', '2026-04-30', '2026-05-29'])
  })

  it('keeps wall-clock time across America/New_York spring and fall transitions', () => {
    const standup = event({ start: '2026-03-06T14:00:00.000Z', end: '2026-03-06T14:30:00.000Z', recurrence: 'daily', timeZone: 'America/New_York' })
    const march = expandEventOccurrences(standup, '2026-03-06T00:00:00Z', '2026-03-10T00:00:00Z')!
    expect(march.map((occurrence) => occurrence.start)).toEqual([
      '2026-03-06T14:00:00.000Z', '2026-03-07T14:00:00.000Z', '2026-03-08T13:00:00.000Z', '2026-03-09T13:00:00.000Z'
    ])
    expect(march.every((occurrence) => wall(occurrence.start, 'America/New_York').endsWith('09:00'))).toBe(true)
    expect(march.every((occurrence) => Date.parse(occurrence.end) - Date.parse(occurrence.start) === 30 * 60_000)).toBe(true)
    const fall = expandEventOccurrences({ ...standup, start: '2026-10-30T13:00:00.000Z', end: '2026-10-30T13:30:00.000Z' }, '2026-10-30T00:00:00Z', '2026-11-03T00:00:00Z')!
    expect(fall.map((occurrence) => wall(occurrence.start, 'America/New_York'))).toEqual(['2026-10-30 09:00', '2026-10-31 09:00', '2026-11-01 09:00', '2026-11-02 09:00'])
    expect(fall[2].start).toBe('2026-11-01T14:00:00.000Z')
  })

  it('handles Europe/London transitions and nonexistent local times', () => {
    const weekly = event({ start: '2026-03-22T09:30:00.000Z', end: '2026-03-22T10:30:00.000Z', recurrence: 'weekly', timeZone: 'Europe/London' })
    expect(starts(weekly, '2026-03-20T00:00:00Z', '2026-04-01T00:00:00Z')).toEqual(['2026-03-22T09:30:00.000Z', '2026-03-29T08:30:00.000Z'])
    // 01:30 does not exist on 29 March 2026 in London; the occurrence moves forward rather than disappearing.
    const early = event({ start: '2026-03-28T01:30:00.000Z', end: '2026-03-28T02:00:00.000Z', recurrence: 'daily', timeZone: 'Europe/London' })
    const gap = expandEventOccurrences(early, '2026-03-28T00:00:00Z', '2026-03-31T00:00:00Z')!
    expect(gap).toHaveLength(3)
    expect(wall(gap[1].start, 'Europe/London')).toBe('2026-03-29 02:30')
    expect(wall(gap[2].start, 'Europe/London')).toBe('2026-03-30 01:30')
  })

  it('keeps zone-named events anchored when the viewer travels', () => {
    const tokyo = event({ start: '2026-07-01T00:00:00.000Z', end: '2026-07-01T01:00:00.000Z', recurrence: 'weekly', timeZone: 'Asia/Tokyo' })
    const fromLondon = starts(tokyo, '2026-07-01T00:00:00Z', '2026-07-16T00:00:00Z', 'Europe/London')
    const fromLosAngeles = starts(tokyo, '2026-07-01T00:00:00Z', '2026-07-16T00:00:00Z', 'America/Los_Angeles')
    expect(fromLondon).toEqual(fromLosAngeles)
    expect(fromLondon!.every((value) => wall(value, 'Asia/Tokyo').endsWith('09:00'))).toBe(true)
    // Floating events follow the viewer's zone instead.
    const floating = event({ start: '2026-07-01T08:00:00.000Z', end: '2026-07-01T09:00:00.000Z', recurrence: 'daily' })
    expect(wall(starts(floating, '2026-07-02T00:00:00Z', '2026-07-03T00:00:00Z', 'Europe/London')![0], 'Europe/London')).toBe('2026-07-02 09:00')
  })

  it('expands all-day dates as dates in every zone, including multi-day spans', () => {
    const holiday = event({ allDay: true, start: '2026-12-24', end: '2026-12-26', recurrenceRule: 'FREQ=YEARLY;COUNT=3' })
    for (const zone of ['Pacific/Auckland', 'America/Los_Angeles', 'UTC']) {
      expect(expandEventOccurrences(holiday, '2026-01-01T00:00:00Z', '2030-01-01T00:00:00Z', { timeZone: zone })).toEqual([
        { start: '2026-12-24', end: '2026-12-26', originalStart: '2026-12-24' },
        { start: '2027-12-24', end: '2027-12-26', originalStart: '2027-12-24' },
        { start: '2028-12-24', end: '2028-12-26', originalStart: '2028-12-24' }
      ])
    }
    expect(starts(event({ allDay: true, start: '2026-03-02', end: '2026-03-03', recurrence: 'weekly', recurrenceExceptions: ['2026-03-09'] }), '2026-03-01T00:00:00Z', '2026-03-20T00:00:00Z'))
      .toEqual(['2026-03-02', '2026-03-16'])
  })

  it('applies exceptions after COUNT and replaces overridden occurrences', () => {
    const master = event({ recurrenceRule: 'FREQ=DAILY;COUNT=4', timeZone: 'UTC', sourceUid: 'uid-1', recurrenceExceptions: ['2026-03-03T14:00:00.000Z'] })
    const override = event({ id: 'moved', title: 'Moved standup', start: '2026-03-04T16:00:00.000Z', end: '2026-03-04T16:30:00.000Z', sourceUid: 'uid-1', recurrenceId: '2026-03-04T14:00:00.000Z' })
    const expanded = expandCalendarEvents([master, override], '2026-03-01T00:00:00Z', '2026-04-01T00:00:00Z', { timeZone: 'UTC' })
    expect(expanded.map((item) => [item.id, item.start])).toEqual([
      ['master::1772460000000', '2026-03-02T14:00:00.000Z'],
      ['master::1772719200000', '2026-03-05T14:00:00.000Z'],
      ['moved', '2026-03-04T16:00:00.000Z']
    ])
    expect(expanded[0]).toMatchObject({ occurrenceOf: 'master', seriesId: 'master', originalStart: '2026-03-02T14:00:00.000Z' })
    // Provider-expanded instances are left alone when the caller opts out.
    expect(expandCalendarEvents([master], '2026-03-01', '2026-04-01', { expand: () => false })).toEqual([master])
  })

  it('bounds expansion and counts occurrences before a split', () => {
    const daily = event({ recurrence: 'daily', timeZone: 'UTC' })
    expect(expandEventOccurrences(daily, '2026-03-01T00:00:00Z', '2036-03-01T00:00:00Z')).toHaveLength(1_000)
    expect(expandEventOccurrences(daily, '2026-03-01T00:00:00Z', '2036-03-01T00:00:00Z', { maxOccurrences: 10 })).toHaveLength(10)
    expect(starts(event({ recurrenceRule: 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30', timeZone: 'UTC' }), '2026-03-03T00:00:00Z', '2030-01-01T00:00:00Z')).toEqual([])
    expect(occurrencesBefore(event({ recurrenceRule: 'FREQ=DAILY;COUNT=10', timeZone: 'UTC' }), '2026-03-05T14:00:00.000Z')).toBe(3)
    expect(occurrencesBefore(event({ allDay: true, start: '2026-03-02', end: '2026-03-03', recurrence: 'weekly' }), '2026-03-16')).toBe(2)
    expect(untilBefore('2026-03-05T14:00:00.000Z', false)).toBe('20260305T135959Z')
    expect(untilBefore('2026-03-05', true)).toBe('20260304')
  })
})
