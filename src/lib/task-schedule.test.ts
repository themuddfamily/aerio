import { describe, expect, it } from 'vitest'
import { advanceExtendedFields, advanceTaskStart, compactExtendedFields, describeTaskStart, nextTaskReminder, parseCategories, parseTaskStart, taskStartInstant, validTaskExtendedFields } from './task-schedule'
import { wallTimeInZone } from './time-zones'

const iso = (ms: number | undefined) => new Date(ms!).toISOString()

describe('task start and reminder scheduling', () => {
  it('parses all-day and wall-clock starts and rejects impossible dates', () => {
    expect(parseTaskStart('2026-10-12')).toMatchObject({ dateOnly: true, wall: { year: 2026, month: 10, day: 12, hour: 0 } })
    expect(parseTaskStart('2026-10-12T09:30')).toMatchObject({ dateOnly: false, wall: { hour: 9, minute: 30, second: 0 } })
    expect(parseTaskStart('2026-10-12T09:30:15.0000000')).toMatchObject({ wall: { second: 15 } })
    for (const invalid of ['2026-02-30', '2026-13-01', '2026-10-12T24:00', '2026-10-12T09:30Z', 'tomorrow', 42]) expect(parseTaskStart(invalid)).toBeUndefined()
  })

  it('reads timed starts in their zone across daylight-saving changes', () => {
    // 02:30 does not exist in New York on 8 March 2026; it moves forward to 03:30 EDT.
    expect(iso(taskStartInstant('2026-03-08T02:30', 'America/New_York'))).toBe('2026-03-08T07:30:00.000Z')
    expect(iso(taskStartInstant('2026-03-07T09:00', 'America/New_York'))).toBe('2026-03-07T14:00:00.000Z')
    expect(iso(taskStartInstant('2026-03-09T09:00', 'America/New_York'))).toBe('2026-03-09T13:00:00.000Z')
    // 01:30 occurs twice in London on 25 October 2026; the first (BST) occurrence is used.
    expect(iso(taskStartInstant('2026-10-25T01:30', 'Europe/London'))).toBe('2026-10-25T00:30:00.000Z')
    // All-day starts begin at midnight in the zone; Windows zone names resolve too.
    expect(iso(taskStartInstant('2026-07-01', 'Asia/Tokyo'))).toBe('2026-06-30T15:00:00.000Z')
    expect(iso(taskStartInstant('2026-07-01T09:00', 'GMT Standard Time'))).toBe('2026-07-01T08:00:00.000Z')
  })

  it('advances starts by calendar steps, clamping months', () => {
    expect(advanceTaskStart('2026-01-31', 'monthly')).toBe('2026-02-28')
    expect(advanceTaskStart('2028-01-31T08:00:00', 'monthly')).toBe('2028-02-29T08:00:00')
    expect(advanceTaskStart('2026-12-15T23:30:00', 'monthly')).toBe('2027-01-15T23:30:00')
    expect(advanceTaskStart('2026-03-07T09:00:00', 'daily')).toBe('2026-03-08T09:00:00')
    expect(advanceTaskStart('2026-12-29', 'weekly')).toBe('2027-01-05')
  })

  it('keeps a reminder at the same local offset from its due time across a DST change', () => {
    const zone = 'America/New_York'
    const due = taskStartInstant('2026-03-07T09:00', zone)!
    const nextDue = taskStartInstant('2026-03-08T09:00', zone)!
    const reminder = nextTaskReminder({ reminder: '2026-03-07T13:45:00.000Z', repeat: 'daily', anchor: due, nextAnchor: nextDue, zone })
    // 08:45 EST becomes 08:45 EDT: 12:45 UTC, not 13:45.
    expect(reminder).toBe('2026-03-08T12:45:00.000Z')
    expect(wallTimeInZone(Date.parse(reminder), zone)).toMatchObject({ hour: 8, minute: 45 })
    // "One day before" stays at the same wall-clock time the previous day.
    expect(nextTaskReminder({ reminder: '2026-03-06T14:00:00.000Z', repeat: 'daily', anchor: due, nextAnchor: nextDue, zone })).toBe('2026-03-07T14:00:00.000Z')
  })

  it('advances an unanchored reminder by wall-clock time in its zone', () => {
    expect(nextTaskReminder({ reminder: '2026-10-24T08:00:00.000Z', repeat: 'daily', zone: 'Europe/London' })).toBe('2026-10-25T09:00:00.000Z')
    expect(nextTaskReminder({ reminder: '2026-01-31T09:00:00.000Z', repeat: 'monthly', zone: 'UTC' })).toBe('2026-02-28T09:00:00.000Z')
  })

  it('carries extended fields to the next occurrence', () => {
    const attachment = { id: 'a', name: 'plan.pdf', size: 3, path: '/profile/task-attachments/a.pdf' }
    const next = advanceExtendedFields({ start: '2026-03-07T08:00:00', startTimeZone: 'America/New_York', reminder: '2026-03-07T12:50:00.000Z', percentComplete: 60, categories: ['Home'], attachments: [attachment] }, { repeat: 'daily' })
    // Without a due anchor the reminder keeps its offset from the start: 10 minutes before 08:00 local.
    expect(next).toEqual({ start: '2026-03-08T08:00:00', startTimeZone: 'America/New_York', reminder: '2026-03-08T11:50:00.000Z', percentComplete: 0, categories: ['Home'], attachments: [attachment] })
    expect(advanceExtendedFields(undefined, { repeat: 'weekly' })).toBeUndefined()
  })

  it('validates and normalizes provider-neutral fields', () => {
    const attachment = { id: 'a', name: 'plan.pdf', size: 3, path: '/profile/task-attachments/a.pdf', mime: 'pdf' }
    expect(validTaskExtendedFields({ start: '2026-10-12T09:00:00', startTimeZone: 'Europe/Paris', reminder: '2026-10-12T07:45:00.000Z', percentComplete: 40, categories: ['Work', 'Q4'], attachments: [attachment] })).toBe(true)
    for (const invalid of [
      { start: '2026-02-31' }, { startTimeZone: 'Mars/Olympus' }, { reminder: '2026-10-12T09:00:00' }, { reminder: '2026-10-12T09:00:00+02:00' },
      { percentComplete: 101 }, { percentComplete: 12.5 }, { categories: ['Work', 'work'] }, { categories: [' padded '] }, { categories: [''] },
      { attachments: [attachment, attachment] }, { attachments: [{ ...attachment, size: 26 * 1024 * 1024 }] }, { attachments: [{ ...attachment, extra: true }] }, { colour: 'red' }
    ]) expect(validTaskExtendedFields(invalid)).toBe(false)
    expect(validTaskExtendedFields({ percentComplete: 5, start: '2026-10-12' }, { allowed: ['percentComplete'] })).toBe(false)
    expect(validTaskExtendedFields({ attachments: [attachment] }, { attachmentPath: (path) => path.startsWith('/managed/') })).toBe(false)
    expect(parseCategories(' Work, home,,work , Q4 ')).toEqual(['Work', 'home', 'Q4'])
    expect(compactExtendedFields({ start: '2026-10-12', startTimeZone: 'Europe/Paris', categories: [], attachments: [] })).toEqual({ start: '2026-10-12' })
    expect(compactExtendedFields({ categories: [] })).toBeUndefined()
    expect(describeTaskStart('2026-10-12T09:30:00', 'Europe/Paris')).toBe('12 Oct 2026, 09:30 (Europe/Paris)')
  })
})
