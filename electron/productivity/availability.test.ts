import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SyncedCalendar } from '../../src/productivity-types'
import {
  AvailabilityService, GOOGLE_FREEBUSY_SCOPE, availabilityScopeStatus, availabilityViewIntervals, graphInstant, graphWorkingHours,
  normalizeAttendeeAddress, registerAvailability, type AvailabilityDependencies
} from './availability'

const googleCalendar: SyncedCalendar = {
  id: 'g:google-calendar:primary', remoteId: 'primary', accountId: 'g', provider: 'gmail', name: 'Work', color: '#6558e8', primary: true, canWrite: true
}
const microsoftCalendar: SyncedCalendar = {
  id: 'm:microsoft-calendar:main', remoteId: 'main', accountId: 'm', provider: 'microsoft', name: 'Outlook', color: '#3b6fd8', primary: true, canWrite: true
}
const range = { start: '2026-10-20T00:00:00.000Z', end: '2026-10-21T00:00:00.000Z' }

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function service(overrides: Partial<AvailabilityDependencies> = {}) {
  const dependencies: AvailabilityDependencies = {
    calendars: () => [googleCalendar, microsoftCalendar],
    accountEmail: async (accountId) => accountId === 'g' ? 'me@company.com' : 'me@contoso.com',
    googleToken: vi.fn(async () => 'google-token'),
    microsoftToken: vi.fn(async () => 'microsoft-token'),
    grantedScopes: (_accountId, provider) => provider === 'gmail' ? [GOOGLE_FREEBUSY_SCOPE, 'https://www.googleapis.com/auth/calendar.events'] : ['Calendars.ReadWrite', 'User.Read'],
    now: () => Date.parse('2026-10-17T12:00:00Z'),
    ...overrides
  }
  return { service: new AvailabilityService(dependencies), dependencies }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('availability helpers', () => {
  it('normalizes attendee addresses and rejects non-addresses', () => {
    expect(normalizeAttendeeAddress(' Ada <ADA@Example.com> ')).toBe('ada@example.com')
    expect(normalizeAttendeeAddress('grace@example.org')).toBe('grace@example.org')
    expect(normalizeAttendeeAddress('Conference room')).toBeUndefined()
  })

  it('detects free/busy scopes per provider and treats legacy grants as unknown', () => {
    expect(availabilityScopeStatus('gmail', ['https://www.googleapis.com/auth/calendar.events'])).toEqual({ granted: false, known: true, missing: [GOOGLE_FREEBUSY_SCOPE] })
    expect(availabilityScopeStatus('gmail', ['https://www.googleapis.com/auth/calendar.readonly']).granted).toBe(true)
    expect(availabilityScopeStatus('microsoft', ['https://graph.microsoft.com/calendars.read']).granted).toBe(true)
    expect(availabilityScopeStatus('microsoft', ['Mail.ReadWrite']).missing).toEqual(['Calendars.ReadWrite'])
    expect(availabilityScopeStatus('gmail', undefined)).toEqual({ granted: true, known: false, missing: [] })
  })

  it('converts Graph date-times, working hours, and availability views', () => {
    expect(graphInstant({ dateTime: '2026-10-20T09:00:00.0000000', timeZone: 'UTC' })).toBe('2026-10-20T09:00:00.000Z')
    expect(graphInstant({ dateTime: '2026-10-20T09:00:00.0000000', timeZone: 'Pacific Standard Time' })).toBe('2026-10-20T16:00:00.000Z')
    expect(graphWorkingHours({ daysOfWeek: ['monday', 'Friday'], startTime: '08:30:00.0000000', endTime: '17:00:00.0000000', timeZone: { name: 'W. Europe Standard Time' } }))
      .toEqual({ days: [1, 5], start: '08:30', end: '17:00', timeZone: 'Europe/Berlin' })
    expect(graphWorkingHours({ daysOfWeek: ['monday'], startTime: '08:00', endTime: '17:00', timeZone: { name: 'Customized Time Zone' } })).toBeUndefined()
    expect(availabilityViewIntervals('0220130', '2026-10-20T09:00:00Z')).toEqual([
      { start: '2026-10-20T09:30:00.000Z', end: '2026-10-20T10:30:00.000Z', status: 'busy' },
      { start: '2026-10-20T11:00:00.000Z', end: '2026-10-20T11:30:00.000Z', status: 'tentative' },
      { start: '2026-10-20T11:30:00.000Z', end: '2026-10-20T12:00:00.000Z', status: 'oof' }
    ])
  })
})

describe('AvailabilityService', () => {
  it('queries Google freeBusy for a Google organizer and separates unknown calendars from free ones', async () => {
    const fetchMock = vi.fn(async () => json({
      calendars: {
        'me@company.com': { busy: [{ start: '2026-10-20T09:00:00Z', end: '2026-10-20T10:00:00Z' }] },
        'colleague@company.com': { busy: [] },
        'partner@other.org': { errors: [{ domain: 'global', reason: 'notFound' }], busy: [] },
        'ghost@company.com': { errors: [{ domain: 'global', reason: 'notFound' }] },
        'broken@company.com': { errors: [{ domain: 'global', reason: 'backendError' }] }
      }
    }))
    vi.stubGlobal('fetch', fetchMock)
    const { service: lookup, dependencies } = service()
    const result = await lookup.lookup({
      calendarId: googleCalendar.id, ...range,
      attendees: ['me@company.com', 'Colleague <colleague@company.com>', 'partner@other.org', 'ghost@company.com', 'broken@company.com', 'not an address']
    })
    // Mixed accounts: the organizer's Google calendar decides the provider and token.
    expect(dependencies.microsoftToken).not.toHaveBeenCalled()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://www.googleapis.com/calendar/v3/freeBusy')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer google-token')
    expect(JSON.parse(String(init.body))).toEqual({
      timeMin: range.start, timeMax: range.end, timeZone: 'UTC',
      items: ['me@company.com', 'colleague@company.com', 'partner@other.org', 'ghost@company.com', 'broken@company.com'].map((id) => ({ id }))
    })
    expect(result).toMatchObject({ provider: 'gmail', accountId: 'g', needsReconnect: false })
    const byEmail = Object.fromEntries(result.attendees.map((item) => [item.email, item]))
    expect(byEmail['me@company.com']).toMatchObject({ known: true, busy: [{ start: '2026-10-20T09:00:00.000Z', end: '2026-10-20T10:00:00.000Z', status: 'busy' }] })
    expect(byEmail['colleague@company.com']).toMatchObject({ known: true, busy: [] })
    expect(byEmail['partner@other.org']).toMatchObject({ known: false, reason: 'external' })
    expect(byEmail['ghost@company.com']).toMatchObject({ known: false, reason: 'not-found' })
    expect(byEmail['broken@company.com']).toMatchObject({ known: false, reason: 'provider-error' })
    expect(byEmail['not an address']).toMatchObject({ known: false, reason: 'not-found' })
  })

  it('queries Graph getSchedule for a Microsoft organizer with statuses, working hours, and per-schedule errors', async () => {
    const fetchMock = vi.fn(async () => json({
      value: [
        {
          scheduleId: 'Adele@contoso.com', availabilityView: '000200',
          scheduleItems: [
            { status: 'busy', start: { dateTime: '2026-10-20T09:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-10-20T10:00:00.0000000', timeZone: 'UTC' } },
            { status: 'tentative', start: { dateTime: '2026-10-20T13:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-10-20T13:30:00.0000000', timeZone: 'UTC' } },
            { status: 'free', start: { dateTime: '2026-10-20T15:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-10-20T16:00:00.0000000', timeZone: 'UTC' } }
          ],
          workingHours: { daysOfWeek: ['monday', 'tuesday'], startTime: '08:00:00.0000000', endTime: '16:00:00.0000000', timeZone: { name: 'Pacific Standard Time' } }
        },
        { scheduleId: 'room1@contoso.com', availabilityView: '220000' },
        { scheduleId: 'guest@fabrikam.com', error: { message: 'The free/busy information is not available', responseCode: 'ErrorMailRecipientNotFound' } },
        { scheduleId: 'private@contoso.com', error: { message: 'Access is denied', responseCode: 'ErrorAccessDenied' } }
      ]
    }))
    vi.stubGlobal('fetch', fetchMock)
    const { service: lookup, dependencies } = service()
    const result = await lookup.lookup({ calendarId: microsoftCalendar.id, ...range, attendees: ['adele@contoso.com', 'room1@contoso.com', 'guest@fabrikam.com', 'private@contoso.com', 'missing@contoso.com'] })
    expect(dependencies.googleToken).not.toHaveBeenCalled()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://graph.microsoft.com/v1.0/me/calendar/getSchedule')
    expect((init.headers as Record<string, string>).Prefer).toBe('outlook.timezone="UTC"')
    expect(JSON.parse(String(init.body))).toEqual({
      schedules: ['adele@contoso.com', 'room1@contoso.com', 'guest@fabrikam.com', 'private@contoso.com', 'missing@contoso.com'],
      startTime: { dateTime: '2026-10-20T00:00:00.000', timeZone: 'UTC' },
      endTime: { dateTime: '2026-10-21T00:00:00.000', timeZone: 'UTC' },
      availabilityViewInterval: 30
    })
    const byEmail = Object.fromEntries(result.attendees.map((item) => [item.email, item]))
    expect(byEmail['adele@contoso.com']).toEqual({
      email: 'adele@contoso.com', known: true,
      busy: [
        { start: '2026-10-20T09:00:00.000Z', end: '2026-10-20T10:00:00.000Z', status: 'busy' },
        { start: '2026-10-20T13:00:00.000Z', end: '2026-10-20T13:30:00.000Z', status: 'tentative' }
      ],
      workingHours: { days: [1, 2], start: '08:00', end: '16:00', timeZone: 'America/Los_Angeles' }
    })
    expect(byEmail['room1@contoso.com'].busy).toEqual([{ start: '2026-10-20T00:00:00.000Z', end: '2026-10-20T01:00:00.000Z', status: 'busy' }])
    expect(byEmail['guest@fabrikam.com']).toMatchObject({ known: false, reason: 'external' })
    expect(byEmail['private@contoso.com']).toMatchObject({ known: false, reason: 'permission' })
    expect(byEmail['missing@contoso.com']).toMatchObject({ known: false, reason: 'provider-error' })
  })

  it('splits large attendee lists into provider-sized batches', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const schedules = JSON.parse(String(init?.body)).schedules as string[]
      return json({ value: schedules.map((scheduleId) => ({ scheduleId, scheduleItems: [] })) })
    })
    vi.stubGlobal('fetch', fetchMock)
    const attendees = Array.from({ length: 45 }, (_, index) => `person${index}@contoso.com`)
    const result = await service().service.lookup({ calendarId: microsoftCalendar.id, ...range, attendees })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(result.attendees.every((item) => item.known)).toBe(true)
  })

  it('asks for a reconnect without calling Google when the grant lacks a free/busy scope', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { service: lookup } = service({ grantedScopes: () => ['https://www.googleapis.com/auth/calendar.events'] })
    const result = await lookup.lookup({ calendarId: googleCalendar.id, ...range, attendees: ['a@company.com'] })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result).toMatchObject({ needsReconnect: true, missingScopes: [GOOGLE_FREEBUSY_SCOPE], accountId: 'g' })
    expect(result.message).toMatch(/calendar\.freebusy/)
    expect(result.attendees).toEqual([expect.objectContaining({ email: 'a@company.com', known: false, reason: 'permission' })])
  })

  it('turns a 403 from a legacy grant into a reconnect request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 403, message: 'Request had insufficient authentication scopes.', errors: [{ reason: 'insufficientPermissions' }] } }, 403)))
    const { service: lookup } = service({ grantedScopes: () => undefined })
    const result = await lookup.lookup({ calendarId: googleCalendar.id, ...range, attendees: ['a@company.com'] })
    expect(result.needsReconnect).toBe(true)
    expect(result.attendees[0]).toMatchObject({ known: false, reason: 'permission' })
  })

  it('reports provider failures and rate limits as unknown rather than free', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 'ErrorServerBusy', message: 'Server busy' } }, 503)))
    const failed = await service().service.lookup({ calendarId: microsoftCalendar.id, ...range, attendees: ['a@contoso.com'] })
    expect(failed).toMatchObject({ needsReconnect: false, message: 'Microsoft couldn’t return availability: Server busy' })
    expect(failed.attendees[0]).toMatchObject({ known: false, reason: 'provider-error' })

    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { message: 'Rate Limit Exceeded', errors: [{ reason: 'rateLimitExceeded' }] } }, 403)))
    const limited = await service().service.lookup({ calendarId: googleCalendar.id, ...range, attendees: ['a@company.com'] })
    expect(limited.needsReconnect).toBe(false)
    expect(limited.attendees[0]).toMatchObject({ known: false, reason: 'provider-error' })

    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    const offline = await service().service.lookup({ calendarId: googleCalendar.id, ...range, attendees: ['a@company.com'] })
    expect(offline.message).toMatch(/could not be reached/)
  })

  it('reports local and subscribed calendars as unsupported without contacting a provider', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const result = await service().service.lookup({ calendarId: 'local-calendar-1', ...range, attendees: ['a@company.com'] })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.provider).toBeUndefined()
    expect(result.attendees[0]).toMatchObject({ known: false, reason: 'unsupported' })
  })

  it('rejects malformed requests and overly long ranges', async () => {
    const { service: lookup } = service()
    await expect(lookup.lookup(null)).rejects.toThrow(/31 days/)
    await expect(lookup.lookup({ calendarId: googleCalendar.id, attendees: [], start: range.start, end: '2026-12-31T00:00:00Z' })).rejects.toThrow(/31 days/)
    await expect(lookup.lookup({ calendarId: googleCalendar.id, attendees: Array(101).fill('a@b.co'), ...range })).rejects.toThrow()
    await expect(lookup.lookup({ calendarId: googleCalendar.id, attendees: [], start: range.end, end: range.start })).rejects.toThrow()
  })

  it('registers the IPC channel', async () => {
    const handle = vi.fn()
    const { service: lookup } = service()
    const spy = vi.spyOn(lookup, 'lookup').mockResolvedValue({ calendarId: 'x', attendees: [], needsReconnect: false, missingScopes: [], fetchedAt: '' })
    registerAvailability({ handle }, () => lookup)
    expect(handle).toHaveBeenCalledWith('productivity:availability', expect.any(Function))
    await handle.mock.calls[0][1]({}, { calendarId: 'x' })
    expect(spy).toHaveBeenCalledWith({ calendarId: 'x' })
  })
})
