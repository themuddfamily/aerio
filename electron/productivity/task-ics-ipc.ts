import { randomUUID } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { Task } from '../../src/types'
import type { TaskEntity, TaskNativeRecurrence } from '../../src/task-provider-types'
import type { TaskIcsDuplicateMode, TaskIcsImportResult, TaskIcsPreview, TaskIcsTarget } from '../../src/task-interchange-types'
import { CALDAV_SOURCE_LIMIT } from '../../src/caldav-task-types'
import type { Component } from '../../src/lib/content-lines'
import { connectedImportInput, parseTaskIcsSource, providerVTodoFields, serializeLocalTasks, TASK_ICS_MAX_ITEMS, taskIcsItems } from '../../src/lib/task-ics'
import { emitComponents, ensureTimeZones, newCalendar, newVTodo, parseVTodos, setRecurrenceRule } from '../../src/lib/vtodo'
import { davTaskExportComponents } from './caldav-tasks'
import type { DavStore } from './dav-store'
import type { TaskService } from './task-service'

export const TASK_ICS_IMPORT_MAX_BYTES = 20 * 1024 * 1024

export interface TaskIcsOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  service(): TaskService | undefined
  localTasks(): Task[]
  davStore(): DavStore | undefined
  isLocked(): boolean
  openFile(event: IpcMainInvokeEvent): Promise<string | undefined>
  saveFile(event: IpcMainInvokeEvent, defaultName: string): Promise<string | undefined>
  diagnostic?(event: string, details: Record<string, unknown>): void
}

const safeFilename = (value: string) => value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 120) || 'Aerio tasks'
const DAYS: Record<string, string> = { sunday: 'SU', monday: 'MO', tuesday: 'TU', wednesday: 'WE', thursday: 'TH', friday: 'FR', saturday: 'SA' }
const ORDINAL: Record<string, string> = { first: '1', second: '2', third: '3', fourth: '4', last: '-1' }

/** An RRULE for a Microsoft To Do recurrence pattern. */
export function microsoftRecurrenceRule(recurrence: TaskNativeRecurrence) {
  const { pattern, range } = recurrence
  const days = (pattern.daysOfWeek ?? []).map((day) => DAYS[day]).filter(Boolean)
  const prefix = pattern.index ? ORDINAL[pattern.index] : ''
  const parts = [`FREQ=${pattern.type === 'daily' ? 'DAILY' : pattern.type === 'weekly' ? 'WEEKLY' : pattern.type.endsWith('Monthly') ? 'MONTHLY' : 'YEARLY'}`]
  if (pattern.interval > 1) parts.push(`INTERVAL=${pattern.interval}`)
  if (pattern.type === 'weekly' && days.length) parts.push(`BYDAY=${days.join(',')}`)
  if (pattern.type.startsWith('relative') && days.length) parts.push(`BYDAY=${days.map((day) => `${prefix}${day}`).join(',')}`)
  if (pattern.type.endsWith('Yearly') && pattern.month) parts.push(`BYMONTH=${pattern.month}`)
  if (pattern.type.startsWith('absolute') && pattern.dayOfMonth) parts.push(`BYMONTHDAY=${pattern.dayOfMonth}`)
  if (range.type === 'endDate' && range.endDate) parts.push(`UNTIL=${range.endDate.replace(/-/g, '')}`)
  if (range.type === 'numbered' && range.numberOfOccurrences) parts.push(`COUNT=${range.numberOfOccurrences}`)
  return parts.join(';')
}

const LOCAL_RULES = { daily: 'FREQ=DAILY', weekly: 'FREQ=WEEKLY', monthly: 'FREQ=MONTHLY' } as const

/** VTODOs for Google Tasks or Microsoft To Do entities, with parent links by UID. */
export function connectedTaskComponents(entities: TaskEntity[], uid: (entity: TaskEntity) => string, now = new Date()): Component[] {
  const byId = new Map(entities.map((entity) => [entity.id, entity]))
  return entities.map((entity) => {
    const parent = entity.parentId ? byId.get(entity.parentId) : undefined
    const component = newVTodo(uid(entity), providerVTodoFields(entity.provider, entity.fields, entity.local, parent ? uid(parent) : undefined), now)
    const recurrence = entity.fields.native?.recurrence
    if (recurrence) setRecurrenceRule(component, microsoftRecurrenceRule(recurrence))
    else if (entity.provider === 'gmail' && entity.local.recurrence !== 'none') setRecurrenceRule(component, LOCAL_RULES[entity.local.recurrence])
    return component
  })
}

export function taskIcsPreview(path: string, text: string): TaskIcsPreview {
  const parsed = parseVTodos(text, { uid: () => `${randomUUID()}@aerio.local` })
  const items = taskIcsItems(parsed)
  const warnings = [...parsed.warnings]
  if (parsed.otherComponents.includes('VEVENT')) warnings.push('Events in this file were ignored; import them from Calendar')
  if (items.length >= TASK_ICS_MAX_ITEMS) warnings.push(`Only the first ${TASK_ICS_MAX_ITEMS.toLocaleString('en-US')} tasks were read`)
  if (!items.length) throw new Error('This file contains no tasks (VTODO)')
  return { fileName: basename(path), ...(parsed.calendarName ? { calendarName: parsed.calendarName } : {}), items, warnings }
}

const listId = (value: unknown) => {
  if (typeof value !== 'string' || !value || value.length > 2048) throw new Error('Choose a task list')
  return value
}

/**
 * .ics task import and export (E45). Every channel refuses while Aerio is locked. Imports into
 * connected lists re-read each previewed source in the main process and go through the task queue.
 */
export function registerTaskIcs(options: TaskIcsOptions) {
  const unlocked = <A extends unknown[], R>(handler: (event: IpcMainInvokeEvent, ...args: A) => R) => (event: IpcMainInvokeEvent, ...args: A) => {
    if (options.isLocked()) throw new Error('Unlock Aerio to use Tasks')
    return handler(event, ...args)
  }
  const service = () => {
    const value = options.service()
    if (!value) throw new Error('Task storage is not ready')
    return value
  }

  options.ipcMain.handle('tasks:ics:choose', unlocked(async (event): Promise<TaskIcsPreview | undefined> => {
    const path = await options.openFile(event)
    if (!path) return undefined
    const file = statSync(path)
    if (!file.isFile() || file.size > TASK_ICS_IMPORT_MAX_BYTES) throw new Error('Choose an .ics file no larger than 20 MB')
    return taskIcsPreview(path, readFileSync(path, 'utf8'))
  }))

  options.ipcMain.handle('tasks:ics:duplicates', unlocked((_event, list: unknown, uids: unknown) => {
    if (!Array.isArray(uids) || uids.length > TASK_ICS_MAX_ITEMS || !uids.every((uid) => typeof uid === 'string' && uid.length <= 1_000)) throw new Error('Invalid task UIDs')
    return service().duplicateUids(listId(list), uids)
  }))

  options.ipcMain.handle('tasks:ics:import-connected', unlocked(async (_event, list: unknown, sources: unknown, mode: unknown): Promise<TaskIcsImportResult> => {
    if (mode !== 'skip' && mode !== 'replace' && mode !== 'copy') throw new Error('Choose how to handle duplicates')
    if (!Array.isArray(sources) || !sources.length || sources.length > TASK_ICS_MAX_ITEMS || !sources.every((source) => typeof source === 'string' && source.length <= CALDAV_SOURCE_LIMIT)) throw new Error('Choose tasks to import')
    const items = sources.map((source) => parseTaskIcsSource(source as string))
    const warnings: string[] = []
    const result = await service().importTasks(listId(list), items.map((item) => ({
      uid: item.uid,
      ...(item.parentUid ? { parentUid: item.parentUid } : {}),
      build: (provider) => {
        const built = connectedImportInput(provider, item)
        warnings.push(...built.warnings)
        return built
      }
    })), mode as TaskIcsDuplicateMode, () => `${randomUUID()}@aerio.local`)
    options.diagnostic?.('tasks-ics-imported', { created: result.created, replaced: result.replaced, skipped: result.skipped, failed: result.failures.length })
    return { created: result.created, replaced: result.replaced, skipped: result.skipped, snapshot: result.snapshot, warnings: [...warnings, ...result.failures].slice(0, 200) }
  }))

  options.ipcMain.handle('tasks:ics:export', unlocked(async (event, target: unknown) => {
    const value = target as Partial<TaskIcsTarget> | undefined
    if (!value || (value.kind !== 'local' && value.kind !== 'connected')) throw new Error('Choose a task list to export')
    const id = listId(value.listId)
    let name: string
    let text: string
    let count: number
    if (value.kind === 'local') {
      const tasks = options.localTasks().filter((task) => id === 'All tasks' || task.listId === id)
      name = id
      text = serializeLocalTasks(tasks, name)
      count = tasks.length
    } else {
      const { list, entities, uid } = await service().exportList(id)
      const store = options.davStore()
      const components = list.provider === 'dav' && store ? davTaskExportComponents(store, entities) : connectedTaskComponents(entities, uid)
      const calendar = newCalendar(components, list.title)
      ensureTimeZones(calendar)
      name = list.title
      text = emitComponents([calendar])
      count = entities.length
    }
    const path = await options.saveFile(event, `${safeFilename(name)}.ics`)
    if (!path) return {}
    const destination = extname(path) ? path : `${path}.ics`
    writeFileSync(destination, text, { encoding: 'utf8', mode: 0o600 })
    options.diagnostic?.('tasks-ics-exported', { tasks: count, source: value.kind })
    return { savedPath: destination, count }
  }))
}
