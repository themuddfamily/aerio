import { createHash, randomUUID } from 'node:crypto'
import type { ProviderTask, ProviderTaskInput, ProviderTaskList, ProviderTaskSnapshot, TaskEntity, TaskProviderConnector } from '../../src/task-provider-types'
import type { CalDavTaskInfo } from '../../src/caldav-task-types'
import type { Component } from '../../src/lib/content-lines'
import {
  emitComponents, ensureTimeZones, newCalendar, newVTodo, parseVTodos, patchVTodo, removeOccurrence, type VTodoFields, type VTodoItem
} from '../../src/lib/vtodo'
import { providerVTodoFields } from '../../src/lib/task-ics'
import { ProductivityApiError } from './connector'
import { DavHttpError, httpError, type DavClient } from './dav-client'
import { COLLECTION_PROPS, collectionFromResponse } from './dav-discovery'
import { CALDAV_NS, DAV_NS, escapeXml, propfindBody } from './dav-xml'
import { isTaskCalendar, type DavService } from './dav-service'
import type { DavCollectionRecord, DavResourceRecord, DavStore } from './dav-store'
import type { TaskServiceAccount } from './task-service'

// CalDAV task provider (E45). VTODOs in task-only and mixed calendars become Tasks entries, while
// their VEVENTs stay in Calendar. The raw calendar objects live in dav.sqlite and are pulled by the
// shared DAV sync engine (sync-collection, then ctag/ETag, with multiget). The task queue in
// provider-tasks.sqlite carries offline edits; each write here is one conditional request that
// patches only the edited properties of the cached object, so unknown properties survive.

const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24)
export const davTaskId = (collectionId: string, href: string, recurrenceId?: string) => `${collectionId}:todo:${hash(`${href}\u0000${recurrenceId ?? ''}`)}`
const hrefOf = (task: Pick<ProviderTask, 'remoteId'>) => task.remoteId.split('#')[0]
const memberUrl = (collection: DavCollectionRecord, name: string) => new URL(encodeURIComponent(name), collection.url.endsWith('/') ? collection.url : `${collection.url}/`).toString()
const isEventCalendar = (collection: DavCollectionRecord) => collection.components.includes('VEVENT')
const apiError = (message: string, status: number) => new ProductivityApiError(message, 'dav', status)

/** A CalDAV calendar as a task list. Mixed calendars are renamed or deleted only from Calendar's server. */
export function davTaskList(collection: DavCollectionRecord): ProviderTaskList {
  return {
    id: collection.id, accountId: collection.accountId, provider: 'dav', remoteId: collection.url, title: collection.name,
    revision: collection.ctag ?? collection.syncToken ?? 'unversioned', revisionMode: 'etag', readOnly: collection.readOnly,
    ...(collection.readOnly || isEventCalendar(collection) ? { manageReadOnly: true } : {})
  }
}

function readOnlyReason(collection: DavCollectionRecord, resource: DavResourceRecord, others: string[], uids: number) {
  if (collection.readOnly) return 'This task list is read-only on the server'
  if (others.some((name) => name === 'VEVENT' || name === 'VJOURNAL')) return 'This calendar object also holds events or journal entries, so Aerio does not change it'
  if (uids > 1) return 'This calendar object holds several tasks, which CalDAV does not allow, so Aerio does not change it'
  if (!resource.etag) return 'The server did not report a revision for this task, so Aerio cannot update it safely'
  return undefined
}

function providerTask(collection: DavCollectionRecord, resource: DavResourceRecord, item: VTodoItem, reason: string | undefined): ProviderTask {
  const fields = item.fields
  const caldav: CalDavTaskInfo = {
    uid: item.uid,
    ...(item.recurrenceId ? { recurrenceId: item.recurrenceId, recurrenceNote: 'This is one changed occurrence of a repeating task. Edits apply to this occurrence only.' } : {}),
    ...(item.recurrence ? { recurrence: item.recurrence, recurrenceNote: 'Repeat rules from the server are kept as they are and can be changed only in another app. Edits here apply to the whole series; completing it completes the series.' } : {}),
    ...(!item.recurrence && !item.recurrenceId && item.recurrenceDates ? { recurrenceNote: 'Extra or excluded dates from the server are kept as they are.' } : {}),
    ...(item.links.length ? { links: item.links.slice(0, 500) } : {}),
    ...(item.inlineAttachments.length ? { inlineAttachments: item.inlineAttachments.slice(0, 500) } : {}),
    ...(item.preserved.length ? { preserved: item.preserved.slice(0, 500) } : {}),
    ...(item.notesTruncated ? { notesTruncated: true } : {}),
    ...(reason ? { readOnlyReason: reason } : {})
  }
  return {
    id: davTaskId(collection.id, resource.href, item.recurrenceId), accountId: collection.accountId, provider: 'dav',
    remoteId: item.recurrenceId ? `${resource.href}#${item.recurrenceId}` : resource.href, listId: collection.id, remoteListId: collection.url,
    ...(fields.parentUid ? { remoteParentId: fields.parentUid } : {}),
    position: `${fields.due ?? '9999'}\u0000${fields.title.toLowerCase()}`.slice(0, 1_000),
    ...(resource.etag ? { revision: resource.etag } : {}), revisionMode: 'etag',
    title: fields.title, ...(fields.notes ? { notes: fields.notes } : {}), ...(fields.due ? { due: fields.due } : {}), completed: fields.completed,
    readOnly: Boolean(reason),
    native: {
      priority: fields.priority, status: fields.status, categories: fields.categories,
      ...(fields.due && fields.dueTimeZone ? { dueTimeZone: fields.dueTimeZone } : {}),
      ...(fields.start ? { start: fields.start, ...(fields.startTimeZone ? { startTimeZone: fields.startTimeZone } : {}) } : {}),
      ...(fields.reminder ? { reminder: fields.reminder } : {}),
      ...(fields.percentComplete !== undefined ? { percentComplete: fields.percentComplete } : {}),
      caldav
    }
  }
}

/** Every VTODO in one cached calendar object. Unreadable objects are skipped, never rewritten. */
export function tasksFromResource(collection: DavCollectionRecord, resource: DavResourceRecord): ProviderTask[] {
  let parsed
  try { parsed = parseVTodos(resource.data) } catch { return [] }
  const reason = readOnlyReason(collection, resource, parsed.otherComponents, new Set(parsed.items.map((item) => item.uid)).size)
  return parsed.items.map((item) => providerTask(collection, resource, item, reason))
}

/** The tasks of one collection, with RELATED-TO parents resolved to series masters in the same list. */
function collectionTasks(store: DavStore, collection: DavCollectionRecord) {
  const tasks = store.resources(collection.id).flatMap((resource) => tasksFromResource(collection, resource))
  const masters = new Map<string, string>()
  for (const task of tasks) if (!task.native?.caldav?.recurrenceId && !masters.has(task.native!.caldav!.uid)) masters.set(task.native!.caldav!.uid, task.id)
  const parents = new Map<string, string>()
  for (const task of tasks) {
    const parent = task.remoteParentId ? masters.get(task.remoteParentId) : undefined
    if (parent && parent !== task.id) parents.set(task.id, parent)
  }
  // Drop links that would make a cycle; such tasks are shown at the top level.
  for (const id of [...parents.keys()]) {
    const seen = new Set([id])
    for (let current = parents.get(id); current; current = parents.get(current)) {
      if (seen.has(current)) { parents.delete(id); break }
      seen.add(current)
    }
  }
  return tasks.map((task) => parents.has(task.id) ? { ...task, parentId: parents.get(task.id) } : task)
}

/** The task snapshot of a CalDAV account from its cache: enabled calendars that hold VTODOs. */
export function davTaskSnapshot(store: DavStore, accountId: string): ProviderTaskSnapshot {
  const collections = store.collections(accountId).filter((collection) => collection.enabled && isTaskCalendar(collection))
  return { lists: collections.map(davTaskList), tasks: collections.flatMap((collection) => collectionTasks(store, collection)), checkpoints: {} }
}

/**
 * VTODO components for exporting connected CalDAV tasks: the cached object with any pending field
 * edits applied, so unknown properties and occurrences round-trip unchanged.
 */
export function davTaskExportComponents(store: DavStore, entities: TaskEntity[], now = new Date()): Component[] {
  const components: Component[] = []
  const byHref = new Map<string, TaskEntity[]>()
  const fresh: TaskEntity[] = []
  for (const entity of entities) {
    if (entity.remote) byHref.set(`${entity.listId}\u0000${hrefOf(entity.remote)}`, [...byHref.get(`${entity.listId}\u0000${hrefOf(entity.remote)}`) ?? [], entity])
    else fresh.push(entity)
  }
  for (const [key, group] of byHref) {
    const [listId, href] = key.split('\u0000')
    const resource = store.resource(listId, href)
    if (!resource) { fresh.push(...group); continue }
    let parsed
    try { parsed = parseVTodos(resource.data) } catch { fresh.push(...group); continue }
    for (const item of parsed.items) {
      const entity = group.find((candidate) => candidate.remote?.native?.caldav?.uid === item.uid && (candidate.remote.native.caldav.recurrenceId ?? '') === (item.recurrenceId ?? ''))
      if (entity) patchVTodo(item.component, item.fields, providerVTodoFields('dav', entity.fields, undefined, item.fields.parentUid), now)
    }
    for (const calendar of parsed.calendars) components.push(...calendar.children.filter((child) => child.name === 'VTODO' || child.name === 'VTIMEZONE'))
  }
  for (const entity of fresh) {
    const source = entity.fields.native?.caldav?.source
    if (source) {
      try { components.push(...parseVTodos(source).calendars.flatMap((calendar) => calendar.children)); continue } catch { /* Fall through to a generated task. */ }
    }
    components.push(newVTodo(entity.fields.native?.caldav?.uid ?? `${entity.id}@aerio.local`, providerVTodoFields('dav', entity.fields), now))
  }
  return components
}

/** CalDAV accounts as Tasks accounts. A transient sync error does not block the task queue; a rejected password does. */
export function davTaskAccounts(service: DavService | null | undefined): TaskServiceAccount[] {
  return (service?.taskAccounts() ?? []).map((account) => ({
    id: account.id, provider: 'dav', email: account.username, displayName: account.name, color: '#3f74c9',
    status: account.status === 'needs-auth' ? 'needs-auth' : 'ready', archived: false, syncEnabled: true, signature: '', notifications: false
  }))
}

/** The raw cached calendar object behind a CalDAV task, if any. */
export const davTaskResource = (store: DavStore, task: Pick<ProviderTask, 'listId' | 'remoteId'>) => store.resource(task.listId, hrefOf(task))

export class CalDavTasksConnector implements TaskProviderConnector {
  readonly provider = 'dav' as const
  readonly capabilities = { recurrence: 'native', priority: 'native', due: 'date-time', subtasks: 'tasks', reparent: true } as const

  constructor(private readonly accountId: string, private readonly service: DavService, private readonly store: DavStore, private readonly now: () => Date = () => new Date()) {}

  async sync(previous?: ProviderTaskSnapshot): Promise<ProviderTaskSnapshot> {
    await this.service.pullTaskCollections(this.accountId, !previous)
    return davTaskSnapshot(this.store, this.accountId)
  }

  // DAV HTTP failures become provider errors, so the task queue applies its conflict rules (412/404/409).
  private run<T>(work: (client: DavClient) => Promise<T>): Promise<T> {
    return this.service.withAccount(this.accountId, (_account, client) => work(client)).catch((error) => {
      if (error instanceof DavHttpError) throw apiError(error.message, error.status || 502)
      throw error
    })
  }

  private collection(listId: string, write = true) {
    const collection = this.store.collection(listId)
    if (!collection || collection.accountId !== this.accountId || !isTaskCalendar(collection)) throw apiError('That task list is no longer available', 404)
    if (write && collection.readOnly) throw apiError('This task list is read-only on the server', 403)
    return collection
  }

  private async put(client: DavClient, collection: DavCollectionRecord, href: string, data: string, ifMatch?: string) {
    const response = await client.request('PUT', href, {
      headers: { 'Content-Type': 'text/calendar; charset=utf-8', ...(ifMatch ? { 'If-Match': ifMatch } : { 'If-None-Match': '*' }) },
      body: data
    })
    if (response.status < 200 || response.status >= 300) throw httpError(response)
    let etag = response.headers.get('etag')?.trim() || undefined
    let stored = data
    // Without an ETag the server may have rewritten the object; read back its stored copy.
    if (!etag) {
      const read = await client.request('GET', href, { headers: { Accept: 'text/calendar' } })
      if (read.status >= 200 && read.status < 300) { stored = read.text; etag = read.headers.get('etag')?.trim() || undefined }
    }
    this.store.saveResource({ collectionId: collection.id, href, data: stored, ...(etag ? { etag } : {}) })
  }

  private async remove(client: DavClient, collection: DavCollectionRecord, href: string, ifMatch: string) {
    const response = await client.request('DELETE', href, { headers: { 'If-Match': ifMatch } })
    if ((response.status < 200 || response.status >= 300) && response.status !== 404 && response.status !== 410) throw httpError(response)
    this.store.removeResource(collection.id, href)
  }

  private written(collection: DavCollectionRecord, href: string, uid: string, recurrenceId?: string) {
    const task = collectionTasks(this.store, collection).find((item) => hrefOf(item) === href && item.native?.caldav?.uid === uid && item.native.caldav.recurrenceId === recurrenceId)
    if (!task) throw apiError('The server stored the task in a form Aerio cannot read back', 502)
    return task
  }

  /** The cached object a task was read from; a newer or missing copy is a conflict. */
  private cached(current: ProviderTask, collection: DavCollectionRecord) {
    const href = hrefOf(current)
    const resource = this.store.resource(collection.id, href)
    if (!resource) throw apiError('The task was deleted on the server', 404)
    if (!current.revision || resource.etag !== current.revision) throw apiError('The task changed on the server', 412)
    const parsed = parseVTodos(resource.data)
    const caldav = current.native?.caldav
    const item = parsed.items.find((candidate) => candidate.uid === caldav?.uid && candidate.recurrenceId === caldav?.recurrenceId)
    if (!item) throw apiError('The task is no longer in this calendar object', 409)
    if (current.readOnly || readOnlyReason(collection, resource, parsed.otherComponents, new Set(parsed.items.map((value) => value.uid)).size)) throw apiError('This task is read-only', 403)
    return { href, resource, parsed, item }
  }

  private fields(input: ProviderTaskInput, before: VTodoFields, parentUid = before.parentUid): VTodoFields {
    const after = providerVTodoFields('dav', input, undefined, parentUid)
    // Completing a task with tracked progress records it as fully done.
    if (after.completed && !before.completed && after.percentComplete !== undefined && after.percentComplete === before.percentComplete) after.percentComplete = 100
    return after
  }

  createList(title: string) {
    return this.service.withAccount(this.accountId, async (account, client) => {
      if (!account.calendarHomeUrl) throw apiError('This account has no calendar home for task lists', 409)
      const url = new URL(`${randomUUID()}/`, account.calendarHomeUrl.endsWith('/') ? account.calendarHomeUrl : `${account.calendarHomeUrl}/`).toString()
      const body = `<?xml version="1.0" encoding="utf-8"?><c:mkcalendar xmlns:d="${DAV_NS}" xmlns:c="${CALDAV_NS}"><d:set><d:prop><d:displayname>${escapeXml(title)}</d:displayname><c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set></d:prop></d:set></c:mkcalendar>`
      const response = await client.request('MKCALENDAR', url, { body })
      if (response.status < 200 || response.status >= 300) throw httpError(response)
      const listing = await client.multistatus('PROPFIND', url, propfindBody(COLLECTION_PROPS), '0')
      const found = listing.responses[0] ? collectionFromResponse(listing.responses[0], listing.url) : undefined
      if (!found) throw apiError('The server did not report the new task list', 502)
      return davTaskList(this.service.saveDiscoveredCollection(this.accountId, found))
    }).catch((error) => { throw error instanceof DavHttpError ? apiError(error.message, error.status || 502) : error })
  }

  updateList(current: ProviderTaskList, title: string) {
    return this.run(async (client) => {
      const collection = this.collection(current.id)
      if (isEventCalendar(collection)) throw apiError('This calendar also holds events; rename it from your server', 409)
      const body = `<?xml version="1.0" encoding="utf-8"?><d:propertyupdate xmlns:d="${DAV_NS}"><d:set><d:prop><d:displayname>${escapeXml(title)}</d:displayname></d:prop></d:set></d:propertyupdate>`
      const response = await client.request('PROPPATCH', collection.url, { body })
      if (response.status < 200 || response.status >= 300 || /HTTP\/1\.[01] [45]\d\d/.test(response.text)) throw httpError({ status: response.status >= 300 ? response.status : 403, text: response.text })
      const saved = { ...collection, name: title }
      this.store.saveCollection(saved)
      return davTaskList(saved)
    })
  }

  deleteList(current: ProviderTaskList) {
    return this.run(async (client) => {
      const collection = this.collection(current.id)
      if (isEventCalendar(collection)) throw apiError('This calendar also holds events; delete it from your server', 409)
      const response = await client.request('DELETE', collection.url)
      if ((response.status < 200 || response.status >= 300) && response.status !== 404 && response.status !== 410) throw httpError(response)
      this.store.removeCollection(collection.id)
    })
  }

  createTask(list: ProviderTaskList, input: ProviderTaskInput, parent?: ProviderTask) {
    return this.run(async (client) => {
      const collection = this.collection(list.id)
      const parentUid = parent?.native?.caldav?.uid
      const source = input.native?.caldav?.source
      let calendar: Component
      let uid: string
      if (source) {
        // Imports start from the file's own object, so its unmapped properties and occurrences are kept.
        const parsed = parseVTodos(source)
        const master = parsed.items.find((item) => !item.recurrenceId) ?? parsed.items[0]
        if (!master || new Set(parsed.items.map((item) => item.uid)).size !== 1) throw apiError('The imported task is not a single iCalendar task', 422)
        calendar = parsed.calendars[0]
        calendar.children = calendar.children.filter((child) => child.name === 'VTODO' || child.name === 'VTIMEZONE')
        calendar.properties = calendar.properties.filter((line) => line.name !== 'METHOD')
        uid = master.uid
        patchVTodo(master.component, master.fields, this.fields(input, master.fields, parentUid ?? master.fields.parentUid), this.now())
      } else {
        uid = input.native?.caldav?.uid ?? randomUUID()
        calendar = newCalendar([newVTodo(uid, providerVTodoFields('dav', input, undefined, parentUid), this.now())])
      }
      ensureTimeZones(calendar)
      const href = memberUrl(collection, `${randomUUID()}.ics`)
      await this.put(client, collection, href, emitComponents([calendar]))
      return this.written(collection, href, uid)
    })
  }

  updateTask(current: ProviderTask, input: ProviderTaskInput) {
    return this.run(async (client) => {
      const collection = this.collection(current.listId)
      const { href, resource, parsed, item } = this.cached(current, collection)
      patchVTodo(item.component, item.fields, this.fields(input, item.fields), this.now())
      ensureTimeZones(item.calendar)
      await this.put(client, collection, href, emitComponents(parsed.calendars), resource.etag)
      return this.written(collection, href, item.uid, item.recurrenceId)
    })
  }

  moveTask(current: ProviderTask, parent?: ProviderTask) {
    return this.run(async (client) => {
      const collection = this.collection(current.listId)
      const { href, resource, parsed, item } = this.cached(current, collection)
      if (item.recurrenceId) throw apiError('An occurrence of a repeating task cannot be moved', 422)
      const parentUid = parent?.native?.caldav?.uid
      if (parent && !parentUid) throw apiError('The new parent task is not synchronized yet', 409)
      for (const occurrence of parsed.items.filter((candidate) => candidate.uid === item.uid)) {
        patchVTodo(occurrence.component, occurrence.fields, { ...occurrence.fields, parentUid }, this.now())
      }
      await this.put(client, collection, href, emitComponents(parsed.calendars), resource.etag)
      return this.written(collection, href, item.uid)
    })
  }

  deleteTask(current: ProviderTask) {
    return this.run(async (client) => {
      const collection = this.collection(current.listId)
      const { href, resource, parsed, item } = this.cached(current, collection)
      // Deleting one occurrence removes its override and excludes the date from the series.
      if (item.recurrenceId && removeOccurrence(item.calendar, item.uid, item.recurrenceId) && item.calendar.children.some((child) => child.name === 'VTODO')) {
        await this.put(client, collection, href, emitComponents(parsed.calendars), resource.etag)
        return
      }
      await this.remove(client, collection, href, resource.etag!)
    })
  }
}
