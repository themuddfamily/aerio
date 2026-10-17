// `dav` is a CalDAV account's VTODO collections (E45); see docs/caldav-tasks.md.
export type TaskProvider = 'gmail' | 'microsoft' | 'dav'

export interface TaskProviderCapabilities {
  recurrence: 'local' | 'native'
  priority: 'local' | 'native'
  due: 'date' | 'date-time'
  subtasks: 'tasks' | 'checklist'
  reparent?: boolean
}

export interface TaskNativeRecurrence {
  pattern: {
    type: 'daily' | 'weekly' | 'absoluteMonthly' | 'relativeMonthly' | 'absoluteYearly' | 'relativeYearly'
    interval: number
    dayOfMonth?: number
    daysOfWeek?: string[]
    firstDayOfWeek?: string
    index?: 'first' | 'second' | 'third' | 'fourth' | 'last'
    month?: number
  }
  range: { type: 'endDate' | 'noEnd' | 'numbered'; startDate: string; endDate?: string; numberOfOccurrences?: number; recurrenceTimeZone?: string }
}

export interface TaskNativeFields {
  priority?: 'low' | 'normal' | 'high'
  recurrence?: TaskNativeRecurrence | null
  dueTimeZone?: string
  // CalDAV STATUS maps NEEDS-ACTION/IN-PROCESS/COMPLETED/CANCELLED to notStarted/inProgress/completed/cancelled.
  status?: 'notStarted' | 'inProgress' | 'completed' | 'waitingOnOthers' | 'deferred' | 'cancelled'
  body?: { contentType: 'text' | 'html'; content: string }
  // Microsoft Graph startDateTime (wall clock + zone), reminderDateTime/isReminderOn (as a UTC
  // instant), and categories (E44). null clears start/reminder. Attachments are provider metadata
  // only; they change through TaskAttachmentApi, never through a field patch.
  start?: string | null
  startTimeZone?: string
  reminder?: string | null
  categories?: string[]
  attachments?: import('./task-fields-types').TaskNativeAttachment[]
  /** CalDAV PERCENT-COMPLETE (E45). null clears it. */
  percentComplete?: number | null
  /** CalDAV provider metadata (E45). Read-only: never part of a field patch, except `source` on an import create. */
  caldav?: import('./caldav-task-types').CalDavTaskInfo
}

export interface ProviderTaskList {
  id: string
  accountId: string
  provider: TaskProvider
  remoteId: string
  title: string
  revision?: string
  revisionMode?: 'etag' | 'snapshot'
  manageReadOnly?: boolean
  readOnly: boolean
}

// Provider tasks are flat records with stable parent identities. Local
// recurrence/priority and the UI's embedded checklist are projected separately.
export interface ProviderTask {
  id: string
  accountId: string
  provider: TaskProvider
  remoteId: string
  listId: string
  remoteListId: string
  parentId?: string
  position?: string
  revision?: string
  updatedAt?: string
  title: string
  notes?: string
  due?: string
  completed: boolean
  readOnly: boolean
  assigned?: boolean
  kind?: 'task' | 'checklist'
  remoteParentId?: string
  revisionMode?: 'etag' | 'snapshot'
  native?: TaskNativeFields
}

export interface ProviderTaskInput {
  title: string
  notes?: string
  due?: string
  completed: boolean
  native?: TaskNativeFields
}

export interface ProviderTaskSnapshot {
  lists: ProviderTaskList[]
  tasks: ProviderTask[]
  checkpoints: Record<string, string>
}

export interface TaskProviderConnector {
  readonly provider: TaskProvider
  readonly capabilities: TaskProviderCapabilities
  sync(previous?: ProviderTaskSnapshot): Promise<ProviderTaskSnapshot>
  createList(title: string): Promise<ProviderTaskList>
  updateList(current: ProviderTaskList, title: string): Promise<ProviderTaskList>
  deleteList(current: ProviderTaskList): Promise<void>
  createTask(list: ProviderTaskList, input: ProviderTaskInput, parent?: ProviderTask): Promise<ProviderTask>
  updateTask(current: ProviderTask, input: ProviderTaskInput): Promise<ProviderTask>
  deleteTask(current: ProviderTask): Promise<void>
  moveTask(current: ProviderTask, parent?: ProviderTask): Promise<ProviderTask>
  /** Native attachments (Microsoft). Each returns the re-read task with its new revision. */
  addAttachment?(current: ProviderTask, file: { name: string; contentType?: string; bytes: Uint8Array }): Promise<ProviderTask>
  deleteAttachment?(current: ProviderTask, attachmentId: string): Promise<ProviderTask>
  readAttachment?(current: ProviderTask, attachmentId: string): Promise<Uint8Array>
}

export interface TaskLocalMetadata {
  priority: 'low' | 'normal' | 'high'
  recurrence: 'none' | 'daily' | 'weekly' | 'monthly'
  timedDue?: string
  /** Fields the provider cannot store, kept beside the cached task (E44). Labeled local-only in the UI. */
  extended?: import('./task-fields-types').TaskExtendedFields
}

export interface TaskEntity {
  id: string
  accountId: string
  provider: TaskProvider
  listId: string
  parentId?: string
  fields: ProviderTaskInput
  local: TaskLocalMetadata
  remote?: ProviderTask
}

export interface TaskFieldPatch {
  title?: string
  notes?: string | null
  due?: string | null
  completed?: boolean
  native?: TaskNativeFields
}

export type TaskOperationStatus = 'queued' | 'running' | 'succeeded' | 'cancelled' | 'failed' | 'conflict' | 'review'
export interface TaskOperation {
  id: string
  sequence: number
  entityId: string
  accountId: string
  provider: TaskProvider
  kind: 'create' | 'update' | 'delete' | 'move'
  status: TaskOperationStatus
  patch: TaskFieldPatch
  before: TaskEntity
  parentId?: string
  base?: ProviderTask
  result?: ProviderTask
  attempts: number
  retryAt: number
  error?: string
  undoOf?: string
  dependsOn?: string
}

export type TaskResolution =
  | { action: 'discard' }
  | { action: 'retry'; expectedRevision?: string; confirmedNotApplied?: boolean }
  | { action: 'accept'; remoteId?: string; expectedRevision?: string }

export interface TaskResolutionRecord {
  operationId: string
  resolvedAt: string
  resolution: TaskResolution
  previousStatus: TaskOperationStatus
  previousBase?: ProviderTask
}

export interface TaskListOperation {
  id: string
  sequence: number
  accountId: string
  provider: TaskProvider
  kind: 'create' | 'update' | 'delete'
  status: TaskOperationStatus
  title?: string
  knownListIds?: string[]
  base?: ProviderTaskList
  result?: ProviderTaskList
  attempts: number
  retryAt: number
  error?: string
  history?: { resolvedAt: string; resolution: TaskResolution; previousStatus: TaskOperationStatus; previousBase?: ProviderTaskList }[]
}

export interface TaskAccountState {
  accountId: string
  provider: TaskProvider
  canRead: boolean
  canWrite: boolean
  archived: boolean
  recovered?: boolean
  syncEnabled?: boolean
  phase: 'idle' | 'syncing' | 'ready' | 'error'
  error?: 'needs-consent' | 'offline' | 'sync-failed'
  /** Display name for accounts that are not mail accounts (CalDAV, E45). */
  name?: string
}

export interface TaskSnapshot {
  lists: ProviderTaskList[]
  tasks: TaskEntity[]
  remoteTasks: ProviderTask[]
  operations: TaskOperation[]
  accounts: TaskAccountState[]
  listOperations?: TaskListOperation[]
}

export interface TaskDesktopApi {
  createList(accountId: string, title: string): Promise<TaskSnapshot>
  renameList(listId: string, title: string): Promise<TaskSnapshot>
  deleteList(listId: string): Promise<TaskSnapshot>
  resolveList(operationId: string, resolution: TaskResolution): Promise<TaskSnapshot>
  exportData(): Promise<{ savedPath?: string }>
  importData(): Promise<TaskSnapshot | undefined>
  snapshot(): Promise<TaskSnapshot>
  sync(accountId: string): Promise<TaskSnapshot>
  create(accountId: string, listId: string, input: ProviderTaskInput, parentId?: string, local?: TaskLocalMetadata): Promise<TaskSnapshot>
  update(id: string, patch: TaskFieldPatch, local?: TaskLocalMetadata): Promise<TaskSnapshot>
  delete(id: string): Promise<TaskSnapshot>
  move(id: string, parentId?: string): Promise<TaskSnapshot>
  setLocal(id: string, local: TaskLocalMetadata): Promise<TaskSnapshot>
  undo(operationId: string): Promise<TaskSnapshot>
  resolve(operationId: string, resolution: TaskResolution): Promise<TaskSnapshot>
  onChanged(callback: (snapshot: TaskSnapshot) => void): () => void
  reminders?: import('./task-fields-types').TaskReminderApi
  attachments?: import('./task-fields-types').TaskAttachmentApi
  /** iCalendar (.ics) task import and export (E45). */
  ics?: import('./task-interchange-types').TaskIcsApi
}
