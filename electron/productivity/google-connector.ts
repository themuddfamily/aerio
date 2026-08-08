import type { CalendarEvent, Contact } from '../../src/types'
import type { ProviderProductivityData, SyncedCalendar, SyncedCalendarEvent, SyncedContact } from '../../src/productivity-types'
import { retryingJson, type ProductivityConnector } from './connector'

interface GooglePage<T> { items?: T[]; connections?: T[]; nextPageToken?: string }
interface GoogleCalendar { id: string; summary?: string; backgroundColor?: string; primary?: boolean; accessRole?: string }
interface GoogleEvent {
  id: string
  status?: string
  summary?: string
  description?: string
  location?: string
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
  attendees?: { email?: string }[]
  reminders?: { useDefault?: boolean; overrides?: { minutes?: number }[] }
  recurrence?: string[]
}
interface GooglePerson {
  resourceName: string
  metadata?: { sources?: { type?: string; id?: string; etag?: string }[] }
  names?: { displayName?: string }[]
  emailAddresses?: { value?: string }[]
  phoneNumbers?: { value?: string }[]
  organizations?: { name?: string; title?: string }[]
  biographies?: { value?: string }[]
  memberships?: { contactGroupMembership?: { contactGroupResourceName?: string } }[]
}

const googleContactFields = 'names,emailAddresses,phoneNumbers,organizations,biographies,memberships,metadata'

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

export const googleEventBody = (event: CalendarEvent) => {
  const repeat = event.recurrence ?? 'none'
  return {
    summary: event.title,
    description: event.description || undefined,
    location: event.location || undefined,
    start: { dateTime: event.start },
    end: { dateTime: event.end },
    attendees: event.attendees.map((email) => ({ email })),
    reminders: {
      useDefault: false,
      overrides: [{ method: 'popup', minutes: event.reminderMinutes }]
    },
    recurrence: repeat === 'none' ? undefined : [`RRULE:FREQ=${repeat.toUpperCase()}`]
  }
}

export function mapGoogleEvent(accountId: string, calendar: SyncedCalendar, event: GoogleEvent): SyncedCalendarEvent | undefined {
  const start = event.start?.dateTime ?? event.start?.date
  const end = event.end?.dateTime ?? event.end?.date
  if (!start || !end || event.status === 'cancelled') return
  return {
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
    reminderMinutes: event.reminders?.overrides?.[0]?.minutes ?? 30,
    recurrence: recurrence(event.recurrence),
    readOnly: !calendar.canWrite
  }
}

export function mapGoogleContact(accountId: string, person: GooglePerson, readOnly = false): SyncedContact | undefined {
  const name = person.names?.[0]?.displayName?.trim()
  if (!name) return
  const groupResource = person.memberships?.map((membership) => membership.contactGroupMembership?.contactGroupResourceName).find(Boolean)
  return {
    id: `${accountId}:google-contact:${person.resourceName}`,
    remoteId: person.resourceName,
    accountId,
    provider: 'gmail',
    revision: person.metadata?.sources?.find((source) => source.type === 'CONTACT')?.etag,
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

  async sync(): Promise<ProviderProductivityData> {
    const calendarItems = await this.pages<GoogleCalendar>('https://www.googleapis.com/calendar/v3/users/me/calendarList', 'items')
    const calendars: SyncedCalendar[] = calendarItems.map((calendar) => ({
      id: `${this.accountId}:google-calendar:${calendar.id}`,
      remoteId: calendar.id,
      accountId: this.accountId,
      provider: 'gmail',
      name: calendar.summary?.trim() || 'Calendar',
      color: calendar.backgroundColor ?? '#6558e8',
      primary: Boolean(calendar.primary),
      canWrite: this.calendarWriteAuthorized && (calendar.accessRole === 'owner' || calendar.accessRole === 'writer')
    }))
    const from = new Date(); from.setUTCFullYear(from.getUTCFullYear() - 1)
    const to = new Date(); to.setUTCFullYear(to.getUTCFullYear() + 2)
    const events: SyncedCalendarEvent[] = []
    for (const calendar of calendars) {
      const query = new URLSearchParams({ singleEvents: 'true', showDeleted: 'false', maxResults: '2500', timeMin: from.toISOString(), timeMax: to.toISOString() })
      const remoteEvents = await this.pages<GoogleEvent>(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar.remoteId)}/events?${query}`, 'items')
      events.push(...remoteEvents.flatMap((event) => {
        const mapped = mapGoogleEvent(this.accountId, calendar, event)
        return mapped ? [mapped] : []
      }))
    }
    const people = await this.pages<GooglePerson>(`https://people.googleapis.com/v1/people/me/connections?personFields=${googleContactFields}&pageSize=1000`, 'connections')
    return { calendars, events, contacts: people.flatMap((person) => { const mapped = mapGoogleContact(this.accountId, person, !this.contactsWriteAuthorized); return mapped ? [mapped] : [] }) }
  }

  async createEvent(calendar: SyncedCalendar, event: CalendarEvent) {
    this.assertWritable(calendar)
    const remote = await retryingJson<GoogleEvent>(this.provider, this.eventsUrl(calendar), this.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(googleEventBody(event))
    })
    return this.mapWrittenEvent(calendar, remote)
  }

  async updateEvent(calendar: SyncedCalendar, current: SyncedCalendarEvent, event: CalendarEvent) {
    this.assertWritable(calendar)
    const remote = await retryingJson<GoogleEvent>(this.provider, `${this.eventsUrl(calendar)}/${encodeURIComponent(current.remoteId)}`, this.token, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(googleEventBody(event))
    })
    return this.mapWrittenEvent(calendar, remote)
  }

  async deleteEvent(calendar: SyncedCalendar, event: SyncedCalendarEvent) {
    this.assertWritable(calendar)
    await retryingJson<void>(this.provider, `${this.eventsUrl(calendar)}/${encodeURIComponent(event.remoteId)}`, this.token, { method: 'DELETE' })
  }

  async createContact(contact: Contact) {
    this.assertContactsWritable()
    const remote = await retryingJson<GooglePerson>(this.provider, `https://people.googleapis.com/v1/people:createContact?personFields=${googleContactFields}`, this.token, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(googleContactBody(contact))
    })
    return this.mapWrittenContact(remote)
  }

  async updateContact(current: SyncedContact, contact: Contact) {
    this.assertContactsWritable(current)
    const resource = this.contactResource(current.remoteId)
    const revision = current.revision ?? (await retryingJson<GooglePerson>(this.provider, `${resource}?personFields=${googleContactFields}`, this.token))
      .metadata?.sources?.find((source) => source.type === 'CONTACT')?.etag
    if (!revision) throw new Error('Google did not return a contact revision; synchronize Contacts before editing again')
    const query = new URLSearchParams({ updatePersonFields: 'names,emailAddresses,phoneNumbers,organizations,biographies', personFields: googleContactFields })
    const remote = await retryingJson<GooglePerson>(this.provider, `${resource}:updateContact?${query}`, this.token, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(googleContactBody(contact, revision, current.remoteId))
    })
    return this.mapWrittenContact(remote)
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

  private mapWrittenContact(remote: GooglePerson) {
    const mapped = mapGoogleContact(this.accountId, remote, false)
    if (!mapped) throw new Error('Google saved the contact but did not return valid contact details')
    return mapped
  }

  private async pages<T>(initialUrl: string, field: 'items' | 'connections') {
    const items: T[] = []
    let url: string | undefined = initialUrl
    while (url) {
      const page: GooglePage<T> = await retryingJson(this.provider, url, this.token)
      items.push(...(page[field] ?? []))
      if (!page.nextPageToken) break
      const next = new URL(initialUrl)
      next.searchParams.set('pageToken', page.nextPageToken)
      url = next.toString()
    }
    return items
  }
}
