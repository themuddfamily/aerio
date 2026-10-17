import type { ProductivityProvider } from './productivity-types'

// Free/busy data for the scheduling assistant. The organizer's calendar decides which provider is
// asked: a Google calendar queries Google Calendar freeBusy, a Microsoft calendar queries Graph
// getSchedule, and local or subscribed calendars have no availability service at all.

// 'unknown' marks a window the provider could not describe (for example a Graph "unknown" item).
export type AvailabilityStatus = 'busy' | 'tentative' | 'oof' | 'workingElsewhere' | 'unknown'

export interface AvailabilityInterval {
  start: string
  end: string
  status: AvailabilityStatus
}

/** Why an attendee's availability is not known. Unknown time is never treated as free. */
export type AvailabilityUnknownReason = 'permission' | 'not-found' | 'external' | 'provider-error' | 'unsupported'

/** Weekly working hours in a time zone; days use 0 = Sunday. */
export interface WorkingHours {
  days: number[]
  start: string
  end: string
  timeZone: string
}

export interface AttendeeAvailability {
  email: string
  known: boolean
  reason?: AvailabilityUnknownReason
  message?: string
  busy: AvailabilityInterval[]
  workingHours?: WorkingHours
}

export interface AvailabilityRequest {
  /** The calendar the event is saved to; its account and provider answer the lookup. */
  calendarId: string
  attendees: string[]
  start: string
  end: string
}

export interface AvailabilityResult {
  calendarId: string
  accountId?: string
  provider?: ProductivityProvider
  attendees: AttendeeAvailability[]
  /** True when the account's grant lacks a free/busy permission and a reconnect would fix it. */
  needsReconnect: boolean
  missingScopes: string[]
  message?: string
  fetchedAt: string
}
