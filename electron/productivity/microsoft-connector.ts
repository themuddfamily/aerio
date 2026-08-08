import type { CalendarEvent, Contact } from '../../src/types'
import type { ProviderProductivityData, ProviderProductivitySyncResult, SyncedCalendar, SyncedCalendarEvent, SyncedContact } from '../../src/productivity-types'
import { ProductivityApiError, retryingJson, type ProductivityConnector } from './connector'

interface GraphPage<T> { value: T[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string }
interface GraphCalendar { id: string; name?: string; color?: string; isDefaultCalendar?: boolean; canEdit?: boolean }
interface GraphEvent {
  id: string
  '@removed'?: { reason?: string }
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
      const current = deltaLink ? new Map(previous.filter((event) => event.calendarId === calendar.id).map((event) => [event.id, event])) : new Map<string, SyncedCalendarEvent>()
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
        const select = 'id,changeKey,parentFolderId,displayName,givenName,surname,emailAddresses,businessPhones,mobilePhone,companyName,jobTitle,personalNotes,categories'
        initial = `https://graph.microsoft.com/v1.0/me/contactFolders/${encodeURIComponent(folderId)}/contacts/delta?$select=${select}`
      }
      const delta = await this.deltaPages<GraphContact>(initial)
      const current = deltaLink ? new Map(previous.map((contact) => [contact.remoteId, contact])) : new Map<string, SyncedContact>()
      for (const contact of delta.items) {
        if (contact['@removed']) {
          current.delete(contact.id)
          continue
        }
        const mapped = mapMicrosoftContact(this.accountId, contact, !this.contactsWriteAuthorized)
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

  async createContact(contact: Contact) {
    this.assertContactsWritable()
    const remote = await retryingJson<GraphContact>(this.provider, this.contactsUrl(), this.token, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(microsoftContactBody(contact))
    })
    return this.mapWrittenContact(remote)
  }

  async updateContact(current: SyncedContact, contact: Contact) {
    this.assertContactsWritable(current)
    await this.assertCurrentContactRevision(current)
    const remote = await retryingJson<GraphContact>(this.provider, `${this.contactsUrl()}/${encodeURIComponent(current.remoteId)}`, this.token, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(microsoftContactBody(contact))
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

  private mapWrittenContact(remote: GraphContact) {
    const mapped = mapMicrosoftContact(this.accountId, remote, false)
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
