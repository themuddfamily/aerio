// Plans "this event / this and following / all events" edits and deletes for recurring series. Local
// calendars apply the plan directly; provider connectors reuse the time-shifting helpers.
import type { CalendarEvent, RecurrenceEditScope } from '../types'
import {
  eventRecurrenceRule, eventZone, formatRecurrenceRule, instantFromParts, isAllDayEvent, isOverrideOf, isoDay,
  occurrenceKey, occurrencesBefore, parseRecurrenceRule, simpleRecurrenceFor, untilBefore, wallParts
} from './recurrence'

export interface LocalRecurrencePlan {
  save: CalendarEvent[]
  remove: string[]
}

type Timing = Pick<CalendarEvent, 'start' | 'end' | 'allDay' | 'timeZone'>

// Removes view-only expansion fields before an event is stored.
export function storedEvent(event: CalendarEvent): CalendarEvent {
  const { occurrenceOf: _occurrenceOf, ...rest } = event
  return rest
}

// Moves a series' first start by the change made to one occurrence: the same number of calendar days and
// the edited wall-clock time in the edited zone, so DST never shifts the remaining occurrences.
export function shiftSeriesTiming(master: Timing, occurrenceStart: string, edited: Timing): Pick<CalendarEvent, 'start' | 'end' | 'allDay'> {
  const zone = eventZone(edited.timeZone ? edited : master)
  const occurrence = wallParts(occurrenceStart, zone)
  const next = wallParts(edited.start, zone)
  const day = wallParts(master.start, zone).day + (next.day - occurrence.day)
  if (isAllDayEvent(edited)) {
    const length = Math.max(1, wallParts(edited.end, zone).day - next.day)
    return { start: isoDay(day), end: isoDay(day + length), allDay: true }
  }
  const start = instantFromParts({ ...next, day }, zone)
  const duration = Math.max(60_000, Date.parse(edited.end) - Date.parse(edited.start))
  return { start, end: new Date(Date.parse(start) + duration).toISOString(), allDay: undefined }
}

const sameOccurrence = (a: string | undefined, b: string | undefined) => Boolean(a && b) && occurrenceKey(a!) === occurrenceKey(b!)
const atOrAfter = (value: string, split: string) => /^\d{4}-\d{2}-\d{2}$/.test(split)
  ? value.slice(0, 10) >= split
  : Date.parse(value) >= Date.parse(split)

export function findSeriesMaster(events: CalendarEvent[], occurrence: CalendarEvent) {
  if (occurrence.occurrenceOf) return events.find((event) => event.id === occurrence.occurrenceOf)
  if (occurrence.recurrenceId) return events.find((event) => !event.recurrenceId && isOverrideOf(occurrence, event))
  return undefined
}

const occurrenceStartOf = (occurrence: CalendarEvent) => occurrence.originalStart ?? occurrence.recurrenceId ?? occurrence.start

function seriesFields(event: CalendarEvent): CalendarEvent {
  const next = storedEvent(event)
  delete next.seriesId
  delete next.originalStart
  delete next.recurrenceId
  return next
}

function withRule(event: CalendarEvent, rule: string | undefined): CalendarEvent {
  const parsed = parseRecurrenceRule(rule)
  const next = { ...event, recurrence: simpleRecurrenceFor(parsed) }
  if (parsed) next.recurrenceRule = formatRecurrenceRule(parsed)
  else {
    delete next.recurrenceRule
    delete next.recurrenceExceptions
  }
  return next
}

// The rule the edited event asks for: the editor always sets `recurrenceRule` explicitly, otherwise the
// master's rule is kept.
const requestedRule = (edited: CalendarEvent, master: CalendarEvent) => 'recurrenceRule' in edited || edited.recurrence !== master.recurrence
  ? edited.recurrenceRule ?? (edited.recurrence && edited.recurrence !== 'none' ? `FREQ=${edited.recurrence.toUpperCase()}` : undefined)
  : master.recurrenceRule ?? (master.recurrence && master.recurrence !== 'none' ? `FREQ=${master.recurrence.toUpperCase()}` : undefined)

function truncatedMaster(master: CalendarEvent, split: string) {
  const rule = eventRecurrenceRule(master)
  if (!rule) return master
  return withRule(master, formatRecurrenceRule({ ...rule, count: undefined, until: untilBefore(split, isAllDayEvent(master)) }))
}

export function planLocalRecurrenceSave(
  events: CalendarEvent[], occurrence: CalendarEvent, edited: CalendarEvent, scope: RecurrenceEditScope, newId: () => string
): LocalRecurrencePlan {
  const master = findSeriesMaster(events, occurrence)
  if (!master) return { save: [storedEvent(edited)], remove: [] }
  const split = occurrenceStartOf(occurrence)
  const overrides = events.filter((event) => isOverrideOf(event, master))
  if (scope === 'occurrence') {
    const override: CalendarEvent = {
      ...storedEvent(edited), id: occurrence.recurrenceId ? occurrence.id : newId(), seriesId: master.id, recurrenceId: split,
      ...(master.sourceUid ? { sourceUid: master.sourceUid } : {}), recurrence: 'none'
    }
    delete override.recurrenceRule
    delete override.recurrenceExceptions
    delete override.originalStart
    return { save: [override], remove: [] }
  }
  if (scope === 'following' && !sameOccurrence(split, master.start) && eventRecurrenceRule(master)) {
    const rule = parseRecurrenceRule(requestedRule(edited, master))
    const masterRule = eventRecurrenceRule(master)!
    if (rule?.count !== undefined && rule.count === masterRule.count) rule.count = Math.max(1, rule.count - occurrencesBefore(master, split))
    const successor: CalendarEvent = withRule({ ...seriesFields(edited), id: newId() }, rule ? formatRecurrenceRule(rule) : undefined)
    delete successor.sourceUid
    const exceptions = (master.recurrenceExceptions ?? []).filter((value) => atOrAfter(value, split))
    if (rule && exceptions.length) successor.recurrenceExceptions = exceptions
    else delete successor.recurrenceExceptions
    const moved = overrides.filter((event) => atOrAfter(event.recurrenceId!, split)).map((event) => {
      const next = { ...event, seriesId: successor.id }
      delete next.sourceUid
      return next
    })
    return { save: [truncatedMaster(master, split), successor, ...moved], remove: [] }
  }
  // Entire series (or "following" from the first occurrence).
  const timing = shiftSeriesTiming(master, split, edited)
  const shift = (value: string) => shiftSeriesTiming({ ...master, start: value, end: value }, split, edited).start
  const moved = sameOccurrence(timing.start, master.start) ? undefined : shift
  const next: CalendarEvent = withRule({ ...seriesFields(edited), id: master.id, ...timing }, requestedRule(edited, master))
  if (!timing.allDay) delete next.allDay
  if (master.sourceUid) next.sourceUid = master.sourceUid
  if (next.recurrenceRule && master.recurrenceExceptions?.length) next.recurrenceExceptions = moved ? master.recurrenceExceptions.map(moved) : master.recurrenceExceptions
  const shiftedOverrides = moved ? overrides.map((event) => ({ ...event, recurrenceId: moved(event.recurrenceId!) })) : []
  return { save: [next, ...shiftedOverrides], remove: [] }
}

export function planLocalRecurrenceDelete(events: CalendarEvent[], occurrence: CalendarEvent, scope: RecurrenceEditScope): LocalRecurrencePlan {
  const master = findSeriesMaster(events, occurrence)
  if (!master) return { save: [], remove: [occurrence.id] }
  const split = occurrenceStartOf(occurrence)
  const overrides = events.filter((event) => isOverrideOf(event, master))
  if (scope === 'occurrence') {
    const exceptions = [...new Set([...(master.recurrenceExceptions ?? []), split])]
    return { save: [{ ...master, recurrenceExceptions: exceptions }], remove: occurrence.recurrenceId ? [occurrence.id] : [] }
  }
  if (scope === 'following' && !sameOccurrence(split, master.start) && eventRecurrenceRule(master)) {
    return { save: [truncatedMaster(master, split)], remove: overrides.filter((event) => atOrAfter(event.recurrenceId!, split)).map((event) => event.id) }
  }
  return { save: [], remove: [master.id, ...overrides.map((event) => event.id)] }
}
