import type { CalendarEvent, ConferenceProvider, EventConference } from '../../src/types'
import type { CalendarConferenceSupport, SyncedCalendar } from '../../src/productivity-types'
import { CONFERENCE_LABELS, conferenceCapabilities, type ConferenceCapability } from '../../src/lib/online-meetings'

// Online meeting connector boundary (E25, E47). Google Meet and Microsoft Teams are created by the calendar
// connectors themselves as part of the event write (Google conferenceData, Graph isOnlineMeeting), so the
// helpers below translate between those payloads and EventConference. Providers with their own meeting API
// (Zoom, Webex) implement OnlineMeetingConnector: HostedMeetingCoordinator (meeting-coordinator.ts) creates the
// meeting first, then the calendar connector writes the returned join details onto the event.

export interface OnlineMeetingRequest {
  requestId: string
  title: string
  start: string
  end: string
  timeZone?: string
}

// A meeting created through a provider's own API. Never holds the host start link (it carries a host token).
export interface HostedMeeting {
  provider: 'zoom' | 'webex'
  meetingId: string
  joinUrl: string
  // Number participants type into the client or phone ("123 4567 8901").
  meetingNumber?: string
  passcode?: string
  // Numeric passcode for phone and video-system participants, when the provider issues a separate one.
  phonePasscode?: string
  sipAddress?: string
  dialIn?: { number: string; label?: string }[]
}

export interface OnlineMeetingConnector {
  readonly provider: ConferenceProvider
  // OAuth scopes the provider needs in addition to calendar write access.
  readonly requiredScopes: readonly string[]
  capability(calendar: SyncedCalendar): ConferenceCapability
  // One creation attempt. The coordinator makes retries idempotent per requestId: it records the attempt
  // first and, after an uncertain outcome, calls findMeeting before creating again.
  createMeeting(request: OnlineMeetingRequest): Promise<HostedMeeting>
  // The host's meeting carrying this request's marker, if an earlier attempt created one.
  findMeeting(request: OnlineMeetingRequest): Promise<HostedMeeting | undefined>
  updateMeeting(meeting: HostedMeeting, request: OnlineMeetingRequest): Promise<HostedMeeting>
  // Cancels the meeting; a meeting the provider no longer has counts as cancelled.
  deleteMeeting(meeting: HostedMeeting): Promise<void>
}

export class UnavailableMeetingConnector implements OnlineMeetingConnector {
  readonly requiredScopes: readonly string[] = []

  constructor(readonly provider: ConferenceProvider) {}

  capability(): ConferenceCapability {
    return { provider: this.provider, label: CONFERENCE_LABELS[this.provider], available: false, reason: `${CONFERENCE_LABELS[this.provider]} is not connected to Aerio yet` }
  }

  private unsupported(): never {
    throw new Error(`${CONFERENCE_LABELS[this.provider]} meetings are not supported yet`)
  }

  async createMeeting(): Promise<HostedMeeting> { return this.unsupported() }
  async findMeeting(): Promise<HostedMeeting | undefined> { return this.unsupported() }
  async updateMeeting(): Promise<HostedMeeting> { return this.unsupported() }
  async deleteMeeting(): Promise<void> { this.unsupported() }
}

const connectorRegistry: Partial<Record<ConferenceProvider, OnlineMeetingConnector>> = {
  zoom: new UnavailableMeetingConnector('zoom'),
  webex: new UnavailableMeetingConnector('webex')
}

// Zoom and Webex start unavailable; the main process registers the real connectors once their vault is open.
export const externalMeetingConnectors: Readonly<Partial<Record<ConferenceProvider, OnlineMeetingConnector>>> = connectorRegistry

export function registerExternalMeetingConnector(connector: OnlineMeetingConnector) {
  connectorRegistry[connector.provider] = connector
}

// Throws a user-facing reason when a requested meeting cannot be created on this calendar.
export function assertConferenceCreatable(calendar: SyncedCalendar, provider: ConferenceProvider) {
  const external = externalMeetingConnectors[provider]
  const capability = external ? external.capability(calendar) : conferenceCapabilities(calendar).find((item) => item.provider === provider)
  if (!capability) throw new Error(`${CONFERENCE_LABELS[provider]} meetings cannot be added to this calendar`)
  if (!capability.available) throw new Error(capability.reason ?? `${CONFERENCE_LABELS[provider]} meetings cannot be added to this calendar`)
}

export function assertConferenceRemovable(calendar: SyncedCalendar) {
  if (calendar.conferences && !calendar.conferences.canRemove) {
    throw new Error('Microsoft keeps a Teams meeting once it is added to an event; delete and recreate the event to remove it')
  }
}

// --- Google Calendar conferenceData ---

export interface GoogleConferenceData {
  conferenceId?: string
  conferenceSolution?: { key?: { type?: string }; name?: string }
  createRequest?: { requestId?: string; conferenceSolutionKey?: { type?: string }; status?: { statusCode?: string } }
  entryPoints?: { entryPointType?: string; uri?: string; label?: string; pin?: string; passcode?: string; meetingCode?: string }[]
  notes?: string
  signature?: string
}

export function googleConferenceSupport(allowed: string[] | undefined, writable: boolean): CalendarConferenceSupport {
  const types = allowed ?? []
  return { allowed: types, creatable: writable && types.includes('hangoutsMeet') ? ['googleMeet'] : [], canRemove: true }
}

const googleProvider = (data: GoogleConferenceData): ConferenceProvider => {
  const type = data.conferenceSolution?.key?.type ?? data.createRequest?.conferenceSolutionKey?.type
  if (type === 'hangoutsMeet' || type === 'eventHangout' || type === 'eventNamedHangout') return 'googleMeet'
  const name = data.conferenceSolution?.name?.toLowerCase() ?? ''
  return name.includes('zoom') ? 'zoom' : name.includes('webex') ? 'webex' : name.includes('teams') ? 'teams' : 'other'
}

export function mapGoogleConference(data: GoogleConferenceData | undefined, hangoutLink?: string): EventConference | undefined {
  if (!data && !hangoutLink) return
  const entryPoints = data?.entryPoints ?? []
  const video = entryPoints.find((entry) => entry.entryPointType === 'video')
  const phone = entryPoints.find((entry) => entry.entryPointType === 'phone')
  const statusCode = data?.createRequest?.status?.statusCode
  const joinUrl = video?.uri ?? hangoutLink
  const status: EventConference['status'] = statusCode === 'failure' ? 'failed' : statusCode === 'pending' && !joinUrl ? 'pending' : 'ready'
  const name = data?.conferenceSolution?.name
  return {
    provider: data ? googleProvider(data) : 'googleMeet',
    status,
    ...(data?.createRequest?.requestId ? { requestId: data.createRequest.requestId } : {}),
    ...(joinUrl ? { joinUrl } : {}),
    ...(data?.conferenceId ? { conferenceId: data.conferenceId } : {}),
    ...(name ? { name } : {}),
    ...(phone?.label ?? phone?.uri ? { phone: phone?.label ?? phone?.uri?.replace(/^tel:/, '') } : {}),
    ...(phone?.pin ? { pin: phone.pin } : {})
  }
}

export const googleCreateRequest = (requestId: string) => ({ createRequest: { requestId, conferenceSolutionKey: { type: 'hangoutsMeet' } } })

// Copy of an existing conference for a new event (a split series' successor). Google keeps the same meeting
// when conferenceData without a createRequest is written with conferenceDataVersion=1.
export function googleConferenceCopy(data: GoogleConferenceData | undefined) {
  if (!data?.conferenceSolution || !data.entryPoints?.length) return undefined
  const { createRequest: _createRequest, ...copy } = data
  return copy
}

// Google event ids are base32hex (a-v, 0-9), 5-1024 characters. A conference request id doubles as the
// event id on insert, so a retried insert whose first attempt succeeded fails with 409 instead of duplicating.
export function googleEventIdForRequest(requestId: string) {
  const id = requestId.toLowerCase().replace(/[^a-v0-9]/g, '')
  return id.length >= 5 ? id.slice(0, 1024) : undefined
}

// --- Microsoft Graph online meetings ---

export interface GraphOnlineMeetingFields {
  isOnlineMeeting?: boolean
  onlineMeetingProvider?: string
  onlineMeeting?: { joinUrl?: string; conferenceId?: string; tollNumber?: string } | null
  onlineMeetingUrl?: string | null
}

export const graphOnlineMeetingSelect = 'isOnlineMeeting,onlineMeetingProvider,onlineMeeting,onlineMeetingUrl'

export function microsoftConferenceSupport(allowed: string[] | undefined, defaultProvider: string | undefined, writable: boolean): CalendarConferenceSupport {
  const providers = (allowed ?? []).filter((item) => item !== 'unknown')
  return {
    allowed: providers,
    ...(defaultProvider && defaultProvider !== 'unknown' ? { defaultProvider } : {}),
    creatable: writable && providers.includes('teamsForBusiness') ? ['teams'] : [],
    // Graph ignores isOnlineMeeting=false once a meeting exists.
    canRemove: false
  }
}

export function mapGraphConference(event: GraphOnlineMeetingFields): EventConference | undefined {
  const joinUrl = event.onlineMeeting?.joinUrl ?? event.onlineMeetingUrl ?? undefined
  if (!event.isOnlineMeeting && !joinUrl) return
  const provider: ConferenceProvider = event.onlineMeetingProvider === 'teamsForBusiness' ? 'teams'
    : event.onlineMeetingProvider === 'skypeForConsumer' || event.onlineMeetingProvider === 'skypeForBusiness' ? 'skype' : 'other'
  return {
    provider,
    status: joinUrl ? 'ready' : 'pending',
    ...(joinUrl ? { joinUrl } : {}),
    ...(event.onlineMeeting?.conferenceId ? { conferenceId: event.onlineMeeting.conferenceId } : {}),
    ...(event.onlineMeeting?.tollNumber ? { phone: event.onlineMeeting.tollNumber } : {})
  }
}

export const graphTeamsMeeting = { isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness' } as const

// Synchronization replaces stored events with the provider's copy. A meeting request that was saved but never
// confirmed (a failed write) is carried over so the next save retries it under the same request id.
export function carryPendingConferences<T extends CalendarEvent>(previous: readonly T[], next: T[]): T[] {
  const pending = new Map(previous.filter((event) => event.conference?.status === 'pending' && event.conference.requestId && !event.conference.joinUrl).map((event) => [event.id, event.conference!]))
  if (!pending.size) return next
  return next.map((event) => !event.conference && pending.has(event.id) ? { ...event, conference: pending.get(event.id) } : event)
}
