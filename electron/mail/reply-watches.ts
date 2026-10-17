import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { MailReplyWatch, MailReplyWatchStatus } from '../../src/mail-types'

interface DatabaseRow {
  [key: string]: string | number | bigint | null
}

/** A stored message reduced to the fields that decide whether it answers a watch. */
export interface ReplyCandidate {
  id: string
  threadId: string
  fromEmail: string
  fromName?: string
  headerMessageId?: string
  references: string[]
  labelIds: string[]
  internalDate: string
  subject?: string
}

export interface ReplyWatchAccount {
  email: string
  archived: boolean
  syncEnabled: boolean
  lastSyncAt?: string
}

export interface ReplyWatchEvent {
  watch: MailReplyWatch
  reason: 'replied' | 'expired'
}

// Provider and local clocks disagree slightly; a reply can't predate the send by more.
const CLOCK_SKEW_MS = 2 * 60_000
// Without a sync after the deadline a reply may still be on the server; wait this long before giving up.
const OFFLINE_EXPIRY_GRACE_MS = 24 * 60 * 60_000
const SENT_COPY_WINDOW_MS = 15 * 60_000
const SCAN_BATCH = 500

const nowIso = () => new Date().toISOString()
const json = <T>(value: string | number | bigint | null | undefined, fallback: T): T => {
  try {
    return typeof value === 'string' && value ? JSON.parse(value) as T : fallback
  } catch {
    return fallback
  }
}

export function normalizeMessageId(value?: string | null) {
  const trimmed = value?.trim().toLowerCase() ?? ''
  if (!trimmed) return ''
  return trimmed.startsWith('<') ? trimmed : `<${trimmed.replace(/>$/, '')}>`
}

export function addressEmail(value: string) {
  return (value.trim().match(/<([^<>]+)>\s*$/)?.[1] ?? value).trim().toLowerCase()
}

/** Reads the Message-ID header from a built MIME message (Buffer or Gmail base64url). */
export function messageIdFromMime(raw: Buffer | string) {
  const buffer = typeof raw === 'string' ? Buffer.from(raw, 'base64url') : raw
  const headers = buffer.subarray(0, 8_192).toString('utf8').split(/\r?\n\r?\n/, 1)[0]
  const match = headers.match(/^Message-ID:\s*(<[^>\r\n]+>)/im)
  return match ? match[1] : undefined
}

/**
 * Decides whether a stored message is a reply to the watched outgoing message.
 * A reference to the sent Message-ID is definitive; a shared thread only counts
 * for later mail from one of the original recipients, so unrelated mail that a
 * provider groups by subject does not end the watch.
 */
export function replyMatchesWatch(watch: Pick<MailReplyWatch, 'messageIdHeader' | 'threadId' | 'recipients' | 'sentAt'>, candidate: ReplyCandidate, ownEmail: string) {
  if (candidate.labelIds.includes('DRAFT') || candidate.labelIds.includes('SENT')) return false
  const sender = candidate.fromEmail.trim().toLowerCase()
  if (!sender || sender === ownEmail.trim().toLowerCase()) return false
  const watched = normalizeMessageId(watch.messageIdHeader)
  if (watched && normalizeMessageId(candidate.headerMessageId) === watched) return false
  if (watched && candidate.references.some((reference) => normalizeMessageId(reference) === watched)) return true
  if (!watch.threadId || candidate.threadId !== watch.threadId || !watch.sentAt) return false
  if (Date.parse(candidate.internalDate) < Date.parse(watch.sentAt) - CLOCK_SKEW_MS) return false
  return watch.recipients.some((recipient) => addressEmail(recipient) === sender)
}

/** Deadlines expire only once a sync has had the chance to deliver a reply. */
export function watchExpiryDue(watch: Pick<MailReplyWatch, 'deadlineAt' | 'status'>, account: ReplyWatchAccount | undefined, now = Date.now()) {
  if (watch.status !== 'watching' || !watch.deadlineAt) return false
  const deadline = Date.parse(watch.deadlineAt)
  if (!Number.isFinite(deadline) || deadline > now) return false
  if (!account || account.archived || !account.syncEnabled) return true
  const lastSync = account.lastSyncAt ? Date.parse(account.lastSyncAt) : 0
  return lastSync >= deadline || now - deadline >= OFFLINE_EXPIRY_GRACE_MS
}

/**
 * Persists outgoing reply watches beside the mail cache. Watches survive
 * restarts in SQLite and are evaluated against locally synced mail, so
 * offline periods are caught up on the next pass after synchronization.
 */
export class ReplyWatchStore {
  private statements = new Map<string, StatementSync>()

  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mail_reply_watches (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES gmail_accounts(id) ON DELETE CASCADE,
        draft_id TEXT,
        header_message_id TEXT,
        thread_id TEXT,
        sent_copy_id TEXT,
        subject TEXT NOT NULL DEFAULT '',
        recipients_json TEXT NOT NULL DEFAULT '[]',
        deadline_at TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        sent_at TEXT,
        scanned_rowid INTEGER NOT NULL DEFAULT 0,
        backfill INTEGER NOT NULL DEFAULT 0,
        reply_message_id TEXT,
        reply_thread_id TEXT,
        reply_from TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS mail_reply_watches_status ON mail_reply_watches(status, deadline_at);
      CREATE INDEX IF NOT EXISTS mail_reply_watches_draft ON mail_reply_watches(draft_id);
    `)
  }

  private stmt(sql: string) {
    const cached = this.statements.get(sql)
    if (cached) return cached
    const statement = this.db.prepare(sql)
    this.statements.set(sql, statement)
    return statement
  }

  private record(row: DatabaseRow): MailReplyWatch {
    const optional = (value: DatabaseRow[string]) => value === null || value === undefined ? undefined : String(value)
    return {
      id: String(row.id),
      accountId: String(row.account_id),
      draftId: optional(row.draft_id),
      messageIdHeader: optional(row.header_message_id),
      threadId: optional(row.thread_id),
      subject: String(row.subject ?? ''),
      recipients: json<string[]>(row.recipients_json, []),
      deadlineAt: optional(row.deadline_at),
      status: String(row.status) as MailReplyWatchStatus,
      createdAt: String(row.created_at),
      sentAt: optional(row.sent_at),
      resolvedAt: optional(row.resolved_at),
      replyMessageId: optional(row.reply_message_id),
      replyThreadId: optional(row.reply_thread_id),
      replyFrom: optional(row.reply_from)
    }
  }

  get(id: string) {
    const row = this.stmt('SELECT * FROM mail_reply_watches WHERE id=?').get(id) as DatabaseRow | undefined
    return row ? this.record(row) : undefined
  }

  /** Active watches first, then the most recent resolved ones for context. */
  list(accountIds?: string[]) {
    const where = accountIds?.length ? `WHERE account_id IN (${accountIds.map(() => '?').join(',')})` : ''
    const rows = this.db.prepare(`SELECT * FROM mail_reply_watches ${where}
      ORDER BY CASE WHEN status IN ('pending','watching') THEN 0 ELSE 1 END, COALESCE(resolved_at, created_at) DESC LIMIT 200`).all(...(accountIds ?? [])) as DatabaseRow[]
    return rows.map((row) => this.record(row))
  }

  private account(accountId: string): ReplyWatchAccount | undefined {
    const row = this.stmt('SELECT email,archived,sync_enabled,last_sync_at FROM gmail_accounts WHERE id=?').get(accountId) as DatabaseRow | undefined
    if (!row) return undefined
    return { email: String(row.email), archived: Boolean(row.archived), syncEnabled: Boolean(row.sync_enabled), lastSyncAt: row.last_sync_at ? String(row.last_sync_at) : undefined }
  }

  private maxRowid() {
    return Number((this.stmt('SELECT COALESCE(MAX(rowid),0) value FROM gmail_messages').get() as DatabaseRow).value)
  }

  private activeFor(column: 'draft_id' | 'header_message_id', accountId: string, value: string) {
    const row = this.stmt(`SELECT * FROM mail_reply_watches WHERE account_id=? AND ${column}=? AND status IN ('pending','watching') ORDER BY created_at DESC LIMIT 1`).get(accountId, value) as DatabaseRow | undefined
    return row ? this.record(row) : undefined
  }

  /** Watches an outgoing draft; it starts matching when the worker delivers it. */
  createForDraft(accountId: string, draftId: string, deadlineAt?: string) {
    const draft = this.stmt('SELECT * FROM gmail_drafts WHERE id=?').get(draftId) as DatabaseRow | undefined
    if (!draft || String(draft.account_id) !== accountId) throw new Error('The outgoing message was not found')
    if (!['send-pending', 'scheduled', 'queued', 'syncing'].includes(String(draft.status))) {
      throw new Error(String(draft.status) === 'sent' ? 'This message was already sent; watch it from the Sent folder instead' : 'Send or schedule this message before watching for replies')
    }
    const recipients = [...json<string[]>(draft.to_json, []), ...json<string[]>(draft.cc_json, []), ...json<string[]>(draft.bcc_json, [])]
    const existing = this.activeFor('draft_id', accountId, draftId)
    const timestamp = nowIso()
    if (existing) {
      this.stmt('UPDATE mail_reply_watches SET deadline_at=?,subject=?,recipients_json=?,updated_at=? WHERE id=?')
        .run(deadlineAt ?? null, String(draft.subject ?? ''), JSON.stringify(recipients), timestamp, existing.id)
      return this.get(existing.id)!
    }
    const id = crypto.randomUUID()
    this.stmt(`INSERT INTO mail_reply_watches(id,account_id,draft_id,thread_id,subject,recipients_json,deadline_at,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,'pending',?,?)`).run(id, accountId, draftId, draft.thread_id ? String(draft.thread_id) : null, String(draft.subject ?? ''), JSON.stringify(recipients), deadlineAt ?? null, timestamp, timestamp)
    return this.get(id)!
  }

  /** Watches a message already in the local Sent mail of this account. */
  createForMessage(accountId: string, messageId: string, deadlineAt?: string) {
    const message = this.stmt('SELECT rowid,* FROM gmail_messages WHERE account_id=? AND id=?').get(accountId, messageId) as DatabaseRow | undefined
    if (!message) throw new Error('The message is not available offline')
    const account = this.account(accountId)
    const labels = json<string[]>(message.label_ids_json, [])
    const fromSelf = account && String(message.from_email).trim().toLowerCase() === account.email.trim().toLowerCase()
    if (!labels.includes('SENT') && !fromSelf) throw new Error('Only messages you sent can be watched for replies')
    const header = message.header_message_id ? String(message.header_message_id) : ''
    if (!header) throw new Error('This message has no Message-ID, so replies cannot be matched')
    const recipients = [...json<string[]>(message.to_json, []), ...json<string[]>(message.cc_json, [])]
    const timestamp = nowIso()
    const existing = this.activeFor('header_message_id', accountId, header)
    if (existing) {
      this.stmt('UPDATE mail_reply_watches SET deadline_at=?,updated_at=? WHERE id=?').run(deadlineAt ?? null, timestamp, existing.id)
      return this.get(existing.id)!
    }
    const id = crypto.randomUUID()
    this.stmt(`INSERT INTO mail_reply_watches(id,account_id,header_message_id,thread_id,sent_copy_id,subject,recipients_json,deadline_at,status,sent_at,scanned_rowid,backfill,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,'watching',?,?,1,?,?)`).run(
      id, accountId, header, String(message.thread_id), messageId, String(message.subject ?? ''), JSON.stringify(recipients), deadlineAt ?? null,
      String(message.internal_date), Number(message.rowid), timestamp, timestamp
    )
    return this.get(id)!
  }

  cancel(id: string) {
    const timestamp = nowIso()
    return Number(this.stmt(`UPDATE mail_reply_watches SET status='cancelled',resolved_at=?,updated_at=? WHERE id=? AND status IN ('pending','watching')`).run(timestamp, timestamp, id).changes) > 0
  }

  /** Undoing or discarding the outgoing message also drops its pending watch. */
  cancelForDraft(draftId: string) {
    const timestamp = nowIso()
    return Number(this.stmt(`UPDATE mail_reply_watches SET status='cancelled',resolved_at=?,updated_at=? WHERE draft_id=? AND status='pending'`).run(timestamp, timestamp, draftId).changes)
  }

  /** Called after delivery with the Message-ID and provider thread the worker actually sent. */
  activateForDraft(draftId: string, sent: { messageIdHeader?: string; threadId?: string; sentAt?: string }) {
    const timestamp = nowIso()
    this.stmt(`UPDATE mail_reply_watches SET status='watching',header_message_id=?,thread_id=COALESCE(?,thread_id),sent_at=?,scanned_rowid=?,updated_at=?
      WHERE draft_id=? AND status='pending'`).run(sent.messageIdHeader ?? null, sent.threadId ?? null, sent.sentAt ?? timestamp, this.maxRowid(), timestamp, draftId)
  }

  private candidate(row: DatabaseRow): ReplyCandidate {
    return {
      id: String(row.id),
      threadId: String(row.thread_id),
      fromEmail: String(row.from_email ?? ''),
      fromName: String(row.from_name ?? ''),
      headerMessageId: row.header_message_id ? String(row.header_message_id) : undefined,
      references: json<string[]>(row.references_json, []),
      labelIds: json<string[]>(row.label_ids_json, []),
      internalDate: String(row.internal_date),
      subject: String(row.subject ?? '')
    }
  }

  private resolve(watch: MailReplyWatch, status: 'replied' | 'expired', reply?: ReplyCandidate) {
    const timestamp = nowIso()
    const changed = this.stmt(`UPDATE mail_reply_watches SET status=?,reply_message_id=?,reply_thread_id=?,reply_from=?,resolved_at=?,updated_at=? WHERE id=? AND status='watching'`)
      .run(status, reply?.id ?? null, reply?.threadId ?? null, reply ? (reply.fromName ? `${reply.fromName} <${reply.fromEmail}>` : reply.fromEmail) : null, timestamp, timestamp, watch.id)
    return Number(changed.changes) ? this.get(watch.id) : undefined
  }

  /**
   * Matches newly stored mail against active watches and expires overdue ones.
   * New rows are read incrementally by rowid, and the watched thread is always
   * rechecked through its index, so repeated passes stay cheap.
   */
  process(now = Date.now()): ReplyWatchEvent[] {
    const events: ReplyWatchEvent[] = []
    const pending = this.stmt(`SELECT w.id FROM mail_reply_watches w LEFT JOIN gmail_drafts d ON d.id=w.draft_id
      WHERE w.status='pending' AND (d.id IS NULL OR d.status IN ('local','discarded','discard-queued','discarding'))`).all() as DatabaseRow[]
    for (const row of pending) this.cancel(String(row.id))
    const watches = (this.stmt(`SELECT * FROM mail_reply_watches WHERE status='watching' ORDER BY created_at`).all() as DatabaseRow[])
    for (const row of watches) {
      let watch = this.record(row)
      const account = this.account(watch.accountId)
      if (!account) continue
      let scanned = Number(row.scanned_rowid)
      let sentCopyId = row.sent_copy_id ? String(row.sent_copy_id) : undefined
      const fresh = this.stmt(`SELECT rowid,* FROM gmail_messages WHERE rowid>? AND account_id=? ORDER BY rowid LIMIT ${SCAN_BATCH}`).all(scanned, watch.accountId) as DatabaseRow[]
      const candidates = new Map<string, ReplyCandidate>()
      for (const message of fresh) {
        scanned = Math.max(scanned, Number(message.rowid))
        const candidate = this.candidate(message)
        if (!sentCopyId && this.isSentCopy(watch, candidate)) {
          // Adopt the provider's Message-ID and thread for the delivered copy.
          sentCopyId = candidate.id
          watch = { ...watch, messageIdHeader: candidate.headerMessageId ?? watch.messageIdHeader, threadId: candidate.threadId }
          this.stmt('UPDATE mail_reply_watches SET sent_copy_id=?,header_message_id=?,thread_id=?,updated_at=? WHERE id=?')
            .run(candidate.id, watch.messageIdHeader ?? null, candidate.threadId, nowIso(), watch.id)
        }
        candidates.set(candidate.id, candidate)
      }
      if (fresh.length) this.stmt('UPDATE mail_reply_watches SET scanned_rowid=? WHERE id=?').run(scanned, watch.id)
      if (watch.threadId) {
        const threadRows = this.stmt('SELECT * FROM gmail_messages WHERE account_id=? AND thread_id=? ORDER BY internal_date').all(watch.accountId, watch.threadId) as DatabaseRow[]
        for (const message of threadRows) candidates.set(String(message.id), this.candidate(message))
      }
      if (Number(row.backfill)) {
        // Watches set on older sent mail also search earlier replies that reference it once.
        if (watch.messageIdHeader) {
          const referencing = this.stmt('SELECT * FROM gmail_messages WHERE account_id=? AND references_json LIKE ? LIMIT 50')
            .all(watch.accountId, `%${watch.messageIdHeader.replace(/^<|>$/g, '')}%`) as DatabaseRow[]
          for (const message of referencing) candidates.set(String(message.id), this.candidate(message))
        }
        this.stmt('UPDATE mail_reply_watches SET backfill=0 WHERE id=?').run(watch.id)
      }
      const reply = [...candidates.values()]
        .filter((candidate) => replyMatchesWatch(watch, candidate, account.email))
        .sort((left, right) => left.internalDate.localeCompare(right.internalDate))[0]
      const resolved = reply ? this.resolve(watch, 'replied', reply) : watchExpiryDue(watch, account, now) ? this.resolve(watch, 'expired') : undefined
      if (resolved) events.push({ watch: resolved, reason: reply ? 'replied' : 'expired' })
    }
    return events
  }

  private isSentCopy(watch: MailReplyWatch, candidate: ReplyCandidate) {
    const expected = normalizeMessageId(watch.messageIdHeader)
    if (expected) return normalizeMessageId(candidate.headerMessageId) === expected
    // Exchange may assign its own Message-ID, so match the Sent copy by subject and send time.
    if (!candidate.labelIds.includes('SENT') || !watch.sentAt) return false
    if ((candidate.subject ?? '').trim() !== watch.subject.trim()) return false
    return Math.abs(Date.parse(candidate.internalDate) - Date.parse(watch.sentAt)) <= SENT_COPY_WINDOW_MS
  }
}
