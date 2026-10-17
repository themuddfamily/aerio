import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { TaskReminder, TaskReminderSource } from '../../src/task-fields-types'
import { validTaskReminder } from '../../src/lib/task-schedule'

/** A task with a reminder, as read from local Tasks or a connected-task cache. */
export interface TaskReminderCandidate {
  source: TaskReminderSource
  taskId: string
  title: string
  reminder: string
  completed: boolean
}

export interface TaskReminderServiceOptions {
  path: string
  candidates(): TaskReminderCandidate[]
  /** Reminders that became due in this pass (first time or after a snooze). */
  notify(fired: TaskReminder[]): void
  changed(active: TaskReminder[]): void
  now?(): number
  /** Defaults to an unreferenced setTimeout. */
  schedule?(callback: () => void, delay: number): () => void
}

/** A reminder delivered more than a minute late, for example while Aerio was closed, is labeled missed. */
export const MISSED_REMINDER_GRACE_MS = 60_000
export const MAX_REMINDER_SNOOZE_MS = 30 * 86_400_000
// Without a matching task, delivery state is retained this long so a reappearing cache cannot refire it.
const STATE_RETENTION_MS = 30 * 86_400_000
const MAX_WAIT_MS = 60_000

export const TASK_REMINDER_SCHEMA = `
  CREATE TABLE IF NOT EXISTS task_reminder_state (
    key TEXT PRIMARY KEY, source TEXT NOT NULL CHECK(source IN ('local','connected')), task_id TEXT NOT NULL,
    reminder_at TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('fired','snoozed','dismissed')),
    fired_at INTEGER, snoozed_until INTEGER, missed INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_task_reminder_task ON task_reminder_state(source,task_id);
`

export const taskReminderKey = (source: TaskReminderSource, taskId: string, reminder: string) => `${source}:${taskId}:${new Date(reminder).toISOString()}`

interface StateRow { key: string; source: TaskReminderSource; task_id: string; reminder_at: string; status: 'fired' | 'snoozed' | 'dismissed'; fired_at: number | null; snoozed_until: number | null; missed: number; title: string; updated_at: number }

/**
 * Durable reminder delivery for tasks (E44). Each task reminder instant has one state row:
 * fired, snoozed until a time, or dismissed. Rows survive restart, so a dismissed reminder never
 * fires again and reminders that fell due while Aerio was closed fire once, labeled missed.
 * Changing a reminder time or completing a recurring task yields a new key and a fresh delivery.
 */
export class TaskReminderService {
  private readonly db: DatabaseSync
  private cancel?: () => void
  private lastPublished = ''
  private closed = false

  constructor(private readonly options: TaskReminderServiceOptions) {
    mkdirSync(dirname(options.path), { recursive: true })
    this.db = new DatabaseSync(options.path)
    this.db.exec('PRAGMA journal_mode=WAL;')
    this.db.exec(TASK_REMINDER_SCHEMA)
  }

  private now() { return this.options.now?.() ?? Date.now() }

  private candidates() {
    const unique = new Map<string, TaskReminderCandidate & { key: string; at: number }>()
    for (const candidate of this.options.candidates()) {
      if (!validTaskReminder(candidate.reminder)) continue
      const key = taskReminderKey(candidate.source, candidate.taskId, candidate.reminder)
      unique.set(key, { ...candidate, key, at: Date.parse(candidate.reminder) })
    }
    return unique
  }

  private rows() {
    return new Map((this.db.prepare('SELECT * FROM task_reminder_state').all() as unknown as StateRow[]).map((row) => [row.key, row]))
  }

  private view(row: StateRow, title: string): TaskReminder {
    return {
      key: row.key, source: row.source, taskId: row.task_id, title, reminderAt: row.reminder_at,
      status: row.status === 'snoozed' ? 'snoozed' : 'fired',
      ...(row.fired_at !== null ? { firedAt: new Date(row.fired_at).toISOString() } : {}),
      ...(row.snoozed_until !== null && row.status === 'snoozed' ? { snoozedUntil: new Date(row.snoozed_until).toISOString() } : {}),
      missed: Boolean(row.missed)
    }
  }

  /** Fired and snoozed reminders for open tasks, newest reminder first. */
  list(candidates = this.candidates()): TaskReminder[] {
    const rows = this.rows()
    const active: TaskReminder[] = []
    for (const candidate of candidates.values()) {
      const row = rows.get(candidate.key)
      if (!row || row.status === 'dismissed' || candidate.completed) continue
      active.push(this.view(row, candidate.title))
    }
    return active.sort((a, b) => b.reminderAt.localeCompare(a.reminderAt) || a.key.localeCompare(b.key))
  }

  /** Delivers due reminders, publishes changes, and schedules the next pass. */
  tick() {
    if (this.closed) return
    this.cancel?.()
    this.cancel = undefined
    const now = this.now()
    let wake = now + MAX_WAIT_MS
    let candidates: ReturnType<TaskReminderService['candidates']>
    try { candidates = this.candidates() }
    catch { this.wait(wake - now); return }
    const rows = this.rows()
    const fired: TaskReminder[] = []
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const candidate of candidates.values()) {
        if (candidate.completed) continue
        const row = rows.get(candidate.key)
        if (!row) {
          if (candidate.at > now) { wake = Math.min(wake, candidate.at); continue }
          const missed = now - candidate.at > MISSED_REMINDER_GRACE_MS
          this.db.prepare("INSERT INTO task_reminder_state(key,source,task_id,reminder_at,status,fired_at,missed,title,updated_at) VALUES(?,?,?,?,'fired',?,?,?,?)").run(candidate.key, candidate.source, candidate.taskId, new Date(candidate.at).toISOString(), now, Number(missed), candidate.title, now)
          fired.push(this.view(this.rows().get(candidate.key)!, candidate.title))
        } else if (row.status === 'snoozed' && row.snoozed_until !== null) {
          if (row.snoozed_until > now) { wake = Math.min(wake, row.snoozed_until); continue }
          const missed = now - row.snoozed_until > MISSED_REMINDER_GRACE_MS
          this.db.prepare("UPDATE task_reminder_state SET status='fired',fired_at=?,snoozed_until=NULL,missed=?,title=?,updated_at=? WHERE key=?").run(now, Number(missed), candidate.title, now, candidate.key)
          fired.push(this.view(this.rows().get(candidate.key)!, candidate.title))
        }
      }
      // Forget delivery state only after its task has been gone for the retention period.
      for (const row of rows.values()) {
        if (candidates.has(row.key)) this.db.prepare('UPDATE task_reminder_state SET updated_at=? WHERE key=? AND updated_at<?').run(now, row.key, now - 86_400_000)
        else if (row.updated_at < now - STATE_RETENTION_MS) this.db.prepare('DELETE FROM task_reminder_state WHERE key=?').run(row.key)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      this.wait(MAX_WAIT_MS)
      throw error
    }
    if (fired.length) this.options.notify(fired)
    this.publish(this.list(candidates))
    this.wait(Math.max(1_000, wake - now))
  }

  private wait(delay: number) {
    if (this.closed) return
    const schedule = this.options.schedule ?? ((callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms)
      timer.unref?.()
      return () => clearTimeout(timer)
    })
    this.cancel = schedule(() => { try { this.tick() } catch { /* The next pass retries. */ } }, delay)
  }

  private publish(active: TaskReminder[]) {
    const serialized = JSON.stringify(active)
    if (serialized === this.lastPublished) return
    this.lastPublished = serialized
    this.options.changed(active)
  }

  private activeRow(key: unknown) {
    if (typeof key !== 'string' || !key || key.length > 5_000) throw new Error('Choose a valid reminder')
    const row = this.rows().get(key)
    if (!row || row.status === 'dismissed') throw new Error('That reminder is no longer active')
    return row
  }

  dismiss(key: unknown) {
    const row = this.activeRow(key)
    this.db.prepare("UPDATE task_reminder_state SET status='dismissed',snoozed_until=NULL,updated_at=? WHERE key=?").run(this.now(), row.key)
    const active = this.list()
    this.publish(active)
    return active
  }

  snooze(key: unknown, until: unknown) {
    const row = this.activeRow(key)
    const now = this.now()
    const at = typeof until === 'string' && until.length <= 100 ? Date.parse(until) : NaN
    if (!Number.isFinite(at) || at <= now) throw new Error('Snooze until a future time')
    if (at > now + MAX_REMINDER_SNOOZE_MS) throw new Error('Reminders can be snoozed for up to 30 days')
    this.db.prepare("UPDATE task_reminder_state SET status='snoozed',snoozed_until=?,updated_at=? WHERE key=?").run(at, now, row.key)
    this.tick()
    return this.list()
  }

  close() {
    this.closed = true
    this.cancel?.()
    this.db.close()
  }
}
