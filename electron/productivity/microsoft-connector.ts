import type { CalendarEvent } from '../../src/types'
import type { ProviderProductivityData, SyncedCalendar, SyncedCalendarEvent, SyncedContact } from '../../src/productivity-types'
import { retryingJson, type ProductivityConnector } from './connector'

interface GraphPage<T> { value: T[]; '@odata.nextLink'?: string }
interface GraphCalendar { id: string; name?: string; color?: string; isDefaultCalendar?: boolean; canEdit?: boolean }
interface GraphEvent {
  id: string
  subject?: string
  bodyPreview?: string
  location?: { displayName?: string }
  start?: { dateTime?: string; timeZone?: string }
  end?: { dateTime?: string; timeZone?: string }
  attendees?: { emailAddress?: { address?: string } }[]
  recurrence?: { pattern?: { type?: string } }
  reminderMinutesBeforeStart?: number
  isCancelled?: boolean
  isOrganizer?: boolean
}
interface GraphContact {
  id: string
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

const utc = (value?: string) => !value ? undefined : /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value}Z`
const recurrence = (value?: string) => {
  const normalized = value?.toLowerCase() ?? ''
  return normalized.includes('daily') ? 'daily' : normalized.includes('weekly') ? 'weekly' : normalized.includes('monthly') ? 'monthly' : 'none'
}

const weekDays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

export const microsoftEventBody = (event: CalendarEvent) => {
  const start = new Date(event.start)
  const repeat = event.recurrence ?? 'none'
  const pattern = repeat === 'daily' ? { type: 'daily', interval: 1 }
    : repeat === 'weekly' ? { type: 'weekly', interval: 1, daysOfWeek: [weekDays[start.getUTCDay()]] }
      : repeat === 'monthly' ? { type: 'absoluteMonthly', interval: 1, dayOfMonth: start.getUTCDate() }
        : undefined
  return {
    subject: event.title,
    body: { contentType: 'text', content: event.description ?? '' },
    start: { dateTime: event.start, timeZone: 'UTC' },
    end: { dateTime: event.end, timeZone: 'UTC' },
    location: { displayName: event.location ?? '' },
    attendees: event.attendees.map((address) => ({ emailAddress: { address }, type: 'required' })),
    isReminderOn: true,
    reminderMinutesBeforeStart: event.reminderMinutes,
    recurrence: pattern ? { pattern, range: { type: 'noEnd', startDate: event.start.slice(0, 10) } } : null
  }
}

export function mapMicrosoftEvent(accountId: string, calendar: SyncedCalendar, event: GraphEvent): SyncedCalendarEvent | undefined {
  const start = utc(event.start?.dateTime)
  const end = utc(event.end?.dateTime)
  if (!start || !end || event.isCancelled) return
  return {
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
    readOnly: !calendar.canWrite || event.isOrganizer === false
  }
}

export function mapMicrosoftContact(accountId: string, contact: GraphContact): SyncedContact | undefined {
  const name = contact.displayName?.trim() || `${contact.givenName ?? ''} ${contact.surname ?? ''}`.trim()
  if (!name) return
  return {
    id: `${accountId}:microsoft-contact:${contact.id}`,
    remoteId: contact.id,
    accountId,
    provider: 'microsoft',
    name,
    email: contact.emailAddresses?.[0]?.address ?? '',
    phone: contact.mobilePhone ?? contact.businessPhones?.[0],
    company: contact.companyName,
    title: contact.jobTitle,
    group: contact.categories?.[0] ?? 'Outlook',
    notes: contact.personalNotes,
    favorite: false,
    color: '#3b6fd8',
    readOnly: false
  }
}

export class MicrosoftProductivityConnector implements ProductivityConnector {
  readonly provider = 'microsoft' as const

  constructor(private readonly accountId: string, private readonly token: () => Promise<string>, private readonly calendarWriteAuthorized = false) {}

  async sync(): Promise<ProviderProductivityData> {
    const remoteCalendars = await this.pages<GraphCalendar>('https://graph.microsoft.com/v1.0/me/calendars?$select=id,name,color,isDefaultCalendar,canEdit')
    const calendars: SyncedCalendar[] = remoteCalendars.map((calendar) => ({
      id: `${this.accountId}:microsoft-calendar:${calendar.id}`,
      remoteId: calendar.id,
      accountId: this.accountId,
      provider: 'microsoft',
      name: calendar.name?.trim() || 'Calendar',
      color: graphColor(calendar.color),
      primary: Boolean(calendar.isDefaultCalendar),
      canWrite: this.calendarWriteAuthorized && Boolean(calendar.canEdit)
    }))
    const from = new Date(); from.setUTCFullYear(from.getUTCFullYear() - 1)
    const to = new Date(); to.setUTCFullYear(to.getUTCFullYear() + 2)
    const events: SyncedCalendarEvent[] = []
    for (const calendar of calendars) {
      const query = new URLSearchParams({ startDateTime: from.toISOString(), endDateTime: to.toISOString(), '$top': '1000', '$select': 'id,subject,bodyPreview,location,start,end,attendees,recurrence,isCancelled,isOrganizer' })
      const remoteEvents = await this.pages<GraphEvent>(`https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendar.remoteId)}/calendarView?${query}`)
      events.push(...remoteEvents.flatMap((event) => { const mapped = mapMicrosoftEvent(this.accountId, calendar, event); return mapped ? [mapped] : [] }))
    }
    const contacts = await this.pages<GraphContact>('https://graph.microsoft.com/v1.0/me/contacts?$top=1000&$select=id,displayName,givenName,surname,emailAddresses,businessPhones,mobilePhone,companyName,jobTitle,personalNotes,categories')
    return { calendars, events, contacts: contacts.flatMap((contact) => { const mapped = mapMicrosoftContact(this.accountId, contact); return mapped ? [mapped] : [] }) }
  }

  async createEvent(calendar: SyncedCalendar, event: CalendarEvent) {
    this.assertWritable(calendar)
    const remote = await retryingJson<GraphEvent>(this.provider, this.eventsUrl(calendar), this.token, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(microsoftEventBody(event))
    })
    return this.mapWrittenEvent(calendar, remote)
  }

  async updateEvent(calendar: SyncedCalendar, current: SyncedCalendarEvent, event: CalendarEvent) {
    this.assertWritable(calendar)
    const remote = await retryingJson<GraphEvent>(this.provider, `${this.eventsUrl(calendar)}/${encodeURIComponent(current.remoteId)}`, this.token, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(microsoftEventBody(event))
    })
    return this.mapWrittenEvent(calendar, remote)
  }

  async deleteEvent(calendar: SyncedCalendar, event: SyncedCalendarEvent) {
    this.assertWritable(calendar)
    await retryingJson<void>(this.provider, `${this.eventsUrl(calendar)}/${encodeURIComponent(event.remoteId)}`, this.token, { method: 'DELETE' })
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
}

function graphColor(color?: string) {
  const colors: Record<string, string> = {
    auto: '#6558e8', lightBlue: '#3b82c4', lightGreen: '#4d8f78', lightOrange: '#b76a3c', lightGray: '#687080',
    lightYellow: '#9c7725', lightTeal: '#247d82', lightPink: '#a54f78', lightBrown: '#805b45', lightRed: '#b24752', maxColor: '#6558e8'
  }
  return colors[color ?? 'auto'] ?? '#6558e8'
}
