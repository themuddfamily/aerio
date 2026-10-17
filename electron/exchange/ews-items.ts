import { createHash } from 'node:crypto'
import type { AttendeeResponse, CalendarEvent, Contact, ContactField, EventAttendee } from '../../src/types'
import type { SyncedCalendarEvent, SyncedContact } from '../../src/productivity-types'
import { eventAttendees, participant, withAttendees } from '../../src/lib/event-attendees'
import { graphRecurrenceToRule, ruleToGraphRecurrence, UnsupportedRecurrenceError, type GraphRecurrence } from '../../src/lib/provider-recurrence'
import { eventRecurrenceRule, isAllDayEvent, isoDay, wallParts } from '../../src/lib/recurrence'
import { isIanaTimeZone, resolveTimeZoneName, windowsTimeZoneName } from '../../src/lib/time-zones'
import type { XmlElement } from '../productivity/dav-xml'
import { deleteIndexedField, deleteItemField, setIndexedField, setItemField } from './ews-client'
import { attr, element, path, t, tBool, tNumber, ts, tText, xmlText } from './ews-xml'

// Mapping between EWS CalendarItem/Contact elements and Aerio's normalized productivity records.
// Recurrence patterns go through the Graph recurrence helpers: EWS and Graph share the same
// pattern model (daily/weekly/absolute- and relative-monthly/yearly with end-date, numbered, or
// no-end ranges), so only the XML spelling differs.

export const CALENDAR_ITEM_PROPERTIES = [
  'item:Subject', 'item:Body', 'item:ReminderIsSet', 'item:ReminderMinutesBeforeStart', 'item:Categories',
  'calendar:Start', 'calendar:End', 'calendar:IsAllDayEvent', 'calendar:Location', 'calendar:IsCancelled', 'calendar:IsMeeting',
  'calendar:CalendarItemType', 'calendar:MyResponseType', 'calendar:Organizer', 'calendar:RequiredAttendees', 'calendar:OptionalAttendees',
  'calendar:Resources', 'calendar:Recurrence', 'calendar:ModifiedOccurrences', 'calendar:DeletedOccurrences', 'calendar:UID',
  'calendar:StartTimeZoneId', 'calendar:AppointmentSequenceNumber', 'calendar:OriginalStart'
]

export const CONTACT_PROPERTIES = [
  'item:Body', 'item:Categories', 'contacts:DisplayName', 'contacts:GivenName', 'contacts:Surname', 'contacts:Nickname', 'contacts:CompanyName',
  'contacts:JobTitle', 'contacts:EmailAddresses', 'contacts:PhoneNumbers', 'contacts:Birthday', 'contacts:BusinessHomePage'
]

const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24)
export const exchangeEventId = (accountId: string, itemId: string) => `${accountId}:exchange-event:${hash(itemId)}`
export const exchangeContactId = (accountId: string, itemId: string) => `${accountId}:exchange-contact:${hash(itemId)}`

export interface ExchangeFolderRef {
  /** Aerio's calendar/contacts folder key (`<accountId>:<hash>`). */
  key: string
  accountId: string
  name: string
  color: string
  canWrite: boolean
}

// --- Recurrence -------------------------------------------------------------------------------

const EWS_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DAY_GROUPS: Record<string, string[]> = {
  Day: EWS_DAYS, Weekday: EWS_DAYS.slice(1, 6), WeekendDay: [EWS_DAYS[0], EWS_DAYS[6]]
}

const ewsDaysToGraph = (value: string | undefined) => (value ?? '').split(/\s+/).filter(Boolean).flatMap((day) => DAY_GROUPS[day] ?? [day]).map((day) => day.toLowerCase())
const dateOnly = (value: string | undefined) => value?.slice(0, 10)

/** EWS <Recurrence> → Graph-shaped recurrence (for graphRecurrenceToRule). */
export function ewsRecurrenceToGraph(recurrence: XmlElement | undefined): GraphRecurrence | undefined {
  if (!recurrence) return undefined
  const patternElement = recurrence.children.find((child) => /Recurrence$/.test(child.name) && !/^(NoEnd|EndDate|Numbered)Recurrence$/.test(child.name))
  const rangeElement = recurrence.children.find((child) => /^(NoEnd|EndDate|Numbered)Recurrence$/.test(child.name))
  if (!patternElement) return undefined
  const types: Record<string, string> = {
    DailyRecurrence: 'daily', WeeklyRecurrence: 'weekly', AbsoluteMonthlyRecurrence: 'absoluteMonthly', RelativeMonthlyRecurrence: 'relativeMonthly',
    AbsoluteYearlyRecurrence: 'absoluteYearly', RelativeYearlyRecurrence: 'relativeYearly'
  }
  const type = types[patternElement.name]
  if (!type) return undefined
  const month = tText(patternElement, 'Month')
  const index = tText(patternElement, 'DayOfWeekIndex')
  const days = tText(patternElement, 'DaysOfWeek')
  return {
    pattern: {
      type,
      interval: tNumber(patternElement, 'Interval') ?? 1,
      ...(days ? { daysOfWeek: ewsDaysToGraph(days) } : {}),
      ...(tNumber(patternElement, 'DayOfMonth') ? { dayOfMonth: tNumber(patternElement, 'DayOfMonth') } : {}),
      ...(month && MONTHS.includes(month) ? { month: MONTHS.indexOf(month) + 1 } : {}),
      ...(index ? { index: index.toLowerCase() } : {}),
      ...(tText(patternElement, 'FirstDayOfWeek') ? { firstDayOfWeek: tText(patternElement, 'FirstDayOfWeek')!.toLowerCase() } : {})
    },
    range: rangeElement ? {
      type: rangeElement.name === 'NoEndRecurrence' ? 'noEnd' : rangeElement.name === 'EndDateRecurrence' ? 'endDate' : 'numbered',
      startDate: dateOnly(tText(rangeElement, 'StartDate')),
      ...(tText(rangeElement, 'EndDate') ? { endDate: dateOnly(tText(rangeElement, 'EndDate')) } : {}),
      ...(tNumber(rangeElement, 'NumberOfOccurrences') ? { numberOfOccurrences: tNumber(rangeElement, 'NumberOfOccurrences') } : {})
    } : undefined
  }
}

const capital = (value: string) => value[0].toUpperCase() + value.slice(1)

/** RRULE → EWS <t:Recurrence>; rules EWS cannot hold throw UnsupportedRecurrenceError. */
export function ruleToEwsRecurrence(rule: string, startDate: string) {
  const graph = ruleToGraphRecurrence(rule, startDate, 'UTC')
  const pattern = graph.pattern ?? {}
  const range = graph.range ?? {}
  const days = (pattern.daysOfWeek ?? []).map(capital).join(' ')
  const interval = element('Interval', pattern.interval ?? 1)
  const month = pattern.month ? element('Month', MONTHS[pattern.month - 1]) : ''
  const index = pattern.index ? element('DayOfWeekIndex', capital(pattern.index)) : ''
  if ((pattern.type === 'absoluteYearly' || pattern.type === 'relativeYearly') && (pattern.interval ?? 1) !== 1) {
    throw new UnsupportedRecurrenceError('Exchange cannot repeat an event every few years; the repeat rule was left unchanged')
  }
  const body = pattern.type === 'daily' ? `<t:DailyRecurrence>${interval}</t:DailyRecurrence>`
    : pattern.type === 'weekly' ? `<t:WeeklyRecurrence>${interval}${element('DaysOfWeek', days)}${pattern.firstDayOfWeek ? element('FirstDayOfWeek', capital(pattern.firstDayOfWeek)) : ''}</t:WeeklyRecurrence>`
      : pattern.type === 'absoluteMonthly' ? `<t:AbsoluteMonthlyRecurrence>${interval}${element('DayOfMonth', pattern.dayOfMonth)}</t:AbsoluteMonthlyRecurrence>`
        : pattern.type === 'relativeMonthly' ? `<t:RelativeMonthlyRecurrence>${interval}${element('DaysOfWeek', days)}${index}</t:RelativeMonthlyRecurrence>`
          : pattern.type === 'absoluteYearly' ? `<t:AbsoluteYearlyRecurrence>${element('DayOfMonth', pattern.dayOfMonth)}${month}</t:AbsoluteYearlyRecurrence>`
            : pattern.type === 'relativeYearly' ? `<t:RelativeYearlyRecurrence>${element('DaysOfWeek', days)}${index}${month}</t:RelativeYearlyRecurrence>` : undefined
  if (!body) throw new UnsupportedRecurrenceError('Exchange cannot store this repeat rule; it was left unchanged')
  const start = element('StartDate', range.startDate ?? startDate)
  const end = range.type === 'endDate' && range.endDate ? `<t:EndDateRecurrence>${start}${element('EndDate', range.endDate)}</t:EndDateRecurrence>`
    : range.type === 'numbered' && range.numberOfOccurrences ? `<t:NumberedRecurrence>${start}${element('NumberOfOccurrences', range.numberOfOccurrences)}</t:NumberedRecurrence>`
      : `<t:NoEndRecurrence>${start}</t:NoEndRecurrence>`
  return `<t:Recurrence>${body}${end}</t:Recurrence>`
}

// --- Calendar items ---------------------------------------------------------------------------

const RESPONSES: Record<string, AttendeeResponse> = { Accept: 'accepted', Tentative: 'tentative', Decline: 'declined', NoResponseReceived: 'needs-action', Unknown: 'needs-action', Organizer: 'accepted' }

function attendeesOf(item: XmlElement, list: string, role: EventAttendee['role'], kind?: EventAttendee['kind']): EventAttendee[] {
  return ts(t(item, list), 'Attendee').flatMap((attendee) => {
    const email = path(attendee, 'Mailbox', 'EmailAddress')?.text.trim()
    if (!email) return []
    const name = path(attendee, 'Mailbox', 'Name')?.text.trim()
    const response = RESPONSES[tText(attendee, 'ResponseType') ?? ''] ?? 'needs-action'
    return [{ email, ...(name ? { name } : {}), ...(role && role !== 'required' ? { role } : {}), ...(kind ? { kind } : {}), response }]
  })
}

function allDayDate(value: string, zone: string | undefined) {
  if (!zone) return value.slice(0, 10)
  return isoDay(wallParts(value, zone).day)
}

/** CalendarItem (Single, RecurringMaster, or Exception) → SyncedCalendarEvent. */
export function mapCalendarItem(folder: ExchangeFolderRef, item: XmlElement, master?: { eventId: string; uid?: string }): SyncedCalendarEvent | undefined {
  const itemId = t(item, 'ItemId')?.attributes.Id
  const startRaw = tText(item, 'Start')
  const endRaw = tText(item, 'End')
  if (!itemId || !startRaw || !endRaw || tBool(item, 'IsCancelled')) return undefined
  const start = new Date(startRaw).toISOString()
  const end = new Date(endRaw).toISOString()
  const zone = resolveTimeZoneName(tText(item, 'StartTimeZoneId'))
  const allDay = tBool(item, 'IsAllDayEvent')
  const isMaster = tText(item, 'CalendarItemType') === 'RecurringMaster'
  const recurrenceRule = isMaster ? graphRecurrenceToRule(ewsRecurrenceToGraph(t(item, 'Recurrence'))) : undefined
  const deleted = isMaster ? ts(t(item, 'DeletedOccurrences'), 'DeletedOccurrence').flatMap((entry) => {
    const value = tText(entry, 'Start')
    return value ? [allDay ? allDayDate(new Date(value).toISOString(), zone) : new Date(value).toISOString()] : []
  }) : []
  const myResponse = tText(item, 'MyResponseType')
  const organizerEmail = path(item, 'Organizer', 'Mailbox', 'EmailAddress')?.text.trim()
  const organizer = participant(organizerEmail, path(item, 'Organizer', 'Mailbox', 'Name')?.text.trim(), myResponse === 'Organizer')
  const details = [...attendeesOf(item, 'RequiredAttendees', 'required'), ...attendeesOf(item, 'OptionalAttendees', 'optional'), ...attendeesOf(item, 'Resources', 'non-participant', 'resource')]
  const uid = tText(item, 'UID') ?? master?.uid
  const originalStart = master ? tText(item, 'OriginalStart') : undefined
  const description = tText(item, 'Body')
  const location = tText(item, 'Location')
  const reminderSet = tBool(item, 'ReminderIsSet')
  const sequence = tNumber(item, 'AppointmentSequenceNumber')
  const attendeeCopy = Boolean(tBool(item, 'IsMeeting')) && myResponse !== undefined && myResponse !== 'Organizer'
  const event: SyncedCalendarEvent = {
    id: exchangeEventId(folder.accountId, itemId),
    remoteId: itemId,
    accountId: folder.accountId,
    provider: 'exchange',
    calendarId: folder.key,
    title: tText(item, 'Subject')?.trim() || '(Untitled event)',
    start: allDay ? allDayDate(start, zone) : start,
    end: allDay ? allDayDate(end, zone) : end,
    ...(location ? { location } : {}),
    ...(description ? { description } : {}),
    color: folder.color,
    attendees: [],
    reminderMinutes: reminderSet === false ? 0 : tNumber(item, 'ReminderMinutesBeforeStart') ?? 15,
    recurrence: recurrenceRule ? (/FREQ=DAILY/.test(recurrenceRule) ? 'daily' : /FREQ=WEEKLY/.test(recurrenceRule) ? 'weekly' : /FREQ=MONTHLY/.test(recurrenceRule) ? 'monthly' : 'none') : 'none',
    readOnly: !folder.canWrite || attendeeCopy,
    ...(allDay ? { allDay: true } : {}),
    ...(zone && !allDay ? { timeZone: zone } : {}),
    ...(recurrenceRule ? { recurrenceRule } : {}),
    ...(deleted.length ? { recurrenceExceptions: deleted } : {}),
    ...(master ? { seriesId: master.eventId } : {}),
    ...(master && originalStart ? { recurrenceId: allDay ? allDayDate(new Date(originalStart).toISOString(), zone) : new Date(originalStart).toISOString(), originalStart: allDay ? allDayDate(new Date(originalStart).toISOString(), zone) : new Date(originalStart).toISOString() } : {}),
    ...(uid ? { sourceUid: uid, icalUid: uid } : {}),
    ...(organizer ? { organizer } : {}),
    ...(sequence !== undefined ? { sequence } : {})
  }
  return withAttendees(event, details)
}

/** ItemIds of a master's modified occurrences (each is fetched separately). */
export const modifiedOccurrenceIds = (item: XmlElement) =>
  ts(t(item, 'ModifiedOccurrences'), 'Occurrence').flatMap((occurrence) => t(occurrence, 'ItemId')?.attributes.Id ?? [])

const localZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return 'UTC' } }

/** The Windows time zone id used for an event's StartTimeZone/EndTimeZone and TimeZoneContext. */
export function eventWindowsZone(event: CalendarEvent) {
  const iana = event.timeZone && isIanaTimeZone(event.timeZone) ? event.timeZone : localZone()
  return windowsTimeZoneName(iana) ?? 'UTC'
}

function timesXml(event: CalendarEvent) {
  if (isAllDayEvent(event)) {
    // Midnight wall times in the event's zone, interpreted through the request's TimeZoneContext.
    return { start: `${event.start.slice(0, 10)}T00:00:00`, end: `${event.end.slice(0, 10)}T00:00:00`, allDay: true }
  }
  return { start: new Date(event.start).toISOString(), end: new Date(event.end).toISOString(), allDay: false }
}

const mailboxXml = (attendee: EventAttendee) => `<t:Attendee><t:Mailbox>${attendee.name ? element('Name', attendee.name) : ''}${element('EmailAddress', attendee.email)}</t:Mailbox></t:Attendee>`
const attendeeLists = (event: CalendarEvent) => {
  const all = eventAttendees(event)
  const resources = all.filter((attendee) => attendee.kind === 'room' || attendee.kind === 'resource' || attendee.role === 'non-participant')
  const optional = all.filter((attendee) => !resources.includes(attendee) && attendee.role === 'optional')
  const required = all.filter((attendee) => !resources.includes(attendee) && !optional.includes(attendee) && attendee.role !== 'chair')
  return { required, optional, resources }
}
const listXml = (name: string, attendees: EventAttendee[]) => attendees.length ? `<t:${name}>${attendees.map(mailboxXml).join('')}</t:${name}>` : ''
const bodyXml = (text: string) => `<t:Body BodyType="Text">${xmlText(text)}</t:Body>`

/** A new CalendarItem element; returns the Windows zone to put in TimeZoneContext. */
export function calendarItemXml(event: CalendarEvent) {
  const zone = eventWindowsZone(event)
  const times = timesXml(event)
  const lists = attendeeLists(event)
  const rule = event.seriesId ? undefined : eventRecurrenceRule(event)
  const recurrence = rule && event.recurrenceRule ? ruleToEwsRecurrence(event.recurrenceRule, times.start.slice(0, 10))
    : rule ? ruleToEwsRecurrence(`FREQ=${event.recurrence!.toUpperCase()}`, times.start.slice(0, 10)) : ''
  const xml = '<t:CalendarItem>' +
    element('Subject', event.title) + bodyXml(event.description ?? '') +
    element('ReminderIsSet', event.reminderMinutes > 0) + element('ReminderMinutesBeforeStart', Math.max(0, event.reminderMinutes)) +
    element('Start', times.start) + element('End', times.end) + element('IsAllDayEvent', times.allDay) + element('Location', event.location ?? '') +
    listXml('RequiredAttendees', lists.required) + listXml('OptionalAttendees', lists.optional) + listXml('Resources', lists.resources) +
    recurrence + `<t:StartTimeZone Id="${attr(zone)}"/><t:EndTimeZone Id="${attr(zone)}"/>` +
    '</t:CalendarItem>'
  return { xml, zone, hasAttendees: lists.required.length + lists.optional.length + lists.resources.length > 0 }
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((value, index) => value.toLowerCase() === b[index]?.toLowerCase())

/** SetItemField updates for the fields that changed between the synchronized copy and the edit. */
export function calendarItemUpdates(current: CalendarEvent, next: CalendarEvent) {
  const zone = eventWindowsZone(next)
  const field = (uri: string, value: string) => setItemField(uri, 'CalendarItem', value)
  const updates: string[] = []
  if (next.title !== current.title) updates.push(field('item:Subject', element('Subject', next.title)))
  if ((next.description ?? '') !== (current.description ?? '')) updates.push(field('item:Body', bodyXml(next.description ?? '')))
  if (next.reminderMinutes !== current.reminderMinutes) {
    updates.push(field('item:ReminderIsSet', element('ReminderIsSet', next.reminderMinutes > 0)))
    if (next.reminderMinutes > 0) updates.push(field('item:ReminderMinutesBeforeStart', element('ReminderMinutesBeforeStart', next.reminderMinutes)))
  }
  const timing = next.start !== current.start || next.end !== current.end || Boolean(next.allDay) !== Boolean(current.allDay) || (next.timeZone ?? '') !== (current.timeZone ?? '')
  if (timing) {
    const times = timesXml(next)
    updates.push(field('calendar:Start', element('Start', times.start)), field('calendar:End', element('End', times.end)), field('calendar:IsAllDayEvent', element('IsAllDayEvent', times.allDay)))
    updates.push(field('calendar:StartTimeZone', `<t:StartTimeZone Id="${attr(zone)}"/>`), field('calendar:EndTimeZone', `<t:EndTimeZone Id="${attr(zone)}"/>`))
  }
  if ((next.location ?? '') !== (current.location ?? '')) updates.push(field('calendar:Location', element('Location', next.location ?? '')))
  const before = attendeeLists(current)
  const after = attendeeLists(next)
  for (const [uri, name, key] of [['calendar:RequiredAttendees', 'RequiredAttendees', 'required'], ['calendar:OptionalAttendees', 'OptionalAttendees', 'optional'], ['calendar:Resources', 'Resources', 'resources']] as const) {
    if (sameList(before[key].map((item) => item.email), after[key].map((item) => item.email))) continue
    updates.push(after[key].length ? field(uri, listXml(name, after[key])) : deleteItemField(uri))
  }
  if (!next.seriesId && (next.recurrenceRule ?? next.recurrence ?? 'none') !== (current.recurrenceRule ?? current.recurrence ?? 'none')) {
    const rule = eventRecurrenceRule(next)
    const start = timesXml(next).start.slice(0, 10)
    updates.push(rule ? field('calendar:Recurrence', next.recurrenceRule ? ruleToEwsRecurrence(next.recurrenceRule, start) : ruleToEwsRecurrence(`FREQ=${next.recurrence!.toUpperCase()}`, start)) : deleteItemField('calendar:Recurrence'))
  }
  return { updates, zone, attendeesChanged: updates.some((update) => /Attendees|Resources/.test(update)) || timing }
}

// --- Contacts ---------------------------------------------------------------------------------

const EMAIL_KEYS = ['EmailAddress1', 'EmailAddress2', 'EmailAddress3']
const PHONE_KEYS: Record<string, string> = { cell: 'MobilePhone', mobile: 'MobilePhone', work: 'BusinessPhone', home: 'HomePhone', fax: 'BusinessFax', pager: 'Pager', other: 'OtherTelephone' }
const PHONE_TYPES: Record<string, string> = { MobilePhone: 'cell', BusinessPhone: 'work', BusinessPhone2: 'work', HomePhone: 'home', HomePhone2: 'home', BusinessFax: 'fax', HomeFax: 'fax', Pager: 'pager', OtherTelephone: 'other', PrimaryPhone: 'other', CompanyMainPhone: 'work' }

const entries = (container: XmlElement | undefined) => (container?.children ?? []).filter((child) => child.name === 'Entry' && child.text.trim()).map((child) => ({ key: child.attributes.Key ?? '', value: child.text.trim() }))

export function mapContact(folder: ExchangeFolderRef, item: XmlElement): SyncedContact | undefined {
  const id = t(item, 'ItemId')
  if (!id?.attributes.Id) return undefined
  const given = tText(item, 'GivenName')
  const surname = tText(item, 'Surname')
  const name = tText(item, 'DisplayName')?.trim() || `${given ?? ''} ${surname ?? ''}`.trim()
  if (!name) return undefined
  const emails = entries(t(item, 'EmailAddresses')).filter((entry) => EMAIL_KEYS.includes(entry.key)).sort((a, b) => a.key.localeCompare(b.key))
  const phones = entries(t(item, 'PhoneNumbers'))
  const primaryPhone = phones.find((entry) => entry.key === 'MobilePhone') ?? phones.find((entry) => entry.key === 'BusinessPhone') ?? phones.find((entry) => entry.key === 'HomePhone') ?? phones[0]
  const categories = ts(t(item, 'Categories'), 'String').map((value) => value.text.trim()).filter(Boolean)
  const notes = tText(item, 'Body')
  const company = tText(item, 'CompanyName')
  const title = tText(item, 'JobTitle')
  const nickname = tText(item, 'Nickname')
  const birthday = tText(item, 'Birthday')?.slice(0, 10)
  const url = tText(item, 'BusinessHomePage')
  return {
    id: exchangeContactId(folder.accountId, id.attributes.Id),
    remoteId: id.attributes.Id,
    accountId: folder.accountId,
    provider: 'exchange',
    ...(id.attributes.ChangeKey ? { revision: id.attributes.ChangeKey } : {}),
    folderId: folder.key,
    name,
    email: emails[0]?.value ?? '',
    ...(emails.length > 1 ? { emails: emails.map((entry) => ({ value: entry.value })) } : {}),
    ...(primaryPhone ? { phone: primaryPhone.value } : {}),
    ...(phones.length > 1 ? { phones: phones.map((entry): ContactField => ({ value: entry.value, ...(PHONE_TYPES[entry.key] ? { type: PHONE_TYPES[entry.key] } : {}) })) } : {}),
    ...(company ? { company } : {}),
    ...(title ? { title } : {}),
    ...(notes ? { notes } : {}),
    ...(nickname ? { nickname } : {}),
    ...(birthday && /^\d{4}-\d{2}-\d{2}$/.test(birthday) ? { birthday } : {}),
    ...(url ? { urls: [{ value: url }] } : {}),
    ...(given || surname ? { nameParts: [surname ?? '', given ?? ''] } : {}),
    group: categories[0] ?? folder.name,
    ...(categories.length ? { groups: categories } : {}),
    favorite: false,
    color: folder.color,
    readOnly: !folder.canWrite,
    providerData: { phoneKeys: phones.map((entry) => entry.key), emailCount: emails.length }
  }
}

const splitName = (contact: Contact) => {
  if (contact.nameParts?.length) return { surname: contact.nameParts[0] || undefined, given: contact.nameParts[1] || undefined }
  const parts = contact.name.trim().split(/\s+/)
  const surname = parts.length > 1 ? parts.pop() : undefined
  return { given: parts.join(' ') || contact.name.trim(), surname }
}

const contactEmails = (contact: Contact) => [...new Set([contact.email, ...(contact.emails ?? []).map((item) => item.value)].map((value) => value?.trim()).filter((value): value is string => Boolean(value)))].slice(0, 3)

function contactPhones(contact: Contact): { key: string; value: string }[] {
  const typed = (contact.phones ?? []).filter((phone) => phone.value.trim())
  const result: { key: string; value: string }[] = []
  for (const phone of typed) {
    const key = PHONE_KEYS[(phone.type ?? '').toLowerCase().split(',')[0]] ?? 'OtherTelephone'
    if (!result.some((item) => item.key === key)) result.push({ key, value: phone.value.trim() })
  }
  if (contact.phone?.trim() && !result.some((item) => item.value === contact.phone!.trim())) {
    const key = ['MobilePhone', 'BusinessPhone', 'HomePhone', 'OtherTelephone'].find((candidate) => !result.some((item) => item.key === candidate))
    if (key) result.unshift({ key, value: contact.phone.trim() })
  }
  return result
}

const categoriesOf = (contact: Contact, folderName: string) => [...new Set((contact.groups?.length ? contact.groups : [contact.group]).map((value) => value?.trim()).filter((value): value is string => Boolean(value) && value !== folderName))]

export function contactXml(contact: Contact, folderName: string) {
  const { given, surname } = splitName(contact)
  const emails = contactEmails(contact)
  const phones = contactPhones(contact)
  const categories = categoriesOf(contact, folderName)
  return '<t:Contact>' +
    (contact.notes ? bodyXml(contact.notes) : '') +
    (categories.length ? `<t:Categories>${categories.map((value) => element('String', value)).join('')}</t:Categories>` : '') +
    element('DisplayName', contact.name) + element('GivenName', given) + (contact.nickname ? element('Nickname', contact.nickname) : '') + (contact.company ? element('CompanyName', contact.company) : '') +
    (emails.length ? `<t:EmailAddresses>${emails.map((value, index) => `<t:Entry Key="${EMAIL_KEYS[index]}">${xmlText(value)}</t:Entry>`).join('')}</t:EmailAddresses>` : '') +
    (phones.length ? `<t:PhoneNumbers>${phones.map((phone) => `<t:Entry Key="${phone.key}">${xmlText(phone.value)}</t:Entry>`).join('')}</t:PhoneNumbers>` : '') +
    (contact.title ? element('JobTitle', contact.title) : '') + (surname ? element('Surname', surname) : '') +
    '</t:Contact>'
}

export function contactUpdates(current: SyncedContact, next: Contact, folderName: string) {
  const field = (uri: string, value: string) => setItemField(uri, 'Contact', value)
  const text = (uri: string, name: string, before: string | undefined, after: string | undefined) => {
    if ((before ?? '') === (after ?? '')) return []
    return [after ? field(uri, element(name, after)) : deleteItemField(uri)]
  }
  const beforeName = splitName(current)
  const afterName = splitName(next)
  const updates = [
    ...text('contacts:DisplayName', 'DisplayName', current.name, next.name),
    ...text('contacts:GivenName', 'GivenName', beforeName.given, afterName.given),
    ...text('contacts:Surname', 'Surname', beforeName.surname, afterName.surname),
    ...text('contacts:Nickname', 'Nickname', current.nickname, next.nickname),
    ...text('contacts:CompanyName', 'CompanyName', current.company, next.company),
    ...text('contacts:JobTitle', 'JobTitle', current.title, next.title)
  ]
  if ((current.notes ?? '') !== (next.notes ?? '')) updates.push(next.notes ? field('item:Body', bodyXml(next.notes)) : deleteItemField('item:Body'))
  const beforeCategories = categoriesOf(current, folderName)
  const afterCategories = categoriesOf(next, folderName)
  if (!sameList(beforeCategories, afterCategories)) updates.push(afterCategories.length ? field('item:Categories', `<t:Categories>${afterCategories.map((value) => element('String', value)).join('')}</t:Categories>`) : deleteItemField('item:Categories'))
  const beforeEmails = contactEmails(current)
  const afterEmails = contactEmails(next)
  EMAIL_KEYS.forEach((key, index) => {
    if ((beforeEmails[index] ?? '') === (afterEmails[index] ?? '')) return
    updates.push(afterEmails[index]
      ? setIndexedField('contacts:EmailAddress', key, 'Contact', `<t:EmailAddresses><t:Entry Key="${key}">${xmlText(afterEmails[index])}</t:Entry></t:EmailAddresses>`)
      : deleteIndexedField('contacts:EmailAddress', key))
  })
  const beforePhones = new Map(contactPhones(current).map((phone) => [phone.key, phone.value]))
  const afterPhones = new Map(contactPhones(next).map((phone) => [phone.key, phone.value]))
  // Phone slots are rewritten only when the numbers themselves changed, so untouched server
  // slots (BusinessPhone2, CarPhone, ...) are never renumbered by a name or email edit.
  const phonesChanged = !sameList([...beforePhones.values()].sort(), [...afterPhones.values()].sort())
  const known = phonesChanged ? new Set([...beforePhones.keys(), ...afterPhones.keys()]) : new Set<string>()
  for (const key of known) {
    if (beforePhones.get(key) === afterPhones.get(key)) continue
    const value = afterPhones.get(key)
    updates.push(value ? setIndexedField('contacts:PhoneNumber', key, 'Contact', `<t:PhoneNumbers><t:Entry Key="${key}">${xmlText(value)}</t:Entry></t:PhoneNumbers>`) : deleteIndexedField('contacts:PhoneNumber', key))
  }
  return updates
}

export const itemTitle = (kind: 'event' | 'contact', data: { title?: string; name?: string } | undefined) => (kind === 'event' ? data?.title : data?.name)?.slice(0, 200)
