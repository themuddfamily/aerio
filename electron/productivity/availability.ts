import type { IpcMain } from 'electron'
import type { ProductivityProvider, SyncedCalendar } from '../../src/productivity-types'
import type {
  AttendeeAvailability, AvailabilityInterval, AvailabilityRequest, AvailabilityResult, AvailabilityStatus, AvailabilityUnknownReason, WorkingHours
} from '../../src/scheduling-types'
import { resolveTimeZoneName, wallTimeToUtc } from '../../src/lib/time-zones'

// Provider-backed free/busy lookup for the scheduling assistant. The organizer's calendar picks the
// provider; attendees in other domains or without sharing come back as "unknown", never as free.

export const GOOGLE_FREEBUSY_SCOPE = 'https://www.googleapis.com/auth/calendar.freebusy'
// Google's freeBusy.query accepts any of these; calendar.events (the editing scope) is not one of them.
const GOOGLE_FREEBUSY_SCOPES = [
  GOOGLE_FREEBUSY_SCOPE,
  'https://www.googleapis.com/auth/calendar.events.freebusy',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar'
]
// Graph getSchedule needs one of the calendar read permissions; Aerio already requests Calendars.ReadWrite.
const MICROSOFT_SCHEDULE_SCOPES = ['Calendars.ReadBasic', 'Calendars.Read', 'Calendars.ReadWrite', 'Calendars.Read.Shared', 'Calendars.ReadWrite.Shared']

export const MAX_AVAILABILITY_ATTENDEES = 100
export const MAX_AVAILABILITY_RANGE_MS = 31 * 24 * 60 * 60_000
const GOOGLE_BATCH = 50
const MICROSOFT_BATCH = 20
const MICROSOFT_VIEW_INTERVAL = 30
const REQUEST_TIMEOUT_MS = 20_000

export interface AvailabilityDependencies {
  calendars(): SyncedCalendar[]
  accountEmail(accountId: string): Promise<string | undefined>
  googleToken(accountId: string): Promise<string>
  microsoftToken(accountId: string): Promise<string>
  /** Undefined means the grant predates scope tracking; the provider response decides. */
  grantedScopes(accountId: string, provider: Exclude<ProductivityProvider, 'dav'>): string[] | undefined
  now?: () => number
}

class AvailabilityRequestError extends Error {
  constructor(readonly status: number, message: string, readonly reason = '') {
    super(message)
    this.name = 'AvailabilityRequestError'
  }
}

interface GoogleFreeBusyResponse {
  calendars?: Record<string, { busy?: { start?: string; end?: string }[]; errors?: { domain?: string; reason?: string }[] }>
}

interface GraphDateTime { dateTime?: string; timeZone?: string }
interface GraphSchedule {
  scheduleId?: string
  availabilityView?: string
  scheduleItems?: { status?: string; start?: GraphDateTime; end?: GraphDateTime }[]
  workingHours?: { daysOfWeek?: string[]; startTime?: string; endTime?: string; timeZone?: { name?: string } }
  error?: { message?: string; responseCode?: string }
}

const providerName = (provider: ProductivityProvider) => provider === 'gmail' ? 'Google' : 'Microsoft'
const domainOf = (email: string | undefined) => email?.split('@').at(-1)?.toLowerCase() ?? ''

/** Accepts "person@example.com" and "Name <person@example.com>"; returns undefined for anything else. */
export function normalizeAttendeeAddress(value: string) {
  const address = (value.match(/<([^<>]+)>\s*$/)?.[1] ?? value).trim().toLowerCase()
  return address.length <= 320 && /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/.test(address) ? address : undefined
}

export function availabilityScopeStatus(provider: ProductivityProvider, granted: string[] | undefined) {
  if (!granted) return { granted: true, known: false, missing: [] as string[] }
  const lower = new Set(granted.map((scope) => scope.replace(/^https:\/\/graph\.microsoft\.com\//i, '').toLowerCase()))
  const accepted = provider === 'gmail' ? GOOGLE_FREEBUSY_SCOPES : MICROSOFT_SCHEDULE_SCOPES
  if (accepted.some((scope) => lower.has(scope.toLowerCase()))) return { granted: true, known: true, missing: [] as string[] }
  return { granted: false, known: true, missing: [provider === 'gmail' ? GOOGLE_FREEBUSY_SCOPE : 'Calendars.ReadWrite'] }
}

export function permissionMessage(provider: ProductivityProvider) {
  return provider === 'gmail'
    ? 'Aerio needs the “See the availability on Google Calendars you have access to” permission (calendar.freebusy) to look up free/busy times. Reconnect the account and allow it on Google’s consent screen.'
    : 'Aerio needs permission to read calendars (Calendars.ReadWrite) to look up free/busy times. Reconnect the account and accept the permission; some work or school organizations require an administrator to approve it.'
}

/** Recognizes insufficient-scope and access-denied responses; rate limiting also uses 403 on Google. */
export function isPermissionFailure(status: number, message = '', reason = '') {
  if (status !== 401 && status !== 403) return false
  return !/rate ?limit|quota/i.test(`${message} ${reason}`)
}

/** Converts a Graph dateTime/timeZone pair to an ISO instant; Graph omits the offset. */
export function graphInstant(value: GraphDateTime | undefined) {
  const raw = value?.dateTime
  if (!raw) return undefined
  if (/(?:Z|[+-]\d\d:\d\d)$/.test(raw)) return new Date(raw).toISOString()
  const zone = value?.timeZone && !/^(utc|coordinated universal time)$/i.test(value.timeZone) ? resolveTimeZoneName(value.timeZone) : 'UTC'
  const match = raw.match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d))?/)
  if (!match) return undefined
  const [, year, month, day, hour, minute, second = '0'] = match
  const wall = { year: Number(year), month: Number(month), day: Number(day), hour: Number(hour), minute: Number(minute), second: Number(second) }
  if (!zone || zone === 'UTC') return new Date(Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second)).toISOString()
  return new Date(wallTimeToUtc(wall, zone)).toISOString()
}

const graphStatus = (value: string | undefined): AvailabilityStatus | undefined => {
  const normalized = value?.toLowerCase()
  if (normalized === 'busy' || normalized === 'tentative' || normalized === 'oof' || normalized === 'unknown') return normalized
  if (normalized === 'workingelsewhere') return 'workingElsewhere'
  return undefined
}

const viewStatus: Record<string, AvailabilityStatus | undefined> = { '1': 'tentative', '2': 'busy', '3': 'oof', '4': 'workingElsewhere' }

/** Expands Graph's availabilityView string (one digit per interval) into intervals. */
export function availabilityViewIntervals(view: string, start: string, intervalMinutes = MICROSOFT_VIEW_INTERVAL): AvailabilityInterval[] {
  const origin = Date.parse(start)
  const step = intervalMinutes * 60_000
  const intervals: AvailabilityInterval[] = []
  for (let index = 0; index < view.length; index++) {
    const status = viewStatus[view[index]]
    if (!status) continue
    const from = origin + index * step
    const last = intervals.at(-1)
    if (last && last.status === status && Date.parse(last.end) === from) last.end = new Date(from + step).toISOString()
    else intervals.push({ start: new Date(from).toISOString(), end: new Date(from + step).toISOString(), status })
  }
  return intervals
}

const weekDays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

export function graphWorkingHours(value: GraphSchedule['workingHours']): WorkingHours | undefined {
  const timeZone = resolveTimeZoneName(value?.timeZone?.name)
  const start = value?.startTime?.match(/^(\d\d:\d\d)/)?.[1]
  const end = value?.endTime?.match(/^(\d\d:\d\d)/)?.[1]
  const days = (value?.daysOfWeek ?? []).map((day) => weekDays.indexOf(day.toLowerCase())).filter((day) => day >= 0)
  if (!timeZone || !start || !end || !days.length) return undefined
  return { days: [...new Set(days)].sort(), start, end, timeZone }
}

function unknownReason(code: string, attendee: string, organizer: string | undefined): AvailabilityUnknownReason {
  const external = Boolean(organizer) && domainOf(attendee) !== domainOf(organizer)
  if (/notfound|recipientnotfound/i.test(code)) return external ? 'external' : 'not-found'
  if (/accessdenied|nofreebusyaccess|notallowed|permission|forbidden/i.test(code)) return external ? 'external' : 'permission'
  if (/federat|external|crossforest|crosssite/i.test(code)) return 'external'
  return 'provider-error'
}

const reasonMessages: Record<AvailabilityUnknownReason, string> = {
  permission: 'This calendar isn’t shared with you',
  'not-found': 'No calendar was found for this address',
  external: 'Availability isn’t shared outside this person’s organization',
  'provider-error': 'The provider couldn’t return availability',
  unsupported: 'This calendar has no free/busy service'
}

const unknownAttendee = (email: string, reason: AvailabilityUnknownReason, message = reasonMessages[reason]): AttendeeAvailability => ({
  email, known: false, reason, message, busy: []
})

async function postJson<T>(url: string, token: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
  } catch (error) {
    throw new AvailabilityRequestError(0, error instanceof Error && error.name === 'TimeoutError' ? 'The availability request timed out' : 'The provider could not be reached')
  }
  if (response.ok) return await response.json() as T
  const details = await response.json().catch(() => ({})) as { error?: { message?: string; code?: string; errors?: { reason?: string }[] } }
  const reason = details.error?.errors?.[0]?.reason ?? details.error?.code ?? ''
  throw new AvailabilityRequestError(response.status, details.error?.message ?? `Availability lookup failed (${response.status})`, reason)
}

const chunks = <T>(values: T[], size: number) => Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size))

export async function googleFreeBusy(token: string, attendees: string[], start: string, end: string, organizer?: string): Promise<AttendeeAvailability[]> {
  const results: AttendeeAvailability[] = []
  for (const batch of chunks(attendees, GOOGLE_BATCH)) {
    const response = await postJson<GoogleFreeBusyResponse>('https://www.googleapis.com/calendar/v3/freeBusy', token, {
      timeMin: start, timeMax: end, timeZone: 'UTC', items: batch.map((id) => ({ id }))
    })
    const calendars = new Map(Object.entries(response.calendars ?? {}).map(([id, value]) => [id.toLowerCase(), value]))
    for (const email of batch) {
      const calendar = calendars.get(email)
      if (!calendar) {
        results.push(unknownAttendee(email, 'provider-error', 'Google didn’t return this calendar'))
        continue
      }
      const error = calendar.errors?.[0]
      if (error) {
        const reason = unknownReason(error.reason ?? '', email, organizer)
        results.push(unknownAttendee(email, reason))
        continue
      }
      results.push({
        email,
        known: true,
        busy: (calendar.busy ?? []).flatMap((item) => item.start && item.end
          ? [{ start: new Date(item.start).toISOString(), end: new Date(item.end).toISOString(), status: 'busy' as const }]
          : [])
      })
    }
  }
  return results
}

export async function microsoftSchedule(token: string, attendees: string[], start: string, end: string, organizer?: string): Promise<AttendeeAvailability[]> {
  const results: AttendeeAvailability[] = []
  for (const batch of chunks(attendees, MICROSOFT_BATCH)) {
    const response = await postJson<{ value?: GraphSchedule[] }>('https://graph.microsoft.com/v1.0/me/calendar/getSchedule', token, {
      schedules: batch,
      startTime: { dateTime: start.replace(/Z$/, ''), timeZone: 'UTC' },
      endTime: { dateTime: end.replace(/Z$/, ''), timeZone: 'UTC' },
      availabilityViewInterval: MICROSOFT_VIEW_INTERVAL
    }, { Prefer: 'outlook.timezone="UTC"' })
    const schedules = new Map((response.value ?? []).map((item) => [item.scheduleId?.toLowerCase() ?? '', item]))
    for (const email of batch) {
      const schedule = schedules.get(email)
      if (!schedule) {
        results.push(unknownAttendee(email, 'provider-error', 'Microsoft didn’t return this schedule'))
        continue
      }
      if (schedule.error) {
        const reason = unknownReason(schedule.error.responseCode ?? schedule.error.message ?? '', email, organizer)
        results.push(unknownAttendee(email, reason))
        continue
      }
      const items = (schedule.scheduleItems ?? []).flatMap((item): AvailabilityInterval[] => {
        const status = graphStatus(item.status)
        const itemStart = graphInstant(item.start)
        const itemEnd = graphInstant(item.end)
        return status && itemStart && itemEnd ? [{ start: itemStart, end: itemEnd, status }] : []
      })
      const busy = items.length || !schedule.availabilityView ? items : availabilityViewIntervals(schedule.availabilityView, start)
      const workingHours = graphWorkingHours(schedule.workingHours)
      results.push({ email, known: true, busy, ...(workingHours ? { workingHours } : {}) })
    }
  }
  return results
}

function validRequest(value: unknown): value is AvailabilityRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Partial<AvailabilityRequest>
  if (typeof request.calendarId !== 'string' || !request.calendarId || request.calendarId.length > 500) return false
  if (!Array.isArray(request.attendees) || request.attendees.length > MAX_AVAILABILITY_ATTENDEES) return false
  if (!request.attendees.every((item) => typeof item === 'string' && item.length <= 500)) return false
  if (typeof request.start !== 'string' || typeof request.end !== 'string' || request.start.length > 100 || request.end.length > 100) return false
  const start = Date.parse(request.start), end = Date.parse(request.end)
  return Number.isFinite(start) && Number.isFinite(end) && end > start && end - start <= MAX_AVAILABILITY_RANGE_MS
}

export class AvailabilityService {
  constructor(private readonly dependencies: AvailabilityDependencies) {}

  async lookup(input: unknown): Promise<AvailabilityResult> {
    if (!validRequest(input)) throw new Error('Choose up to 100 attendees and a time range of at most 31 days')
    const fetchedAt = new Date(this.dependencies.now?.() ?? Date.now()).toISOString()
    const start = new Date(input.start).toISOString()
    const end = new Date(input.end).toISOString()
    const addresses: string[] = []
    const invalid: AttendeeAvailability[] = []
    for (const raw of input.attendees) {
      const address = normalizeAttendeeAddress(raw)
      if (address) { if (!addresses.includes(address)) addresses.push(address) }
      else if (raw.trim()) invalid.push(unknownAttendee(raw.trim(), 'not-found', 'Not a valid email address'))
    }
    const base = { calendarId: input.calendarId, needsReconnect: false, missingScopes: [] as string[], fetchedAt }
    const calendar = this.dependencies.calendars().find((item) => item.id === input.calendarId)
    if (!calendar) {
      return {
        ...base,
        attendees: [...addresses.map((email) => unknownAttendee(email, 'unsupported')), ...invalid],
        message: 'Free/busy lookup needs a Google or Microsoft calendar. Local and subscribed calendars can’t check other people’s availability.'
      }
    }
    // CalDAV free/busy (RFC 6638 scheduling) is not implemented.
    if (calendar.provider === 'dav') {
      return {
        ...base,
        attendees: [...addresses.map((email) => unknownAttendee(email, 'unsupported')), ...invalid],
        message: 'Free/busy lookup needs a Google or Microsoft calendar. CalDAV calendars can’t check other people’s availability yet.'
      }
    }
    const accountId = calendar.accountId
    const provider = calendar.provider
    const scopes = availabilityScopeStatus(provider, this.dependencies.grantedScopes(accountId, provider))
    const withAccount = { ...base, accountId, provider }
    if (!scopes.granted) {
      return {
        ...withAccount, needsReconnect: true, missingScopes: scopes.missing, message: permissionMessage(provider),
        attendees: [...addresses.map((email) => unknownAttendee(email, 'permission', 'Reconnect to look up availability')), ...invalid]
      }
    }
    if (!addresses.length) return { ...withAccount, attendees: invalid }
    try {
      const organizer = await this.dependencies.accountEmail(accountId)
      const attendees = provider === 'gmail'
        ? await googleFreeBusy(await this.dependencies.googleToken(accountId), addresses, start, end, organizer)
        : await microsoftSchedule(await this.dependencies.microsoftToken(accountId), addresses, start, end, organizer)
      return { ...withAccount, attendees: [...attendees, ...invalid] }
    } catch (error) {
      const status = error instanceof AvailabilityRequestError ? error.status : 0
      const reason = error instanceof AvailabilityRequestError ? error.reason : ''
      const message = error instanceof Error ? error.message.slice(0, 300) : 'Availability lookup failed'
      if (isPermissionFailure(status, message, reason)) {
        return {
          ...withAccount, needsReconnect: true, missingScopes: provider === 'gmail' ? [GOOGLE_FREEBUSY_SCOPE] : ['Calendars.ReadWrite'], message: permissionMessage(provider),
          attendees: [...addresses.map((email) => unknownAttendee(email, 'permission', 'Reconnect to look up availability')), ...invalid]
        }
      }
      return {
        ...withAccount,
        message: `${providerName(provider)} couldn’t return availability: ${message}`,
        attendees: [...addresses.map((email) => unknownAttendee(email, 'provider-error')), ...invalid]
      }
    }
  }
}

export function registerAvailability(ipc: Pick<IpcMain, 'handle'>, service: () => AvailabilityService) {
  ipc.handle('productivity:availability', (_event, request: unknown) => service().lookup(request))
}
