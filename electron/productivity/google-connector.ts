import type { CalendarEvent, Contact } from '../../src/types'
import type { ProviderProductivityData, ProviderProductivitySyncResult, SyncedCalendar, SyncedCalendarEvent, SyncedContact, SyncedContactGroup } from '../../src/productivity-types'
import { ProductivityApiError, retryingJson, type ProductivityConnector } from './connector'
import {
  attachGooglePhotos, googleContactGroupFields, googlePhotoBytes, googleRichContactBody, googleRichContactFields, googleUpdatePersonFields,
  mapGoogleContactGroup, mapGoogleRichContact, type GoogleContactGroup, type GoogleRichPerson
} from './google-contacts'

interface GooglePage<T> { items?: T[]; connections?: T[]; nextPageToken?: string; nextSyncToken?: string }
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
      canWrite: this.calendarWriteAuthorized && (calendar.accessRole === 'owner' || calendar.accessRole === 'writer')
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
      const current = syncToken ? new Map(previous.filter((event) => event.calendarId === calendar.id).map((event) => [event.id, event])) : new Map<string, SyncedCalendarEvent>()
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
