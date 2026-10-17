// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalendarEvent } from '../types'
import type { SyncedCalendarEvent } from '../productivity-types'
import EventAttendeesField, { applyAttendeeSelection, attendeeFieldText, attendeeFieldValues, attendeesFromFields, type AttendeeFieldValues } from './EventAttendeesField'

const event = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 'e', calendarId: 'c', title: 'Meeting', start: '2026-10-05T08:00:00.000Z', end: '2026-10-05T09:00:00.000Z', color: '#000',
  attendees: [], reminderMinutes: 0, ...overrides
})

const meeting = event({
  attendees: ['chair@example.test', 'a@example.test', 'opt@example.test', 'room@example.test'],
  attendeeDetails: [
    { email: 'chair@example.test', role: 'chair', response: 'accepted', name: 'Chair' },
    { email: 'a@example.test', response: 'declined' },
    { email: 'opt@example.test', role: 'optional' },
    { email: 'room@example.test', kind: 'room', role: 'non-participant' }
  ]
})

describe('attendee fields', () => {
  it('splits attendees into required, optional, and resource fields', () => {
    expect(attendeeFieldValues(meeting)).toEqual({ required: 'chair@example.test, a@example.test', optional: 'opt@example.test', resources: 'room@example.test' })
    expect(attendeeFieldValues(event({ attendees: ['legacy@example.test'] }))).toEqual({ required: 'legacy@example.test', optional: '', resources: '' })
    expect(attendeeFieldValues()).toEqual({ required: '', optional: '', resources: '' })
  })

  it('rebuilds structured attendees and keeps responses, names, chairs, and rooms the editor does not show', () => {
    expect(attendeesFromFields({ required: 'chair@example.test; new@example.test', optional: 'a@example.test', resources: 'room@example.test, projector@example.test' }, meeting)).toEqual([
      { email: 'chair@example.test', name: 'Chair', role: 'chair', response: 'accepted' },
      { email: 'new@example.test', role: 'required' },
      { email: 'a@example.test', role: 'optional', response: 'declined' },
      { email: 'room@example.test', kind: 'room', role: 'non-participant' },
      { email: 'projector@example.test', kind: 'resource', role: 'non-participant' }
    ])
  })
})

describe('scheduling assistant hand-off', () => {
  it('passes every address and keeps optional and resource fields when a selection comes back', () => {
    const values = attendeeFieldValues(meeting)
    expect(attendeeFieldText(values)).toBe('chair@example.test, a@example.test, opt@example.test, room@example.test')
    expect(attendeeFieldText({ required: '', optional: 'o@example.test', resources: ' ' })).toBe('o@example.test')
    expect(applyAttendeeSelection(values, ['chair@example.test', 'OPT@example.test', 'room@example.test', 'new@example.test'])).toEqual({
      required: 'chair@example.test, new@example.test', optional: 'OPT@example.test', resources: 'room@example.test'
    })
  })
})

describe('EventAttendeesField', () => {
  const respondToEvent = vi.fn(async () => ({ calendars: [], events: [], contacts: [], sync: [] }))
  beforeEach(() => {
    respondToEvent.mockClear()
    Object.defineProperty(window, 'aerio', { configurable: true, value: { productivity: { respondToEvent } } })
  })

  function Harness({ initial }: { initial: CalendarEvent }) {
    const [value, setValue] = useState<AttendeeFieldValues>(() => attendeeFieldValues(initial))
    return <EventAttendeesField value={value} event={initial} disabled={false} onChange={setValue} />
  }

  it('edits the three fields and lists guest responses', async () => {
    const user = userEvent.setup()
    render(<Harness initial={meeting} />)
    await user.type(screen.getByLabelText('Optional attendees'), ', late@example.test')
    expect(screen.getByLabelText('Optional attendees')).toHaveValue('opt@example.test, late@example.test')
    expect(screen.getByLabelText('Rooms and resources')).toHaveValue('room@example.test')
    expect(screen.getByRole('list', { name: 'Guest responses' })).toHaveTextContent('ChairChair · Accepted')
    expect(screen.queryByRole('group', { name: 'Your response' })).not.toBeInTheDocument()
  })

  it('offers RSVP on synced meetings organized by someone else', async () => {
    const user = userEvent.setup()
    const synced: SyncedCalendarEvent = {
      ...meeting, remoteId: 'r', accountId: 'g', provider: 'gmail', readOnly: false, organizer: { email: 'chair@example.test' },
      attendeeDetails: [...meeting.attendeeDetails!.filter((item) => item.email !== 'a@example.test'), { email: 'a@example.test', self: true, response: 'tentative' }]
    }
    render(<Harness initial={synced} />)
    expect(screen.getByText('You: Tentative')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Accept' }))
    expect(respondToEvent).toHaveBeenCalledWith('e', { response: 'accepted' })
    expect(await screen.findByRole('status')).toHaveTextContent('Response sent: Accepted.')
  })
})
