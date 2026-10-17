import { createHash } from 'node:crypto'
import type { DuplicateConfidence, DuplicateItem, DuplicateReasonCode } from '../../src/duplicate-cleanup-types'
import type { SyncedCalendarEvent } from '../../src/productivity-types'
import type { CalendarEvent } from '../../src/types'
import { DuplicateUnion, normalizeText, suggestedKeeper } from '../../src/lib/duplicate-grouping'

// Calendar duplicate scanner (E32). Events are compared inside one calendar only. A
// repeating series is compared as a unit (master plus exceptions or provider instances),
// so an exception is never offered as a duplicate of its own master, and two series only
// match when every occurrence matches.

export type EventDuplicateSource = 'provider' | 'dav' | 'local'

export interface EventCalendarRef {
  id: string
  label: string
  ownerLabel: string
  source: EventDuplicateSource
}

export interface EventDuplicateItem extends DuplicateItem {
  calendarId: string
  source: EventDuplicateSource
  series: boolean
  eventIds: string[]
  revision: string
}

export interface EventDuplicateGroup {
  confidence: DuplicateConfidence
  codes: DuplicateReasonCode[]
  notes: string[]
  keeperId: string
  items: EventDuplicateItem[]
}

interface EventUnit {
  itemId: string
  series: boolean
  events: CalendarEvent[]
  master?: CalendarEvent
}

const time = (value: string | undefined) => {
  const parsed = Date.parse(value ?? '')
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : (value ?? '')
}
const uidOf = (event: CalendarEvent) => (event as SyncedCalendarEvent).icalUid ?? event.sourceUid
const isMaster = (event: CalendarEvent) => Boolean(event.recurrenceRule && !event.seriesId && !event.recurrenceId)

// Stable over key order, so a record re-saved without changes keeps its revision.
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().filter((key) => (value as Record<string, unknown>)[key] !== undefined).map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`
  return JSON.stringify(value)
}

export const eventRevision = (events: CalendarEvent[]) =>
  createHash('sha256').update(stable([...events].sort((a, b) => a.id.localeCompare(b.id)))).digest('hex')

export function eventUnits(calendarId: string, events: CalendarEvent[]): EventUnit[] {
  const visible = events.filter((event) => event.calendarId === calendarId && !event.occurrenceOf)
  const masters = visible.filter(isMaster)
  const masterFor = (event: CalendarEvent) => {
    if (event.seriesId) return masters.find((master) => master.id === event.seriesId || (master as SyncedCalendarEvent).remoteId === event.seriesId)
    if (event.recurrenceId && uidOf(event)) return masters.find((master) => uidOf(master) === uidOf(event))
    return undefined
  }
  const units = new Map<string, EventUnit>()
  for (const master of masters) units.set(`series:${calendarId}:${master.id}`, { itemId: `series:${calendarId}:${master.id}`, series: true, events: [master], master })
  for (const event of visible) {
    if (isMaster(event)) continue
    const master = masterFor(event)
    if (master) {
      units.get(`series:${calendarId}:${master.id}`)!.events.push(event)
      continue
    }
    if (event.seriesId) {
      // Provider feeds list a series as its instances; they form the unit together.
      const key = `series:${calendarId}:${event.seriesId}`
      const unit = units.get(key) ?? { itemId: key, series: true, events: [] }
      unit.events.push(event)
      units.set(key, unit)
      continue
    }
    units.set(`event:${event.id}`, { itemId: `event:${event.id}`, series: false, events: [event] })
  }
  return [...units.values()]
}

const occurrenceSignature = (event: CalendarEvent) =>
  `${time(event.originalStart ?? event.recurrenceId)}>${time(event.start)}|${time(event.end)}|${normalizeText(event.title)}|${normalizeText(event.location)}`

function detailsKey(unit: EventUnit) {
  if (!unit.series) {
    const [event] = unit.events
    return `event|${normalizeText(event.title)}|${time(event.start)}|${time(event.end)}|${normalizeText(event.location)}|${event.allDay ? 'all-day' : 'timed'}`
  }
  const master = unit.master
  const others = unit.events.filter((event) => event !== master).map(occurrenceSignature).sort()
  const head = master
    ? `${normalizeText(master.title)}|${normalizeText(master.location)}|${time(master.start)}|${time(master.end)}|${master.recurrenceRule ?? master.recurrence ?? ''}`
    : `${normalizeText(unit.events[0]?.title)}|${normalizeText(unit.events[0]?.location)}`
  return `series|${head}|${others.join(';')}`
}

function uidKey(unit: EventUnit) {
  if (!unit.series) {
    const [event] = unit.events
    const uid = uidOf(event)
    return uid ? `event|${uid}|${time(event.recurrenceId ?? event.originalStart)}` : undefined
  }
  const uid = unit.master ? uidOf(unit.master) : unit.events.map(uidOf).find(Boolean)
  return uid ? `series|${uid}` : undefined
}

function describe(unit: EventUnit) {
  const lead = unit.master ?? [...unit.events].sort((a, b) => time(a.start).localeCompare(time(b.start)))[0]
  return lead
}

function eventItem(calendar: EventCalendarRef, unit: EventUnit): EventDuplicateItem {
  const lead = describe(unit)
  const readOnly = unit.events.some((event) => (event as SyncedCalendarEvent).readOnly)
  const exceptions = unit.events.filter((event) => event !== unit.master).length
  const blockedReason = readOnly
    ? 'This event is read-only here (for example, an invitation organized by someone else).'
    : unit.series && calendar.source !== 'local'
      ? 'Repeating series in synchronized calendars are listed for review only, because undo could not recreate their exceptions. Delete the extra series from the calendar.'
      : undefined
  const repeats = unit.series
    ? unit.master
      ? `${unit.master.recurrenceRule ?? unit.master.recurrence ?? 'Repeats'}${exceptions ? ` · ${exceptions} exception${exceptions === 1 ? '' : 's'}` : ''}`
      : `${unit.events.length} occurrence${unit.events.length === 1 ? '' : 's'}`
    : 'No'
  return {
    id: unit.itemId,
    calendarId: calendar.id,
    source: calendar.source,
    series: unit.series,
    eventIds: unit.events.map((event) => event.id),
    revision: eventRevision(unit.events),
    title: lead.title,
    ownerLabel: calendar.ownerLabel,
    containerLabel: calendar.label,
    date: lead.start,
    summary: `${lead.allDay ? lead.start.slice(0, 10) : lead.start}${unit.series ? ' · repeating' : ''}`,
    details: [
      { label: 'Title', value: lead.title },
      { label: 'Start', value: lead.start },
      { label: 'End', value: lead.end },
      { label: 'Location', value: lead.location || 'None' },
      { label: 'Repeats', value: repeats },
      { label: 'Attendees', value: lead.attendees.join(', ') || 'None' },
      { label: 'Description', value: (lead.description ?? '').slice(0, 300) || 'None' },
      { label: 'UID', value: (unit.master ? uidOf(unit.master) : unit.events.map(uidOf).find(Boolean)) ?? 'None' },
      { label: 'Calendar', value: calendar.label }
    ],
    completeness: (lead.description ? 1 : 0) + (lead.location ? 1 : 0) + lead.attendees.length + (lead.conference ? 1 : 0) + exceptions / 100,
    removable: !blockedReason,
    ...(blockedReason ? { blockedReason } : {})
  }
}

export function findEventDuplicates(calendar: EventCalendarRef, events: CalendarEvent[]): EventDuplicateGroup[] {
  const units = eventUnits(calendar.id, events)
  const byId = new Map(units.map((unit) => [unit.itemId, unit]))
  const union = new DuplicateUnion()
  const buckets = (key: (unit: EventUnit) => string | undefined, code: DuplicateReasonCode) => {
    const map = new Map<string, EventUnit[]>()
    for (const unit of units) {
      const value = key(unit)
      if (value) map.set(value, [...(map.get(value) ?? []), unit])
    }
    for (const bucket of map.values()) for (const unit of bucket.slice(1)) union.join(bucket[0].itemId, unit.itemId, code)
  }
  buckets(uidKey, 'ical-uid')
  buckets(detailsKey, 'event-details')
  return union.groups().map(({ ids }) => {
    const members = ids.map((id) => byId.get(id)!)
    const sameUid = members.every((unit) => uidKey(unit) && uidKey(unit) === uidKey(members[0]))
    const sameDetails = members.every((unit) => detailsKey(unit) === detailsKey(members[0]))
    const codes: DuplicateReasonCode[] = []
    if (sameUid) codes.push('ical-uid')
    if (sameDetails) codes.push('event-details')
    const notes: string[] = []
    if (!sameDetails) notes.push('These copies share a calendar UID but their details differ. Compare them before removing one.')
    if (!sameUid && !sameDetails) notes.push('Some copies were matched through another copy; review each one.')
    if (members.some((unit) => unit.series)) notes.push('Repeating events are compared as whole series, including every exception.')
    const items = members.map((unit) => eventItem(calendar, unit))
    return {
      confidence: sameUid && sameDetails ? 'high' : sameDetails || sameUid ? 'medium' : 'low',
      codes: codes.length ? codes : ['event-details'],
      notes,
      keeperId: suggestedKeeper(items),
      items
    }
  })
}
