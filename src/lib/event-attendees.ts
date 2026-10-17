// Structured meeting attendees (E22). `CalendarEvent.attendees` stays the plain address list; the optional
// `attendeeDetails` carries roles, resource kinds, and responses for the same addresses. These helpers keep
// the two in step and translate between iCalendar parameters and the Google and Microsoft vocabularies.
import type { AttendeeKind, AttendeeResponse, AttendeeRole, CalendarEvent, EventAttendee, EventParticipant } from '../types'

export const attendeeKey = (email: string) => email.trim().replace(/^mailto:/i, '').toLowerCase()

const isPlain = (attendee: EventAttendee) =>
  !attendee.name && !attendee.self && attendee.rsvp === undefined && (attendee.role ?? 'required') === 'required' &&
  (attendee.kind ?? 'individual') === 'individual' && attendee.response === undefined

// Every attendee in `attendees` order, with details where known. Details for addresses that are no longer in
// `attendees` (an older editor removed them) are ignored: the plain list is authoritative.
export function eventAttendees(event: Pick<CalendarEvent, 'attendees' | 'attendeeDetails'>): EventAttendee[] {
  const details = new Map((event.attendeeDetails ?? []).map((attendee) => [attendeeKey(attendee.email), attendee]))
  return event.attendees.map((email) => ({ ...details.get(attendeeKey(email)), email }))
}

// Writes both fields; `attendeeDetails` is omitted when every attendee is a plain required person.
export function withAttendees<T extends CalendarEvent>(event: T, attendees: EventAttendee[]): T {
  const seen = new Set<string>()
  const unique = attendees.filter((attendee) => {
    const key = attendeeKey(attendee.email)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
  const { attendeeDetails: _previous, ...rest } = event
  const next = { ...rest, attendees: unique.map((attendee) => attendee.email.trim()) } as T
  return unique.some((attendee) => !isPlain(attendee)) ? { ...next, attendeeDetails: unique } : next
}

export function findAttendee(event: Pick<CalendarEvent, 'attendees' | 'attendeeDetails'>, emails: readonly string[]) {
  const keys = new Set(emails.map(attendeeKey))
  const attendees = eventAttendees(event)
  return attendees.find((attendee) => attendee.self) ?? attendees.find((attendee) => keys.has(attendeeKey(attendee.email)))
}

export const isResourceAttendee = (attendee: EventAttendee) => attendee.kind === 'room' || attendee.kind === 'resource'

export function attendeeResponseCounts(attendees: EventAttendee[]) {
  const counts: Record<AttendeeResponse, number> = { 'needs-action': 0, accepted: 0, tentative: 0, declined: 0, delegated: 0 }
  for (const attendee of attendees) counts[attendee.response ?? 'needs-action']++
  return counts
}

export const responseLabel: Record<AttendeeResponse, string> = {
  'needs-action': 'Awaiting reply', accepted: 'Accepted', tentative: 'Tentative', declined: 'Declined', delegated: 'Delegated'
}
export const roleLabel: Record<AttendeeRole, string> = {
  chair: 'Chair', required: 'Required', optional: 'Optional', 'non-participant': 'For information'
}

// --- iCalendar (RFC 5545 section 3.2) -------------------------------------------------------

const ICS_ROLES: Record<string, AttendeeRole> = { CHAIR: 'chair', 'REQ-PARTICIPANT': 'required', 'OPT-PARTICIPANT': 'optional', 'NON-PARTICIPANT': 'non-participant' }
const ICS_KINDS: Record<string, AttendeeKind> = { INDIVIDUAL: 'individual', GROUP: 'group', RESOURCE: 'resource', ROOM: 'room', UNKNOWN: 'unknown' }
const ICS_RESPONSES: Record<string, AttendeeResponse> = {
  'NEEDS-ACTION': 'needs-action', ACCEPTED: 'accepted', TENTATIVE: 'tentative', DECLINED: 'declined', DELEGATED: 'delegated'
}
const invert = <V extends string>(map: Record<string, V>) => Object.fromEntries(Object.entries(map).map(([key, value]) => [value, key])) as Record<V, string>
const ROLE_PARAMS = invert(ICS_ROLES)
const KIND_PARAMS = invert(ICS_KINDS)
const RESPONSE_PARAMS = invert(ICS_RESPONSES)

// Unknown x-names and IANA tokens fall back to the RFC defaults (REQ-PARTICIPANT, INDIVIDUAL, NEEDS-ACTION).
export const roleFromIcs = (value?: string): AttendeeRole | undefined => value ? ICS_ROLES[value.toUpperCase()] ?? 'required' : undefined
export const kindFromIcs = (value?: string): AttendeeKind | undefined => value ? ICS_KINDS[value.toUpperCase()] ?? 'unknown' : undefined
export const responseFromIcs = (value?: string): AttendeeResponse | undefined => value ? ICS_RESPONSES[value.toUpperCase()] ?? 'needs-action' : undefined
export const roleToIcs = (role: AttendeeRole) => ROLE_PARAMS[role]
export const kindToIcs = (kind: AttendeeKind) => KIND_PARAMS[kind]
export const responseToIcs = (response: AttendeeResponse) => RESPONSE_PARAMS[response]

// --- Google Calendar ------------------------------------------------------------------------

export interface GoogleAttendee {
  email?: string
  displayName?: string
  optional?: boolean
  resource?: boolean
  organizer?: boolean
  self?: boolean
  responseStatus?: 'needsAction' | 'declined' | 'tentative' | 'accepted' | string
  comment?: string
}

const GOOGLE_RESPONSES: Record<string, AttendeeResponse> = { needsAction: 'needs-action', declined: 'declined', tentative: 'tentative', accepted: 'accepted' }

export function fromGoogleAttendee(attendee: GoogleAttendee): EventAttendee | undefined {
  if (!attendee.email) return undefined
  return {
    email: attendee.email,
    ...(attendee.displayName ? { name: attendee.displayName } : {}),
    ...(attendee.self ? { self: true } : {}),
    role: attendee.organizer ? 'chair' : attendee.optional ? 'optional' : 'required',
    kind: attendee.resource ? 'resource' : 'individual',
    response: GOOGLE_RESPONSES[attendee.responseStatus ?? ''] ?? 'needs-action'
  }
}

export const googleResponseStatus = (response: AttendeeResponse) =>
  response === 'accepted' ? 'accepted' : response === 'tentative' ? 'tentative' : response === 'declined' ? 'declined' : 'needsAction'

// Google has no chair or non-participant role: chairs are written as required and non-participants as
// optional. Known responses are written back so an organizer's edit does not reset them to needsAction.
export function toGoogleAttendee(attendee: EventAttendee): GoogleAttendee {
  return {
    email: attendee.email,
    ...(attendee.name ? { displayName: attendee.name } : {}),
    ...(!isResourceAttendee(attendee) && (attendee.role === 'optional' || attendee.role === 'non-participant') ? { optional: true } : {}),
    ...(isResourceAttendee(attendee) ? { resource: true } : {}),
    ...(attendee.response ? { responseStatus: googleResponseStatus(attendee.response) } : {})
  }
}

// --- Microsoft Graph ------------------------------------------------------------------------

export interface GraphAttendee {
  emailAddress?: { address?: string; name?: string }
  type?: 'required' | 'optional' | 'resource' | string
  status?: { response?: string; time?: string }
}

const GRAPH_RESPONSES: Record<string, AttendeeResponse> = {
  none: 'needs-action', notResponded: 'needs-action', organizer: 'accepted', tentativelyAccepted: 'tentative', accepted: 'accepted', declined: 'declined'
}

export function fromGraphAttendee(attendee: GraphAttendee, selfEmail?: string): EventAttendee | undefined {
  const email = attendee.emailAddress?.address
  if (!email) return undefined
  return {
    email,
    ...(attendee.emailAddress?.name && attendee.emailAddress.name !== email ? { name: attendee.emailAddress.name } : {}),
    ...(selfEmail && attendeeKey(selfEmail) === attendeeKey(email) ? { self: true } : {}),
    role: attendee.type === 'optional' ? 'optional' : 'required',
    kind: attendee.type === 'resource' ? 'resource' : 'individual',
    response: GRAPH_RESPONSES[attendee.status?.response ?? ''] ?? 'needs-action'
  }
}

export const toGraphAttendee = (attendee: EventAttendee): GraphAttendee => ({
  emailAddress: { address: attendee.email, ...(attendee.name ? { name: attendee.name } : {}) },
  type: isResourceAttendee(attendee) ? 'resource' : attendee.role === 'optional' || attendee.role === 'non-participant' ? 'optional' : 'required'
})

export const participant = (email: string | undefined, name?: string, self?: boolean): EventParticipant | undefined =>
  email ? { email, ...(name && name !== email ? { name } : {}), ...(self ? { self: true } : {}) } : undefined
