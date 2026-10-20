import { eventReminders } from '../../src/lib/event-reminders'
import type { CalendarEvent, Contact } from '../../src/types'
import type { ProviderProductivityData, ProviderProductivitySyncResult, SyncedCalendar, SyncedCalendarEvent, SyncedContact, SyncedContactGroup } from '../../src/productivity-types'
import { ProductivityApiError, retryingJson, type ProductivityConnector } from './connector'
import { eventRecurrenceRule, formatRecurrenceRule, isAllDayEvent, occurrenceKey, occurrencesBefore, parseRecurrenceRule, untilBefore } from '../../src/lib/recurrence'
import { shiftSeriesTiming } from '../../src/lib/recurrence-edit'
import { googleRecurrenceRule, replaceGoogleRecurrenceRule } from '../../src/lib/provider-recurrence'
import { isIanaTimeZone, resolveTimeZoneName, wallTimeInZone } from '../../src/lib/time-zones'
import { attendeeKey, eventAttendees, fromGoogleAttendee, googleResponseStatus, participant, toGoogleAttendee, withAttendees, type GoogleAttendee } from '../../src/lib/event-attendees'
import type { EventResponseInput } from '../../src/invitation-types'
import {
  attachGooglePhotos, googleContactGroupFields, googlePhotoBytes, googleRichContactBody, googleRichContactFields, googleUpdatePersonFields,
  mapGoogleContactGroup, mapGoogleRichContact, type GoogleContactGroup, type GoogleRichPerson
} from './google-contacts'
import { conferenceWrite } from '../../src/lib/online-meetings'
import {
  assertConferenceCreatable, assertConferenceRemovable, googleConferenceCopy, googleConferenceSupport, googleCreateRequest, googleEventIdForRequest,
  mapGoogleConference, type GoogleConferenceData
} from './online-meetings'

interface GooglePage<T> { items?: T[]; connections?: T[]; nextPageToken?: string; nextSyncToken?: string }
interface GoogleCalendar { defaultReminders?: { minutes?: number }[]; id: string; summary?: string; backgroundColor?: string; primary?: boolean; accessRole?: string; conferenceProperties?: { allowedConferenceSolutionTypes?: string[] } }
interface GoogleEvent {
  id: string
  status?: string
  summary?: string
  description?: string
  location?: string
  start?: { dateTime?: string; date?: string; timeZone?: string }
  end?: { dateTime?: string; date?: string; timeZone?: string }
  attendees?: GoogleAttendee[]
  organizer?: { email?: string; displayName?: string; self?: boolean }
  iCalUID?: string
  sequence?: number
  reminders?: { useDefault?: boolean; overrides?: { minutes?: number }[] }
  recurrence?: string[]
  recurringEventId?: string
  originalStartTime?: { dateTime?: string; date?: string; timeZone?: string }
  conferenceData?: GoogleConferenceData
  hangoutLink?: string
}
interface GooglePerson {
  resourceName: string
  metadata?: { deleted?: boolean; sources?: { type?: string; id?: string; etag?: string }[] }
  names?: { displayName?: string }[]
  emailAddresses?: { value?: string }[]
  phoneNumbers?: { value?: string }[]
  organizations?: { name?: string; title?: string }[]
  biographies?: { value?: string }[]
  memberships?: { contactGroupMembership?: { contactGroupResourceName?: string } }[]
}

// Single-value body kept for callers that only have the legacy fields; the connector writes
// googleRichContactBody (google-contacts.ts), which carries every value and raw provider details.
export const googleContactBody = (contact: Contact, revision?: string, remoteId?: string) => {
  const parts = contact.name.trim().split(/\s+/)
  const familyName = parts.length > 1 ? parts.pop() : undefined
  const givenName = parts.join(' ') || contact.name.trim()
  return {
    metadata: revision && remoteId ? { sources: [{ type: 'CONTACT', id: remoteId.split('/').at(-1), etag: revision }] } : undefined,
    names: [{ givenName, familyName }],
    emailAddresses: contact.email ? [{ value: contact.email }] : [],
    phoneNumbers: contact.phone ? [{ value: contact.phone }] : [],
    organizations: contact.company || contact.title ? [{ name: contact.company, title: contact.title }] : [],
    biographies: contact.notes ? [{ value: contact.notes, contentType: 'TEXT_PLAIN' }] : []
  }
}

const recurrence = (rules?: string[]) => {
  const frequency = rules?.find((rule) => rule.startsWith('RRULE:'))?.match(/FREQ=(DAILY|WEEKLY|MONTHLY)/)?.[1]?.toLowerCase()
  return frequency === 'daily' || frequency === 'weekly' || frequency === 'monthly' ? frequency : 'none'
}

const pad = (value: number) => String(value).padStart(2, '0')
const compactUtc = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')

// Google RRULE plus EXDATE lines for an Aerio series; EXDATEs use the event's zone like DTSTART does.
function googleRecurrenceLines(event: CalendarEvent) {
  const rule = eventRecurrenceRule(event)
  if (!rule) return undefined
  const lines = [`RRULE:${formatRecurrenceRule(rule)}`]
  const exceptions = event.recurrenceExceptions ?? []
  const dates = exceptions.filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))
  const times = exceptions.filter((value) => !/^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)))
  if (dates.length) lines.push(`EXDATE;VALUE=DATE:${dates.map((value) => value.replace(/-/g, '')).join(',')}`)
  if (times.length) {
    const zone = event.timeZone && isIanaTimeZone(event.timeZone) ? event.timeZone : undefined
    lines.push(zone
      ? `EXDATE;TZID=${zone}:${times.map((value) => {
        const wall = wallTimeInZone(Date.parse(value), zone)
        return `${wall.year}${pad(wall.month)}${pad(wall.day)}T${pad(wall.hour)}${pad(wall.minute)}${pad(wall.second)}`
      }).join(',')}`
      : `EXDATE:${times.map((value) => compactUtc(Date.parse(value))).join(',')}`)
  }
  return lines
}

// `instance` writes a single occurrence (or a master without touching its rule): Google rejects or would
// replace `recurrence` there, so it is omitted.
export const googleEventBody = (event: CalendarEvent, options: { instance?: boolean } = {}) => {
  const allDay = isAllDayEvent(event)
  const recurrence = options.instance || event.seriesId ? undefined : googleRecurrenceLines(event)
  // Recurring timed events need a named zone so occurrences keep their local time across DST.
  const timeZone = allDay ? undefined : event.timeZone && isIanaTimeZone(event.timeZone) ? event.timeZone : recurrence ? 'UTC' : undefined
  return {
    summary: event.title,
    description: event.description || undefined,
    location: event.location || undefined,
    start: allDay ? { date: event.start.slice(0, 10) } : { dateTime: event.start, timeZone },
    end: allDay ? { date: event.end.slice(0, 10) } : { dateTime: event.end, timeZone },
    attendees: eventAttendees(event).map(toGoogleAttendee),
    reminders: {
      useDefault: false,
      overrides: eventReminders(event).map((minutes) => ({ method: 'popup', minutes }))
    },
    recurrence
  }
}

export function mapGoogleEvent(accountId: string, calendar: SyncedCalendar, event: GoogleEvent): SyncedCalendarEvent | undefined {
  const start = event.start?.dateTime ?? event.start?.date
  const end = event.end?.dateTime ?? event.end?.date
  if (!start || !end || event.status === 'cancelled') return
  const details = (event.attendees ?? []).flatMap((attendee) => fromGoogleAttendee(attendee) ?? [])
  const organizer = participant(event.organizer?.email, event.organizer?.displayName, event.organizer?.self)
  const conference = mapGoogleConference(event.conferenceData, event.hangoutLink)
  return withAttendees({
    id: `${accountId}:google-event:${calendar.remoteId}:${event.id}`,
    remoteId: event.id,
    accountId,
    provider: 'gmail',
    calendarId: calendar.id,
    title: event.summary?.trim() || '(Untitled event)',
    start,
    end,
    location: event.location,
    description: event.description,
    color: calendar.color,
    attendees: (event.attendees ?? []).flatMap((attendee) => attendee.email ? [attendee.email] : []),
    reminderMinutes: event.reminders?.overrides?.[0]?.minutes ?? calendar.defaultEventReminders?.[0] ?? 30,
    reminders: event.reminders?.useDefault === false ? [...new Set((event.reminders.overrides ?? []).flatMap((item) => Number.isInteger(item.minutes) && item.minutes! >= 0 && item.minutes! <= 40_320 ? [item.minutes!] : []))].slice(0, 5) : calendar.defaultEventReminders,
    recurrence: recurrence(event.recurrence),
    readOnly: !calendar.canWrite,
    ...(event.start?.date ? { allDay: true } : {}),
    ...(resolveTimeZoneName(event.start?.timeZone) ? { timeZone: resolveTimeZoneName(event.start?.timeZone) } : {}),
    ...(googleRecurrenceRule(event.recurrence) ? { recurrenceRule: googleRecurrenceRule(event.recurrence) } : {}),
    ...(event.recurringEventId ? { seriesId: event.recurringEventId } : {}),
    ...(event.originalStartTime?.dateTime ?? event.originalStartTime?.date ? { originalStart: event.originalStartTime?.dateTime ?? event.originalStartTime?.date } : {}),
    ...(organizer ? { organizer } : {}),
    ...(event.iCalUID ? { icalUid: event.iCalUID } : {}),
    ...(Number.isInteger(event.sequence) ? { sequence: event.sequence } : {}),
    ...(conference ? { conference } : {})
  } satisfies SyncedCalendarEvent, details)
}

// Meetings with guests tell them about changes (sendUpdates=all); events without guests keep the default.
const notifyAttendees = (separator: '?' | '&', ...events: Pick<CalendarEvent, 'attendees'>[]) =>
  events.some((event) => event.attendees.length) ? `${separator}sendUpdates=all` : ''

// Synced feeds use singleEvents=true, so a stored series master (returned by a write) is replaced by its
// instances on the next sync instead of being kept alongside them.
const isStoredMaster = (event: SyncedCalendarEvent) => Boolean(event.recurrenceRule && !event.seriesId)

export function mapGoogleContact(accountId: string, person: GooglePerson, readOnly = false): SyncedContact | undefined {
  const name = person.names?.[0]?.displayName?.trim()
  if (!name) return
  const groupResource = person.memberships?.map((membership) => membership.contactGroupMembership?.contactGroupResourceName).find(Boolean)
  const source = person.metadata?.sources?.find((item) => item.type === 'CONTACT')
  return {
    id: `${accountId}:google-contact:${person.resourceName}`,
    remoteId: person.resourceName,
    accountId,
    provider: 'gmail',
    revision: source?.etag,
    sourceId: source?.id,
    name,
    email: person.emailAddresses?.[0]?.value ?? '',
    phone: person.phoneNumbers?.[0]?.value,
    company: person.organizations?.[0]?.name,
    title: person.organizations?.[0]?.title,
    group: groupResource?.split('/').at(-1) ?? 'Google',
    notes: person.biographies?.[0]?.value,
    favorite: groupResource === 'contactGroups/starred',
    color: '#4d8f78',
    readOnly
  }
}

export class GoogleProductivityConnector implements ProductivityConnector {
  readonly provider = 'gmail' as const

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
    const calendarItems = await this.pages<GoogleCalendar>('https://www.googleapis.com/calendar/v3/users/me/calendarList', 'items')
    const calendars: SyncedCalendar[] = calendarItems.map((calendar) => ({
      id: `${this.accountId}:google-calendar:${calendar.id}`,
      remoteId: calendar.id,
      accountId: this.accountId,
      provider: 'gmail',
      name: calendar.summary?.trim() || 'Calendar',
      color: calendar.backgroundColor ?? '#6558e8',
      primary: Boolean(calendar.primary),
      defaultEventReminders: [...new Set((calendar.defaultReminders ?? []).flatMap((item) => Number.isInteger(item.minutes) && item.minutes! >= 0 && item.minutes! <= 40_320 ? [item.minutes!] : []))].slice(0, 5),
      canWrite: this.calendarWriteAuthorized && (calendar.accessRole === 'owner' || calendar.accessRole === 'writer'),
      conferences: googleConferenceSupport(calendar.conferenceProperties?.allowedConferenceSolutionTypes, this.calendarWriteAuthorized && (calendar.accessRole === 'owner' || calendar.accessRole === 'writer'))
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
    return { calendars, events, contacts: contactSync.items, contactGroups: contactSync.groups, checkpoints: nextCheckpoints }
  }

  private async syncEvents(calendar: SyncedCalendar, previous: SyncedCalendarEvent[], checkpoint: string | undefined, from: Date, to: Date) {
    const run = async (syncToken?: string) => {
      const query = new URLSearchParams({ singleEvents: 'true', showDeleted: 'true', maxResults: '2500' })
      if (syncToken) query.set('syncToken', syncToken)
      else {
        query.set('timeMin', from.toISOString())
        query.set('timeMax', to.toISOString())
      }
      const delta = await this.pagesWithCheckpoint<GoogleEvent>(`${this.eventsUrl(calendar)}?${query}`, 'items')
      const current = syncToken ? new Map(previous.filter((event) => event.calendarId === calendar.id && !isStoredMaster(event)).map((event) => [event.id, event])) : new Map<string, SyncedCalendarEvent>()
      for (const event of delta.items) {
        const id = `${this.accountId}:google-event:${calendar.remoteId}:${event.id}`
        const mapped = mapGoogleEvent(this.accountId, calendar, event)
        if (mapped) current.set(id, mapped)
        else if (event.status === 'cancelled') current.delete(id)
      }
      return { items: [...current.values()], checkpoint: delta.checkpoint }
    }
    try {
      return await run(checkpoint)
    } catch (error) {
      if (!checkpoint || !(error instanceof ProductivityApiError) || error.status !== 410) throw error
      return run()
    }
  }

  private async syncContacts(previous: SyncedContact[], checkpoint?: string) {
    const groups = await this.listContactGroups()
    this.useContactGroups(groups)
    const run = async (syncToken?: string) => {
      const query = new URLSearchParams({ personFields: googleRichContactFields, pageSize: '1000', requestSyncToken: 'true' })
      if (syncToken) query.set('syncToken', syncToken)
      const delta = await this.pagesWithCheckpoint<GoogleRichPerson>(`https://people.googleapis.com/v1/people/me/connections?${query}`, 'connections')
      const current = syncToken ? new Map(previous.map((contact) => [contact.sourceId ?? contact.remoteId, contact])) : new Map<string, SyncedContact>()
      for (const person of delta.items) {
        const sourceId = person.metadata?.sources?.find((source) => source.type === 'CONTACT')?.id ?? person.resourceName
        if (person.metadata?.deleted) {
          current.delete(sourceId)
          continue
        }
        const mapped = mapGoogleRichContact(this.accountId, person, !this.contactsWriteAuthorized, this.groupNames)
        if (mapped) current.set(sourceId, mapped)
      }
      // Group names can change without the member records changing; re-resolve cached contacts.
      const items = [...current.values()].map((contact) => {
        const names = (contact.groupIds ?? []).flatMap((id) => this.groupNames.get(id) ?? [])
        const { groups: _previousGroups, ...rest } = contact
        return { ...rest, ...(names.length ? { groups: names } : {}), group: names[0] ?? 'Google' }
      })
      return { items: await attachGooglePhotos(items, previous), checkpoint: delta.checkpoint, groups }
    }
    try {
      return await run(checkpoint)
    } catch (error) {
      if (!checkpoint || !(error instanceof ProductivityApiError) || (error.status !== 400 && error.status !== 410)) throw error
      return run()
    }
  }

  // Every event write sends conferenceDataVersion=1: without it Google ignores conferenceData in the body, and
  // writes that omit conferenceData keep the event's existing conference.
  async createEvent(calendar: SyncedCalendar, event: CalendarEvent) {
    this.assertWritable(calendar)
    const write = conferenceWrite(event)
    if (write.kind === 'create') assertConferenceCreatable(calendar, write.provider)
    const id = write.kind === 'create' ? googleEventIdForRequest(write.requestId) : undefined
    const body = { ...googleEventBody(event), ...(write.kind === 'create' ? { id, conferenceData: googleCreateRequest(write.requestId) } : {}) }
    try {
      const remote = await retryingJson<GoogleEvent>(this.provider, `${this.eventsUrl(calendar)}?conferenceDataVersion=1${notifyAttendees('&', event)}`, this.token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      return this.mapWrittenEvent(calendar, remote)
    } catch (error) {
      // The insert was retried after an attempt that reached Google: reuse that event rather than add another.
      if (!id || write.kind !== 'create' || !(error instanceof ProductivityApiError) || error.status !== 409) throw error
      const url = `${this.eventsUrl(calendar)}/${encodeURIComponent(id)}`
      const existing = await retryingJson<GoogleEvent>(this.provider, url, this.token)
      if (existing.status === 'cancelled') throw new Error('This meeting request was already used by a deleted event; add the meeting again')
      if (mapGoogleConference(existing.conferenceData, existing.hangoutLink)) return this.mapWrittenEvent(calendar, existing)
      const patched = await retryingJson<GoogleEvent>(this.provider, `${url}?conferenceDataVersion=1`, this.token, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conferenceData: googleCreateRequest(write.requestId) })
      })
      return this.mapWrittenEvent(calendar, patched)
    }
  }

  async updateEvent(calendar: SyncedCalendar, current: SyncedCalendarEvent, event: CalendarEvent) {
    this.assertWritable(calendar)
    const url = `${this.eventsUrl(calendar)}/${encodeURIComponent(current.remoteId)}`
    const conference = await this.conferencePatch(calendar, url, event, current.conference)
    const remote = await retryingJson<GoogleEvent>(this.provider, `${url}?conferenceDataVersion=1${notifyAttendees('&', event, current)}`, this.token, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...googleEventBody(event, { instance: Boolean(current.seriesId) }), ...conference })
    })
    return this.mapWrittenEvent(calendar, remote)
  }

  // conferenceData for a PATCH: omitted (Google keeps the current conference), a createRequest, or null to
  // detach it. Before creating, the event is re-read so a conference added by an earlier attempt whose response
  // was lost, or by another client, is kept instead of replaced.
  private async conferencePatch(calendar: SyncedCalendar, url: string, event: CalendarEvent, known?: CalendarEvent['conference']) {
    const write = conferenceWrite(event, known)
    if (write.kind === 'keep') return {}
    if (write.kind === 'remove') {
      assertConferenceRemovable(calendar)
      return { conferenceData: null }
    }
    assertConferenceCreatable(calendar, write.provider)
    const latest = await retryingJson<GoogleEvent>(this.provider, url, this.token)
    if (conferenceWrite(event, mapGoogleConference(latest.conferenceData, latest.hangoutLink)).kind !== 'create') return {}
    return { conferenceData: googleCreateRequest(write.requestId) }
  }

  // Applies an occurrence edit to the whole series, or splits the series at the occurrence ("this and
  // following"): the master's RRULE ends before it and a new series starts from the edited occurrence.
  async updateEventSeries(calendar: SyncedCalendar, current: SyncedCalendarEvent, event: CalendarEvent, scope: 'following' | 'series') {
    this.assertWritable(calendar)
    const { master, timing, split } = await this.seriesMaster(calendar, current)
    if (scope === 'following' && occurrenceKey(split) !== occurrenceKey(timing.start)) {
      const rule = parseRecurrenceRule(googleRecurrenceRule(master.recurrence))
      if (!rule) throw new Error('Google did not return this series’ repeat rule; synchronize and try again')
      const remaining = rule.count !== undefined ? Math.max(1, rule.count - occurrencesBefore({ ...timing, recurrenceRule: formatRecurrenceRule(rule) } as CalendarEvent, split)) : undefined
      await this.patchMaster(calendar, master, { recurrence: replaceGoogleRecurrenceRule(master.recurrence, formatRecurrenceRule({ ...rule, count: undefined, until: untilBefore(split, isAllDayEvent(timing as CalendarEvent)) })) })
      const successor = { ...event, seriesId: undefined, originalStart: undefined, recurrenceExceptions: undefined, recurrenceRule: formatRecurrenceRule({ ...rule, count: remaining }) }
      // The new series keeps the master's meeting (copied with conferenceDataVersion=1) unless it was removed.
      const write = conferenceWrite(event, mapGoogleConference(master.conferenceData, master.hangoutLink))
      if (write.kind === 'create') assertConferenceCreatable(calendar, write.provider)
      const conferenceData = write.kind === 'create' ? googleCreateRequest(write.requestId) : write.kind === 'remove' ? undefined : googleConferenceCopy(master.conferenceData)
      await retryingJson<GoogleEvent>(this.provider, `${this.eventsUrl(calendar)}?conferenceDataVersion=1`, this.token, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...googleEventBody(successor), ...(conferenceData ? { conferenceData } : {}) })
      })
      return
    }
    const shifted = shiftSeriesTiming(timing, split, event)
    const conference = await this.conferencePatch(calendar, `${this.eventsUrl(calendar)}/${encodeURIComponent(master.id)}`, event, mapGoogleConference(master.conferenceData, master.hangoutLink))
    await this.patchMaster(calendar, master, { ...googleEventBody({ ...event, ...shifted, seriesId: undefined }, { instance: true }), ...conference })
  }

  async deleteEventSeries(calendar: SyncedCalendar, current: SyncedCalendarEvent, scope: 'following' | 'series') {
    this.assertWritable(calendar)
    const { master, timing, split } = await this.seriesMaster(calendar, current)
    if (scope === 'following' && occurrenceKey(split) !== occurrenceKey(timing.start)) {
      const rule = parseRecurrenceRule(googleRecurrenceRule(master.recurrence))
      if (!rule) throw new Error('Google did not return this series’ repeat rule; synchronize and try again')
      await this.patchMaster(calendar, master, { recurrence: replaceGoogleRecurrenceRule(master.recurrence, formatRecurrenceRule({ ...rule, count: undefined, until: untilBefore(split, isAllDayEvent(timing as CalendarEvent)) })) })
      return
    }
    await retryingJson<void>(this.provider, `${this.eventsUrl(calendar)}/${encodeURIComponent(master.id)}`, this.token, { method: 'DELETE' })
  }

  private async seriesMaster(calendar: SyncedCalendar, current: SyncedCalendarEvent) {
    if (!current.seriesId) throw new Error('This event is not part of a repeating series')
    const master = await retryingJson<GoogleEvent>(this.provider, `${this.eventsUrl(calendar)}/${encodeURIComponent(current.seriesId)}`, this.token)
    const start = master.start?.dateTime ?? master.start?.date
    const end = master.end?.dateTime ?? master.end?.date
    if (!start || !end) throw new Error('Google did not return valid series details')
    const timing = { start, end, ...(master.start?.date ? { allDay: true } : {}), timeZone: resolveTimeZoneName(master.start?.timeZone) }
    return { master, timing, split: current.originalStart ?? current.start }
  }

  private async patchMaster(calendar: SyncedCalendar, master: GoogleEvent, body: object) {
    await retryingJson<GoogleEvent>(this.provider, `${this.eventsUrl(calendar)}/${encodeURIComponent(master.id)}?conferenceDataVersion=1`, this.token, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    })
  }

  async deleteEvent(calendar: SyncedCalendar, event: SyncedCalendarEvent) {
    this.assertWritable(calendar)
    await retryingJson<void>(this.provider, `${this.eventsUrl(calendar)}/${encodeURIComponent(event.remoteId)}${notifyAttendees('?', event)}`, this.token, { method: 'DELETE' })
  }

  // RSVP as an attendee: events.patch with the full attendee list (Google replaces the array) where only
  // this account's entry changes, and sendUpdates=all so the organizer is told. `remoteId` is the series
  // master to answer every occurrence, or one instance id. Google's API cannot propose a new time.
  async respondToEvent(calendar: SyncedCalendar, remoteId: string, selfEmails: readonly string[], input: EventResponseInput) {
    if (calendar.accountId !== this.accountId || calendar.provider !== this.provider || !this.calendarWriteAuthorized) {
      throw new Error('Reconnect this Google account once to enable Calendar responses')
    }
    if (input.proposed) throw new Error('Google Calendar does not accept proposed times through its API; propose a new time in Google Calendar instead')
    const url = `${this.eventsUrl(calendar)}/${encodeURIComponent(remoteId)}`
    const remote = await retryingJson<GoogleEvent>(this.provider, url, this.token)
    const keys = new Set(selfEmails.map(attendeeKey))
    const attendees = remote.attendees ?? []
    const index = attendees.findIndex((attendee) => attendee.self) >= 0
      ? attendees.findIndex((attendee) => attendee.self)
      : attendees.findIndex((attendee) => attendee.email && keys.has(attendeeKey(attendee.email)))
    if (index < 0) throw new Error('You are not on this meeting’s guest list in Google Calendar, so Google cannot record a response')
    const next = attendees.map((attendee, position) => position === index
      ? { ...attendee, responseStatus: googleResponseStatus(input.response), ...(input.comment?.trim() ? { comment: input.comment.trim().slice(0, 2_000) } : {}) }
      : attendee)
    const saved = await retryingJson<GoogleEvent>(this.provider, `${url}?sendUpdates=all`, this.token, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ attendees: next })
    })
    return mapGoogleEvent(this.accountId, calendar, saved)
  }

  async createContact(contact: Contact) {
    this.assertContactsWritable()
    const remote = await retryingJson<GoogleRichPerson>(this.provider, `https://people.googleapis.com/v1/people:createContact?personFields=${googleRichContactFields}`, this.token, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(googleRichContactBody(contact))
    })
    return this.writeContactPhoto(this.mapWrittenContact(remote), contact)
  }

  async updateContact(current: SyncedContact, contact: Contact) {
    this.assertContactsWritable(current)
    const resource = this.contactResource(current.remoteId)
    // A freshly fetched revision does not describe the contents of the open editor.
    // Require a refresh instead of allowing a stale edit to overwrite newer data.
    const revision = current.revision
    if (!revision) throw new Error('Google did not return a contact revision; synchronize Contacts before editing again')
    const query = new URLSearchParams({ updatePersonFields: googleUpdatePersonFields, personFields: googleRichContactFields })
    const remote = await retryingJson<GoogleRichPerson>(this.provider, `${resource}:updateContact?${query}`, this.token, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(googleRichContactBody(contact, current))
    }).catch((error: unknown) => { throw googleConflict(error, 'contact') })
    return this.writeContactPhoto(this.mapWrittenContact(remote), contact, current)
  }

  // contactGroups resource names mapped to display names, used when mapping written contacts.
  private groupNames = new Map<string, string>()

  useContactGroups(groups: SyncedContactGroup[]) {
    this.groupNames = new Map(groups.map((group) => [group.remoteId, group.name]))
  }

  async listContactGroups() {
    const groups: SyncedContactGroup[] = []
    let pageToken: string | undefined
    try {
      do {
        const query = new URLSearchParams({ pageSize: '1000', groupFields: googleContactGroupFields })
        if (pageToken) query.set('pageToken', pageToken)
        const page = await retryingJson<{ contactGroups?: GoogleContactGroup[]; nextPageToken?: string }>(this.provider, `https://people.googleapis.com/v1/contactGroups?${query}`, this.token)
        groups.push(...(page.contactGroups ?? []).flatMap((group) => mapGoogleContactGroup(this.accountId, group, this.contactsWriteAuthorized) ?? []))
        pageToken = page.nextPageToken
      } while (pageToken)
    } catch (error) {
      // Contacts still synchronize when groups are unavailable; they just carry no group names.
      if (!(error instanceof ProductivityApiError)) throw error
      return []
    }
    return groups
  }

  async createContactGroup(name: string) {
    this.assertContactsWritable()
    const remote = await retryingJson<GoogleContactGroup>(this.provider, 'https://people.googleapis.com/v1/contactGroups', this.token, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contactGroup: { name: name.trim() }, readGroupFields: googleContactGroupFields })
    })
    return this.mapWrittenGroup(remote)
  }

  async renameContactGroup(group: SyncedContactGroup, name: string) {
    this.assertGroupManageable(group)
    const remote = await retryingJson<GoogleContactGroup>(this.provider, this.contactResource(group.remoteId), this.token, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contactGroup: { name: name.trim(), etag: group.revision }, updateGroupFields: 'name', readGroupFields: googleContactGroupFields })
    }).catch((error: unknown) => { throw googleConflict(error, 'group') })
    return this.mapWrittenGroup(remote)
  }

  async deleteContactGroup(group: SyncedContactGroup) {
    this.assertGroupManageable(group)
    // Members stay in Google Contacts; only the group is removed.
    await retryingJson<void>(this.provider, `${this.contactResource(group.remoteId)}?deleteContacts=false`, this.token, { method: 'DELETE' })
  }

  // Adds and removes members, then re-reads the affected people: membership changes bump their etags.
  async modifyContactGroupMembers(group: SyncedContactGroup, add: SyncedContact[], remove: SyncedContact[]) {
    if (!this.contactsWriteAuthorized || group.readOnly || group.accountId !== this.accountId || group.provider !== this.provider) {
      throw new Error('Reconnect this Google account once to enable Contacts editing')
    }
    for (const contact of [...add, ...remove]) this.assertContactsWritable(contact)
    const result = await retryingJson<{ notFoundResourceNames?: string[]; canNotRemoveLastContactGroupResourceNames?: string[] } | undefined>(
      this.provider, `${this.contactResource(group.remoteId)}/members:modify`, this.token, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resourceNamesToAdd: add.map((contact) => contact.remoteId), resourceNamesToRemove: remove.map((contact) => contact.remoteId) })
      })
    const previous = [...add, ...remove]
    const refreshed: SyncedContact[] = []
    for (let index = 0; index < previous.length; index += 200) {
      const query = new URLSearchParams({ personFields: googleRichContactFields })
      for (const contact of previous.slice(index, index + 200)) query.append('resourceNames', contact.remoteId)
      const page = await retryingJson<{ responses?: { person?: GoogleRichPerson }[] }>(this.provider, `https://people.googleapis.com/v1/people:batchGet?${query}`, this.token)
      for (const response of page.responses ?? []) {
        const mapped = response.person && mapGoogleRichContact(this.accountId, response.person, false, this.groupNames)
        if (mapped) refreshed.push(mapped)
      }
    }
    return {
      contacts: await attachGooglePhotos(refreshed, previous),
      skipped: (result?.notFoundResourceNames?.length ?? 0) + (result?.canNotRemoveLastContactGroupResourceNames?.length ?? 0)
    }
  }

  private assertGroupManageable(group: SyncedContactGroup) {
    if (group.system) throw new Error('Google system groups cannot be renamed or deleted')
    if (!this.contactsWriteAuthorized || group.readOnly || group.accountId !== this.accountId || group.provider !== this.provider) {
      throw new Error('Reconnect this Google account once to enable Contacts editing')
    }
  }

  private mapWrittenGroup(remote: GoogleContactGroup) {
    const mapped = mapGoogleContactGroup(this.accountId, remote, true)
    if (!mapped) throw new Error('Google saved the group but did not return valid group details')
    this.groupNames.set(mapped.remoteId, mapped.name)
    return mapped
  }

  // Photos have their own endpoints; a failed photo write keeps the saved contact details.
  private async writeContactPhoto(saved: SyncedContact, contact: Contact, current?: SyncedContact): Promise<SyncedContact> {
    if ((contact.photo ?? '') === (current?.photo ?? '')) return current?.photo ? { ...saved, photo: current.photo } : saved
    const resource = this.contactResource(saved.remoteId)
    const bytes = googlePhotoBytes(contact.photo)
    try {
      if (bytes) {
        await retryingJson(this.provider, `${resource}:updateContactPhoto`, this.token, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ photoBytes: bytes, personFields: 'metadata' })
        })
        return { ...saved, photo: contact.photo }
      }
      await retryingJson<void>(this.provider, `${resource}:deleteContactPhoto`, this.token, { method: 'DELETE' })
      const { photo: _removed, ...rest } = saved
      return rest
    } catch {
      return current?.photo ? { ...saved, photo: current.photo } : saved
    }
  }

  async deleteContact(contact: SyncedContact) {
    this.assertContactsWritable(contact)
    await retryingJson<void>(this.provider, `${this.contactResource(contact.remoteId)}:deleteContact`, this.token, { method: 'DELETE' })
  }

  private eventsUrl(calendar: SyncedCalendar) {
    return `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar.remoteId)}/events`
  }

  private assertWritable(calendar: SyncedCalendar) {
    if (calendar.accountId !== this.accountId || calendar.provider !== this.provider || !calendar.canWrite || !this.calendarWriteAuthorized) {
      throw new Error('Reconnect this Google account once to enable Calendar editing')
    }
  }

  private mapWrittenEvent(calendar: SyncedCalendar, remote: GoogleEvent) {
    const mapped = mapGoogleEvent(this.accountId, calendar, remote)
    if (!mapped) throw new Error('Google saved the event but did not return valid event details')
    return mapped
  }

  private assertContactsWritable(contact?: SyncedContact) {
    if (!this.contactsWriteAuthorized || (contact && (contact.accountId !== this.accountId || contact.provider !== this.provider || contact.readOnly))) {
      throw new Error('Reconnect this Google account once to enable Contacts editing')
    }
  }

  private contactResource(remoteId: string) {
    return `https://people.googleapis.com/v1/${remoteId.split('/').map(encodeURIComponent).join('/')}`
  }

  private mapWrittenContact(remote: GoogleRichPerson) {
    const mapped = mapGoogleRichContact(this.accountId, remote, false, this.groupNames)
    if (!mapped) throw new Error('Google saved the contact but did not return valid contact details')
    return mapped
  }

  private async pages<T>(initialUrl: string, field: 'items' | 'connections') {
    return (await this.pagesWithCheckpoint<T>(initialUrl, field)).items
  }

  private async pagesWithCheckpoint<T>(initialUrl: string, field: 'items' | 'connections') {
    const items: T[] = []
    let url: string | undefined = initialUrl
    let checkpoint: string | undefined
    while (url) {
      const page: GooglePage<T> = await retryingJson(this.provider, url, this.token)
      items.push(...(page[field] ?? []))
      checkpoint = page.nextSyncToken ?? checkpoint
      if (!page.nextPageToken) break
      const next = new URL(initialUrl)
      next.searchParams.set('pageToken', page.nextPageToken)
      url = next.toString()
    }
    return { items, checkpoint }
  }
}

// The People API reports a stale etag as 400 FAILED_PRECONDITION (409 on some group writes).
function googleConflict(error: unknown, record: 'contact' | 'group') {
  if (error instanceof ProductivityApiError && (error.status === 409 || (error.status === 400 && /etag|precondition|changed/i.test(error.message)))) {
    return new Error(`This Google ${record} changed elsewhere; synchronize Contacts and merge your changes`)
  }
  return error
}
