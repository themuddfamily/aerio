import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SyncedCalendar, SyncedCalendarEvent } from '../../src/productivity-types'
import { GoogleProductivityConnector, googleEventBody, mapGoogleContact, mapGoogleEvent } from './google-connector'
import { mapMicrosoftContact, mapMicrosoftEvent } from './microsoft-connector'

const googleCalendar: SyncedCalendar = {
  id: 'a:google-calendar:primary', remoteId: 'primary', accountId: 'a', provider: 'gmail', name: 'Main', color: '#6558e8', primary: true, canWrite: true
}
const microsoftCalendar: SyncedCalendar = {
  id: 'b:microsoft-calendar:main', remoteId: 'main', accountId: 'b', provider: 'microsoft', name: 'Main', color: '#3b6fd8', primary: true, canWrite: true
}

afterEach(() => vi.unstubAllGlobals())

describe('productivity connector mapping', () => {
  it('normalizes Google events and contacts into Aerio records', () => {
    expect(mapGoogleEvent('a', googleCalendar, {
      id: 'event-1', summary: 'Design review', start: { dateTime: '2026-08-01T09:00:00Z' }, end: { dateTime: '2026-08-01T10:00:00Z' },
      attendees: [{ email: 'person@example.com' }], recurrence: ['RRULE:FREQ=WEEKLY']
    })).toMatchObject({ title: 'Design review', recurrence: 'weekly', attendees: ['person@example.com'], provider: 'gmail' })
    expect(mapGoogleContact('a', {
      resourceName: 'people/1', names: [{ displayName: 'Grace Hopper' }], emailAddresses: [{ value: 'grace@example.com' }],
      organizations: [{ name: 'Navy', title: 'Rear admiral' }]
    })).toMatchObject({ name: 'Grace Hopper', email: 'grace@example.com', company: 'Navy', provider: 'gmail' })
  })

  it('normalizes Microsoft dates as UTC and keeps read-only event state', () => {
    expect(mapMicrosoftEvent('b', { ...microsoftCalendar, canWrite: false }, {
      id: 'event-2', subject: 'Roadmap', start: { dateTime: '2026-08-01T11:00:00.0000000' }, end: { dateTime: '2026-08-01T12:00:00.0000000' },
      attendees: [{ emailAddress: { address: 'team@example.com' } }]
    })).toMatchObject({ start: '2026-08-01T11:00:00.0000000Z', readOnly: true, provider: 'microsoft' })
    expect(mapMicrosoftContact('b', {
      id: 'contact-2', givenName: 'Katherine', surname: 'Johnson', emailAddresses: [{ address: 'kj@example.com' }]
    })).toMatchObject({ name: 'Katherine Johnson', email: 'kj@example.com', provider: 'microsoft' })
  })

  it('builds a Google Calendar write payload from the Aerio editor', () => {
    expect(googleEventBody({
      id: 'local-event', calendarId: googleCalendar.id, title: 'Planning',
      start: '2026-08-01T09:00:00.000Z', end: '2026-08-01T10:00:00.000Z',
      location: 'Studio', description: 'Weekly planning', color: '#6558e8',
      attendees: ['team@example.com'], reminderMinutes: 15, recurrence: 'weekly'
    })).toEqual({
      summary: 'Planning', description: 'Weekly planning', location: 'Studio',
      start: { dateTime: '2026-08-01T09:00:00.000Z' }, end: { dateTime: '2026-08-01T10:00:00.000Z' },
      attendees: [{ email: 'team@example.com' }],
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 15 }] },
      recurrence: ['RRULE:FREQ=WEEKLY']
    })
  })

  it('creates, updates, and deletes events through Google Calendar', async () => {
    const remote = {
      id: 'remote-event', summary: 'Planning',
      start: { dateTime: '2026-08-01T09:00:00.000Z' }, end: { dateTime: '2026-08-01T10:00:00.000Z' }
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => remote })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ...remote, summary: 'Updated planning' }) })
      .mockResolvedValueOnce({ ok: true, status: 204 })
    vi.stubGlobal('fetch', fetchMock)
    const connector = new GoogleProductivityConnector('a', async () => 'token', true)
    const input = {
      id: 'local-event', calendarId: googleCalendar.id, title: 'Planning',
      start: remote.start.dateTime, end: remote.end.dateTime, color: googleCalendar.color,
      attendees: [], reminderMinutes: 15, recurrence: 'none' as const
    }
    const created = await connector.createEvent(googleCalendar, input)
    expect(created).toMatchObject({ id: 'a:google-event:primary:remote-event', remoteId: 'remote-event', readOnly: false })
    const updated = await connector.updateEvent(googleCalendar, created as SyncedCalendarEvent, { ...input, id: created.id, title: 'Updated planning' })
    expect(updated.title).toBe('Updated planning')
    await connector.deleteEvent(googleCalendar, updated)
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
      ['https://www.googleapis.com/calendar/v3/calendars/primary/events', 'POST'],
      ['https://www.googleapis.com/calendar/v3/calendars/primary/events/remote-event', 'PATCH'],
      ['https://www.googleapis.com/calendar/v3/calendars/primary/events/remote-event', 'DELETE']
    ])
  })
})
