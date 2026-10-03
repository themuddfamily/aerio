import { DatabaseSync } from 'node:sqlite'
import type { ProviderTask, ProviderTaskInput, ProviderTaskSnapshot, TaskEntity, TaskFieldPatch, TaskLocalMetadata, TaskOperation, TaskOperationStatus, TaskProvider, TaskResolution, TaskResolutionRecord } from '../../src/task-provider-types'
import { recurringTaskFields } from './task-recurrence'
import { parseTaskBackup, type TaskBackup } from './task-backup'
import { TaskListQueue } from './task-list-queue'
import { applyTaskFields as apply, providerTaskFields as fields } from './task-fields'
import { validTaskNativeFields } from './task-native-validation'
import { isDeepStrictEqual } from 'node:util'

const defaults = (): TaskLocalMetadata => ({ priority: 'normal', recurrence: 'none' })
const active = new Set<TaskOperationStatus>(['queued', 'running', 'failed', 'conflict', 'review'])
interface EntityRow { id: string; account_id: string; provider: TaskProvider; list_id: string; parent_id: string | null; initial_json: string; local_json: string; remote_json: string | null; present: number }
interface OperationRow { sequence: number; payload_json: string; status: TaskOperationStatus; attempts: number; retry_at: number; error: string | null }

export class TaskStore {
  private readonly db: DatabaseSync
  readonly listQueue: TaskListQueue

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS task_provider_snapshots (
        account_id TEXT NOT NULL, provider TEXT NOT NULL, payload_json TEXT NOT NULL,
        PRIMARY KEY(account_id,provider)
      );
      CREATE TABLE IF NOT EXISTS task_entities (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, provider TEXT NOT NULL, list_id TEXT NOT NULL,
        parent_id TEXT, initial_json TEXT NOT NULL, local_json TEXT NOT NULL,
        remote_key TEXT UNIQUE, remote_json TEXT, present INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_task_entities_account ON task_entities(account_id,provider);
      CREATE TABLE IF NOT EXISTS task_operations (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
        entity_id TEXT NOT NULL REFERENCES task_entities(id), account_id TEXT NOT NULL, provider TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','cancelled','failed','conflict','review')),
        payload_json TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0, error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_task_operations_queue ON task_operations(status,retry_at,sequence);
      CREATE TABLE IF NOT EXISTS task_occurrences (
        source_id TEXT PRIMARY KEY REFERENCES task_entities(id),
        completion_id TEXT NOT NULL REFERENCES task_operations(id),
        creation_id TEXT NOT NULL REFERENCES task_operations(id)
      );
      CREATE TABLE IF NOT EXISTS task_resolution_history (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        operation_id TEXT NOT NULL REFERENCES task_operations(id), payload_json TEXT NOT NULL
      );
    `)
    // A write may have reached the provider before the process disappeared.
    // Preserve its intent and baseline, but never resend it automatically.
    this.db.prepare("UPDATE task_operations SET status='review',error='interrupted-write' WHERE status='running'").run()
    this.listQueue = new TaskListQueue(this.db)
  }

  close() { this.db.close() }

  cachedAccounts(): { accountId: string; provider: TaskProvider }[] {
    return this.db.prepare('SELECT account_id,provider FROM task_provider_snapshots ORDER BY rowid').all().map((row) => ({ accountId: String(row.account_id), provider: row.provider as TaskProvider }))
  }

  exportBackup(): TaskBackup {
    return this.transaction(() => parseTaskBackup({
      format: 'aerio-provider-tasks', schemaVersion: 1, exportedAt: new Date().toISOString(),
      accounts: this.cachedAccounts().map((account) => ({ ...account, snapshot: this.providerSnapshot(account.accountId, account.provider) })),
      entities: (this.db.prepare('SELECT * FROM task_entities ORDER BY rowid').all() as unknown as EntityRow[]).map((row) => ({ id: row.id, accountId: row.account_id, provider: row.provider, listId: row.list_id, parentId: row.parent_id ?? undefined, fields: JSON.parse(row.initial_json), local: JSON.parse(row.local_json), remote: row.remote_json ? JSON.parse(row.remote_json) : undefined, present: Boolean(row.present) })),
      operations: this.operations(),
      listOperations: this.listQueue.operations(),
      occurrences: this.db.prepare('SELECT * FROM task_occurrences ORDER BY rowid').all().map((row) => ({ sourceId: row.source_id, completionId: row.completion_id, creationId: row.creation_id })),
      resolutions: this.db.prepare('SELECT payload_json FROM task_resolution_history ORDER BY sequence').all().map((row) => JSON.parse(String(row.payload_json)))
    }))
  }

  restoreBackup(value: unknown) {
    const backup = parseTaskBackup(value)
    this.transaction(() => {
      this.db.exec('DELETE FROM task_resolution_history; DELETE FROM task_occurrences; DELETE FROM task_operations; DELETE FROM task_entities; DELETE FROM task_provider_snapshots;')
      for (const account of backup.accounts) this.db.prepare('INSERT INTO task_provider_snapshots VALUES(?,?,?)').run(account.accountId, account.provider, JSON.stringify({ ...account.snapshot, checkpoints: {} }))
      for (const entity of backup.entities) this.db.prepare('INSERT INTO task_entities(id,account_id,provider,list_id,parent_id,initial_json,local_json,remote_key,remote_json,present) VALUES(?,?,?,?,?,?,?,?,?,?)').run(entity.id, entity.accountId, entity.provider, entity.listId, entity.parentId ?? null, JSON.stringify(entity.fields), JSON.stringify(entity.local), entity.remote?.id ?? null, entity.remote ? JSON.stringify(entity.remote) : null, Number(entity.present))
      for (const original of backup.operations) {
        const pending = active.has(original.status)
        const operation = { ...original, status: pending ? 'review' as const : original.status, error: pending ? 'restored-write' : original.error, retryAt: 0 }
        this.db.prepare('INSERT INTO task_operations(sequence,id,entity_id,account_id,provider,status,payload_json,attempts,retry_at,error) VALUES(?,?,?,?,?,?,?,?,?,?)').run(operation.sequence, operation.id, operation.entityId, operation.accountId, operation.provider, operation.status, JSON.stringify(operation), operation.attempts, operation.retryAt, operation.error ?? null)
      }
      for (const item of backup.occurrences) this.db.prepare('INSERT INTO task_occurrences VALUES(?,?,?)').run(item.sourceId, item.completionId, item.creationId)
      for (const item of backup.resolutions) this.db.prepare('INSERT INTO task_resolution_history(operation_id,payload_json) VALUES(?,?)').run(item.operationId, JSON.stringify(item))
      this.listQueue.restore(backup.listOperations ?? [])
    })
  }

  removeAccount(id: string) {
    this.transaction(() => {
      this.listQueue.removeAccount(id)
      this.db.prepare('DELETE FROM task_resolution_history WHERE operation_id IN (SELECT id FROM task_operations WHERE account_id=?)').run(id)
      this.db.prepare('DELETE FROM task_occurrences WHERE source_id IN (SELECT id FROM task_entities WHERE account_id=?)').run(id)
      this.db.prepare('DELETE FROM task_operations WHERE account_id=?').run(id)
      this.db.prepare('DELETE FROM task_entities WHERE account_id=?').run(id)
      this.db.prepare('DELETE FROM task_provider_snapshots WHERE account_id=?').run(id)
    })
  }

  private transaction<T>(callback: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = callback(); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  providerSnapshot(accountId: string, provider: TaskProvider): ProviderTaskSnapshot {
    const row = this.db.prepare('SELECT payload_json FROM task_provider_snapshots WHERE account_id=? AND provider=?').get(accountId, provider)
    return row ? JSON.parse(String(row.payload_json)) : { lists: [], tasks: [], checkpoints: {} }
  }

  replaceProviderSnapshot(accountId: string, provider: TaskProvider, snapshot: ProviderTaskSnapshot) {
    if (snapshot.lists.some((list) => list.accountId !== accountId || list.provider !== provider) || snapshot.tasks.some((task) => task.accountId !== accountId || task.provider !== provider) || new Set(snapshot.lists.map((list) => list.id)).size !== snapshot.lists.length || new Set(snapshot.tasks.map((task) => task.id)).size !== snapshot.tasks.length) throw new Error('Invalid task snapshot identity')
    const lists = new Set(snapshot.lists.map((list) => list.id))
    if (snapshot.tasks.some((task) => !lists.has(task.listId))) throw new Error('Task snapshot refers to an unavailable list')
    this.transaction(() => {
      this.db.prepare('INSERT INTO task_provider_snapshots VALUES(?,?,?) ON CONFLICT(account_id,provider) DO UPDATE SET payload_json=excluded.payload_json').run(accountId, provider, JSON.stringify(snapshot))
      this.db.prepare('UPDATE task_entities SET present=0 WHERE account_id=? AND provider=? AND remote_key IS NOT NULL').run(accountId, provider)
      const identities = new Map<string, string>()
      for (const remote of snapshot.tasks) {
        const row = this.db.prepare('SELECT id,account_id,provider FROM task_entities WHERE remote_key=?').get(remote.id)
        if (row && (row.account_id !== accountId || row.provider !== provider)) throw new Error('Task identity belongs to another account')
        const id = row ? String(row.id) : crypto.randomUUID()
        identities.set(remote.id, id)
        if (row) this.db.prepare('UPDATE task_entities SET remote_json=?,initial_json=?,list_id=?,present=1 WHERE id=?').run(JSON.stringify(remote), JSON.stringify(fields(remote)), remote.listId, id)
        else this.db.prepare('INSERT INTO task_entities(id,account_id,provider,list_id,initial_json,local_json,remote_key,remote_json) VALUES(?,?,?,?,?,?,?,?)').run(id, accountId, provider, remote.listId, JSON.stringify(fields(remote)), JSON.stringify(defaults()), remote.id, JSON.stringify(remote))
      }
      for (const remote of snapshot.tasks) this.db.prepare('UPDATE task_entities SET parent_id=? WHERE id=?').run(remote.parentId ? identities.get(remote.parentId) ?? null : null, identities.get(remote.id)!)
    })
  }

  private row(id: string) {
    return this.db.prepare('SELECT * FROM task_entities WHERE id=?').get(id) as unknown as EntityRow | undefined
  }

  entity(id: string): TaskEntity | undefined {
    const row = this.row(id)
    if (!row) return
    let visible = Boolean(row.present)
    const value: TaskEntity = { id, accountId: row.account_id, provider: row.provider, listId: row.list_id, parentId: row.parent_id ?? undefined, fields: JSON.parse(row.initial_json), local: JSON.parse(row.local_json), remote: row.remote_json ? JSON.parse(row.remote_json) : undefined }
    for (const operation of this.operations(id).filter((item) => active.has(item.status))) {
      if (operation.kind === 'create' || operation.kind === 'update' || operation.kind === 'move') visible = true
      if (operation.kind === 'delete') visible = false
      if (operation.kind === 'update' || operation.kind === 'create') value.fields = apply(value.fields, operation.patch)
      if (operation.kind === 'move') value.parentId = operation.parentId
    }
    return visible ? value : undefined
  }

  entities(accountId: string, provider: TaskProvider): TaskEntity[] {
    return (this.db.prepare('SELECT id FROM task_entities WHERE account_id=? AND provider=? ORDER BY rowid').all(accountId, provider)).flatMap((row) => { const entity = this.entity(String(row.id)); return entity ? [entity] : [] })
  }

  operations(entityId?: string): TaskOperation[] {
    const rows = (entityId ? this.db.prepare('SELECT * FROM task_operations WHERE entity_id=? ORDER BY sequence').all(entityId) : this.db.prepare('SELECT * FROM task_operations ORDER BY sequence').all()) as unknown as OperationRow[]
    return rows.map((row) => ({ ...JSON.parse(row.payload_json), sequence: row.sequence, status: row.status, attempts: row.attempts, retryAt: row.retry_at, error: row.error ?? undefined }))
  }

  private validatePatch(patch: TaskFieldPatch) {
    if (!patch || Object.keys(patch).some((key) => !['title', 'notes', 'due', 'completed', 'native'].includes(key)) || (patch.native !== undefined && !validTaskNativeFields(patch.native)) || (patch.title !== undefined && (typeof patch.title !== 'string' || !patch.title.trim() || patch.title.length > 1024)) || (patch.notes !== undefined && patch.notes !== null && (typeof patch.notes !== 'string' || patch.notes.length > (patch.native?.body ? 1_000_000 : 8192))) || (patch.completed !== undefined && typeof patch.completed !== 'boolean') || (patch.due !== undefined && patch.due !== null && (typeof patch.due !== 'string' || !Number.isFinite(Date.parse(patch.due))))) throw new Error('Invalid task mutation')
  }

  private validateProviderFields(entity: TaskEntity, patch: TaskFieldPatch, parentId = entity.parentId) {
    if (entity.provider !== 'microsoft') {
      if (patch.native !== undefined) throw new Error('This provider does not support native task fields')
      return
    }
    if (parentId || entity.remote?.kind === 'checklist') {
      if (patch.notes || patch.due || (patch.native && Object.values(patch.native).some((value) => value !== undefined))) throw new Error('Microsoft checklist items support a name and completion only')
      const parent = parentId ? this.entity(parentId) : undefined
      if (parent?.parentId || parent?.remote?.kind === 'checklist') throw new Error('Microsoft checklists cannot be nested')
    }
  }

  private writable(entity: TaskEntity) {
    const list = this.providerSnapshot(entity.accountId, entity.provider).lists.find((list) => list.id === entity.listId)
    if (!list || list.readOnly || entity.remote?.readOnly || entity.remote?.assigned) throw new Error('This task or list is read-only')
    if (this.listQueue.blocked(entity.listId)) throw new Error('Resolve the pending list deletion before changing its tasks')
  }

  private insert(kind: TaskOperation['kind'], entity: TaskEntity, patch: TaskFieldPatch = {}, parentId?: string, undoOf?: string, base = entity.remote, dependsOn?: string) {
    const id = crypto.randomUUID()
    const payload = { id, entityId: entity.id, accountId: entity.accountId, provider: entity.provider, kind, patch, before: entity, parentId, base, undoOf, dependsOn }
    this.db.prepare("INSERT INTO task_operations(id,entity_id,account_id,provider,status,payload_json) VALUES(?,?,?,?,'queued',?)").run(id, entity.id, entity.accountId, entity.provider, JSON.stringify(payload))
    return this.operations(entity.id).at(-1)!
  }

  create(accountId: string, provider: TaskProvider, listId: string, input: ProviderTaskInput, parentId?: string, local = defaults()) {
    this.validatePatch(input)
    this.validateLocal(local)
    if (typeof input.title !== 'string' || typeof input.completed !== 'boolean') throw new Error('Invalid new task')
    const entity: TaskEntity = { id: crypto.randomUUID(), accountId, provider, listId, parentId, fields: input, local }
    this.validateProviderFields(entity, input)
    if (provider === 'microsoft' && (local.recurrence !== 'none' || local.timedDue !== undefined || local.priority !== 'normal')) throw new Error('Use Microsoft native task fields for recurrence, priority and due times')
    this.writable(entity)
    if (parentId) {
      const parent = this.entity(parentId)
      if (!parent || parent.accountId !== accountId || parent.provider !== provider || parent.listId !== listId) throw new Error('Invalid parent task')
      this.writable(parent)
    }
    return this.transaction(() => {
      return this.enqueueCreate(entity)
    })
  }

  private enqueueCreate(entity: TaskEntity, dependsOn?: string) {
    this.db.prepare('INSERT INTO task_entities(id,account_id,provider,list_id,parent_id,initial_json,local_json,present) VALUES(?,?,?,?,?,?,?,0)').run(entity.id, entity.accountId, entity.provider, entity.listId, entity.parentId ?? null, JSON.stringify(entity.fields), JSON.stringify(entity.local))
    const operation = this.insert('create', entity, entity.fields, entity.parentId, undefined, undefined, dependsOn)
    return { entity: this.entity(entity.id)!, operation }
  }

  private occurrence(id: string) {
    const row = this.db.prepare('SELECT * FROM task_occurrences WHERE source_id=?').get(id)
    if (!row) return
    const creation = this.operations().find((item) => item.id === row.creation_id)!
    return { completionId: String(row.completion_id), creation }
  }

  private cancelCreation(operation: TaskOperation) {
    const affected = new Set([operation.entityId])
    const operations = this.operations()
    for (const item of operations) {
      const dependency = item.dependsOn ? operations.find((candidate) => candidate.id === item.dependsOn) : undefined
      if (item.kind === 'create' && ((item.parentId && affected.has(item.parentId)) || (dependency && affected.has(dependency.entityId)))) affected.add(item.entityId)
    }
    for (const entityId of affected) this.db.prepare("UPDATE task_operations SET status='cancelled' WHERE entity_id=? AND (status='queued' OR (status='review' AND error='restored-write' AND attempts=0))").run(entityId)
    for (const item of operations) if (item.kind === 'move' && this.unsent(item) && item.parentId && affected.has(item.parentId)) this.db.prepare("UPDATE task_operations SET status='cancelled' WHERE id=?").run(item.id)
  }

  private unsent(operation: TaskOperation) {
    return operation.attempts === 0 && (operation.status === 'queued' || (operation.status === 'review' && operation.error === 'restored-write'))
  }

  private generateOccurrence(entity: TaskEntity, completion: TaskOperation, now: number) {
    const previous = this.occurrence(entity.id)
    if (previous && previous.creation.status !== 'cancelled') return
    if (previous) this.db.prepare('DELETE FROM task_occurrences WHERE source_id=?').run(entity.id)
    const next = recurringTaskFields(entity, now)
    const created = this.enqueueCreate({ ...entity, ...next, id: crypto.randomUUID(), remote: undefined }, completion.id)
    this.db.prepare('INSERT INTO task_occurrences VALUES(?,?,?)').run(entity.id, completion.id, created.operation.id)
    const tasks = this.entities(entity.accountId, entity.provider)
    const copyChildren = (sourceId: string, parentId: string, visited: Set<string>) => {
      if (visited.has(sourceId)) throw new Error('Task hierarchy cannot contain a cycle')
      const branch = new Set([...visited, sourceId])
      for (const child of tasks.filter((task) => task.parentId === sourceId)) {
        this.writable(child)
        const copy = this.enqueueCreate({ ...child, id: crypto.randomUUID(), parentId, remote: undefined, fields: { ...child.fields, completed: false } })
        copyChildren(child.id, copy.entity.id, branch)
      }
    }
    copyChildren(entity.id, created.entity.id, new Set())
  }

  update(id: string, patch: TaskFieldPatch, now = Date.now(), local?: TaskLocalMetadata) {
    this.validatePatch(patch)
    const entity = this.entity(id)
    if (!entity) throw new Error('Task not found')
    this.writable(entity)
    this.validateProviderFields(entity, patch)
    if (local !== undefined) this.validateLocal(local)
    return this.transaction(() => {
      if (local !== undefined) { this.setLocal(id, local); entity.local = local }
      const operation = this.insert('update', entity, patch)
      if (entity.provider !== 'microsoft' && patch.completed === true && !entity.fields.completed && entity.local.recurrence !== 'none') this.generateOccurrence({ ...entity, fields: apply(entity.fields, patch) }, operation, now)
      return operation
    })
  }

  delete(id: string) {
    const entity = this.entity(id)
    if (!entity) throw new Error('Task not found')
    this.writable(entity)
    if (this.entities(entity.accountId, entity.provider).some((child) => child.parentId === id)) throw new Error('Delete or move subtasks first')
    return this.transaction(() => this.insert('delete', entity))
  }

  move(id: string, parentId?: string) {
    const entity = this.entity(id)
    if (!entity) throw new Error('Task not found')
    if (entity.provider === 'microsoft') throw new Error('Microsoft To Do does not support reparenting')
    this.writable(entity)
    const visited = new Set([id])
    let ancestor = parentId
    while (ancestor) {
      if (visited.has(ancestor)) throw new Error('Task hierarchy cannot contain a cycle')
      visited.add(ancestor)
      const parent = this.entity(ancestor)
      if (!parent || parent.accountId !== entity.accountId || parent.provider !== entity.provider || parent.listId !== entity.listId) throw new Error('Invalid parent task')
      this.writable(parent)
      ancestor = parent.parentId
    }
    return this.transaction(() => this.insert('move', entity, {}, parentId))
  }

  private validateLocal(local: TaskLocalMetadata) {
    if (!local || Object.keys(local).some((key) => !['priority', 'recurrence', 'timedDue'].includes(key)) || !['low', 'normal', 'high'].includes(local.priority) || !['none', 'daily', 'weekly', 'monthly'].includes(local.recurrence) || (local.timedDue !== undefined && (typeof local.timedDue !== 'string' || !Number.isFinite(Date.parse(local.timedDue))))) throw new Error('Invalid local task metadata')
  }

  setLocal(id: string, local: TaskLocalMetadata) {
    this.validateLocal(local)
    const row = this.row(id)
    if (!row) throw new Error('Task not found')
    if (row.provider === 'microsoft' && (local.recurrence !== 'none' || local.timedDue !== undefined || local.priority !== 'normal')) throw new Error('Use Microsoft native task fields for recurrence, priority and due times')
    this.db.prepare('UPDATE task_entities SET local_json=? WHERE id=?').run(JSON.stringify(local), id)
  }

  next(now = Date.now(), eligible: (operation: TaskOperation) => boolean = () => true): TaskOperation | undefined {
    const operations = this.operations()
    return operations.find((operation) => operation.status === 'queued' && operation.retryAt <= now && eligible(operation) && (!operation.dependsOn || operations.some((dependency) => dependency.id === operation.dependsOn && dependency.status === 'succeeded')) && !operations.some((earlier) => earlier.sequence < operation.sequence && earlier.entityId === operation.entityId && active.has(earlier.status)) && (!operation.parentId || Boolean(this.entity(operation.parentId)?.remote)))
  }

  start(id: string) {
    return this.transaction(() => {
      const operation = this.operations().find((item) => item.id === id)
      if (!operation || operation.status !== 'queued') throw new Error('Task operation is not queued')
      // Undo restores the state actually written over, including successful
      // earlier writes, rather than a cancelled optimistic UI projection.
      if (operation.base) {
        operation.before.fields = fields(operation.base)
        const parent = operation.base.parentId ? this.db.prepare('SELECT id FROM task_entities WHERE remote_key=?').get(operation.base.parentId) : undefined
        operation.before.parentId = parent ? String(parent.id) : undefined
      }
      this.db.prepare("UPDATE task_operations SET status='running',attempts=attempts+1,payload_json=? WHERE id=?").run(JSON.stringify(operation), id)
      return this.operations().find((item) => item.id === id)!
    })
  }

  fail(id: string, status: 'queued' | 'failed' | 'conflict' | 'review', error: string, retryAt = 0) {
    this.db.prepare("UPDATE task_operations SET status=?,error=?,retry_at=? WHERE id=? AND status='running'").run(status, error, retryAt, id)
  }

  succeed(id: string, remote?: ProviderTask) {
    this.transaction(() => this.finish(id, remote))
  }

  private finish(id: string, remote?: ProviderTask) {
      const operation = this.operations().find((item) => item.id === id)
      if (!operation || operation.status !== 'running') throw new Error('Task operation is not running')
      const row = this.row(operation.entityId)!
      if (operation.kind !== 'delete') {
        if (!remote || remote.accountId !== row.account_id || remote.provider !== row.provider || remote.listId !== row.list_id) throw new Error('Provider returned an unrelated task')
        this.db.prepare('UPDATE task_entities SET remote_key=?,remote_json=?,initial_json=?,present=1 WHERE id=?').run(remote.id, JSON.stringify(remote), JSON.stringify(fields(remote)), row.id)
        if (operation.kind === 'move' || operation.kind === 'create') {
          const parent = remote.parentId ? this.db.prepare('SELECT id FROM task_entities WHERE remote_key=?').get(remote.parentId) : undefined
          this.db.prepare('UPDATE task_entities SET parent_id=? WHERE id=?').run(parent ? String(parent.id) : null, row.id)
        }
        // Rebase only local descendants of this successful write. A refresh
        // never rewrites mutation baselines to a newer external revision.
        for (const later of this.operations(row.id).filter((item) => item.sequence > operation.sequence && item.status === 'queued' && (!item.base || item.base.revision === operation.base?.revision))) {
          later.base = remote
          this.db.prepare('UPDATE task_operations SET payload_json=? WHERE id=?').run(JSON.stringify(later), later.id)
        }
      } else this.db.prepare('UPDATE task_entities SET present=0,remote_key=NULL,remote_json=NULL WHERE id=?').run(row.id)
      operation.result = remote
      this.db.prepare("UPDATE task_operations SET status='succeeded',error=NULL,payload_json=? WHERE id=?").run(JSON.stringify(operation), id)
      const snapshot = this.providerSnapshot(row.account_id, row.provider)
      snapshot.tasks = snapshot.tasks.filter((task) => task.id !== operation.base?.id && task.id !== remote?.id)
      if (remote) snapshot.tasks.push(remote)
      this.db.prepare('INSERT INTO task_provider_snapshots VALUES(?,?,?) ON CONFLICT(account_id,provider) DO UPDATE SET payload_json=excluded.payload_json').run(row.account_id, row.provider, JSON.stringify(snapshot))
  }

  resolutionHistory(id: string): TaskResolutionRecord[] {
    return this.db.prepare('SELECT payload_json FROM task_resolution_history WHERE operation_id=? ORDER BY sequence').all(id).map((row) => JSON.parse(String(row.payload_json)))
  }

  resolve(id: string, resolution: TaskResolution) {
    return this.transaction(() => {
      const operation = this.operations().find((item) => item.id === id)
      if (!operation || !['failed', 'conflict', 'review'].includes(operation.status)) throw new Error('Task operation does not need resolution')
      if (!resolution || !['discard', 'retry', 'accept'].includes(resolution.action)) throw new Error('Invalid task resolution')
      const record: TaskResolutionRecord = { operationId: id, resolvedAt: new Date().toISOString(), resolution, previousStatus: operation.status, previousBase: operation.base }
      const snapshot = this.providerSnapshot(operation.accountId, operation.provider)
      if (resolution.action === 'discard') {
        const later = this.operations(operation.entityId).filter((item) => item.sequence >= operation.sequence && active.has(item.status))
        if (later.some((item) => item.status === 'running')) throw new Error('Wait for the running task operation')
        for (const item of later) {
          const occurrence = this.occurrence(item.entityId)
          if (occurrence?.completionId === item.id) {
            if (occurrence.creation.status !== 'cancelled' && !this.unsent(occurrence.creation)) throw new Error('Resolve the next occurrence first')
            this.cancelCreation(occurrence.creation)
            this.db.prepare('DELETE FROM task_occurrences WHERE source_id=?').run(item.entityId)
          }
          if (item.kind === 'create') this.cancelCreation(item)
          this.db.prepare("UPDATE task_operations SET status='cancelled',error=NULL WHERE id=?").run(item.id)
        }
      } else if (resolution.action === 'retry') {
        if (operation.status === 'review' && resolution.confirmedNotApplied !== true) throw new Error('Confirm the uncertain write was not applied before retrying')
        const current = operation.base ? snapshot.tasks.find((task) => task.id === operation.base!.id) : undefined
        if (operation.kind !== 'create' && (!current?.revision || current.revision !== resolution.expectedRevision)) throw new Error('The reviewed task revision changed; refresh and review it again')
        const entity = this.entity(operation.entityId) ?? operation.before
        this.writable({ ...entity, remote: current })
        const original = operation.base?.revision
        operation.base = current
        this.db.prepare("UPDATE task_operations SET status='queued',retry_at=0,error=NULL,payload_json=? WHERE id=?").run(JSON.stringify(operation), id)
        for (const later of this.operations(operation.entityId).filter((item) => item.sequence > operation.sequence && item.status === 'queued' && (!item.base || item.base.revision === original))) {
          later.base = current
          this.db.prepare('UPDATE task_operations SET payload_json=? WHERE id=?').run(JSON.stringify(later), later.id)
        }
      } else {
        const remote = resolution.remoteId ? snapshot.tasks.find((task) => task.id === resolution.remoteId) : undefined
        if (operation.kind === 'delete') {
          if (resolution.remoteId || !operation.base || snapshot.tasks.some((task) => task.id === operation.base!.id)) throw new Error('The deleted task is still present')
        } else {
          if (!remote?.revision || remote.revision !== resolution.expectedRevision || remote.listId !== operation.before.listId || remote.accountId !== operation.accountId || remote.provider !== operation.provider || (operation.kind !== 'create' && remote.id !== operation.base?.id)) throw new Error('Select the current task and revision from this account and list')
          const patch = operation.kind === 'create' ? operation.before.fields : operation.patch
          if (operation.kind === 'create' || operation.kind === 'update') {
            for (const [key, value] of Object.entries(patch)) {
              if (value === undefined) continue
              const actual = (remote as unknown as Record<string, unknown>)[key]
              if (key === 'native') {
                for (const [field, original] of Object.entries(value as Record<string, unknown>)) {
                  const expected = field === 'status' && patch.completed !== undefined ? patch.completed ? 'completed' : original === 'completed' ? 'notStarted' : original : field === 'dueTimeZone' && typeof patch.due === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(patch.due) ? 'UTC' : original
                  if (expected !== undefined && !isDeepStrictEqual(remote.native?.[field as keyof typeof remote.native] ?? (field === 'recurrence' ? null : undefined), expected)) throw new Error('The selected task does not match the intended native fields')
                }
                continue
              }
              const expected = value === null ? undefined : value
              if (key === 'due' && operation.provider === 'microsoft' && typeof expected === 'string' && typeof actual === 'string') {
                const normalized = (value: string) => new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : `${value}Z`).toISOString()
                const expectedZone = /(?:Z|[+-]\d{2}:\d{2})$/.test(expected) ? 'UTC' : patch.native?.dueTimeZone ?? operation.base?.native?.dueTimeZone ?? operation.before.fields.native?.dueTimeZone ?? 'UTC'
                if (normalized(actual) !== normalized(expected) || remote.native?.dueTimeZone !== expectedZone) throw new Error('The selected task does not match the intended due time')
                continue
              }
              // Providers represent cleared notes as either an absent field or
              // an empty string. Preserve nonempty text exactly when matching.
              const emptyNotes = key === 'notes' && (actual === undefined || actual === '') && (expected === undefined || expected === '')
              if (actual !== expected && !emptyNotes) throw new Error('The selected task does not match the intended write')
            }
          }
          if (operation.kind === 'create' || operation.kind === 'move') {
            const parent = operation.parentId ? this.entity(operation.parentId)?.remote?.id : undefined
            if ((operation.parentId && !parent) || remote.parentId !== parent) throw new Error('The selected task has a different parent')
          }
          const owner = this.db.prepare('SELECT id,local_json FROM task_entities WHERE remote_key=?').get(remote.id)
          if (owner && owner.id !== operation.entityId) {
            const ownerId = String(owner.id)
            if (this.operations(ownerId).length || this.operations().some((item) => active.has(item.status) && item.parentId === ownerId) || JSON.stringify(JSON.parse(String(owner.local_json))) !== JSON.stringify(defaults())) throw new Error('The selected task already has local changes')
            this.db.prepare('UPDATE task_entities SET parent_id=? WHERE parent_id=?').run(operation.entityId, ownerId)
            for (const item of this.operations()) {
              if (item.parentId !== ownerId && item.before.parentId !== ownerId) continue
              if (item.parentId === ownerId) item.parentId = operation.entityId
              if (item.before.parentId === ownerId) item.before.parentId = operation.entityId
              this.db.prepare('UPDATE task_operations SET payload_json=? WHERE id=?').run(JSON.stringify(item), item.id)
            }
            this.db.prepare('DELETE FROM task_entities WHERE id=?').run(ownerId)
          }
        }
        this.db.prepare("UPDATE task_operations SET status='running' WHERE id=?").run(id)
        this.finish(id, remote)
      }
      this.db.prepare('INSERT INTO task_resolution_history(operation_id,payload_json) VALUES(?,?)').run(id, JSON.stringify(record))
      return this.operations().find((item) => item.id === id)!
    })
  }

  undo(id: string) {
    return this.transaction(() => {
      const operation = this.operations().find((item) => item.id === id)
      if (!operation) throw new Error('Task operation not found')
      if (this.operations().some((item) => item.undoOf === id && item.status !== 'cancelled')) throw new Error('Task operation was already undone')
      const occurrence = this.occurrence(operation.entityId)
      if (occurrence?.completionId === id) {
        const removed = occurrence.creation.status === 'succeeded' && !this.entity(occurrence.creation.entityId) && !this.operations(occurrence.creation.entityId).some((item) => active.has(item.status))
        if (occurrence.creation.status !== 'cancelled' && !removed && !this.unsent(occurrence.creation)) throw new Error('Resolve or undo the next occurrence first')
        if (this.unsent(occurrence.creation)) this.cancelCreation(occurrence.creation)
        this.db.prepare('DELETE FROM task_occurrences WHERE source_id=?').run(operation.entityId)
      }
      if (operation.status === 'queued' && operation.attempts === 0) {
        this.db.prepare("UPDATE task_operations SET status='cancelled' WHERE id=?").run(id)
        if (operation.kind === 'create') {
          this.cancelCreation(operation)
        }
        return undefined
      }
      if (operation.status !== 'succeeded') throw new Error('Resolve the task operation before undoing it')
      if (this.operations(operation.entityId).some((item) => item.sequence > operation.sequence && item.status !== 'cancelled')) throw new Error('Undo the newer task change first')
      const row = this.row(operation.entityId)!
      const entity = this.entity(row.id) ?? operation.before
      this.writable(entity)
      if (operation.kind === 'create') {
        if (this.entities(entity.accountId, entity.provider).some((child) => child.parentId === entity.id)) throw new Error('Undo or move subtasks first')
        return this.insert('delete', entity, {}, undefined, id, operation.result)
      }
      if (operation.kind === 'delete') return this.insert('create', { ...operation.before, remote: undefined }, operation.before.fields, operation.before.parentId, id, undefined)
      if (operation.kind === 'move') return this.insert('move', entity, {}, operation.before.parentId, id, operation.result)
      const inverse: TaskFieldPatch = {}
      for (const key of Object.keys(operation.patch) as (keyof TaskFieldPatch)[]) {
        if (operation.patch[key] === undefined) continue
        if (key === 'native') {
          inverse.native = {}
          for (const field of Object.keys(operation.patch.native!)) {
            const original = operation.before.fields.native?.[field as keyof NonNullable<ProviderTaskInput['native']>]
            if (original !== undefined) (inverse.native as Record<string, unknown>)[field] = original
            else if (field === 'recurrence') inverse.native.recurrence = null
            else if (field === 'priority') inverse.native.priority = 'normal'
          }
        } else (inverse as Record<string, unknown>)[key] = operation.before.fields[key] ?? null
      }
      if (operation.provider === 'microsoft') {
        if (operation.patch.notes !== undefined && operation.before.fields.native?.body) inverse.native = { ...inverse.native, body: operation.before.fields.native.body }
        if (operation.patch.completed !== undefined && operation.before.fields.native?.status) inverse.native = { ...inverse.native, status: operation.before.fields.native.status }
      }
      return this.insert('update', entity, inverse, undefined, id, operation.result)
    })
  }
}
