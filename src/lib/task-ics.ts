// .ics task interchange (E45): preview items, local-task import and export, and the mapping between
// VTODO fields and connected-provider task input. Pure functions shared by the renderer (local
// lists) and the main process (connected lists).
import type { Task } from '../types'
import type { ProviderTaskInput, TaskLocalMetadata, TaskNativeFields, TaskProvider } from '../task-provider-types'
import type { TaskIcsDuplicateMode, TaskIcsItem } from '../task-interchange-types'
import { compactExtendedFields, validTaskStartTimeZone } from './task-schedule'
import { localTimeZone } from './time-zones'
import {
  emitComponents, ensureTimeZones, newCalendar, newVTodo, normalizeVTodoStatus, parseVTodos, patchVTodo, replaceUid, setRecurrenceRule,
  simpleTaskRepeat, standaloneCalendar, vtodoInstant, type VTodoFields, type VTodoItem, type VTodoParseResult, type VTodoStatus
} from './vtodo'
import type { Component } from './content-lines'

export const TASK_ICS_MAX_ITEMS = 20_000

/** Groups parsed VTODOs by UID: a series master (or single task) with its overridden occurrences. */
export function taskIcsItems(parsed: VTodoParseResult): TaskIcsItem[] {
  const groups = new Map<string, VTodoItem[]>()
  for (const item of parsed.items) groups.set(item.uid, [...groups.get(item.uid) ?? [], item])
  const items: TaskIcsItem[] = []
  for (const [uid, group] of groups) {
    if (items.length >= TASK_ICS_MAX_ITEMS) break
    const master = group.find((item) => !item.recurrenceId) ?? group[0]
    const fields = master.fields
    const calendar = standaloneCalendar(master.calendar, group.map((item) => item.component))
    items.push({
      uid,
      ...fields,
      ...(master.recurrence ? { recurrence: master.recurrence } : {}),
      occurrences: group.filter((item) => item.recurrenceId).length,
      links: master.links,
      inlineAttachments: group.reduce((count, item) => count + item.inlineAttachments.length, 0),
      preserved: [...new Set(group.flatMap((item) => item.preserved))],
      source: emitComponents([calendar])
    })
  }
  return items
}

/** Parses one previewed item's source again (the main process never trusts renderer field values). */
export function parseTaskIcsSource(source: string) {
  const parsed = parseVTodos(source)
  const items = taskIcsItems(parsed)
  if (items.length !== 1) throw new Error('Each imported task must contain exactly one task UID')
  return items[0]
}

export const itemFields = (item: Pick<TaskIcsItem, keyof VTodoFields>): VTodoFields => ({
  title: item.title, ...(item.notes ? { notes: item.notes } : {}), ...(item.due ? { due: item.due, ...(item.dueTimeZone ? { dueTimeZone: item.dueTimeZone } : {}) } : {}),
  ...(item.start ? { start: item.start, ...(item.startTimeZone ? { startTimeZone: item.startTimeZone } : {}) } : {}),
  completed: item.completed, status: item.status, ...(item.percentComplete !== undefined ? { percentComplete: item.percentComplete } : {}),
  priority: item.priority, categories: [...item.categories], ...(item.reminder ? { reminder: item.reminder } : {}), ...(item.parentUid ? { parentUid: item.parentUid } : {})
})

const masterOf = (calendar: Component) => calendar.children.find((child) => child.name === 'VTODO' && !child.properties.some((line) => line.name === 'RECURRENCE-ID'))
  ?? calendar.children.find((child) => child.name === 'VTODO')

/** The UID a local task exports with: the imported UID, or one derived from its id. */
export const localTaskUid = (task: Pick<Task, 'id' | 'icalendar'>) => task.icalendar?.uid ?? `${task.id}@aerio.local`

/** A task date or instant expressed for the local Task model (instants as ISO, dates unchanged). */
function localDue(due: string | undefined, zone: string | undefined) {
  if (!due) return undefined
  if (/^\d{4}-\d{2}-\d{2}$/.test(due)) return due
  const ms = vtodoInstant(due, zone)
  return ms === undefined ? undefined : new Date(ms).toISOString()
}

/** A local task for an imported item. Unmapped properties and occurrences stay in `icalendar.source`. */
export function localTaskFromItem(item: TaskIcsItem, listId: string, id: string): Task {
  const repeat = simpleTaskRepeat(item.recurrence)
  const due = localDue(item.due, item.dueTimeZone)
  const zone = item.startTimeZone && validTaskStartTimeZone(item.startTimeZone) ? item.startTimeZone : undefined
  return {
    id, listId, title: item.title, ...(item.notes ? { notes: item.notes } : {}), ...(due ? { due } : {}),
    priority: item.priority, completed: item.completed, subtasks: [], recurrence: repeat ?? 'none',
    ...compactExtendedFields({
      ...(item.start ? { start: item.start, ...(zone ? { startTimeZone: zone } : {}) } : {}),
      ...(item.reminder ? { reminder: item.reminder } : {}),
      ...(item.percentComplete !== undefined ? { percentComplete: item.percentComplete } : {}),
      ...(item.categories.length ? { categories: item.categories.slice(0, 50) } : {})
    }),
    icalendar: { uid: item.uid, source: item.source }
  }
}

export interface LocalImportResult { tasks: Task[]; created: number; replaced: number; skipped: number }

/**
 * Imports items into local tasks. Duplicates are matched by UID across all local tasks: skip keeps
 * the existing task, replace overwrites it in place (moving it to `listId`), and copy imports the
 * item again under a new UID.
 */
export function importLocalTasks(tasks: Task[], items: TaskIcsItem[], listId: string, mode: TaskIcsDuplicateMode, newId: () => string): LocalImportResult {
  const byUid = new Map(tasks.map((task) => [localTaskUid(task), task]))
  let next = [...tasks]
  const created: Task[] = []
  let replaced = 0, skipped = 0
  for (const item of items) {
    const existing = byUid.get(item.uid)
    if (existing && mode === 'skip') { skipped++; continue }
    if (existing && mode === 'replace') {
      const task = { ...localTaskFromItem(item, listId, existing.id), subtasks: existing.subtasks, ...(existing.attachments ? { attachments: existing.attachments } : {}) }
      next = next.map((candidate) => candidate.id === existing.id ? task : candidate)
      replaced++
      continue
    }
    let value = item
    if (existing || created.some((task) => task.icalendar?.uid === item.uid)) {
      const uid = `${newId()}@aerio.local`
      const calendar = parseVTodos(item.source).calendars[0]
      replaceUid(calendar, uid)
      value = { ...item, uid, source: emitComponents([calendar]) }
    }
    const task = localTaskFromItem(value, listId, newId())
    created.push(task)
    byUid.set(value.uid, task)
  }
  return { tasks: [...created, ...next], created: created.length, replaced, skipped }
}

const statusAfter = (completed: boolean, previous?: VTodoStatus): VTodoStatus => normalizeVTodoStatus({ completed, status: previous ?? 'notStarted' } as VTodoFields, previous).status

/** Keeps the source's own representation of a date when it names the same instant. */
function sameMoment(value: string | undefined, zone: string | undefined, before: VTodoFields | undefined, field: 'due' | 'start') {
  const previous = before?.[field]
  const previousZone = field === 'due' ? before?.dueTimeZone : before?.startTimeZone
  if (value && previous && (value === previous || vtodoInstant(value, zone) === vtodoInstant(previous, previousZone))) return { value: previous, zone: previousZone }
  return { value, zone }
}

/** VTODO fields for a local task, reusing the imported representation where values are unchanged. */
export function localVTodoFields(task: Task, before?: VTodoFields): VTodoFields {
  const due = sameMoment(task.due, undefined, before, 'due')
  const start = sameMoment(task.start, task.startTimeZone, before, 'start')
  return {
    title: task.title, ...(task.notes ? { notes: task.notes } : {}),
    ...(due.value ? { due: due.value, ...(due.zone ? { dueTimeZone: due.zone } : {}) } : {}),
    ...(start.value ? { start: start.value, ...(start.zone ? { startTimeZone: start.zone } : {}) } : {}),
    completed: task.completed, status: statusAfter(task.completed, before?.status),
    ...(task.percentComplete !== undefined ? { percentComplete: task.percentComplete } : {}),
    priority: task.priority, categories: task.categories ?? [],
    ...(task.reminder ? { reminder: before?.reminder && Date.parse(before.reminder) === Date.parse(task.reminder) ? before.reminder : task.reminder } : {}),
    ...(before?.parentUid ? { parentUid: before.parentUid } : {})
  }
}

const RULES = { daily: 'FREQ=DAILY', weekly: 'FREQ=WEEKLY', monthly: 'FREQ=MONTHLY' } as const

/** VTODO components for one local task: the retained source patched with current values, or new ones. */
export function localTaskComponents(task: Task, now = new Date()): Component[] {
  const uid = localTaskUid(task)
  let components: Component[]
  let master: Component | undefined
  let rule: string | undefined
  if (task.icalendar?.source) {
    try {
      const parsed = parseVTodos(task.icalendar.source)
      const calendar = parsed.calendars[0]
      master = masterOf(calendar)
      const item = parsed.items.find((candidate) => candidate.component === master)
      if (master && item) {
        patchVTodo(master, item.fields, localVTodoFields(task, item.fields), now)
        rule = item.recurrence
        components = calendar.children
      } else components = []
    } catch { components = [] }
  } else components = []
  if (!master) {
    master = newVTodo(uid, localVTodoFields(task), now)
    components = [master]
  }
  // A repeat Aerio can represent follows the local setting; a richer RRULE stays unless replaced.
  const repeat = task.recurrence && task.recurrence !== 'none' ? task.recurrence : undefined
  if (simpleTaskRepeat(rule) !== repeat && (repeat || !rule || simpleTaskRepeat(rule))) setRecurrenceRule(master, repeat ? RULES[repeat] : undefined)
  const subtasks = task.subtasks.map((subtask) => newVTodo(`${subtask.id}@aerio.local`, { title: subtask.title, completed: subtask.completed, status: subtask.completed ? 'completed' : 'notStarted', priority: 'normal', categories: [], parentUid: uid }, now))
  return [...components, ...subtasks]
}

/** Serializes local tasks as one VCALENDAR. Local attachment files are not embedded. */
export function serializeLocalTasks(tasks: Task[], name?: string, now = new Date()) {
  const calendar = newCalendar(tasks.flatMap((task) => localTaskComponents(task, now)), name)
  ensureTimeZones(calendar)
  return emitComponents([calendar])
}

// --- Connected providers ------------------------------------------------------------------------

const PROVIDER_STATUS: Record<string, VTodoStatus> = { notStarted: 'notStarted', inProgress: 'inProgress', completed: 'completed', cancelled: 'cancelled', waitingOnOthers: 'inProgress', deferred: 'notStarted' }

/** VTODO fields for a connected task: native fields first, then the task's local overlay. */
export function providerVTodoFields(provider: TaskProvider, input: ProviderTaskInput, local?: TaskLocalMetadata, parentUid?: string): VTodoFields {
  const native: TaskNativeFields = input.native ?? {}
  const overlay = local?.extended ?? {}
  const nativeExtended = provider !== 'gmail'
  const start = nativeExtended ? native.start ?? undefined : overlay.start
  const startZone = nativeExtended ? native.startTimeZone : overlay.startTimeZone
  const reminder = nativeExtended ? native.reminder ?? undefined : overlay.reminder
  const categories = (nativeExtended ? native.categories : overlay.categories) ?? []
  const percent = provider === 'dav' ? native.percentComplete ?? undefined : overlay.percentComplete
  const due = provider === 'gmail' && input.due ? input.due.slice(0, 10) : input.due
  const fields: VTodoFields = {
    title: input.title, ...(input.notes ? { notes: input.notes } : {}),
    ...(due ? { due, ...(native.dueTimeZone && provider !== 'gmail' && !/(?:Z|[+-]\d{2}:\d{2})$/.test(due) ? { dueTimeZone: native.dueTimeZone } : {}) } : {}),
    ...(start ? { start, ...(startZone ? { startTimeZone: startZone } : {}) } : {}),
    completed: input.completed, status: PROVIDER_STATUS[native.status ?? ''] ?? 'notStarted',
    ...(percent !== undefined ? { percentComplete: percent } : {}),
    priority: provider === 'gmail' ? local?.priority ?? 'normal' : native.priority ?? 'normal',
    categories: [...categories], ...(reminder ? { reminder } : {}), ...(parentUid ? { parentUid } : {})
  }
  return normalizeVTodoStatus(fields, fields.status)
}

export interface ConnectedImport { input: ProviderTaskInput; local: TaskLocalMetadata; warnings: string[] }

/**
 * Provider task input for an imported item. CalDAV keeps the whole source (every property and
 * occurrence). Google Tasks and Microsoft To Do receive the fields they can store; the rest becomes
 * Aerio's local overlay or is reported in `warnings`.
 */
export function connectedImportInput(provider: TaskProvider, item: TaskIcsItem): ConnectedImport {
  const warnings: string[] = []
  const base = { title: item.title, ...(item.notes ? { notes: item.notes.slice(0, 8192) } : {}), completed: item.completed }
  const extended = compactExtendedFields({
    ...(item.start ? { start: item.start, ...(item.startTimeZone && validTaskStartTimeZone(item.startTimeZone) ? { startTimeZone: item.startTimeZone } : {}) } : {}),
    ...(item.reminder ? { reminder: item.reminder } : {}),
    ...(item.percentComplete !== undefined ? { percentComplete: item.percentComplete } : {}),
    ...(item.categories.length ? { categories: item.categories } : {})
  })
  const unkept = [...item.preserved, ...(item.links.length ? ['ATTACH'] : []), ...(item.inlineAttachments ? ['ATTACH (embedded files)'] : [])]
  if (provider === 'dav') {
    return {
      input: {
        ...base, ...(item.due ? { due: item.due } : {}),
        native: {
          priority: item.priority, status: item.status, categories: item.categories,
          ...(item.due && item.dueTimeZone ? { dueTimeZone: item.dueTimeZone } : {}),
          ...(item.start ? { start: item.start, ...(item.startTimeZone ? { startTimeZone: item.startTimeZone } : {}) } : {}),
          ...(item.reminder ? { reminder: item.reminder } : {}),
          ...(item.percentComplete !== undefined ? { percentComplete: item.percentComplete } : {}),
          caldav: { uid: item.uid, source: item.source }
        }
      },
      local: { priority: 'normal', recurrence: 'none' }, warnings
    }
  }
  if (item.recurrence && (provider === 'microsoft' || !simpleTaskRepeat(item.recurrence))) warnings.push(`“${item.title}”: the repeat rule was not imported`)
  if (item.occurrences) warnings.push(`“${item.title}”: ${item.occurrences} changed occurrence${item.occurrences === 1 ? ' was' : 's were'} not imported`)
  if (unkept.length) warnings.push(`“${item.title}”: ${unkept.join(', ')} cannot be stored in ${provider === 'gmail' ? 'Google Tasks' : 'Microsoft To Do'}`)
  if (provider === 'gmail') {
    if (item.due && item.due.length > 10) warnings.push(`“${item.title}”: Google Tasks keeps the due date without its time`)
    const due = item.due ? /^\d{4}-\d{2}-\d{2}$/.test(item.due) ? item.due : new Date(vtodoInstant(item.due, item.dueTimeZone) ?? Date.parse(item.due)).toISOString().slice(0, 10) : undefined
    return { input: { ...base, ...(due ? { due } : {}) }, local: { priority: item.priority, recurrence: simpleTaskRepeat(item.recurrence) ?? 'none', ...(extended ? { extended } : {}) }, warnings }
  }
  if (item.status === 'cancelled') warnings.push(`“${item.title}”: Microsoft To Do has no cancelled state; it was imported as not started`)
  const status = item.status === 'cancelled' ? 'notStarted' : item.status
  const zone = /(?:Z|[+-]\d{2}:\d{2})$/.test(item.due ?? '') ? undefined : item.dueTimeZone ?? localTimeZone()
  return {
    input: {
      ...base, ...(item.due ? { due: item.due } : {}),
      native: {
        priority: item.priority, status, ...(item.categories.length ? { categories: item.categories } : {}),
        ...(item.due && zone ? { dueTimeZone: zone } : {}),
        ...(item.start ? { start: item.start, startTimeZone: item.startTimeZone ?? localTimeZone() } : {}),
        ...(item.reminder ? { reminder: item.reminder } : {})
      }
    },
    local: { priority: 'normal', recurrence: 'none', ...(item.percentComplete !== undefined ? { extended: { percentComplete: item.percentComplete } } : {}) },
    warnings
  }
}
