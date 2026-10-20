import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { MailDatabase } from './database'
import type { DelegateTaskInput, DelegatedTask, DelegationChange, DelegationReply } from '../../src/task-delegation-types'
import { isCompleteMailAddress } from '../../src/lib/mail-address'
import { parseTaskItip, taskItip, taskStamp, validTaskDate, type TaskItip } from '../../src/lib/task-delegation-itip'
import type { CalendarMimeInput } from './mime-builder'
export class TaskDelegationStore {
  constructor(private readonly db: DatabaseSync, private readonly mail: MailDatabase) {
    db.exec(`CREATE TABLE IF NOT EXISTS task_delegations (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, uid TEXT NOT NULL, data_json TEXT NOT NULL, UNIQUE(account_id,uid));
      CREATE TABLE IF NOT EXISTS task_delegation_mail (draft_id TEXT PRIMARY KEY, delegation_id TEXT NOT NULL, method TEXT NOT NULL, ics TEXT NOT NULL);`)
  }
  private account(id: string) {
    const account = this.mail.getAccount(id)
    if (!account || account.archived || account.provider === 'local') throw new Error('Choose a connected mail account that can send task requests.')
    return account
  }
  private get(id: string): DelegatedTask {
    const row = this.db.prepare('SELECT data_json FROM task_delegations WHERE id=?').get(id)
    if (!row) throw new Error('Task assignment not found.')
    return JSON.parse(String(row.data_json))
  }
  list(): DelegatedTask[] {
    return (this.db.prepare('SELECT data_json FROM task_delegations ORDER BY rowid DESC').all()).map((row) => {
      const task: DelegatedTask = JSON.parse(String(row.data_json))
      task.deliveries = this.db.prepare('SELECT m.draft_id id,m.method,d.status,d.error FROM task_delegation_mail m LEFT JOIN gmail_drafts d ON d.id=m.draft_id WHERE m.delegation_id=? ORDER BY m.rowid DESC').all(task.id).map((item) => ({ id: String(item.id), method: String(item.method), status: item.status ? String(item.status) : 'missing', ...(item.error ? { error: String(item.error) } : {}) }))
      return task
    })
  }
  private save(task: DelegatedTask) {
    task.updatedAt = new Date(Math.max(Date.now(), Date.parse(task.updatedAt || '') + 1 || 0)).toISOString()
    this.db.prepare('INSERT INTO task_delegations(id,account_id,uid,data_json) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json').run(task.id, task.accountId, task.uid, JSON.stringify({ ...task, deliveries: [] }))
    return task
  }
  private check(task: DelegatedTask, expected: string) { this.account(task.accountId); if (task.updatedAt !== expected) throw new Error('This assignment changed. Refresh before sending.'); if (task.status === 'CANCELLED') throw new Error('This assignment was cancelled.') }
  private content(input: { title?: string; notes?: string; due?: string }) {
    if (!input || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 1024 || input.notes !== undefined && (typeof input.notes !== 'string' || input.notes.length > 8192) || input.due !== undefined && (typeof input.due !== 'string' || input.due !== '' && !validTaskDate(input.due))) throw new Error('Enter a title and a date-only due date; notes may contain up to 8192 characters.')
    return { title: input.title.trim(), notes: input.notes ?? '', ...(input.due ? { due: input.due } : { due: undefined }) }
  }
  private queue(task: DelegatedTask, method: TaskItip['method']) {
    const id = `task-request-${randomUUID()}`, now = new Date().toISOString()
    this.db.prepare('INSERT INTO task_delegation_mail(draft_id,delegation_id,method,ics) VALUES(?,?,?,?)').run(id, task.id, method, taskItip({ ...task, method }))
    this.mail.saveDraft({ id, accountId: task.accountId, to: [task.role === 'organizer' ? task.assignee : task.organizer], cc: [], bcc: [], subject: `${method === 'CANCEL' ? 'Cancelled task' : method === 'REPLY' ? 'Task response' : 'Task request'}: ${task.title}`, text: `${task.title}\n${task.notes}\n${task.due ? `Due: ${task.due}\n` : ''}${task.participation}; ${task.status}; ${task.percent}% complete${task.comment ? `\n${task.comment}` : ''}`, attachmentPaths: [] }, { status: 'send-pending', deliveryAt: now })
    return this.save(task)
  }
  assign(input: DelegateTaskInput): DelegatedTask {
    const account = this.account(input?.accountId), content = this.content(input)
    if (!isCompleteMailAddress(input.assignee) || /[\s<>]/.test(input.assignee) || input.assignee.length > 320 || input.assignee.toLowerCase() === account.email.toLowerCase()) throw new Error('Enter another person’s email address.')
    if (input.source && (!['local', 'provider'].includes(input.source.kind) || typeof input.source.id !== 'string' || input.source.id.length > 500)) throw new Error('Invalid source task link.')
    const task: DelegatedTask = { id: randomUUID(), accountId: account.id, uid: `${randomUUID()}@aerio.local`, role: 'organizer', organizer: account.email.toLowerCase(), assignee: input.assignee.toLowerCase(), ...content, sequence: 0, stamp: taskStamp(), participation: 'NEEDS-ACTION', status: 'NEEDS-ACTION', percent: 0, updatedAt: '', source: input.source, deliveries: [] }
    this.mail.transaction(() => this.queue(task, 'REQUEST')); return this.list().find((item) => item.id === task.id)!
  }
  update(input: DelegationChange): DelegatedTask {
    if (!input || input.cancel !== undefined && typeof input.cancel !== 'boolean') throw new Error('Choose whether to update or cancel this assignment.')
    const task = this.get(input.id); this.check(task, input.expectedUpdatedAt)
    if (task.role !== 'organizer') throw new Error('Only the organizer can update or cancel an assignment.')
    if (!input.cancel) Object.assign(task, this.content({ title: input.title ?? task.title, notes: input.notes ?? task.notes, due: input.due ?? task.due }))
    task.sequence++; task.stamp = taskStamp(); task.replyStamp = undefined; task.comment = undefined
    if (input.cancel) task.status = 'CANCELLED'
    else { task.participation = 'NEEDS-ACTION'; task.status = 'NEEDS-ACTION'; task.percent = 0 }
    this.mail.transaction(() => this.queue(task, input.cancel ? 'CANCEL' : 'REQUEST')); return this.list().find((item) => item.id === task.id)!
  }
  respond(input: DelegationReply): DelegatedTask {
    const task = this.get(input.id); this.check(task, input.expectedUpdatedAt)
    if (task.role !== 'assignee' || !['accept', 'decline', 'progress', 'complete'].includes(input.response)) throw new Error('Only the recipient can respond to this task.')
    if (input.comment !== undefined && (typeof input.comment !== 'string' || input.comment.length > 2000)) throw new Error('Comments may contain up to 2000 characters.')
    if (['progress', 'complete'].includes(input.response) && task.participation !== 'ACCEPTED') throw new Error('Accept the task before sending progress.')
    if (input.response === 'progress' && (!Number.isInteger(input.percent) || input.percent! < 0 || input.percent! > 99)) throw new Error('Progress must be 0–99 percent.')
    task.participation = input.response === 'decline' ? 'DECLINED' : 'ACCEPTED'
    task.status = input.response === 'complete' ? 'COMPLETED' : input.response === 'progress' ? 'IN-PROCESS' : 'NEEDS-ACTION'
    task.percent = input.response === 'complete' ? 100 : input.response === 'progress' ? input.percent! : 0
    // DTSTAMP has second precision: make rapid replies monotonically ordered.
    const prior = task.replyStamp ?? task.stamp
    const priorDate = Date.parse(`${prior.slice(0,4)}-${prior.slice(4,6)}-${prior.slice(6,8)}T${prior.slice(9,11)}:${prior.slice(11,13)}:${prior.slice(13,15)}Z`)
    task.replyStamp = taskStamp(new Date(Math.max(Date.now(), priorDate + 1000)))
    task.comment = input.comment
    const original = task.stamp; task.stamp = task.replyStamp
    this.mail.transaction(() => { this.queue(task, 'REPLY'); task.stamp = original; this.save(task) })
    return this.list().find((item) => item.id === task.id)!
  }
  observe(accountId: string, from: string, addresses: string[], parts: string[]): DelegatedTask | undefined {
    const account = this.mail.getAccount(accountId)
    if (!account || account.archived || account.provider === 'local') return
    let observed: DelegatedTask | undefined
    for (const text of parts) {
      const data = parseTaskItip(text); if (!data) continue
      const known = this.db.prepare('SELECT id FROM task_delegations WHERE account_id=? AND uid=?').get(accountId, data.uid)
      const task = known ? this.get(String(known.id)) : undefined
      const own = new Set(addresses.map((value) => value.toLowerCase()))
      if (data.method === 'REPLY') {
        if (!task || task.role !== 'organizer' || data.organizer !== task.organizer || data.assignee !== task.assignee || from.toLowerCase() !== task.assignee || data.sequence !== task.sequence || data.stamp < task.stamp || !['ACCEPTED', 'DECLINED'].includes(data.participation) || data.status === 'CANCELLED' || task.status === 'CANCELLED' || task.replyStamp && data.stamp <= task.replyStamp) continue
        task.participation = data.participation; task.status = data.status; task.percent = data.percent; task.comment = data.comment; task.replyStamp = data.stamp
        observed = this.save(task)
      } else {
        if (!own.has(data.assignee) || from.toLowerCase() !== data.organizer || own.has(data.organizer)) continue
        if (task && (task.role !== 'assignee' || task.organizer !== data.organizer || task.assignee !== data.assignee || data.sequence <= task.sequence || task.status === 'CANCELLED')) { observed = task; continue }
        // Retain cancellation tombstones even if the original request has not arrived.
        const next: DelegatedTask = { ...data, participation: 'NEEDS-ACTION', percent: 0, id: task?.id ?? randomUUID(), accountId, role: 'assignee', updatedAt: task?.updatedAt ?? '', deliveries: [], status: data.method === 'CANCEL' ? 'CANCELLED' : 'NEEDS-ACTION' }
        observed = this.save(next)
      }
    }
    return observed && this.list().find((item) => item.id === observed!.id)
  }
  calendar(draftId?: string): Pick<CalendarMimeInput, 'ics' | 'method'> | undefined {
    if (!draftId) return
    const row = this.db.prepare('SELECT ics,method FROM task_delegation_mail WHERE draft_id=?').get(draftId)
    return row ? { ics: String(row.ics), method: String(row.method) as TaskItip['method'] } : undefined
  }
  retry(draftId: string) {
    if (!this.calendar(draftId)) throw new Error('Task message not found.')
    const draft = this.mail.getDraftRecord(draftId)
    if (!draft || draft.status !== 'failed') throw new Error('Only failed task messages can be retried. Inspect Sent mail before retrying an uncertain delivery.')
    this.account(draft.accountId)
    this.mail.saveDraft(draft, { status: 'send-pending', deliveryAt: new Date().toISOString() })
  }
}
