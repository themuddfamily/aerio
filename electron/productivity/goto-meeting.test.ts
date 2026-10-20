import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GoToMeetingConnector, mapGoToMeeting } from './goto-meeting'
import { MeetingHostHttp } from './meeting-host-http'
import { MeetingHostVault } from './meeting-host-vault'
import { MeetingLinkStore } from './meeting-link-store'
import { HostedMeetingCoordinator, stripMeetingDetails, withMeetingDetails } from './meeting-coordinator'
import { checkJoinLink, conferenceCapabilities, validEventConference } from '../../src/lib/online-meetings'
import type { SyncedCalendar } from '../../src/productivity-types'
const account = { provider: 'goto' as const, configured: true, connected: true, redirectUri: '', scopes: [] }
const request = { requestId: '0123456789abcdef0123456789abcdef', title: 'Quarterly <review>', start: '2030-10-20T10:00:00Z', end: '2030-10-20T11:00:00Z' }
const result = { meetingid: 123456789, joinURL: 'https://meet.goto.com/123456789' }
const calendar: SyncedCalendar = { id: 'calendar', accountId: 'account', remoteId: 'calendar', provider: 'gmail', name: 'Calendar', color: '#fff', primary: true, canWrite: true }
const directories: string[] = []
afterEach(() => { for (const path of directories) rmSync(path, { recursive: true, force: true }); directories.length = 0 })
const directory = () => { const path = mkdtempSync(join(tmpdir(), 'aerio-goto-')); directories.push(path); return path }
const tokens = { accessToken: vi.fn(async () => 'fixture-access'), markRevoked: vi.fn() }
function fixture(...responses: (Response | unknown)[]) {
  const fetcher = vi.fn(async (_input: URL | RequestInfo, _init?: RequestInit) => { const response = responses.shift(); if (response instanceof Error) throw response; return response instanceof Response ? response : Response.json(response) })
  return { fetcher, connector: new GoToMeetingConnector(new MeetingHostHttp('goto', tokens, { fetch: fetcher }), () => account, () => Date.parse('2026-10-20T00:00:00Z')) }
}
describe('GoToMeeting connector', () => {
  it('creates scheduled meetings with bounded escaped subjects and a stable recovery marker', async () => {
    const { connector, fetcher } = fixture([result])
    expect(await connector.createMeeting({ ...request, title: '<>'.repeat(100) })).toMatchObject({ provider: 'goto', meetingId: '123456789', joinUrl: result.joinURL })
    expect(String(fetcher.mock.calls[0][0])).toBe('https://api.getgo.com/G2M/rest/meetings')
    const init = fetcher.mock.calls[0][1]!
    const body = JSON.parse(init.body as string)
    expect(body).toMatchObject({ starttime: request.start, endtime: request.end, meetingtype: 'scheduled', timezonekey: '', conferencecallinfo: 'VoIP', passwordrequired: false })
    expect(body.subject.length).toBeLessThanOrEqual(100); expect(body.subject).not.toContain('<'); expect(body.subject).toMatch(/\[aerio:[a-f0-9]{24}\]$/)
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer fixture-access' } })
  })
  it('finds an uncertain creation by marker and reads its participant link without creating again', async () => {
    const created = fixture([result]); await created.connector.createMeeting(request)
    const subject = JSON.parse(created.fetcher.mock.calls[0][1]!.body as string).subject
    const { connector, fetcher } = fixture([{ meetingId: '123456789', subject }], [{ meetingId: '123456789', joinURL: result.joinURL }])
    expect(await connector.findMeeting(request)).toMatchObject({ meetingId: '123456789' })
    expect(fetcher.mock.calls.map((call) => call[1]?.method)).toEqual(['GET', 'GET'])
    expect(String(fetcher.mock.calls[0][0])).toContain('/upcomingMeetings')
    await expect(fixture({ meetings: [] }).connector.findMeeting(request)).rejects.toMatchObject({ uncertain: true })
    await expect(fixture([{ meetingId: '1', subject }, { meetingId: '2', subject }]).connector.findMeeting(request)).rejects.toThrow(/More than one/)
    await expect(fixture([{ meetingId: '123456789', subject }], [{ meetingId: '999', joinURL: result.joinURL }]).connector.findMeeting(request)).rejects.toThrow(/different recovered/)
  })
  it('updates title/time without replacing the meeting and treats a missing deletion as success', async () => {
    const { connector, fetcher } = fixture(new Response(null, { status: 204 }), new Response(null, { status: 404 }))
    const meeting = mapGoToMeeting(result)
    expect(await connector.updateMeeting(meeting, request)).toEqual(meeting)
    await connector.deleteMeeting(meeting)
    expect(fetcher.mock.calls.map((call) => call[1]?.method)).toEqual(['PUT', 'DELETE'])
    expect(String(fetcher.mock.calls[0][0])).toBe('https://api.getgo.com/G2M/rest/meetings/123456789')
  })
  it('rejects past/invalid dates before creating and treats unconfirmed responses as uncertain', async () => {
    const f = fixture()
    for (const modified of [{ start: 'bad' }, { start: '2020-01-01T00:00:00Z' }, { end: request.start }]) await expect(f.connector.createMeeting({ ...request, ...modified })).rejects.toMatchObject({ uncertain: false })
    expect(f.fetcher).not.toHaveBeenCalled()
    for (const response of [[], [result, result], [{}], [{ ...result, joinURL: 'https://hostile.test/start?hostToken=secret' }], new Error('lost connection')]) await expect(fixture(response).connector.createMeeting(request)).rejects.toMatchObject({ uncertain: true })
    expect(() => mapGoToMeeting({ ...result, meetingid: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/identity/)
  })
  it('recovers an ambiguous API creation through the durable coordinator after restart', async () => {
    const path = join(directory(), 'meetings.sqlite'); let store = new MeetingLinkStore(path)
    let posted = 0, subject = ''
    const fetcher = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      if (init?.method === 'POST') { posted++; subject = JSON.parse(init.body as string).subject; return new Response(null, { status: 503 }) }
      return Response.json(String(input).endsWith('upcomingMeetings') ? [{ ...result, subject }] : [result])
    })
    const connector = new GoToMeetingConnector(new MeetingHostHttp('goto', tokens, { fetch: fetcher }), () => account)
    const event = { id: 'event', color: '#fff', attendees: [], reminderMinutes: 10, title: request.title, start: request.start, end: request.end, calendarId: calendar.id, conference: { provider: 'goto' as const, status: 'pending' as const, requestId: request.requestId } }
    let coordinator = new HostedMeetingCoordinator({ store, connector: () => connector })
    await expect(coordinator.prepare(calendar, event)).rejects.toThrow(/did not confirm/)
    store.close(); store = new MeetingLinkStore(path); coordinator = new HostedMeetingCoordinator({ store, connector: () => connector })
    try { const prepared = await coordinator.prepare(calendar, event); expect(prepared.event.conference).toMatchObject({ provider: 'goto', status: 'ready', joinUrl: result.joinURL }); expect(posted).toBe(1) } finally { store.close() }
  })
  it('exposes Google/Microsoft calendar capability, validates conference metadata and strips invite blocks', () => {
    expect(conferenceCapabilities(calendar, [account]).find((item) => item.provider === 'goto')?.available).toBe(true)
    expect(conferenceCapabilities({ ...calendar, canWrite: false }, [account]).find((item) => item.provider === 'goto')?.available).toBe(false)
    expect(validEventConference({ provider: 'goto', status: 'ready', joinUrl: result.joinURL })).toBe(true)
    expect(checkJoinLink(result.joinURL).kind).toBe('trusted')
    const event = withMeetingDetails({ id: 'event', calendarId: calendar.id, color: '#fff', attendees: [], reminderMinutes: 10, title: 'Review', start: request.start, end: request.end, description: 'Notes' }, mapGoToMeeting(result))
    expect(event.description).toContain('Join GoToMeeting meeting')
    expect(stripMeetingDetails(event.description)).toBe('Notes')
  })
  it('authorizes with the current confidential OAuth endpoint, maps SCIM identity and renews encrypted tokens', async () => {
    const path = join(directory(), 'vault'), opened: URL[] = [], calls: RequestInit[] = []
    const storage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret', encryptString: (value: string) => Buffer.from('sealed:' + Buffer.from(value).toString('base64')), decryptString: (value: Buffer) => Buffer.from(value.toString().slice(7), 'base64').toString() }
    const fetcher = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      calls.push(init!)
      if (String(input).endsWith('/oauth/token')) return Response.json({ access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 3600 })
      expect(String(input)).toBe('https://api.getgo.com/identity/v1/Users/me')
      return Response.json({ id: 'organizer', userName: 'host@example.test', displayName: 'Host' })
    })
    const vault = new MeetingHostVault(path, { storage, ports: { goto: 0 }, fetch: fetcher, openExternal: async (url) => {
      const auth = new URL(url); opened.push(auth)
      const callback = new URL(auth.searchParams.get('redirect_uri')!); callback.searchParams.set('code', 'fixture-code'); callback.searchParams.set('state', auth.searchParams.get('state')!)
      expect((await fetch(callback)).status).toBe(200)
    } })
    vault.configure('goto', 'gotoClient123', 'gotoSecret456')
    expect(await vault.authorize('goto')).toMatchObject({ connected: true, email: 'host@example.test', displayName: 'Host' })
    expect(opened[0].origin).toBe('https://authentication.logmeininc.com')
    expect(opened[0].searchParams.has('code_challenge')).toBe(false)
    const tokenBody = new URLSearchParams(String(calls[0].body)); expect(tokenBody.get('code')).toBe('fixture-code'); expect(tokenBody.has('code_verifier')).toBe(false)
    expect(new Headers(calls[0].headers).get('Authorization')).toBe('Basic ' + Buffer.from('gotoClient123:gotoSecret456').toString('base64'))
    expect(calls.every((call) => call.redirect === 'error')).toBe(true)
    expect(readFileSync(path, 'utf8')).not.toMatch(/private-access|private-refresh|gotoSecret456/)
    expect(await vault.accessToken('goto', { forceRefresh: true })).toBe('private-access')
  })
})
