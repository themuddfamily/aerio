import type { EventAttendee, EventParticipant } from './types'
import type { InvitationStatus, ItipMethod } from './lib/itip'

export type { InvitationStatus, ItipMethod } from './lib/itip'

export type InvitationResponse = 'accepted' | 'tentative' | 'declined'

// How a response is delivered: the provider's RSVP API when the meeting is already in that account's
// synced calendar, otherwise an iTIP REPLY (or COUNTER) mailed to the organizer.
export type InvitationChannel = 'google' | 'microsoft' | 'mail' | 'none'

export interface ProposedTime {
  start: string
  end: string
}

// One text/calendar part of a received message, interpreted against what Aerio has already seen.
export interface MeetingInvitation {
  accountId: string
  messageId: string
  method: ItipMethod
  status: InvitationStatus
  explanation?: string
  uid: string
  sequence: number
  recurrenceId?: string
  title: string
  start: string
  end: string
  allDay: boolean
  timeZone?: string
  location?: string
  description?: string
  recurrenceRule?: string
  organizer?: EventParticipant
  attendees: EventAttendee[]
  // This mailbox's attendee entry, when the invitation lists it.
  self?: EventAttendee
  organizerIsSelf: boolean
  // REPLY and COUNTER: who answered, what they said, and the time they proposed.
  replyFrom?: EventAttendee
  comment?: string
  proposed?: ProposedTime
  // The last response sent from Aerio, or the response the provider calendar reports.
  response?: InvitationResponse
  respondedAt?: string
  channel: InvitationChannel
  canRespond: boolean
  respondBlockedReason?: string
  canProposeTime: boolean
  proposeTimeNote?: string
  // The provider or local calendar event this invitation corresponds to.
  calendarEventId?: string
  // A local calendar copy (kept for accounts whose provider calendar does not hold the meeting).
  localCopyId?: string
  warnings: string[]
}

export interface InvitationRespondInput {
  accountId: string
  messageId: string
  response: InvitationResponse
  comment?: string
  proposed?: ProposedTime
}

export interface EventResponseInput {
  response: InvitationResponse
  comment?: string
  proposed?: ProposedTime
}

// What the mail worker returns for one stored message: its calendar parts plus the mailbox addresses that
// identify "me" among the attendees.
export interface InvitationMessageSource {
  parts: string[]
  account: { id: string; email: string; displayName: string; provider: import('./mail-types').MailProviderId; archived: boolean }
  addresses: string[]
  fromEmail: string
  subject: string
  messageIdHeader?: string
}

export interface InvitationMailInput {
  accountId: string
  to: string[]
  subject: string
  text: string
  ics: string
  method: 'REPLY' | 'COUNTER'
  inReplyTo?: string
}

export interface MeetingInvitationApi {
  inspect(accountId: string, messageId: string): Promise<MeetingInvitation | undefined>
  respond(input: InvitationRespondInput): Promise<MeetingInvitation>
  // Removes the local calendar copy of a cancelled meeting.
  applyCancellation(accountId: string, messageId: string): Promise<MeetingInvitation>
}
