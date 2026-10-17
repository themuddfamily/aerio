import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SyncedCalendar, SyncedCalendarEvent } from '../../src/productivity-types'
import type { CalendarEvent } from '../../src/types'
import { GoogleProductivityConnector, mapGoogleEvent } from './google-connector'
import { MicrosoftProductivityConnector, mapMicrosoftEvent } from './microsoft-connector'
import {
  assertConferenceCreatable, carryPendingConferences, externalMeetingConnectors, googleConferenceSupport, googleEventIdForRequest,
  mapGoogleConference, mapGraphConference, microsoftConferenceSupport
} from './online-meetings'

const googleCalendar: SyncedCalendar = {
  id: 'a:google-calendar:primary', remoteId: 'primary', accountId: 'a', provider: 'gmail', name: 'Main', color: '#6558e8', primary: true, canWrite: true,
  conferences: googleConferenceSupport(['hangoutsMeet'], true)
}
const microsoftCalendar: SyncedCalendar = {
  id: 'b:microsoft-calendar:main', remoteId: 'main', accountId: 'b', provider: 'microsoft', name: 'Main', color: '#3b6fd8', primary: true, canWrite: true,
  conferences: microsoftConferenceSupport(['teamsForBusiness'], 'teamsForBusiness', true)
}
const requestId = '0123456789abcdef0123456789abcdef'
const event = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 'event', calendarId: googleCalendar.id, title: 'Sync', start: '2026-03-02T14:00:00.000Z', end: '2026-03-02T14:30:00.000Z',
  color: '#000', attendees: [], reminderMinutes: 10, recurrence: 'none', ...overrides
})
const meet = {
  conferenceId: 'abc-defg-hij',
  conferenceSolution: { key: { type: 'hangoutsMeet' }, name: 'Google Meet' },
  createRequest: { requestId, conferenceSolutionKey: { type: 'hangoutsMeet' }, status: { statusCode: 'success' } },
  entryPoints: [
    { entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij', label: 'meet.google.com/abc-defg-hij' },
    { entryPointType: 'phone', uri: 'tel:+1-555-0100', label: '+1 555-0100', pin: '123456' }
  ]
}
const googleRemote = (overrides: Record<string, unknown> = {}) => ({
  id: 'remote', summary: 'Sync', start: { dateTime: '2026-03-02T14:00:00.000Z' }, end: { dateTime: '2026-03-02T14:30:00.000Z' }, ...overrides
})
const graphRemote = (overrides: Record<string, unknown> = {}) => ({
  id: 'graph-id', subject: 'Sync', start: { dateTime: '2026-03-02T14:00:00.0000000' }, end: { dateTime: '2026-03-02T14:30:00.0000000' }, isOrganizer: true, ...overrides
})
const ok = (body: unknown) => ({ ok: true, status: body === undefined ? 204 : 200, json: async () => body, headers: new Headers() })
const failed = (status: number) => ({ ok: false, status, json: async () => ({ error: { message: `status ${status}` } }), headers: new Headers() })
const calls = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.map(([url, init]) => [String(url), init?.method ?? 'GET', init?.body ? JSON.parse(init.body) : undefined])
const google = () => new GoogleProductivityConnector('a', async () => 'token', true)
const microsoft = () => new MicrosoftProductivityConnector('b', async () => 'token', true)

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Google Meet conference data', () => {
  it('maps join links, dial-in details, pending and failed requests, and add-on providers', () => {
    expect(mapGoogleEvent('a', googleCalendar, googleRemote({ conferenceData: meet, hangoutLink: 'https://meet.google.com/abc-defg-hij' }))?.conference).toEqual({
      provider: 'googleMeet', status: 'ready', requestId, joinUrl: 'https://meet.google.com/abc-defg-hij', conferenceId: 'abc-defg-hij', name: 'Google Meet', phone: '+1 555-0100', pin: '123456'
    })
    expect(mapGoogleConference({ createRequest: { requestId, conferenceSolutionKey: { type: 'hangoutsMeet' }, status: { statusCode: 'pending' } } })).toEqual({ provider: 'googleMeet', status: 'pending', requestId })
    expect(mapGoogleConference({ createRequest: { requestId, status: { statusCode: 'failure' } } })).toMatchObject({ status: 'failed' })
    expect(mapGoogleConference({ conferenceSolution: { key: { type: 'addOn' }, name: 'Zoom Meeting' }, entryPoints: [{ entryPointType: 'video', uri: 'https://zoom.us/j/1' }] })).toMatchObject({ provider: 'zoom', joinUrl: 'https://zoom.us/j/1' })
    expect(mapGoogleConference(undefined, 'https://meet.google.com/legacy')).toMatchObject({ provider: 'googleMeet', joinUrl: 'https://meet.google.com/legacy' })
    expect(mapGoogleEvent('a', googleCalendar, googleRemote())?.conference).toBeUndefined()
  })

  it('reports Meet capability from allowedConferenceSolutionTypes and write access', () => {
    expect(googleConferenceSupport(['hangoutsMeet'], true)).toEqual({ allowed: ['hangoutsMeet'], creatable: ['googleMeet'], canRemove: true })
    expect(googleConferenceSupport(['eventHangout'], true).creatable).toEqual([])
    expect(googleConferenceSupport(undefined, true)).toEqual({ allowed: [], creatable: [], canRemove: true })
    expect(googleConferenceSupport(['hangoutsMeet'], false).creatable).toEqual([])
  })

  it('reads conference capability while synchronizing calendars', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok({ items: [{ id: 'primary', accessRole: 'owner', conferenceProperties: { allowedConferenceSolutionTypes: ['hangoutsMeet'] } }] }))
      .mockResolvedValueOnce(ok({ items: [googleRemote({ conferenceData: meet })], nextSyncToken: 'sync' }))
      .mockResolvedValue(ok({}))
    vi.stubGlobal('fetch', fetchMock)
    const result = await google().sync()
    expect(result.calendars[0].conferences).toEqual({ allowed: ['hangoutsMeet'], creatable: ['googleMeet'], canRemove: true })
    expect(result.events[0].conference).toMatchObject({ provider: 'googleMeet', joinUrl: 'https://meet.google.com/abc-defg-hij' })
  })

  it('creates a Meet with a stable createRequest and conferenceDataVersion=1', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(ok(googleRemote({ id: requestId, conferenceData: meet })))
    vi.stubGlobal('fetch', fetchMock)
    const saved = await google().createEvent(googleCalendar, event({ conference: { provider: 'googleMeet', status: 'pending', requestId } }))
    const [[url, method, body]] = calls(fetchMock)
    expect([url, method]).toEqual(['https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1', 'POST'])
    expect(body).toMatchObject({ id: requestId, conferenceData: { createRequest: { requestId, conferenceSolutionKey: { type: 'hangoutsMeet' } } } })
    expect(saved.conference).toMatchObject({ status: 'ready', joinUrl: 'https://meet.google.com/abc-defg-hij' })
  })

  it('does not create a second event or conference when a retried insert finds the first one', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(failed(409))
      .mockResolvedValueOnce(ok(googleRemote({ id: requestId, conferenceData: meet })))
    vi.stubGlobal('fetch', fetchMock)
    const saved = await google().createEvent(googleCalendar, event({ conference: { provider: 'googleMeet', status: 'pending', requestId } }))
    expect(calls(fetchMock).map(([url, method]) => [url, method])).toEqual([
      ['https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1', 'POST'],
      [`https://www.googleapis.com/calendar/v3/calendars/primary/events/${requestId}`, 'GET']
    ])
    expect(saved).toMatchObject({ remoteId: requestId, conference: { joinUrl: 'https://meet.google.com/abc-defg-hij' } })
  })

  it('adds the conference to an event found by a retried insert when it has none yet', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(failed(409))
      .mockResolvedValueOnce(ok(googleRemote({ id: requestId })))
      .mockResolvedValueOnce(ok(googleRemote({ id: requestId, conferenceData: meet })))
    vi.stubGlobal('fetch', fetchMock)
    await google().createEvent(googleCalendar, event({ conference: { provider: 'googleMeet', status: 'pending', requestId } }))
    const patch = calls(fetchMock)[2]
    expect(patch).toEqual([`https://www.googleapis.com/calendar/v3/calendars/primary/events/${requestId}?conferenceDataVersion=1`, 'PATCH', { conferenceData: { createRequest: { requestId, conferenceSolutionKey: { type: 'hangoutsMeet' } } } }])
  })

  it('keeps an existing conference on unrelated edits', async () => {
    const current = mapGoogleEvent('a', googleCalendar, googleRemote({ conferenceData: meet })) as SyncedCalendarEvent
    const fetchMock = vi.fn().mockResolvedValueOnce(ok(googleRemote({ summary: 'Renamed', conferenceData: meet })))
    vi.stubGlobal('fetch', fetchMock)
    const saved = await google().updateEvent(googleCalendar, current, { ...current, title: 'Renamed' })
    const [[url, method, body]] = calls(fetchMock)
    expect([url, method]).toEqual(['https://www.googleapis.com/calendar/v3/calendars/primary/events/remote?conferenceDataVersion=1', 'PATCH'])
    expect(body).not.toHaveProperty('conferenceData')
    expect(saved.conference?.joinUrl).toBe('https://meet.google.com/abc-defg-hij')
    // An editor that does not know about conferences (conference absent) also leaves it untouched.
    fetchMock.mockResolvedValueOnce(ok(googleRemote({ conferenceData: meet })))
    const { conference: _conference, ...plain } = current
    await google().updateEvent(googleCalendar, current, plain)
    expect(calls(fetchMock)[1][2]).not.toHaveProperty('conferenceData')
  })

  it('detects a conference created by an earlier attempt before adding one to an existing event', async () => {
    const current = mapGoogleEvent('a', googleCalendar, googleRemote()) as SyncedCalendarEvent
    const input = { ...current, conference: { provider: 'googleMeet' as const, status: 'pending' as const, requestId } }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok(googleRemote({ conferenceData: meet })))
      .mockResolvedValueOnce(ok(googleRemote({ conferenceData: meet })))
      .mockResolvedValueOnce(ok(googleRemote()))
      .mockResolvedValueOnce(ok(googleRemote({ conferenceData: meet })))
    vi.stubGlobal('fetch', fetchMock)
    await google().updateEvent(googleCalendar, current, input)
    await google().updateEvent(googleCalendar, current, input)
    const [getFound, patchFound, getMissing, patchMissing] = calls(fetchMock)
    expect(getFound.slice(0, 2)).toEqual(['https://www.googleapis.com/calendar/v3/calendars/primary/events/remote', 'GET'])
    expect(patchFound[2]).not.toHaveProperty('conferenceData')
    expect(getMissing[1]).toBe('GET')
    expect(patchMissing[2]).toMatchObject({ conferenceData: { createRequest: { requestId } } })
  })

  it('removes a conference only when asked, and refuses calendars without Meet', async () => {
    const current = mapGoogleEvent('a', googleCalendar, googleRemote({ conferenceData: meet })) as SyncedCalendarEvent
    const fetchMock = vi.fn().mockResolvedValueOnce(ok(googleRemote()))
    vi.stubGlobal('fetch', fetchMock)
    const saved = await google().updateEvent(googleCalendar, current, { ...current, conference: { ...current.conference!, status: 'removed' } })
    expect(calls(fetchMock)[0][2]).toMatchObject({ conferenceData: null })
    expect(saved.conference).toBeUndefined()
    const noMeet = { ...googleCalendar, conferences: googleConferenceSupport([], true) }
    await expect(google().createEvent(noMeet, event({ conference: { provider: 'googleMeet', status: 'pending', requestId } }))).rejects.toThrow(/does not offer Google Meet/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('copies the master conference to the new series when splitting this and following', async () => {
    const instance = mapGoogleEvent('a', googleCalendar, googleRemote({
      id: 'series_20260304T140000Z', recurringEventId: 'series', start: { dateTime: '2026-03-04T14:00:00Z' }, end: { dateTime: '2026-03-04T14:30:00Z' },
      originalStartTime: { dateTime: '2026-03-04T14:00:00Z' }, conferenceData: meet
    })) as SyncedCalendarEvent
    const master = googleRemote({ id: 'series', start: { dateTime: '2026-03-02T14:00:00Z', timeZone: 'UTC' }, end: { dateTime: '2026-03-02T14:30:00Z', timeZone: 'UTC' }, recurrence: ['RRULE:FREQ=DAILY'], conferenceData: meet })
    const fetchMock = vi.fn().mockResolvedValueOnce(ok(master)).mockResolvedValueOnce(ok(master)).mockResolvedValueOnce(ok(googleRemote({ id: 'successor' })))
    vi.stubGlobal('fetch', fetchMock)
    await google().updateEventSeries(googleCalendar, instance, { ...instance, title: 'Moved' }, 'following')
    const [, patchMaster, createSuccessor] = calls(fetchMock)
    expect(patchMaster[0]).toContain('conferenceDataVersion=1')
    expect(createSuccessor[0]).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1')
    expect(createSuccessor[2].conferenceData).toEqual({ conferenceId: meet.conferenceId, conferenceSolution: meet.conferenceSolution, entryPoints: meet.entryPoints })
  })

  it('derives a valid base32hex event id from a request id', () => {
    expect(googleEventIdForRequest(requestId)).toBe(requestId)
    expect(googleEventIdForRequest('ABC-xyz')).toBeUndefined()
    expect(googleEventIdForRequest('Room-42-zzzz-abcd')).toBe('room42abcd')
  })
})

describe('Microsoft Teams online meetings', () => {
  const teamsFields = { isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness', onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/1', conferenceId: '42', tollNumber: '+1 555 0101' } }

  it('maps onlineMeeting join details and reports allowed providers', () => {
    expect(mapMicrosoftEvent('b', microsoftCalendar, graphRemote(teamsFields))?.conference).toEqual({
      provider: 'teams', status: 'ready', joinUrl: 'https://teams.microsoft.com/l/meetup-join/1', conferenceId: '42', phone: '+1 555 0101'
    })
    expect(mapGraphConference({ isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness', onlineMeeting: null })).toEqual({ provider: 'teams', status: 'pending' })
    expect(mapGraphConference({ isOnlineMeeting: true, onlineMeetingProvider: 'skypeForConsumer', onlineMeetingUrl: 'https://join.skype.com/x' })).toMatchObject({ provider: 'skype', joinUrl: 'https://join.skype.com/x' })
    expect(mapGraphConference({ isOnlineMeeting: false })).toBeUndefined()
    expect(microsoftConferenceSupport(['teamsForBusiness', 'unknown'], 'teamsForBusiness', true)).toEqual({ allowed: ['teamsForBusiness'], defaultProvider: 'teamsForBusiness', creatable: ['teams'], canRemove: false })
    // Personal accounts report skypeForConsumer or nothing; Aerio does not create those.
    expect(microsoftConferenceSupport(['skypeForConsumer'], 'skypeForConsumer', true).creatable).toEqual([])
    expect(microsoftConferenceSupport(undefined, undefined, true)).toEqual({ allowed: [], creatable: [], canRemove: false })
  })

  it('selects allowedOnlineMeetingProviders while synchronizing calendars', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok({ value: [{ id: 'main', canEdit: true, allowedOnlineMeetingProviders: ['teamsForBusiness'], defaultOnlineMeetingProvider: 'teamsForBusiness' }] }))
      .mockResolvedValueOnce(ok({ value: [graphRemote(teamsFields)], '@odata.deltaLink': 'delta' }))
      .mockResolvedValue(ok({ value: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await microsoft().sync()
    expect(String(fetchMock.mock.calls[0][0])).toContain('allowedOnlineMeetingProviders,defaultOnlineMeetingProvider')
    expect(result.calendars[0].conferences?.creatable).toEqual(['teams'])
    expect(result.events[0].conference?.joinUrl).toBe('https://teams.microsoft.com/l/meetup-join/1')
  })

  it('creates a Teams meeting with the request id as transactionId', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(ok(graphRemote(teamsFields)))
    vi.stubGlobal('fetch', fetchMock)
    const saved = await microsoft().createEvent(microsoftCalendar, event({ calendarId: microsoftCalendar.id, conference: { provider: 'teams', status: 'pending', requestId } }))
    expect(calls(fetchMock)[0][2]).toMatchObject({ isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness', transactionId: requestId })
    expect(saved.conference?.joinUrl).toBe('https://teams.microsoft.com/l/meetup-join/1')
    fetchMock.mockResolvedValueOnce(ok(graphRemote()))
    await microsoft().createEvent(microsoftCalendar, event({ calendarId: microsoftCalendar.id }))
    expect(calls(fetchMock)[1][2]).not.toHaveProperty('isOnlineMeeting')
    expect(calls(fetchMock)[1][2]).not.toHaveProperty('transactionId')
  })

  it('never touches the meeting or the HTML body on unrelated edits', async () => {
    const current = mapMicrosoftEvent('b', microsoftCalendar, graphRemote({ ...teamsFields, bodyPreview: 'Agenda' })) as SyncedCalendarEvent
    const fetchMock = vi.fn().mockResolvedValue(ok(graphRemote(teamsFields)))
    vi.stubGlobal('fetch', fetchMock)
    await microsoft().updateEvent(microsoftCalendar, current, { ...current, title: 'Renamed' })
    const body = calls(fetchMock)[0][2]
    expect(body).toMatchObject({ subject: 'Renamed' })
    expect(body).not.toHaveProperty('isOnlineMeeting')
    expect(body).not.toHaveProperty('onlineMeetingProvider')
    expect(body).not.toHaveProperty('body')
    await microsoft().updateEvent(microsoftCalendar, current, { ...current, description: 'New agenda' })
    expect(calls(fetchMock)[1][2]).toMatchObject({ body: { contentType: 'text', content: 'New agenda' } })
  })

  it('checks for an existing meeting before adding Teams to an event', async () => {
    const current = mapMicrosoftEvent('b', microsoftCalendar, graphRemote()) as SyncedCalendarEvent
    const input = { ...current, conference: { provider: 'teams' as const, status: 'pending' as const, requestId } }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok(teamsFields)).mockResolvedValueOnce(ok(graphRemote(teamsFields)))
      .mockResolvedValueOnce(ok({ isOnlineMeeting: false })).mockResolvedValueOnce(ok(graphRemote(teamsFields)))
    vi.stubGlobal('fetch', fetchMock)
    await microsoft().updateEvent(microsoftCalendar, current, input)
    await microsoft().updateEvent(microsoftCalendar, current, input)
    const [getFound, patchFound, , patchMissing] = calls(fetchMock)
    expect(getFound[0]).toBe('https://graph.microsoft.com/v1.0/me/events/graph-id?$select=isOnlineMeeting,onlineMeetingProvider,onlineMeeting,onlineMeetingUrl')
    expect(patchFound[2]).not.toHaveProperty('isOnlineMeeting')
    expect(patchMissing[2]).toMatchObject({ isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness' })
  })

  it('refuses Teams on personal calendars and removing an existing Teams meeting', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const personal = { ...microsoftCalendar, conferences: microsoftConferenceSupport(['skypeForConsumer'], 'skypeForConsumer', true) }
    await expect(microsoft().createEvent(personal, event({ conference: { provider: 'teams', status: 'pending', requestId } }))).rejects.toThrow(/Personal Microsoft accounts/)
    const current = mapMicrosoftEvent('b', microsoftCalendar, graphRemote(teamsFields)) as SyncedCalendarEvent
    await expect(microsoft().updateEvent(microsoftCalendar, current, { ...current, conference: { ...current.conference!, status: 'removed' } })).rejects.toThrow(/keeps a Teams meeting/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('online meeting connector boundary', () => {
  it('reports Zoom and Webex as not connected and refuses to create them', async () => {
    expect(externalMeetingConnectors.zoom?.capability(googleCalendar)).toMatchObject({ provider: 'zoom', available: false })
    await expect(externalMeetingConnectors.webex!.createMeeting({ requestId, title: 'x', start: '', end: '' })).rejects.toThrow(/Webex meetings are not supported/)
    expect(() => assertConferenceCreatable(googleCalendar, 'zoom')).toThrow(/Zoom is not connected/)
    expect(() => assertConferenceCreatable(googleCalendar, 'teams')).toThrow(/cannot be added/)
    expect(() => assertConferenceCreatable(googleCalendar, 'googleMeet')).not.toThrow()
  })

  it('carries an unconfirmed meeting request across synchronization', () => {
    const pending = { provider: 'googleMeet' as const, status: 'pending' as const, requestId }
    const previous = [{ ...event(), conference: pending }, event({ id: 'other', conference: { provider: 'googleMeet', status: 'ready', joinUrl: 'https://meet.google.com/x' } })]
    const next = [event(), event({ id: 'other' })]
    expect(carryPendingConferences(previous, next)).toEqual([{ ...event(), conference: pending }, event({ id: 'other' })])
  })
})
