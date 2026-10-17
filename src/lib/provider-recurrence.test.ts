import { describe, expect, it } from 'vitest'
import { googleRecurrenceRule, graphRecurrenceToRule, replaceGoogleRecurrenceRule, ruleToGraphRecurrence, UnsupportedRecurrenceError } from './provider-recurrence'

describe('Google recurrence lines', () => {
  it('reads the RRULE and replaces it while keeping EXDATE lines', () => {
    const lines = ['EXDATE;TZID=America/New_York:20260310T090000', 'RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=8']
    expect(googleRecurrenceRule(lines)).toBe('FREQ=WEEKLY;COUNT=8;BYDAY=TU')
    expect(replaceGoogleRecurrenceRule(lines, 'FREQ=WEEKLY;UNTIL=20260401T000000Z;BYDAY=TU')).toEqual([
      'RRULE:FREQ=WEEKLY;UNTIL=20260401T000000Z;BYDAY=TU', 'EXDATE;TZID=America/New_York:20260310T090000'
    ])
    expect(googleRecurrenceRule(['EXDATE:20260101T000000Z'])).toBeUndefined()
  })
})

describe('Microsoft patternedRecurrence', () => {
  const cases: [string, Parameters<typeof graphRecurrenceToRule>[0]][] = [
    ['FREQ=DAILY;INTERVAL=3', { pattern: { type: 'daily', interval: 3 }, range: { type: 'noEnd', startDate: '2026-03-02' } }],
    ['FREQ=WEEKLY;INTERVAL=2;COUNT=6;BYDAY=MO,WE;WKST=SU', { pattern: { type: 'weekly', interval: 2, daysOfWeek: ['monday', 'wednesday'], firstDayOfWeek: 'sunday' }, range: { type: 'numbered', numberOfOccurrences: 6 } }],
    ['FREQ=MONTHLY;UNTIL=20261231;BYMONTHDAY=15', { pattern: { type: 'absoluteMonthly', interval: 1, dayOfMonth: 15 }, range: { type: 'endDate', endDate: '2026-12-31' } }],
    ['FREQ=MONTHLY;BYDAY=-1FR', { pattern: { type: 'relativeMonthly', interval: 1, daysOfWeek: ['friday'], index: 'last' } }],
    ['FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1', { pattern: { type: 'relativeMonthly', interval: 1, daysOfWeek: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'], index: 'first' } }],
    ['FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=14', { pattern: { type: 'absoluteYearly', interval: 1, month: 2, dayOfMonth: 14 } }],
    ['FREQ=YEARLY;BYMONTH=11;BYDAY=4TH', { pattern: { type: 'relativeYearly', interval: 1, month: 11, daysOfWeek: ['thursday'], index: 'fourth' } }]
  ]

  it('converts Graph patterns to RRULEs', () => {
    for (const [rule, recurrence] of cases) expect(graphRecurrenceToRule(recurrence)).toBe(rule)
    expect(graphRecurrenceToRule(null)).toBeUndefined()
    expect(graphRecurrenceToRule({ pattern: { type: 'hourly' } })).toBeUndefined()
  })

  it('round-trips RRULEs through Graph patterns', () => {
    for (const [rule] of cases) {
      const graph = ruleToGraphRecurrence(rule, '2026-03-02', 'Eastern Standard Time')
      expect(graph.range).toMatchObject({ startDate: '2026-03-02', recurrenceTimeZone: 'Eastern Standard Time' })
      expect(graphRecurrenceToRule(graph)).toBe(rule)
    }
  })

  it('fills defaults from the start date', () => {
    expect(ruleToGraphRecurrence('FREQ=WEEKLY', '2026-03-04', 'UTC').pattern).toMatchObject({ type: 'weekly', daysOfWeek: ['wednesday'] })
    expect(ruleToGraphRecurrence('FREQ=MONTHLY', '2026-03-04', 'UTC').pattern).toMatchObject({ type: 'absoluteMonthly', dayOfMonth: 4 })
    expect(ruleToGraphRecurrence('FREQ=YEARLY', '2026-03-04', 'UTC').pattern).toMatchObject({ type: 'absoluteYearly', month: 3, dayOfMonth: 4 })
    expect(ruleToGraphRecurrence('FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR', '2026-03-04', 'UTC').pattern).toMatchObject({ type: 'weekly', daysOfWeek: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'] })
  })

  it('refuses rules Graph cannot store instead of simplifying them', () => {
    for (const rule of ['FREQ=HOURLY', 'FREQ=DAILY;BYHOUR=9', 'FREQ=MONTHLY;BYMONTHDAY=1,15', 'FREQ=MONTHLY;BYMONTHDAY=-1', 'FREQ=MONTHLY;BYDAY=5MO', 'FREQ=YEARLY;BYMONTH=1,7', 'FREQ=DAILY;INTERVAL=2;BYDAY=MO']) {
      expect(() => ruleToGraphRecurrence(rule, '2026-03-02', 'UTC')).toThrow(UnsupportedRecurrenceError)
    }
  })
})
