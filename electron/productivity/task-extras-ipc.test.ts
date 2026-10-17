import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Task } from '../../src/types'
import { registerTaskExtras, validLocalTaskExtras } from './task-extras-ipc'
import { TaskReminderService } from './task-reminders'
import type { TaskBackup } from './task-backup'
import type { TaskService } from './task-service'

let directory: string
let handlers: Map<string, (...args: unknown[]) => unknown>
let state: { locked: boolean; notifications: boolean; tasks: Task[]; chosen: string[]; connectedPaths: string[] }
let notifications: [string, string][]
let broadcasts: [string, unknown][]
let service: Record<string, ReturnType<typeof vi.fn>>
let extras: ReturnType<typeof registerTaskExtras>
const event = { sender: {} }
const invoke = (channel: string, ...args: unknown[]) => {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`Missing ${channel}`)
  return handler(event, ...args)
}
const file = (name: string, contents: string | Buffer) => { const path = join(directory, 'source', name); writeFileSync(path, contents); return path }
const baseTask = (overrides: Partial<Task> = {}): Task => ({ id: 'task', listId: 'Today', title: 'Pay rent', priority: 'normal', completed: false, subtasks: [], ...overrides })

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'aerio-task-extras-'))
  mkdirSync(join(directory, 'source'))
  handlers = new Map()
  state = { locked: false, notifications: true, tasks: [], chosen: [], connectedPaths: [] }
  notifications = []; broadcasts = []
  service = {
    reminderCandidates: vi.fn(() => []),
    referencedAttachmentPaths: vi.fn(() => state.connectedPaths),
    nativeAttachment: vi.fn(async () => ({ lists: [], tasks: [], remoteTasks: [], operations: [], accounts: [] })),
    readNativeAttachment: vi.fn(async () => ({ name: 'report?.pdf', bytes: new Uint8Array([1, 2, 3]) }))
  }
  extras = registerTaskExtras({
    ipcMain: { handle: (channel: string, handler: (...args: any[]) => unknown) => { handlers.set(channel, handler) } } as never,
    userData: join(directory, 'profile'),
    tempDirectory: join(directory, 'temp'),
    service: () => service as unknown as TaskService,
    localTasks: () => state.tasks,
    isLocked: () => state.locked,
    notificationsEnabled: () => state.notifications,
    chooseFiles: async () => state.chosen,
    openPath: vi.fn(async () => ''),
    showNotification: (title, body) => notifications.push([title, body]),
    broadcast: (channel, payload) => broadcasts.push([channel, payload])
  })
})
afterEach(() => { extras.dispose(); rmSync(directory, { recursive: true, force: true }) })

describe('task extras IPC', () => {
  it('registers every channel the preload bridge uses and refuses them while locked', async () => {
    expect([...handlers.keys()].sort()).toEqual(['tasks:attachments:choose', 'tasks:attachments:open', 'tasks:attachments:open-native', 'tasks:attachments:remove-native', 'tasks:attachments:upload-native', 'tasks:reminders:dismiss', 'tasks:reminders:list', 'tasks:reminders:snooze'])
    state.locked = true
    for (const channel of handlers.keys()) expect(() => invoke(channel, 'task', 'id')).toThrow('Unlock Aerio')
  })

  it('copies chosen attachments into the managed profile directory and opens only managed files', async () => {
    state.chosen = [file('plan.txt', 'plan')]
    const [attachment] = await invoke('tasks:attachments:choose') as Task['attachments'] & object
    expect(attachment.path!.startsWith(join(directory, 'profile', 'task-attachments'))).toBe(true)
    await expect(invoke('tasks:attachments:open', attachment.path)).resolves.toEqual({})
    await expect(invoke('tasks:attachments:open', state.chosen[0])).rejects.toThrow('no longer available')
    await expect(invoke('tasks:attachments:open', 7)).rejects.toThrow('no longer available')
  })

  it('removes attachments no local or connected task references once they are saved and then dropped', async () => {
    state.chosen = [file('a.txt', 'a'), file('b.txt', 'b')]
    const [kept, dropped] = await invoke('tasks:attachments:choose') as NonNullable<Task['attachments']>
    state.tasks = [baseTask({ attachments: [kept] })]
    state.connectedPaths = [dropped.path!]
    extras.localChanged()
    expect(existsSync(dropped.path!)).toBe(true)
    state.connectedPaths = []
    extras.localChanged()
    expect(existsSync(dropped.path!)).toBe(false)
    expect(existsSync(kept.path!)).toBe(true)
  })

  it('uploads native attachments up to 3 MB through the task service and opens downloaded ones', async () => {
    state.chosen = [file('report.pdf', 'pdf')]
    await invoke('tasks:attachments:upload-native', 'entity')
    expect(service.nativeAttachment).toHaveBeenCalledWith('entity', { kind: 'add', file: { name: 'report.pdf', contentType: 'application/pdf', bytes: new Uint8Array(Buffer.from('pdf')) } })
    state.chosen = [file('large.bin', Buffer.alloc(3 * 1024 * 1024 + 1))]
    await expect(invoke('tasks:attachments:upload-native', 'entity')).rejects.toThrow('3 MB')
    state.chosen = []
    await expect(invoke('tasks:attachments:upload-native', 'entity')).resolves.toBeUndefined()
    await invoke('tasks:attachments:remove-native', 'entity', 'attachment')
    expect(service.nativeAttachment).toHaveBeenLastCalledWith('entity', { kind: 'remove', attachmentId: 'attachment' })
    await expect(invoke('tasks:attachments:open-native', 'entity', 'attachment')).resolves.toEqual({})
    const [download] = readdirSync(join(directory, 'temp', 'aerio-task-attachments'))
    expect(readdirSync(join(directory, 'temp', 'aerio-task-attachments', download))).toEqual(['report_.pdf'])
    expect(() => invoke('tasks:attachments:remove-native', '', 'attachment')).toThrow('Invalid task identity')
  })

  it('notifies due local reminders, hides titles while locked, and routes dismiss and snooze', async () => {
    state.tasks = [baseTask({ reminder: '2020-01-01T09:00:00.000Z' }), baseTask({ id: 'later', reminder: '2999-01-01T09:00:00.000Z' })]
    extras.localChanged()
    expect(notifications).toEqual([['Missed task reminder', 'Pay rent']])
    const reminders = await invoke('tasks:reminders:list') as { key: string }[]
    expect(reminders).toHaveLength(1)
    expect(broadcasts.at(-1)![0]).toBe('tasks:reminders:changed')
    const snoozed = await invoke('tasks:reminders:snooze', reminders[0].key, new Date(Date.now() + 60_000).toISOString()) as { status: string }[]
    expect(snoozed[0].status).toBe('snoozed')
    expect(await invoke('tasks:reminders:dismiss', reminders[0].key)).toEqual([])
    state.locked = true
    state.tasks = [baseTask({ id: 'next', reminder: '2020-01-02T09:00:00.000Z' })]
    extras.localChanged()
    expect(notifications.at(-1)).toEqual(['Missed task reminder', 'Unlock Aerio to see this reminder'])
  })

  it('summarizes many reminders in one notification and respects the notification preference', () => {
    state.notifications = false
    state.tasks = [baseTask({ reminder: '2020-01-01T09:00:00.000Z' })]
    extras.localChanged()
    expect(notifications).toEqual([])
    state.notifications = true
    state.tasks = ['a', 'b', 'c', 'd'].map((id) => baseTask({ id, reminder: '2020-01-01T09:00:00.000Z' }))
    extras.localChanged()
    expect(notifications).toEqual([['4 task reminders', 'Open Tasks in Aerio to review them']])
  })

  it('embeds local-overlay attachments in connected-task backups and relinks them on restore', async () => {
    state.chosen = [file('photo.png', 'png!')]
    const [attachment] = await invoke('tasks:attachments:choose') as NonNullable<Task['attachments']>
    const entity = { id: 'e', accountId: 'a', provider: 'gmail' as const, listId: 'l', fields: { title: 'T', completed: false }, local: { priority: 'normal' as const, recurrence: 'none' as const, extended: { attachments: [attachment] } }, present: true }
    const backup = { format: 'aerio-provider-tasks', schemaVersion: 2, exportedAt: '2026-10-17T00:00:00Z', accounts: [], entities: [entity], operations: [], occurrences: [], resolutions: [] } as unknown as TaskBackup
    const embedded = extras.embedBackup(backup)
    expect(embedded.attachments).toEqual([expect.objectContaining({ id: attachment.id, dataBase64: Buffer.from('png!').toString('base64') })])
    expect(extras.embedBackup({ ...backup, entities: [] })).not.toHaveProperty('attachments')
    const restored = extras.materializeBackup(embedded)
    expect(restored.backup).not.toHaveProperty('attachments')
    const path = restored.backup.entities[0].local.extended!.attachments![0].path!
    expect(path).not.toBe(attachment.path)
    expect(readFileSync(path, 'utf8')).toBe('png!')
    extras.removeFiles(restored.created)
    expect(existsSync(path)).toBe(false)
  })

  it('validates local task extended fields for local storage', () => {
    expect(validLocalTaskExtras(baseTask({ start: '2026-10-17', reminder: '2026-10-17T08:00:00.000Z', percentComplete: 20, categories: ['Home'] }))).toBe(true)
    expect(validLocalTaskExtras(baseTask({ percentComplete: 140 }))).toBe(false)
    expect(validLocalTaskExtras(baseTask({ reminder: 'tomorrow' }))).toBe(false)
  })
})

describe('reminder service injection', () => {
  it('uses an injected reminder service', () => {
    const reminders = { tick: vi.fn(), list: vi.fn(() => []), dismiss: vi.fn(() => []), snooze: vi.fn(() => []), close: vi.fn() } as unknown as TaskReminderService
    const local = new Map<string, (...args: unknown[]) => unknown>()
    const registered = registerTaskExtras({
      ipcMain: { handle: (channel: string, handler: (...args: any[]) => unknown) => { local.set(channel, handler) } } as never,
      userData: join(directory, 'injected'), tempDirectory: directory, service: () => undefined, localTasks: () => [], isLocked: () => false,
      notificationsEnabled: () => true, chooseFiles: async () => [], openPath: async () => '', showNotification: () => {}, broadcast: () => {}, reminders
    })
    local.get('tasks:reminders:dismiss')!(event, 'key')
    expect(reminders.dismiss).toHaveBeenCalledWith('key')
    registered.dispose()
    expect(reminders.close).toHaveBeenCalled()
  })
})
