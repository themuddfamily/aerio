// iTIP (RFC 5546) scheduling messages carried in mail: reading REQUEST/CANCEL/REPLY/COUNTER parts, deciding
// whether one is new, an update, a duplicate, or stale against what was seen before, and writing the
// attendee's REPLY or COUNTER. Pure functions; storage and transport live in the main process.
import type { AttendeeResponse, EventAttendee, EventParticipant } from '../types'
import { escapeText, foldLine } from './content-lines'
import { attendeeKey } from './event-attendees'
import { attendeeLine, ICS_LIMITS, organizerLine, parseIcs, type IcsEvent } from './ics'

export type ItipMethod = 'REQUEST' | 'CANCEL' | 'REPLY' | 'COUNTER' | 'DECLINECOUNTER' | 'REFRESH' | 'ADD' | 'PUBLISH'
export const ITIP_METHODS: readonly ItipMethod[] = ['REQUEST', 'CANCEL', 'REPLY', 'COUNTER', 'DECLINECOUNTER', 'REFRESH', 'ADD', 'PUBLISH']

// Invitations are small; these bounds keep a hostile part from costing more than a normal message.
export const ITIP_MAX_CHARS = 1024 * 1024
const ITIP_LIMITS = { ...ICS_LIMITS, maxChars: ITIP_MAX_CHARS, maxLines: 20_000, maxComponents: 500, maxDepth: 5 }
const ITIP_MAX_EVENTS = 200

const CALENDAR_TYPES = new Set(['text/calendar', 'application/ics', 'text/x-vcalendar'])

// Mail parts that may carry an iTIP message: text/calendar (inline or attached) and .ics files.
export const isCalendarAttachment = (attachment: { mimeType?: string; filename?: string | null }) =>
  CALENDAR_TYPES.has((attachment.mimeType ?? '').toLowerCase()) || /\.(ics|ifb|vcs)$/i.test(attachment.filename ?? '')

export interface ItipMessage {
  method: ItipMethod
  // The series master (no RECURRENCE-ID) when present, otherwise the first instance.
  event: IcsEvent & { uid: string }
  // Every VEVENT with the same UID, master first: overridden instances of a recurring invitation.
  instances: (IcsEvent & { uid: string })[]
  warnings: string[]
}

// Returns undefined when the text is not a usable scheduling message (no METHOD, no UID, malformed).
export function parseItip(text: string): ItipMessage | undefined {
  if (text.length > ITIP_MAX_CHARS) return undefined
  let parsed: ReturnType<typeof parseIcs>
  try {
    parsed = parseIcs(text, ITIP_LIMITS, ITIP_MAX_EVENTS, { keepCancelled: true })
  } catch {
    return undefined
  }
  const method = parsed.method as ItipMethod | undefined
  if (!method || !ITIP_METHODS.includes(method)) return undefined
  const withUid = parsed.events.filter((event): event is IcsEvent & { uid: string } => Boolean(event.uid))
  if (!withUid.length) return undefined
  // RFC 5546 section 2.1.5: one iTIP message describes one UID.
  const uid = withUid[0].uid
  const instances = withUid.filter((event) => event.uid === uid)
  instances.sort((a, b) => Number(Boolean(a.recurrenceId)) - Number(Boolean(b.recurrenceId)))
  const warnings = [...parsed.warnings]
  if (withUid.length !== instances.length) warnings.push('Only the first meeting in this message is shown')
  return { method, event: instances[0], instances, warnings }
}

// --- Lifecycle ------------------------------------------------------------------------------

// What Aerio last recorded for one UID (and RECURRENCE-ID) in one account.
export interface InvitationRecord {
  uid: string
  recurrenceId?: string
  method: ItipMethod
  sequence: number
  dtstamp?: string
  messageId: string
  response?: Exclude<AttendeeResponse, 'needs-action' | 'delegated'>
  respondedAt?: string
}

export type InvitationStatus = 'new' | 'update' | 'current' | 'duplicate' | 'stale' | 'cancelled' | 'reply' | 'counter' | 'unsupported'

export interface InvitationVerdict {
  status: InvitationStatus
  // Whether this message should replace the stored record.
  record: boolean
  explanation?: string
}

const stampMs = (value?: string) => value ? Date.parse(value) : Number.NaN

// RFC 5546 section 2.1.5: a higher SEQUENCE wins; within one SEQUENCE a later DTSTAMP wins. A message that
// is neither newer nor the one already recorded is a duplicate (same SEQUENCE and DTSTAMP) or stale.
export function evaluateInvitation(message: ItipMessage, messageId: string, stored?: InvitationRecord, providerSequence?: number): InvitationVerdict {
  const sequence = message.event.sequence ?? 0
  const label = message.method === 'CANCEL' ? 'cancellation' : 'invitation'
  if (message.method === 'REPLY') return { status: 'reply', record: false }
  if (message.method === 'COUNTER') return { status: 'counter', record: false }
  if (message.method !== 'REQUEST' && message.method !== 'CANCEL' && message.method !== 'ADD') {
    return { status: 'unsupported', record: false, explanation: `Aerio does not act on iTIP ${message.method} messages; the details are shown for reference.` }
  }
  if (providerSequence !== undefined && sequence < providerSequence) {
    return { status: 'stale', record: false, explanation: `This ${label} is out of date: your calendar already has update ${providerSequence} of this meeting, and this message carries update ${sequence}.` }
  }
  const current = message.method === 'CANCEL' ? 'cancelled' : stored ? 'update' : 'new'
  if (!stored) return { status: current, record: true }
  if (stored.messageId === messageId) return { status: message.method === 'CANCEL' ? 'cancelled' : 'current', record: false }
  const incomingStamp = stampMs(message.event.dtstamp)
  const storedStamp = stampMs(stored.dtstamp)
  if (sequence > stored.sequence) return { status: current, record: true }
  if (sequence < stored.sequence) {
    const newer = stored.method === 'CANCEL' ? 'a later cancellation' : 'a newer version'
    return { status: 'stale', record: false, explanation: `This ${label} is out of date: ${newer} of this meeting (update ${stored.sequence}) was already received, and this message carries update ${sequence}.` }
  }
  // Same SEQUENCE. A cancellation outranks a request at the same revision (RFC 5546 section 3.2.5).
  if (stored.method === 'CANCEL' && message.method !== 'CANCEL') {
    return { status: 'stale', record: false, explanation: 'This invitation is out of date: the organizer cancelled this meeting after sending it.' }
  }
  if (message.method === 'CANCEL' && stored.method !== 'CANCEL') return { status: 'cancelled', record: true }
  if (Number.isFinite(incomingStamp) && Number.isFinite(storedStamp)) {
    if (incomingStamp > storedStamp) return { status: current, record: true }
    if (incomingStamp < storedStamp) {
      return { status: 'stale', record: false, explanation: `This ${label} is out of date: a copy with the same update number but a later timestamp was already received.` }
    }
  }
  return { status: 'duplicate', record: false, explanation: `You already received this ${label} (same meeting and update number) in another message. Responding here answers the same meeting.` }
}

// --- Replies --------------------------------------------------------------------------------

export interface ItipReplyInput {
  message: ItipMessage
  attendee: EventParticipant
  response: Exclude<AttendeeResponse, 'needs-action' | 'delegated'>
  comment?: string
  // COUNTER: the attendee proposes another time instead of only replying.
  proposed?: { start: string; end: string }
  now?: Date
  prodId?: string
}

const icsUtc = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

const dateLine = (name: string, value: string) =>
  DATE_ONLY.test(value) ? `${name};VALUE=DATE:${value.replace(/-/g, '')}` : `${name}:${icsUtc(Date.parse(value))}`

// RFC 5546 sections 3.2.3 (REPLY) and 3.2.7 (COUNTER). The REPLY carries only the replying attendee and
// echoes the organizer, UID, SEQUENCE, and RECURRENCE-ID so the organizer's client can match it.
// Times are written in UTC: the reply carries no VTIMEZONE, so a TZID would be unresolvable for some clients.
export function buildItipReply(input: ItipReplyInput) {
  const { message, attendee, response, comment, proposed } = input
  const source = message.event
  const method = proposed ? 'COUNTER' : 'REPLY'
  const stamp = icsUtc((input.now ?? new Date()).getTime())
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${input.prodId ?? '-//Aerio//Meeting Response//EN'}`, `METHOD:${method}`, 'BEGIN:VEVENT']
  lines.push(`UID:${escapeText(source.uid)}`, `DTSTAMP:${stamp}`, `SEQUENCE:${source.sequence ?? 0}`)
  if (source.recurrenceId) lines.push(dateLine('RECURRENCE-ID', source.recurrenceId))
  if (source.organizer) lines.push(organizerLine(source.organizer))
  lines.push(attendeeLine({ email: attendee.email, ...(attendee.name ? { name: attendee.name } : {}), response }))
  const times = proposed ?? { start: source.start, end: source.end }
  lines.push(dateLine('DTSTART', times.start), dateLine('DTEND', times.end))
  lines.push(`SUMMARY:${escapeText(source.title)}`)
  if (proposed && source.location) lines.push(`LOCATION:${escapeText(source.location)}`)
  if (comment?.trim()) lines.push(`COMMENT:${escapeText(comment.trim().slice(0, 2_000))}`)
  lines.push('END:VEVENT', 'END:VCALENDAR')
  return { method, ics: `${lines.map(foldLine).join('\r\n')}\r\n` } as const
}

const RESPONSE_WORDS: Record<ItipReplyInput['response'], string> = { accepted: 'Accepted', tentative: 'Tentative', declined: 'Declined' }

// Subject and plain-text body that accompany the calendar part, in the style most clients use.
export function replyMailText(input: Pick<ItipReplyInput, 'message' | 'attendee' | 'response' | 'comment' | 'proposed'>) {
  const who = input.attendee.name || input.attendee.email
  const title = input.message.event.title
  const subject = input.proposed ? `New time proposed: ${title}` : `${RESPONSE_WORDS[input.response]}: ${title}`
  const lines = [input.proposed
    ? `${who} proposed a new time for “${title}”: ${new Date(input.proposed.start).toUTCString()} – ${new Date(input.proposed.end).toUTCString()}.`
    : `${who} ${input.response === 'accepted' ? 'accepted' : input.response === 'tentative' ? 'tentatively accepted' : 'declined'} “${title}”.`]
  if (input.comment?.trim()) lines.push('', input.comment.trim())
  return { subject, text: lines.join('\n') }
}

// The attendee entry for this mailbox, by address, among the invitation's attendees.
export function invitationAttendee(event: IcsEvent, addresses: readonly string[]): EventAttendee | undefined {
  const keys = new Set(addresses.map(attendeeKey))
  const details = new Map((event.attendeeDetails ?? []).map((attendee) => [attendeeKey(attendee.email), attendee]))
  const email = event.attendees.find((address) => keys.has(attendeeKey(address)))
  return email ? { ...details.get(attendeeKey(email)), email } : undefined
}

// The attendee who sent a REPLY or COUNTER: the only (or first) ATTENDEE in it.
export function replyingAttendee(event: IcsEvent): EventAttendee | undefined {
  const email = event.attendees[0]
  if (!email) return undefined
  return { ...(event.attendeeDetails ?? []).find((attendee) => attendeeKey(attendee.email) === attendeeKey(email)), email }
}
