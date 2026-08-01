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
  names?: { displayName?: string }[]
  emailAddresses?: { value?: string }[]
  phoneNumbers?: { value?: string }[]
  organizations?: { name?: string; title?: string }[]
  biographies?: { value?: string }[]
  memberships?: { contactGroupMembership?: { contactGroupResourceName?: string } }[]
}

const recurrence = (rules?: string[]) => {
  const frequency = rules?.find((rule) => rule.startsWith('RRULE:'))?.match(/FREQ=(DAILY|WEEKLY|MONTHLY)/)?.[1]?.toLowerCase()
  return frequency === 'daily' || frequency === 'weekly' || frequency === 'monthly' ? frequency : 'none'
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

export function mapGoogleContact(accountId: string, person: GooglePerson): SyncedContact | undefined {
  const name = person.names?.[0]?.displayName?.trim()
  if (!name) return
  const groupResource = person.memberships?.map((membership) => membership.contactGroupMembership?.contactGroupResourceName).find(Boolean)
  return {
    id: `${accountId}:google-contact:${person.resourceName}`,
    remoteId: person.resourceName,
    accountId,
    provider: 'gmail',
    name,
    email: person.emailAddresses?.[0]?.value ?? '',
    phone: person.phoneNumbers?.[0]?.value,
    company: person.organizations?.[0]?.name,
    title: person.organizations?.[0]?.title,
    group: groupResource?.split('/').at(-1) ?? 'Google',
    notes: person.biographies?.[0]?.value,
    favorite: groupResource === 'contactGroups/starred',
    color: '#4d8f78',
    readOnly: false
  }
}

export class GoogleProductivityConnector implements ProductivityConnector {
  readonly provider = 'gmail' as const

  constructor(private readonly accountId: string, private readonly token: () => Promise<string>) {}

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
      canWrite: false
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
    const personFields = 'names,emailAddresses,phoneNumbers,organizations,biographies,memberships'
    const people = await this.pages<GooglePerson>(`https://people.googleapis.com/v1/people/me/connections?personFields=${personFields}&pageSize=1000`, 'connections')
    return { calendars, events, contacts: people.flatMap((person) => { const mapped = mapGoogleContact(this.accountId, person); return mapped ? [mapped] : [] }) }
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
