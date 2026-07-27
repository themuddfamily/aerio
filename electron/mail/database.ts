import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  ApplyMailActionInput,
  GmailAccountSummary,
  GmailAttachment,
  GmailDraftInput,
  GmailDraftResult,
  GmailLabel,
  GmailMessageDetail,
  GmailThreadDetail,
  MailActionKind,
  MailPage,
  MailQuery,
  MailStorageStats,
  PendingOperation,
  SyncProgress
} from '../../src/gmail-types'

export interface ParsedMailMessage {
  accountId: string
  id: string
  threadId: string
  historyId: string
  internalDate: string
  fromName: string
  fromEmail: string
  to: string[]
  cc: string[]
  subject: string
  messageIdHeader?: string
  references: string[]
  snippet: string
  text: string
  html: string
  labelIds: string[]
  sizeEstimate: number
  rawPath: string
  attachments: GmailAttachment[]
}

interface DatabaseRow {
  [key: string]: string | number | bigint | null
}

const nowIso = () => new Date().toISOString()
const json = <T>(value: string | null | undefined, fallback: T): T => {
  try {
    return value ? JSON.parse(value) as T : fallback
  } catch {
    return fallback
  }
}

export class MailDatabase {
  readonly contentPath: string
  private readonly db: DatabaseSync
  private statements = new Map<string, StatementSync>()

  constructor(databasePath: string, contentPath: string) {
    mkdirSync(dirname(databasePath), { recursive: true })
    mkdirSync(contentPath, { recursive: true })
    const backupPath = `${databasePath}.v0.1.bak`
    if (existsSync(databasePath) && !existsSync(backupPath)) copyFileSync(databasePath, backupPath)
    this.contentPath = contentPath
    this.db = new DatabaseSync(databasePath, { timeout: 5_000 })
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;')
    this.migrate()
  }

  close() {
    this.db.close()
  }

  private stmt(sql: string) {
    const cached = this.statements.get(sql)
    if (cached) return cached
    const statement = this.db.prepare(sql)
    this.statements.set(sql, statement)
    return statement
  }

  transaction<T>(callback: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = callback()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS gmail_accounts (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        avatar_url TEXT,
        color TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'connecting',
        archived INTEGER NOT NULL DEFAULT 0,
        history_id TEXT,
        last_sync_at TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS gmail_labels (
        account_id TEXT NOT NULL REFERENCES gmail_accounts(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        color TEXT,
        PRIMARY KEY (account_id, id)
      );

      CREATE TABLE IF NOT EXISTS gmail_threads (
        account_id TEXT NOT NULL REFERENCES gmail_accounts(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        subject TEXT NOT NULL,
        participants_json TEXT NOT NULL DEFAULT '[]',
        snippet TEXT NOT NULL DEFAULT '',
        last_date TEXT NOT NULL,
        unread INTEGER NOT NULL DEFAULT 0,
        starred INTEGER NOT NULL DEFAULT 0,
        important INTEGER NOT NULL DEFAULT 0,
        trashed INTEGER NOT NULL DEFAULT 0,
        draft INTEGER NOT NULL DEFAULT 0,
        sent INTEGER NOT NULL DEFAULT 0,
        inbox INTEGER NOT NULL DEFAULT 0,
        has_attachments INTEGER NOT NULL DEFAULT 0,
        message_count INTEGER NOT NULL DEFAULT 0,
        label_ids_json TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (account_id, id)
      );
      CREATE INDEX IF NOT EXISTS gmail_threads_date ON gmail_threads(last_date DESC, id DESC);
      CREATE INDEX IF NOT EXISTS gmail_threads_account_date ON gmail_threads(account_id, last_date DESC);

      CREATE TABLE IF NOT EXISTS gmail_messages (
        account_id TEXT NOT NULL REFERENCES gmail_accounts(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        history_id TEXT NOT NULL,
        internal_date TEXT NOT NULL,
        from_name TEXT NOT NULL DEFAULT '',
        from_email TEXT NOT NULL DEFAULT '',
        to_json TEXT NOT NULL DEFAULT '[]',
        cc_json TEXT NOT NULL DEFAULT '[]',
        subject TEXT NOT NULL DEFAULT '',
        header_message_id TEXT,
        references_json TEXT NOT NULL DEFAULT '[]',
        snippet TEXT NOT NULL DEFAULT '',
        body_text TEXT NOT NULL DEFAULT '',
        body_html TEXT NOT NULL DEFAULT '',
        label_ids_json TEXT NOT NULL DEFAULT '[]',
        size_estimate INTEGER NOT NULL DEFAULT 0,
        raw_path TEXT NOT NULL,
        PRIMARY KEY (account_id, id),
        FOREIGN KEY (account_id, thread_id) REFERENCES gmail_threads(account_id, id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS gmail_messages_thread ON gmail_messages(account_id, thread_id, internal_date);

      CREATE TABLE IF NOT EXISTS gmail_attachments (
        account_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        id TEXT NOT NULL,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        content_id TEXT,
        PRIMARY KEY (account_id, message_id, id),
        FOREIGN KEY (account_id, message_id) REFERENCES gmail_messages(account_id, id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS gmail_sync_items (
        account_id TEXT NOT NULL REFERENCES gmail_accounts(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        PRIMARY KEY (account_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS gmail_sync_pending ON gmail_sync_items(account_id, status, message_id);

      CREATE TABLE IF NOT EXISTS gmail_sync_state (
        account_id TEXT PRIMARY KEY REFERENCES gmail_accounts(id) ON DELETE CASCADE,
        phase TEXT NOT NULL DEFAULT 'idle',
        completed INTEGER NOT NULL DEFAULT 0,
        total INTEGER NOT NULL DEFAULT 0,
        transferred_bytes INTEGER NOT NULL DEFAULT 0,
        started_at TEXT,
        updated_at TEXT NOT NULL,
        page_token TEXT,
        initial_history_id TEXT,
        paused_reason TEXT,
        message TEXT
      );

      CREATE TABLE IF NOT EXISTS gmail_operations (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES gmail_accounts(id) ON DELETE CASCADE,
        thread_ids_json TEXT NOT NULL,
        kind TEXT NOT NULL,
        label_id TEXT,
        inverse_kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0,
        execute_after TEXT NOT NULL,
        undo_until TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS gmail_operations_due ON gmail_operations(status, execute_after);

      CREATE TABLE IF NOT EXISTS gmail_drafts (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES gmail_accounts(id) ON DELETE CASCADE,
        gmail_draft_id TEXT,
        thread_id TEXT,
        in_reply_to TEXT,
        references_json TEXT NOT NULL DEFAULT '[]',
        to_json TEXT NOT NULL DEFAULT '[]',
        cc_json TEXT NOT NULL DEFAULT '[]',
        bcc_json TEXT NOT NULL DEFAULT '[]',
        subject TEXT NOT NULL DEFAULT '',
        body_text TEXT NOT NULL DEFAULT '',
        body_html TEXT,
        attachment_paths_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'local',
        error TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS gmail_fts USING fts5(
        account_id UNINDEXED,
        message_id UNINDEXED,
        thread_id UNINDEXED,
        subject,
        sender,
        recipients,
        body,
        attachment_names,
        tokenize='unicode61 remove_diacritics 2'
      );
    `)
    const messageColumns = new Set((this.db.prepare('PRAGMA table_info(gmail_messages)').all() as { name: string }[]).map((column) => column.name))
    if (!messageColumns.has('header_message_id')) this.db.exec('ALTER TABLE gmail_messages ADD COLUMN header_message_id TEXT')
    if (!messageColumns.has('references_json')) this.db.exec(`ALTER TABLE gmail_messages ADD COLUMN references_json TEXT NOT NULL DEFAULT '[]'`)
    this.stmt('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(2, ?)').run(nowIso())
  }

  listAccounts(): GmailAccountSummary[] {
    return (this.stmt('SELECT * FROM gmail_accounts ORDER BY archived, created_at').all() as DatabaseRow[]).map((row) => ({
      id: String(row.id),
      email: String(row.email),
      displayName: String(row.display_name),
      avatarUrl: row.avatar_url ? String(row.avatar_url) : undefined,
      color: String(row.color),
      status: String(row.status) as GmailAccountSummary['status'],
      archived: Boolean(row.archived),
      lastSyncAt: row.last_sync_at ? String(row.last_sync_at) : undefined,
      error: row.error ? String(row.error) : undefined
    }))
  }

  upsertAccount(account: GmailAccountSummary) {
    const timestamp = nowIso()
    this.stmt(`
      INSERT INTO gmail_accounts(id,email,display_name,avatar_url,color,status,archived,last_sync_at,error,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET email=excluded.email,display_name=excluded.display_name,avatar_url=excluded.avatar_url,
        color=excluded.color,status=excluded.status,archived=excluded.archived,error=excluded.error,updated_at=excluded.updated_at
    `).run(account.id, account.email, account.displayName, account.avatarUrl ?? null, account.color, account.status, account.archived ? 1 : 0, account.lastSyncAt ?? null, account.error ?? null, timestamp, timestamp)
    this.stmt(`INSERT OR IGNORE INTO gmail_sync_state(account_id,phase,updated_at) VALUES(?,'idle',?)`).run(account.id, timestamp)
  }

  setAccountStatus(accountId: string, status: GmailAccountSummary['status'], error?: string) {
    this.stmt('UPDATE gmail_accounts SET status=?,error=?,updated_at=? WHERE id=?').run(status, error ?? null, nowIso(), accountId)
  }

  setAccountHistory(accountId: string, historyId: string, completedSync = false) {
    this.stmt('UPDATE gmail_accounts SET history_id=?,last_sync_at=?,status=?,error=NULL,updated_at=? WHERE id=?')
      .run(historyId, nowIso(), completedSync ? 'ready' : 'syncing', nowIso(), accountId)
  }

  getAccountHistory(accountId: string) {
    const row = this.stmt('SELECT history_id FROM gmail_accounts WHERE id=?').get(accountId) as DatabaseRow | undefined
    return row?.history_id ? String(row.history_id) : undefined
  }

  disconnectAccount(accountId: string, mode: 'archive' | 'delete') {
    if (mode === 'archive') {
      this.stmt(`UPDATE gmail_accounts SET archived=1,status='archived',updated_at=? WHERE id=?`).run(nowIso(), accountId)
      return
    }
    const rawRows = this.stmt('SELECT raw_path FROM gmail_messages WHERE account_id=?').all(accountId) as DatabaseRow[]
    this.transaction(() => {
      this.stmt('DELETE FROM gmail_fts WHERE account_id=?').run(accountId)
      this.stmt('DELETE FROM gmail_accounts WHERE id=?').run(accountId)
    })
    for (const row of rawRows) {
      try { rmSync(String(row.raw_path), { force: true }) } catch { /* Best effort after DB deletion. */ }
    }
    const safeAccount = accountId.replaceAll(/[^a-zA-Z0-9._-]/g, '_')
    try { rmSync(join(this.contentPath, safeAccount), { recursive: true, force: true }) } catch { /* Best effort. */ }
  }

  replaceLabels(accountId: string, labels: GmailLabel[]) {
    this.transaction(() => {
      this.stmt('DELETE FROM gmail_labels WHERE account_id=?').run(accountId)
      const insert = this.stmt('INSERT INTO gmail_labels(account_id,id,name,type,color) VALUES(?,?,?,?,?)')
      for (const label of labels) insert.run(accountId, label.id, label.name, label.type, label.color ?? null)
    })
  }

  listLabels(accountIds?: string[]): GmailLabel[] {
    const rows = accountIds?.length
      ? this.db.prepare(`SELECT * FROM gmail_labels WHERE account_id IN (${accountIds.map(() => '?').join(',')}) ORDER BY type,name`).all(...accountIds) as DatabaseRow[]
      : this.stmt('SELECT * FROM gmail_labels ORDER BY account_id,type,name').all() as DatabaseRow[]
    return rows.map((row) => ({
      accountId: String(row.account_id),
      id: String(row.id),
      name: String(row.name),
      type: String(row.type) as GmailLabel['type'],
      color: row.color ? String(row.color) : undefined
    }))
  }

  updateSyncProgress(progress: SyncProgress, extras?: { pageToken?: string | null; initialHistoryId?: string }) {
    this.stmt(`
      INSERT INTO gmail_sync_state(account_id,phase,completed,total,transferred_bytes,started_at,updated_at,page_token,initial_history_id,paused_reason,message)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(account_id) DO UPDATE SET phase=excluded.phase,completed=excluded.completed,total=excluded.total,
        transferred_bytes=excluded.transferred_bytes,updated_at=excluded.updated_at,
        page_token=COALESCE(excluded.page_token,gmail_sync_state.page_token),
        initial_history_id=COALESCE(excluded.initial_history_id,gmail_sync_state.initial_history_id),
        paused_reason=excluded.paused_reason,message=excluded.message
    `).run(
      progress.accountId, progress.phase, progress.completed, progress.total, progress.transferredBytes,
      progress.phase === 'inventory' ? progress.updatedAt : null, progress.updatedAt,
      extras?.pageToken ?? null, extras?.initialHistoryId ?? null, progress.pausedReason ?? null, progress.message ?? null
    )
    if (extras && Object.hasOwn(extras, 'pageToken')) {
      this.stmt('UPDATE gmail_sync_state SET page_token=? WHERE account_id=?').run(extras.pageToken ?? null, progress.accountId)
    }
  }

  getSyncProgress(accountId?: string): SyncProgress[] {
    const rows = accountId
      ? this.stmt('SELECT * FROM gmail_sync_state WHERE account_id=?').all(accountId) as DatabaseRow[]
      : this.stmt('SELECT * FROM gmail_sync_state ORDER BY account_id').all() as DatabaseRow[]
    return rows.map((row) => {
      const completed = Number(row.completed)
      const total = Number(row.total)
      const started = row.started_at ? new Date(String(row.started_at)).getTime() : 0
      const elapsed = started ? (Date.now() - started) / 1000 : 0
      const rate = elapsed > 0 ? completed / elapsed : 0
      return {
        accountId: String(row.account_id),
        phase: String(row.phase) as SyncProgress['phase'],
        completed,
        total,
        transferredBytes: Number(row.transferred_bytes),
        estimatedRemainingSeconds: rate > 0 && total > completed ? Math.round((total - completed) / rate) : undefined,
        message: row.message ? String(row.message) : undefined,
        pausedReason: row.paused_reason ? String(row.paused_reason) as SyncProgress['pausedReason'] : undefined,
        updatedAt: String(row.updated_at)
      }
    })
  }

  getSyncCheckpoint(accountId: string) {
    return this.stmt('SELECT * FROM gmail_sync_state WHERE account_id=?').get(accountId) as DatabaseRow | undefined
  }

  addInventory(accountId: string, items: { id: string; threadId: string }[]) {
    this.transaction(() => {
      const insert = this.stmt(`INSERT OR IGNORE INTO gmail_sync_items(account_id,message_id,thread_id,status) VALUES(?,?,?,'pending')`)
      for (const item of items) insert.run(accountId, item.id, item.threadId)
      const total = Number((this.stmt('SELECT COUNT(*) count FROM gmail_sync_items WHERE account_id=?').get(accountId) as DatabaseRow).count)
      this.stmt('UPDATE gmail_sync_state SET total=?,updated_at=? WHERE account_id=?').run(total, nowIso(), accountId)
    })
  }

  resetInventory(accountId: string) {
    this.transaction(() => {
      this.stmt('DELETE FROM gmail_sync_items WHERE account_id=?').run(accountId)
      this.stmt(`UPDATE gmail_sync_state SET phase='inventory',completed=0,total=0,transferred_bytes=0,page_token=NULL,started_at=?,updated_at=?,message=NULL WHERE account_id=?`)
        .run(nowIso(), nowIso(), accountId)
    })
  }

  reconcileInventory(accountId: string) {
    const stale = this.stmt(`
      SELECT id FROM gmail_messages m
      WHERE account_id=? AND NOT EXISTS(
        SELECT 1 FROM gmail_sync_items s WHERE s.account_id=m.account_id AND s.message_id=m.id
      )
    `).all(accountId) as DatabaseRow[]
    for (const row of stale) this.deleteMessage(accountId, String(row.id))
    return stale.length
  }

  pendingMessageIds(accountId: string, limit: number) {
    return (this.stmt(`SELECT message_id,thread_id FROM gmail_sync_items WHERE account_id=? AND (status='pending' OR (status='failed' AND attempts<5)) ORDER BY rowid LIMIT ?`).all(accountId, limit) as DatabaseRow[])
      .map((row) => ({ id: String(row.message_id), threadId: String(row.thread_id) }))
  }

  markSyncItem(accountId: string, messageId: string, status: 'complete' | 'pending' | 'failed', error?: string) {
    this.stmt('UPDATE gmail_sync_items SET status=?,attempts=attempts+1,error=? WHERE account_id=? AND message_id=?').run(status, error ?? null, accountId, messageId)
  }

  upsertMessage(message: ParsedMailMessage) {
    const labels = new Set(message.labelIds)
    const syncItem = this.stmt('SELECT status FROM gmail_sync_items WHERE account_id=? AND message_id=?').get(message.accountId, message.id) as DatabaseRow | undefined
    const inventoryCompletion = Boolean(syncItem && syncItem.status !== 'complete')
    this.transaction(() => {
      this.stmt(`
        INSERT INTO gmail_threads(account_id,id,subject,participants_json,snippet,last_date,unread,starred,important,trashed,draft,sent,inbox,has_attachments,message_count,label_ids_json)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)
        ON CONFLICT(account_id,id) DO UPDATE SET
          subject=CASE WHEN excluded.last_date>=gmail_threads.last_date THEN excluded.subject ELSE gmail_threads.subject END,
          snippet=CASE WHEN excluded.last_date>=gmail_threads.last_date THEN excluded.snippet ELSE gmail_threads.snippet END,
          last_date=MAX(gmail_threads.last_date,excluded.last_date),
          unread=MAX(gmail_threads.unread,excluded.unread),starred=MAX(gmail_threads.starred,excluded.starred),
          important=MAX(gmail_threads.important,excluded.important),trashed=MIN(gmail_threads.trashed,excluded.trashed),
          draft=MAX(gmail_threads.draft,excluded.draft),sent=MAX(gmail_threads.sent,excluded.sent),
          inbox=MAX(gmail_threads.inbox,excluded.inbox),has_attachments=MAX(gmail_threads.has_attachments,excluded.has_attachments),
          message_count=(SELECT COUNT(*)+1 FROM gmail_messages WHERE account_id=excluded.account_id AND thread_id=excluded.id AND id<>?),
          label_ids_json=excluded.label_ids_json
      `).run(
        message.accountId, message.threadId, message.subject, JSON.stringify([message.fromName || message.fromEmail]),
        message.snippet, message.internalDate, labels.has('UNREAD') ? 1 : 0, labels.has('STARRED') ? 1 : 0,
        labels.has('IMPORTANT') ? 1 : 0, labels.has('TRASH') ? 1 : 0, labels.has('DRAFT') ? 1 : 0,
        labels.has('SENT') ? 1 : 0, labels.has('INBOX') ? 1 : 0, message.attachments.length ? 1 : 0,
        JSON.stringify(message.labelIds), message.id
      )
      this.stmt(`
        INSERT INTO gmail_messages(account_id,id,thread_id,history_id,internal_date,from_name,from_email,to_json,cc_json,subject,header_message_id,references_json,snippet,body_text,body_html,label_ids_json,size_estimate,raw_path)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(account_id,id) DO UPDATE SET history_id=excluded.history_id,internal_date=excluded.internal_date,
          from_name=excluded.from_name,from_email=excluded.from_email,to_json=excluded.to_json,cc_json=excluded.cc_json,
          subject=excluded.subject,header_message_id=excluded.header_message_id,references_json=excluded.references_json,
          snippet=excluded.snippet,body_text=excluded.body_text,body_html=excluded.body_html,
          label_ids_json=excluded.label_ids_json,size_estimate=excluded.size_estimate,raw_path=excluded.raw_path
      `).run(
        message.accountId, message.id, message.threadId, message.historyId, message.internalDate,
        message.fromName, message.fromEmail, JSON.stringify(message.to), JSON.stringify(message.cc), message.subject,
        message.messageIdHeader ?? null, JSON.stringify(message.references), message.snippet, message.text, message.html,
        JSON.stringify(message.labelIds), message.sizeEstimate, message.rawPath
      )
      this.stmt('DELETE FROM gmail_attachments WHERE account_id=? AND message_id=?').run(message.accountId, message.id)
      const insertAttachment = this.stmt('INSERT INTO gmail_attachments(account_id,message_id,id,filename,mime_type,size,content_id) VALUES(?,?,?,?,?,?,?)')
      for (const attachment of message.attachments) {
        insertAttachment.run(message.accountId, message.id, attachment.id, attachment.filename, attachment.mimeType, attachment.size, attachment.contentId ?? null)
      }
      this.stmt('DELETE FROM gmail_fts WHERE account_id=? AND message_id=?').run(message.accountId, message.id)
      this.stmt('INSERT INTO gmail_fts(account_id,message_id,thread_id,subject,sender,recipients,body,attachment_names) VALUES(?,?,?,?,?,?,?,?)')
        .run(message.accountId, message.id, message.threadId, message.subject, `${message.fromName} ${message.fromEmail}`, [...message.to, ...message.cc].join(' '), message.text, message.attachments.map((item) => item.filename).join(' '))
      this.markSyncItem(message.accountId, message.id, 'complete')
      if (inventoryCompletion) {
        this.stmt('UPDATE gmail_sync_state SET completed=completed+1,transferred_bytes=transferred_bytes+?,updated_at=? WHERE account_id=?')
          .run(message.sizeEstimate, nowIso(), message.accountId)
      }
    })
  }

  updateMessageLabels(accountId: string, messageId: string, labelIds: string[], historyId: string) {
    const row = this.stmt('SELECT thread_id FROM gmail_messages WHERE account_id=? AND id=?').get(accountId, messageId) as DatabaseRow | undefined
    if (!row) return
    this.stmt('UPDATE gmail_messages SET label_ids_json=?,history_id=? WHERE account_id=? AND id=?').run(JSON.stringify(labelIds), historyId, accountId, messageId)
    this.rebuildThread(accountId, String(row.thread_id))
  }

  deleteMessage(accountId: string, messageId: string) {
    const row = this.stmt('SELECT thread_id,raw_path FROM gmail_messages WHERE account_id=? AND id=?').get(accountId, messageId) as DatabaseRow | undefined
    if (!row) return
    this.transaction(() => {
      this.stmt('DELETE FROM gmail_fts WHERE account_id=? AND message_id=?').run(accountId, messageId)
      this.stmt('DELETE FROM gmail_messages WHERE account_id=? AND id=?').run(accountId, messageId)
    })
    try { rmSync(String(row.raw_path), { force: true }) } catch { /* Best effort. */ }
    this.rebuildThread(accountId, String(row.thread_id))
  }

  private rebuildThread(accountId: string, threadId: string) {
    const rows = this.stmt('SELECT * FROM gmail_messages WHERE account_id=? AND thread_id=? ORDER BY internal_date').all(accountId, threadId) as DatabaseRow[]
    if (!rows.length) {
      this.stmt('DELETE FROM gmail_threads WHERE account_id=? AND id=?').run(accountId, threadId)
      return
    }
    const newest = rows.at(-1)!
    const labelSets = rows.map((row) => new Set(json<string[]>(String(row.label_ids_json), [])))
    const participants = Array.from(new Set(rows.map((row) => String(row.from_name || row.from_email)).filter(Boolean)))
    const allLabels = Array.from(new Set(rows.flatMap((row) => json<string[]>(String(row.label_ids_json), []))))
    const attachments = Number((this.stmt('SELECT COUNT(*) count FROM gmail_attachments a JOIN gmail_messages m ON m.account_id=a.account_id AND m.id=a.message_id WHERE m.account_id=? AND m.thread_id=?').get(accountId, threadId) as DatabaseRow).count)
    this.stmt(`
      UPDATE gmail_threads SET subject=?,participants_json=?,snippet=?,last_date=?,unread=?,starred=?,important=?,trashed=?,draft=?,sent=?,inbox=?,has_attachments=?,message_count=?,label_ids_json=?
      WHERE account_id=? AND id=?
    `).run(
      String(newest.subject), JSON.stringify(participants), String(newest.snippet), String(newest.internal_date),
      labelSets.some((set) => set.has('UNREAD')) ? 1 : 0, labelSets.some((set) => set.has('STARRED')) ? 1 : 0,
      labelSets.some((set) => set.has('IMPORTANT')) ? 1 : 0, labelSets.every((set) => set.has('TRASH')) ? 1 : 0,
      labelSets.some((set) => set.has('DRAFT')) ? 1 : 0, labelSets.some((set) => set.has('SENT')) ? 1 : 0,
      labelSets.some((set) => set.has('INBOX')) ? 1 : 0, attachments ? 1 : 0, rows.length, JSON.stringify(allLabels), accountId, threadId
    )
  }

  listThreads(query: MailQuery): MailPage {
    const pageSize = Math.min(Math.max(query.pageSize ?? 50, 1), 100)
    const where: string[] = ['1=1']
    const params: (string | number)[] = []
    if (query.accountIds?.length) {
      where.push(`t.account_id IN (${query.accountIds.map(() => '?').join(',')})`)
      params.push(...query.accountIds)
    }
    const folder = query.folder ?? 'inbox'
    if (folder === 'inbox') where.push('t.inbox=1 AND t.trashed=0')
    if (folder === 'starred') where.push('t.starred=1 AND t.trashed=0')
    if (folder === 'important') where.push('t.important=1 AND t.trashed=0')
    if (folder === 'sent') where.push('t.sent=1 AND t.trashed=0')
    if (folder === 'drafts') where.push('t.draft=1 AND t.trashed=0')
    if (folder === 'archive') where.push('t.inbox=0 AND t.trashed=0 AND t.sent=0 AND t.draft=0')
    if (folder === 'spam') where.push(`EXISTS(SELECT 1 FROM json_each(t.label_ids_json) WHERE value='SPAM')`)
    if (folder === 'trash') where.push('t.trashed=1')
    if (folder === 'all') where.push(`t.trashed=0 AND NOT EXISTS(SELECT 1 FROM json_each(t.label_ids_json) WHERE value='SPAM')`)
    if (query.labelId) {
      where.push(`EXISTS(SELECT 1 FROM json_each(t.label_ids_json) WHERE value=?)`)
      params.push(query.labelId)
    }
    let join = ''
    if (query.search?.trim()) {
      join = 'JOIN (SELECT DISTINCT account_id,thread_id FROM gmail_fts WHERE gmail_fts MATCH ?) f ON f.account_id=t.account_id AND f.thread_id=t.id'
      params.unshift(query.search.trim().split(/\s+/).map((term) => `"${term.replaceAll('"', '""')}"*`).join(' AND '))
    }
    if (query.cursor) {
      const cursor = json<{ date: string; id: string; accountId: string }>(Buffer.from(query.cursor, 'base64url').toString('utf8'), { date: '', id: '', accountId: '' })
      where.push('(t.last_date < ? OR (t.last_date=? AND (t.id<? OR (t.id=? AND t.account_id<?))))')
      params.push(cursor.date, cursor.date, cursor.id, cursor.id, cursor.accountId)
    }
    const sql = `SELECT t.* FROM gmail_threads t JOIN gmail_accounts a ON a.id=t.account_id ${join} WHERE ${where.join(' AND ')} ORDER BY t.last_date DESC,t.id DESC,t.account_id DESC LIMIT ?`
    const rows = this.db.prepare(sql).all(...params, pageSize + 1) as DatabaseRow[]
    const hasMore = rows.length > pageSize
    const visible = rows.slice(0, pageSize)
    const countParams = params.slice(0, params.length - (query.cursor ? 5 : 0))
    const countWhere = where.filter((part) => !part.startsWith('(t.last_date <'))
    const total = Number((this.db.prepare(`SELECT COUNT(DISTINCT t.account_id||':'||t.id) total FROM gmail_threads t JOIN gmail_accounts a ON a.id=t.account_id ${join} WHERE ${countWhere.join(' AND ')}`).get(...countParams) as DatabaseRow).total)
    const items = visible.map((row) => ({
      accountId: String(row.account_id),
      id: String(row.id),
      subject: String(row.subject || '(No subject)'),
      participants: json<string[]>(String(row.participants_json), []),
      snippet: String(row.snippet),
      lastDate: String(row.last_date),
      unread: Boolean(row.unread),
      starred: Boolean(row.starred),
      important: Boolean(row.important),
      trashed: Boolean(row.trashed),
      draft: Boolean(row.draft),
      hasAttachments: Boolean(row.has_attachments),
      messageCount: Number(row.message_count),
      labelIds: json<string[]>(String(row.label_ids_json), [])
    }))
    const last = items.at(-1)
    return {
      items,
      total,
      nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ date: last.lastDate, id: last.id, accountId: last.accountId })).toString('base64url') : undefined
    }
  }

  getThread(accountId: string, threadId: string): GmailThreadDetail {
    const rows = this.stmt('SELECT * FROM gmail_messages WHERE account_id=? AND thread_id=? ORDER BY internal_date').all(accountId, threadId) as DatabaseRow[]
    if (!rows.length) throw new Error('Thread not found')
    const messages: GmailMessageDetail[] = rows.map((row) => ({
      accountId,
      id: String(row.id),
      threadId,
      fromName: String(row.from_name),
      fromEmail: String(row.from_email),
      to: json<string[]>(String(row.to_json), []),
      cc: json<string[]>(String(row.cc_json), []),
      subject: String(row.subject),
      messageIdHeader: row.header_message_id ? String(row.header_message_id) : undefined,
      references: json<string[]>(String(row.references_json), []),
      date: String(row.internal_date),
      text: String(row.body_text),
      html: String(row.body_html),
      sanitizedHtml: '',
      labelIds: json<string[]>(String(row.label_ids_json), []),
      attachments: (this.stmt('SELECT * FROM gmail_attachments WHERE account_id=? AND message_id=? ORDER BY filename').all(accountId, String(row.id)) as DatabaseRow[]).map((item) => ({
        id: String(item.id),
        messageId: String(row.id),
        filename: String(item.filename),
        mimeType: String(item.mime_type),
        size: Number(item.size),
        contentId: item.content_id ? String(item.content_id) : undefined
      }))
    }))
    return { accountId, id: threadId, subject: messages.at(-1)?.subject ?? '(No subject)', messages }
  }

  private actionLabels(action: MailActionKind, labelId?: string) {
    if (action === 'archive') return { add: [] as string[], remove: ['INBOX'] }
    if (action === 'unarchive') return { add: ['INBOX'], remove: [] as string[] }
    if (action === 'read') return { add: [] as string[], remove: ['UNREAD'] }
    if (action === 'unread') return { add: ['UNREAD'], remove: [] as string[] }
    if (action === 'star') return { add: ['STARRED'], remove: [] as string[] }
    if (action === 'unstar') return { add: [] as string[], remove: ['STARRED'] }
    if (action === 'important') return { add: ['IMPORTANT'], remove: [] as string[] }
    if (action === 'unimportant') return { add: [] as string[], remove: ['IMPORTANT'] }
    if (action === 'label') return { add: labelId ? [labelId] : [], remove: [] as string[] }
    if (action === 'unlabel') return { add: [] as string[], remove: labelId ? [labelId] : [] }
    return { add: [] as string[], remove: [] as string[] }
  }

  private inverseAction(action: MailActionKind): MailActionKind {
    const inverses: Record<MailActionKind, MailActionKind> = {
      archive: 'unarchive', unarchive: 'archive', read: 'unread', unread: 'read',
      star: 'unstar', unstar: 'star', important: 'unimportant', unimportant: 'important',
      trash: 'untrash', untrash: 'trash', label: 'unlabel', unlabel: 'label'
    }
    return inverses[action]
  }

  applyLocalAction(input: ApplyMailActionInput, operationId = crypto.randomUUID(), delayMs = 10_000): PendingOperation {
    const created = nowIso()
    const undoUntil = new Date(Date.now() + delayMs).toISOString()
    const { add, remove } = this.actionLabels(input.action, input.labelId)
    this.transaction(() => {
      for (const threadId of input.threadIds) {
        const messageRows = this.stmt('SELECT id,label_ids_json FROM gmail_messages WHERE account_id=? AND thread_id=?').all(input.accountId, threadId) as DatabaseRow[]
        for (const row of messageRows) {
          const labels = new Set(json<string[]>(String(row.label_ids_json), []))
          if (input.action === 'trash') labels.add('TRASH')
          else if (input.action === 'untrash') labels.delete('TRASH')
          else {
            add.forEach((label) => labels.add(label))
            remove.forEach((label) => labels.delete(label))
          }
          this.stmt('UPDATE gmail_messages SET label_ids_json=? WHERE account_id=? AND id=?').run(JSON.stringify([...labels]), input.accountId, String(row.id))
        }
        this.rebuildThread(input.accountId, threadId)
      }
      this.stmt(`
        INSERT INTO gmail_operations(id,account_id,thread_ids_json,kind,label_id,inverse_kind,status,execute_after,undo_until,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'queued',?,?,?,?)
      `).run(operationId, input.accountId, JSON.stringify(input.threadIds), input.action, input.labelId ?? null, this.inverseAction(input.action), undoUntil, undoUntil, created, created)
    })
    return { id: operationId, accountId: input.accountId, kind: input.action, status: 'queued', undoUntil }
  }

  undoOperation(operationId: string) {
    const row = this.stmt('SELECT * FROM gmail_operations WHERE id=?').get(operationId) as DatabaseRow | undefined
    if (!row || row.status === 'cancelled' || row.status === 'failed') return false
    const inverse = String(row.inverse_kind) as MailActionKind
    const input: ApplyMailActionInput = {
      accountId: String(row.account_id),
      threadIds: json<string[]>(String(row.thread_ids_json), []),
      action: inverse,
      labelId: row.label_id ? String(row.label_id) : undefined
    }
    if (row.status === 'queued') {
      this.stmt(`UPDATE gmail_operations SET status='cancelled',updated_at=? WHERE id=?`).run(nowIso(), operationId)
      const { add, remove } = this.actionLabels(inverse, input.labelId)
      this.transaction(() => {
        for (const threadId of input.threadIds) {
          const messages = this.stmt('SELECT id,label_ids_json FROM gmail_messages WHERE account_id=? AND thread_id=?').all(input.accountId, threadId) as DatabaseRow[]
          for (const message of messages) {
            const labels = new Set(json<string[]>(String(message.label_ids_json), []))
            if (inverse === 'trash') labels.add('TRASH')
            else if (inverse === 'untrash') labels.delete('TRASH')
            else { add.forEach((label) => labels.add(label)); remove.forEach((label) => labels.delete(label)) }
            this.stmt('UPDATE gmail_messages SET label_ids_json=? WHERE account_id=? AND id=?').run(JSON.stringify([...labels]), input.accountId, String(message.id))
          }
          this.rebuildThread(input.accountId, threadId)
        }
      })
      return true
    }
    this.applyLocalAction(input, crypto.randomUUID(), 0)
    return true
  }

  dueOperations(limit = 20) {
    return this.stmt(`SELECT * FROM gmail_operations WHERE status='queued' AND execute_after<=? ORDER BY created_at LIMIT ?`).all(nowIso(), limit) as DatabaseRow[]
  }

  updateOperation(id: string, status: PendingOperation['status'], error?: string) {
    this.stmt('UPDATE gmail_operations SET status=?,attempts=attempts+1,error=?,updated_at=? WHERE id=?').run(status, error ?? null, nowIso(), id)
  }

  saveDraft(input: GmailDraftInput, result: Partial<GmailDraftResult> = {}): GmailDraftResult {
    const id = input.id ?? crypto.randomUUID()
    const updatedAt = nowIso()
    const status = result.status ?? 'local'
    this.stmt(`
      INSERT INTO gmail_drafts(id,account_id,gmail_draft_id,thread_id,in_reply_to,references_json,to_json,cc_json,bcc_json,subject,body_text,body_html,attachment_paths_json,status,error,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET gmail_draft_id=COALESCE(excluded.gmail_draft_id,gmail_drafts.gmail_draft_id),thread_id=excluded.thread_id,in_reply_to=excluded.in_reply_to,
        references_json=excluded.references_json,to_json=excluded.to_json,cc_json=excluded.cc_json,bcc_json=excluded.bcc_json,
        subject=excluded.subject,body_text=excluded.body_text,body_html=excluded.body_html,attachment_paths_json=excluded.attachment_paths_json,
        status=excluded.status,error=excluded.error,updated_at=excluded.updated_at
    `).run(
      id, input.accountId, result.gmailDraftId ?? null, input.threadId ?? null, input.inReplyTo ?? null,
      JSON.stringify(input.references ?? []), JSON.stringify(input.to), JSON.stringify(input.cc), JSON.stringify(input.bcc),
      input.subject, input.text, input.html ?? null, JSON.stringify(input.attachmentPaths), status, result.error ?? null, updatedAt
    )
    const stored = this.getDraft(id)
    return { id, gmailDraftId: stored?.gmail_draft_id ? String(stored.gmail_draft_id) : result.gmailDraftId, status, updatedAt, error: result.error }
  }

  getDraft(id: string) {
    return this.stmt('SELECT * FROM gmail_drafts WHERE id=?').get(id) as DatabaseRow | undefined
  }

  queuedDrafts() {
    return this.stmt(`SELECT * FROM gmail_drafts WHERE status='queued' ORDER BY updated_at LIMIT 20`).all() as DatabaseRow[]
  }

  draftsToSync() {
    return this.stmt(`SELECT * FROM gmail_drafts WHERE status='local' ORDER BY updated_at LIMIT 20`).all() as DatabaseRow[]
  }

  updateDraftResult(id: string, result: GmailDraftResult) {
    this.stmt('UPDATE gmail_drafts SET gmail_draft_id=?,status=?,error=?,updated_at=? WHERE id=?')
      .run(result.gmailDraftId ?? null, result.status, result.error ?? null, result.updatedAt, id)
  }

  getMessageRaw(accountId: string, messageId: string) {
    const row = this.stmt('SELECT raw_path FROM gmail_messages WHERE account_id=? AND id=?').get(accountId, messageId) as DatabaseRow | undefined
    return row?.raw_path ? String(row.raw_path) : undefined
  }

  getAttachment(accountId: string, messageId: string, attachmentId: string) {
    return this.stmt('SELECT * FROM gmail_attachments WHERE account_id=? AND message_id=? AND id=?').get(accountId, messageId, attachmentId) as DatabaseRow | undefined
  }

  storageStats(freeBytes: number): MailStorageStats {
    const accounts = this.stmt('SELECT account_id,COUNT(*) messages,SUM(size_estimate) bytes FROM gmail_messages GROUP BY account_id').all() as DatabaseRow[]
    return {
      totalBytes: accounts.reduce((sum, row) => sum + Number(row.bytes ?? 0), 0),
      freeBytes,
      accounts: accounts.map((row) => ({ accountId: String(row.account_id), bytes: Number(row.bytes ?? 0), messages: Number(row.messages) }))
    }
  }

  rawPath(accountId: string, messageId: string) {
    const safeAccount = accountId.replaceAll(/[^a-zA-Z0-9._-]/g, '_')
    const shard = messageId.slice(0, 2)
    const directory = join(this.contentPath, safeAccount, shard)
    mkdirSync(directory, { recursive: true })
    return join(directory, `${messageId}.eml`)
  }

  rawExists(path: string) {
    try { return statSync(path).size > 0 } catch { return false }
  }
}
