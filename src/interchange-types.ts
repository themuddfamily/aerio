import type { CalendarEvent, Contact } from './types'

export type InterchangeCalendarKind = 'local' | 'subscription'

export interface InterchangeCalendar {
  id: string
  kind: InterchangeCalendarKind
  name: string
  color: string
  // Subscriptions only: the normalized https feed URL, refresh cadence, and the last fetch outcome.
  url?: string
  refreshMinutes?: number
  lastRefreshedAt?: string
  lastAttemptAt?: string
  error?: string
  etag?: string
  lastModified?: string
  sourceName?: string
}

export interface InterchangeCalendarEvent extends CalendarEvent {
  readOnly: boolean
}

export interface InterchangeSnapshot {
  calendars: InterchangeCalendar[]
  events: InterchangeCalendarEvent[]
}

export interface CalendarImportPreview {
  fileName: string
  calendarName?: string
  events: CalendarEvent[]
  warnings: string[]
}

export interface CsvTable {
  headers: string[]
  rows: string[][]
}

export type ContactImportPreview =
  | { fileName: string; format: 'vcard'; contacts: Contact[]; warnings: string[] }
  | { fileName: string; format: 'csv'; table: CsvTable; warnings: string[] }

export type ContactExportFormat = 'vcard3' | 'vcard4' | 'csv'

export interface InterchangeExportResult {
  savedPath?: string
  count?: number
}

// Imports into a local calendar target an existing local calendar or create a new one by name.
export type LocalCalendarTarget = { calendarId: string } | { newCalendarName: string }

export interface CalendarSubscriptionInput {
  url: string
  name?: string
  refreshMinutes?: number
}

export interface InterchangeDesktopApi {
  snapshot(): Promise<InterchangeSnapshot>
  onChanged(callback: (snapshot: InterchangeSnapshot) => void): () => void
  chooseCalendarFile(): Promise<CalendarImportPreview | undefined>
  chooseContactsFile(): Promise<ContactImportPreview | undefined>
  exportCalendar(calendarIds: string[]): Promise<InterchangeExportResult>
  exportContacts(contactIds: string[], format: ContactExportFormat): Promise<InterchangeExportResult>
  saveLocalEvents(target: LocalCalendarTarget, events: CalendarEvent[]): Promise<InterchangeSnapshot>
  saveLocalEvent(event: CalendarEvent): Promise<InterchangeSnapshot>
  deleteLocalEvent(eventId: string): Promise<InterchangeSnapshot>
  subscribe(input: CalendarSubscriptionInput): Promise<InterchangeSnapshot>
  refresh(calendarId: string): Promise<InterchangeSnapshot>
  removeCalendar(calendarId: string): Promise<InterchangeSnapshot>
}
