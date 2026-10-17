import { describe, expect, it } from 'vitest'
import type { CalendarEvent } from '../types'
import { icsEventToCalendarEvent, parseIcs, serializeIcs } from './ics'

const event = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 'event-1', calendarId: 'local', title: 'Planning', start: '2026-03-10T14:00:00.000Z', end: '2026-03-10T15:00:00.000Z',
  color: '#000', attendees: [], reminderMinutes: 0, recurrence: 'none', ...overrides
})

describe('ICS meeting details', () => {
  it('round-trips organizer, attendee roles, resource kinds, responses, RSVP, and SEQUENCE', () => {
    const meeting = event({
      sourceUid: 'meet@example.test', sequence: 3,
      organizer: { email: 'ada@example.test', name: 'Ada; Countess' },
      attendees: ['ada@example.test', 'grace@example.test', 'room@example.test', 'plain@example.test'],
      attendeeDetails: [
        { email: 'ada@example.test', role: 'chair', response: 'accepted' },
        { email: 'grace@example.test', name: 'Grace', role: 'optional', response: 'tentative', rsvp: true },
        { email: 'room@example.test', role: 'non-participant', kind: 'room' }
      ]
    })
    const text = serializeIcs([meeting])
    const unfolded = text.replace(/\r\n /g, '')
    expect(unfolded).toContain('ATTENDEE;CN=Grace;ROLE=OPT-PARTICIPANT;PARTSTAT=TENTATIVE;RSVP=TRUE:mailto:grace@example.test')
    expect(text).toContain('ORGANIZER;CN="Ada; Countess":mailto:ada@example.test')
    expect(text).toContain('SEQUENCE:3')
    expect(text).toContain('ATTENDEE;ROLE=NON-PARTICIPANT;CUTYPE=ROOM:mailto:room@example.test')
    expect(text).toContain('ATTENDEE:mailto:plain@example.test')
    const restored = icsEventToCalendarEvent(parseIcs(text).events[0], 'local', '#000', 'event-1')
    expect(restored).toMatchObject({ organizer: meeting.organizer, sequence: 3, attendees: meeting.attendees })
    expect(restored.attendeeDetails).toEqual([...meeting.attendeeDetails!, { email: 'plain@example.test' }])
  })

  it('leaves plain attendee lists without details, skips cancelled events by default, and reads METHOD', () => {
    const text = 'BEGIN:VCALENDAR\r\nMETHOD:request\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART:20260101T100000Z\r\nATTENDEE:mailto:x@example.test\r\nEND:VEVENT\r\n' +
      'BEGIN:VEVENT\r\nUID:b\r\nSTATUS:CANCELLED\r\nDTSTART:20260101T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'
    const parsed = parseIcs(text)
    expect(parsed.method).toBe('REQUEST')
    expect(parsed.events).toHaveLength(1)
    expect(parsed.events[0].attendeeDetails).toBeUndefined()
    expect(parsed.events[0].sequence).toBeUndefined()
    expect(parseIcs(text, undefined, undefined, { keepCancelled: true }).events.map((item) => item.status)).toEqual([undefined, 'CANCELLED'])
  })
})
