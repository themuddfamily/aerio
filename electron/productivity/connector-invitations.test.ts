import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CalendarEvent } from '../../src/types'
import type { SyncedCalendar } from '../../src/productivity-types'
import { GoogleProductivityConnector, googleEventBody, mapGoogleEvent } from './google-connector'
import { MicrosoftProductivityConnector, mapMicrosoftEvent, microsoftEventBody } from './microsoft-connector'

const googleCalendar: SyncedCalendar = { id: 'a:google-calendar:primary', remoteId: 'primary', accountId: 'a', provider: 'gmail', name: 'Calendar', color: '#000', primary: true, canWrite: true }
const microsoftCalendar: SyncedCalendar = { id: 'b:microsoft-calendar:main', remoteId: 'main', accountId: 'b', provider: 'microsoft', name: 'Calendar', color: '#000', primary: true, canWrite: true }
const json = (body: unknown, status = 200) => ({ ok: true, status, json: async () => body })
const calls = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.map(([url, init]) => [String(url), init?.method ?? 'GET', init?.body ? JSON.parse(init.body) : undefined])

const meeting: CalendarEvent = {
  id: 'local', calendarId: googleCalendar.id, title: 'Review', start: '2026-10-05T08:00:00.000Z', end: '2026-10-05T09:00:00.000Z', color: '#000',
  reminderMinutes: 10, attendees: ['ada@example.test', 'opt@example.test', 'room@example.test'],
  attendeeDetails: [{ email: 'ada@example.test', response: 'accepted' }, { email: 'opt@example.test', role: 'optional' }, { email: 'room@example.test', kind: 'room' }]
}

afterEach(() => vi.unstubAllGlobals())

describe('Google meeting details', () => {
  it('maps organizer, iCalUID, SEQUENCE, roles, resources, and responses', () => {
    const mapped = mapGoogleEvent('a', googleCalendar, {
      id: 'e1', summary: 'Review', start: { dateTime: '2026-10-05T08:00:00Z' }, end: { dateTime: '2026-10-05T09:00:00Z' },
      iCalUID: 'uid-1@google.com', sequence: 2, organizer: { email: 'ada@example.test', displayName: 'Ada' },
      attendees: [
        { email: 'ada@example.test', organizer: true, responseStatus: 'accepted' },
        { email: 'me@example.test', self: true, optional: true, responseStatus: 'tentative' },
        { email: 'room@resource.calendar.google.com', resource: true, responseStatus: 'accepted' }
      ]
    })!
    expect(mapped).toMatchObject({ icalUid: 'uid-1@google.com', sequence: 2, organizer: { email: 'ada@example.test', name: 'Ada' }, attendees: ['ada@example.test', 'me@example.test', 'room@resource.calendar.google.com'] })
    expect(mapped.attendeeDetails).toEqual([
      { email: 'ada@example.test', role: 'chair', kind: 'individual', response: 'accepted' },
      { email: 'me@example.test', self: true, role: 'optional', kind: 'individual', response: 'tentative' },
      { email: 'room@resource.calendar.google.com', role: 'required', kind: 'resource', response: 'accepted' }
    ])
  })

  it('writes optional guests and resources, and notifies guests on create and update', async () => {
    expect(googleEventBody(meeting).attendees).toEqual([
      { email: 'ada@example.test', responseStatus: 'accepted' }, { email: 'opt@example.test', optional: true }, { email: 'room@example.test', resource: true }
    ])
    const remote = { id: 'e1', summary: 'Review', start: { dateTime: meeting.start }, end: { dateTime: meeting.end }, attendees: [{ email: 'ada@example.test' }] }
    const fetchMock = vi.fn().mockResolvedValueOnce(json(remote)).mockResolvedValueOnce(json(remote))
    vi.stubGlobal('fetch', fetchMock)
    const connector = new GoogleProductivityConnector('a', async () => 'token', true)
    const created = await connector.createEvent(googleCalendar, meeting)
    await connector.updateEvent(googleCalendar, created, meeting)
    expect(calls(fetchMock).map(([url, method]) => [url, method])).toEqual([
      ['https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all', 'POST'],
      ['https://www.googleapis.com/calendar/v3/calendars/primary/events/e1?sendUpdates=all', 'PATCH']
    ])
  })

  it('RSVPs with events.patch, changing only this account’s attendee entry and sending updates', async () => {
    const remote = {
      id: 'series', summary: 'Review', start: { dateTime: meeting.start }, end: { dateTime: meeting.end },
      attendees: [{ email: 'ada@example.test', organizer: true, responseStatus: 'accepted' }, { email: 'Me@Example.test', responseStatus: 'needsAction' }]
    }
    const fetchMock = vi.fn().mockResolvedValueOnce(json(remote)).mockResolvedValueOnce(json({ ...remote, attendees: [remote.attendees[0], { ...remote.attendees[1], responseStatus: 'declined' }] }))
    vi.stubGlobal('fetch', fetchMock)
    const connector = new GoogleProductivityConnector('a', async () => 'token', true)
    const saved = await connector.respondToEvent(googleCalendar, 'series', ['me@example.test'], { response: 'declined', comment: 'Away' })
    const [read, patch] = calls(fetchMock)
    expect(read.slice(0, 2)).toEqual(['https://www.googleapis.com/calendar/v3/calendars/primary/events/series', 'GET'])
    expect(patch).toEqual(['https://www.googleapis.com/calendar/v3/calendars/primary/events/series?sendUpdates=all', 'PATCH', {
      attendees: [remote.attendees[0], { email: 'Me@Example.test', responseStatus: 'declined', comment: 'Away' }]
    }])
    expect(saved?.attendeeDetails?.[1]).toMatchObject({ response: 'declined' })
  })

  it('refuses proposals, non-guests, and unauthorized accounts', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ id: 'x', attendees: [{ email: 'other@example.test' }] }))
    vi.stubGlobal('fetch', fetchMock)
    const connector = new GoogleProductivityConnector('a', async () => 'token', true)
    await expect(connector.respondToEvent(googleCalendar, 'x', ['me@example.test'], { response: 'accepted' })).rejects.toThrow(/not on this meeting’s guest list/)
    await expect(connector.respondToEvent(googleCalendar, 'x', ['me@example.test'], { response: 'tentative', proposed: { start: meeting.start, end: meeting.end } })).rejects.toThrow(/proposed times/)
    await expect(new GoogleProductivityConnector('a', async () => 'token', false).respondToEvent(googleCalendar, 'x', [], { response: 'accepted' })).rejects.toThrow(/Reconnect/)
  })
})

describe('Microsoft meeting details', () => {
  it('maps organizer, uid, attendee types, and response statuses', () => {
    const mapped = mapMicrosoftEvent('b', microsoftCalendar, {
      id: 'm1', subject: 'Review', start: { dateTime: '2026-10-05T08:00:00' }, end: { dateTime: '2026-10-05T09:00:00' },
      uid: 'series-uid', iCalUId: 'instance-uid', isOrganizer: false, organizer: { emailAddress: { address: 'ada@example.test', name: 'Ada' } },
      attendees: [
        { emailAddress: { address: 'me@example.test' }, type: 'optional', status: { response: 'tentativelyAccepted' } },
        { emailAddress: { address: 'room@example.test', name: 'Room 4' }, type: 'resource', status: { response: 'accepted' } }
      ]
    })!
    expect(mapped).toMatchObject({ icalUid: 'series-uid', organizer: { email: 'ada@example.test', name: 'Ada' }, readOnly: true })
    expect(mapped.organizer?.self).toBeUndefined()
    expect(mapped.attendeeDetails).toEqual([
      { email: 'me@example.test', role: 'optional', kind: 'individual', response: 'tentative' },
      { email: 'room@example.test', name: 'Room 4', role: 'required', kind: 'resource', response: 'accepted' }
    ])
    expect(microsoftEventBody(meeting).attendees).toEqual([
      { emailAddress: { address: 'ada@example.test' }, type: 'required' }, { emailAddress: { address: 'opt@example.test' }, type: 'optional' }, { emailAddress: { address: 'room@example.test' }, type: 'resource' }
    ])
  })

  it('RSVPs with accept/tentativelyAccept/decline, sendResponse, comments, and proposedNewTime', async () => {
    const remote = { id: 'm1', subject: 'Review', start: { dateTime: '2026-10-05T08:00:00' }, end: { dateTime: '2026-10-05T09:00:00' } }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 202 }).mockResolvedValueOnce(json(remote))
      .mockResolvedValueOnce({ ok: true, status: 202 }).mockResolvedValueOnce(json(remote))
      .mockResolvedValueOnce({ ok: true, status: 202 })
    vi.stubGlobal('fetch', fetchMock)
    const connector = new MicrosoftProductivityConnector('b', async () => 'token', true)
    expect(await connector.respondToEvent(microsoftCalendar, 'm1', { response: 'accepted', comment: 'Yes' })).toMatchObject({ remoteId: 'm1' })
    await connector.respondToEvent(microsoftCalendar, 'm1', { response: 'tentative', proposed: { start: '2026-10-06T08:00:00.000Z', end: '2026-10-06T09:00:00.000Z' } })
    expect(await connector.respondToEvent(microsoftCalendar, 'm1', { response: 'declined' })).toBeUndefined()
    const sent = calls(fetchMock).filter(([, method]) => method === 'POST')
    expect(sent).toEqual([
      ['https://graph.microsoft.com/v1.0/me/events/m1/accept', 'POST', { sendResponse: true, comment: 'Yes' }],
      ['https://graph.microsoft.com/v1.0/me/events/m1/tentativelyAccept', 'POST', {
        sendResponse: true,
        proposedNewTime: { start: { dateTime: '2026-10-06T08:00:00.000', timeZone: 'UTC' }, end: { dateTime: '2026-10-06T09:00:00.000', timeZone: 'UTC' } }
      }],
      ['https://graph.microsoft.com/v1.0/me/events/m1/decline', 'POST', { sendResponse: true }]
    ])
    await expect(connector.respondToEvent(microsoftCalendar, 'm1', { response: 'accepted', proposed: { start: '2026-10-06T08:00:00Z', end: '2026-10-06T09:00:00Z' } })).rejects.toThrow(/tentative or decline/)
    await expect(new MicrosoftProductivityConnector('b', async () => 'token', false).respondToEvent(microsoftCalendar, 'm1', { response: 'accepted' })).rejects.toThrow(/Reconnect/)
  })
})
