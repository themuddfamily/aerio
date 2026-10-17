import type { VTodoInlineAttachment, VTodoLink } from './lib/vtodo'

/**
 * Read-only CalDAV metadata carried on a synchronized VTODO (E45). The raw calendar object stays in
 * dav.sqlite; Aerio writes back by patching only the properties a field edit changed. See
 * docs/caldav-tasks.md for the VTODO mapping.
 */
export interface CalDavTaskInfo {
  uid: string
  /** RECURRENCE-ID of an overridden occurrence. Edits change only this occurrence. */
  recurrenceId?: string
  /** RRULE of a series master. Repeat rules are shown and preserved but not edited in Aerio. */
  recurrence?: string
  /** Why the repeat settings (or the whole task) cannot be edited here. */
  recurrenceNote?: string
  /** URI attachments (ATTACH;VALUE=URI). */
  links?: VTodoLink[]
  /** Inline binary attachments (ATTACH;VALUE=BINARY): preserved on every write, never edited. */
  inlineAttachments?: VTodoInlineAttachment[]
  /** Unmapped properties kept unchanged on every write (X- properties and others). */
  preserved?: string[]
  /** The DESCRIPTION is longer than Aerio's note limit; notes are read-only. */
  notesTruncated?: boolean
  /** Why the whole task is read-only, when it is. */
  readOnlyReason?: string
  /** Import only: the source VCALENDAR to create from, so unmapped properties survive the import. */
  source?: string
}

export const CALDAV_SOURCE_LIMIT = 512 * 1024
