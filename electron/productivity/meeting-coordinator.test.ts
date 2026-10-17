import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncedCalendar, SyncedCalendarEvent } from '../../src/productivity-types'
import type { CalendarEvent } from '../../src/types'
import type { MeetingHostAccount } from '../../src/meeting-host-types'
import { hostedConferenceCapability } from '../../src/lib/online-meetings'
import { GoogleProductivityConnector, mapGoogleEvent } from './google-connector'
import { MicrosoftProductivityConnector } from './microsoft-connector'
import { HostedMeetingCoordinator, meetingDetailsBlock, stripMeetingDetails, withMeetingDetails } from './meeting-coordinator'
import { MeetingHostRequestError } from './meeting-host-http'
import { MeetingHostAuthError, revokedMessage } from './meeting-host-vault'
import { MeetingLinkStore } from './meeting-link-store'
import { googleConferenceSupport, microsoftConferenceSupport, type HostedMeeting, type OnlineMeetingConnector, type OnlineMeetingRequest } from './online-meetings'

const requestId = '0123456789abcdef0123456789abcdef'
const googleCalendar: SyncedCalendar = {
  id: 'a:google-calendar:primary', remoteId: 'primary', accountId: 'a', provider: 'gmail', name: 'Main', color: '#000', primary: true, canWrite: true,
  conferences: googleConferenceSupport(['hangoutsMeet'], true)
}
const microsoftCalendar: SyncedCalendar = {
  id: 'b:microsoft-calendar:main', remoteId: 'main', accountId: 'b', provider: 'microsoft', name: 'Main', color: '#000', primary: true, canWrite: true,
  conferences: microsoftConferenceSupport(['teamsForBusiness'], 'teamsForBusiness', true)
}
const zoomMeeting: HostedMeeting = {
  provider: 'zoom', meetingId: '85746065432', joinUrl: 'https://us02web.zoom.us/j/85746065432?pwd=abc', meetingNumber: '857 4606 5432', passcode: 'k9Lp2', phonePasscode: '123456',
  dialIn: [{ number: '+1 646 558 8656', label: 'US (New York)' }]
}
const event = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 'draft-event', calendarId: googleCalendar.id, title: 'Planning', start: '2026-03-02T14:00:00.000Z', end: '2026-03-02T14:45:00.000Z', timeZone: 'Europe/London',
  location: '', description: 'Agenda: roadmap', color: '#000', attendees: ['ada@example.test'], reminderMinutes: 10, recurrence: 'none', ...overrides
})
const synced = (overrides: Partial<SyncedCalendarEvent> = {}): SyncedCalendarEvent => ({
  ...event(), id: 'a:google-event:primary:remote-1', remoteId: 'remote-1', accountId: 'a', provider: 'gmail', readOnly: false, ...overrides
})
const zoomRequest = { provider: 'zoom' as const, status: 'pending' as const, requestId }

let directory: string
let store: MeetingLinkStore
let account: MeetingHostAccount
let connector: { [K in keyof OnlineMeetingConnector]: OnlineMeetingConnector[K] } & {
  createMeeting: ReturnType<typeof vi.fn>; findMeeting: ReturnType<typeof vi.fn>; updateMeeting: ReturnType<typeof vi.fn>; deleteMeeting: ReturnType<typeof vi.fn>
}
let coordinator: HostedMeetingCoordinator

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'aerio-meeting-links-'))
  store = new MeetingLinkStore(join(directory, 'productivity.sqlite'))
  account = { provider: 'zoom', configured: true, connected: true, redirectUri: 'http://localhost:47817/oauth/zoom', scopes: [] }
  connector = {
    provider: 'zoom',
    requiredScopes: [],
    capability: (calendar) => hostedConferenceCapability('zoom', calendar, account),
    createMeeting: vi.fn(async () => zoomMeeting),
    findMeeting: vi.fn(async () => undefined),
    updateMeeting: vi.fn(async (meeting: HostedMeeting) => meeting),
    deleteMeeting: vi.fn(async () => undefined)
  }
  coordinator = new HostedMeetingCoordinator({ store, connector: (provider) => provider === 'zoom' ? connector : undefined })
})
afterEach(() => {
  store.close()
  rmSync(directory, { recursive: true, force: true })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// Simulates the calendar connector: the provider returns the event under its own id, without Aerio's meeting.
const written = (prepared: CalendarEvent) => synced({ ...prepared, id: 'a:google-event:primary:remote-1', conference: undefined })

describe('meeting details in the event', () => {
  it('writes one delimited block into the notes and replaces it on later writes', () => {
    const block = meetingDetailsBlock(zoomMeeting)
    expect(block.split('\n')).toEqual([
      '─'.repeat(20), 'Join Zoom meeting', zoomMeeting.joinUrl, 'Meeting ID: 857 4606 5432', 'Passcode: k9Lp2', 'Dial in (US (New York)): +1 646 558 8656', 'Phone passcode: 123456', '─'.repeat(20)
    ])
    const once = withMeetingDetails(event(), zoomMeeting)
    expect(once.location).toBe(zoomMeeting.joinUrl)
    expect(once.description).toBe(`Agenda: roadmap\n\n${block}`)
    expect(withMeetingDetails(once, zoomMeeting).description).toBe(once.description)
    // A typed location is kept; the link is still in the notes.
    expect(withMeetingDetails(event({ location: 'Room 4' }), zoomMeeting).location).toBe('Room 4')
    // Graph's bodyPreview truncates the block; the remainder is still recognised.
    expect(stripMeetingDetails(`Notes\n\n${block.slice(0, 60)}`)).toBe('Notes')
    const webex = meetingDetailsBlock({ provider: 'webex', meetingId: 's', joinUrl: 'https://acme.webex.com/j', meetingNumber: '255 1234 5678', passcode: 'pw', phonePasscode: '2453', sipAddress: '2551@acme.webex.com', dialIn: [{ number: '+1-415-655-0002', label: 'US Toll' }] })
    expect(webex).toContain('Meeting number: 255 1234 5678\nPassword: pw\nDial in (US Toll): +1-415-655-0002\nPhone and video system password: 2453\nAccess code: 255 1234 5678\nJoin by video system: 2551@acme.webex.com')
  })
})

describe('hosted meeting lifecycle', () => {
  it('creates the meeting before the event, links it, re-attaches it after sync, and follows edits', async () => {
    const prepared = await coordinator.prepare(googleCalendar, event({ conference: zoomRequest }))
    expect(connector.createMeeting).toHaveBeenCalledWith({ requestId, title: 'Planning', start: '2026-03-02T14:00:00.000Z', end: '2026-03-02T14:45:00.000Z', timeZone: 'Europe/London' })
    expect(prepared.event.conference).toEqual({ provider: 'zoom', status: 'ready', requestId, joinUrl: zoomMeeting.joinUrl, conferenceId: '857 4606 5432', phone: '+1 646 558 8656 (US (New York))', pin: '123456' })
    expect(prepared.event.description).toContain('Join Zoom meeting')
    expect(prepared.event.location).toBe(zoomMeeting.joinUrl)

    const saved = coordinator.finish(prepared, written(prepared.event))
    expect(saved.conference).toMatchObject({ provider: 'zoom', joinUrl: zoomMeeting.joinUrl })
    expect(store.get(requestId)).toMatchObject({ state: 'created', eventId: saved.id, calendarId: googleCalendar.id, accountId: 'a' })
    // Provider reads never report the meeting; synchronization puts it back.
    expect(coordinator.decorate([{ ...saved, conference: undefined }, synced({ id: 'other' })]).map((item) => item.conference?.provider)).toEqual(['zoom', undefined])

    // Notes-only edit: no meeting update.
    const notes = await coordinator.prepare(googleCalendar, { ...saved, description: `${saved.description}\nBring slides` }, saved)
    expect(connector.updateMeeting).not.toHaveBeenCalled()
    expect(notes.event.description?.match(/Join Zoom meeting/g)).toHaveLength(1)

    // Title and time change: the meeting follows before the event is written.
    const moved = { ...saved, title: 'Planning (moved)', start: '2026-03-03T09:00:00.000Z', end: '2026-03-03T10:00:00.000Z' }
    const edit = await coordinator.prepare(googleCalendar, moved, saved)
    expect(connector.updateMeeting).toHaveBeenCalledWith(zoomMeeting, { requestId, title: 'Planning (moved)', start: '2026-03-03T09:00:00.000Z', end: '2026-03-03T10:00:00.000Z', timeZone: 'Europe/London' })
    expect(edit.event.conference?.joinUrl).toBe(zoomMeeting.joinUrl)
    coordinator.finish(edit, written(edit.event))
    expect(store.get(requestId)?.request.title).toBe('Planning (moved)')
    expect(connector.createMeeting).toHaveBeenCalledTimes(1)
  })

  it('leaves the event unsaved when the host refuses an edit', async () => {
    const saved = coordinator.finish(await coordinator.prepare(googleCalendar, event({ conference: zoomRequest })), written(event()))
    connector.updateMeeting.mockRejectedValueOnce(new MeetingHostRequestError('Zoom returned an error (400): Invalid start time', 400, false))
    await expect(coordinator.prepare(googleCalendar, { ...saved, start: '2026-03-02T15:00:00.000Z', end: '2026-03-02T16:00:00.000Z' }, saved))
      .rejects.toThrow('Zoom did not accept the new title or time, so the event was not saved: Zoom returned an error (400): Invalid start time')
    expect(store.get(requestId)?.request.start).toBe('2026-03-02T14:00:00.000Z')
  })

  it('cancels the meeting when the event is deleted, or keeps it when asked', async () => {
    const saved = coordinator.finish(await coordinator.prepare(googleCalendar, event({ conference: zoomRequest })), written(event()))
    expect(coordinator.meetingOptions(requestId)).toEqual({ provider: 'zoom', cancelOnDelete: true, meetingId: '85746065432' })
    await coordinator.eventDeleted(saved)
    expect(connector.deleteMeeting).toHaveBeenCalledWith(zoomMeeting)
    expect(store.get(requestId)?.state).toBe('cancelled')
    expect(coordinator.decorate([{ ...saved, conference: undefined }])[0].conference).toBeUndefined()

    const second = '1123456789abcdef0123456789abcdef'
    const other = coordinator.finish(await coordinator.prepare(googleCalendar, event({ id: 'draft-2', conference: { ...zoomRequest, requestId: second } })), synced({ id: 'a:google-event:primary:remote-2' }))
    expect(coordinator.setCancelOnDelete(second, false)).toMatchObject({ cancelOnDelete: false })
    connector.deleteMeeting.mockClear()
    await coordinator.eventDeleted(other)
    expect(connector.deleteMeeting).not.toHaveBeenCalled()
    expect(store.get(second)?.state).toBe('detached')
    expect(() => coordinator.setCancelOnDelete(second, true)).toThrow(/no longer linked/)
  })

  it('explains a failed cancellation after the event is gone and never re-attaches that meeting', async () => {
    const saved = coordinator.finish(await coordinator.prepare(googleCalendar, event({ conference: zoomRequest })), written(event()))
    connector.deleteMeeting.mockRejectedValueOnce(new MeetingHostAuthError('zoom', revokedMessage('Zoom')))
    await expect(coordinator.eventDeleted(saved)).rejects.toThrow(/^The event was deleted, but Zoom could not cancel the meeting: Zoom no longer accepts Aerio’s access.*Reconnect Zoom/)
    expect(store.get(requestId)).toMatchObject({ state: 'detached', lastError: expect.stringContaining('no longer accepts') })
    expect(coordinator.decorate([{ ...saved, conference: undefined }])[0].conference).toBeUndefined()
  })

  it('removes the meeting from the event, then cancels it', async () => {
    const saved = coordinator.finish(await coordinator.prepare(googleCalendar, event({ conference: zoomRequest })), written(event()))
    const removal = await coordinator.prepare(googleCalendar, { ...saved, conference: { ...saved.conference!, status: 'removed' } }, saved)
    expect(removal.event.conference).toBeUndefined()
    expect(removal.event.description).toBe('Agenda: roadmap')
    expect(removal.event.location).toBe('')
    expect(connector.deleteMeeting).not.toHaveBeenCalled()
    coordinator.finish(removal, written(removal.event))
    await coordinator.settle(removal)
    expect(connector.deleteMeeting).toHaveBeenCalledWith(zoomMeeting)
    expect(store.get(requestId)?.state).toBe('cancelled')
  })
})

describe('duplicate prevention', () => {
  const timedOut = () => new MeetingHostRequestError('Zoom did not answer in time', undefined, true)

  it('searches the host before creating again after an uncertain outcome', async () => {
    connector.createMeeting.mockRejectedValueOnce(timedOut())
    await expect(coordinator.prepare(googleCalendar, event({ conference: zoomRequest }))).rejects.toThrow(/Zoom did not confirm whether the meeting was created \(Zoom did not answer in time\)\. The event was not saved\. Save again/)
    // The attempt was recorded before the call, so it survives a restart.
    store.close()
    store = new MeetingLinkStore(join(directory, 'productivity.sqlite'))
    coordinator = new HostedMeetingCoordinator({ store, connector: () => connector })
    expect(store.get(requestId)).toMatchObject({ state: 'creating', lastError: 'Zoom did not answer in time' })

    connector.findMeeting.mockResolvedValueOnce(zoomMeeting)
    const retry = await coordinator.prepare(googleCalendar, event({ conference: zoomRequest }))
    expect(connector.findMeeting).toHaveBeenCalledWith(expect.objectContaining({ requestId }))
    expect(connector.createMeeting).toHaveBeenCalledTimes(1)
    expect(retry.event.conference?.joinUrl).toBe(zoomMeeting.joinUrl)
    expect(store.get(requestId)?.state).toBe('created')
  })

  it('creates again only when the search finds nothing, and never when the search fails', async () => {
    connector.createMeeting.mockRejectedValueOnce(timedOut())
    await expect(coordinator.prepare(googleCalendar, event({ conference: zoomRequest }))).rejects.toThrow(/did not confirm/)
    connector.findMeeting.mockRejectedValueOnce(new MeetingHostRequestError('Zoom could not be reached', undefined, true))
    await expect(coordinator.prepare(googleCalendar, event({ conference: zoomRequest }))).rejects.toThrow('Zoom could not be reached')
    expect(connector.createMeeting).toHaveBeenCalledTimes(1)
    await coordinator.prepare(googleCalendar, event({ conference: zoomRequest }))
    expect(connector.findMeeting).toHaveBeenCalledTimes(2)
    expect(connector.createMeeting).toHaveBeenCalledTimes(2)
  })

  it('forgets a definitely refused attempt, so the retry does not need a search', async () => {
    connector.createMeeting.mockRejectedValueOnce(new MeetingHostRequestError('Zoom refused this request', 403, false))
    await expect(coordinator.prepare(googleCalendar, event({ conference: zoomRequest }))).rejects.toThrow('Zoom refused this request')
    expect(store.get(requestId)).toBeUndefined()
    await coordinator.prepare(googleCalendar, event({ conference: zoomRequest }))
    expect(connector.findMeeting).not.toHaveBeenCalled()
  })

  it('reuses the meeting when the calendar write failed after it was created', async () => {
    await coordinator.prepare(googleCalendar, event({ conference: zoomRequest }))
    // The calendar write failed; the editor retries with the same request id (and a corrected title).
    const retry = await coordinator.prepare(googleCalendar, event({ title: 'Planning v2', conference: zoomRequest }))
    expect(connector.createMeeting).toHaveBeenCalledTimes(1)
    expect(connector.findMeeting).not.toHaveBeenCalled()
    expect(connector.updateMeeting).toHaveBeenCalledWith(zoomMeeting, expect.objectContaining({ title: 'Planning v2' }))
    expect(retry.requestId).toBe(requestId)
    // Same for an existing event whose cached copy holds the pending request.
    const current = synced({ conference: zoomRequest })
    const update = await coordinator.prepare(googleCalendar, { ...current, title: 'Planning v2' }, current)
    expect(connector.createMeeting).toHaveBeenCalledTimes(1)
    expect(update.event.conference).toMatchObject({ status: 'ready', joinUrl: zoomMeeting.joinUrl })
  })

  it('does not create a second meeting for an event that already has one', async () => {
    const saved = coordinator.finish(await coordinator.prepare(googleCalendar, event({ conference: zoomRequest })), written(event()))
    await coordinator.prepare(googleCalendar, { ...saved, conference: { provider: 'zoom', status: 'pending', requestId: 'ffffffffffffffffffffffffffffffff' } }, saved)
    expect(connector.createMeeting).toHaveBeenCalledTimes(1)
  })
})

describe('hosted meeting availability', () => {
  it('explains revoked credentials and refuses all-day and repeating events before calling Zoom', async () => {
    account = { ...account, needsReconnect: true, error: 'Zoom refused Aerio’s access' }
    await expect(coordinator.prepare(googleCalendar, event({ conference: zoomRequest }))).rejects.toThrow('Zoom access was revoked or expired; reconnect Zoom in Settings › Online meetings')
    account = { ...account, needsReconnect: undefined, connected: false }
    await expect(coordinator.prepare(googleCalendar, event({ conference: zoomRequest }))).rejects.toThrow('Connect Zoom in Settings › Online meetings')
    account = { ...account, connected: true }
    await expect(coordinator.prepare(googleCalendar, event({ conference: zoomRequest, allDay: true, start: '2026-03-02', end: '2026-03-03' }))).rejects.toThrow(/need a start and end time/)
    await expect(coordinator.prepare(googleCalendar, event({ conference: zoomRequest, recurrence: 'weekly' }))).rejects.toThrow(/single events only/)
    await expect(coordinator.prepare({ ...googleCalendar, canWrite: false }, event({ conference: zoomRequest }))).rejects.toThrow(/enable Calendar editing/)
    await expect(coordinator.prepare(googleCalendar, event({ conference: { provider: 'webex', status: 'pending', requestId } }))).rejects.toThrow(/not available in this build/)
    expect(connector.createMeeting).not.toHaveBeenCalled()
  })

  it('passes revoked-credential errors from the host through with the reconnect explanation', async () => {
    connector.createMeeting.mockRejectedValueOnce(new MeetingHostAuthError('zoom', revokedMessage('Zoom')))
    await expect(coordinator.prepare(googleCalendar, event({ conference: zoomRequest }))).rejects.toThrow(/Reconnect Zoom in Settings › Online meetings, then try again/)
    // An authentication refusal is definite: nothing was created.
    expect(store.get(requestId)).toBeUndefined()
  })

  it('leaves Google Meet and Teams requests to the calendar connectors', async () => {
    const meet = event({ conference: { provider: 'googleMeet', status: 'pending', requestId } })
    await expect(coordinator.prepare(googleCalendar, meet)).resolves.toEqual({ event: meet })
    const teams = event({ calendarId: microsoftCalendar.id, conference: { provider: 'teams', status: 'removed' } })
    await expect(coordinator.prepare(microsoftCalendar, teams, synced({ conference: { provider: 'teams', status: 'ready', joinUrl: 'https://teams.microsoft.com/l/x' } }))).resolves.toEqual({ event: teams })
    expect(coordinator.decorate([meet])).toEqual([meet])
    expect(connector.createMeeting).not.toHaveBeenCalled()
  })
})

describe('calendar connectors with hosted meetings', () => {
  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, headers: new Headers() })

  it('writes the Zoom details to Google without requesting a Google conference', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      return ok({ id: 'remote-1', summary: body.summary, description: body.description, location: body.location, start: body.start, end: body.end })
    })
    vi.stubGlobal('fetch', fetchMock)
    const prepared = await coordinator.prepare(googleCalendar, event({ conference: zoomRequest }))
    const saved = coordinator.finish(prepared, await new GoogleProductivityConnector('a', async () => 'token', true).createEvent(googleCalendar, prepared.event))
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(body.conferenceData).toBeUndefined()
    expect(body.id).toBeUndefined()
    expect(body.location).toBe(zoomMeeting.joinUrl)
    expect(body.description).toContain(`Join Zoom meeting\n${zoomMeeting.joinUrl}\nMeeting ID: 857 4606 5432`)
    expect(saved.conference).toMatchObject({ provider: 'zoom', joinUrl: zoomMeeting.joinUrl })
    // The next sync maps the provider event without a conference; decorate restores it.
    const remote = mapGoogleEvent('a', googleCalendar, { id: 'remote-1', summary: 'Planning', start: { dateTime: event().start }, end: { dateTime: event().end }, description: body.description })!
    expect(remote.conference).toBeUndefined()
    expect(coordinator.decorate([remote])[0].conference?.provider).toBe('zoom')
  })

  it('removes a Zoom meeting from a Microsoft event without asking Graph to detach a Teams meeting', async () => {
    const msCoordinator = coordinator
    const created = await msCoordinator.prepare(microsoftCalendar, event({ calendarId: microsoftCalendar.id, conference: zoomRequest }))
    const current = msCoordinator.finish(created, { ...synced({ ...created.event, id: 'b:microsoft-event:main:graph-1', remoteId: 'graph-1', accountId: 'b', provider: 'microsoft', calendarId: microsoftCalendar.id }), conference: undefined } as SyncedCalendarEvent)
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ok({ id: 'graph-1', subject: 'Planning', start: { dateTime: '2026-03-02T14:00:00.0000000' }, end: { dateTime: '2026-03-02T14:45:00.0000000' }, isOrganizer: true }))
    vi.stubGlobal('fetch', fetchMock)
    const removal = await msCoordinator.prepare(microsoftCalendar, { ...current, conference: { ...current.conference!, status: 'removed' } }, current)
    await new MicrosoftProductivityConnector('b', async () => 'token', true).updateEvent(microsoftCalendar, current, removal.event)
    const patch = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body))
    expect(patch.isOnlineMeeting).toBeUndefined()
    expect(patch.body.content).toBe('Agenda: roadmap')
    await msCoordinator.settle(removal)
    expect(connector.deleteMeeting).toHaveBeenCalledTimes(1)
  })
})
