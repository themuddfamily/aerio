import type { VTodoLink, VTodoPriority, VTodoStatus } from './lib/vtodo'
import type { TaskSnapshot } from './task-provider-types'

// iCalendar (.ics) task import and export (E45). Files hold a VCALENDAR with VTODOs; the mapping is
// the one CalDAV tasks use (docs/caldav-tasks.md).

/** One task (a UID, with any overridden occurrences) from an .ics file. */
export interface TaskIcsItem {
  uid: string
  title: string
  notes?: string
  due?: string
  dueTimeZone?: string
  start?: string
  startTimeZone?: string
  completed: boolean
  status: VTodoStatus
  percentComplete?: number
  priority: VTodoPriority
  categories: string[]
  reminder?: string
  parentUid?: string
  /** RRULE of a repeating task. */
  recurrence?: string
  /** Overridden occurrences (RECURRENCE-ID) kept with the series. */
  occurrences: number
  links: VTodoLink[]
  inlineAttachments: number
  /** Properties Aerio keeps on round-trip but does not edit. */
  preserved: string[]
  /** A standalone VCALENDAR with this task, its occurrences, and the time zones they use. */
  source: string
}

export interface TaskIcsPreview {
  fileName: string
  calendarName?: string
  items: TaskIcsItem[]
  warnings: string[]
}

export type TaskIcsDuplicateMode = 'skip' | 'replace' | 'copy'

/** A local list is named by its list id; a connected list by its provider list id. */
export type TaskIcsTarget = { kind: 'local'; listId: string } | { kind: 'connected'; listId: string }

export interface TaskIcsImportResult {
  created: number
  replaced: number
  skipped: number
  snapshot: TaskSnapshot
  warnings: string[]
}

export interface TaskIcsApi {
  /** Opens an .ics file and returns its tasks for preview. Nothing is imported yet. */
  choose(): Promise<TaskIcsPreview | undefined>
  /** UIDs from `uids` that already exist in a connected list. */
  duplicates(listId: string, uids: string[]): Promise<string[]>
  /** Imports previewed tasks (by their `source`) into a connected list through its offline queue. */
  importConnected(listId: string, sources: string[], mode: TaskIcsDuplicateMode): Promise<TaskIcsImportResult>
  /** Saves a list (local or connected) as an .ics file. */
  exportList(target: TaskIcsTarget): Promise<{ savedPath?: string; count?: number }>
}
