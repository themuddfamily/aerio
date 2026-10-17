import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncedCalendar } from '../../src/productivity-types'
import { hostedConferenceCapability } from '../../src/lib/online-meetings'
import { mapWebexMeeting, mapZoomMeeting, WebexMeetingConnector, ZoomMeetingConnector } from './hosted-meeting-connectors'
import { MeetingHostHttp, MeetingHostRequestError, isUncertainOutcome } from './meeting-host-http'
import { parseMeetingHostEnvironment } from './meeting-host-providers'
import { MeetingHostAuthError, MeetingHostVault } from './meeting-host-vault'

// Reversible stand-in for OS secure storage; never stores plaintext JSON.
const storage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString: (value: string) => Buffer.from(`enc:${Buffer.from(value).toString('base64')}`),
  decryptString: (value: Buffer) => Buffer.from(value.toString().slice(4), 'base64').toString()
}
const zoomClient = { clientId: 'zoomClientId123', clientSecret: 'zoomClientSecret456' }
const webexClient = { clientId: 'webexClientId123', clientSecret: 'webexClientSecret456' }
const requestId = '0123456789abcdef0123456789abcdef'
const calendar: SyncedCalendar = { id: 'a:google-calendar:primary', remoteId: 'primary', accountId: 'a', provider: 'gmail', name: 'Main', color: '#000', primary: true, canWrite: true }

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>
const json = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const form = (init?: RequestInit) => new URLSearchParams(String(init?.body ?? ''))

let directory: string
let now: number
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'aerio-meeting-hosts-'))
  now = Date.parse('2026-03-01T10:00:00Z')
})
afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
  vi.restoreAllMocks()
})

// Completes the browser leg of the loopback flow: Aerio's callback receives the code with the issued state.
const browser = (code = 'auth-code') => {
  const opened: URL[] = []
  return {
    opened,
    openExternal: async (url: string) => {
      const authorization = new URL(url)
      opened.push(authorization)
      const callback = new URL(authorization.searchParams.get('redirect_uri')!)
      callback.searchParams.set('code', code)
      callback.searchParams.set('state', authorization.searchParams.get('state')!)
      const response = await fetch(callback)
      expect(response.status).toBe(200)
    }
  }
}

const vault = (fetchMock: unknown, options: Partial<ConstructorParameters<typeof MeetingHostVault>[1]> = {}) => new MeetingHostVault(join(directory, 'meeting-host-vault.dat'), {
  storage, builtIn: { zoom: zoomClient, webex: webexClient }, openExternal: async () => undefined, fetch: fetchMock as unknown as typeof fetch,
  ports: { zoom: 0, webex: 0 }, now: () => now, ...options
})

const connectedVault = (fetchMock: FetchFn, expiresIn = 3600) => {
  const tokens = new Map([['https://zoom.us/oauth/token', { access_token: 'zoom-access', refresh_token: 'zoom-refresh', expires_in: expiresIn }], ['https://webexapis.com/v1/access_token', { access_token: 'webex-access', refresh_token: 'webex-refresh', expires_in: expiresIn }]])
  const setup = vi.fn<FetchFn>(async (url: string) => {
    if (tokens.has(url)) return json(200, tokens.get(url))
    if (url.endsWith('/users/me')) return json(200, { id: 'zoom-user', email: 'host@example.test', display_name: 'Host' })
    return json(200, { id: 'webex-user', emails: ['host@example.test'], displayName: 'Host' })
  })
  const flow = browser()
  const result = vault(setup, { openExternal: flow.openExternal })
  return { vault: result, connect: async () => { await result.authorize('zoom'); await result.authorize('webex'); setup.mockReset(); setup.mockImplementation(fetchMock) } }
}

describe('meeting-host OAuth vault', () => {
  it('connects Zoom with PKCE over the loopback redirect and keeps tokens encrypted', async () => {
    const flow = browser('zoom-code')
    const fetchMock = vi.fn<FetchFn>(async (url: string, init?: RequestInit) => {
      if (url === 'https://zoom.us/oauth/token') return json(200, { access_token: 'zoom-access', refresh_token: 'zoom-refresh', expires_in: 3600, scope: 'meeting:write:meeting meeting:read:meeting meeting:update:meeting meeting:delete:meeting user:read:user' })
      if (url === 'https://api.zoom.us/v2/users/me') {
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer zoom-access')
        return json(200, { id: 'user-1', email: 'host@example.test', display_name: 'Ada Host' })
      }
      throw new Error(`unexpected ${url}`)
    })
    const hosts = vault(fetchMock, { openExternal: flow.openExternal })
    const account = await hosts.authorize('zoom')
    expect(account).toMatchObject({ provider: 'zoom', connected: true, email: 'host@example.test', displayName: 'Ada Host', configSource: 'built-in' })

    const authorization = flow.opened[0]
    expect(authorization.origin + authorization.pathname).toBe('https://zoom.us/oauth/authorize')
    expect(authorization.searchParams.get('client_id')).toBe(zoomClient.clientId)
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorization.searchParams.get('redirect_uri')).toMatch(/^http:\/\/localhost:\d+\/oauth\/zoom$/)
    // Zoom grants the scopes listed on the app registration rather than a scope parameter.
    expect(authorization.searchParams.has('scope')).toBe(false)

    const [, tokenInit] = fetchMock.mock.calls[0]
    const body = form(tokenInit)
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('zoom-code')
    expect(body.get('redirect_uri')).toBe(authorization.searchParams.get('redirect_uri'))
    expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url')).toBe(authorization.searchParams.get('code_challenge'))
    expect(new Headers(tokenInit?.headers).get('Authorization')).toBe(`Basic ${Buffer.from(`${zoomClient.clientId}:${zoomClient.clientSecret}`).toString('base64')}`)
    expect(body.has('client_secret')).toBe(false)

    const stored = readFileSync(join(directory, 'meeting-host-vault.dat'), 'utf8')
    expect(stored).not.toContain('zoom-access')
    expect(Buffer.from(stored, 'base64').toString()).toMatch(/^enc:/)
    // A fresh instance reads the same grant back.
    expect(vault(vi.fn()).account('zoom')).toMatchObject({ connected: true, email: 'host@example.test' })
  })

  it('connects Webex with its scope list and client credentials in the token request', async () => {
    const flow = browser('webex-code')
    const fetchMock = vi.fn<FetchFn>(async (url: string) => url === 'https://webexapis.com/v1/access_token'
      ? json(200, { access_token: 'webex-access', refresh_token: 'webex-refresh', expires_in: 1209600 })
      : json(200, { id: 'person-1', emails: ['host@example.test'], displayName: 'Ada Host' }))
    const hosts = vault(fetchMock, { openExternal: flow.openExternal })
    await expect(hosts.authorize('webex')).resolves.toMatchObject({ provider: 'webex', connected: true, email: 'host@example.test' })
    expect(flow.opened[0].searchParams.get('scope')).toBe('meeting:schedules_write meeting:schedules_read spark:people_read')
    const body = form(fetchMock.mock.calls[0][1])
    expect([body.get('client_id'), body.get('client_secret'), body.get('code')]).toEqual([webexClient.clientId, webexClient.clientSecret, 'webex-code'])
    expect(fetchMock.mock.calls[1][0]).toBe('https://webexapis.com/v1/people/me')
  })

  it('refuses a registration that does not grant the meeting scopes and stores nothing', async () => {
    const flow = browser()
    const fetchMock = vi.fn<FetchFn>(async () => json(200, { access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: 'user:read:user meeting:read:meeting' }))
    const hosts = vault(fetchMock, { openExternal: flow.openExternal })
    await expect(hosts.authorize('zoom')).rejects.toThrow(/does not grant meeting:write:meeting, meeting:update:meeting, meeting:delete:meeting/)
    expect(hosts.account('zoom').connected).toBe(false)
    expect(existsSync(join(directory, 'meeting-host-vault.dat'))).toBe(false)
  })

  it('stops on a mismatched OAuth state', async () => {
    const hosts = vault(vi.fn(), {
      openExternal: async (url) => {
        const callback = new URL(new URL(url).searchParams.get('redirect_uri')!)
        callback.searchParams.set('code', 'x')
        callback.searchParams.set('state', 'forged')
        expect((await fetch(callback)).status).toBe(400)
      }
    })
    await expect(hosts.authorize('zoom')).rejects.toThrow(/invalid OAuth state/)
  })

  it('renews expired tokens once for concurrent callers and keeps the rotated refresh token', async () => {
    const fetchMock = vi.fn<FetchFn>(async (_url: string, init?: RequestInit) => {
      expect(form(init).get('grant_type')).toBe('refresh_token')
      expect(form(init).get('refresh_token')).toBe('zoom-refresh')
      return json(200, { access_token: 'zoom-access-2', refresh_token: 'zoom-refresh-2', expires_in: 3600 })
    })
    const { vault: hosts, connect } = connectedVault(fetchMock)
    await connect()
    now += 2 * 60 * 60_000
    const [first, second] = await Promise.all([hosts.accessToken('zoom'), hosts.accessToken('zoom')])
    expect([first, second]).toEqual(['zoom-access-2', 'zoom-access-2'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await hosts.accessToken('zoom')).toBe('zoom-access-2')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('marks a refused refresh as revoked and explains how to reconnect', async () => {
    const changed = vi.fn()
    const fetchMock = vi.fn<FetchFn>(async () => json(400, { reason: 'Invalid Token!', error: 'invalid_grant' }))
    const { vault: hosts, connect } = connectedVault(fetchMock)
    await connect()
    ;(hosts as unknown as { options: { changed?: () => void } }).options.changed = changed
    now += 2 * 60 * 60_000
    const failure = await hosts.accessToken('zoom').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(MeetingHostAuthError)
    expect((failure as Error).message).toMatch(/Reconnect Zoom in Settings › Online meetings/)
    expect(hosts.account('zoom')).toMatchObject({ connected: true, needsReconnect: true, error: expect.stringContaining('Invalid Token!') })
    expect(changed).toHaveBeenCalled()
    // No further network calls until reconnect.
    await expect(hosts.accessToken('zoom')).rejects.toBeInstanceOf(MeetingHostAuthError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(hostedConferenceCapability('zoom', calendar, hosts.account('zoom'))).toMatchObject({ available: false, reason: expect.stringContaining('reconnect Zoom') })
    // Webex is unaffected.
    expect(hosts.account('webex').needsReconnect).toBeUndefined()
  })

  it('treats an unreachable token endpoint as transient, not revoked', async () => {
    const { vault: hosts, connect } = connectedVault(vi.fn<FetchFn>(async () => { throw new TypeError('fetch failed') }))
    await connect()
    now += 2 * 60 * 60_000
    await expect(hosts.accessToken('webex')).rejects.toThrow(/could not be reached/)
    expect(hosts.account('webex').needsReconnect).toBeUndefined()
  })

  it('disconnects by revoking at Zoom and clearing the grant but keeps a user registration', async () => {
    const fetchMock = vi.fn<FetchFn>(async () => json(200, {}))
    const flow = browser()
    const setup = vi.fn<FetchFn>(async (url: string) => url.includes('token') ? json(200, { access_token: 'zoom-access', refresh_token: 'zoom-refresh', expires_in: 3600 }) : json(200, { id: 'u' }))
    const hosts = vault(setup, { builtIn: {}, openExternal: flow.openExternal })
    expect(hosts.account('zoom')).toMatchObject({ configured: false, connected: false })
    expect(hostedConferenceCapability('zoom', calendar, hosts.account('zoom')).reason).toMatch(/no Zoom app registration/)
    expect(() => hosts.configure('zoom', 'short', 'x')).toThrow(/client ID/)
    hosts.configure('zoom', zoomClient.clientId, zoomClient.clientSecret)
    expect(hosts.account('zoom')).toMatchObject({ configured: true, configSource: 'user' })
    await hosts.authorize('zoom')
    setup.mockImplementation(fetchMock)
    const snapshot = await hosts.disconnect('zoom')
    expect(fetchMock).toHaveBeenCalledWith('https://zoom.us/oauth/revoke', expect.objectContaining({ method: 'POST' }))
    expect(form(fetchMock.mock.calls[0][1]).get('token')).toBe('zoom-access')
    expect(snapshot.accounts.find((item) => item.provider === 'zoom')).toMatchObject({ configured: true, connected: false })
    await expect(hosts.accessToken('zoom')).rejects.toThrow(/Connect Zoom/)
  })

  it('refuses to store credentials without OS encryption', () => {
    const hosts = new MeetingHostVault(join(directory, 'meeting-host-vault.dat'), { storage: { ...storage, isEncryptionAvailable: () => false }, openExternal: async () => undefined })
    expect(() => hosts.configure('webex', webexClient.clientId, webexClient.clientSecret)).toThrow(/Secure credential storage is unavailable/)
  })

  it('reads build-time registrations in pairs', () => {
    expect(parseMeetingHostEnvironment({})).toEqual({})
    expect(parseMeetingHostEnvironment({ zoomClientId: zoomClient.clientId, zoomClientSecret: zoomClient.clientSecret })).toEqual({ zoom: zoomClient })
    expect(() => parseMeetingHostEnvironment({ webexClientId: webexClient.clientId })).toThrow(/MAIN_VITE_WEBEX_CLIENT_SECRET/)
  })
})

// --- Connectors ---

const tokens = () => ({
  accessToken: vi.fn(async (_provider: string, options?: { forceRefresh?: boolean }) => options?.forceRefresh ? 'renewed' : 'token'),
  markRevoked: vi.fn((_provider: string, _reason?: string) => undefined)
})
const connectedAccount = (provider: 'zoom' | 'webex') => ({ provider, configured: true, connected: true, redirectUri: '', scopes: [] })
const request = { requestId, title: 'Planning', start: '2026-03-02T14:00:00.000Z', end: '2026-03-02T14:45:00.000Z', timeZone: 'Europe/London' }
const zoomCreated = {
  id: 85746065432, topic: 'Planning', join_url: 'https://us02web.zoom.us/j/85746065432?pwd=abc', password: 'k9Lp2', pstn_password: '123456', start_url: 'https://zoom.us/s/secret-host-link',
  settings: { global_dial_in_numbers: [{ country_name: 'US', city: 'New York', number: '+1 646 558 8656' }, { country_name: 'UK', number: '+44 203 481 5240' }] }
}
const calls = (fetchMock: { mock: { calls: Parameters<FetchFn>[] } }) => fetchMock.mock.calls.map(([url, init]) => [String(url), (init as RequestInit | undefined)?.method ?? 'GET', (init as RequestInit | undefined)?.body ? JSON.parse(String((init as RequestInit).body)) : undefined])

describe('Zoom meeting connector', () => {
  const zoom = (fetchMock: FetchFn, auth = tokens()) => new ZoomMeetingConnector(new MeetingHostHttp('zoom', auth, { fetch: fetchMock as unknown as typeof fetch }), () => connectedAccount('zoom'))

  it('schedules a type 2 meeting with the request marker and maps join, passcode, and dial-in details', async () => {
    const fetchMock = vi.fn<FetchFn>(async () => json(201, zoomCreated))
    const meeting = await zoom(fetchMock).createMeeting(request)
    expect(calls(fetchMock)).toEqual([['https://api.zoom.us/v2/users/me/meetings', 'POST', {
      topic: 'Planning', type: 2, start_time: '2026-03-02T14:00:00Z', duration: 45, timezone: 'Europe/London', agenda: `Scheduled from Aerio (reference aerio-${requestId})`
    }]])
    expect(meeting).toEqual({
      provider: 'zoom', meetingId: '85746065432', joinUrl: 'https://us02web.zoom.us/j/85746065432?pwd=abc', meetingNumber: '857 4606 5432', passcode: 'k9Lp2', phonePasscode: '123456',
      dialIn: [{ number: '+1 646 558 8656', label: 'US (New York)' }, { number: '+44 203 481 5240', label: 'UK' }]
    })
    expect(JSON.stringify(meeting)).not.toContain('secret-host-link')
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer token')
  })

  it('finds an earlier attempt by its agenda marker across pages and reads its full details', async () => {
    const fetchMock = vi.fn<FetchFn>(async (url: string) => {
      if (url.includes('next_page_token=page-2')) return json(200, { meetings: [{ id: 85746065432, agenda: `Scheduled from Aerio (reference aerio-${requestId})` }] })
      if (url.includes('/users/me/meetings')) return json(200, { meetings: [{ id: 1, agenda: 'Other' }], next_page_token: 'page-2' })
      return json(200, zoomCreated)
    })
    await expect(zoom(fetchMock).findMeeting(request)).resolves.toMatchObject({ meetingId: '85746065432', passcode: 'k9Lp2' })
    expect(calls(fetchMock).map(([url]) => url)).toEqual([
      'https://api.zoom.us/v2/users/me/meetings?type=scheduled&page_size=300',
      'https://api.zoom.us/v2/users/me/meetings?type=scheduled&page_size=300&next_page_token=page-2',
      'https://api.zoom.us/v2/meetings/85746065432'
    ])
    await expect(zoom(vi.fn<FetchFn>(async () => json(200, { meetings: [] }))).findMeeting(request)).resolves.toBeUndefined()
  })

  it('updates the schedule with PATCH and treats an already deleted meeting as cancelled', async () => {
    const fetchMock = vi.fn<FetchFn>(async (_url: string, init?: RequestInit) => init?.method === 'DELETE' ? json(404, { code: 3001, message: 'Meeting does not exist' }) : new Response(null, { status: 204 }))
    const connector = zoom(fetchMock)
    const meeting = mapZoomMeeting(zoomCreated)
    await expect(connector.updateMeeting(meeting, { ...request, title: 'Renamed', end: '2026-03-02T15:00:00.000Z' })).resolves.toBe(meeting)
    await expect(connector.deleteMeeting(meeting)).resolves.toBeUndefined()
    expect(calls(fetchMock)).toEqual([
      ['https://api.zoom.us/v2/meetings/85746065432', 'PATCH', { topic: 'Renamed', start_time: '2026-03-02T14:00:00Z', duration: 60, timezone: 'Europe/London' }],
      ['https://api.zoom.us/v2/meetings/85746065432', 'DELETE', undefined]
    ])
  })

  it('renews once after a 401 and reports a second 401 as revoked credentials', async () => {
    const auth = tokens()
    const fetchMock = vi.fn<FetchFn>(async () => json(401, { code: 124, message: 'Invalid access token.' }))
    const failure = await zoom(fetchMock, auth).createMeeting(request).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(MeetingHostAuthError)
    expect((failure as Error).message).toMatch(/Reconnect Zoom/)
    expect(auth.accessToken).toHaveBeenLastCalledWith('zoom', { forceRefresh: true })
    expect(auth.markRevoked).toHaveBeenCalledWith('zoom', 'Invalid access token.')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get('Authorization')).toBe('Bearer renewed')
  })

  it('classifies timeouts, network failures, and 5xx as uncertain, and refusals as definite', async () => {
    const outcome = (response: () => Promise<Response>) => zoom(vi.fn<FetchFn>(response)).createMeeting(request).catch((error: unknown) => error)
    const timeout = await outcome(async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }) })
    expect(isUncertainOutcome(timeout)).toBe(true)
    expect((timeout as Error).message).toMatch(/did not answer in time/)
    expect(isUncertainOutcome(await outcome(async () => { throw new TypeError('fetch failed') }))).toBe(true)
    expect(isUncertainOutcome(await outcome(async () => json(502)))).toBe(true)
    const forbidden = await outcome(async () => json(403, { code: 200, message: 'No permission.' }))
    expect(forbidden).toBeInstanceOf(MeetingHostRequestError)
    expect(isUncertainOutcome(forbidden)).toBe(false)
    expect((forbidden as Error).message).toMatch(/No permission.*meeting-host permission/)
    expect(isUncertainOutcome(await outcome(async () => json(429)))).toBe(false)
    expect(isUncertainOutcome(await outcome(async () => json(400, { message: 'Invalid field.' })))).toBe(false)
    // A success without a join link may still have created a meeting.
    expect(isUncertainOutcome(await outcome(async () => json(201, { id: 1 })))).toBe(true)
  })
})

describe('Webex meeting connector', () => {
  const webexCreated = {
    id: 'series-1', meetingNumber: '25512345678', title: 'Planning', agenda: `Scheduled from Aerio (reference aerio-${requestId})`, password: 'BgJep@43',
    phoneAndVideoSystemPassword: '24537943', webLink: 'https://acme.webex.com/acme/j.php?MTID=m1', sipAddress: '25512345678@acme.webex.com',
    telephony: { accessCode: '25512345678', callInNumbers: [{ label: 'United States Toll', callInNumber: '+1-415-655-0002', tollType: 'toll' }] }
  }
  const webex = (fetchMock: FetchFn) => new WebexMeetingConnector(new MeetingHostHttp('webex', tokens(), { fetch: fetchMock as unknown as typeof fetch }), () => connectedAccount('webex'))

  it('creates, finds, updates, and cancels a meeting through /v1/meetings', async () => {
    const fetchMock = vi.fn<FetchFn>(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 204 })
      if (!init?.method || init.method === 'GET') return json(200, { items: [{ ...webexCreated, id: 'other', agenda: 'Team sync' }, webexCreated] })
      return json(200, webexCreated)
    })
    const connector = webex(fetchMock)
    const meeting = await connector.createMeeting(request)
    expect(meeting).toEqual({
      provider: 'webex', meetingId: 'series-1', joinUrl: 'https://acme.webex.com/acme/j.php?MTID=m1', meetingNumber: '255 1234 5678', passcode: 'BgJep@43', phonePasscode: '24537943',
      sipAddress: '25512345678@acme.webex.com', dialIn: [{ number: '+1-415-655-0002', label: 'United States Toll' }]
    })
    await expect(connector.findMeeting(request)).resolves.toMatchObject({ meetingId: 'series-1' })
    await connector.updateMeeting(meeting, { ...request, start: '2026-03-02T15:00:00.000Z', end: '2026-03-02T15:30:00.000Z' })
    await connector.deleteMeeting(meeting)
    expect(calls(fetchMock)).toEqual([
      ['https://webexapis.com/v1/meetings', 'POST', { title: 'Planning', agenda: `Scheduled from Aerio (reference aerio-${requestId})`, start: '2026-03-02T14:00:00Z', end: '2026-03-02T14:45:00Z', timezone: 'Europe/London' }],
      ['https://webexapis.com/v1/meetings?from=2026-03-01T14%3A00%3A00Z&to=2026-03-03T14%3A45%3A00Z&max=100', 'GET', undefined],
      ['https://webexapis.com/v1/meetings/series-1', 'PUT', { title: 'Planning', agenda: `Scheduled from Aerio (reference aerio-${requestId})`, start: '2026-03-02T15:00:00Z', end: '2026-03-02T15:30:00Z', timezone: 'Europe/London', password: 'BgJep@43' }],
      ['https://webexapis.com/v1/meetings/series-1', 'DELETE', undefined]
    ])
    expect(mapWebexMeeting({ id: 'x', webLink: 'https://acme.webex.com/x' })).toEqual({ provider: 'webex', meetingId: 'x', joinUrl: 'https://acme.webex.com/x' })
  })

  it('reports Webex error details', async () => {
    const failure = await webex(vi.fn<FetchFn>(async () => json(400, { message: 'The request could not be understood', errors: [{ description: 'Start time must be in the future' }] }))).createMeeting(request).catch((error: unknown) => error)
    expect((failure as Error).message).toBe('Webex returned an error (400): The request could not be understood: Start time must be in the future')
  })
})
