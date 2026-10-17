// Duplicate detection and merge planning for calendar and contact imports. Pure functions so the
// preview in the renderer and the tests agree on exactly what an import will do.
import type { CalendarEvent, Contact, ContactField } from '../types'
import { eventIdentity } from './ics'

export type ContactDuplicateStrategy = 'merge' | 'skip' | 'create'
export type EventDuplicateStrategy = 'update' | 'skip' | 'create'

export interface ContactImportItem {
  contact: Contact
  action: 'create' | 'merge' | 'skip'
  match?: Contact
}

export interface EventImportItem {
  event: CalendarEvent
  action: 'create' | 'update' | 'skip'
  match?: CalendarEvent
}

const normalizedEmail = (value: string) => value.trim().toLowerCase()
const normalizedPhone = (value: string) => value.replace(/[^\d+]/g, '')
const normalizedName = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ')

const contactEmails = (contact: Contact) => [contact.email, ...(contact.emails ?? []).map((field) => field.value)].filter(Boolean).map(normalizedEmail)
const contactPhones = (contact: Contact) => [contact.phone ?? '', ...(contact.phones ?? []).map((field) => field.value)].map(normalizedPhone).filter((value) => value.length >= 5)

class ContactIndex {
  private readonly byUid = new Map<string, Contact>()
  private readonly byEmail = new Map<string, Contact>()
  private readonly byNamePhone = new Map<string, Contact>()

  constructor(contacts: Contact[]) {
    for (const contact of contacts) this.add(contact)
  }

  add(contact: Contact) {
    if (contact.sourceUid && !this.byUid.has(contact.sourceUid)) this.byUid.set(contact.sourceUid, contact)
    for (const email of contactEmails(contact)) if (!this.byEmail.has(email)) this.byEmail.set(email, contact)
    for (const phone of contactPhones(contact)) {
      const key = `${normalizedName(contact.name)}\u0000${phone}`
      if (!this.byNamePhone.has(key)) this.byNamePhone.set(key, contact)
    }
  }

  find(contact: Contact) {
    if (contact.sourceUid && this.byUid.has(contact.sourceUid)) return this.byUid.get(contact.sourceUid)
    for (const email of contactEmails(contact)) if (this.byEmail.has(email)) return this.byEmail.get(email)
    for (const phone of contactPhones(contact)) {
      const match = this.byNamePhone.get(`${normalizedName(contact.name)}\u0000${phone}`)
      if (match) return match
    }
    return undefined
  }
}

// Matches by source UID, then any shared email address, then the same name with a shared phone number.
// Duplicates inside the imported file are matched against earlier rows of the same file.
export function planContactImport(incoming: Contact[], existing: Contact[], strategy: ContactDuplicateStrategy): ContactImportItem[] {
  const index = new ContactIndex(existing)
  const planned: ContactImportItem[] = []
  const createdBy = new Map<Contact, ContactImportItem>()
  for (const contact of incoming) {
    const match = strategy === 'create' ? undefined : index.find(contact)
    if (!match) {
      const item: ContactImportItem = { contact, action: 'create' }
      planned.push(item)
      createdBy.set(contact, item)
      index.add(contact)
      continue
    }
    if (strategy === 'skip') {
      planned.push({ contact, action: 'skip', match })
      continue
    }
    const earlier = createdBy.get(match)
    if (earlier) {
      // Fold a repeated row into the contact that this import is already creating.
      earlier.contact = mergeContacts(earlier.contact, contact)
      createdBy.set(earlier.contact, earlier)
      planned.push({ contact, action: 'skip', match: earlier.contact })
      index.add(earlier.contact)
      continue
    }
    const merged = mergeContacts(match, contact)
    planned.push({ contact: merged, action: 'merge', match })
  }
  return planned
}

function mergeFields(current: ContactField[] | undefined, primary: string | undefined, incoming: ContactField[] | undefined, normalize: (value: string) => string) {
  const fields = [...(current?.length ? current : primary ? [{ value: primary }] : [])]
  const seen = new Set(fields.map((field) => normalize(field.value)))
  for (const field of incoming ?? []) {
    const key = normalize(field.value)
    if (!key || seen.has(key)) continue
    seen.add(key)
    fields.push({ ...field, preferred: undefined })
  }
  return fields.length ? fields.slice(0, 50).map((field) => Object.fromEntries(Object.entries(field).filter(([, value]) => value !== undefined)) as unknown as ContactField) : undefined
}

// Keeps the existing record's identity, values, and favourite state, filling gaps from the import.
export function mergeContacts(existing: Contact, incoming: Contact): Contact {
  const emails = mergeFields(existing.emails, existing.email || undefined, incoming.emails ?? (incoming.email ? [{ value: incoming.email }] : []), normalizedEmail)
  const phones = mergeFields(existing.phones, existing.phone, incoming.phones ?? (incoming.phone ? [{ value: incoming.phone }] : []), normalizedPhone)
  const addresses = mergeFields(existing.addresses, undefined, incoming.addresses, normalizedName)
  const urls = mergeFields(existing.urls, undefined, incoming.urls, (value) => value.trim().toLowerCase())
  return {
    ...incoming,
    ...Object.fromEntries(Object.entries(existing).filter(([, value]) => value !== undefined && value !== '')),
    email: existing.email || emails?.[0]?.value || '',
    ...(existing.phone || phones?.[0] ? { phone: existing.phone || phones?.[0]?.value } : {}),
    ...(emails ? { emails } : {}),
    ...(phones ? { phones } : {}),
    ...(addresses ? { addresses } : {}),
    ...(urls ? { urls } : {}),
    sourceUid: existing.sourceUid ?? incoming.sourceUid
  } as Contact
}

// Date-only values are local calendar days, matching how the views parse them.
const instant = (value: string) => {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  return date ? new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3])).getTime() : Date.parse(value)
}

const eventKey = (event: CalendarEvent) => `${normalizedName(event.title)}\u0000${event.start}\u0000${event.end}`

// Matches by UID plus RECURRENCE-ID, then by identical title, start, and end.
export function planEventImport(incoming: CalendarEvent[], existing: CalendarEvent[], strategy: EventDuplicateStrategy): EventImportItem[] {
  const byIdentity = new Map<string, CalendarEvent>()
  const byKey = new Map<string, CalendarEvent>()
  const byKeyWithoutUid = new Map<string, CalendarEvent>()
  const remember = (event: CalendarEvent) => {
    const identity = eventIdentity(event)
    if (identity && !byIdentity.has(identity)) byIdentity.set(identity, event)
    if (!byKey.has(eventKey(event))) byKey.set(eventKey(event), event)
    if (!identity && !byKeyWithoutUid.has(eventKey(event))) byKeyWithoutUid.set(eventKey(event), event)
  }
  existing.forEach(remember)
  const seenInFile = new Set<string>()
  return incoming.map((event) => {
    const identity = eventIdentity(event)
    const fileKey = identity ?? eventKey(event)
    if (seenInFile.has(fileKey)) return { event, action: 'skip' as const }
    seenInFile.add(fileKey)
    // An event with a UID only falls back to title/time matching against events that have no UID,
    // so distinct occurrences of the same series are not collapsed together.
    const match = strategy === 'create' ? undefined : identity
      ? byIdentity.get(identity) ?? byKeyWithoutUid.get(eventKey(event))
      : byKey.get(eventKey(event))
    if (!match) return { event, action: 'create' as const }
    if (strategy === 'skip') return { event, action: 'skip' as const, match }
    return { event: { ...event, id: match.id, calendarId: match.calendarId, color: match.color }, action: 'update' as const, match }
  })
}

// The event editor rebuilds an event from its form fields; this carries interchange data forward and
// drops values the user has visibly replaced (a new repeat choice or edited times).
export function preserveEventInterchangeFields(original: CalendarEvent | undefined, next: CalendarEvent): CalendarEvent {
  if (!original) return next
  const timesChanged = instant(original.start) !== instant(next.start) || instant(original.end) !== instant(next.end)
  const recurrenceChanged = (original.recurrence ?? 'none') !== (next.recurrence ?? 'none')
  return {
    ...next,
    ...(original.timeZone ? { timeZone: original.timeZone } : {}),
    ...(original.sourceUid ? { sourceUid: original.sourceUid } : {}),
    ...(original.recurrenceId ? { recurrenceId: original.recurrenceId } : {}),
    ...(original.allDay && !timesChanged ? { allDay: true, start: original.start, end: original.end } : {}),
    ...(original.recurrenceRule && !recurrenceChanged ? { recurrenceRule: original.recurrenceRule } : {}),
    ...(original.recurrenceExceptions?.length && !recurrenceChanged ? { recurrenceExceptions: original.recurrenceExceptions } : {})
  }
}
