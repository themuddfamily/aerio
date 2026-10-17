import type { Attachment } from './types'

/**
 * Provider-neutral task scheduling, progress, tag, and attachment fields (E44).
 *
 * Local Tasks carry these directly on `Task`. Connected tasks carry the
 * provider-supported subset in `TaskNativeFields` and every unsupported field
 * as a labeled local overlay in `TaskLocalMetadata.extended`. CalDAV VTODO
 * (E45) maps the same shapes: `start` is DTSTART (DATE or wall-clock
 * DATE-TIME with TZID), `reminder` an absolute VALARM trigger, `percentComplete`
 * PERCENT-COMPLETE, and `categories` CATEGORIES.
 */
export interface TaskExtendedFields {
  /** `YYYY-MM-DD` for an all-day start, or a wall-clock `YYYY-MM-DDTHH:mm[:ss]` read in `startTimeZone`. */
  start?: string
  /** IANA zone for a timed start. Absent means this computer's zone at the time it is read. */
  startTimeZone?: string
  /** Absolute reminder instant in UTC (`…Z`), independent of the due date. */
  reminder?: string
  /** Integer 0–100. */
  percentComplete?: number
  /** Tags/categories, compared case-insensitively for uniqueness. */
  categories?: string[]
  /** Managed copies under the profile's `task-attachments` directory. */
  attachments?: Attachment[]
}

export type TaskExtendedFieldName = 'start' | 'reminder' | 'percentComplete' | 'categories' | 'attachments'
/** `native`: stored by the provider. `local`: kept in Aerio beside the cached task and never sent. */
export type TaskFieldSupport = 'native' | 'local'
export type TaskFieldCapabilities = Record<TaskExtendedFieldName, TaskFieldSupport>
export type TaskFieldSource = 'local' | 'gmail' | 'microsoft' | 'dav'

/** The published provider capability matrix (see docs/task-fields-reminders.md). */
export const TASK_FIELD_CAPABILITIES: Record<TaskFieldSource, TaskFieldCapabilities> = {
  local: { start: 'local', reminder: 'local', percentComplete: 'local', categories: 'local', attachments: 'local' },
  // Google Tasks exposes title, notes, a date-only due value, completion, and hierarchy only.
  gmail: { start: 'local', reminder: 'local', percentComplete: 'local', categories: 'local', attachments: 'local' },
  // Microsoft Graph todoTask has startDateTime, reminderDateTime/isReminderOn, categories and
  // taskFileAttachment, but only a status (no percentage).
  microsoft: { start: 'native', reminder: 'native', percentComplete: 'local', categories: 'native', attachments: 'native' },
  // CalDAV VTODO (E45): DTSTART, VALARM, PERCENT-COMPLETE and CATEGORIES. ATTACH URIs are shown and kept;
  // files added in Aerio stay a local overlay.
  dav: { start: 'native', reminder: 'native', percentComplete: 'native', categories: 'native', attachments: 'local' }
}

/** Fields a provider task may keep in its local overlay. */
export const localOverlayFields = (source: TaskFieldSource): TaskExtendedFieldName[] =>
  (Object.entries(TASK_FIELD_CAPABILITIES[source]) as [TaskExtendedFieldName, TaskFieldSupport][]).filter(([, support]) => support === 'local').map(([name]) => name)

/** Provider attachment metadata (Microsoft taskFileAttachment). Contents are fetched on demand. */
export interface TaskNativeAttachment {
  id: string
  name: string
  size: number
  contentType?: string
}

export type TaskReminderSource = 'local' | 'connected'
export type TaskReminderStatus = 'fired' | 'snoozed' | 'dismissed'

/** A reminder that has fired and has not been dismissed, or is snoozed. */
export interface TaskReminder {
  /** Stable for one task and one reminder instant: `source:taskId:reminder`. */
  key: string
  source: TaskReminderSource
  taskId: string
  title: string
  reminderAt: string
  status: Exclude<TaskReminderStatus, 'dismissed'>
  firedAt?: string
  snoozedUntil?: string
  /** Fired after the reminder time had already passed, for example while Aerio was closed. */
  missed: boolean
}

export interface TaskReminderApi {
  list(): Promise<TaskReminder[]>
  dismiss(key: string): Promise<TaskReminder[]>
  snooze(key: string, until: string): Promise<TaskReminder[]>
  onChanged(callback: (reminders: TaskReminder[]) => void): () => void
}

export interface TaskAttachmentApi {
  /** Copies chosen files into managed storage for a local task or a local-only overlay. */
  choose(): Promise<Attachment[]>
  open(path: string): Promise<{ error?: string }>
  /** Microsoft To Do: upload small files (up to 3 MB each) to a saved task immediately. */
  uploadNative(taskId: string): Promise<import('./task-provider-types').TaskSnapshot>
  removeNative(taskId: string, attachmentId: string): Promise<import('./task-provider-types').TaskSnapshot>
  openNative(taskId: string, attachmentId: string): Promise<{ error?: string }>
}
