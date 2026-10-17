// Scheduling-assistant helpers: timeline status per attendee, working-hours checks, and slot
// suggestions. All instants are UTC milliseconds; wall-clock math goes through time-zones.ts.

import type { AttendeeAvailability, AvailabilityStatus, WorkingHours } from '../scheduling-types'
import { wallTimeInZone, wallTimeToUtc } from './time-zones'

export type ParticipantRole = 'required' | 'optional' | 'resource'

export interface Participant {
  email: string
  role: ParticipantRole
}

/** What one timeline cell shows for one participant. */
export type CellStatus = 'free' | AvailabilityStatus

export interface SlotSuggestion {
  start: number
  end: number
  /** Optional attendees who are busy or whose availability is unknown. */
  optionalConflicts: string[]
  /** Required attendees and resources whose availability could not be checked. */
  unverified: string[]
}

export const DEFAULT_WORKING_HOURS = (timeZone: string): WorkingHours => ({ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', timeZone })

export function systemTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' }
}

const FALLBACK_ZONES = [
  'UTC', 'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York', 'America/Sao_Paulo',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Helsinki', 'Africa/Johannesburg', 'Asia/Dubai',
  'Asia/Kolkata', 'Asia/Singapore', 'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland'
]

export function selectableTimeZones(): string[] {
  const supported = (Intl as unknown as { supportedValuesOf?(key: string): string[] }).supportedValuesOf
  try { return supported ? supported('timeZone') : FALLBACK_ZONES } catch { return FALLBACK_ZONES }
}

/** Splits the editor's attendee text ("a@x.com, Name <b@y.com>; c@z.com"). */
export function parseAttendeeText(text: string) {
  return text.split(/[,;\n]/).map((value) => value.trim()).filter(Boolean)
}

export function attendeeAddress(value: string) {
  return (value.match(/<([^<>]+)>\s*$/)?.[1] ?? value).trim().toLowerCase()
}

const minutesOf = (value: string) => {
  const match = value.match(/^(\d\d):(\d\d)$/)
  return match ? Number(match[1]) * 60 + Number(match[2]) : NaN
}

/** UTC start of the calendar day containing `ms` in `timeZone`. */
export function startOfZonedDay(ms: number, timeZone: string) {
  const wall = wallTimeInZone(ms, timeZone)
  return wallTimeToUtc({ year: wall.year, month: wall.month, day: wall.day, hour: 0, minute: 0, second: 0 }, timeZone)
}

/** Adds whole calendar days in a zone, so DST changes don't shift midnight. */
export function addZonedDays(dayStart: number, days: number, timeZone: string) {
  const wall = wallTimeInZone(dayStart + 12 * 3_600_000, timeZone)
  const next = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days))
  return wallTimeToUtc({ year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate(), hour: 0, minute: 0, second: 0 }, timeZone)
}

/** Whether [start, end) falls entirely inside the working hours of one working day. */
export function withinWorkingHours(start: number, end: number, hours: WorkingHours | undefined) {
  if (!hours) return true
  const from = minutesOf(hours.start), to = minutesOf(hours.end)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return true
  const a = wallTimeInZone(start, hours.timeZone)
  const b = wallTimeInZone(end - 1, hours.timeZone)
  if (a.year !== b.year || a.month !== b.month || a.day !== b.day) return false
  const weekday = new Date(Date.UTC(a.year, a.month - 1, a.day)).getUTCDay()
  if (!hours.days.includes(weekday)) return false
  const startMinute = a.hour * 60 + a.minute
  const endMinute = startMinute + Math.ceil((end - start) / 60_000)
  return startMinute >= from && endMinute <= to
}

const severity: Record<CellStatus, number> = { free: 0, workingElsewhere: 1, tentative: 2, unknown: 3, busy: 4, oof: 5 }

/** The most significant status overlapping [start, end); unknown attendees are always "unknown". */
export function statusDuring(availability: AttendeeAvailability | undefined, start: number, end: number): CellStatus {
  if (!availability || !availability.known) return 'unknown'
  let status: CellStatus = 'free'
  for (const item of availability.busy) {
    const itemStart = Date.parse(item.start), itemEnd = Date.parse(item.end)
    if (itemStart < end && itemEnd > start && severity[item.status] > severity[status]) status = item.status
  }
  return status
}

/** Free and "working elsewhere" time can hold a meeting; tentative, busy, away, and unknown cannot. */
export const isAvailable = (status: CellStatus) => status === 'free' || status === 'workingElsewhere'

export interface SuggestOptions {
  participants: Participant[]
  availability: AttendeeAvailability[]
  durationMinutes: number
  from: number
  to: number
  /** The organizer's own working hours (user setting). */
  workingHours?: WorkingHours
  /** Also keep to each attendee's provider-reported working hours when known. */
  respectAttendeeHours?: boolean
  stepMinutes?: number
  limit?: number
  now?: number
}

/**
 * Next slots where every required attendee and resource with known availability is free.
 * Attendees whose availability is unknown never block a slot but are listed as unverified, so the
 * organizer can see the suggestion was not confirmed for them.
 */
export function suggestSlots(options: SuggestOptions): SlotSuggestion[] {
  const step = (options.stepMinutes ?? 30) * 60_000
  const duration = Math.max(5, options.durationMinutes) * 60_000
  const limit = options.limit ?? 5
  const byEmail = new Map(options.availability.map((item) => [attendeeAddress(item.email), item]))
  const required = options.participants.filter((item) => item.role !== 'optional')
  const optional = options.participants.filter((item) => item.role === 'optional')
  const unverified = required.filter((item) => !byEmail.get(attendeeAddress(item.email))?.known).map((item) => item.email)
  const results: SlotSuggestion[] = []
  let start = Math.ceil(Math.max(options.from, options.now ?? options.from) / step) * step
  while (start + duration <= options.to && results.length < limit) {
    const end = start + duration
    const fits = withinWorkingHours(start, end, options.workingHours) && required.every((participant) => {
      const availability = byEmail.get(attendeeAddress(participant.email))
      if (!availability?.known) return true
      if (options.respectAttendeeHours !== false && !withinWorkingHours(start, end, availability.workingHours)) return false
      return isAvailable(statusDuring(availability, start, end))
    })
    if (!fits) {
      start += step
      continue
    }
    const optionalConflicts = optional
      .filter((participant) => !isAvailable(statusDuring(byEmail.get(attendeeAddress(participant.email)), start, end)))
      .map((participant) => participant.email)
    results.push({ start, end, optionalConflicts, unverified })
    // Skip past the suggested meeting so the list offers distinct choices.
    start = Math.ceil(end / step) * step
  }
  return results
}

const timeFormatters = new Map<string, Intl.DateTimeFormat>()

export function formatZoneTime(ms: number, timeZone: string) {
  let formatter = timeFormatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    timeFormatters.set(timeZone, formatter)
  }
  return formatter.format(new Date(ms))
}

export function formatZoneDay(ms: number, timeZone: string) {
  return new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(ms))
}

/** Short zone label such as "GMT+2" for headers. */
export function zoneLabel(ms: number, timeZone: string) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' }).formatToParts(new Date(ms)).find((part) => part.type === 'timeZoneName')?.value ?? timeZone
  } catch {
    return timeZone
  }
}

/** Converts an editor `datetime-local` value (system local time) to UTC ms. */
export const localInputMs = (value: string) => {
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : NaN
}

/** Formats UTC ms back into a `datetime-local` value in system local time. */
export function msToLocalInput(ms: number) {
  const date = new Date(ms)
  const pad = (value: number) => value.toString().padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const WORKING_HOURS_KEY = 'aerio:scheduling-working-hours:v1'
const SECONDARY_ZONE_KEY = 'aerio:scheduling-secondary-zone:v1'

function validWorkingHours(value: unknown): value is WorkingHours {
  if (!value || typeof value !== 'object') return false
  const hours = value as WorkingHours
  return Array.isArray(hours.days) && hours.days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6) &&
    Number.isFinite(minutesOf(hours.start)) && Number.isFinite(minutesOf(hours.end)) && typeof hours.timeZone === 'string'
}

export function loadWorkingHours(timeZone: string): WorkingHours {
  try {
    const parsed = JSON.parse(localStorage.getItem(WORKING_HOURS_KEY) ?? 'null') as unknown
    if (validWorkingHours(parsed)) return { ...parsed, timeZone }
  } catch { /* Fall back to the default week. */ }
  return DEFAULT_WORKING_HOURS(timeZone)
}

export function saveWorkingHours(hours: WorkingHours) {
  try { localStorage.setItem(WORKING_HOURS_KEY, JSON.stringify(hours)) } catch { /* Not persisted in this session. */ }
}

export function loadSecondaryZone() {
  try { return localStorage.getItem(SECONDARY_ZONE_KEY) ?? '' } catch { return '' }
}

export function saveSecondaryZone(zone: string) {
  try {
    if (zone) localStorage.setItem(SECONDARY_ZONE_KEY, zone)
    else localStorage.removeItem(SECONDARY_ZONE_KEY)
  } catch { /* Not persisted in this session. */ }
}
