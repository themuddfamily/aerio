// Bounds checks for interchange data crossing the IPC boundary into the main process.
import type { CalendarEvent, Contact, ContactField, ContactList } from '../types'
import { CONTACT_GROUP_LIMIT, isContactPhoto } from './contact-fields'
import { isCompleteMailAddress } from './mail-address'

const text = (value: unknown, max: number, required = false): value is string =>
  typeof value === 'string' && value.length <= max && (!required || Boolean(value.trim()))
const optionalText = (value: unknown, max: number) => value === undefined || text(value, max)
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

function validField(field: unknown): field is ContactField {
  if (!field || typeof field !== 'object') return false
  const value = field as Partial<ContactField>
  return text(value.value, 10_000, true) && optionalText(value.type, 200) && (value.preferred === undefined || typeof value.preferred === 'boolean') &&
    (value.parts === undefined || (Array.isArray(value.parts) && value.parts.length <= 7 && value.parts.every((part) => text(part, 2_000))))
}

const validFields = (fields: unknown) => fields === undefined || (Array.isArray(fields) && fields.length <= 50 && fields.every(validField))

export function validContactInterchangeFields(contact: Partial<Contact>) {
  return validFields(contact.emails) && validFields(contact.phones) && validFields(contact.addresses) && validFields(contact.urls) &&
    (contact.nameParts === undefined || (Array.isArray(contact.nameParts) && contact.nameParts.length <= 5 && contact.nameParts.every((part) => text(part, 1_000)))) &&
    optionalText(contact.nickname, 500) && optionalText(contact.birthday, 50) && optionalText(contact.sourceUid, 1_000) &&
    (contact.groups === undefined || (Array.isArray(contact.groups) && contact.groups.length <= CONTACT_GROUP_LIMIT && contact.groups.every((group) => text(group, 300, true)))) &&
    (contact.photo === undefined || isContactPhoto(contact.photo))
}

export const CONTACT_LIST_LIMIT = 10_000
export const CONTACT_LIST_MEMBER_LIMIT = 5_000

export function validContactList(value: unknown): value is ContactList {
  if (!value || typeof value !== 'object') return false
  const list = value as Partial<ContactList>
  if (!text(list.id, 300, true) || !text(list.name, 300, true) || list.source !== 'local' || !optionalText(list.notes, 100_000)) return false
  if (!Array.isArray(list.members) || list.members.length > CONTACT_LIST_MEMBER_LIMIT) return false
  return list.members.every((member) => member && typeof member === 'object' && text(member.email, 500, true) && isCompleteMailAddress(member.email) &&
    optionalText(member.contactId, 500) && optionalText(member.name, 500))
}

export function validContactLists(value: unknown): value is ContactList[] {
  return Array.isArray(value) && value.length <= CONTACT_LIST_LIMIT && value.every(validContactList) && new Set(value.map((list) => list.id)).size === value.length
}

export function validEventInterchangeFields(event: Partial<CalendarEvent>) {
  return (event.allDay === undefined || typeof event.allDay === 'boolean') && optionalText(event.timeZone, 200) &&
    optionalText(event.recurrenceRule, 1_000) && optionalText(event.recurrenceId, 100) && optionalText(event.sourceUid, 1_000) &&
    (event.recurrenceExceptions === undefined || (Array.isArray(event.recurrenceExceptions) && event.recurrenceExceptions.length <= 5_000 &&
      event.recurrenceExceptions.every((value) => text(value, 100) && Number.isFinite(Date.parse(value)))))
}

// Local calendar events accept the same fields as provider events plus date-only all-day values.
export function validInterchangeEvent(value: unknown): value is CalendarEvent {
  if (!value || typeof value !== 'object') return false
  const event = value as Partial<CalendarEvent>
  if (!text(event.id, 500, true) || !text(event.calendarId, 500) || !text(event.title, 500, true)) return false
  if (!text(event.start, 100) || !text(event.end, 100)) return false
  if (DATE_ONLY.test(event.start) !== DATE_ONLY.test(event.end)) return false
  const start = Date.parse(event.start)
  const end = Date.parse(event.end)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return false
  if (!optionalText(event.location, 2_000) || !optionalText(event.description, 100_000)) return false
  if (!text(event.color, 100) || !Array.isArray(event.attendees) || event.attendees.length > 1_000 || !event.attendees.every((item) => text(item, 500))) return false
  if (!Number.isInteger(event.reminderMinutes) || Number(event.reminderMinutes) < 0 || Number(event.reminderMinutes) > 40_320) return false
  if (event.recurrence !== undefined && !['none', 'daily', 'weekly', 'monthly'].includes(event.recurrence)) return false
  return validEventInterchangeFields(event)
}
