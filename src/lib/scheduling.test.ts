import { describe, expect, it } from 'vitest'
import type { AttendeeAvailability } from '../scheduling-types'
import {
  DEFAULT_WORKING_HOURS, addZonedDays, formatZoneTime, parseAttendeeText, startOfZonedDay, statusDuring, suggestSlots, withinWorkingHours
} from './scheduling'

const at = (iso: string) => Date.parse(iso)
const known = (email: string, busy: AttendeeAvailability['busy'] = [], workingHours?: AttendeeAvailability['workingHours']): AttendeeAvailability =>
  ({ email, known: true, busy, ...(workingHours ? { workingHours } : {}) })

describe('scheduling helpers', () => {
  it('parses attendee text with commas, semicolons, and display names', () => {
    expect(parseAttendeeText('a@x.com, Bo <b@y.com>;\n c@z.com,,')).toEqual(['a@x.com', 'Bo <b@y.com>', 'c@z.com'])
  })

  it('finds zoned day starts across daylight-saving changes', () => {
    const start = startOfZonedDay(at('2026-11-01T15:00:00Z'), 'America/New_York')
    expect(new Date(start).toISOString()).toBe('2026-11-01T04:00:00.000Z')
    // The fall-back day is 25 hours long.
    expect(new Date(addZonedDays(start, 1, 'America/New_York')).toISOString()).toBe('2026-11-02T05:00:00.000Z')
    expect(formatZoneTime(at('2026-11-02T14:00:00Z'), 'America/New_York')).toBe('09:00')
  })

  it('checks working hours in the hours’ own time zone', () => {
    const hours = { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', timeZone: 'America/New_York' }
    // Tuesday 20 Oct 2026, 09:00–10:00 New York (13:00Z).
    expect(withinWorkingHours(at('2026-10-20T13:00:00Z'), at('2026-10-20T14:00:00Z'), hours)).toBe(true)
    expect(withinWorkingHours(at('2026-10-20T12:30:00Z'), at('2026-10-20T13:30:00Z'), hours)).toBe(false)
    expect(withinWorkingHours(at('2026-10-20T20:30:00Z'), at('2026-10-20T21:00:00Z'), hours)).toBe(true)
    expect(withinWorkingHours(at('2026-10-20T20:30:00Z'), at('2026-10-20T21:30:00Z'), hours)).toBe(false)
    // Saturday.
    expect(withinWorkingHours(at('2026-10-24T14:00:00Z'), at('2026-10-24T15:00:00Z'), hours)).toBe(false)
    expect(withinWorkingHours(0, 1, undefined)).toBe(true)
  })

  it('reports the most significant overlapping status and never treats unknown as free', () => {
    const person = known('a@x.com', [
      { start: '2026-10-20T09:00:00Z', end: '2026-10-20T10:00:00Z', status: 'tentative' },
      { start: '2026-10-20T09:30:00Z', end: '2026-10-20T10:00:00Z', status: 'busy' }
    ])
    expect(statusDuring(person, at('2026-10-20T09:00:00Z'), at('2026-10-20T09:30:00Z'))).toBe('tentative')
    expect(statusDuring(person, at('2026-10-20T09:00:00Z'), at('2026-10-20T10:00:00Z'))).toBe('busy')
    expect(statusDuring(person, at('2026-10-20T10:00:00Z'), at('2026-10-20T10:30:00Z'))).toBe('free')
    expect(statusDuring({ email: 'b@x.com', known: false, reason: 'external', busy: [] }, 0, 1)).toBe('unknown')
    expect(statusDuring(undefined, 0, 1)).toBe('unknown')
  })

  it('suggests the next slots where every required attendee and resource is free', () => {
    const workingHours = DEFAULT_WORKING_HOURS('UTC')
    const slots = suggestSlots({
      participants: [
        { email: 'me@x.com', role: 'required' },
        { email: 'Ann <ann@x.com>', role: 'required' },
        { email: 'room@x.com', role: 'resource' },
        { email: 'opt@x.com', role: 'optional' }
      ],
      availability: [
        known('me@x.com', [{ start: '2026-10-20T09:00:00Z', end: '2026-10-20T10:00:00Z', status: 'busy' }]),
        known('ann@x.com', [{ start: '2026-10-20T10:00:00Z', end: '2026-10-20T11:00:00Z', status: 'oof' }]),
        known('room@x.com', [{ start: '2026-10-20T11:00:00Z', end: '2026-10-20T11:30:00Z', status: 'busy' }]),
        known('opt@x.com', [{ start: '2026-10-20T11:30:00Z', end: '2026-10-20T12:30:00Z', status: 'busy' }])
      ],
      durationMinutes: 60,
      from: at('2026-10-20T00:00:00Z'),
      to: at('2026-10-21T00:00:00Z'),
      workingHours,
      limit: 3
    })
    expect(slots.map((slot) => new Date(slot.start).toISOString())).toEqual([
      '2026-10-20T11:30:00.000Z', '2026-10-20T12:30:00.000Z', '2026-10-20T13:30:00.000Z'
    ])
    expect(slots[0]).toMatchObject({ optionalConflicts: ['opt@x.com'], unverified: [] })
    expect(slots[1].optionalConflicts).toEqual([])
  })

  it('keeps to attendee working hours, skips the past, and flags unverified attendees', () => {
    const slots = suggestSlots({
      participants: [
        { email: 'la@x.com', role: 'required' },
        { email: 'external@other.org', role: 'required' }
      ],
      availability: [
        known('la@x.com', [], { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', timeZone: 'America/Los_Angeles' }),
        { email: 'external@other.org', known: false, reason: 'external', busy: [] }
      ],
      durationMinutes: 30,
      from: at('2026-10-20T00:00:00Z'),
      to: at('2026-10-22T00:00:00Z'),
      workingHours: DEFAULT_WORKING_HOURS('UTC'),
      now: at('2026-10-20T16:10:00Z'),
      limit: 2
    })
    // UTC working hours end at 17:00Z; Los Angeles starts at 16:00Z. "now" rounds up to 16:30Z.
    expect(slots.map((slot) => new Date(slot.start).toISOString())).toEqual(['2026-10-20T16:30:00.000Z', '2026-10-21T16:00:00.000Z'])
    expect(slots[0].unverified).toEqual(['external@other.org'])
  })

  it('returns nothing when no working time is left', () => {
    expect(suggestSlots({
      participants: [{ email: 'a@x.com', role: 'required' }],
      availability: [known('a@x.com')],
      durationMinutes: 60,
      from: at('2026-10-24T00:00:00Z'),
      to: at('2026-10-26T00:00:00Z'),
      workingHours: DEFAULT_WORKING_HOURS('UTC')
    })).toEqual([])
  })
})
