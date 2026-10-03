export type TaskProvider = 'gmail' | 'microsoft'

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
  status?: 'notStarted' | 'inProgress' | 'completed' | 'waitingOnOthers' | 'deferred'
  body?: { contentType: 'text' | 'html'; content: string }
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
}

export interface TaskLocalMetadata {
  priority: 'low' | 'normal' | 'high'
  recurrence: 'none' | 'daily' | 'weekly' | 'monthly'
  timedDue?: string
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
}
