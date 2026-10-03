import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import sanitizeHtml from 'sanitize-html'
import { decodeHTML, escapeText } from 'entities'
import type { ProviderTask, ProviderTaskInput, ProviderTaskList, ProviderTaskSnapshot, TaskNativeFields, TaskProviderConnector } from '../../src/task-provider-types'
import { ProductivityApiError, retryingJson } from './connector'
import { validTaskNativeFields } from './task-native-validation'

interface GraphList { id: string; displayName?: string; isOwner?: boolean; isShared?: boolean; wellknownListName?: string; '@odata.etag'?: string }
interface GraphTask { id: string; title?: string; status?: string; importance?: string; body?: { contentType: 'text' | 'html'; content: string }; dueDateTime?: { dateTime: string; timeZone: string } | null; recurrence?: TaskNativeFields['recurrence']; lastModifiedDateTime?: string; '@odata.etag'?: string; '@removed'?: unknown }
interface GraphChecklist { id: string; displayName?: string; isChecked?: boolean; createdDateTime?: string; checkedDateTime?: string; '@odata.etag'?: string }
interface GraphPage<T> { value: T[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string }
const base = 'https://graph.microsoft.com/v1.0/me/todo/lists'
const identity = (account: string, kind: string, ...parts: string[]) => [account, `microsoft-${kind}`, ...parts].map(encodeURIComponent).join(':')
const fingerprint = (value: unknown) => `snapshot:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
const listVersion = (list: GraphList) => list['@odata.etag'] || fingerprint([list.id, list.displayName ?? '', list.isOwner ?? false, list.isShared ?? false, list.wellknownListName ?? 'none'])
const checklistVersion = (item: GraphChecklist) => item['@odata.etag'] || fingerprint([item.id, item.displayName ?? '', item.isChecked ?? false, item.createdDateTime ?? null, item.checkedDateTime ?? null])
const day = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
const dateTime = (value: string) => /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,7})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/.test(value) && day(value.slice(0, 10)) && Number.isFinite(Date.parse(value))
const plainBody = (body?: GraphTask['body']) => {
  if (!body) return undefined
  if (body.contentType === 'text') return body.content
  // Sanitize before interpreting block breaks, then decode only plain text.
  const clean = sanitizeHtml(body.content, { allowedTags: ['p', 'div', 'br', 'li', 'h1', 'h2', 'h3'], allowedAttributes: {} })
  return decodeHTML(clean.replace(/<br\s*\/?\s*>|<\/(?:p|div|li|h[123])>/gi, '\n').replace(/<[^>]*>/g, '')).replace(/\n+$/, '')
}

export class MicrosoftTasksConnector implements TaskProviderConnector {
  readonly provider = 'microsoft' as const
  readonly capabilities = { recurrence: 'native', priority: 'native', due: 'date-time', subtasks: 'checklist', reparent: false } as const
  constructor(private readonly accountId: string, private readonly token: () => Promise<string>, private readonly writeAuthorized = false) {}

  async sync(previous: ProviderTaskSnapshot = { lists: [], tasks: [], checkpoints: {} }): Promise<ProviderTaskSnapshot> {
    if (previous.lists.some((list) => list.accountId !== this.accountId || list.provider !== this.provider) || previous.tasks.some((task) => task.accountId !== this.accountId || task.provider !== this.provider)) throw new Error('Task cache belongs to another account')
    const lists = (await this.pages<GraphList>(base)).items.map((list) => this.mapList(list))
    const tasks: ProviderTask[] = [], checkpoints: Record<string, string> = {}
    for (const list of lists) {
      const initial = `${this.listResource(list.remoteId)}/tasks/delta`
      const cursor = previous.checkpoints[list.id]
      let incremental = Boolean(cursor)
      let delta: { items: GraphTask[]; checkpoint?: string }
      try { delta = await this.pages<GraphTask>(cursor ? this.safeLink(cursor, initial) : initial, initial, true) }
      catch (error) {
        if (!cursor || !(error instanceof ProductivityApiError) || ![400, 404, 410].includes(error.status)) throw error
        incremental = false
        delta = await this.pages<GraphTask>(initial, initial, true)
      }
      const parents = new Map<string, ProviderTask>(incremental ? previous.tasks.filter((task) => task.kind !== 'checklist' && task.listId === list.id).map((task) => [task.id, { ...task, readOnly: !this.writeAuthorized || !task.revision }]) : [])
      for (const changed of delta.items) {
        this.requireId(changed.id)
        const id = identity(this.accountId, 'task', list.remoteId, changed.id)
        if (changed['@removed']) { parents.delete(id); continue }
        // Delta resources can be partial. Read the complete task so a title-only
        // delta cannot erase its recurrence, rich body, due zone or revision.
        const resource = `${this.listResource(list.remoteId)}/tasks/${encodeURIComponent(changed.id)}`
        let remote: GraphTask
        try { remote = await this.read<GraphTask>(resource) }
        catch (error) { if (error instanceof ProductivityApiError && error.status === 404) { parents.delete(id); continue }; throw error }
        if (remote.id !== changed.id) throw new Error('Microsoft returned an unrelated task')
        parents.set(id, this.mapTask(list.remoteId, remote))
      }
      for (const parent of parents.values()) {
        tasks.push(parent)
        // Checklist mutations need not appear in a parent's delta. Re-read each
        // surviving parent's checklist, including pagination and removals.
        const children = await this.pages<GraphChecklist>(`${this.taskResource(parent)}/checklistItems`)
        for (const child of children.items) tasks.push(this.mapChecklist(parent, child))
      }
      if (delta.checkpoint) checkpoints[list.id] = delta.checkpoint
    }
    if (new Set(lists.map((list) => list.id)).size !== lists.length || new Set(tasks.map((task) => task.id)).size !== tasks.length) throw new Error('Microsoft returned duplicate task identities')
    return { lists, tasks, checkpoints }
  }

  async createList(title: string) {
    this.assertWritable()
    return this.mapList(await this.write<GraphList>(base, 'POST', { displayName: this.title(title) }))
  }
  async updateList(current: ProviderTaskList, title: string) {
    this.assertList(current)
    await this.assertRevision(`${base}/${encodeURIComponent(current.remoteId)}`, current)
    const result = await this.write<GraphList>(`${base}/${encodeURIComponent(current.remoteId)}`, 'PATCH', { displayName: this.title(title) }, current)
    if (result.id !== current.remoteId) throw new Error('Microsoft returned an unrelated list write result')
    return this.mapList(result)
  }
  async deleteList(current: ProviderTaskList) {
    this.assertList(current)
    await this.assertRevision(`${base}/${encodeURIComponent(current.remoteId)}`, current)
    await this.write<void>(`${base}/${encodeURIComponent(current.remoteId)}`, 'DELETE', undefined, current)
  }
  async createTask(list: ProviderTaskList, input: ProviderTaskInput, parent?: ProviderTask) {
    this.assertWritable()
    if (list.accountId !== this.accountId || list.provider !== this.provider || list.readOnly || list.id !== identity(this.accountId, 'task-list', list.remoteId)) throw new Error('That task list is not writable')
    if (parent) {
      this.assertTask(parent)
      if (parent.kind === 'checklist' || parent.listId !== list.id) throw new Error('A checklist item needs a parent task in the same list')
      const body = this.checklistBody(input)
      return this.mapChecklist(parent, await this.write<GraphChecklist>(`${this.taskResource(parent)}/checklistItems`, 'POST', body))
    }
    return this.mapTask(list.remoteId, await this.write<GraphTask>(`${this.listResource(list.remoteId)}/tasks`, 'POST', this.taskBody(input)))
  }
  async updateTask(current: ProviderTask, input: ProviderTaskInput) {
    this.assertTask(current)
    const body = current.kind === 'checklist' ? this.checklistBody(input) : this.taskBody(input, current)
    await this.assertRevision(this.taskResource(current), current)
    if (current.kind === 'checklist') {
      const result = await this.write<GraphChecklist>(this.taskResource(current), 'PATCH', body, current)
      if (result.id !== current.remoteId) throw new Error('Microsoft returned an unrelated checklist write result')
      return this.mapChecklist(this.parent(current), result)
    }
    const result = await this.write<GraphTask>(this.taskResource(current), 'PATCH', body, current)
    if (result.id !== current.remoteId) throw new Error('Microsoft returned an unrelated task write result')
    return this.mapTask(current.remoteListId, result)
  }
  async deleteTask(current: ProviderTask) {
    this.assertTask(current)
    await this.assertRevision(this.taskResource(current), current)
    await this.write<void>(this.taskResource(current), 'DELETE', undefined, current)
  }
  async moveTask(_current: ProviderTask, _parent?: ProviderTask): Promise<ProviderTask> {
    throw new Error('Microsoft To Do does not provide a checklist reparent operation')
  }

  private mapList(remote: GraphList): ProviderTaskList {
    this.requireId(remote.id)
    return { id: identity(this.accountId, 'task-list', remote.id), accountId: this.accountId, provider: this.provider, remoteId: remote.id, title: remote.displayName?.trim() || '(Untitled list)', revision: listVersion(remote), revisionMode: remote['@odata.etag'] ? 'etag' : 'snapshot', readOnly: !this.writeAuthorized, manageReadOnly: !this.writeAuthorized || remote.isOwner !== true || Boolean(remote.wellknownListName && remote.wellknownListName !== 'none') }
  }
  private mapTask(listId: string, remote: GraphTask): ProviderTask {
    this.requireId(remote.id)
    const native: TaskNativeFields = { priority: (remote.importance ?? 'normal') as TaskNativeFields['priority'], status: (remote.status ?? 'notStarted') as TaskNativeFields['status'], recurrence: remote.recurrence, dueTimeZone: remote.dueDateTime?.timeZone, body: remote.body }
    if (!validTaskNativeFields(native) || (remote.dueDateTime && !dateTime(remote.dueDateTime.dateTime))) throw new Error('Microsoft returned invalid native task details')
    return { id: identity(this.accountId, 'task', listId, remote.id), accountId: this.accountId, provider: this.provider, remoteId: remote.id, listId: identity(this.accountId, 'task-list', listId), remoteListId: listId, kind: 'task', title: remote.title?.trim() || '(Untitled task)', notes: plainBody(remote.body), due: remote.dueDateTime?.dateTime, completed: remote.status === 'completed', revision: remote['@odata.etag'], revisionMode: 'etag', updatedAt: remote.lastModifiedDateTime, native, readOnly: !this.writeAuthorized || !remote['@odata.etag'] }
  }
  private mapChecklist(parent: ProviderTask, remote: GraphChecklist): ProviderTask {
    this.requireId(remote.id)
    if (typeof remote.isChecked !== 'boolean') throw new Error('Microsoft returned an invalid checklist state')
    return { id: identity(this.accountId, 'checklist', parent.remoteListId, parent.remoteId, remote.id), accountId: this.accountId, provider: this.provider, remoteId: remote.id, listId: parent.listId, remoteListId: parent.remoteListId, remoteParentId: parent.remoteId, parentId: parent.id, kind: 'checklist', title: remote.displayName?.trim() || '(Untitled checklist item)', completed: remote.isChecked, revision: checklistVersion(remote), revisionMode: remote['@odata.etag'] ? 'etag' : 'snapshot', updatedAt: remote.checkedDateTime ?? remote.createdDateTime, readOnly: !this.writeAuthorized || parent.readOnly }
  }
  private parent(child: ProviderTask): ProviderTask {
    return { ...child, id: identity(this.accountId, 'task', child.remoteListId, child.remoteParentId!), remoteId: child.remoteParentId!, kind: 'task', parentId: undefined, remoteParentId: undefined }
  }
  private title(value: string) {
    if (typeof value !== 'string' || !value.trim() || value.length > 1024) throw new Error('Task names must contain 1 to 1024 characters')
    return value.trim()
  }
  private requireId(value: string) { if (typeof value !== 'string' || !value) throw new Error('Microsoft returned an invalid identifier') }
  private assertWritable() { if (!this.writeAuthorized) throw new Error('Reconnect this Microsoft account to enable To Do editing') }
  private assertList(list: ProviderTaskList) {
    this.assertWritable()
    if (list.accountId !== this.accountId || list.provider !== this.provider || list.readOnly || list.manageReadOnly || !list.revision || list.id !== identity(this.accountId, 'task-list', list.remoteId)) throw new Error('That task list cannot be changed')
  }
  private assertTask(task: ProviderTask) {
    this.assertWritable()
    const expected = task.kind === 'checklist' ? identity(this.accountId, 'checklist', task.remoteListId, task.remoteParentId ?? '', task.remoteId) : identity(this.accountId, 'task', task.remoteListId, task.remoteId)
    if (task.accountId !== this.accountId || task.provider !== this.provider || task.readOnly || !task.revision || task.id !== expected || task.listId !== identity(this.accountId, 'task-list', task.remoteListId) || (task.kind === 'checklist' && (!task.remoteParentId || task.parentId !== identity(this.accountId, 'task', task.remoteListId, task.remoteParentId)))) throw new Error('That task is not writable')
  }
  private checklistBody(input: ProviderTaskInput) {
    if (typeof input.completed !== 'boolean' || input.notes || input.due || (input.native && Object.values(input.native).some((value) => value !== undefined))) throw new Error('Microsoft checklist items support a name and completion only')
    return { displayName: this.title(input.title), isChecked: input.completed }
  }
  private taskBody(input: ProviderTaskInput, current?: ProviderTask) {
    if (typeof input.completed !== 'boolean' || (input.notes !== undefined && (typeof input.notes !== 'string' || input.notes.length > ((current && input.notes === current.notes) || (input.native?.body && plainBody(input.native.body) === input.notes) ? 1_000_000 : 8192))) || (input.native !== undefined && !validTaskNativeFields(input.native))) throw new Error('Invalid Microsoft task details')
    const requestedStatus = input.native?.status ?? current?.native?.status
    const status = input.completed ? 'completed' : requestedStatus === 'completed' ? 'notStarted' : requestedStatus ?? 'notStarted'
    const body: Record<string, unknown> = { title: this.title(input.title), status }
    if (!current || input.notes !== current.notes || (input.native?.body && !isDeepStrictEqual(input.native.body, current.native?.body))) {
      const rich = input.native?.body
      body.body = rich?.contentType === 'html' && plainBody(rich) === (input.notes ?? '') ? rich : { contentType: 'html', content: escapeText(input.notes ?? '').replace(/\r?\n/g, '<br>') }
    }
    if (!current || input.due !== current.due || (input.native?.dueTimeZone !== undefined && input.native.dueTimeZone !== current.native?.dueTimeZone)) {
      if (input.due === undefined) body.dueDateTime = null
      else {
        const value = day(input.due) ? `${input.due}T00:00:00` : input.due
        if (!dateTime(value)) throw new Error('Microsoft due dates must be valid calendar timestamps')
        const offset = /(?:Z|[+-]\d{2}:\d{2})$/.test(value)
        body.dueDateTime = { dateTime: offset ? new Date(value).toISOString().replace(/Z$/, '') : value, timeZone: offset ? 'UTC' : input.native?.dueTimeZone ?? current?.native?.dueTimeZone ?? 'UTC' }
      }
    }
    if (input.native?.priority !== undefined && (!current || input.native.priority !== current.native?.priority)) body.importance = input.native.priority
    if (input.native?.recurrence !== undefined && (!current || !isDeepStrictEqual(input.native.recurrence, current.native?.recurrence))) body.recurrence = input.native.recurrence
    return body
  }
  private listResource(id: string) { return `${base}/${encodeURIComponent(id)}` }
  private taskResource(task: ProviderTask) { return task.kind === 'checklist' ? `${this.listResource(task.remoteListId)}/tasks/${encodeURIComponent(task.remoteParentId!)}/checklistItems/${encodeURIComponent(task.remoteId)}` : `${this.listResource(task.remoteListId)}/tasks/${encodeURIComponent(task.remoteId)}` }
  private async assertRevision(url: string, current: ProviderTask | ProviderTaskList) {
    const resource = await this.read<GraphTask & GraphList & GraphChecklist>(url)
    if (resource.id !== current.remoteId) throw new Error('Microsoft returned an unrelated resource')
    const revision = current.revisionMode === 'snapshot' ? 'kind' in current ? checklistVersion(resource) : listVersion(resource) : resource['@odata.etag']
    if (!revision || revision !== current.revision) throw new ProductivityApiError('This Microsoft task or list changed in another client', this.provider, 412)
  }
  private async read<T>(url: string) { return retryingJson<T>(this.provider, url, this.token, { redirect: 'error' }) }
  private async write<T>(url: string, method: string, body?: unknown, current?: ProviderTask | ProviderTaskList): Promise<T> {
    const response = await fetch(url, { method, redirect: 'error', headers: { Authorization: `Bearer ${await this.token()}`, Accept: 'application/json', 'Content-Type': 'application/json', ...(current?.revision && current.revisionMode !== 'snapshot' ? { 'If-Match': current.revision } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    if (!response.ok) throw new ProductivityApiError(`Microsoft To Do write failed (${response.status})`, this.provider, response.status)
    return response.status === 204 ? undefined as T : await response.json() as T
  }
  private safeLink(value: string, collection: string) {
    const url = new URL(value), expected = new URL(collection)
    const path = (url: URL) => url.pathname.replace(/\(\)$/, '').split('/').map((part) => decodeURIComponent(part)).join('\0')
    if (url.origin !== expected.origin || url.username || url.password || url.hash || path(url) !== path(expected)) throw new Error('Microsoft returned an unexpected task continuation URL')
    return url.toString()
  }
  private async pages<T>(initial: string, collection = initial, requireDelta = false) {
    const items: T[] = [], seen = new Set<string>()
    let url = initial
    while (true) {
      url = this.safeLink(url, collection)
      if (seen.has(url)) throw new Error('Microsoft repeated a task continuation URL')
      seen.add(url)
      const page = await this.read<GraphPage<T>>(url)
      if (!Array.isArray(page.value)) throw new Error('Microsoft returned an invalid task page')
      items.push(...page.value)
      if (page['@odata.nextLink'] !== undefined) {
        if (typeof page['@odata.nextLink'] !== 'string' || page['@odata.deltaLink'] !== undefined) throw new Error('Microsoft returned an invalid task continuation')
        url = this.safeLink(page['@odata.nextLink'], collection); continue
      }
      const checkpoint = page['@odata.deltaLink']
      if ((requireDelta && !checkpoint) || (checkpoint !== undefined && typeof checkpoint !== 'string')) throw new Error('Microsoft did not finish the task delta round')
      return { items, checkpoint: checkpoint ? this.safeLink(checkpoint, collection) : undefined }
    }
  }
}
