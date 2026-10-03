import type { MailAccountSummary } from '../../src/mail-types'
import type { ProviderTaskInput, TaskAccountState, TaskFieldPatch, TaskLocalMetadata, TaskProvider, TaskProviderConnector, TaskResolution, TaskSnapshot } from '../../src/task-provider-types'
import { TaskStore } from './task-store'
import { TaskSyncEngine } from './task-sync-engine'
import type { TaskBackup } from './task-backup'

interface TaskServiceOptions {
  accounts: () => Promise<MailAccountSummary[]>
  access: (accountId: string, provider: TaskProvider) => { read: boolean; write: boolean }
  connector: (accountId: string, provider: TaskProvider) => TaskProviderConnector
  online: () => boolean
  changed: (snapshot: TaskSnapshot) => void
}

export class TaskService {
  private accounts: MailAccountSummary[] = []
  private states = new Map<string, Pick<TaskAccountState, 'phase' | 'error'>>()
  private disabled = new Set<string>()
  private writeRefreshBlocked = new Set<string>()
  private pending: Promise<unknown> = Promise.resolve()
  private closing = false
  private engine: TaskSyncEngine

  constructor(private readonly store: TaskStore, private readonly options: TaskServiceOptions) {
    this.engine = new TaskSyncEngine(store, {
      online: () => !this.closing && options.online(),
      connector: (id, provider) => this.provider(id) === provider && this.available(id) && !this.writeRefreshBlocked.has(id) && options.access(id, provider).write ? options.connector(id, provider) : undefined,
      changed: () => this.emit()
    })
  }

  private available(id: string) {
    const account = this.accounts.find((item) => item.id === id)
    return !this.closing && Boolean(this.provider(id)) && account && !account.archived && account.syncEnabled && !this.disabled.has(id) && account.status !== 'needs-auth' && account.status !== 'error'
  }

  private provider(id: string): TaskProvider | undefined {
    const provider = this.accounts.find((account) => account.id === id)?.provider
    return provider === 'gmail' || provider === 'microsoft' ? provider : undefined
  }
  private access(id: string) { const provider = this.provider(id); return provider ? this.options.access(id, provider) : { read: false, write: false } }

  private async reload() { this.accounts = await this.options.accounts() }
  private serial<T>(callback: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('Task service is closed'))
    const request = this.pending.then(callback)
    this.pending = request.catch(() => {})
    return request
  }

  private view(): TaskSnapshot {
    const result: TaskSnapshot = { lists: [], tasks: [], remoteTasks: [], operations: [], accounts: [], listOperations: [] }
    const visible = this.accounts.filter((item) => item.provider === 'gmail' || item.provider === 'microsoft').map((account) => ({ ...account, recovered: false }))
    for (const account of this.store.cachedAccounts()) if (!visible.some((item) => item.id === account.accountId && item.provider === account.provider)) visible.push({ id: account.accountId, provider: account.provider, email: '', displayName: account.provider === 'gmail' ? 'Recovered Google tasks' : 'Recovered Microsoft tasks', color: '#6558e8', signature: '', notifications: false, status: 'ready', archived: true, syncEnabled: false, recovered: true })
    for (const account of visible) {
      const provider = account.provider as TaskProvider
      const connected = !account.archived && !this.disabled.has(account.id) && account.syncEnabled
      const access = connected ? this.options.access(account.id, provider) : { read: false, write: false }
      const canRead = connected && access.read
      const canWrite = connected && access.write
      result.accounts.push({ accountId: account.id, provider, canRead, canWrite, archived: account.archived, recovered: account.recovered, syncEnabled: account.syncEnabled, ...this.states.get(account.id) ?? (account.status === 'needs-auth' ? { phase: 'error', error: 'needs-consent' } : account.status === 'error' ? { phase: 'error', error: 'sync-failed' } : { phase: 'idle' }) })
      const snapshot = this.store.providerSnapshot(account.id, provider)
      result.lists.push(...snapshot.lists.map((list) => ({ ...list, readOnly: list.readOnly || !canWrite || this.store.listQueue.blocked(list.id) })))
      result.tasks.push(...this.store.entities(account.id, provider))
      result.remoteTasks.push(...snapshot.tasks)
      result.operations.push(...this.store.operations().filter((item) => item.accountId === account.id && item.provider === provider))
      result.listOperations!.push(...this.store.listQueue.operations().filter((item) => item.accountId === account.id && item.provider === provider))
    }
    return result
  }

  private emit() { this.options.changed(this.view()) }
  private async dispatch() {
    if (this.options.online()) {
      const queuedAccounts = new Set([...this.store.operations(), ...this.store.listQueue.operations()].filter((operation) => operation.status === 'queued').map((operation) => operation.accountId))
      for (const id of queuedAccounts) {
        if (!this.available(id) || !this.access(id).write) continue
        const snapshot = this.store.providerSnapshot(id, this.provider(id)!)
        const stalePermissions = snapshot.lists.some((list) => list.readOnly) || snapshot.tasks.some((task) => task.readOnly && !task.assigned)
        if (!stalePermissions) { this.writeRefreshBlocked.delete(id); continue }
        // A new write grant does not rewrite cached permission flags. Refresh
        // first, while retaining every queued operation's original revision.
        // A failed read holds the queue rather than manufacturing write failures.
        try { await this.refresh(id, true) }
        catch { this.writeRefreshBlocked.add(id) }
      }
    }
    await this.engine.flush()
  }
  async snapshot() { await this.reload(); return this.view() }
  exportBackup(): Promise<TaskBackup> { return this.serial(async () => this.store.exportBackup()) }
  restoreBackup(value: unknown): Promise<TaskSnapshot> {
    return this.serial(async () => { await this.reload(); this.store.restoreBackup(value); this.states.clear(); this.emit(); return this.view() })
  }

  sync(accountId: string): Promise<TaskSnapshot> {
    return this.serial(async () => {
      await this.reload()
      await this.refresh(accountId, false)
      await this.dispatch()
      return this.view()
    })
  }

  private async refresh(id: string, full: boolean) {
    const provider = this.provider(id)
    if (!provider || !this.available(id) || !this.access(id).read) {
      this.states.set(id, { phase: 'error', error: 'needs-consent' }); this.emit()
      throw new Error('Reconnect this account to enable Tasks')
    }
    if (!this.options.online()) {
      this.states.set(id, { phase: 'error', error: 'offline' }); this.emit()
      throw new Error('Tasks will synchronize when Aerio is online')
    }
    this.states.set(id, { phase: 'syncing' }); this.emit()
    try {
      const connector = this.options.connector(id, provider)
      if (connector.provider !== provider) throw new Error('Task connector belongs to another provider')
      const snapshot = await connector.sync(full ? undefined : this.store.providerSnapshot(id, provider))
      if (!this.available(id)) return
      this.store.replaceProviderSnapshot(id, provider, snapshot)
      this.writeRefreshBlocked.delete(id)
      this.states.set(id, { phase: 'ready' }); this.emit()
    } catch {
      this.states.set(id, { phase: 'error', error: 'sync-failed' }); this.emit()
      throw new Error('Tasks synchronization failed; cached tasks are preserved')
    }
  }

  private writable(accountId: string) {
    const account = this.accounts.find((item) => item.id === accountId)
    // Cached consent permits saving offline intent even when mail reports an
    // authentication/network failure. available() separately gates dispatch.
    if (this.closing || !account || !this.provider(accountId) || account.archived || !account.syncEnabled || this.disabled.has(accountId) || !this.access(accountId).write) throw new Error('Reconnect an active account with Tasks write access')
    return this.provider(accountId)!
  }

  private edit(callback: () => void): Promise<TaskSnapshot> {
    return this.serial(async () => {
      await this.reload()
      callback(); this.emit()
      // Local intent is durable before any network request. Queue processing
      // shares the same serial lane as refresh and explicit reconciliation.
      void this.serial(async () => { await this.reload(); await this.dispatch() }).catch(() => {})
      return this.view()
    })
  }

  create(accountId: string, listId: string, input: ProviderTaskInput, parentId?: string, local?: TaskLocalMetadata) {
    return this.edit(() => { const provider = this.writable(accountId); this.store.create(accountId, provider, listId, input, parentId, local) })
  }
  createList(accountId: string, title: string) { return this.edit(() => { const provider = this.writable(accountId); this.store.listQueue.enqueue(accountId, provider, 'create', title) }) }
  private writableList(listId: string) {
    for (const account of this.accounts) {
      const provider = this.provider(account.id)
      if (!provider) continue
      const list = this.store.providerSnapshot(account.id, provider).lists.find((item) => item.id === listId)
      if (list) { this.writable(account.id); return list }
    }
    throw new Error('Task list not found')
  }
  renameList(listId: string, title: string) { return this.edit(() => { const list = this.writableList(listId); this.store.listQueue.enqueue(list.accountId, list.provider, 'update', title, listId) }) }
  deleteList(listId: string) { return this.edit(() => { const list = this.writableList(listId); this.store.listQueue.enqueue(list.accountId, list.provider, 'delete', undefined, listId) }) }
  resolveList(id: string, resolution: TaskResolution): Promise<TaskSnapshot> {
    return this.serial(async () => {
      await this.reload()
      const operation = this.store.listQueue.operations().find((item) => item.id === id)
      if (!operation) throw new Error('Task list change not found')
      if (this.writable(operation.accountId) !== operation.provider) throw new Error('This list change belongs to another provider')
      if (resolution?.action !== 'discard') await this.refresh(operation.accountId, true)
      this.writable(operation.accountId)
      this.store.listQueue.resolve(id, resolution); this.emit()
      await this.dispatch()
      return this.view()
    })
  }
  update(id: string, patch: TaskFieldPatch, local?: TaskLocalMetadata) { return this.edit(() => { this.writableEntity(id); this.store.update(id, patch, Date.now(), local) }) }
  delete(id: string) { return this.edit(() => { this.writableEntity(id); this.store.delete(id) }) }
  move(id: string, parentId?: string) { return this.edit(() => { this.writableEntity(id); this.store.move(id, parentId) }) }
  setLocal(id: string, local: TaskLocalMetadata) { return this.edit(() => { this.writableEntity(id); this.store.setLocal(id, local) }) }
  undo(id: string) { return this.edit(() => { this.writableOperation(id); this.store.undo(id) }) }
  private writableEntity(id: string) {
    const task = this.store.entity(id)
    if (!task) throw new Error('Task not found')
    if (this.writable(task.accountId) !== task.provider) throw new Error('This task belongs to another provider')
  }
  private writableOperation(id: string) {
    const operation = this.store.operations().find((item) => item.id === id)
    if (!operation) throw new Error('Task operation not found')
    if (this.writable(operation.accountId) !== operation.provider) throw new Error('This task change belongs to another provider')
    return operation
  }

  resolve(id: string, resolution: TaskResolution): Promise<TaskSnapshot> {
    return this.serial(async () => {
      if (!resolution || !['discard', 'retry', 'accept'].includes(resolution.action)) throw new Error('Invalid task resolution')
      await this.reload()
      const operation = this.writableOperation(id)
      // Full refresh, rather than an incremental result, establishes absence
      // for deletion reconciliation and provides candidates for lost creates.
      if (resolution.action !== 'discard') await this.refresh(operation.accountId, true)
      this.writable(operation.accountId)
      this.store.resolve(id, resolution); this.emit()
      await this.dispatch()
      return this.view()
    })
  }

  async flush() { return this.serial(async () => { await this.reload(); await this.dispatch() }) }
  async poll() {
    return this.serial(async () => {
      await this.reload()
      if (!this.options.online()) return
      for (const account of this.accounts) {
        if (!this.available(account.id) || !this.access(account.id).read) continue
        try { await this.refresh(account.id, false) } catch { /* Keep other account refreshes independent. */ }
      }
      await this.dispatch()
    })
  }
  async stopAccount(id: string) { this.disabled.add(id); await this.pending; this.emit() }
  async removeAccount(id: string) { await this.stopAccount(id); this.store.removeAccount(id); await this.reload(); this.emit() }
  accountChanged() { return this.serial(async () => { await this.reload(); this.emit() }) }
  resumeAccount(id: string) {
    this.disabled.delete(id)
    void this.accountChanged().catch(() => {})
  }
  async close() { this.closing = true; await this.pending; this.store.close() }
}
