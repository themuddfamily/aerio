import { createHash } from 'node:crypto'
import type { CalendarEvent, Contact } from '../../src/types'
import type { SyncedCalendarEvent, SyncedContact } from '../../src/productivity-types'
import { icsEventToCalendarEvent, ICS_LIMITS, parseIcs, serializeIcs } from '../../src/lib/ics'
import { parseVCards, serializeVCards, VCARD_LIMITS } from '../../src/lib/vcard'
import { firstProperty, foldLine, formatParam, parseComponents, unescapeText, type Component, type ContentLine } from '../../src/lib/content-lines'

// Maps CalDAV calendar objects and CardDAV vCards to Aerio events and contacts, and back. Writes
// reuse the E26 ICS/vCard serializers, then carry over every property Aerio does not edit
// (ORGANIZER, attendee parameters, X- properties, PHOTO, …) from the server copy so a round trip
// does not strip data other clients rely on.

export interface DavCollectionRef {
  id: string
  accountId: string
  name: string
  color: string
  readOnly: boolean
}

const shortHash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24)
export const davEventId = (collectionId: string, href: string, recurrenceId?: string) => `${collectionId}:${shortHash(`${href}\u0000${recurrenceId ?? ''}`)}`
export const davContactId = (collectionId: string, href: string) => `${collectionId}:${shortHash(href)}`

export function eventsFromResource(collection: DavCollectionRef, href: string, data: string): SyncedCalendarEvent[] {
  const parsed = parseIcs(data, ICS_LIMITS, 5_000)
  return parsed.events.map((event) => ({
    ...icsEventToCalendarEvent(event, collection.id, collection.color, davEventId(collection.id, href, event.recurrenceId)),
    remoteId: href,
    accountId: collection.accountId,
    provider: 'dav' as const,
    readOnly: collection.readOnly
  }))
}

// iCloud and others store contact groups as vCards with a KIND/X-ADDRESSBOOKSERVER-KIND of "group".
const isGroupCard = (card: Component) => [firstProperty(card, 'KIND'), firstProperty(card, 'X-ADDRESSBOOKSERVER-KIND')].some((line) => line?.value.trim().toLowerCase() === 'group')

export function contactFromResource(collection: DavCollectionRef, href: string, etag: string | undefined, data: string): SyncedContact | undefined {
  const { roots } = parseComponents(data, VCARD_LIMITS)
  const card = roots.find((root) => root.name === 'VCARD')
  if (!card || isGroupCard(card)) return undefined
  const id = davContactId(collection.id, href)
  const contact = parseVCards(data, { idFactory: () => id, color: collection.color, group: collection.name }).contacts[0]
  if (!contact) return undefined
  return {
    ...contact,
    remoteId: href,
    accountId: collection.accountId,
    provider: 'dav',
    readOnly: collection.readOnly,
    folderId: collection.id,
    ...(etag ? { revision: etag } : {})
  }
}

export const resourceTitle = (kind: 'event' | 'contact', data: string | undefined) => {
  if (!data) return undefined
  try {
    const { roots } = parseComponents(data, kind === 'event' ? ICS_LIMITS : VCARD_LIMITS)
    const component = kind === 'event' ? roots[0]?.children.find((child) => child.name === 'VEVENT') : roots[0]
    const line = component ? firstProperty(component, kind === 'event' ? 'SUMMARY' : 'FN') : undefined
    return line ? unescapeText(line.value).slice(0, 200) : undefined
  } catch { return undefined }
}

// --- Writing ----------------------------------------------------------------------------------

const formatLine = (line: ContentLine) =>
  `${line.group ? `${line.group}.` : ''}${line.name}${Object.entries(line.params).map(([name, values]) => formatParam(name, values)).join('')}:${line.value}`

function emitComponent(component: Component): string[] {
  return [`BEGIN:${component.name}`, ...component.properties.map(formatLine), ...component.children.flatMap(emitComponent), `END:${component.name}`]
}

const emit = (roots: Component[]) => `${roots.flatMap(emitComponent).map(foldLine).join('\r\n')}\r\n`

const parseRoots = (text: string, limits = ICS_LIMITS) => parseComponents(text, limits).roots

// Properties the ICS serializer writes from CalendarEvent; everything else on the server copy is kept.
const EVENT_MANAGED = new Set(['UID', 'DTSTAMP', 'DTSTART', 'DTEND', 'DURATION', 'RECURRENCE-ID', 'SUMMARY', 'LOCATION', 'DESCRIPTION', 'RRULE', 'EXDATE', 'ATTENDEE'])
// The normalized RECURRENCE-ID of one VEVENT, resolved with the resource's own VTIMEZONEs.
function instanceKey(calendar: Component, event: Component) {
  if (!firstProperty(event, 'RECURRENCE-ID')) return ''
  const zones = calendar.children.filter((child) => child.name === 'VTIMEZONE')
  try {
    return parseIcs(emit([{ name: 'VCALENDAR', properties: calendar.properties, children: [...zones, event] }])).events[0]?.recurrenceId ?? '?'
  } catch { return '?' }
}

const attendeeEmails = (component: Component) => component.properties
  .filter((line) => line.name === 'ATTENDEE')
  .map((line) => line.value.replace(/^mailto:/i, '').trim().toLowerCase())
  .sort()

/** Serializes a new calendar object resource for `event` with the given UID. */
export function newEventResource(event: CalendarEvent, uid: string) {
  return serializeIcs([{ ...event, sourceUid: uid }])
}

/**
 * Replaces one VEVENT (matched by RECURRENCE-ID) in an existing calendar object resource while
 * keeping its other instances, VTIMEZONEs, unmanaged properties, attendee parameters, and alarms
 * when the edited event did not change them.
 */
export function mergeEventResource(original: string, previous: CalendarEvent, event: CalendarEvent) {
  const roots = parseRoots(original)
  const calendar = roots.find((root) => root.name === 'VCALENDAR')
  if (!calendar) return newEventResource(event, event.sourceUid ?? `${event.id}@aerio.local`)
  const generatedCalendar = parseRoots(serializeIcs([{ ...event, sourceUid: event.sourceUid ?? previous.sourceUid }])).find((root) => root.name === 'VCALENDAR')!
  const generated = generatedCalendar.children.find((child) => child.name === 'VEVENT')!
  const index = calendar.children.findIndex((child) => child.name === 'VEVENT' && instanceKey(calendar, child) === (previous.recurrenceId ?? ''))
  const target = index >= 0 ? calendar.children[index] : undefined
  if (!target) {
    calendar.children.push(generated)
  } else {
    const keepAttendees = attendeeEmails(target).join('\n') === attendeeEmails(generated).join('\n')
    const keepAlarms = previous.reminderMinutes === event.reminderMinutes
    const timingChanged = previous.start !== event.start || previous.end !== event.end || (previous.recurrenceRule ?? previous.recurrence) !== (event.recurrenceRule ?? event.recurrence)
    const properties: ContentLine[] = [
      ...generated.properties.filter((line) => !(keepAttendees && line.name === 'ATTENDEE')),
      ...target.properties.filter((line) => !EVENT_MANAGED.has(line.name) || (keepAttendees && line.name === 'ATTENDEE'))
        .map((line) => {
          if (line.name === 'SEQUENCE' && timingChanged) return { ...line, value: String((Number(line.value) || 0) + 1) }
          if (line.name === 'LAST-MODIFIED') return { ...line, params: {}, value: new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '') }
          return line
        })
    ]
    const children = [
      ...target.children.filter((child) => child.name !== 'VALARM' || keepAlarms),
      ...(keepAlarms ? [] : generated.children.filter((child) => child.name === 'VALARM'))
    ]
    // The generated UID stays authoritative only when the server copy has none.
    calendar.children[index] = { name: 'VEVENT', properties: firstProperty(target, 'UID') ? properties.filter((line) => line.name !== 'UID').concat(firstProperty(target, 'UID')!) : properties, children }
  }
  for (const zone of generatedCalendar.children.filter((child) => child.name === 'VTIMEZONE')) {
    const tzid = firstProperty(zone, 'TZID')?.value
    if (!calendar.children.some((child) => child.name === 'VTIMEZONE' && firstProperty(child, 'TZID')?.value === tzid)) calendar.children.unshift(zone)
  }
  return emit(roots)
}

/**
 * Deletes one instance of a recurring event: its override (if any) is removed and the master gets an
 * EXDATE for that occurrence (RFC 5545). Returns undefined when the resource has no recurring master.
 */
export function removeEventInstance(original: string, recurrenceId: string) {
  const roots = parseRoots(original)
  const calendar = roots.find((root) => root.name === 'VCALENDAR')
  const master = calendar?.children.find((child) => child.name === 'VEVENT' && !firstProperty(child, 'RECURRENCE-ID'))
  if (!calendar || !master || !firstProperty(master, 'RRULE')) return undefined
  const override = calendar.children.find((child) => child.name === 'VEVENT' && child !== master && instanceKey(calendar, child) === recurrenceId)
  const line = override ? firstProperty(override, 'RECURRENCE-ID') : undefined
  master.properties.push(line
    ? { ...line, name: 'EXDATE' }
    : /^\d{4}-\d{2}-\d{2}$/.test(recurrenceId)
      ? { name: 'EXDATE', params: { VALUE: ['DATE'] }, value: recurrenceId.replace(/-/g, '') }
      : { name: 'EXDATE', params: {}, value: new Date(recurrenceId).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '') })
  calendar.children = calendar.children.filter((child) => child !== override)
  return emit(roots)
}

const CONTACT_MANAGED = new Set(['UID', 'FN', 'N', 'NICKNAME', 'EMAIL', 'TEL', 'ADR', 'URL', 'ORG', 'TITLE', 'BDAY', 'CATEGORIES', 'NOTE', 'VERSION', 'PRODID'])

/** Serializes a vCard for `contact`. `defaultGroup` (the address book name) is not written as a category. */
export function newContactResource(contact: Contact, uid: string, defaultGroup: string, version: '3.0' | '4.0' = '3.0') {
  const roots = parseRoots(serializeVCards([{ ...contact, sourceUid: uid }], version), VCARD_LIMITS)
  const card = roots[0]
  if (contact.group === defaultGroup) card.properties = card.properties.filter((line) => line.name !== 'CATEGORIES')
  return emit(roots)
}

export function mergeContactResource(original: string, contact: Contact, defaultGroup: string) {
  const roots = parseRoots(original, VCARD_LIMITS)
  const card = roots.find((root) => root.name === 'VCARD')
  if (!card) return newContactResource(contact, contact.sourceUid ?? `${contact.id}@aerio.local`, defaultGroup)
  const version = firstProperty(card, 'VERSION')?.value.trim() === '4.0' ? '4.0' : '3.0'
  const uid = firstProperty(card, 'UID')
  const generated = parseRoots(newContactResource(contact, uid ? unescapeText(uid.value) : contact.sourceUid ?? `${contact.id}@aerio.local`, defaultGroup, version), VCARD_LIMITS)[0]
  const keepCategories = contact.group === defaultGroup
  const keptOriginal = card.properties.filter((line) => !CONTACT_MANAGED.has(line.name) || (keepCategories && line.name === 'CATEGORIES') || (line.name === 'UID'))
  const properties = [
    ...generated.properties.filter((line) => line.name !== 'UID' || !uid).filter((line) => line.name !== 'REV'),
    ...keptOriginal.filter((line) => line.name !== 'REV'),
    ...(firstProperty(card, 'REV') ? [{ name: 'REV', params: {}, value: new Date().toISOString().replace(/\.\d{3}/, '') }] : [])
  ]
  // VERSION must stay the first property after BEGIN.
  properties.sort((a, b) => Number(b.name === 'VERSION') - Number(a.name === 'VERSION'))
  card.properties = properties
  return emit(roots)
}
