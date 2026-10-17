import { describe, expect, it } from 'vitest'
import type { CalendarEvent } from '../types'
import {
  attendeeResponseCounts, eventAttendees, findAttendee, fromGoogleAttendee, fromGraphAttendee, kindFromIcs, responseFromIcs, roleFromIcs,
  toGoogleAttendee, toGraphAttendee, withAttendees
} from './event-attendees'
import { validEventMeetingFields, validInterchangeEvent } from './interchange-validation'

const event = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 'e', calendarId: 'c', title: 'Meeting', start: '2026-10-05T08:00:00.000Z', end: '2026-10-05T09:00:00.000Z', color: '#000',
  attendees: [], reminderMinutes: 0, ...overrides
})

describe('meeting field validation', () => {
  it('accepts structured attendees, organizers, and SEQUENCE and rejects malformed values', () => {
    expect(validInterchangeEvent(event({ attendees: ['a@example.test'], attendeeDetails: [{ email: 'a@example.test', role: 'optional', kind: 'room', response: 'tentative', rsvp: true }], organizer: { email: 'o@example.test', name: 'O' }, sequence: 4 }))).toBe(true)
    expect(validEventMeetingFields({ attendeeDetails: [{ email: 'a@example.test', role: 'boss' as never }] })).toBe(false)
    expect(validEventMeetingFields({ attendeeDetails: [{ email: '' }] })).toBe(false)
    expect(validEventMeetingFields({ organizer: { email: 'x'.repeat(501) } })).toBe(false)
    expect(validEventMeetingFields({ sequence: -1 })).toBe(false)
    expect(validEventMeetingFields({ sequence: 1.5 })).toBe(false)
  })
})

describe('structured attendees', () => {
  it('reads plain string attendees as required people and keeps details aligned with the address list', () => {
    const legacy = event({ attendees: ['ada@example.test'] })
    expect(eventAttendees(legacy)).toEqual([{ email: 'ada@example.test' }])
    const detailed = event({
      attendees: ['ada@example.test', 'room@example.test'],
      attendeeDetails: [{ email: 'ROOM@example.test', kind: 'room' }, { email: 'removed@example.test', role: 'optional' }]
    })
    expect(eventAttendees(detailed)).toEqual([{ email: 'ada@example.test' }, { email: 'room@example.test', kind: 'room' }])
  })

  it('writes both fields, drops duplicates, and omits details when every attendee is plain', () => {
    expect(withAttendees(event(), [{ email: 'a@example.test' }, { email: 'A@example.test', role: 'optional' }, { email: ' ' }])).toEqual(event({ attendees: ['a@example.test'] }))
    const structured = withAttendees(event(), [{ email: 'a@example.test', role: 'optional' }])
    expect(structured).toMatchObject({ attendees: ['a@example.test'], attendeeDetails: [{ email: 'a@example.test', role: 'optional' }] })
    expect(withAttendees(structured, [{ email: 'a@example.test', role: 'required' }]).attendeeDetails).toBeUndefined()
  })

  it('finds this account among attendees by self flag or address and counts responses', () => {
    const meeting = event({ attendees: ['a@example.test', 'b@example.test'], attendeeDetails: [{ email: 'b@example.test', self: true, response: 'declined' }] })
    expect(findAttendee(meeting, ['a@example.test'])?.email).toBe('b@example.test')
    expect(findAttendee(event({ attendees: ['A@Example.test'] }), ['a@example.test'])?.email).toBe('A@Example.test')
    expect(attendeeResponseCounts(eventAttendees(meeting))).toMatchObject({ declined: 1, 'needs-action': 1 })
  })

  it('maps iCalendar parameters with RFC defaults for unknown values', () => {
    expect([roleFromIcs('chair'), roleFromIcs('X-SPEAKER'), roleFromIcs(undefined)]).toEqual(['chair', 'required', undefined])
    expect([kindFromIcs('ROOM'), kindFromIcs('RESOURCE'), kindFromIcs('X-BOT')]).toEqual(['room', 'resource', 'unknown'])
    expect([responseFromIcs('DECLINED'), responseFromIcs('X-MAYBE')]).toEqual(['declined', 'needs-action'])
  })

  it('maps Google attendees, resources, and response status both ways', () => {
    expect(fromGoogleAttendee({ email: 'r@resource.calendar.google.com', resource: true, responseStatus: 'accepted', displayName: 'Room 1' }))
      .toEqual({ email: 'r@resource.calendar.google.com', name: 'Room 1', role: 'required', kind: 'resource', response: 'accepted' })
    expect(fromGoogleAttendee({ email: 'me@example.test', self: true, optional: true, responseStatus: 'needsAction' })).toMatchObject({ self: true, role: 'optional', response: 'needs-action' })
    expect(fromGoogleAttendee({ email: 'o@example.test', organizer: true })).toMatchObject({ role: 'chair' })
    expect(fromGoogleAttendee({})).toBeUndefined()
    expect(toGoogleAttendee({ email: 'a@example.test', role: 'optional', response: 'tentative', name: 'A' })).toEqual({ email: 'a@example.test', displayName: 'A', optional: true, responseStatus: 'tentative' })
    expect(toGoogleAttendee({ email: 'room@example.test', kind: 'room', role: 'non-participant' })).toEqual({ email: 'room@example.test', resource: true })
  })

  it('maps Microsoft Graph attendee types and statuses both ways', () => {
    expect(fromGraphAttendee({ emailAddress: { address: 'room@example.test', name: 'Room' }, type: 'resource', status: { response: 'accepted' } }))
      .toEqual({ email: 'room@example.test', name: 'Room', role: 'required', kind: 'resource', response: 'accepted' })
    expect(fromGraphAttendee({ emailAddress: { address: 'me@example.test' }, type: 'optional', status: { response: 'tentativelyAccepted' } }, 'ME@example.test'))
      .toMatchObject({ self: true, role: 'optional', response: 'tentative' })
    expect(fromGraphAttendee({ emailAddress: { address: 'x@example.test' }, status: { response: 'notResponded' } })?.response).toBe('needs-action')
    expect(toGraphAttendee({ email: 'a@example.test', role: 'optional' })).toEqual({ emailAddress: { address: 'a@example.test' }, type: 'optional' })
    expect(toGraphAttendee({ email: 'r@example.test', kind: 'room', role: 'optional' })).toEqual({ emailAddress: { address: 'r@example.test' }, type: 'resource' })
    expect(toGraphAttendee({ email: 'c@example.test', role: 'chair' })).toEqual({ emailAddress: { address: 'c@example.test' }, type: 'required' })
  })
})
