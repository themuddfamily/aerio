import type { ProviderTask, ProviderTaskInput, ProviderTaskList, ProviderTaskSnapshot, TaskProviderConnector } from '../../src/task-provider-types'
import { ProductivityApiError, retryingJson } from './connector'

interface GoogleTaskList { id: string; title?: string; etag?: string }
interface GoogleTask {
  id: string; title?: string; etag?: string; updated?: string; notes?: string
  parent?: string; position?: string; due?: string; status?: string; deleted?: boolean
  assignmentInfo?: unknown
}
interface GoogleTaskPage<T> { items?: T[]; nextPageToken?: string }
const base = 'https://tasks.googleapis.com/tasks/v1'
const identity = (account: string, kind: string, ...parts: string[]) => [account, `google-${kind}`, ...parts].map(encodeURIComponent).join(':')
const timestamp = (value?: string) => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : undefined

export class GoogleTasksConnector implements TaskProviderConnector {
  readonly provider = 'gmail' as const
  readonly capabilities = { recurrence: 'local', priority: 'local', due: 'date', subtasks: 'tasks' } as const

  constructor(private readonly accountId: string, private readonly token: () => Promise<string>, private readonly writeAuthorized = false) {}

  async sync(previous: ProviderTaskSnapshot = { lists: [], tasks: [], checkpoints: {} }): Promise<ProviderTaskSnapshot> {
    const remoteLists = await this.pages<GoogleTaskList>(`${base}/users/@me/lists?maxResults=1000`)
    const lists = [...new Map(remoteLists.map((list) => { const mapped = this.mapList(list); return [mapped.id, mapped] })).values()]
    const tasks: ProviderTask[] = []
    const checkpoints: Record<string, string> = {}
    for (const list of lists) {
      const checkpoint = previous.checkpoints[list.id]
      const cursor = timestamp(checkpoint) !== undefined ? checkpoint : undefined
      const url = new URL(`${this.listResource(list.remoteId)}/tasks`)
      url.searchParams.set('maxResults', '100')
      url.searchParams.set('showCompleted', 'true')
      url.searchParams.set('showHidden', 'true')
      url.searchParams.set('showDeleted', 'true')
      url.searchParams.set('showAssigned', 'true')
      if (cursor) url.searchParams.set('updatedMin', cursor)
      let delta: GoogleTask[]
      let incremental = Boolean(cursor)
      try { delta = await this.pages<GoogleTask>(url.toString()) }
      catch (error) {
        if (!cursor || !(error instanceof ProductivityApiError) || ![400, 410].includes(error.status)) throw error
        url.searchParams.delete('updatedMin')
        delta = await this.pages<GoogleTask>(url.toString())
        incremental = false
      }
      const merged = new Map<string, ProviderTask>(incremental ? previous.tasks.filter((task) => task.accountId === this.accountId && task.provider === this.provider && task.listId === list.id).map((task) => [task.id, { ...task, readOnly: !this.writeAuthorized || Boolean(task.assigned) || !task.revision }]) : [])
      let newest: number | undefined
      for (const remote of delta) {
        this.requireId(remote.id)
        const changed = timestamp(remote.updated)
        if (changed !== undefined) newest = Math.max(newest ?? changed, changed)
        const id = identity(this.accountId, 'task', list.remoteId, remote.id)
        if (remote.deleted) merged.delete(id)
        else {
          const mapped = this.mapTask(list.remoteId, remote)
          const cached = merged.get(id)
          if (!cached || changed === undefined || (timestamp(cached.updatedAt) ?? 0) <= changed) merged.set(id, mapped)
        }
      }
      tasks.push(...merged.values())
      // Use provider timestamps rather than the desktop clock, with overlap
      // at the boundary. An empty delta never advances the checkpoint.
      const next = newest === undefined ? (incremental ? cursor : undefined) : new Date(Math.max(incremental ? timestamp(cursor) ?? 0 : 0, newest - 1_000)).toISOString()
      if (next) checkpoints[list.id] = next
    }
    return { lists, tasks, checkpoints }
  }

  async createList(title: string) {
    this.assertWritable()
    return this.mapList(await this.write<GoogleTaskList>(`${base}/users/@me/lists`, 'POST', { title: this.title(title) }))
  }

  async updateList(current: ProviderTaskList, title: string) {
    this.assertCurrent(current)
    const body = { title: this.title(title) }
    const resource = `${base}/users/@me/lists/${encodeURIComponent(current.remoteId)}`
    await this.assertRevision(resource, current.revision!)
    return this.mapList(await this.write<GoogleTaskList>(resource, 'PATCH', body, current.revision))
  }

  async deleteList(current: ProviderTaskList) {
    this.assertCurrent(current)
    const resource = `${base}/users/@me/lists/${encodeURIComponent(current.remoteId)}`
    await this.assertRevision(resource, current.revision!)
    await this.write<void>(resource, 'DELETE', undefined, current.revision)
  }

  async createTask(list: ProviderTaskList, input: ProviderTaskInput, parent?: ProviderTask) {
    this.assertWritable()
    if (list.accountId !== this.accountId || list.provider !== this.provider || list.readOnly || list.id !== identity(this.accountId, 'task-list', list.remoteId)) throw new Error('That task list is not writable')
    const url = new URL(`${this.listResource(list.remoteId)}/tasks`)
    if (parent) {
      this.assertCurrent(parent)
      if (parent.remoteListId !== list.remoteId) throw new Error('A subtask must belong to its parent task list')
      url.searchParams.set('parent', parent.remoteId)
    }
    return this.mapTask(list.remoteId, await this.write<GoogleTask>(url.toString(), 'POST', this.body(input)))
  }

  async updateTask(current: ProviderTask, input: ProviderTaskInput) {
    this.assertCurrent(current)
    const body = this.body(input)
    const resource = this.taskResource(current)
    await this.assertRevision(resource, current.revision!)
    return this.mapTask(current.remoteListId, await this.write<GoogleTask>(resource, 'PATCH', body, current.revision))
  }

  async deleteTask(current: ProviderTask) {
    this.assertCurrent(current)
    const resource = this.taskResource(current)
    await this.assertRevision(resource, current.revision!)
    await this.write<void>(resource, 'DELETE', undefined, current.revision)
  }

  async moveTask(current: ProviderTask, parent?: ProviderTask) {
    this.assertCurrent(current)
    const url = new URL(`${this.taskResource(current)}/move`)
    if (parent) {
      this.assertCurrent(parent)
      if (parent.remoteListId !== current.remoteListId || parent.remoteId === current.remoteId) throw new Error('A task needs a different parent in the same task list')
      url.searchParams.set('parent', parent.remoteId)
    }
    await this.assertRevision(this.taskResource(current), current.revision!)
    return this.mapTask(current.remoteListId, await this.write<GoogleTask>(url.toString(), 'POST', undefined, current.revision))
  }

  private mapList(remote: GoogleTaskList): ProviderTaskList {
    this.requireId(remote.id)
    return { id: identity(this.accountId, 'task-list', remote.id), accountId: this.accountId, provider: this.provider, remoteId: remote.id, title: remote.title?.trim() || '(Untitled list)', revision: remote.etag, readOnly: !this.writeAuthorized || !remote.etag }
  }

  private mapTask(listId: string, remote: GoogleTask): ProviderTask {
    this.requireId(remote.id)
    return { id: identity(this.accountId, 'task', listId, remote.id), accountId: this.accountId, provider: this.provider, remoteId: remote.id, listId: identity(this.accountId, 'task-list', listId), remoteListId: listId, parentId: remote.parent ? identity(this.accountId, 'task', listId, remote.parent) : undefined, position: remote.position, revision: remote.etag, updatedAt: remote.updated, title: remote.title?.trim() || '(Untitled task)', notes: remote.notes, due: remote.due?.slice(0, 10), completed: remote.status === 'completed', readOnly: !this.writeAuthorized || Boolean(remote.assignmentInfo) || !remote.etag, assigned: Boolean(remote.assignmentInfo) }
  }

  private body(input: ProviderTaskInput) {
    if (typeof input.completed !== 'boolean' || (input.notes !== undefined && (typeof input.notes !== 'string' || input.notes.length > 8192))) throw new Error('Invalid task details')
    if (input.due !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(input.due) || !Number.isFinite(Date.parse(`${input.due}T00:00:00.000Z`)) || new Date(`${input.due}T00:00:00.000Z`).toISOString().slice(0, 10) !== input.due)) throw new Error('Google Tasks due dates must be valid calendar dates')
    return { title: this.title(input.title), notes: input.notes ?? '', due: input.due ? `${input.due}T00:00:00.000Z` : null, status: input.completed ? 'completed' : 'needsAction', ...(!input.completed ? { completed: null } : {}) }
  }

  private title(value: string) {
    if (typeof value !== 'string' || !value.trim() || value.length > 1024) throw new Error('Task titles must contain 1 to 1024 characters')
    return value.trim()
  }

  private requireId(id: string) {
    if (typeof id !== 'string' || !id) throw new Error('Google Tasks returned an invalid identifier')
  }

  private assertWritable() {
    if (!this.writeAuthorized) throw new Error('Reconnect this Google account to enable Tasks editing')
  }

  private assertCurrent(current: ProviderTask | ProviderTaskList) {
    this.assertWritable()
    const expected = 'remoteListId' in current ? identity(this.accountId, 'task', current.remoteListId, current.remoteId) : identity(this.accountId, 'task-list', current.remoteId)
    if (current.accountId !== this.accountId || current.provider !== this.provider || current.readOnly || ('assigned' in current && current.assigned) || current.id !== expected) throw new Error('That task or list is not writable')
    if (!current.revision) throw new Error('Refresh Tasks before editing an item without its original revision')
  }

  private async assertRevision(resource: string, revision: string) {
    const remote = await retryingJson<{ etag?: string }>(this.provider, resource, this.token)
    if (remote.etag !== revision) throw new ProductivityApiError('This task or list changed in another client. Refresh before editing.', this.provider, 412)
  }

  private listResource(id: string) { return `${base}/lists/${encodeURIComponent(id)}` }
  private taskResource(task: ProviderTask) { return `${this.listResource(task.remoteListId)}/tasks/${encodeURIComponent(task.remoteId)}` }

  private async write<T>(url: string, method: string, body?: unknown, revision?: string): Promise<T> {
    // POST responses may be lost after creation. Leave recovery to the durable
    // operation ledger rather than retrying and creating duplicate tasks.
    const response = await fetch(url, { method, headers: { Authorization: `Bearer ${await this.token()}`, Accept: 'application/json', 'Content-Type': 'application/json', ...(revision ? { 'If-Match': revision } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    if (!response.ok) throw new ProductivityApiError(response.status === 412 ? 'This task or list changed in another client. Refresh before editing.' : `Google Tasks write failed (${response.status})`, this.provider, response.status)
    return response.status === 204 ? undefined as T : await response.json() as T
  }

  private async pages<T>(initial: string) {
    const items: T[] = []
    const seen = new Set<string>()
    let url = initial
    while (true) {
      const page = await retryingJson<GoogleTaskPage<T>>(this.provider, url, this.token)
      if (page.items !== undefined && !Array.isArray(page.items)) throw new Error('Google Tasks returned an invalid page')
      items.push(...(page.items ?? []))
      if (!page.nextPageToken) return items
      if (typeof page.nextPageToken !== 'string' || seen.has(page.nextPageToken)) throw new Error('Google Tasks repeated a pagination token')
      seen.add(page.nextPageToken)
      const next = new URL(initial); next.searchParams.set('pageToken', page.nextPageToken); url = next.toString()
    }
  }
}
