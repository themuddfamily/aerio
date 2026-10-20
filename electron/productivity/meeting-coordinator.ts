import type { CalendarEvent, EventConference } from '../../src/types'
import type { SyncedCalendar, SyncedCalendarEvent } from '../../src/productivity-types'
import type { HostedMeetingOptions, MeetingHostProvider } from '../../src/meeting-host-types'
import { CONFERENCE_LABELS, conferenceWrite, isHostedConferenceProvider } from '../../src/lib/online-meetings'
import { isUncertainOutcome } from './meeting-host-http'
import type { MeetingLink, MeetingLinkStore } from './meeting-link-store'
import type { HostedMeeting, OnlineMeetingConnector, OnlineMeetingRequest } from './online-meetings'

// Coordinates Zoom and Webex meetings with Google and Microsoft calendar writes (E47).
//
// Create: the meeting is created through the host's API before the calendar write, then its join details are
// written into the event (location when empty, and a delimited block in the notes, which the calendar provider
// sends to attendees with the invitation). The calendar connector receives the conference as `ready`, so it
// never asks Google or Microsoft for a meeting of its own.
//
// Retries: the attempt is recorded under its request id before the call. A definite refusal forgets it; an
// uncertain outcome (timeout, lost connection, 5xx) keeps it, and the next attempt with that id searches the
// host's meetings for the id's agenda marker before creating again. A meeting created by an attempt whose
// calendar write failed is reused by the retry.
//
// Edit: a title or time change updates the meeting first, so a refused change leaves the event unsaved.
// Remove and delete: the event is written first, then the meeting is cancelled (unless the user chose to
// keep it on delete).

export const MEETING_DETAILS_FENCE = '─'.repeat(20)
const DETAILS_BLOCK = new RegExp(`\\n*${MEETING_DETAILS_FENCE}\\nJoin (?:Zoom|Webex|GoToMeeting) meeting\\n[\\s\\S]*?(?:\\n${MEETING_DETAILS_FENCE}|$)`, 'g')

export function meetingDetailsBlock(meeting: HostedMeeting) {
  const label = CONFERENCE_LABELS[meeting.provider]
  const zoom = meeting.provider === 'zoom'
  const lines = [MEETING_DETAILS_FENCE, `Join ${label} meeting`, meeting.joinUrl]
  if (meeting.meetingNumber) lines.push(`${zoom ? 'Meeting ID' : 'Meeting number'}: ${meeting.meetingNumber}`)
  if (meeting.passcode) lines.push(`${zoom ? 'Passcode' : 'Password'}: ${meeting.passcode}`)
  for (const dial of meeting.dialIn ?? []) lines.push(`Dial in${dial.label ? ` (${dial.label})` : ''}: ${dial.number}`)
  if (meeting.dialIn?.length && meeting.phonePasscode) lines.push(`${zoom ? 'Phone passcode' : 'Phone and video system password'}: ${meeting.phonePasscode}`)
  if (meeting.dialIn?.length && !zoom && meeting.meetingNumber) lines.push(`Access code: ${meeting.meetingNumber}`)
  if (meeting.sipAddress) lines.push(`Join by video system: ${meeting.sipAddress}`)
  lines.push(MEETING_DETAILS_FENCE)
  return lines.join('\n')
}

// Removes Aerio's join block, including one cut short by a provider preview (Graph bodyPreview).
export const stripMeetingDetails = (text: string | undefined) => (text ?? '').replace(DETAILS_BLOCK, '').trimEnd()

export function withMeetingDetails<T extends CalendarEvent>(event: T, meeting: HostedMeeting, previousJoinUrl?: string): T {
  const notes = stripMeetingDetails(event.description)
  const location = event.location?.trim()
  return {
    ...event,
    description: [notes, meetingDetailsBlock(meeting)].filter(Boolean).join('\n\n'),
    location: !location || location === previousJoinUrl || location === meeting.joinUrl ? meeting.joinUrl : event.location
  }
}

export function withoutMeetingDetails<T extends CalendarEvent>(event: T, meeting: HostedMeeting | undefined): T {
  return {
    ...event,
    description: stripMeetingDetails(event.description),
    location: meeting && event.location?.trim() === meeting.joinUrl ? '' : event.location
  }
}

export function hostedConference(meeting: HostedMeeting, requestId: string): EventConference {
  const dial = meeting.dialIn?.[0]
  const pin = meeting.phonePasscode ?? meeting.passcode
  return {
    provider: meeting.provider,
    status: 'ready',
    requestId,
    joinUrl: meeting.joinUrl,
    ...(meeting.meetingNumber ? { conferenceId: meeting.meetingNumber } : {}),
    ...(dial ? { phone: `${dial.number}${dial.label ? ` (${dial.label})` : ''}`.slice(0, 200) } : {}),
    ...(dial && pin ? { pin: pin.slice(0, 100) } : {})
  }
}

const meetingRequest = (event: CalendarEvent, requestId: string): OnlineMeetingRequest => ({
  requestId, title: event.title, start: event.start, end: event.end, ...(event.timeZone ? { timeZone: event.timeZone } : {})
})

const scheduleChanged = (before: OnlineMeetingRequest, after: OnlineMeetingRequest) =>
  before.title !== after.title || Date.parse(before.start) !== Date.parse(after.start) || Date.parse(before.end) !== Date.parse(after.end) ||
  (before.timeZone ?? '') !== (after.timeZone ?? '')

const isAllDay = (event: CalendarEvent) => Boolean(event.allDay) || /^\d{4}-\d{2}-\d{2}$/.test(event.start)
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

export interface PreparedMeetingWrite {
  // The event to send to the calendar connector.
  event: CalendarEvent
  // Linked to the written event once the calendar accepts it.
  requestId?: string
  // A removed meeting, cancelled once the event no longer carries it.
  cancel?: MeetingLink
}

export interface HostedMeetingCoordinatorOptions {
  store: MeetingLinkStore
  connector(provider: MeetingHostProvider): OnlineMeetingConnector | undefined
  log?(event: string, details: Record<string, unknown>): void
}

export class HostedMeetingCoordinator {
  constructor(private readonly options: HostedMeetingCoordinatorOptions) {}

  private get store() {
    return this.options.store
  }

  private connector(provider: MeetingHostProvider) {
    const connector = this.options.connector(provider)
    if (!connector) throw new Error(`${CONFERENCE_LABELS[provider]} meetings are not available in this build`)
    return connector
  }

  private linkFor(event: CalendarEvent | undefined) {
    if (!event) return undefined
    const byEvent = this.store.forEvent(event.id)
    if (byEvent) return byEvent
    const requestId = event.conference?.requestId
    const byRequest = requestId && isHostedConferenceProvider(event.conference?.provider) ? this.store.get(requestId) : undefined
    return byRequest?.state === 'created' ? byRequest : undefined
  }

  async prepare(calendar: SyncedCalendar, input: CalendarEvent, current?: CalendarEvent): Promise<PreparedMeetingWrite> {
    const conference = input.conference
    const link = this.linkFor(current)

    if (conference?.status === 'removed') {
      // Aerio's meeting is not a provider conference: drop it from the event instead of asking Google or
      // Microsoft to detach one (Graph refuses that).
      if (link) return { event: withoutMeetingDetails({ ...input, conference: undefined }, link.meeting), cancel: link }
      return { event: input }
    }

    if (conference && isHostedConferenceProvider(conference.provider) && conference.status === 'pending' && conference.requestId && !conference.joinUrl) {
      if (!link && conferenceWrite(input, current?.conference).kind === 'create') {
        const request = meetingRequest(input, conference.requestId)
        this.assertCreatable(calendar, conference.provider, input)
        const meeting = await this.ensureMeeting(calendar, conference.provider, request)
        return { event: withMeetingDetails({ ...input, conference: hostedConference(meeting, request.requestId) }, meeting), requestId: request.requestId }
      }
      // The event already has a meeting: keep it rather than creating another.
      input = { ...input, conference: current?.conference }
    }

    if (link?.meeting && (!input.conference || isHostedConferenceProvider(input.conference.provider))) {
      const label = CONFERENCE_LABELS[link.provider]
      if (isAllDay(input)) throw new Error(`${label} meetings need a start and end time. Remove the ${label} meeting or turn off All day.`)
      const request = meetingRequest(input, link.requestId)
      let meeting = link.meeting
      if (scheduleChanged(link.request, request)) {
        try {
          meeting = await this.connector(link.provider).updateMeeting(link.meeting, request)
        } catch (error) {
          throw new Error(`${label} did not accept the new title or time, so the event was not saved: ${message(error)}`)
        }
        this.store.created(link.requestId, meeting, request)
        this.options.log?.('hosted-meeting-updated', { provider: link.provider })
      }
      return { event: withMeetingDetails({ ...input, conference: hostedConference(meeting, link.requestId) }, meeting, link.meeting.joinUrl), requestId: link.requestId }
    }
    return { event: input }
  }

  private assertCreatable(calendar: SyncedCalendar, provider: MeetingHostProvider, event: CalendarEvent) {
    const label = CONFERENCE_LABELS[provider]
    const capability = this.connector(provider).capability(calendar)
    if (!capability.available) throw new Error(capability.reason ?? `${label} meetings cannot be added to this calendar`)
    if (isAllDay(event)) throw new Error(`${label} meetings need a start and end time; turn off All day to add one`)
    if (event.seriesId || event.recurrenceRule || (event.recurrence && event.recurrence !== 'none')) {
      throw new Error(`${label} meetings can be added to single events only; Aerio does not create recurring ${label} meetings`)
    }
  }

  private async ensureMeeting(calendar: SyncedCalendar, provider: MeetingHostProvider, request: OnlineMeetingRequest): Promise<HostedMeeting> {
    const label = CONFERENCE_LABELS[provider]
    const connector = this.connector(provider)
    const link = this.store.get(request.requestId)
    if (link && link.provider !== provider) throw new Error('This meeting request belongs to another provider; add the meeting again')
    if (link?.state === 'cancelled' || link?.state === 'detached') throw new Error(`This ${label} request was already used by a meeting that has been cancelled; remove it and add ${label} again`)
    if (link?.state === 'created' && link.meeting) return this.reschedule(connector, link, link.meeting, request)
    if (link?.state === 'creating') {
      // An earlier attempt may have created the meeting without Aerio hearing back. Search first; if the search
      // itself fails, nothing is created.
      const found = await connector.findMeeting(request)
      if (found) {
        this.store.created(request.requestId, found, link.request)
        this.options.log?.('hosted-meeting-recovered', { provider, calendarId: calendar.id })
        return this.reschedule(connector, { ...link, request: link.request }, found, request)
      }
    }
    this.store.begin(request.requestId, provider, request)
    let meeting: HostedMeeting
    try {
      meeting = await connector.createMeeting(request)
    } catch (error) {
      if (isUncertainOutcome(error)) {
        this.store.noteError(request.requestId, message(error))
        throw new Error(`${label} did not confirm whether the meeting was created (${message(error)}). The event was not saved. Save again: Aerio checks ${label} for this meeting before creating another.`)
      }
      this.store.forget(request.requestId)
      throw error
    }
    this.store.created(request.requestId, meeting, request)
    this.options.log?.('hosted-meeting-created', { provider, calendarId: calendar.id })
    return meeting
  }

  private async reschedule(connector: OnlineMeetingConnector, link: MeetingLink, meeting: HostedMeeting, request: OnlineMeetingRequest) {
    if (!scheduleChanged(link.request, request)) return meeting
    const updated = await connector.updateMeeting(meeting, request)
    this.store.created(request.requestId, updated, request)
    return updated
  }

  // After the calendar accepted the write: remembers which event carries the meeting.
  finish<T extends SyncedCalendarEvent>(prepared: PreparedMeetingWrite, saved: T): T {
    if (prepared.requestId) this.store.linkEvent(prepared.requestId, { accountId: saved.accountId, calendarId: saved.calendarId, eventId: saved.id })
    return this.decorate([saved])[0]
  }

  // Cancels a meeting removed from its event. Throws an explanation when the provider refuses; the event is
  // already saved without it by then.
  async settle(prepared: PreparedMeetingWrite) {
    if (!prepared.cancel) return
    await this.cancel(prepared.cancel, 'The event was saved without the meeting')
  }

  // Calendar events whose stored copy lost Aerio's meeting (provider reads never report it) get it back.
  decorate<T extends CalendarEvent>(events: T[]): T[] {
    const links = this.store.linkedEvents()
    if (!links.size) return events
    return events.map((event) => {
      const link = links.get(event.id)
      if (!link?.meeting) return event
      const current = event.conference
      if (current && !isHostedConferenceProvider(current.provider) && current.requestId !== link.requestId) return event
      return { ...event, conference: hostedConference(link.meeting, link.requestId) }
    })
  }

  // After the calendar event was deleted in Aerio.
  async eventDeleted(event: CalendarEvent) {
    const link = this.linkFor(event)
    if (!link) return
    if (!link.cancelOnDelete) {
      this.store.setState(link.requestId, 'detached')
      this.options.log?.('hosted-meeting-kept', { provider: link.provider })
      return
    }
    await this.cancel(link, 'The event was deleted')
  }

  private async cancel(link: MeetingLink, done: string) {
    const label = CONFERENCE_LABELS[link.provider]
    // Detached first, so the meeting is never re-attached to the event even if cancelling fails.
    this.store.setState(link.requestId, 'detached')
    if (!link.meeting) return
    try {
      await this.connector(link.provider).deleteMeeting(link.meeting)
    } catch (error) {
      this.store.noteError(link.requestId, message(error))
      throw new Error(`${done}, but ${label} could not cancel the meeting: ${message(error)} Cancel it in ${label} if it is no longer needed.`)
    }
    this.store.setState(link.requestId, 'cancelled')
    this.options.log?.('hosted-meeting-cancelled', { provider: link.provider })
  }

  meetingOptions(requestId: string): HostedMeetingOptions | null {
    const link = this.store.get(requestId)
    if (!link || link.state !== 'created') return null
    return { provider: link.provider, cancelOnDelete: link.cancelOnDelete, ...(link.meeting ? { meetingId: link.meeting.meetingId } : {}) }
  }

  setCancelOnDelete(requestId: string, cancel: boolean) {
    if (!this.meetingOptions(requestId)) throw new Error('That meeting is no longer linked to an event')
    this.store.setCancelOnDelete(requestId, cancel)
    return this.meetingOptions(requestId)
  }
}
