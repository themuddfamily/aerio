import type { CalendarEvent, Contact } from '../../src/types'
import type { ProviderProductivityData, ProviderProductivitySyncResult, SyncedCalendar, SyncedCalendarEvent, SyncedContact } from '../../src/productivity-types'
import { ProductivityApiError, retryingJson, type ProductivityConnector } from './connector'
import { addDaysIso, eventRecurrenceRule, formatRecurrenceRule, isAllDayEvent, occurrenceKey, occurrencesBefore, parseRecurrenceRule, wallParts, isoDay } from '../../src/lib/recurrence'
import { shiftSeriesTiming } from '../../src/lib/recurrence-edit'
import { graphRecurrenceToRule, ruleToGraphRecurrence, type GraphRecurrence } from '../../src/lib/provider-recurrence'
import { isIanaTimeZone, resolveTimeZoneName, wallTimeInZone, windowsTimeZoneName } from '../../src/lib/time-zones'
import { eventAttendees, fromGraphAttendee, participant, toGraphAttendee, withAttendees, type GraphAttendee } from '../../src/lib/event-attendees'
import type { EventResponseInput } from '../../src/invitation-types'
import { mapMicrosoftRichContact, microsoftRichContactBody, microsoftRichContactSelect, type GraphRichContact } from './microsoft-contacts'
import { conferenceWrite } from '../../src/lib/online-meetings'
import {
  assertConferenceCreatable, assertConferenceRemovable, graphOnlineMeetingSelect, graphTeamsMeeting, mapGraphConference, microsoftConferenceSupport,
  type GraphOnlineMeetingFields
} from './online-meetings'

interface GraphPage<T> { value: T[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string }
interface GraphCalendar {
  id: string
  name?: string
  color?: string
  isDefaultCalendar?: boolean
  canEdit?: boolean
  allowedOnlineMeetingProviders?: string[]
  defaultOnlineMeetingProvider?: string
}
interface GraphEvent extends GraphOnlineMeetingFields {
  id: string
  '@removed'?: { reason?: string }
  subject?: string
  bodyPreview?: string
  location?: { displayName?: string }
  start?: { dateTime?: string; timeZone?: string }
  end?: { dateTime?: string; timeZone?: string }
  attendees?: GraphAttendee[]
  organizer?: { emailAddress?: { address?: string; name?: string } }
  responseStatus?: { response?: string; time?: string }
  iCalUId?: string
  uid?: string
  recurrence?: GraphRecurrence | null
  reminderMinutesBeforeStart?: number
  isCancelled?: boolean
  isOrganizer?: boolean
  isAllDay?: boolean
  type?: 'singleInstance' | 'occurrence' | 'exception' | 'seriesMaster' | string
  seriesMasterId?: string
  originalStart?: string
  originalStartTimeZone?: string
}
interface GraphContact {
  id: string
  '@removed'?: { reason?: string }
  changeKey?: string
  parentFolderId?: string
  displayName?: string
  givenName?: string
  surname?: string
  emailAddresses?: { address?: string }[]
  businessPhones?: string[]
  mobilePhone?: string
  companyName?: string
  jobTitle?: string
  personalNotes?: string
  categories?: string[]
}

export const microsoftContactBody = (contact: Contact) => {
  const parts = contact.name.trim().split(/\s+/)
  const surname = parts.length > 1 ? parts.pop() : undefined
  const givenName = parts.join(' ') || contact.name.trim()
  return {
    displayName: contact.name,
    givenName,
    surname,
    emailAddresses: contact.email ? [{ address: contact.email, name: contact.name }] : [],
    businessPhones: contact.phone ? [contact.phone] : [],
    companyName: contact.company ?? '',
    jobTitle: contact.title ?? '',
    personalNotes: contact.notes ?? '',
    categories: contact.group && contact.group !== 'Outlook' ? [contact.group] : []
  }
}

const utc = (value?: string) => !value ? undefined : /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value}Z`
const recurrence = (value?: string) => {
  const normalized = value?.toLowerCase() ?? ''
  return normalized.includes('daily') ? 'daily' : normalized.includes('weekly') ? 'weekly' : normalized.includes('monthly') ? 'monthly' : 'none'
}

const pad = (value: number) => String(value).padStart(2, '0')
const graphWall = (ms: number, zone: string) => {
  const wall = wallTimeInZone(ms, zone)
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}:${pad(wall.second)}`
}

// Graph time for an Aerio value: wall time in the event's zone (by Windows name) when Graph knows the zone,
// otherwise UTC. All-day events are written as midnight dates with isAllDay.
function graphTimes(event: CalendarEvent) {
  const iana = event.timeZone && isIanaTimeZone(event.timeZone) ? event.timeZone : undefined
  const windows = windowsTimeZoneName(iana)
  if (isAllDayEvent(event)) {
    const zone = windows ?? 'UTC'
    return { zone, startDate: event.start.slice(0, 10), start: { dateTime: `${event.start.slice(0, 10)}T00:00:00`, timeZone: zone }, end: { dateTime: `${event.end.slice(0, 10)}T00:00:00`, timeZone: zone } }
  }
  if (iana && windows && windows !== 'UTC') {
    return {
      zone: windows, startDate: graphWall(Date.parse(event.start), iana).slice(0, 10),
      start: { dateTime: graphWall(Date.parse(event.start), iana), timeZone: windows }, end: { dateTime: graphWall(Date.parse(event.end), iana), timeZone: windows }
    }
  }
  return { zone: 'UTC', startDate: new Date(event.start).toISOString().slice(0, 10), start: { dateTime: event.start, timeZone: 'UTC' }, end: { dateTime: event.end, timeZone: 'UTC' } }
}

// `instance` writes a single occurrence (or a master without touching its pattern): `recurrence` is omitted.
// Rules Graph cannot express throw UnsupportedRecurrenceError rather than being simplified silently.
export const microsoftEventBody = (event: CalendarEvent, options: { instance?: boolean } = {}) => {
  const times = graphTimes(event)
  const rule = eventRecurrenceRule(event)
  const body = {
    subject: event.title,
    body: { contentType: 'text', content: event.description ?? '' },
    start: times.start,
    end: times.end,
    location: { displayName: event.location ?? '' },
    attendees: eventAttendees(event).map(toGraphAttendee),
    isReminderOn: true,
    reminderMinutesBeforeStart: event.reminderMinutes,
    ...(isAllDayEvent(event) ? { isAllDay: true } : {})
  }
  if (options.instance || event.seriesId) return body
  return { ...body, recurrence: rule ? ruleToGraphRecurrence(formatRecurrenceRule(rule), times.startDate, times.zone) : null }
}

// With Prefer: outlook.timezone="UTC", all-day events may come back as midnight UTC or as the UTC instant
// of local midnight; both are reduced to the local calendar date.
function allDayDate(value: string, zone: string | undefined) {
  if (/T00:00:00(?:\.0+)?Z?$/.test(value) || !zone) return value.slice(0, 10)
  return isoDay(wallParts(utc(value)!, zone).day)
}

export function mapMicrosoftEvent(accountId: string, calendar: SyncedCalendar, event: GraphEvent): SyncedCalendarEvent | undefined {
  const start = utc(event.start?.dateTime)
  const end = utc(event.end?.dateTime)
  if (!start || !end || event.isCancelled) return
  const zone = resolveTimeZoneName(event.originalStartTimeZone)
  const recurrenceRule = event.seriesMasterId ? undefined : graphRecurrenceToRule(event.recurrence)
  const allDay = event.isAllDay ? { allDay: true, start: allDayDate(event.start!.dateTime!, zone), end: allDayDate(event.end!.dateTime!, zone) } : {}
  const details = (event.attendees ?? []).flatMap((attendee) => fromGraphAttendee(attendee) ?? [])
  const organizer = participant(event.organizer?.emailAddress?.address, event.organizer?.emailAddress?.name, event.isOrganizer)
  // `uid` is shared by a series master and its occurrences; iCalUId differs per occurrence.
  const icalUid = event.uid ?? event.iCalUId
  const conference = mapGraphConference(event)
  return withAttendees({
    id: `${accountId}:microsoft-event:${calendar.remoteId}:${event.id}`,
    remoteId: event.id,
    accountId,
    provider: 'microsoft',
    calendarId: calendar.id,
    title: event.subject?.trim() || '(Untitled event)',
    start,
    end,
    location: event.location?.displayName,
    description: event.bodyPreview,
    color: calendar.color,
    attendees: (event.attendees ?? []).flatMap((attendee) => attendee.emailAddress?.address ? [attendee.emailAddress.address] : []),
    reminderMinutes: event.reminderMinutesBeforeStart ?? 30,
    recurrence: recurrence(event.recurrence?.pattern?.type),
    readOnly: !calendar.canWrite || event.isOrganizer === false,
    ...allDay,
    ...(zone && !event.isAllDay ? { timeZone: zone } : {}),
    ...(recurrenceRule ? { recurrenceRule } : {}),
    ...(event.seriesMasterId ? { seriesId: event.seriesMasterId } : {}),
    ...(event.seriesMasterId && event.originalStart ? { originalStart: event.isAllDay ? allDayDate(event.originalStart, zone) : new Date(utc(event.originalStart)!).toISOString() } : {}),
    ...(organizer ? { organizer } : {}),
    ...(icalUid ? { icalUid } : {}),
    ...(conference ? { conference } : {})
  } satisfies SyncedCalendarEvent, details)
}

// calendarView never returns series masters, so one stored from a write is replaced by its occurrences.
const isStoredMaster = (event: SyncedCalendarEvent) => Boolean(event.recurrenceRule && !event.seriesId)

export function mapMicrosoftContact(accountId: string, contact: GraphContact, readOnly = false): SyncedContact | undefined {
  const name = contact.displayName?.trim() || `${contact.givenName ?? ''} ${contact.surname ?? ''}`.trim()
  if (!name) return
  return {
    id: `${accountId}:microsoft-contact:${contact.id}`,
    remoteId: contact.id,
    accountId,
    provider: 'microsoft',
    revision: contact.changeKey,
    folderId: contact.parentFolderId,
    name,
    email: contact.emailAddresses?.[0]?.address ?? '',
    phone: contact.mobilePhone ?? contact.businessPhones?.[0],
    company: contact.companyName,
    title: contact.jobTitle,
    group: contact.categories?.[0] ?? 'Outlook',
    notes: contact.personalNotes,
    favorite: false,
    color: '#3b6fd8',
    readOnly
  }
}

export class MicrosoftProductivityConnector implements ProductivityConnector {
  readonly provider = 'microsoft' as const

  constructor(
    private readonly accountId: string,
    private readonly token: () => Promise<string>,
    private readonly calendarWriteAuthorized = false,
    private readonly contactsWriteAuthorized = false
  ) {}

  async sync(
    previous: ProviderProductivityData = { calendars: [], events: [], contacts: [] },
    checkpoints: Record<string, string> = {}
  ): Promise<ProviderProductivitySyncResult> {
    const remoteCalendars = await this.pages<GraphCalendar>('https://graph.microsoft.com/v1.0/me/calendars?$select=id,name,color,isDefaultCalendar,canEdit,allowedOnlineMeetingProviders,defaultOnlineMeetingProvider')
    const calendars: SyncedCalendar[] = remoteCalendars.map((calendar) => ({
      id: `${this.accountId}:microsoft-calendar:${calendar.id}`,
      remoteId: calendar.id,
      accountId: this.accountId,
      provider: 'microsoft',
      name: calendar.name?.trim() || 'Calendar',
      color: graphColor(calendar.color),
      primary: Boolean(calendar.isDefaultCalendar),
      canWrite: this.calendarWriteAuthorized && Boolean(calendar.canEdit),
      conferences: microsoftConferenceSupport(calendar.allowedOnlineMeetingProviders, calendar.defaultOnlineMeetingProvider, this.calendarWriteAuthorized && Boolean(calendar.canEdit))
    }))
    const from = new Date(); from.setUTCFullYear(from.getUTCFullYear() - 1)
    const to = new Date(); to.setUTCFullYear(to.getUTCFullYear() + 2)
    const events: SyncedCalendarEvent[] = []
    const nextCheckpoints: Record<string, string> = {}
    for (const calendar of calendars) {
      const key = `events:${calendar.remoteId}`
      const synced = await this.syncEvents(calendar, previous.events, checkpoints[key], from, to)
      events.push(...synced.items)
      if (synced.checkpoint) nextCheckpoints[key] = synced.checkpoint
    }
    const contactSync = await this.syncContacts(previous.contacts, checkpoints.contacts)
    if (contactSync.checkpoint) nextCheckpoints.contacts = contactSync.checkpoint
    return { calendars, events, contacts: contactSync.items, checkpoints: nextCheckpoints }
  }

  private async syncEvents(calendar: SyncedCalendar, previous: SyncedCalendarEvent[], checkpoint: string | undefined, from: Date, to: Date) {
    const run = async (deltaLink?: string) => {
      const initial = new URL(`https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendar.remoteId)}/calendarView/delta`)
      initial.search = new URLSearchParams({ startDateTime: from.toISOString(), endDateTime: to.toISOString() }).toString()
      const delta = await this.deltaPages<GraphEvent>(deltaLink ?? initial.toString())
      const current = deltaLink ? new Map(previous.filter((event) => event.calendarId === calendar.id && !isStoredMaster(event)).map((event) => [event.id, event])) : new Map<string, SyncedCalendarEvent>()
      for (const event of delta.items) {
        const id = `${this.accountId}:microsoft-event:${calendar.remoteId}:${event.id}`
        const mapped = mapMicrosoftEvent(this.accountId, calendar, event)
        if (mapped) current.set(id, mapped)
        else if (event['@removed'] || event.isCancelled) current.delete(id)
      }
      return { items: [...current.values()], checkpoint: delta.checkpoint }
    }
    try {
      return await run(checkpoint)
    } catch (error) {
      if (!checkpoint || !(error instanceof ProductivityApiError) || (error.status !== 404 && error.status !== 410)) throw error
      return run()
    }
  }

  private async syncContacts(previous: SyncedContact[], checkpoint?: string) {
    const run = async (deltaLink?: string) => {
      let initial = deltaLink
      if (!initial) {
        const knownFolder = previous.find((contact) => contact.folderId)?.folderId
        const folderId = knownFolder ?? await this.defaultContactFolderId()
        if (!folderId) return { items: [] as SyncedContact[], checkpoint: undefined }
        initial = `https://graph.microsoft.com/v1.0/me/contactFolders/${encodeURIComponent(folderId)}/contacts/delta?$select=${microsoftRichContactSelect}`
      }
      const delta = await this.deltaPages<GraphRichContact>(initial)
      const current = deltaLink ? new Map(previous.map((contact) => [contact.remoteId, contact])) : new Map<string, SyncedContact>()
      for (const contact of delta.items) {
        if (contact['@removed']) {
          current.delete(contact.id)
          continue
        }
        const mapped = mapMicrosoftRichContact(this.accountId, contact, !this.contactsWriteAuthorized)
        if (mapped) current.set(contact.id, mapped)
      }
      return { items: [...current.values()], checkpoint: delta.checkpoint }
    }
    try {
      return await run(checkpoint)
    } catch (error) {
      if (!checkpoint || !(error instanceof ProductivityApiError) || (error.status !== 404 && error.status !== 410)) throw error
      return run()
    }
  }

  private async defaultContactFolderId() {
    const page = await retryingJson<GraphPage<GraphContact>>(this.provider, 'https://graph.microsoft.com/v1.0/me/contacts?$top=1&$select=id,parentFolderId', this.token)
    return page.value[0]?.parentFolderId
  }

  // A Teams request sends its stable request id as transactionId, so Graph recognizes a retried POST of the
  // same meeting instead of creating a second event and meeting.
  async createEvent(calendar: SyncedCalendar, event: CalendarEvent) {
    this.assertWritable(calendar)
    const write = conferenceWrite(event)
    if (write.kind === 'create') assertConferenceCreatable(calendar, write.provider)
    const body = {
      ...microsoftEventBody(event),
      ...(write.kind === 'create' ? { ...graphTeamsMeeting, transactionId: write.requestId } : {})
    }
    const remote = await retryingJson<GraphEvent>(this.provider, this.eventsUrl(calendar), this.token, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    })
    return this.mapWrittenEvent(calendar, remote)
  }

  // Online meeting fields are only sent to add a meeting, so unrelated edits never touch an existing one. The
  // body is only rewritten when the notes changed: Aerio reads bodyPreview, and rewriting the body would drop
  // the HTML (including Teams join details) it does not show.
  async updateEvent(calendar: SyncedCalendar, current: SyncedCalendarEvent, event: CalendarEvent) {
    this.assertWritable(calendar)
    const url = `${this.eventsUrl(calendar)}/${encodeURIComponent(current.remoteId)}`
    const meeting = await this.meetingPatch(calendar, `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(current.remoteId)}`, event, current.conference)
    const { body: content, ...fields } = microsoftEventBody(event, { instance: Boolean(current.seriesId) })
    const notesChanged = (current.description ?? '') !== (event.description ?? '')
    const remote = await retryingJson<GraphEvent>(this.provider, url, this.token, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...fields, ...(notesChanged ? { body: content } : {}), ...meeting })
    })
    return this.mapWrittenEvent(calendar, remote)
  }

  // Teams fields for a PATCH. Before adding a meeting the event is re-read, so one created by an earlier attempt
  // whose response was lost, or by another client, is kept rather than requested again.
  private async meetingPatch(calendar: SyncedCalendar, url: string, event: CalendarEvent, known?: CalendarEvent['conference']) {
    const write = conferenceWrite(event, known)
    if (write.kind === 'keep') return {}
    if (write.kind === 'remove') {
      assertConferenceRemovable({ ...calendar, conferences: calendar.conferences ?? microsoftConferenceSupport([], undefined, false) })
      return {}
    }
    assertConferenceCreatable(calendar, write.provider)
    const latest = await retryingJson<GraphEvent>(this.provider, `${url}?$select=${graphOnlineMeetingSelect}`, this.token)
    if (conferenceWrite(event, mapGraphConference(latest)).kind !== 'create') return {}
    return graphTeamsMeeting
  }

  // Applies an occurrence edit to the series master, or ends the master's range before the occurrence and
  // starts a new series from it ("this and following").
  async updateEventSeries(calendar: SyncedCalendar, current: SyncedCalendarEvent, event: CalendarEvent, scope: 'following' | 'series') {
    this.assertWritable(calendar)
    const { master, timing, split } = await this.seriesMaster(current)
    if (scope === 'following' && occurrenceKey(split) !== occurrenceKey(timing.start)) {
      const rule = parseRecurrenceRule(graphRecurrenceToRule(master.recurrence))
      if (!rule || !master.recurrence?.pattern) throw new Error('Microsoft did not return this series’ repeat pattern; synchronize and try again')
      const remaining = rule.count !== undefined ? Math.max(1, rule.count - occurrencesBefore({ ...timing, recurrenceRule: formatRecurrenceRule(rule) } as CalendarEvent, split)) : undefined
      await this.endSeriesBefore(master, timing, split)
      const successor = { ...event, seriesId: undefined, originalStart: undefined, recurrenceExceptions: undefined, recurrenceRule: formatRecurrenceRule({ ...rule, count: remaining }) }
      // Graph cannot copy a meeting to another event: a Teams master gives the new series its own Teams meeting.
      const write = conferenceWrite(event, mapGraphConference(master))
      if (write.kind === 'create') assertConferenceCreatable(calendar, write.provider)
      const teams = write.kind === 'create' || (write.kind === 'keep' && master.isOnlineMeeting && master.onlineMeetingProvider === 'teamsForBusiness')
      await retryingJson<GraphEvent>(this.provider, this.eventsUrl(calendar), this.token, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...microsoftEventBody(successor), ...(teams ? graphTeamsMeeting : {}) })
      })
      return
    }
    const shifted = shiftSeriesTiming(timing, split, event)
    const meeting = await this.meetingPatch(calendar, `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(master.id)}`, event, mapGraphConference(master))
    await this.patchMaster(master, { ...microsoftEventBody({ ...event, ...shifted, seriesId: undefined }, { instance: true }), ...meeting })
  }

  async deleteEventSeries(calendar: SyncedCalendar, current: SyncedCalendarEvent, scope: 'following' | 'series') {
    this.assertWritable(calendar)
    const { master, timing, split } = await this.seriesMaster(current)
    if (scope === 'following' && occurrenceKey(split) !== occurrenceKey(timing.start)) {
      if (!master.recurrence?.pattern) throw new Error('Microsoft did not return this series’ repeat pattern; synchronize and try again')
      await this.endSeriesBefore(master, timing, split)
      return
    }
    await retryingJson<void>(this.provider, `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(master.id)}`, this.token, { method: 'DELETE' })
  }

  private async seriesMaster(current: SyncedCalendarEvent) {
    if (!current.seriesId) throw new Error('This event is not part of a repeating series')
    const master = await retryingJson<GraphEvent>(this.provider, `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(current.seriesId)}`, this.token, { headers: { Prefer: 'outlook.timezone="UTC"' } })
    const mapped = master.start?.dateTime && master.end?.dateTime
      ? mapMicrosoftEvent(this.accountId, { id: current.calendarId, remoteId: '', accountId: this.accountId, provider: 'microsoft', name: '', color: '', primary: false, canWrite: true }, master)
      : undefined
    if (!mapped) throw new Error('Microsoft did not return valid series details')
    const timing = { start: mapped.start, end: mapped.end, allDay: mapped.allDay, timeZone: mapped.timeZone }
    return { master, timing, split: current.originalStart ?? current.start }
  }

  // Graph ranges end on a date in the series' zone: the day before the split occurrence.
  private async endSeriesBefore(master: GraphEvent, timing: { start: string; allDay?: boolean; timeZone?: string }, split: string) {
    const zone = timing.timeZone ?? resolveTimeZoneName(master.recurrence?.range?.recurrenceTimeZone) ?? 'UTC'
    const splitDate = /^\d{4}-\d{2}-\d{2}$/.test(split) ? split : isoDay(wallParts(split, zone).day)
    const range = { ...master.recurrence!.range, type: 'endDate', endDate: addDaysIso(splitDate, -1) }
    delete (range as { numberOfOccurrences?: number }).numberOfOccurrences
    await this.patchMaster(master, { recurrence: { pattern: master.recurrence!.pattern, range } })
  }

  private async patchMaster(master: GraphEvent, body: object) {
    await retryingJson<GraphEvent>(this.provider, `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(master.id)}`, this.token, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    })
  }

  async deleteEvent(calendar: SyncedCalendar, event: SyncedCalendarEvent) {
    this.assertWritable(calendar)
    await retryingJson<void>(this.provider, `${this.eventsUrl(calendar)}/${encodeURIComponent(event.remoteId)}`, this.token, { method: 'DELETE' })
  }

  // RSVP through Graph's accept/tentativelyAccept/decline actions with sendResponse=true. A proposed time is
  // only accepted on tentativelyAccept and decline, and only when the organizer allows new time proposals
  // (Graph then rejects the request, which is reported as is). `remoteId` may be a series master.
  async respondToEvent(calendar: SyncedCalendar, remoteId: string, input: EventResponseInput) {
    if (calendar.accountId !== this.accountId || calendar.provider !== this.provider || !this.calendarWriteAuthorized) {
      throw new Error('Reconnect this Microsoft account once to enable Calendar responses')
    }
    if (input.proposed && input.response === 'accepted') throw new Error('Microsoft accepts a proposed time only with a tentative or decline response')
    const action = input.response === 'accepted' ? 'accept' : input.response === 'tentative' ? 'tentativelyAccept' : 'decline'
    const url = `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(remoteId)}`
    const graphTime = (value: string) => ({ dateTime: new Date(value).toISOString().replace(/Z$/, ''), timeZone: 'UTC' })
    await retryingJson<void>(this.provider, `${url}/${action}`, this.token, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sendResponse: true,
        ...(input.comment?.trim() ? { comment: input.comment.trim().slice(0, 2_000) } : {}),
        ...(input.proposed ? { proposedNewTime: { start: graphTime(input.proposed.start), end: graphTime(input.proposed.end) } } : {})
      })
    })
    // A decline removes the meeting from the calendar; there is nothing left to read back.
    if (input.response === 'declined') return undefined
    const remote = await retryingJson<GraphEvent>(this.provider, url, this.token, { headers: { Prefer: 'outlook.timezone="UTC"' } })
    return mapMicrosoftEvent(this.accountId, calendar, remote)
  }

  async createContact(contact: Contact) {
    this.assertContactsWritable()
    const remote = await retryingJson<GraphContact>(this.provider, this.contactsUrl(), this.token, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(microsoftRichContactBody(contact))
    })
    return this.mapWrittenContact(remote)
  }

  async updateContact(current: SyncedContact, contact: Contact) {
    this.assertContactsWritable(current)
    await this.assertCurrentContactRevision(current)
    const remote = await retryingJson<GraphContact>(this.provider, `${this.contactsUrl()}/${encodeURIComponent(current.remoteId)}`, this.token, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(microsoftRichContactBody(contact, current))
    })
    return this.mapWrittenContact(remote)
  }

  async deleteContact(contact: SyncedContact) {
    this.assertContactsWritable(contact)
    await this.assertCurrentContactRevision(contact)
    await retryingJson<void>(this.provider, `${this.contactsUrl()}/${encodeURIComponent(contact.remoteId)}`, this.token, { method: 'DELETE' })
  }

  private eventsUrl(calendar: SyncedCalendar) {
    return `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendar.remoteId)}/events`
  }

  private assertWritable(calendar: SyncedCalendar) {
    if (calendar.accountId !== this.accountId || calendar.provider !== this.provider || !calendar.canWrite || !this.calendarWriteAuthorized) {
      throw new Error('Reconnect this Microsoft account once to enable Calendar editing')
    }
  }

  private mapWrittenEvent(calendar: SyncedCalendar, remote: GraphEvent) {
    const mapped = mapMicrosoftEvent(this.accountId, calendar, remote)
    if (!mapped) throw new Error('Microsoft saved the event but did not return valid event details')
    return mapped
  }

  private contactsUrl() {
    return 'https://graph.microsoft.com/v1.0/me/contacts'
  }

  private assertContactsWritable(contact?: SyncedContact) {
    if (!this.contactsWriteAuthorized || (contact && (contact.accountId !== this.accountId || contact.provider !== this.provider || contact.readOnly))) {
      throw new Error('Reconnect this Microsoft account once to enable Contacts editing')
    }
  }

  private async assertCurrentContactRevision(contact: SyncedContact) {
    if (!contact.revision) throw new Error('Synchronize Contacts before editing this Microsoft contact')
    const latest = await retryingJson<GraphContact>(this.provider, `${this.contactsUrl()}/${encodeURIComponent(contact.remoteId)}?$select=id,changeKey`, this.token)
    if (!latest.changeKey || latest.changeKey !== contact.revision) {
      throw new Error('This Microsoft contact changed elsewhere; synchronize Contacts and merge your changes')
    }
  }

  private mapWrittenContact(remote: GraphRichContact) {
    const mapped = mapMicrosoftRichContact(this.accountId, remote, false)
    if (!mapped) throw new Error('Microsoft saved the contact but did not return valid contact details')
    return mapped
  }

  private async pages<T>(initialUrl: string) {
    const items: T[] = []
    let url: string | undefined = initialUrl
    while (url) {
      const page: GraphPage<T> = await retryingJson(this.provider, url, this.token, { headers: { Prefer: 'outlook.timezone="UTC"' } })
      items.push(...page.value)
      url = page['@odata.nextLink']
    }
    return items
  }

  private async deltaPages<T>(initialUrl: string) {
    const items: T[] = []
    let url: string | undefined = initialUrl
    let checkpoint: string | undefined
    while (url) {
      const page: GraphPage<T> = await retryingJson(this.provider, url, this.token, { headers: { Prefer: 'outlook.timezone="UTC", odata.maxpagesize=1000' } })
      items.push(...page.value)
      checkpoint = page['@odata.deltaLink'] ?? checkpoint
      url = page['@odata.nextLink']
    }
    return { items, checkpoint }
  }
}

function graphColor(color?: string) {
  const colors: Record<string, string> = {
    auto: '#6558e8', lightBlue: '#3b82c4', lightGreen: '#4d8f78', lightOrange: '#b76a3c', lightGray: '#687080',
    lightYellow: '#9c7725', lightTeal: '#247d82', lightPink: '#a54f78', lightBrown: '#805b45', lightRed: '#b24752', maxColor: '#6558e8'
  }
  return colors[color ?? 'auto'] ?? '#6558e8'
}
