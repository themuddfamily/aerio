import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { Task } from '../../src/types'
import type { TaskReminder } from '../../src/task-fields-types'
import type { TaskLocalMetadata, TaskSnapshot } from '../../src/task-provider-types'
import type { ArchivedTaskAttachment } from './task-backup'
import { localTaskExtendedFields, validTaskExtendedFields } from '../../src/lib/task-schedule'
import { MICROSOFT_TASK_ATTACHMENT_MAX_BYTES } from './microsoft-tasks-connector'
import { relinkAttachments, TaskAttachmentFiles } from './task-attachments'
import type { TaskBackup } from './task-backup'
import { TaskReminderService, type TaskReminderCandidate } from './task-reminders'
import type { TaskService } from './task-service'

export interface TaskExtrasOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  userData: string
  tempDirectory: string
  service(): TaskService | undefined
  localTasks(): Task[]
  isLocked(): boolean
  notificationsEnabled(): boolean
  chooseFiles(event: IpcMainInvokeEvent, title: string): Promise<string[]>
  openPath(path: string): Promise<string>
  showNotification(title: string, body: string): void
  broadcast(channel: string, payload: unknown): void
  /** Injected for tests; production uses SQLite in the profile. */
  reminders?: TaskReminderService
}

const id = (value: unknown, label = 'task') => {
  if (typeof value !== 'string' || !value || value.length > 2048) throw new Error(`Invalid ${label} identity`)
  return value
}

/**
 * Validates a local task's extended fields. Attachment paths are opened and cleaned up only inside
 * managed storage, as with Notes, so restored backups may carry their original paths until relinked.
 */
export function validLocalTaskExtras(task: Task) {
  return validTaskExtendedFields(localTaskExtendedFields(task))
}

/**
 * Task reminders and managed task attachments (E44): IPC, durable reminder delivery, and cleanup.
 * Every channel refuses while Aerio is locked; notifications omit task titles while locked.
 */
export function registerTaskExtras(options: TaskExtrasOptions) {
  const files = new TaskAttachmentFiles(join(options.userData, 'task-attachments'))
  const candidates = (): TaskReminderCandidate[] => [
    ...options.localTasks().filter((task) => task.reminder).map((task) => ({ source: 'local' as const, taskId: task.id, title: task.title, reminder: task.reminder!, completed: task.completed })),
    ...(options.service()?.reminderCandidates() ?? [])
  ]
  const notify = (fired: TaskReminder[]) => {
    if (!options.notificationsEnabled()) return
    const locked = options.isLocked()
    if (fired.length > 3) {
      options.showNotification(`${fired.length} task reminders`, locked ? 'Unlock Aerio to see them' : 'Open Tasks in Aerio to review them')
      return
    }
    for (const reminder of fired) options.showNotification(reminder.missed ? 'Missed task reminder' : 'Task reminder', locked ? 'Unlock Aerio to see this reminder' : reminder.title)
  }
  const reminders = options.reminders ?? new TaskReminderService({
    path: join(options.userData, 'task-reminders.sqlite'),
    candidates,
    notify,
    changed: (active) => options.broadcast('tasks:reminders:changed', active)
  })
  const unlocked = <A extends unknown[], R>(handler: (event: IpcMainInvokeEvent, ...args: A) => R) => (event: IpcMainInvokeEvent, ...args: A) => {
    if (options.isLocked()) throw new Error('Unlock Aerio to use Tasks')
    return handler(event, ...args)
  }
  const service = () => {
    const value = options.service()
    if (!value) throw new Error('Task storage is not ready')
    return value
  }
  const references = () => {
    const connected = options.service()
    // Without the connected-task store the reference set is incomplete, so nothing is removed.
    if (!connected) return undefined
    return [...options.localTasks().flatMap((task) => task.attachments ?? []).flatMap((attachment) => attachment.path ? [attachment.path] : []), ...connected.referencedAttachmentPaths()]
  }
  const sweep = () => {
    try {
      const referenced = references()
      if (referenced) files.sweep(referenced)
    } catch { /* Cleanup retries after the next change. */ }
  }
  const refreshReminders = () => { try { reminders.tick() } catch { /* The next pass retries. */ } }
  const openDownloaded = async (name: string, bytes: Uint8Array) => {
    const directory = join(options.tempDirectory, 'aerio-task-attachments', randomUUID())
    mkdirSync(directory, { recursive: true })
    const safe = basename(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 200) || 'attachment'
    const path = join(directory, safe)
    writeFileSync(path, bytes, { mode: 0o600 })
    const error = await options.openPath(path)
    return error ? { error } : {}
  }

  options.ipcMain.handle('tasks:attachments:choose', unlocked(async (event) => files.copyIn(await options.chooseFiles(event, 'Attach files to task'))))
  options.ipcMain.handle('tasks:attachments:open', unlocked(async (_event, path: unknown) => {
    if (typeof path !== 'string' || !files.isManaged(path) || !existsSync(path)) throw new Error('That task attachment is no longer available')
    const error = await options.openPath(path)
    return error ? { error } : {}
  }))
  options.ipcMain.handle('tasks:attachments:upload-native', unlocked(async (event, taskId: unknown): Promise<TaskSnapshot | undefined> => {
    const target = id(taskId)
    const paths = await options.chooseFiles(event, 'Attach files to Microsoft To Do task')
    if (!paths.length) return undefined
    if (paths.length > 10) throw new Error('Attach up to 10 files at a time')
    const uploads = paths.map((path) => {
      const file = statSync(path)
      if (!file.isFile() || file.size > MICROSOFT_TASK_ATTACHMENT_MAX_BYTES) throw new Error(`“${basename(path)}” must be a file no larger than 3 MB`)
      return path
    })
    let snapshot: TaskSnapshot | undefined
    for (const path of uploads) {
      const extension = extname(path).slice(1).toLowerCase()
      snapshot = await service().nativeAttachment(target, { kind: 'add', file: { name: basename(path), contentType: extension ? contentTypes[extension] : undefined, bytes: new Uint8Array(readFileSync(path)) } })
    }
    return snapshot
  }))
  options.ipcMain.handle('tasks:attachments:remove-native', unlocked((_event, taskId: unknown, attachmentId: unknown) => service().nativeAttachment(id(taskId), { kind: 'remove', attachmentId: id(attachmentId, 'attachment') })))
  options.ipcMain.handle('tasks:attachments:open-native', unlocked(async (_event, taskId: unknown, attachmentId: unknown) => {
    const { name, bytes } = await service().readNativeAttachment(id(taskId), id(attachmentId, 'attachment'))
    return openDownloaded(name, bytes)
  }))
  options.ipcMain.handle('tasks:reminders:list', unlocked(() => reminders.list()))
  options.ipcMain.handle('tasks:reminders:dismiss', unlocked((_event, key: unknown) => reminders.dismiss(key)))
  options.ipcMain.handle('tasks:reminders:snooze', unlocked((_event, key: unknown, until: unknown) => reminders.snooze(key, until)))

  refreshReminders()
  sweep()
  // Connected-task changes arrive in bursts (sync phases, queued writes); coalesce them.
  let connectedTimer: ReturnType<typeof setTimeout> | undefined
  return {
    files,
    /** Local Tasks were saved or restored. */
    localChanged() { sweep(); refreshReminders() },
    /** The connected-task cache or its overlays changed. */
    connectedChanged() {
      if (connectedTimer) return
      connectedTimer = setTimeout(() => { connectedTimer = undefined; sweep(); refreshReminders() }, 250)
      connectedTimer.unref?.()
    },
    /** Embeds local-overlay attachment files in a connected-task backup (schema 2). */
    embedBackup(backup: TaskBackup): TaskBackup {
      const attachments = [...backup.entities, ...backup.operations.map((operation) => operation.before)].flatMap((item) => item.local.extended?.attachments ?? [])
      return attachments.length ? { ...backup, schemaVersion: 2, attachments: files.archive(attachments) } : backup
    },
    /** Writes embedded files and points overlays at the new copies before the store restores them. */
    materializeBackup(backup: TaskBackup): { backup: TaskBackup; created: string[] } {
      if (!backup.attachments?.length) return { backup, created: [] }
      const { paths, created } = files.materialize(backup.attachments)
      try {
        const relink = <T extends { local: TaskLocalMetadata }>(item: T): T => item.local.extended?.attachments ? { ...item, local: { ...item.local, extended: relinkAttachments(item.local.extended, paths) } } : item
        const { attachments: _embedded, ...rest } = backup
        return { backup: { ...rest, entities: backup.entities.map(relink), operations: backup.operations.map((operation) => ({ ...operation, before: relink(operation.before) })) }, created }
      } catch (error) {
        files.remove(created)
        throw error
      }
    },
    /** Local Tasks backup restore (aerio-local-data schema 3): writes files and relinks attachments. */
    materializeLocalTasks(tasks: Task[], archived: ArchivedTaskAttachment[]): { tasks: Task[]; created: string[] } {
      if (!archived.length) return { tasks, created: [] }
      const { paths, created } = files.materialize(archived)
      try { return { tasks: tasks.map((task) => relinkAttachments(task, paths)), created } }
      catch (error) { files.remove(created); throw error }
    },
    removeFiles(paths: string[]) { files.remove(paths) },
    dispose() {
      if (connectedTimer) clearTimeout(connectedTimer)
      try { reminders.close() } catch { /* Already closed. */ }
    }
  }
}

const contentTypes: Record<string, string> = {
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', zip: 'application/zip', json: 'application/json', md: 'text/markdown'
}
