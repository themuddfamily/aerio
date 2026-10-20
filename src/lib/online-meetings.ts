import type { CalendarEvent, ConferenceProvider, EventConference } from '../types'
import type { CalendarConferenceSupport } from '../productivity-types'
import type { MeetingAccount, HostedMeetingProvider } from '../meeting-host-types'

// Online meetings (E25): provider labels, capability reporting, join-link safety, and the pure rules connectors
// use to decide whether a write creates, keeps, or removes a conference.

export const CONFERENCE_LABELS: Record<ConferenceProvider, string> = {
  googleMeet: 'Google Meet',
  teams: 'Microsoft Teams',
  skype: 'Skype',
  zoom: 'Zoom',
  webex: 'Webex',
  goto: 'GoToMeeting',
  meetn: 'Meetn',
  icewarp: 'IceWarp',
  other: 'Online meeting'
}

// Join links open without a prompt only on these hosts (and their subdomains); anything else asks first.
const TRUSTED_JOIN_HOSTS = ['meet.google.com', 'teams.microsoft.com', 'teams.live.com', 'zoom.us', 'zoom.com', 'webex.com', 'gotomeeting.com', 'goto.com', 'meetn.com']

export type JoinLinkCheck = { kind: 'trusted'; url: string } | { kind: 'untrusted'; url: string; host: string } | { kind: 'invalid' }

export function checkJoinLink(value: string | undefined): JoinLinkCheck {
  if (!value || value.length > 4_000) return { kind: 'invalid' }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { kind: 'invalid' }
  }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return { kind: 'invalid' }
  const host = url.hostname.toLowerCase()
  const trusted = TRUSTED_JOIN_HOSTS.some((item) => host === item || host.endsWith(`.${item}`))
  return trusted ? { kind: 'trusted', url: url.href } : { kind: 'untrusted', url: url.href, host }
}

export const conferenceLabel = (conference: Pick<EventConference, 'provider' | 'name'>) => conference.name?.trim() || CONFERENCE_LABELS[conference.provider]

// A stable id for a new creation request. Hex only, so it is also a valid Google base32hex event id.
export function newConferenceRequestId() {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function requestConference(provider: ConferenceProvider, previous?: EventConference): EventConference {
  // Re-adding before the first save keeps the original request id, so it is never retried under a new id.
  const requestId = previous?.status === 'pending' && previous.provider === provider && previous.requestId ? previous.requestId : newConferenceRequestId()
  return { provider, status: 'pending', requestId }
}

// What a write should do with conference data, given the edited event and what the provider already has.
export type ConferenceWrite = { kind: 'keep' } | { kind: 'create'; provider: ConferenceProvider; requestId: string } | { kind: 'remove' }

export function conferenceWrite(event: Pick<CalendarEvent, 'conference'>, existing?: EventConference): ConferenceWrite {
  const conference = event.conference
  if (!conference) return { kind: 'keep' }
  if (conference.status === 'removed') return existing && existing.status !== 'removed' ? { kind: 'remove' } : { kind: 'keep' }
  if (conference.status !== 'pending' || !conference.requestId) return { kind: 'keep' }
  // A conference the provider already has (from an earlier attempt or another client) is never created again.
  // An unconfirmed request under the same id is ours and is resent under that id, which providers deduplicate.
  const ownRequest = existing?.status === 'pending' && !existing.joinUrl && existing.requestId === conference.requestId
  if (existing && existing.status !== 'failed' && existing.status !== 'removed' && !ownRequest) return { kind: 'keep' }
  return { kind: 'create', provider: conference.provider, requestId: conference.requestId }
}

export interface ConferenceCapability {
  provider: ConferenceProvider
  label: string
  available: boolean
  reason?: string
}

// Providers that create their meeting through their own API and then attach the join details to a calendar
// event (E47). Each needs its own OAuth consent, connected in Settings > Online meetings.
export const EXTERNAL_CONFERENCE_PROVIDERS: HostedMeetingProvider[] = ['zoom', 'webex', 'goto', 'meetn', 'icewarp']

export const isHostedConferenceProvider = (provider: ConferenceProvider | undefined): provider is HostedMeetingProvider => provider === 'zoom' || provider === 'webex' || provider === 'goto' || provider === 'meetn' || provider === 'icewarp'

type CapabilityCalendar = { provider: 'gmail' | 'microsoft' | string; canWrite?: boolean; conferences?: CalendarConferenceSupport }

// Whether a Zoom or Webex meeting can be added to an event on this calendar, given the meeting-host account.
// The main process and the editor both use this, so they always give the same reason.
export function hostedConferenceCapability(provider: HostedMeetingProvider, calendar: CapabilityCalendar | undefined, account: MeetingAccount | undefined): ConferenceCapability {
  const label = CONFERENCE_LABELS[provider]
  let reason: string | undefined
  if (!calendar || (calendar.provider !== 'gmail' && calendar.provider !== 'microsoft')) reason = `${label} meetings can be added to Google and Microsoft calendars`
  else if (!calendar.canWrite) reason = `Reconnect this ${calendar.provider === 'gmail' ? 'Google' : 'Microsoft'} account once to enable Calendar editing`
  else if (account && !account.configured) reason = `This Aerio build has no ${label} app registration; add one in Settings › Online meetings`
  else if (account && 'needsReconnect' in account && account.needsReconnect) reason = `${label} access was revoked or expired; reconnect ${label} in Settings › Online meetings`
  else if (!account?.connected) reason = `Connect ${label} in Settings › Online meetings`
  return { provider, label, available: !reason, ...(reason ? { reason } : {}) }
}

export function conferenceCapabilities(calendar: CapabilityCalendar | undefined, hosts: readonly MeetingAccount[] = []): ConferenceCapability[] {
  if (!calendar || (calendar.provider !== 'gmail' && calendar.provider !== 'microsoft')) {
    return [{ provider: 'other', label: CONFERENCE_LABELS.other, available: false, reason: 'Online meetings need a Google or Microsoft calendar' }]
  }
  const native: ConferenceProvider = calendar.provider === 'gmail' ? 'googleMeet' : 'teams'
  const support = calendar.conferences
  let reason: string | undefined
  if (!calendar.canWrite) reason = `Reconnect this ${calendar.provider === 'gmail' ? 'Google' : 'Microsoft'} account once to enable Calendar editing`
  else if (!support) reason = 'Synchronize this calendar to check which meetings it supports'
  else if (!support.creatable.includes(native)) {
    reason = calendar.provider === 'gmail'
      ? 'This Google calendar does not offer Google Meet (it may be disabled by a Workspace administrator)'
      : support.allowed.includes('skypeForConsumer')
        ? 'Personal Microsoft accounts offer only Skype meetings, which Aerio does not create; Teams needs a work or school account'
        : 'This Microsoft calendar does not offer Teams meetings'
  }
  return [
    { provider: native, label: CONFERENCE_LABELS[native], available: !reason, ...(reason ? { reason } : {}) },
    ...EXTERNAL_CONFERENCE_PROVIDERS.map((provider) => hostedConferenceCapability(provider, calendar, hosts.find((item) => item.provider === provider)))
  ]
}

const PROVIDERS = new Set<ConferenceProvider>(['googleMeet', 'teams', 'skype', 'zoom', 'webex', 'goto', 'meetn', 'icewarp', 'other'])
const STATUSES = new Set<EventConference['status']>(['pending', 'ready', 'failed', 'removed'])
const optional = (value: unknown, max: number) => value === undefined || (typeof value === 'string' && value.length <= max)

export function validEventConference(value: unknown): value is EventConference | undefined {
  if (value === undefined) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const conference = value as Partial<EventConference>
  if (!PROVIDERS.has(conference.provider as ConferenceProvider) || !STATUSES.has(conference.status as EventConference['status'])) return false
  if (conference.requestId !== undefined && (typeof conference.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,200}$/.test(conference.requestId))) return false
  return optional(conference.joinUrl, 4_000) && optional(conference.conferenceId, 500) && optional(conference.name, 200) &&
    optional(conference.phone, 200) && optional(conference.pin, 100)
}
