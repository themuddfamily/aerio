import type { DatabaseSync } from 'node:sqlite'
import type { MailLabel } from '../../src/mail-types'
import type {
  MailArchiveItem,
  MailArchiveItemState,
  MailArchiveJob,
  MailArchiveJobStatus,
  MailArchivePolicy,
  MailArchivePolicyInput,
  MailArchivePreview,
  MailArchiveRemoval
} from '../../src/mail-archive-types'
import { defaultMailArchivePolicy, mailArchiveCutoff, nextMailArchiveRun } from '../../src/lib/mail-archive'
import { mailFolderLeafName } from '../../src/lib/mail-folders'
import type { MailDatabase } from './database'

/**
 * Durable state for automatic archiving (E31): one policy per account, jobs
 * (one per run) and per-message items. Everything lives in the mail
 * database, so profile backups include it and deleting an account removes it.
 *
 * Server removal is queued in the normal provider operation queue
 * (gmail_operations) as a message-level operation: `message_ids_json` lists
 * the exact messages, so other messages of the same conversation are never
 * touched. Only verified copies are ever queued.
 */

type Row = Record<string, string | number | bigint | null>

const nowIso = () => new Date().toISOString()
const json = <T>(value: unknown, fallback: T): T => {
  try { return typeof value === 'string' && value ? JSON.parse(value) as T : fallback } catch { return fallback }
}

/** Items that still need work; a message in one of these is never added to another job. */
const ACTIVE_ITEM_STATES = `('pending','copied','removal-queued')`
const ACTIVE_JOB_STATES = `('running','paused')`
const HISTORY_LIMIT = 10
/** Ignore messages already in Trash or Spam; archiving them would preserve mail the user discarded. */
const IGNORED_LABELS = new Set(['TRASH', 'SPAM'])

export interface ArchiveCandidate {
  messageId: string
  threadId: string
  subject: string
  from: string
  receivedAt: string
  size: number
  rawPath: string
  labelIds: string[]
  remoteFolderId?: string
  headerMessageId?: string
  /** Folder names below the policy destination, outermost first. */
  segments: string[]
  /** Source folder display name. */
  folder: string
}

export interface StoredArchiveItem extends MailArchiveItem {
  segments: string[]
  sha256?: string
  localMessageId?: string
  operationId?: string
}

export interface ArchiveSelection {
  cutoff: Date
  eligible: ArchiveCandidate[]
  excluded: MailArchivePreview['excluded']
}

function inFolder(labelIds: string[], remoteFolderId: string | undefined, folderId: string) {
  return labelIds.includes(folderId) || (folderId.startsWith('folder:') && remoteFolderId === folderId.slice(7))
}

/** Folder path segments of a label, outermost first, using the parent chain when the provider reports one. */
export function labelSegments(label: MailLabel, labels: MailLabel[]) {
  const segments: string[] = []
  let current: MailLabel | undefined = label
  const seen = new Set<string>()
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    const parent: MailLabel | undefined = current.parentId ? labels.find((item) => item.id === current!.parentId) : undefined
    segments.unshift(parent ? mailFolderLeafName(current, labels) : current.name)
    current = parent
  }
  // Gmail nests labels by name ("Projects/2024") without parent ids.
  return segments.length === 1 && !label.parentId ? label.name.split('/').filter(Boolean) : segments
}

const SYSTEM_NAMES: Record<string, string> = { INBOX: 'Inbox', SENT: 'Sent', DRAFT: 'Drafts', ARCHIVE: 'Archive', IMPORTANT: 'Important', STARRED: 'Starred' }

export class MailArchiveStore {
  constructor(private readonly db: DatabaseSync, private readonly mail: MailDatabase) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mail_archive_policies (
        account_id TEXT PRIMARY KEY REFERENCES gmail_accounts(id) ON DELETE CASCADE,
        policy_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        last_run_at TEXT,
        last_run_status TEXT,
        last_error TEXT,
        next_run_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mail_archive_jobs (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES gmail_accounts(id) ON DELETE CASCADE,
        trigger TEXT NOT NULL,
        status TEXT NOT NULL,
        cutoff TEXT NOT NULL,
        removal TEXT NOT NULL,
        policy_json TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS mail_archive_jobs_account ON mail_archive_jobs(account_id, status);
      CREATE TABLE IF NOT EXISTS mail_archive_items (
        job_id TEXT NOT NULL REFERENCES mail_archive_jobs(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        subject TEXT NOT NULL DEFAULT '',
        from_text TEXT NOT NULL DEFAULT '',
        received_at TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        segments_json TEXT NOT NULL DEFAULT '[]',
        state TEXT NOT NULL,
        reason TEXT,
        sha256 TEXT,
        destination_label_id TEXT,
        local_message_id TEXT,
        operation_id TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (job_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS mail_archive_items_state ON mail_archive_items(job_id, state);
      CREATE INDEX IF NOT EXISTS mail_archive_items_message ON mail_archive_items(account_id, message_id, state);
      CREATE INDEX IF NOT EXISTS mail_archive_items_operation ON mail_archive_items(operation_id);
    `)
    const operationColumns = new Set((this.db.prepare('PRAGMA table_info(gmail_operations)').all() as { name: string }[]).map((column) => column.name))
    if (!operationColumns.has('message_ids_json')) this.db.exec('ALTER TABLE gmail_operations ADD COLUMN message_ids_json TEXT')
    if (!operationColumns.has('archive_removal')) this.db.exec('ALTER TABLE gmail_operations ADD COLUMN archive_removal TEXT')
  }

  // ---- Policies -----------------------------------------------------------

  private policyFromRow(row: Row): MailArchivePolicy {
    const accountId = String(row.account_id)
    const stored = json<Partial<MailArchivePolicyInput>>(row.policy_json, {})
    const defaults = defaultMailArchivePolicy(accountId)
    return {
      ...defaults,
      ...stored,
      exclude: { ...defaults.exclude, ...stored.exclude },
      subfolders: { ...defaults.subfolders, ...stored.subfolders },
      accountId,
      enabled: Boolean(row.enabled),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      ...(row.last_run_at ? { lastRunAt: String(row.last_run_at) } : {}),
      ...(row.last_run_status ? { lastRunStatus: String(row.last_run_status) as MailArchiveJobStatus } : {}),
      ...(row.last_error ? { lastError: String(row.last_error) } : {}),
      ...(row.next_run_at && row.enabled ? { nextRunAt: String(row.next_run_at) } : {})
    }
  }

  policy(accountId: string) {
    const row = this.db.prepare('SELECT * FROM mail_archive_policies WHERE account_id=?').get(accountId) as Row | undefined
    return row ? this.policyFromRow(row) : undefined
  }

  /**
   * Saves a policy. Turning it on (or changing its frequency) schedules the
   * next run: immediately for a newly enabled policy, otherwise one period
   * after the last run.
   */
  savePolicy(input: MailArchivePolicyInput, now = new Date()): MailArchivePolicy {
    const existing = this.policy(input.accountId)
    const timestamp = now.toISOString()
    let nextRunAt: string | null = null
    if (input.enabled) {
      nextRunAt = existing?.lastRunAt
        ? nextMailArchiveRun(new Date(existing.lastRunAt), input.frequency).toISOString()
        : timestamp
    }
    const { accountId, enabled, ...policy } = input
    this.db.prepare(`
      INSERT INTO mail_archive_policies(account_id,policy_json,enabled,next_run_at,created_at,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(account_id) DO UPDATE SET policy_json=excluded.policy_json,enabled=excluded.enabled,next_run_at=excluded.next_run_at,updated_at=excluded.updated_at
    `).run(accountId, JSON.stringify(policy), enabled ? 1 : 0, nextRunAt, timestamp, timestamp)
    return this.policy(accountId)!
  }

  duePolicies(now = new Date()) {
    return (this.db.prepare(`
      SELECT p.* FROM mail_archive_policies p JOIN gmail_accounts a ON a.id=p.account_id
      WHERE p.enabled=1 AND a.archived=0 AND a.provider<>'local' AND p.next_run_at IS NOT NULL AND p.next_run_at<=?
    `).all(now.toISOString()) as Row[]).map((row) => this.policyFromRow(row))
  }

  recordRunStart(accountId: string, frequency: MailArchivePolicy['frequency'], now = new Date()) {
    this.db.prepare('UPDATE mail_archive_policies SET last_run_at=?,last_run_status=?,last_error=NULL,next_run_at=CASE WHEN enabled=1 THEN ? ELSE NULL END WHERE account_id=?')
      .run(now.toISOString(), 'running', nextMailArchiveRun(now, frequency).toISOString(), accountId)
  }

  recordRunOutcome(accountId: string, status: MailArchiveJobStatus, error?: string) {
    this.db.prepare('UPDATE mail_archive_policies SET last_run_status=?,last_error=? WHERE account_id=?').run(status, error ?? null, accountId)
  }

  // ---- Selection ------------------------------------------------------------

  private activeMessageIds(accountId: string) {
    return new Set((this.db.prepare(`SELECT message_id FROM mail_archive_items WHERE account_id=? AND state IN ${ACTIVE_ITEM_STATES}`).all(accountId) as Row[]).map((row) => String(row.message_id)))
  }

  /** Path below the destination folder for one message; also used for its display name. */
  private placement(policy: MailArchivePolicyInput, provider: string, email: string, labels: MailLabel[], candidate: { labelIds: string[]; remoteFolderId?: string; receivedAt: string }) {
    let source: MailLabel | undefined
    if (policy.scope === 'folders') {
      const id = policy.folderIds.find((folderId) => inFolder(candidate.labelIds, candidate.remoteFolderId, folderId))
      source = labels.find((label) => label.id === id)
    } else if (provider === 'gmail') {
      source = labels.find((label) => label.type === 'user' && candidate.labelIds.includes(label.id))
    } else {
      source = labels.find((label) => label.id === `folder:${candidate.remoteFolderId}`)
        ?? labels.find((label) => label.id.startsWith('folder:') && candidate.labelIds.includes(label.id))
    }
    const systemName = Object.keys(SYSTEM_NAMES).find((label) => candidate.labelIds.includes(label))
    const sourceSegments = source ? labelSegments(source, labels) : [systemName ? SYSTEM_NAMES[systemName] : 'All Mail']
    const segments: string[] = []
    if (policy.subfolders.perAccount) segments.push(email)
    if (policy.subfolders.perYear) segments.push(String(new Date(candidate.receivedAt).getUTCFullYear()))
    if (policy.subfolders.mirrorSourcePath) segments.push(...sourceSegments)
    return { segments, folder: sourceSegments.join('/') }
  }

  /**
   * Chooses the messages a policy archives right now. Selection is per
   * message by received date, so a conversation with newer replies keeps
   * them; a pinned conversation is kept whole.
   */
  select(policy: MailArchivePolicyInput, now = new Date()): ArchiveSelection {
    const account = this.mail.getAccount(policy.accountId)
    if (!account) throw new Error('Account not found')
    const cutoff = mailArchiveCutoff(policy, now)
    const labels = this.mail.listLabels([policy.accountId])
    const active = this.activeMessageIds(policy.accountId)
    const excluded: MailArchivePreview['excluded'] = { starred: 0, unread: 0, pinned: 0, drafts: 0, sent: 0, folders: 0, notDownloaded: 0, inOtherJob: 0 }
    const eligible: ArchiveCandidate[] = []
    // ISO strings with and without milliseconds compare slightly differently; the
    // one-day margin keeps SQL's prefilter safe and Date.parse decides exactly.
    const margin = new Date(cutoff.getTime() + 24 * 60 * 60_000).toISOString()
    const rows = this.db.prepare(`
      SELECT id,thread_id,subject,from_name,from_email,internal_date,size_estimate,raw_path,label_ids_json,remote_folder_id,header_message_id
      FROM gmail_messages WHERE account_id=? AND internal_date<? ORDER BY internal_date,id
    `).all(policy.accountId, margin) as Row[]
    const pinned = new Map<string, boolean>()
    for (const row of rows) {
      const receivedAt = String(row.internal_date)
      const received = Date.parse(receivedAt)
      if (!Number.isFinite(received) || received >= cutoff.getTime()) continue
      const labelIds = json<string[]>(row.label_ids_json, [])
      const remoteFolderId = row.remote_folder_id ? String(row.remote_folder_id) : undefined
      if (labelIds.some((label) => IGNORED_LABELS.has(label))) continue
      if (policy.scope === 'folders' && !policy.folderIds.some((folderId) => inFolder(labelIds, remoteFolderId, folderId))) continue
      if (policy.exclude.folderIds.some((folderId) => inFolder(labelIds, remoteFolderId, folderId))) { excluded.folders += 1; continue }
      if (policy.exclude.drafts && labelIds.includes('DRAFT')) { excluded.drafts += 1; continue }
      if (policy.exclude.sent && labelIds.includes('SENT')) { excluded.sent += 1; continue }
      if (policy.exclude.starred && labelIds.includes('STARRED')) { excluded.starred += 1; continue }
      if (policy.exclude.unread && labelIds.includes('UNREAD')) { excluded.unread += 1; continue }
      const threadId = String(row.thread_id)
      if (policy.exclude.pinned) {
        if (!pinned.has(threadId)) pinned.set(threadId, Boolean(this.mail.pins.pinnedAt(policy.accountId, threadId)))
        if (pinned.get(threadId)) { excluded.pinned += 1; continue }
      }
      const rawPath = String(row.raw_path)
      if (!this.mail.rawExists(rawPath)) { excluded.notDownloaded += 1; continue }
      const messageId = String(row.id)
      if (active.has(messageId)) { excluded.inOtherJob += 1; continue }
      const { segments, folder } = this.placement(policy, account.provider, account.email, labels, { labelIds, remoteFolderId, receivedAt })
      eligible.push({
        messageId,
        threadId,
        subject: String(row.subject || '(No subject)'),
        from: String(row.from_name || row.from_email || ''),
        receivedAt,
        size: Number(row.size_estimate ?? 0),
        rawPath,
        labelIds,
        ...(remoteFolderId ? { remoteFolderId } : {}),
        ...(row.header_message_id ? { headerMessageId: String(row.header_message_id) } : {}),
        segments,
        folder
      })
    }
    return { cutoff, eligible, excluded }
  }

  /** Re-checks one message right before it is copied; returns why it is no longer eligible. */
  stillEligible(policy: MailArchivePolicyInput, messageId: string, cutoff: string) {
    const row = this.db.prepare('SELECT thread_id,internal_date,label_ids_json,remote_folder_id,raw_path FROM gmail_messages WHERE account_id=? AND id=?').get(policy.accountId, messageId) as Row | undefined
    if (!row) return 'The message is no longer in this account'
    const labelIds = json<string[]>(row.label_ids_json, [])
    const remoteFolderId = row.remote_folder_id ? String(row.remote_folder_id) : undefined
    if (Date.parse(String(row.internal_date)) >= Date.parse(cutoff)) return 'The message is newer than the cutoff'
    if (labelIds.some((label) => IGNORED_LABELS.has(label))) return 'The message was moved to Trash or Spam'
    if (policy.exclude.folderIds.some((folderId) => inFolder(labelIds, remoteFolderId, folderId))) return 'The message is now in an excluded folder'
    if (policy.exclude.starred && labelIds.includes('STARRED')) return 'The message was starred or flagged'
    if (policy.exclude.unread && labelIds.includes('UNREAD')) return 'The message was marked unread'
    if (policy.exclude.pinned && this.mail.pins.pinnedAt(policy.accountId, String(row.thread_id))) return 'The conversation was pinned'
    if (!this.mail.rawExists(String(row.raw_path))) return 'The original message is not stored offline'
    return undefined
  }

  // ---- Jobs -------------------------------------------------------------------

  createJob(input: { accountId: string; trigger: MailArchiveJob['trigger']; policy: MailArchivePolicyInput; candidates: ArchiveCandidate[]; cutoff: Date; now?: Date }) {
    const id = crypto.randomUUID()
    const timestamp = (input.now ?? new Date()).toISOString()
    const insertItem = this.db.prepare(`
      INSERT OR IGNORE INTO mail_archive_items(job_id,account_id,message_id,thread_id,subject,from_text,received_at,size,segments_json,state,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,'pending',?)
    `)
    this.mail.transaction(() => {
      this.db.prepare(`INSERT INTO mail_archive_jobs(id,account_id,trigger,status,cutoff,removal,policy_json,created_at,updated_at) VALUES(?,?,?,'running',?,?,?,?,?)`)
        .run(id, input.accountId, input.trigger, input.cutoff.toISOString(), input.policy.removal, JSON.stringify(input.policy), timestamp, timestamp)
      for (const item of input.candidates) {
        insertItem.run(id, input.accountId, item.messageId, item.threadId, item.subject, item.from, item.receivedAt, item.size, JSON.stringify(item.segments), timestamp)
      }
    })
    return this.job(id)!
  }

  private jobFromRow(row: Row): MailArchiveJob {
    const counts = Object.fromEntries((this.db.prepare('SELECT state,COUNT(*) count,SUM(size) bytes FROM mail_archive_items WHERE job_id=? GROUP BY state').all(String(row.id)) as Row[])
      .map((item) => [String(item.state), { count: Number(item.count), bytes: Number(item.bytes ?? 0) }])) as Partial<Record<MailArchiveItemState, { count: number; bytes: number }>>
    const count = (state: MailArchiveItemState) => counts[state]?.count ?? 0
    return {
      id: String(row.id),
      accountId: String(row.account_id),
      trigger: String(row.trigger) as MailArchiveJob['trigger'],
      status: String(row.status) as MailArchiveJobStatus,
      cutoff: String(row.cutoff),
      removal: String(row.removal) as MailArchiveRemoval,
      total: Object.values(counts).reduce((sum, item) => sum + (item?.count ?? 0), 0),
      pending: count('pending'),
      copied: count('copied'),
      removalQueued: count('removal-queued'),
      done: count('done'),
      failed: count('failed'),
      skipped: count('skipped'),
      bytes: counts.done?.bytes ?? 0,
      ...(row.error ? { error: String(row.error) } : {}),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      ...(row.finished_at ? { finishedAt: String(row.finished_at) } : {})
    }
  }

  job(id: string) {
    const row = this.db.prepare('SELECT * FROM mail_archive_jobs WHERE id=?').get(id) as Row | undefined
    return row ? this.jobFromRow(row) : undefined
  }

  jobPolicy(id: string) {
    const row = this.db.prepare('SELECT account_id,policy_json FROM mail_archive_jobs WHERE id=?').get(id) as Row | undefined
    if (!row) return undefined
    const accountId = String(row.account_id)
    return { ...defaultMailArchivePolicy(accountId), ...json<Partial<MailArchivePolicyInput>>(row.policy_json, {}), accountId }
  }

  jobs(accountId: string, limit = HISTORY_LIMIT) {
    return (this.db.prepare('SELECT * FROM mail_archive_jobs WHERE account_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?').all(accountId, limit) as Row[]).map((row) => this.jobFromRow(row))
  }

  activeJob(accountId: string) {
    const row = this.db.prepare(`SELECT * FROM mail_archive_jobs WHERE account_id=? AND status IN ${ACTIVE_JOB_STATES} ORDER BY created_at,rowid LIMIT 1`).get(accountId) as Row | undefined
    return row ? this.jobFromRow(row) : undefined
  }

  runningJobIds() {
    return (this.db.prepare(`SELECT id FROM mail_archive_jobs WHERE status='running' ORDER BY created_at,rowid`).all() as Row[]).map((row) => String(row.id))
  }

  setJobStatus(id: string, status: MailArchiveJobStatus, error?: string) {
    const finished = status === 'completed' || status === 'cancelled' || status === 'failed'
    this.db.prepare('UPDATE mail_archive_jobs SET status=?,error=?,updated_at=?,finished_at=? WHERE id=?').run(status, error ?? null, nowIso(), finished ? nowIso() : null, id)
    const job = this.job(id)!
    if (finished || status === 'paused') this.recordRunOutcome(job.accountId, status, error)
    return job
  }

  /** Keeps the newest jobs of an account; older finished jobs and their items are removed. */
  pruneHistory(accountId: string, keep = HISTORY_LIMIT) {
    this.db.prepare(`
      DELETE FROM mail_archive_jobs WHERE account_id=? AND status NOT IN ${ACTIVE_JOB_STATES}
        AND id NOT IN (SELECT id FROM mail_archive_jobs WHERE account_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?)
        AND NOT EXISTS (SELECT 1 FROM mail_archive_items i WHERE i.job_id=mail_archive_jobs.id AND i.state IN ${ACTIVE_ITEM_STATES})
    `).run(accountId, accountId, keep)
  }

  // ---- Items ------------------------------------------------------------------

  private itemFromRow(row: Row): StoredArchiveItem {
    return {
      jobId: String(row.job_id),
      messageId: String(row.message_id),
      threadId: String(row.thread_id),
      subject: String(row.subject),
      from: String(row.from_text),
      receivedAt: String(row.received_at),
      size: Number(row.size),
      state: String(row.state) as MailArchiveItemState,
      ...(row.reason ? { reason: String(row.reason) } : {}),
      ...(row.destination_label_id ? { destinationLabelId: String(row.destination_label_id) } : {}),
      segments: json<string[]>(row.segments_json, []),
      ...(row.sha256 ? { sha256: String(row.sha256) } : {}),
      ...(row.local_message_id ? { localMessageId: String(row.local_message_id) } : {}),
      ...(row.operation_id ? { operationId: String(row.operation_id) } : {})
    }
  }

  items(jobId: string, states?: MailArchiveItemState[], limit = 2_000): StoredArchiveItem[] {
    const filter = states?.length ? `AND state IN (${states.map(() => '?').join(',')})` : ''
    const order = states?.length ? 'received_at,message_id' : `CASE state WHEN 'failed' THEN 0 WHEN 'removal-queued' THEN 1 WHEN 'copied' THEN 2 WHEN 'pending' THEN 3 ELSE 4 END,received_at,message_id`
    return (this.db.prepare(`SELECT * FROM mail_archive_items WHERE job_id=? ${filter} ORDER BY ${order} LIMIT ?`).all(jobId, ...(states ?? []), limit) as Row[]).map((row) => this.itemFromRow(row))
  }

  markCopied(jobId: string, messageId: string, copy: { sha256: string; destinationLabelId: string; localMessageId: string }) {
    this.db.prepare(`UPDATE mail_archive_items SET state='copied',reason=NULL,sha256=?,destination_label_id=?,local_message_id=?,updated_at=? WHERE job_id=? AND message_id=?`)
      .run(copy.sha256, copy.destinationLabelId, copy.localMessageId, nowIso(), jobId, messageId)
  }

  setItemState(jobId: string, messageId: string, state: MailArchiveItemState, reason?: string) {
    this.db.prepare('UPDATE mail_archive_items SET state=?,reason=?,updated_at=? WHERE job_id=? AND message_id=?').run(state, reason ?? null, nowIso(), jobId, messageId)
  }

  /** Ends every item of a job that has not reached the server-removal queue. */
  settleUnqueued(jobId: string, reason: string) {
    this.db.prepare(`UPDATE mail_archive_items SET state='skipped',reason=?,updated_at=? WHERE job_id=? AND state IN ('pending','copied')`).run(reason, nowIso(), jobId)
  }

  attachmentCount(accountId: string, messageId: string) {
    return Number((this.db.prepare('SELECT COUNT(*) count FROM gmail_attachments WHERE account_id=? AND message_id=?').get(accountId, messageId) as Row).count)
  }

  /**
   * Queues message-level server removal for verified copies. The messages are
   * hidden locally (marked Trash) in the same transaction that records the
   * operation, so a crash can never leave a queued removal without its items.
   * If the provider keeps rejecting it, the operation queue restores the
   * labels and the item is reported as failed with the server copy kept.
   */
  queueRemoval(jobId: string, accountId: string, removal: MailArchiveRemoval, items: StoredArchiveItem[]) {
    if (!items.length) return undefined
    const operationId = crypto.randomUUID()
    const timestamp = nowIso()
    const beforeLabels: Record<string, string[]> = {}
    const threadIds = new Set<string>()
    this.mail.transaction(() => {
      for (const item of items) {
        const row = this.db.prepare('SELECT thread_id,history_id,label_ids_json FROM gmail_messages WHERE account_id=? AND id=?').get(accountId, item.messageId) as Row | undefined
        if (!row) continue
        const labels = json<string[]>(row.label_ids_json, [])
        beforeLabels[item.messageId] = labels
        threadIds.add(String(row.thread_id))
        this.mail.updateMessageLabels(accountId, item.messageId, [...new Set([...labels, 'TRASH'])], String(row.history_id))
      }
      this.db.prepare(`
        INSERT INTO gmail_operations(id,account_id,thread_ids_json,kind,label_id,inverse_kind,status,execute_after,undo_until,created_at,updated_at,before_labels_json,message_ids_json,archive_removal)
        VALUES(?,?,?,'trash',NULL,'untrash','queued',?,?,?,?,?,?,?)
      `).run(operationId, accountId, JSON.stringify([...threadIds]), timestamp, timestamp, timestamp, timestamp, JSON.stringify(beforeLabels), JSON.stringify(items.map((item) => item.messageId)), removal)
      const update = this.db.prepare(`UPDATE mail_archive_items SET state='removal-queued',operation_id=?,updated_at=? WHERE job_id=? AND message_id=?`)
      for (const item of items) update.run(operationId, timestamp, jobId, item.messageId)
    })
    return { id: operationId, accountId, threadIds: [...threadIds] }
  }

  /** Message-level removal details for an operation row, or undefined for ordinary thread operations. */
  removalFor(row: Row) {
    if (!row.message_ids_json) return undefined
    const accountId = String(row.account_id)
    const ids = json<string[]>(row.message_ids_json, [])
    const messages = ids.flatMap((id) => {
      const message = this.db.prepare('SELECT id,remote_folder_id,remote_uid FROM gmail_messages WHERE account_id=? AND id=?').get(accountId, id) as Row | undefined
      return message ? [{ id, ...(message.remote_folder_id ? { remoteFolderId: String(message.remote_folder_id) } : {}), ...(message.remote_uid ? { remoteUid: String(message.remote_uid) } : {}) }] : []
    })
    return { accountId, mode: (String(row.archive_removal ?? 'trash') === 'delete' ? 'delete' : 'trash') as MailArchiveRemoval, messages }
  }

  /**
   * Moves removal-queued items forward from their operation's outcome. Returns
   * the jobs that changed and messages whose permanent deletion succeeded (so
   * their cached copies can be removed).
   */
  reconcileRemovals() {
    const rows = this.db.prepare(`
      SELECT i.job_id,i.account_id,i.message_id,i.operation_id,o.status op_status,o.error op_error,o.archive_removal
      FROM mail_archive_items i LEFT JOIN gmail_operations o ON o.id=i.operation_id
      WHERE i.state='removal-queued'
    `).all() as Row[]
    const changed = new Set<string>()
    const deleted: { accountId: string; messageId: string }[] = []
    for (const row of rows) {
      const jobId = String(row.job_id)
      const status = row.op_status === null ? 'missing' : String(row.op_status)
      if (status === 'queued' || status === 'running') continue
      if (status === 'succeeded') {
        this.setItemState(jobId, String(row.message_id), 'done')
        if (row.archive_removal === 'delete') deleted.push({ accountId: String(row.account_id), messageId: String(row.message_id) })
      } else if (status === 'cancelled') {
        this.setItemState(jobId, String(row.message_id), 'failed', 'Server removal was undone. The server copy and the Local Folders copy were both kept.')
      } else {
        const error = row.op_error ? String(row.op_error) : 'The server removal could not be completed'
        this.setItemState(jobId, String(row.message_id), 'failed', `${error}. The server copy was kept; the Local Folders copy remains.`)
      }
      changed.add(jobId)
    }
    return { changed: [...changed], deleted }
  }

  /** Marks a running job finished once none of its items need more work. */
  completeIfSettled(jobId: string) {
    const job = this.job(jobId)
    if (!job || job.status !== 'running' || job.pending || job.copied || job.removalQueued) return undefined
    return this.setJobStatus(jobId, 'completed', job.failed ? `${job.failed.toLocaleString()} message${job.failed === 1 ? '' : 's'} could not be archived` : undefined)
  }
}
