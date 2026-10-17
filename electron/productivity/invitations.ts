import { createHash } from 'node:crypto'
import type { CalendarEvent } from '../../src/types'
import type { SyncedCalendar, SyncedCalendarEvent } from '../../src/productivity-types'
import type {
  EventResponseInput, InvitationChannel, InvitationMailInput, InvitationMessageSource, InvitationRespondInput, InvitationResponse, MeetingInvitation
} from '../../src/invitation-types'
import { attendeeKey, eventAttendees, findAttendee, withAttendees } from '../../src/lib/event-attendees'
import { icsEventToCalendarEvent } from '../../src/lib/ics'
import {
  buildItipReply, evaluateInvitation, invitationAttendee, parseItip, replyingAttendee, replyMailText, type InvitationRecord, type ItipMessage
} from '../../src/lib/itip'
import { occurrenceKey } from '../../src/lib/recurrence'
import type { InterchangeStore } from './interchange-store'
import type { InvitationStore } from './invitation-store'
import type { ProductivityStore } from './store'

// Accepted invitations for accounts whose provider calendar does not hold the meeting are kept here.
export const INVITATIONS_CALENDAR_ID = 'local-calendar-invitations'
const RESPONSES: readonly InvitationResponse[] = ['accepted', 'tentative', 'declined']

export interface InvitationServiceOptions {
  source(accountId: string, messageId: string): Promise<InvitationMessageSource>
  sendMail(input: InvitationMailInput): Promise<void>
  // Provider RSVP: Google events.patch or Graph accept/tentativelyAccept/decline for `remoteId`.
  respondProvider(calendar: SyncedCalendar, remoteId: string, addresses: readonly string[], input: EventResponseInput): Promise<void>
  addresses(accountId: string): Promise<string[]>
  sync(accountId: string): Promise<unknown>
  productivity(): ProductivityStore
  interchange(): InterchangeStore
  invitations(): InvitationStore
  changed?(): void
  now?(): Date
  diagnostic?(record: { level: 'info' | 'warn' | 'error'; event: string; message?: string; details?: Record<string, unknown> }): void
}

const sameOccurrence = (a?: string, b?: string) => Boolean(a && b && occurrenceKey(a) === occurrenceKey(b))
const asResponse = (value?: string): InvitationResponse | undefined => RESPONSES.includes(value as InvitationResponse) ? value as InvitationResponse : undefined

export function validProposedTime(value: unknown): value is { start: string; end: string } {
  if (!value || typeof value !== 'object') return false
  const { start, end } = value as { start?: unknown; end?: unknown }
  if (typeof start !== 'string' || typeof end !== 'string' || start.length > 100 || end.length > 100) return false
  const from = Date.parse(start)
  const to = Date.parse(end)
  return Number.isFinite(from) && Number.isFinite(to) && to > from && to - from <= 366 * 86_400_000
}

export function validRespondInput(value: unknown): value is EventResponseInput {
  if (!value || typeof value !== 'object') return false
  const input = value as Partial<EventResponseInput>
  return RESPONSES.includes(input.response as InvitationResponse) &&
    (input.comment === undefined || (typeof input.comment === 'string' && input.comment.length <= 2_000)) &&
    (input.proposed === undefined || validProposedTime(input.proposed))
}

export function createInvitationService(options: InvitationServiceOptions) {
  const now = () => options.now?.() ?? new Date()

  // The synced provider event for this UID in the same account: the matching occurrence for an instance
  // invitation, otherwise any instance (its series master is what gets answered).
  const providerEvent = (accountId: string, message: ItipMessage) => {
    const candidates = options.productivity().snapshot().events.filter((event) =>
      event.accountId === accountId && (event.provider === 'gmail' || event.provider === 'microsoft') && event.icalUid === message.event.uid)
    if (message.event.recurrenceId) return candidates.find((event) => sameOccurrence(event.originalStart ?? event.start, message.event.recurrenceId))
    return candidates.find((event) => !event.seriesId) ?? candidates[0]
  }

  const localCopies = (uid: string) => options.interchange().events(INVITATIONS_CALENDAR_ID).filter((event) => event.sourceUid === uid)

  const localCopyId = (accountId: string, uid: string, recurrenceId?: string) =>
    `invitation-${createHash('sha256').update(`${accountId}\u0000${uid}\u0000${recurrenceId ?? ''}`).digest('hex').slice(0, 32)}`

  async function evaluate(accountId: string, messageId: string, record: boolean) {
    const source = await options.source(accountId, messageId)
    let message: ItipMessage | undefined
    for (const part of source.parts) {
      message = parseItip(part)
      if (message) break
    }
    if (!message) return undefined
    const event = message.event
    const store = options.invitations()
    const stored = store.get(accountId, event.uid, event.recurrenceId)
    const synced = source.account.provider === 'gmail' || source.account.provider === 'microsoft' ? providerEvent(accountId, message) : undefined
    const verdict = evaluateInvitation(message, messageId, stored, synced?.sequence)
    const sequence = event.sequence ?? 0
    if (record && verdict.record) {
      // A new SEQUENCE is a significant change (RFC 5546 section 2.1.4): the previous answer no longer applies.
      const keep = stored && stored.sequence === sequence
      store.save(accountId, {
        uid: event.uid, ...(event.recurrenceId ? { recurrenceId: event.recurrenceId } : {}), method: message.method, sequence,
        ...(event.dtstamp ? { dtstamp: event.dtstamp } : {}), messageId,
        ...(keep && stored.response ? { response: stored.response, respondedAt: stored.respondedAt } : {})
      })
    }
    const current = store.get(accountId, event.uid, event.recurrenceId)
    return { source, message, synced, verdict, stored: current }
  }

  function describe(accountId: string, messageId: string, evaluated: NonNullable<Awaited<ReturnType<typeof evaluate>>>): MeetingInvitation {
    const { source, message, synced, verdict, stored } = evaluated
    const event = message.event
    const sequence = event.sequence ?? 0
    const keys = new Set(source.addresses.map(attendeeKey))
    const organizerIsSelf = Boolean(event.organizer && keys.has(attendeeKey(event.organizer.email)))
    const self = invitationAttendee(event, source.addresses)
    const warnings = [...message.warnings]
    const replying = message.method === 'REPLY' || message.method === 'COUNTER'
    const providerSelf = synced ? findAttendee(synced, source.addresses) : undefined
    const response = (stored?.sequence === sequence ? stored.response : undefined) ?? asResponse(providerSelf?.response)
    const copies = localCopies(event.uid)
    const copy = copies.find((item) => (item.recurrenceId ?? '') === (event.recurrenceId ?? '')) ?? (event.recurrenceId ? undefined : copies[0])

    const actionable = message.method === 'REQUEST' || message.method === 'ADD'
    const channel: InvitationChannel = !actionable ? 'none' : synced ? (synced.provider === 'gmail' ? 'google' : 'microsoft') : event.organizer ? 'mail' : 'none'
    const blocked = !actionable ? undefined
      : verdict.status === 'stale' ? verdict.explanation
        : organizerIsSelf ? 'You organized this meeting; attendees’ answers arrive as replies.'
          : source.account.archived ? 'Reconnect this account to respond.'
            : channel === 'none' ? 'This invitation does not name an organizer to reply to.'
              : undefined
    const canRespond = actionable && !blocked
    if (canRespond && !self) warnings.push('Your address is not on the guest list (the invitation may have been sent to a group or forwarded); your reply adds you as a guest.')
    if (canRespond && self && (self.rsvp === false || self.role === 'non-participant')) warnings.push('The organizer did not ask you to reply; responding is optional.')
    const canProposeTime = canRespond && channel !== 'google'

    return {
      accountId, messageId, method: message.method, status: verdict.status,
      ...(verdict.explanation ? { explanation: verdict.explanation } : {}),
      uid: event.uid, sequence,
      ...(event.recurrenceId ? { recurrenceId: event.recurrenceId } : {}),
      title: event.title, start: event.start, end: event.end, allDay: event.allDay,
      ...(event.timeZone ? { timeZone: event.timeZone } : {}),
      ...(event.location ? { location: event.location } : {}),
      ...(event.description ? { description: event.description.slice(0, 5_000) } : {}),
      ...(event.recurrenceRule ? { recurrenceRule: event.recurrenceRule } : {}),
      ...(event.organizer ? { organizer: event.organizer } : {}),
      attendees: eventAttendees(event),
      ...(self ? { self } : {}),
      organizerIsSelf,
      ...(replying && replyingAttendee(event) ? { replyFrom: replyingAttendee(event) } : {}),
      ...(event.comment ? { comment: event.comment } : {}),
      ...(message.method === 'COUNTER' ? { proposed: { start: event.start, end: event.end } } : {}),
      ...(response ? { response } : {}),
      ...(stored?.respondedAt && stored.sequence === sequence ? { respondedAt: stored.respondedAt } : {}),
      channel, canRespond,
      ...(blocked ? { respondBlockedReason: blocked } : {}),
      canProposeTime,
      ...(canRespond && channel === 'google' ? { proposeTimeNote: 'Google Calendar’s API cannot propose a new time; use Google Calendar to propose one.' } : {}),
      ...(canRespond && channel === 'microsoft' ? { proposeTimeNote: 'Microsoft sends a proposed time with a Tentative or Decline response, when the organizer allows proposals.' } : {}),
      ...(synced ? { calendarEventId: synced.id } : copy ? { calendarEventId: copy.id } : {}),
      ...(copy ? { localCopyId: copy.id } : {}),
      warnings
    }
  }

  async function inspect(accountId: string, messageId: string) {
    const evaluated = await evaluate(accountId, messageId, true)
    return evaluated ? describe(accountId, messageId, evaluated) : undefined
  }

  // Accepted meetings answered by mail are copied into the local Invitations calendar so they show up in
  // Calendar; a decline removes the copy. Overridden instances in the message are kept as overrides.
  function saveLocalCopy(accountId: string, message: ItipMessage, self: { email: string; name?: string }, response: InvitationResponse) {
    const store = options.interchange()
    const existing = localCopies(message.event.uid)
    if (response === 'declined') {
      for (const item of existing) store.deleteEvent(item.id)
      return
    }
    if (!store.calendar(INVITATIONS_CALENDAR_ID)) {
      store.saveCalendar({ id: INVITATIONS_CALENDAR_ID, kind: 'local', name: 'Invitations', color: store.nextColor() })
    }
    const masterId = localCopyId(accountId, message.event.uid)
    const events: CalendarEvent[] = message.instances.filter((instance) => instance.status !== 'CANCELLED').map((instance) => {
      const id = localCopyId(accountId, instance.uid, instance.recurrenceId)
      const base = icsEventToCalendarEvent(instance, INVITATIONS_CALENDAR_ID, '', id)
      const attendees = eventAttendees(base)
      const mine = attendees.findIndex((attendee) => attendeeKey(attendee.email) === attendeeKey(self.email))
      const next = mine >= 0
        ? attendees.map((attendee, index) => index === mine ? { ...attendee, response, self: true } : attendee)
        : [...attendees, { email: self.email, ...(self.name ? { name: self.name } : {}), role: 'required' as const, response, self: true }]
      return withAttendees({ ...base, ...(instance.recurrenceId && message.event.recurrenceId === undefined ? { seriesId: masterId } : {}) }, next)
    })
    store.saveEvents(INVITATIONS_CALENDAR_ID, events)
  }

  async function respond(input: InvitationRespondInput) {
    const evaluated = await evaluate(input.accountId, input.messageId, true)
    if (!evaluated) throw new Error('This message no longer contains a meeting invitation')
    const invitation = describe(input.accountId, input.messageId, evaluated)
    if (!invitation.canRespond) throw new Error(invitation.respondBlockedReason ?? 'This message cannot be answered')
    if (input.proposed && !invitation.canProposeTime) throw new Error(invitation.proposeTimeNote ?? 'A new time cannot be proposed for this meeting')
    const { source, message, synced } = evaluated
    const reply: EventResponseInput = { response: input.response, ...(input.comment?.trim() ? { comment: input.comment.trim() } : {}), ...(input.proposed ? { proposed: input.proposed } : {}) }
    if (synced && (invitation.channel === 'google' || invitation.channel === 'microsoft')) {
      const calendar = options.productivity().snapshot().calendars.find((item) => item.id === synced.calendarId)
      if (!calendar) throw new Error('The meeting’s calendar is no longer available; synchronize Calendar and try again')
      // An invitation for the whole series answers the series master; an instance invitation answers that instance.
      const remoteId = message.event.recurrenceId ? synced.remoteId : synced.seriesId ?? synced.remoteId
      await options.respondProvider(calendar, remoteId, source.addresses, reply)
      await options.sync(input.accountId).catch(() => undefined)
    } else {
      const attendee = invitation.self ?? { email: source.account.email, ...(source.account.displayName ? { name: source.account.displayName } : {}) }
      const built = buildItipReply({ message, attendee, response: input.response, comment: reply.comment, proposed: input.proposed, now: now() })
      const mail = replyMailText({ message, attendee, response: input.response, comment: reply.comment, proposed: input.proposed })
      await options.sendMail({
        accountId: input.accountId, to: [message.event.organizer!.email], subject: mail.subject, text: mail.text, ics: built.ics, method: built.method,
        ...(source.messageIdHeader ? { inReplyTo: source.messageIdHeader } : {})
      })
      saveLocalCopy(input.accountId, message, attendee, input.response)
    }
    const stored = options.invitations().get(input.accountId, message.event.uid, message.event.recurrenceId)
    const record: InvitationRecord = stored ?? {
      uid: message.event.uid, ...(message.event.recurrenceId ? { recurrenceId: message.event.recurrenceId } : {}),
      method: message.method, sequence: message.event.sequence ?? 0, ...(message.event.dtstamp ? { dtstamp: message.event.dtstamp } : {}), messageId: input.messageId
    }
    options.invitations().save(input.accountId, { ...record, response: input.response, respondedAt: now().toISOString() })
    options.diagnostic?.({ level: 'info', event: 'meeting-response-sent', details: { channel: invitation.channel, response: input.response, proposed: Boolean(input.proposed) } })
    options.changed?.()
    return (await inspect(input.accountId, input.messageId))!
  }

  // Applies a received cancellation to the local Invitations copy: an instance cancellation becomes an
  // exception on the copied series; a whole-meeting cancellation removes every copy.
  async function applyCancellation(accountId: string, messageId: string) {
    const evaluated = await evaluate(accountId, messageId, true)
    if (!evaluated) throw new Error('This message no longer contains a meeting invitation')
    if (evaluated.message.method !== 'CANCEL' || evaluated.verdict.status !== 'cancelled') throw new Error(evaluated.verdict.explanation ?? 'This message does not cancel a meeting')
    const store = options.interchange()
    const { uid, recurrenceId } = evaluated.message.event
    const copies = localCopies(uid)
    if (recurrenceId) {
      for (const item of copies.filter((copy) => sameOccurrence(copy.recurrenceId, recurrenceId))) store.deleteEvent(item.id)
      const master = copies.find((copy) => !copy.recurrenceId)
      if (master) {
        const exceptions = [...new Set([...(master.recurrenceExceptions ?? []), recurrenceId])]
        const { readOnly: _readOnly, ...event } = master
        store.saveEvents(INVITATIONS_CALENDAR_ID, [{ ...event, recurrenceExceptions: exceptions }])
      }
    } else {
      for (const item of copies) store.deleteEvent(item.id)
    }
    options.changed?.()
    return describe(accountId, messageId, evaluated)
  }

  // Calendar-side RSVP for a synced provider event (one occurrence, or a single event).
  async function respondToEvent(eventId: string, input: EventResponseInput) {
    const snapshot = options.productivity().snapshot()
    const event: SyncedCalendarEvent | undefined = snapshot.events.find((item) => item.id === eventId)
    if (!event) throw new Error('That event is no longer available')
    if (event.provider !== 'gmail' && event.provider !== 'microsoft') throw new Error('This calendar has no response API; answer the invitation email instead')
    const calendar = snapshot.calendars.find((item) => item.id === event.calendarId)
    if (!calendar) throw new Error('That calendar is no longer available')
    const addresses = await options.addresses(event.accountId)
    if (event.organizer && (event.organizer.self || addresses.some((address) => attendeeKey(address) === attendeeKey(event.organizer!.email)))) {
      throw new Error('You organized this meeting; attendees’ answers arrive as replies')
    }
    if (!findAttendee(event, addresses)) throw new Error('You are not a guest of this meeting')
    if (input.proposed && event.provider === 'gmail') throw new Error('Google Calendar’s API cannot propose a new time; use Google Calendar to propose one')
    await options.respondProvider(calendar, event.remoteId, addresses, input)
    options.diagnostic?.({ level: 'info', event: 'meeting-response-sent', details: { channel: event.provider, response: input.response, proposed: Boolean(input.proposed) } })
    await options.sync(event.accountId).catch(() => undefined)
    options.changed?.()
    return options.productivity().snapshot()
  }

  return { inspect, respond, applyCancellation, respondToEvent }
}
