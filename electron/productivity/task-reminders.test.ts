import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskReminderService, taskReminderKey, type TaskReminderCandidate } from './task-reminders'
import type { TaskReminder } from '../../src/task-fields-types'

let directory: string
let now: number
let candidates: TaskReminderCandidate[]
let fired: TaskReminder[][]
let published: TaskReminder[][]
let scheduled: { callback: () => void; delay: number }[]
const services: TaskReminderService[] = []
const minute = 60_000
const open = () => {
  const service = new TaskReminderService({
    path: join(directory, 'task-reminders.sqlite'),
    candidates: () => candidates,
    notify: (items) => fired.push(items),
    changed: (items) => published.push(items),
    now: () => now,
    schedule: (callback, delay) => { const entry = { callback, delay }; scheduled.push(entry); return () => { scheduled = scheduled.filter((item) => item !== entry) } }
  })
  services.push(service)
  return service
}
const close = (service: TaskReminderService) => { service.close(); services.splice(services.indexOf(service), 1) }
const task = (overrides: Partial<TaskReminderCandidate> = {}): TaskReminderCandidate => ({ source: 'local', taskId: 'task-1', title: 'Send the report', reminder: '2026-10-17T09:00:00.000Z', completed: false, ...overrides })

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'aerio-task-reminders-'))
  now = Date.parse('2026-10-17T08:00:00.000Z')
  candidates = [task()]
  fired = []; published = []; scheduled = []
})
afterEach(() => {
  for (const service of [...services]) close(service)
  rmSync(directory, { recursive: true, force: true })
})

describe('durable task reminders', () => {
  it('fires once at the reminder time, independent of the due date, and waits until then', () => {
    const service = open()
    service.tick()
    expect(fired).toEqual([])
    expect(scheduled.at(-1)!.delay).toBe(minute)
    now = Date.parse('2026-10-17T08:59:30.000Z')
    service.tick()
    expect(scheduled.at(-1)!.delay).toBe(30_000)
    now = Date.parse('2026-10-17T09:00:10.000Z')
    scheduled.at(-1)!.callback()
    expect(fired).toHaveLength(1)
    expect(fired[0][0]).toMatchObject({ key: taskReminderKey('local', 'task-1', '2026-10-17T09:00:00.000Z'), title: 'Send the report', status: 'fired', missed: false })
    service.tick(); service.tick()
    expect(fired).toHaveLength(1)
    expect(service.list()).toHaveLength(1)
    expect(published.at(-1)).toHaveLength(1)
  })

  it('delivers reminders missed while closed once after restart, labeled missed', () => {
    let service = open()
    service.tick()
    close(service)
    now = Date.parse('2026-10-17T11:00:00.000Z')
    service = open()
    service.tick()
    expect(fired).toHaveLength(1)
    expect(fired[0][0].missed).toBe(true)
    close(service)
    service = open()
    service.tick()
    expect(fired).toHaveLength(1)
    expect(service.list()[0]).toMatchObject({ status: 'fired', missed: true })
  })

  it('keeps dismissals across restart and never refires a dismissed reminder', () => {
    now = Date.parse('2026-10-17T09:00:00.000Z')
    let service = open()
    service.tick()
    const [reminder] = service.list()
    expect(service.dismiss(reminder.key)).toEqual([])
    expect(published.at(-1)).toEqual([])
    close(service)
    now += 7 * 86_400_000
    service = open()
    service.tick()
    expect(fired).toHaveLength(1)
    expect(service.list()).toEqual([])
    expect(() => service.dismiss(reminder.key)).toThrow('no longer active')
  })

  it('snoozes until a later time, persists the snooze across restart, then fires again', () => {
    now = Date.parse('2026-10-17T09:00:00.000Z')
    let service = open()
    service.tick()
    const key = service.list()[0].key
    expect(() => service.snooze(key, '2026-10-17T08:00:00.000Z')).toThrow('future')
    expect(() => service.snooze(key, '2026-12-17T08:00:00.000Z')).toThrow('30 days')
    expect(() => service.snooze(key, 'soon')).toThrow('future')
    expect(service.snooze(key, '2026-10-17T09:10:00.000Z')).toEqual([expect.objectContaining({ status: 'snoozed', snoozedUntil: '2026-10-17T09:10:00.000Z' })])
    expect(scheduled.at(-1)!.delay).toBe(minute)
    close(service)
    now = Date.parse('2026-10-17T09:05:00.000Z')
    service = open()
    service.tick()
    expect(fired).toHaveLength(1)
    now = Date.parse('2026-10-17T09:10:30.000Z')
    service.tick()
    expect(fired).toHaveLength(2)
    expect(fired[1][0]).toMatchObject({ status: 'fired', missed: false })
  })

  it('skips completed tasks and starts a fresh delivery when the reminder time changes', () => {
    now = Date.parse('2026-10-17T09:30:00.000Z')
    candidates = [task({ completed: true })]
    const service = open()
    service.tick()
    expect(fired).toEqual([])
    candidates = [task()]
    service.tick()
    service.dismiss(service.list()[0].key)
    candidates = [task({ reminder: '2026-10-17T10:00:00.000Z' })]
    service.tick()
    expect(fired).toHaveLength(1)
    now = Date.parse('2026-10-17T10:00:00.000Z')
    service.tick()
    expect(fired).toHaveLength(2)
    // Completing hides an active reminder without dismissing it.
    candidates = [task({ reminder: '2026-10-17T10:00:00.000Z', completed: true })]
    service.tick()
    expect(service.list()).toEqual([])
  })

  it('gives each recurring occurrence its own reminder delivery', () => {
    now = Date.parse('2026-10-17T09:00:00.000Z')
    const service = open()
    service.tick()
    service.dismiss(service.list()[0].key)
    // Completing the recurring task creates the next occurrence with its reminder offset applied.
    candidates = [task({ completed: true }), task({ taskId: 'task-2', reminder: '2026-10-18T09:00:00.000Z' })]
    service.tick()
    expect(fired).toHaveLength(1)
    now = Date.parse('2026-10-18T09:00:00.000Z')
    service.tick()
    expect(fired.at(-1)![0]).toMatchObject({ taskId: 'task-2', reminderAt: '2026-10-18T09:00:00.000Z' })
  })

  it('separates local and connected sources and ignores malformed reminders', () => {
    now = Date.parse('2026-10-17T09:00:00.000Z')
    candidates = [task(), task({ source: 'connected' }), task({ taskId: 'bad', reminder: 'not-a-date' })]
    const service = open()
    service.tick()
    expect(fired[0].map((item) => item.source).sort()).toEqual(['connected', 'local'])
  })

  it('retains delivery state while a task is temporarily absent', () => {
    now = Date.parse('2026-10-17T09:00:00.000Z')
    const service = open()
    service.tick()
    service.dismiss(service.list()[0].key)
    candidates = []
    now += 10 * 86_400_000
    service.tick()
    candidates = [task()]
    service.tick()
    expect(fired).toHaveLength(1)
    candidates = []
    now += 31 * 86_400_000
    service.tick()
    candidates = [task()]
    service.tick()
    // After the retention period the old state is forgotten, so the reminder is delivered as missed.
    expect(fired).toHaveLength(2)
    expect(fired[1][0].missed).toBe(true)
  })

  it('reschedules after a failing candidate source without delivering anything', () => {
    const service = open()
    const failing = vi.fn(() => { throw new Error('storage closed') })
    ;(service as unknown as { options: { candidates: () => TaskReminderCandidate[] } }).options.candidates = failing
    service.tick()
    expect(fired).toEqual([])
    expect(scheduled.at(-1)!.delay).toBe(minute)
  })
})
