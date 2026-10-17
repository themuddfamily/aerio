import { describe, expect, it } from 'vitest'
import type { CalendarEvent } from '../../src/types'
import type { SyncedCalendarEvent } from '../../src/productivity-types'
import { findEventDuplicates, type EventCalendarRef } from './event-duplicates'

const local: EventCalendarRef = { id: 'cal', label: 'Home', ownerLabel: 'Calendars on this PC', source: 'local' }
const google: EventCalendarRef = { id: 'cal', label: 'Work', ownerLabel: 'ada@example.com', source: 'provider' }

const event = (id: string, overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id, calendarId: 'cal', title: 'Standup', start: '2026-10-05T09:00:00.000Z', end: '2026-10-05T09:15:00.000Z', color: '#000', attendees: [], reminderMinutes: 10, ...overrides
})
const synced = (id: string, overrides: Partial<SyncedCalendarEvent> = {}): SyncedCalendarEvent => ({
  ...event(id), remoteId: id, accountId: 'acc', provider: 'gmail', readOnly: false, ...overrides
})

describe('event duplicate scanner', () => {
  it('groups the same UID and occurrence, and the same title, start, end, and location', () => {
    const groups = findEventDuplicates(local, [
      event('a', { sourceUid: 'uid-1', location: 'Room 1', description: 'Agenda' }),
      event('b', { sourceUid: 'uid-1', location: 'Room 1' }),
      event('c', { title: 'Lunch', start: '2026-10-05T12:00:00.000Z', end: '2026-10-05T13:00:00.000Z' }),
      event('d', { title: '  lunch ', start: '2026-10-05T12:00:00Z', end: '2026-10-05T13:00:00Z' })
    ])
    expect(groups).toHaveLength(2)
    const byUid = groups.find((group) => group.items.some((item) => item.id === 'event:a'))!
    expect(byUid).toMatchObject({ confidence: 'high', codes: ['ical-uid', 'event-details'] })
    // The copy with a description is more complete.
    expect(byUid.keeperId).toBe('event:a')
    const byDetails = groups.find((group) => group.items.some((item) => item.id === 'event:c'))!
    expect(byDetails).toMatchObject({ confidence: 'medium', codes: ['event-details'] })
  })

  it('does not group look-alike events (false-positive fixtures)', () => {
    const groups = findEventDuplicates(local, [
      event('a'),
      event('b', { start: '2026-10-06T09:00:00.000Z', end: '2026-10-06T09:15:00.000Z' }),
      event('c', { location: 'Room 2' }),
      event('d', { end: '2026-10-05T09:30:00.000Z' }),
      event('e', { calendarId: 'other' })
    ])
    expect(groups).toEqual([])
  })

  it('compares repeating series as a whole and never matches an exception with its master', () => {
    const master = event('m1', { sourceUid: 'series-1', recurrenceRule: 'FREQ=WEEKLY;COUNT=4' })
    const exception = event('x1', { sourceUid: 'series-1', recurrenceId: '2026-10-12T09:00:00.000Z', start: '2026-10-12T10:00:00.000Z', end: '2026-10-12T10:15:00.000Z' })
    // A standalone event identical to the master's first occurrence is not a duplicate of the series.
    const lookalike = event('single')
    const copyMaster = event('m2', { sourceUid: 'series-2', recurrenceRule: 'FREQ=WEEKLY;COUNT=4' })
    const copyException = event('x2', { sourceUid: 'series-2', recurrenceId: '2026-10-12T09:00:00.000Z', start: '2026-10-12T10:00:00.000Z', end: '2026-10-12T10:15:00.000Z' })
    const groups = findEventDuplicates(local, [master, exception, lookalike, copyMaster, copyException])
    expect(groups).toHaveLength(1)
    expect(groups[0].items.map((item) => item.id).sort()).toEqual(['series:cal:m1', 'series:cal:m2'])
    expect(groups[0].items.find((item) => item.id === 'series:cal:m1')!.eventIds.sort()).toEqual(['m1', 'x1'])
    expect(groups[0].notes.join(' ')).toMatch(/whole series/)
    expect(groups[0].items.every((item) => item.removable)).toBe(true)
  })

  it('keeps series with different exceptions apart', () => {
    const groups = findEventDuplicates(local, [
      event('m1', { sourceUid: 'series-1', recurrenceRule: 'FREQ=WEEKLY;COUNT=4' }),
      event('x1', { sourceUid: 'series-1', recurrenceId: '2026-10-12T09:00:00.000Z', start: '2026-10-12T10:00:00.000Z', end: '2026-10-12T10:15:00.000Z' }),
      event('m2', { sourceUid: 'series-2', recurrenceRule: 'FREQ=WEEKLY;COUNT=4' })
    ])
    expect(groups).toEqual([])
  })

  it('treats provider instances of one series as a unit and lists synchronized series for review only', () => {
    const instances = (series: string, uid: string) => [0, 7].map((day) => synced(`${series}-${day}`, {
      seriesId: series, icalUid: uid,
      originalStart: `2026-10-${String(5 + day).padStart(2, '0')}T09:00:00.000Z`,
      start: `2026-10-${String(5 + day).padStart(2, '0')}T09:00:00.000Z`, end: `2026-10-${String(5 + day).padStart(2, '0')}T09:15:00.000Z`
    }))
    const groups = findEventDuplicates(google, [...instances('s1', 'uid-a'), ...instances('s2', 'uid-b')])
    expect(groups).toHaveLength(1)
    expect(groups[0].items.map((item) => item.eventIds.length)).toEqual([2, 2])
    expect(groups[0].items.every((item) => !item.removable && /review only/.test(item.blockedReason!))).toBe(true)
    // Two instances of the same series share a UID but are different occurrences.
    expect(findEventDuplicates(google, instances('s1', 'uid-a'))).toEqual([])
  })

  it('marks read-only events as not removable and suggests them as the copy to keep', () => {
    const [group] = findEventDuplicates(google, [synced('mine'), synced('invite', { readOnly: true })])
    expect(group.items.find((item) => item.id === 'event:invite')).toMatchObject({ removable: false })
    expect(group.keeperId).toBe('event:invite')
  })
})
