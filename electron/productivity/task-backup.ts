import type { ProviderTask, ProviderTaskInput, ProviderTaskList, ProviderTaskSnapshot, TaskEntity, TaskFieldPatch, TaskListOperation, TaskLocalMetadata, TaskOperation, TaskProvider, TaskResolutionRecord } from '../../src/task-provider-types'
import { validTaskNativeFields } from './task-native-validation'

export interface TaskBackup {
  format: 'aerio-provider-tasks'
  schemaVersion: 1
  exportedAt: string
  accounts: { accountId: string; provider: TaskProvider; snapshot: ProviderTaskSnapshot }[]
  entities: (TaskEntity & { present: boolean })[]
  operations: TaskOperation[]
  occurrences: { sourceId: string; completionId: string; creationId: string }[]
  resolutions: TaskResolutionRecord[]
  listOperations?: TaskListOperation[]
}

const record = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const keys = (value: unknown, allowed: string[]) => record(value) && Object.keys(value).every((key) => allowed.includes(key))
const text = (value: unknown, max = 2048): value is string => typeof value === 'string' && Boolean(value.trim()) && value.length <= max
const optionalText = (value: unknown, max = 2048) => value === undefined || (typeof value === 'string' && value.length <= max)
const date = (value: unknown) => typeof value === 'string' && value.length <= 100 && /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) === value.slice(0, 10)
const provider = (value: unknown): value is TaskProvider => value === 'gmail' || value === 'microsoft'
const statuses = ['queued', 'running', 'succeeded', 'cancelled', 'failed', 'conflict', 'review']
const identity = (value: any) => text(value.accountId) && provider(value.provider)
const fields = (value: unknown): value is ProviderTaskInput => keys(value, ['title', 'notes', 'due', 'completed', 'native']) && text((value as any).title, 1024) && optionalText((value as any).notes, (value as any).native?.body ? 1_000_000 : 8192) && ((value as any).due === undefined || date((value as any).due)) && typeof (value as any).completed === 'boolean' && ((value as any).native === undefined || validTaskNativeFields((value as any).native))
const metadata = (value: unknown): value is TaskLocalMetadata => keys(value, ['priority', 'recurrence', 'timedDue']) && ['low', 'normal', 'high'].includes((value as any).priority) && ['none', 'daily', 'weekly', 'monthly'].includes((value as any).recurrence) && ((value as any).timedDue === undefined || date((value as any).timedDue))
const revisionMode = (value: any) => value.revisionMode === undefined || value.revisionMode === 'etag' || (value.revisionMode === 'snapshot' && typeof value.revision === 'string' && /^snapshot:[a-f0-9]{64}$/.test(value.revision))
const list = (value: unknown): value is ProviderTaskList => keys(value, ['id', 'accountId', 'provider', 'remoteId', 'title', 'revision', 'readOnly', 'revisionMode', 'manageReadOnly']) && identity(value) && text((value as any).id) && text((value as any).remoteId) && text((value as any).title, 1024) && optionalText((value as any).revision) && typeof (value as any).readOnly === 'boolean' && revisionMode(value) && ((value as any).manageReadOnly === undefined || typeof (value as any).manageReadOnly === 'boolean')
const remote = (value: unknown): value is ProviderTask => keys(value, ['id', 'accountId', 'provider', 'remoteId', 'listId', 'remoteListId', 'parentId', 'position', 'revision', 'updatedAt', 'title', 'notes', 'due', 'completed', 'readOnly', 'assigned', 'kind', 'remoteParentId', 'revisionMode', 'native']) && identity(value) && ['id', 'remoteId', 'listId', 'remoteListId'].every((key) => text((value as any)[key])) && ['parentId', 'remoteParentId', 'position', 'revision'].every((key) => optionalText((value as any)[key])) && ((value as any).updatedAt === undefined || date((value as any).updatedAt)) && fields({ title: (value as any).title, notes: (value as any).notes, due: (value as any).due, completed: (value as any).completed, native: (value as any).native }) && typeof (value as any).readOnly === 'boolean' && ((value as any).assigned === undefined || typeof (value as any).assigned === 'boolean') && ((value as any).kind === undefined || ['task', 'checklist'].includes((value as any).kind)) && revisionMode(value) && ((value as any).kind !== 'checklist' || (text((value as any).remoteParentId) && text((value as any).parentId) && !(value as any).native && !(value as any).due && !(value as any).notes))
const entity = (value: unknown, stored = false): value is TaskEntity => keys(value, ['id', 'accountId', 'provider', 'listId', 'parentId', 'fields', 'local', 'remote', ...(stored ? ['present'] : [])]) && identity(value) && text((value as any).id) && text((value as any).listId) && optionalText((value as any).parentId) && fields((value as any).fields) && metadata((value as any).local) && ((value as any).remote === undefined || (remote((value as any).remote) && sameScope(value, (value as any).remote))) && (!stored || typeof (value as any).present === 'boolean')
const sameScope = (left: any, right: any) => left.accountId === right.accountId && left.provider === right.provider && left.listId === right.listId
const patch = (value: unknown): value is TaskFieldPatch => keys(value, ['title', 'notes', 'due', 'completed', 'native']) && ((value as any).title === undefined || text((value as any).title, 1024)) && ((value as any).notes === null || optionalText((value as any).notes, (value as any).native?.body ? 1_000_000 : 8192)) && ((value as any).due === undefined || (value as any).due === null || date((value as any).due)) && ((value as any).completed === undefined || typeof (value as any).completed === 'boolean') && ((value as any).native === undefined || validTaskNativeFields((value as any).native))
const checkpointValid = (value: unknown, owner: ProviderTaskList) => {
  if (owner.provider === 'gmail') return date(value)
  if (typeof value !== 'string' || value.length > 32_768) return false
  try {
    const url = new URL(value)
    const path = url.pathname.replace(/\(\)$/, '').split('/').map(decodeURIComponent)
    return url.origin === 'https://graph.microsoft.com' && !url.username && !url.password && !url.hash && path.length === 8 && path.slice(0, 5).join('/') === '/v1.0/me/todo/lists' && path[5] === owner.remoteId && path[6] === 'tasks' && path[7] === 'delta' && Boolean(url.search)
  } catch { return false }
}
const unique = (values: string[]) => new Set(values).size === values.length
const providerFields = (value: TaskEntity) => value.provider === 'microsoft' ? value.local.priority === 'normal' && value.local.recurrence === 'none' && value.local.timedDue === undefined : value.fields.native === undefined && value.remote?.native === undefined
const groupKey = (accountId: string, type: TaskProvider) => JSON.stringify([accountId, type])
const boundedArray = (value: unknown, limit = 100_000): value is any[] => Array.isArray(value) && value.length <= limit
const acyclic = <T extends { parentId?: string }>(values: Map<string, T>) => {
  const complete = new Set<string>()
  for (const id of values.keys()) {
    const branch = new Set<string>(); let current: string | undefined = id
    while (current && !complete.has(current)) {
      if (branch.has(current)) return false
      branch.add(current); current = values.get(current)?.parentId
    }
    for (const visited of branch) complete.add(visited)
  }
  return true
}

/** Validate the entire reference graph before opening a restore transaction. */
export function parseTaskBackup(value: unknown): TaskBackup {
  const invalid = () => { throw new Error('This connected-task backup is invalid or unsupported') }
  if (!keys(value, ['format', 'schemaVersion', 'exportedAt', 'accounts', 'entities', 'operations', 'occurrences', 'resolutions', 'listOperations'])) return invalid()
  const backup = value as unknown as TaskBackup
  if (backup.format !== 'aerio-provider-tasks' || backup.schemaVersion !== 1 || !date(backup.exportedAt) || !boundedArray(backup.accounts, 1000) || !boundedArray(backup.entities) || !boundedArray(backup.operations, 200_000) || !boundedArray(backup.occurrences) || !boundedArray(backup.resolutions, 200_000)) return invalid()
  const groups = new Set<string>(), lists = new Map<string, ProviderTaskList>(), native = new Map<string, ProviderTask>()
  for (const account of backup.accounts) {
    if (!keys(account, ['accountId', 'provider', 'snapshot']) || !identity(account) || groups.has(groupKey(account.accountId, account.provider)) || !keys(account.snapshot, ['lists', 'tasks', 'checkpoints']) || !boundedArray(account.snapshot.lists) || !boundedArray(account.snapshot.tasks) || !record(account.snapshot.checkpoints)) return invalid()
    groups.add(groupKey(account.accountId, account.provider))
    for (const item of account.snapshot.lists) {
      if (!list(item) || item.accountId !== account.accountId || item.provider !== account.provider || lists.has(item.id)) return invalid()
      lists.set(item.id, item)
    }
    for (const item of account.snapshot.tasks) {
      const owner = lists.get(item?.listId)
      if (!remote(item) || item.accountId !== account.accountId || item.provider !== account.provider || !owner || owner.accountId !== item.accountId || owner.provider !== item.provider || owner.remoteId !== item.remoteListId || native.has(item.id)) return invalid()
      native.set(item.id, item)
    }
    for (const [id, checkpoint] of Object.entries(account.snapshot.checkpoints)) {
      const owner = account.snapshot.lists.find((item) => item.id === id)
      if (!owner || !checkpointValid(checkpoint, owner)) return invalid()
    }
  }
  const entities = new Map<string, TaskBackup['entities'][number]>(), remoteOwners = new Map<string, string>()
  for (const item of backup.entities) {
    if (!entity(item, true) || !providerFields(item) || entities.has(item.id) || !groups.has(groupKey(item.accountId, item.provider)) || (item.remote && remoteOwners.has(item.remote.id))) return invalid()
    entities.set(item.id, item)
    if (item.remote) remoteOwners.set(item.remote.id, item.id)
  }
  const parentValid = (item: TaskEntity) => !item.parentId || Boolean(entities.get(item.parentId) && sameScope(item, entities.get(item.parentId)))
  for (const item of backup.entities) {
    if (!parentValid(item)) return invalid()
    if (item.provider === 'microsoft' && item.parentId && (entities.get(item.parentId)?.parentId || item.fields.notes || item.fields.due || (item.fields.native && Object.values(item.fields.native).some((value) => value !== undefined)))) return invalid()
  }
  if (!acyclic(entities) || !acyclic(native) || lists.size > 100_000 || native.size > 100_000) return invalid()
  for (const item of native.values()) {
    const owner = entities.get(remoteOwners.get(item.id) ?? '')
    if (!owner || !owner.present || !sameScope(owner, item) || (item.parentId && (!native.has(item.parentId) || !sameScope(item, native.get(item.parentId))))) return invalid()
    if (item.kind === 'checklist' && (item.provider !== 'microsoft' || native.get(item.parentId!)?.kind === 'checklist' || native.get(item.parentId!)?.remoteId !== item.remoteParentId)) return invalid()
  }
  const operations = new Map<string, TaskOperation>(); let sequence = 0
  for (const item of backup.operations) {
    const owner = entities.get(item?.entityId)
    if (!keys(item, ['id', 'sequence', 'entityId', 'accountId', 'provider', 'kind', 'status', 'patch', 'before', 'parentId', 'base', 'result', 'attempts', 'retryAt', 'error', 'undoOf', 'dependsOn']) || !text(item.id) || operations.has(item.id) || !owner || item.accountId !== owner.accountId || item.provider !== owner.provider || !Number.isSafeInteger(item.sequence) || item.sequence <= sequence || !['create', 'update', 'delete', 'move'].includes(item.kind) || !statuses.includes(item.status) || !patch(item.patch) || !entity(item.before) || item.before.id !== owner.id || !sameScope(owner, item.before) || !parentValid(item.before) || !Number.isSafeInteger(item.attempts) || item.attempts < 0 || !Number.isSafeInteger(item.retryAt) || item.retryAt < 0 || !optionalText(item.error)) return invalid()
    for (const original of [item.base, item.result]) if (original !== undefined && (!remote(original) || !sameScope(owner, original))) return invalid()
    if (!providerFields(item.before) || (item.provider !== 'microsoft' && item.patch.native !== undefined)) return invalid()
    if (item.provider === 'microsoft' && (item.before.parentId || item.base?.kind === 'checklist') && (item.patch.notes || item.patch.due || (item.patch.native && Object.values(item.patch.native).some((value) => value !== undefined)))) return invalid()
    if ([item.parentId, item.undoOf, item.dependsOn].some((reference) => reference !== undefined && !text(reference))) return invalid()
    if (item.parentId && (!entities.has(item.parentId) || !sameScope(owner, entities.get(item.parentId)))) return invalid()
    if (item.undoOf && (!operations.has(item.undoOf) || operations.get(item.undoOf)!.entityId !== item.entityId)) return invalid()
    if (item.dependsOn && (!operations.has(item.dependsOn) || operations.get(item.dependsOn)!.accountId !== item.accountId || operations.get(item.dependsOn)!.provider !== item.provider)) return invalid()
    sequence = item.sequence; operations.set(item.id, item)
  }
  if (!unique(backup.occurrences.map((item) => item?.sourceId))) return invalid()
  for (const item of backup.occurrences) {
    const completion = operations.get(item?.completionId), creation = operations.get(item?.creationId)
    if (!keys(item, ['sourceId', 'completionId', 'creationId']) || !entities.has(item.sourceId) || completion?.entityId !== item.sourceId || completion.kind !== 'update' || completion.patch.completed !== true || creation?.kind !== 'create' || creation.dependsOn !== completion.id || creation.accountId !== completion.accountId || creation.provider !== completion.provider) return invalid()
  }
  for (const item of backup.resolutions) {
    const operation = operations.get(item?.operationId), action = item?.resolution?.action
    if (!keys(item, ['operationId', 'resolvedAt', 'resolution', 'previousStatus', 'previousBase']) || !operation || !date(item.resolvedAt) || !statuses.includes(item.previousStatus) || !keys(item.resolution, action === 'discard' ? ['action'] : action === 'retry' ? ['action', 'expectedRevision', 'confirmedNotApplied'] : ['action', 'remoteId', 'expectedRevision']) || !['discard', 'retry', 'accept'].includes(action) || !optionalText((item.resolution as any).expectedRevision) || !optionalText((item.resolution as any).remoteId) || ((item.resolution as any).confirmedNotApplied !== undefined && typeof (item.resolution as any).confirmedNotApplied !== 'boolean') || (item.previousBase !== undefined && (!remote(item.previousBase) || !sameScope(operation.before, item.previousBase)))) return invalid()
  }
  if (backup.listOperations !== undefined && !boundedArray(backup.listOperations, 200_000)) return invalid()
  const listOperationIds = new Set<string>(); let listSequence = 0
  for (const item of backup.listOperations ?? []) {
    if (!keys(item, ['id', 'sequence', 'accountId', 'provider', 'kind', 'status', 'title', 'knownListIds', 'base', 'result', 'attempts', 'retryAt', 'error', 'history']) || !identity(item) || !groups.has(groupKey(item.accountId, item.provider)) || !text(item.id) || listOperationIds.has(item.id) || operations.has(item.id) || !Number.isSafeInteger(item.sequence) || item.sequence <= listSequence || !['create', 'update', 'delete'].includes(item.kind) || !statuses.includes(item.status) || !Number.isSafeInteger(item.attempts) || item.attempts < 0 || !Number.isSafeInteger(item.retryAt) || item.retryAt < 0 || !optionalText(item.error)) return invalid()
    const nativeListValid = (value: unknown) => list(value) && value.accountId === item.accountId && value.provider === item.provider
    if (item.kind === 'delete' ? item.title !== undefined || item.result !== undefined : !text(item.title, 1024)) return invalid()
    if (item.kind === 'create') {
      if (item.base !== undefined || !boundedArray(item.knownListIds) || item.knownListIds.some((id) => !text(id)) || !unique(item.knownListIds)) return invalid()
    } else if (!nativeListValid(item.base) || !text(item.base?.revision) || item.knownListIds !== undefined) return invalid()
    if (item.result !== undefined && (!nativeListValid(item.result) || !text(item.result.revision) || item.result.title !== item.title || (item.kind === 'update' && (item.result.id !== item.base?.id || item.result.remoteId !== item.base?.remoteId)) || (item.kind === 'create' && item.knownListIds?.includes(item.result.id)))) return invalid()
    if (item.status === 'succeeded' && item.kind !== 'delete' && !item.result) return invalid()
    if (item.history !== undefined && !boundedArray(item.history, 200_000)) return invalid()
    for (const entry of item.history ?? []) {
      const action = entry?.resolution?.action
      if (!keys(entry, ['resolvedAt', 'resolution', 'previousStatus', 'previousBase']) || !date(entry.resolvedAt) || !statuses.includes(entry.previousStatus) || !keys(entry.resolution, action === 'discard' ? ['action'] : action === 'retry' ? ['action', 'expectedRevision', 'confirmedNotApplied'] : ['action', 'remoteId', 'expectedRevision']) || !['discard', 'retry', 'accept'].includes(action) || !optionalText((entry.resolution as any).expectedRevision) || !optionalText((entry.resolution as any).remoteId) || ((entry.resolution as any).confirmedNotApplied !== undefined && typeof (entry.resolution as any).confirmedNotApplied !== 'boolean') || (entry.previousBase !== undefined && (!nativeListValid(entry.previousBase) || entry.previousBase.id !== item.base?.id))) return invalid()
    }
    listSequence = item.sequence; listOperationIds.add(item.id)
  }
  // A detached copy prevents callers changing validated data during restore.
  return structuredClone(backup)
}
