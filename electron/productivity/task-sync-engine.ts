import { ProductivityApiError } from './connector'
import { TaskStore } from './task-store'
import { applyTaskFields, providerTaskFields } from './task-fields'
import type { ProviderTaskInput, TaskOperation, TaskProvider, TaskProviderConnector } from '../../src/task-provider-types'

interface TaskSyncOptions {
  online: () => boolean
  connector: (accountId: string, provider: TaskProvider) => TaskProviderConnector | undefined
  changed?: () => void
  now?: () => number
}

// One engine owns the store's queue. It does not schedule network access or
// retry uncertain writes; the app decides when to flush and presents reviews.
export class TaskSyncEngine {
  private flushing?: Promise<void>
  constructor(private readonly store: TaskStore, private readonly options: TaskSyncOptions) {}

  flush(): Promise<void> {
    if (this.flushing) return this.flushing
    this.flushing = this.run().finally(() => { this.flushing = undefined })
    return this.flushing
  }

  private async run() {
    await this.runLists()
    while (this.options.online()) {
      const now = this.options.now?.() ?? Date.now()
      const next = this.store.next(now, (operation) => Boolean(this.options.connector(operation.accountId, operation.provider)))
      if (!next) return
      const connector = this.options.connector(next.accountId, next.provider)
      if (!connector) return
      const operation = this.store.start(next.id)
      let dispatched = false
      try {
        const snapshot = this.store.providerSnapshot(operation.accountId, operation.provider)
        const list = snapshot.lists.find((item) => item.id === operation.before.listId)
        const current = snapshot.tasks.find((task) => task.id === operation.base?.id)
        if (connector.provider !== operation.provider || !list || list.readOnly || operation.base?.readOnly || operation.base?.assigned || current?.readOnly || current?.assigned) throw new Error('permission')
        const parent = operation.parentId ? this.store.entity(operation.parentId)?.remote : undefined
        if (operation.parentId && (!parent || parent.accountId !== operation.accountId || parent.listId !== list.id || parent.readOnly || parent.assigned)) throw new Error('parent')
        if (operation.kind !== 'create' && (!operation.base || !operation.base.revision)) throw new Error('baseline')
        if (operation.kind === 'move' && connector.capabilities.reparent === false) throw new Error('reparent')
        if (connector.capabilities.subtasks === 'checklist' && parent?.kind === 'checklist') throw new Error('parent')
        if (operation.kind === 'delete' && snapshot.tasks.some((task) => task.parentId === operation.base!.id)) throw new Error('subtasks')
        const input = this.input(operation)
        if (connector.capabilities.subtasks === 'checklist' && (operation.base?.kind === 'checklist' || (operation.kind === 'create' && parent)) && (input.notes || input.due || (input.native && Object.values(input.native).some((value) => value !== undefined)))) throw new Error('checklist')
        dispatched = true
        if (operation.kind === 'create') this.store.succeed(operation.id, await connector.createTask(list, input, parent))
        else if (operation.kind === 'update') this.store.succeed(operation.id, await connector.updateTask(operation.base!, input))
        else if (operation.kind === 'move') this.store.succeed(operation.id, await connector.moveTask(operation.base!, parent))
        else { await connector.deleteTask(operation.base!); this.store.succeed(operation.id) }
      } catch (error) {
        // Persistence failure after a successful HTTP response is also
        // uncertain. Preserve the operation for review instead of resending.
        if (!dispatched) this.store.fail(operation.id, 'failed', 'precondition')
        else if (error instanceof ProductivityApiError && error.provider === operation.provider) {
          if (error.status === 404 && operation.kind === 'delete') {
            try { this.store.succeed(operation.id) }
            catch { this.store.fail(operation.id, 'review', 'uncertain-write') }
          }
          else if ([404, 409, 412].includes(error.status)) this.store.fail(operation.id, 'conflict', 'revision-conflict')
          else if (error.status === 429 && operation.attempts < 5) this.store.fail(operation.id, 'queued', 'rate-limited', now + Math.min(60_000, 1000 * 2 ** (operation.attempts - 1)))
          else if (error.status >= 400 && error.status < 500 && error.status !== 408) this.store.fail(operation.id, 'failed', error.status === 429 ? 'rate-limit-exhausted' : 'provider-rejected')
          else this.store.fail(operation.id, 'review', 'uncertain-write')
        } else this.store.fail(operation.id, 'review', 'uncertain-write')
      }
      this.options.changed?.()
    }
  }

  private async runLists() {
    while (this.options.online()) {
      const now = this.options.now?.() ?? Date.now()
      const next = this.store.listQueue.next(now, (operation) => Boolean(this.options.connector(operation.accountId, operation.provider)))
      if (!next) return
      const connector = this.options.connector(next.accountId, next.provider)
      if (!connector) return
      const operation = this.store.listQueue.start(next.id)
      let dispatched = false
      try {
        const current = this.store.providerSnapshot(operation.accountId, operation.provider).lists.find((list) => list.id === operation.base?.id)
        if (connector.provider !== operation.provider || (operation.kind !== 'create' && (!operation.base?.revision || operation.base.readOnly || operation.base.manageReadOnly || current?.readOnly || current?.manageReadOnly))) throw new Error('precondition')
        if (operation.kind === 'delete' && !this.store.listQueue.deletionReady(operation.base!)) throw new Error('protected-tasks')
        dispatched = true
        if (operation.kind === 'create') this.store.listQueue.succeed(operation.id, await connector.createList(operation.title!))
        else if (operation.kind === 'update') this.store.listQueue.succeed(operation.id, await connector.updateList(operation.base!, operation.title!))
        else { await connector.deleteList(operation.base!); this.store.listQueue.succeed(operation.id) }
      } catch (error) {
        if (!dispatched) this.store.listQueue.fail(operation.id, 'failed', 'precondition')
        else if (error instanceof ProductivityApiError && error.provider === operation.provider) {
          if (error.status === 404 && operation.kind === 'delete') {
            try { this.store.listQueue.succeed(operation.id) }
            catch { this.store.listQueue.fail(operation.id, 'review', 'uncertain-write') }
          } else if ([404, 409, 412].includes(error.status)) this.store.listQueue.fail(operation.id, 'conflict', 'revision-conflict')
          else if (error.status === 429 && operation.attempts < 5) this.store.listQueue.fail(operation.id, 'queued', 'rate-limited', now + Math.min(60_000, 1000 * 2 ** (operation.attempts - 1)))
          else if (error.status >= 400 && error.status < 500 && error.status !== 408) this.store.listQueue.fail(operation.id, 'failed', error.status === 429 ? 'rate-limit-exhausted' : 'provider-rejected')
          else this.store.listQueue.fail(operation.id, 'review', 'uncertain-write')
        } else this.store.listQueue.fail(operation.id, 'review', 'uncertain-write')
      }
      this.options.changed?.()
    }
  }

  private input(operation: TaskOperation): ProviderTaskInput {
    const base = operation.base
    return applyTaskFields(base ? providerTaskFields(base) : operation.before.fields, operation.patch)
  }
}
