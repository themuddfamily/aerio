import type { DatabaseSync } from 'node:sqlite'
import type {
  MailMergeCounts,
  MailMergeJob,
  MailMergeJobInput,
  MailMergeJobStatus,
  MailMergeJobSummary,
  MailMergeRecipient,
  MailMergeRecipientStatus,
  MailMergeResolution
} from '../../src/mail-merge-types'

type Row = Record<string, string | number | bigint | null>

const STATUSES: MailMergeRecipientStatus[] = ['pending', 'sending', 'sent', 'failed', 'ambiguous', 'skipped', 'cancelled']
export const MAIL_MERGE_DAY_MS = 24 * 60 * 60_000
const nowIso = () => new Date().toISOString()
const json = <T>(value: unknown, fallback: T): T => {
  try {
    return typeof value === 'string' && value ? JSON.parse(value) as T : fallback
  } catch {
    return fallback
  }
}
const optional = (value: string | number | bigint | null | undefined) => value === null || value === undefined || value === '' ? undefined : String(value)

export const MAIL_MERGE_ACTIVE = `status IN ('running','paused','needs-review')`

/**
 * Run on a restored profile copy: the backup may predate deliveries made
 * afterwards, so every unsent recipient of an unfinished merge needs review
 * instead of being sent again. Returns the number of recipients held.
 */
export function holdMailMergesForRestore(db: DatabaseSync, reason: string, at = nowIso()) {
  const held = Number(db.prepare(`UPDATE mail_merge_recipients SET status='ambiguous', error=?, updated_at=? WHERE status IN ('pending','sending') AND job_id IN (SELECT id FROM mail_merge_jobs WHERE ${MAIL_MERGE_ACTIVE})`).run(reason, at).changes)
  db.prepare(`UPDATE mail_merge_jobs SET status='needs-review', last_error=?, updated_at=? WHERE ${MAIL_MERGE_ACTIVE} AND EXISTS (SELECT 1 FROM mail_merge_recipients r WHERE r.job_id=mail_merge_jobs.id AND r.status='ambiguous')`).run(reason, at)
  return held
}

/**
 * Durable mail merge jobs. Each recipient row moves `pending` → `sending` in
 * its own committed write before the provider is contacted, so a crash leaves
 * evidence that the outcome is unknown rather than a row that would be sent
 * again. Rows are removed with their account via foreign keys.
 */
export class MailMergeStore {
  constructor(private readonly db: DatabaseSync) {
    this.migrate()
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mail_merge_jobs (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES gmail_accounts(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        subject TEXT NOT NULL,
        body_text TEXT NOT NULL,
        body_html TEXT,
        attachment_paths_json TEXT NOT NULL DEFAULT '[]',
        from_identity_id TEXT,
        reply_to_json TEXT NOT NULL DEFAULT '[]',
        send_options_json TEXT,
        per_minute INTEGER NOT NULL,
        daily_cap INTEGER NOT NULL,
        next_attempt_at TEXT,
        backoff_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mail_merge_recipients (
        job_id TEXT NOT NULL REFERENCES mail_merge_jobs(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        email TEXT NOT NULL,
        name TEXT,
        first_name TEXT,
        last_name TEXT,
        company TEXT,
        fields_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        message_id_header TEXT,
        submitted_at TEXT,
        sent_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (job_id, position)
      );
      CREATE INDEX IF NOT EXISTS mail_merge_recipients_status ON mail_merge_recipients(job_id, status, position);
      CREATE INDEX IF NOT EXISTS mail_merge_jobs_status ON mail_merge_jobs(status, next_attempt_at);
      CREATE TABLE IF NOT EXISTS mail_merge_send_log (
        account_id TEXT NOT NULL REFERENCES gmail_accounts(id) ON DELETE CASCADE,
        sent_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mail_merge_send_log_account ON mail_merge_send_log(account_id, sent_at);
    `)
  }

  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = action()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** Stores a new job; the caller has validated the input and copied its attachments. */
  create(id: string, input: MailMergeJobInput, at = nowIso()): MailMergeJob {
    this.transaction(() => {
      this.db.prepare(`INSERT INTO mail_merge_jobs(id,account_id,name,status,subject,body_text,body_html,attachment_paths_json,from_identity_id,reply_to_json,send_options_json,per_minute,daily_cap,next_attempt_at,created_at,updated_at)
        VALUES(?,?,?,'running',?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, input.accountId, input.name?.trim() || input.subject.trim() || 'Mail merge', input.subject, input.text, input.html ?? null,
        JSON.stringify(input.attachmentPaths), input.fromIdentityId ?? null, JSON.stringify(input.replyTo ?? []),
        input.sendOptions ? JSON.stringify(input.sendOptions) : null, input.limits.perMinute, input.limits.dailyCap, null, at, at
      )
      const insert = this.db.prepare(`INSERT INTO mail_merge_recipients(job_id,position,email,name,first_name,last_name,company,fields_json,status,updated_at) VALUES(?,?,?,?,?,?,?,?,'pending',?)`)
      input.recipients.forEach((recipient, position) => insert.run(
        id, position, recipient.email, recipient.name ?? null, recipient.firstName ?? null, recipient.lastName ?? null,
        recipient.company ?? null, JSON.stringify(recipient.fields ?? {}), at
      ))
    })
    return this.get(id)!
  }

  private counts(jobId: string): MailMergeCounts {
    const counts = Object.fromEntries(STATUSES.map((status) => [status, 0])) as MailMergeCounts
    const rows = this.db.prepare('SELECT status, COUNT(*) AS count FROM mail_merge_recipients WHERE job_id=? GROUP BY status').all(jobId) as Row[]
    for (const row of rows) counts[String(row.status) as MailMergeRecipientStatus] = Number(row.count)
    return counts
  }

  private summaryFromRow(row: Row): MailMergeJobSummary {
    const counts = this.counts(String(row.id))
    return {
      id: String(row.id),
      accountId: String(row.account_id),
      name: String(row.name),
      subject: String(row.subject),
      status: String(row.status) as MailMergeJobStatus,
      limits: { perMinute: Number(row.per_minute), dailyCap: Number(row.daily_cap) },
      counts,
      total: Object.values(counts).reduce((sum, count) => sum + count, 0),
      ...(optional(row.next_attempt_at) && (row.status === 'running') ? { nextAttemptAt: String(row.next_attempt_at) } : {}),
      ...(optional(row.last_error) ? { lastError: String(row.last_error) } : {}),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    }
  }

  private recipient(row: Row): MailMergeRecipient {
    const fields = json<Record<string, string>>(row.fields_json, {})
    return {
      position: Number(row.position),
      email: String(row.email),
      ...(optional(row.name) ? { name: String(row.name) } : {}),
      ...(optional(row.first_name) ? { firstName: String(row.first_name) } : {}),
      ...(optional(row.last_name) ? { lastName: String(row.last_name) } : {}),
      ...(optional(row.company) ? { company: String(row.company) } : {}),
      ...(Object.keys(fields).length ? { fields } : {}),
      status: String(row.status) as MailMergeRecipientStatus,
      attempts: Number(row.attempts),
      ...(optional(row.error) ? { error: String(row.error) } : {}),
      ...(optional(row.sent_at) ? { sentAt: String(row.sent_at) } : {}),
      updatedAt: String(row.updated_at)
    }
  }

  private jobRow(id: string) {
    return this.db.prepare('SELECT * FROM mail_merge_jobs WHERE id=?').get(id) as Row | undefined
  }

  list(): MailMergeJobSummary[] {
    return (this.db.prepare('SELECT * FROM mail_merge_jobs ORDER BY created_at DESC LIMIT 200').all() as Row[]).map((row) => this.summaryFromRow(row))
  }

  summary(id: string): MailMergeJobSummary | undefined {
    const row = this.jobRow(id)
    return row ? this.summaryFromRow(row) : undefined
  }

  get(id: string): MailMergeJob | undefined {
    const row = this.jobRow(id)
    if (!row) return undefined
    const recipients = (this.db.prepare('SELECT * FROM mail_merge_recipients WHERE job_id=? ORDER BY position').all(id) as Row[]).map((item) => this.recipient(item))
    const replyTo = json<string[]>(row.reply_to_json, [])
    return {
      ...this.summaryFromRow(row),
      subject: String(row.subject),
      text: String(row.body_text),
      ...(optional(row.body_html) !== undefined ? { html: String(row.body_html) } : {}),
      attachmentPaths: json<string[]>(row.attachment_paths_json, []),
      ...(optional(row.from_identity_id) ? { fromIdentityId: String(row.from_identity_id) } : {}),
      ...(replyTo.length ? { replyTo } : {}),
      ...(row.send_options_json ? { sendOptions: json(row.send_options_json, undefined) } : {}),
      recipients
    }
  }

  recipientAt(jobId: string, position: number) {
    const row = this.db.prepare('SELECT * FROM mail_merge_recipients WHERE job_id=? AND position=?').get(jobId, position) as Row | undefined
    return row ? this.recipient(row) : undefined
  }

  /**
   * Run once at startup: a delivery that was `sending` when Aerio stopped may
   * or may not have reached the provider, so it becomes `ambiguous` and its
   * job waits for review. Returns the affected job ids.
   */
  recoverInterrupted(at = nowIso()): string[] {
    const jobs = (this.db.prepare(`SELECT DISTINCT job_id FROM mail_merge_recipients WHERE status='sending'`).all() as Row[]).map((row) => String(row.job_id))
    if (!jobs.length) return []
    this.transaction(() => {
      this.db.prepare(`UPDATE mail_merge_recipients SET status='ambiguous', error=?, updated_at=? WHERE status='sending'`)
        .run('Aerio stopped while this message was being sent. It may already have been delivered.', at)
      for (const id of jobs) this.refreshStatus(id, at)
    })
    return jobs
  }

  /** Running jobs whose throttle window has passed, oldest first. */
  dueJobs(at: string): MailMergeJobSummary[] {
    return (this.db.prepare(`SELECT * FROM mail_merge_jobs WHERE status='running' AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY created_at`).all(at) as Row[])
      .map((row) => this.summaryFromRow(row))
  }

  nextPending(jobId: string) {
    const row = this.db.prepare(`SELECT * FROM mail_merge_recipients WHERE job_id=? AND status='pending' ORDER BY position LIMIT 1`).get(jobId) as Row | undefined
    return row ? this.recipient(row) : undefined
  }

  /** Commits `pending` → `sending` before submission; false when another change won the row. */
  claim(jobId: string, position: number, at = nowIso()) {
    const job = this.jobRow(jobId)
    if (job?.status !== 'running') return false
    return this.transaction(() => {
      const claimed = Number(this.db.prepare(`UPDATE mail_merge_recipients SET status='sending', attempts=attempts+1, submitted_at=?, error=NULL, updated_at=? WHERE job_id=? AND position=? AND status='pending'`)
        .run(at, at, jobId, position).changes) === 1
      // The per-minute throttle spaces submissions, whatever their outcome.
      const next = new Date(Date.parse(at) + Math.ceil(60_000 / Math.max(1, Number(job.per_minute)))).toISOString()
      if (claimed) this.db.prepare('UPDATE mail_merge_jobs SET next_attempt_at=?, updated_at=? WHERE id=?').run(next, at, jobId)
      return claimed
    })
  }

  markSent(jobId: string, position: number, messageIdHeader: string | undefined, at = nowIso()) {
    this.transaction(() => {
      this.db.prepare(`UPDATE mail_merge_recipients SET status='sent', message_id_header=?, sent_at=?, error=NULL, updated_at=? WHERE job_id=? AND position=? AND status='sending'`)
        .run(messageIdHeader ?? null, at, at, jobId, position)
      const job = this.jobRow(jobId)
      if (!job) return
      this.db.prepare('INSERT INTO mail_merge_send_log(account_id,sent_at) VALUES(?,?)').run(String(job.account_id), at)
      this.db.prepare(`UPDATE mail_merge_jobs SET backoff_count=0, last_error=NULL, updated_at=? WHERE id=?`).run(at, jobId)
      this.refreshStatus(jobId, at)
    })
  }

  /** The provider refused this recipient; other recipients continue. */
  markFailed(jobId: string, position: number, error: string, at = nowIso()) {
    this.finishWith(jobId, position, 'failed', error, at)
  }

  /** The outcome is unknown; the job stops for review and this row is never retried automatically. */
  markAmbiguous(jobId: string, position: number, error: string, at = nowIso()) {
    this.finishWith(jobId, position, 'ambiguous', error, at)
  }

  private finishWith(jobId: string, position: number, status: 'failed' | 'ambiguous', error: string, at: string) {
    this.transaction(() => {
      this.db.prepare(`UPDATE mail_merge_recipients SET status=?, error=?, updated_at=? WHERE job_id=? AND position=? AND status='sending'`).run(status, error, at, jobId, position)
      this.refreshStatus(jobId, at)
    })
  }

  /**
   * Returns a recipient that was definitely not accepted to the queue, e.g.
   * after a rate-limit response. `pauseReason` stops the job instead of
   * retrying after `delayMs`.
   */
  requeue(jobId: string, position: number, error: string, options: { delayMs?: number; pauseReason?: string }, at = nowIso()) {
    this.transaction(() => {
      this.db.prepare(`UPDATE mail_merge_recipients SET status='pending', error=?, updated_at=? WHERE job_id=? AND position=? AND status='sending'`).run(error, at, jobId, position)
      if (options.pauseReason) {
        this.db.prepare(`UPDATE mail_merge_jobs SET status='paused', last_error=?, updated_at=? WHERE id=? AND status='running'`).run(options.pauseReason, at, jobId)
      } else {
        const next = new Date(Date.parse(at) + (options.delayMs ?? 60_000)).toISOString()
        this.db.prepare(`UPDATE mail_merge_jobs SET next_attempt_at=?, backoff_count=backoff_count+1, last_error=?, updated_at=? WHERE id=?`).run(next, error, at, jobId)
      }
      this.refreshStatus(jobId, at)
    })
  }

  backoffCount(jobId: string) {
    return Number(this.jobRow(jobId)?.backoff_count ?? 0)
  }

  /** Delays a job without touching recipients (daily cap reached). */
  defer(jobId: string, until: string, reason: string, at = nowIso()) {
    this.db.prepare(`UPDATE mail_merge_jobs SET next_attempt_at=?, last_error=?, updated_at=? WHERE id=? AND status='running'`).run(until, reason, at, jobId)
  }

  /** Accepted deliveries for an account since `since`, across all jobs (including deleted ones). */
  sentSince(accountId: string, since: string) {
    const row = this.db.prepare('SELECT COUNT(*) AS count, MIN(sent_at) AS oldest FROM mail_merge_send_log WHERE account_id=? AND sent_at>=?').get(accountId, since) as Row
    return { count: Number(row.count), oldest: optional(row.oldest) }
  }

  pruneSendLog(before: string) {
    this.db.prepare('DELETE FROM mail_merge_send_log WHERE sent_at<?').run(before)
  }

  /** Derives the job status from its recipients after any change. */
  private refreshStatus(jobId: string, at: string) {
    const job = this.jobRow(jobId)
    if (!job) return
    const status = String(job.status) as MailMergeJobStatus
    if (status === 'cancelled') return
    const counts = this.counts(jobId)
    let next: MailMergeJobStatus = status
    if (counts.ambiguous > 0) next = 'needs-review'
    else if (counts.pending === 0 && counts.sending === 0) next = 'completed'
    else if (status === 'needs-review' || status === 'completed') next = 'running'
    if (next !== status) this.db.prepare('UPDATE mail_merge_jobs SET status=?, updated_at=? WHERE id=?').run(next, at, jobId)
  }

  private requireJob(id: string) {
    const job = this.jobRow(id)
    if (!job) throw new Error('This mail merge no longer exists')
    return job
  }

  pause(id: string, at = nowIso()) {
    const job = this.requireJob(id)
    if (job.status === 'running') this.db.prepare(`UPDATE mail_merge_jobs SET status='paused', last_error=NULL, updated_at=? WHERE id=?`).run(at, id)
    return this.summary(id)!
  }

  resume(id: string, at = nowIso()) {
    const job = this.requireJob(id)
    if (job.status === 'paused') {
      this.transaction(() => {
        this.db.prepare(`UPDATE mail_merge_jobs SET status='running', last_error=NULL, backoff_count=0, next_attempt_at=?, updated_at=? WHERE id=?`).run(at, at, id)
        this.refreshStatus(id, at)
      })
    }
    return this.summary(id)!
  }

  /** Stops future deliveries. A delivery already handed to the provider still records its outcome. */
  cancel(id: string, at = nowIso()) {
    const job = this.requireJob(id)
    if (job.status === 'cancelled' || job.status === 'completed') return this.summary(id)!
    this.transaction(() => {
      this.db.prepare(`UPDATE mail_merge_recipients SET status='cancelled', updated_at=? WHERE job_id=? AND status='pending'`).run(at, id)
      this.db.prepare(`UPDATE mail_merge_jobs SET status='cancelled', updated_at=? WHERE id=?`).run(at, id)
    })
    return this.summary(id)!
  }

  /**
   * Review decisions. `resend` puts ambiguous or failed rows back in the queue
   * (the user accepts a possible duplicate); `skip` closes pending, ambiguous,
   * or failed rows without sending.
   */
  resolve(id: string, positions: number[], resolution: MailMergeResolution, at = nowIso()) {
    const job = this.requireJob(id)
    if (resolution === 'resend' && job.status === 'cancelled') throw new Error('This mail merge was cancelled; start a new one to send again')
    const allowed = resolution === 'resend' ? ['ambiguous', 'failed'] : ['pending', 'ambiguous', 'failed']
    this.transaction(() => {
      const update = this.db.prepare(`UPDATE mail_merge_recipients SET status=?, error=NULL, updated_at=? WHERE job_id=? AND position=? AND status IN (${allowed.map(() => '?').join(',')})`)
      for (const position of positions) update.run(resolution === 'resend' ? 'pending' : 'skipped', at, id, position, ...allowed)
      if (resolution === 'resend') this.db.prepare(`UPDATE mail_merge_jobs SET backoff_count=0, next_attempt_at=? WHERE id=?`).run(at, id)
      this.refreshStatus(id, at)
    })
    return this.get(id)!
  }

  /** Removes a finished or paused job; returns its attachment paths for cleanup. */
  delete(id: string) {
    const job = this.jobRow(id)
    if (!job) return []
    if (job.status === 'running' || this.counts(id).sending > 0) throw new Error('Pause or cancel this mail merge before deleting it')
    this.db.prepare('DELETE FROM mail_merge_jobs WHERE id=?').run(id)
    return json<string[]>(job.attachment_paths_json, [])
  }
}
