import type { DatabaseSync } from 'node:sqlite'
import type { ProviderTaskList, ProviderTaskSnapshot, TaskListOperation, TaskOperationStatus, TaskProvider, TaskResolution } from '../../src/task-provider-types'

const active = new Set<TaskOperationStatus>(['queued', 'running', 'failed', 'conflict', 'review'])
const sameAccount = (left: ProviderTaskList, right: { accountId: string; provider: TaskProvider }) => left.accountId === right.accountId && left.provider === right.provider

// Shares the task store's database and transaction. List intent is saved before
// dispatch, and interrupted writes always require explicit reconciliation.
export class TaskListQueue {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS task_list_operations (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
      account_id TEXT NOT NULL, provider TEXT NOT NULL, status TEXT NOT NULL,
      payload_json TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      retry_at INTEGER NOT NULL DEFAULT 0, error TEXT
    ); CREATE INDEX IF NOT EXISTS idx_task_list_queue ON task_list_operations(status,retry_at,sequence);`)
    db.prepare("UPDATE task_list_operations SET status='review',error='interrupted-write' WHERE status='running'").run()
  }

  operations(): TaskListOperation[] {
    return this.db.prepare('SELECT * FROM task_list_operations ORDER BY sequence').all().map((row) => ({ ...JSON.parse(String(row.payload_json)), sequence: Number(row.sequence), status: row.status, attempts: Number(row.attempts), retryAt: Number(row.retry_at), error: row.error ?? undefined }))
  }
  blocked(listId: string) { return this.operations().some((item) => item.base?.id === listId && item.kind === 'delete' && active.has(item.status)) }
  snapshot(accountId: string, provider: TaskProvider): ProviderTaskSnapshot {
    const row = this.db.prepare('SELECT payload_json FROM task_provider_snapshots WHERE account_id=? AND provider=?').get(accountId, provider)
    return row ? JSON.parse(String(row.payload_json)) : { lists: [], tasks: [], checkpoints: {} }
  }
  private save(accountId: string, provider: TaskProvider, snapshot: ProviderTaskSnapshot) {
    this.db.prepare('INSERT INTO task_provider_snapshots VALUES(?,?,?) ON CONFLICT(account_id,provider) DO UPDATE SET payload_json=excluded.payload_json').run(accountId, provider, JSON.stringify(snapshot))
  }
  private transaction<T>(callback: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = callback(); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  private operation(id: string) {
    const value = this.operations().find((item) => item.id === id)
    if (!value) throw new Error('Task list change not found')
    return value
  }
  private pendingTasks(listId: string) {
    return this.db.prepare("SELECT payload_json FROM task_operations WHERE status NOT IN ('succeeded','cancelled')").all().some((row) => JSON.parse(String(row.payload_json)).before.listId === listId)
  }
  deletionReady(list: ProviderTaskList) {
    return !this.pendingTasks(list.id) && !this.snapshot(list.accountId, list.provider).tasks.some((task) => task.listId === list.id && (task.readOnly || task.assigned || !task.revision))
  }

  enqueue(accountId: string, provider: TaskProvider, kind: TaskListOperation['kind'], title?: string, listId?: string) {
    if (typeof accountId !== 'string' || !accountId.trim() || !['gmail', 'microsoft'].includes(provider) || !['create', 'update', 'delete'].includes(kind)) throw new Error('Invalid task list change')
    if ((kind === 'create' && listId !== undefined) || (kind === 'delete' && title !== undefined)) throw new Error('Invalid task list change')
    if (kind !== 'delete' && (typeof title !== 'string' || !title.trim() || title.length > 1024)) throw new Error('List names must contain 1 to 1024 characters')
    return this.transaction(() => {
      const snapshot = this.snapshot(accountId, provider)
      const base = listId ? snapshot.lists.find((list) => list.id === listId) : undefined
      if (kind !== 'create' && (!base || base.readOnly || base.manageReadOnly || !base.revision || !sameAccount(base, { accountId, provider }))) throw new Error('This task list is read-only or unavailable')
      if (base && this.operations().some((item) => item.base?.id === base.id && active.has(item.status))) throw new Error('Resolve the pending change to this list first')
      if (kind === 'delete' && this.pendingTasks(base!.id)) throw new Error('Synchronize or resolve pending task changes before deleting this list')
      if (kind === 'delete' && !this.deletionReady(base!)) throw new Error('This list contains read-only tasks; manage them with the provider before deleting the list')
      const id = crypto.randomUUID()
      const payload = { id, accountId, provider, kind, title: kind === 'delete' ? undefined : title!.trim(), base, knownListIds: kind === 'create' ? snapshot.lists.map((list) => list.id) : undefined }
      // An offline list creation still owns a cache group for backup/recovery.
      this.save(accountId, provider, snapshot)
      this.db.prepare("INSERT INTO task_list_operations(id,account_id,provider,status,payload_json) VALUES(?,?,?,'queued',?)").run(id, accountId, provider, JSON.stringify(payload))
      return this.operation(id)
    })
  }
  next(now: number, eligible: (operation: TaskListOperation) => boolean) { return this.operations().find((item) => item.status === 'queued' && item.retryAt <= now && eligible(item)) }
  start(id: string) {
    const operation = this.operation(id)
    if (operation.status !== 'queued') throw new Error('Task list change is not queued')
    this.db.prepare("UPDATE task_list_operations SET status='running',attempts=attempts+1,error=NULL WHERE id=?").run(id)
    return this.operation(id)
  }
  fail(id: string, status: TaskOperationStatus, error: string, retryAt = 0) {
    if (this.operation(id).status !== 'running') throw new Error('Task list change is not running')
    this.db.prepare('UPDATE task_list_operations SET status=?,error=?,retry_at=? WHERE id=?').run(status, error, retryAt, id)
  }
  succeed(id: string, result?: ProviderTaskList) {
    return this.transaction(() => {
      const operation = this.operation(id)
      if (operation.status !== 'running') throw new Error('Task list change is not running')
      this.finish(operation, result)
      return this.operation(id)
    })
  }
  private finish(operation: TaskListOperation, result?: ProviderTaskList) {
    const snapshot = this.snapshot(operation.accountId, operation.provider)
    if (operation.kind === 'delete') {
      const listId = operation.base!.id
      if (this.pendingTasks(listId)) throw new Error('Pending task changes prevent list deletion')
      snapshot.lists = snapshot.lists.filter((list) => list.id !== listId)
      snapshot.tasks = snapshot.tasks.filter((task) => task.listId !== listId)
      delete snapshot.checkpoints[listId]
      this.db.prepare('UPDATE task_entities SET present=0 WHERE account_id=? AND provider=? AND list_id=?').run(operation.accountId, operation.provider, listId)
    } else {
      if (!result || !sameAccount(result, operation) || !result.id || !result.remoteId || !result.revision || result.readOnly || result.title !== operation.title || (operation.kind === 'update' && (result.id !== operation.base!.id || result.remoteId !== operation.base!.remoteId))) throw new Error('Provider returned an unrelated task list')
      if (operation.kind === 'create' && operation.knownListIds?.includes(result.id)) throw new Error('Provider returned an existing list for a creation')
      if (operation.kind === 'create' && this.operations().some((item) => item.id !== operation.id && item.kind === 'create' && item.status === 'succeeded' && item.result?.id === result.id)) throw new Error('This list already belongs to another creation')
      const index = snapshot.lists.findIndex((list) => list.id === result.id)
      if (index === -1) snapshot.lists.push(result)
      else snapshot.lists[index] = result
    }
    operation.result = result
    this.save(operation.accountId, operation.provider, snapshot)
    this.db.prepare("UPDATE task_list_operations SET status='succeeded',error=NULL,retry_at=0,payload_json=? WHERE id=?").run(JSON.stringify(operation), operation.id)
  }
  resolve(id: string, resolution: TaskResolution) {
    return this.transaction(() => {
      const operation = this.operation(id)
      if (!['failed', 'conflict', 'review', 'queued'].includes(operation.status)) throw new Error('This list change does not need review')
      if (!resolution || !['discard', 'retry', 'accept'].includes(resolution.action)) throw new Error('Invalid list resolution')
      if (operation.status === 'queued' && (operation.attempts || resolution.action !== 'discard')) throw new Error('Only unsent list changes can be cancelled')
      const previousStatus = operation.status, previousBase = operation.base
      const snapshot = this.snapshot(operation.accountId, operation.provider)
      const current = snapshot.lists.find((list) => list.id === operation.base?.id)
      if (resolution.action === 'discard') {
        this.db.prepare("UPDATE task_list_operations SET status='cancelled',error=NULL WHERE id=?").run(id)
      } else if (resolution.action === 'retry') {
        if (operation.status === 'review' && resolution.confirmedNotApplied !== true) throw new Error('Confirm this change was not applied before retrying')
        if (operation.kind !== 'create' && (!current || current.readOnly || current.manageReadOnly || !current.revision || current.revision !== resolution.expectedRevision)) throw new Error('The list revision changed; refresh and review it first')
        operation.base = current
        this.db.prepare("UPDATE task_list_operations SET status='queued',error=NULL,retry_at=0 WHERE id=?").run(id)
      } else {
        const result = resolution.remoteId ? snapshot.lists.find((list) => list.id === resolution.remoteId) : undefined
        if (operation.kind === 'delete') {
          if (current || resolution.remoteId) throw new Error('The deleted list is still present')
        } else {
          if (!result || !sameAccount(result, operation) || result.revision !== resolution.expectedRevision || result.title !== operation.title || (operation.kind === 'update' && result.id !== operation.base?.id)) throw new Error('Select the matching list and current revision')
          if (operation.kind === 'create' && operation.knownListIds?.includes(result.id)) throw new Error('Select a newly created list')
          if (operation.kind === 'create' && this.operations().some((item) => item.id !== id && item.kind === 'create' && item.status === 'succeeded' && item.result?.id === result.id)) throw new Error('This list already belongs to another creation')
        }
        this.finish(operation, result)
      }
      operation.history = [...operation.history ?? [], { resolvedAt: new Date().toISOString(), resolution, previousStatus, previousBase }]
      this.db.prepare('UPDATE task_list_operations SET payload_json=? WHERE id=?').run(JSON.stringify(operation), id)
      return this.operation(id)
    })
  }
  restore(operations: TaskListOperation[]) {
    this.db.exec('DELETE FROM task_list_operations')
    for (const original of operations) {
      const operation = { ...original, status: active.has(original.status) ? 'review' : original.status, error: active.has(original.status) ? 'restored-write' : original.error, retryAt: 0 }
      this.db.prepare('INSERT INTO task_list_operations(sequence,id,account_id,provider,status,payload_json,attempts,retry_at,error) VALUES(?,?,?,?,?,?,?,?,?)').run(operation.sequence, operation.id, operation.accountId, operation.provider, operation.status, JSON.stringify(operation), operation.attempts, operation.retryAt, operation.error ?? null)
    }
  }
  removeAccount(id: string) { this.db.prepare('DELETE FROM task_list_operations WHERE account_id=?').run(id) }
}
