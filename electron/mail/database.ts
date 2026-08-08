import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  ApplyMailActionInput,
  MailAccountSummary,
  MailAttachment,
  MailDraftInput,
  MailDraftRecord,
  MailDraftResult,
  MailLabel,
  MailRule,
  MailRuleInput,
  MailSnooze,
  MailMessageDetail,
  MailThreadDetail,
  MailActionKind,
  MailAccountSettingsInput,
  MailDiagnosticHealth,
  MailPage,
  MailFolderUnreadCounts,
  MailAccountUnreadCounts,
  MailQuery,
  MailRecipientSuggestion,
  MailStorageStats,
  PendingOperation,
  SyncProgress
} from '../../src/mail-types'

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
  remoteFolderId?: string
  remoteUid?: string
  attachments: MailAttachment[]
}

interface DatabaseRow {
  [key: string]: string | number | bigint | null
}

const nowIso = () => new Date().toISOString()
const addressParts = (value: string) => {
  const match = value.trim().match(/^(.*?)\s*<([^<>]+)>$/)
  return { name: match?.[1]?.trim().replace(/^"|"$/g, '') || undefined, email: (match?.[2] ?? value).trim().toLowerCase() }
}
const json = <T>(value: string | null | undefined, fallback: T): T => {
  try {
    return value ? JSON.parse(value) as T : fallback
  } catch {
    return fallback
  }
}
const containsPattern = (value: string) => `%${value.trim().replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`

type MailRuleMessage = Pick<ParsedMailMessage, 'accountId' | 'threadId' | 'fromName' | 'fromEmail' | 'to' | 'cc' | 'subject' | 'text'>

export function mailRuleMatches(rule: MailRuleInput, message: MailRuleMessage) {
  const values: Record<MailRuleInput['conditions'][number]['field'], string> = {
    from: `${message.fromName} ${message.fromEmail}`,
    to: [...message.to, ...message.cc].join(' '),
    subject: message.subject,
    body: message.text
  }
  const matches = rule.conditions.map((condition) => {
    const haystack = values[condition.field].trim().toLocaleLowerCase()
    const needle = condition.value.trim().toLocaleLowerCase()
    if (!needle) return false
    if (condition.operator === 'equals') {
      const exactValues = condition.field === 'from' ? [message.fromEmail, message.fromName, values.from] : [haystack]
      return exactValues.some((value) => value.trim().toLocaleLowerCase() === needle)
    }
    if (condition.operator === 'starts-with') return haystack.startsWith(needle)
    if (condition.operator === 'ends-with') return haystack.endsWith(needle)
    return haystack.includes(needle)
  })
  return matches.length > 0 && (rule.match === 'all' ? matches.every(Boolean) : matches.some(Boolean))
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
        provider TEXT NOT NULL DEFAULT 'gmail',
        email TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        avatar_url TEXT,
        color TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'connecting',
        archived INTEGER NOT NULL DEFAULT 0,
        history_id TEXT,
        last_sync_at TEXT,
        error TEXT,
        signature TEXT NOT NULL DEFAULT '',
        notifications INTEGER NOT NULL DEFAULT 1,
        sync_enabled INTEGER NOT NULL DEFAULT 1,
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
        sender_email TEXT NOT NULL DEFAULT '',
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
        remote_folder_id TEXT,
        remote_uid TEXT,
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
        remote_folder_id TEXT,
        remote_uid TEXT,
        PRIMARY KEY (account_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS gmail_sync_pending ON gmail_sync_items(account_id, status, message_id);

      CREATE TABLE IF NOT EXISTS gmail_recipients (
        account_id TEXT NOT NULL REFERENCES gmail_accounts(id) ON DELETE CASCADE,
        email TEXT NOT NULL,
        name TEXT,
        last_used_at TEXT NOT NULL,
        PRIMARY KEY (account_id, email)
      );
      CREATE INDEX IF NOT EXISTS gmail_recipients_recent ON gmail_recipients(last_used_at DESC);

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
        message TEXT,
        provider_state_json TEXT NOT NULL DEFAULT '{}'
        ,inventory_complete INTEGER NOT NULL DEFAULT 0
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
        ,before_labels_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS gmail_operations_due ON gmail_operations(status, execute_after);

      CREATE TABLE IF NOT EXISTS gmail_drafts (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES gmail_accounts(id) ON DELETE CASCADE,
        gmail_draft_id TEXT,
        remote_revision TEXT,
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
        delivery_at TEXT,
        error TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mail_snoozes (
        account_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        snoozed_until TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (account_id, thread_id),
        FOREIGN KEY (account_id, thread_id) REFERENCES gmail_threads(account_id, id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS mail_snoozes_due ON mail_snoozes(snoozed_until);

      CREATE TABLE IF NOT EXISTS mail_rules (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES gmail_accounts(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        match_mode TEXT NOT NULL DEFAULT 'all',
        conditions_json TEXT NOT NULL DEFAULT '[]',
        actions_json TEXT NOT NULL DEFAULT '[]',
        match_count INTEGER NOT NULL DEFAULT 0,
        last_matched_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mail_rules_account ON mail_rules(account_id, enabled);

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
    if (!messageColumns.has('remote_folder_id')) this.db.exec('ALTER TABLE gmail_messages ADD COLUMN remote_folder_id TEXT')
    if (!messageColumns.has('remote_uid')) this.db.exec('ALTER TABLE gmail_messages ADD COLUMN remote_uid TEXT')
    const threadColumns = new Set((this.db.prepare('PRAGMA table_info(gmail_threads)').all() as { name: string }[]).map((column) => column.name))
    if (!threadColumns.has('sender_email')) this.db.exec(`ALTER TABLE gmail_threads ADD COLUMN sender_email TEXT NOT NULL DEFAULT ''`)
    this.db.exec(`UPDATE gmail_threads SET sender_email=COALESCE((
      SELECT from_email FROM gmail_messages
      WHERE account_id=gmail_threads.account_id AND thread_id=gmail_threads.id
      ORDER BY internal_date DESC LIMIT 1
    ), '') WHERE sender_email=''`)
    const accountColumns = new Set((this.db.prepare('PRAGMA table_info(gmail_accounts)').all() as { name: string }[]).map((column) => column.name))
    if (!accountColumns.has('provider')) this.db.exec(`ALTER TABLE gmail_accounts ADD COLUMN provider TEXT NOT NULL DEFAULT 'gmail'`)
    if (!accountColumns.has('signature')) this.db.exec(`ALTER TABLE gmail_accounts ADD COLUMN signature TEXT NOT NULL DEFAULT ''`)
    if (!accountColumns.has('notifications')) this.db.exec(`ALTER TABLE gmail_accounts ADD COLUMN notifications INTEGER NOT NULL DEFAULT 1`)
    if (!accountColumns.has('sync_enabled')) this.db.exec(`ALTER TABLE gmail_accounts ADD COLUMN sync_enabled INTEGER NOT NULL DEFAULT 1`)
    const inventoryColumns = new Set((this.db.prepare('PRAGMA table_info(gmail_sync_items)').all() as { name: string }[]).map((column) => column.name))
    if (!inventoryColumns.has('remote_folder_id')) this.db.exec('ALTER TABLE gmail_sync_items ADD COLUMN remote_folder_id TEXT')
    if (!inventoryColumns.has('remote_uid')) this.db.exec('ALTER TABLE gmail_sync_items ADD COLUMN remote_uid TEXT')
    const syncColumns = new Set((this.db.prepare('PRAGMA table_info(gmail_sync_state)').all() as { name: string }[]).map((column) => column.name))
    if (!syncColumns.has('provider_state_json')) this.db.exec(`ALTER TABLE gmail_sync_state ADD COLUMN provider_state_json TEXT NOT NULL DEFAULT '{}'`)
    if (!syncColumns.has('inventory_complete')) this.db.exec(`ALTER TABLE gmail_sync_state ADD COLUMN inventory_complete INTEGER NOT NULL DEFAULT 0`)
    const operationColumns = new Set((this.db.prepare('PRAGMA table_info(gmail_operations)').all() as { name: string }[]).map((column) => column.name))
    if (!operationColumns.has('before_labels_json')) this.db.exec(`ALTER TABLE gmail_operations ADD COLUMN before_labels_json TEXT NOT NULL DEFAULT '{}'`)
    const draftColumns = new Set((this.db.prepare('PRAGMA table_info(gmail_drafts)').all() as { name: string }[]).map((column) => column.name))
    if (!draftColumns.has('delivery_at')) this.db.exec('ALTER TABLE gmail_drafts ADD COLUMN delivery_at TEXT')
    if (!draftColumns.has('remote_revision')) this.db.exec('ALTER TABLE gmail_drafts ADD COLUMN remote_revision TEXT')
    this.stmt('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(4, ?)').run(nowIso())
    this.stmt('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(5, ?)').run(nowIso())
    this.stmt('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(6, ?)').run(nowIso())
    this.stmt('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(7, ?)').run(nowIso())
    this.recoverInterruptedWork()
  }

  listAccounts(): MailAccountSummary[] {
    return (this.stmt('SELECT * FROM gmail_accounts ORDER BY archived, created_at').all() as DatabaseRow[]).map((row) => ({
      id: String(row.id),
      provider: String(row.provider ?? 'gmail') as MailAccountSummary['provider'],
      email: String(row.email),
      displayName: String(row.display_name),
      avatarUrl: row.avatar_url ? String(row.avatar_url) : undefined,
      color: String(row.color),
      status: String(row.status) as MailAccountSummary['status'],
      archived: Boolean(row.archived),
      lastSyncAt: row.last_sync_at ? String(row.last_sync_at) : undefined,
      error: row.error ? String(row.error) : undefined,
      signature: String(row.signature ?? ''),
      notifications: Boolean(row.notifications),
      syncEnabled: Boolean(row.sync_enabled)
    }))
  }

  upsertAccount(account: MailAccountSummary) {
    const timestamp = nowIso()
    this.stmt(`
      INSERT INTO gmail_accounts(id,provider,email,display_name,avatar_url,color,status,archived,last_sync_at,error,signature,notifications,sync_enabled,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET provider=excluded.provider,email=excluded.email,display_name=excluded.display_name,avatar_url=excluded.avatar_url,
        color=excluded.color,status=excluded.status,archived=excluded.archived,error=excluded.error,updated_at=excluded.updated_at
    `).run(account.id, account.provider, account.email, account.displayName, account.avatarUrl ?? null, account.color, account.status, account.archived ? 1 : 0, account.lastSyncAt ?? null, account.error ?? null, account.signature, account.notifications ? 1 : 0, account.syncEnabled ? 1 : 0, timestamp, timestamp)
    this.stmt(`INSERT OR IGNORE INTO gmail_sync_state(account_id,phase,updated_at) VALUES(?,'idle',?)`).run(account.id, timestamp)
  }

  getAccount(accountId: string) {
    return this.listAccounts().find((account) => account.id === accountId)
  }

  setAccountStatus(accountId: string, status: MailAccountSummary['status'], error?: string) {
    this.stmt('UPDATE gmail_accounts SET status=?,error=?,updated_at=? WHERE id=?').run(status, error ?? null, nowIso(), accountId)
  }

  updateAccountSettings(input: MailAccountSettingsInput) {
    if (!this.getAccount(input.accountId)) throw new Error('Account not found')
    this.stmt('UPDATE gmail_accounts SET display_name=?,color=?,signature=?,notifications=?,sync_enabled=?,updated_at=? WHERE id=?')
      .run(input.displayName.trim(), input.color, input.signature, input.notifications ? 1 : 0, input.syncEnabled ? 1 : 0, nowIso(), input.accountId)
    return this.getAccount(input.accountId)!
  }

  resetForFullSync(accountId: string) {
    this.resetInventory(accountId)
    this.stmt(`UPDATE gmail_accounts SET history_id=NULL,status='syncing',error=NULL,updated_at=? WHERE id=?`).run(nowIso(), accountId)
    this.stmt(`UPDATE gmail_sync_state SET provider_state_json='{}',initial_history_id=NULL WHERE account_id=?`).run(accountId)
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

  replaceLabels(accountId: string, labels: MailLabel[]) {
    this.transaction(() => {
      this.stmt('DELETE FROM gmail_labels WHERE account_id=?').run(accountId)
      const insert = this.stmt('INSERT INTO gmail_labels(account_id,id,name,type,color) VALUES(?,?,?,?,?)')
      for (const label of labels) insert.run(accountId, label.id, label.name, label.type, label.color ?? null)
    })
  }

  listLabels(accountIds?: string[]): MailLabel[] {
    const rows = accountIds?.length
      ? this.db.prepare(`SELECT * FROM gmail_labels WHERE account_id IN (${accountIds.map(() => '?').join(',')}) ORDER BY type,name`).all(...accountIds) as DatabaseRow[]
      : this.stmt('SELECT * FROM gmail_labels ORDER BY account_id,type,name').all() as DatabaseRow[]
    return rows.map((row) => ({
      accountId: String(row.account_id),
      id: String(row.id),
      name: String(row.name),
      type: String(row.type) as MailLabel['type'],
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

  getProviderState<T>(accountId: string, fallback: T): T {
    const row = this.getSyncCheckpoint(accountId)
    return json<T>(row?.provider_state_json ? String(row.provider_state_json) : undefined, fallback)
  }

  setProviderState(accountId: string, state: unknown) {
    this.stmt('UPDATE gmail_sync_state SET provider_state_json=?,updated_at=? WHERE account_id=?')
      .run(JSON.stringify(state), nowIso(), accountId)
  }

  addInventory(accountId: string, items: { id: string; threadId: string; remoteFolderId?: string; remoteUid?: string }[]) {
    this.transaction(() => {
      const insert = this.stmt(`INSERT INTO gmail_sync_items(account_id,message_id,thread_id,status,remote_folder_id,remote_uid) VALUES(?,?,?,'pending',?,?)
        ON CONFLICT(account_id,message_id) DO UPDATE SET remote_folder_id=excluded.remote_folder_id,remote_uid=excluded.remote_uid`)
      for (const item of items) insert.run(accountId, item.id, item.threadId, item.remoteFolderId ?? null, item.remoteUid ?? null)
      const total = Number((this.stmt('SELECT COUNT(*) count FROM gmail_sync_items WHERE account_id=?').get(accountId) as DatabaseRow).count)
      this.stmt('UPDATE gmail_sync_state SET total=?,updated_at=? WHERE account_id=?').run(total, nowIso(), accountId)
    })
  }

  resetInventory(accountId: string) {
    this.transaction(() => {
      this.stmt('DELETE FROM gmail_sync_items WHERE account_id=?').run(accountId)
      this.stmt(`UPDATE gmail_sync_state SET phase='inventory',completed=0,total=0,transferred_bytes=0,page_token=NULL,inventory_complete=0,started_at=?,updated_at=?,message=NULL WHERE account_id=?`)
        .run(nowIso(), nowIso(), accountId)
    })
  }

  suggestRecipients(query: string, accountIds?: string[]): MailRecipientSuggestion[] {
    const where: string[] = []
    const params: string[] = []
    if (accountIds?.length) {
      where.push(`account_id IN (${accountIds.map(() => '?').join(',')})`)
      params.push(...accountIds)
    }
    if (query.trim()) {
      where.push(`(lower(email) LIKE ? ESCAPE '\\' OR lower(COALESCE(name,'')) LIKE ? ESCAPE '\\')`)
      const term = `%${query.trim().toLowerCase().replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
      params.push(term, term)
    }
    const sql = `SELECT account_id,email,name FROM gmail_recipients ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY last_used_at DESC LIMIT 12`
    return (this.db.prepare(sql).all(...params) as DatabaseRow[]).map((row) => ({
      accountId: String(row.account_id),
      email: String(row.email),
      name: row.name ? String(row.name) : undefined
    }))
  }

  completeInventory(accountId: string) {
    this.stmt('UPDATE gmail_sync_state SET inventory_complete=1,page_token=NULL,updated_at=? WHERE account_id=?').run(nowIso(), accountId)
  }

  retryFailedSyncItems(accountId: string) {
    this.stmt(`UPDATE gmail_sync_items SET status='pending',attempts=0,error=NULL WHERE account_id=? AND status='failed' AND attempts>=5`).run(accountId)
  }

  syncFailureCount(accountId: string) {
    return Number((this.stmt(`SELECT COUNT(*) count FROM gmail_sync_items WHERE account_id=? AND status='failed'`).get(accountId) as DatabaseRow).count)
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
    return (this.stmt(`SELECT message_id,thread_id,remote_folder_id,remote_uid FROM gmail_sync_items WHERE account_id=? AND (status='pending' OR (status='failed' AND attempts<5)) ORDER BY rowid LIMIT ?`).all(accountId, limit) as DatabaseRow[])
      .map((row) => ({ id: String(row.message_id), threadId: String(row.thread_id), remoteFolderId: row.remote_folder_id ? String(row.remote_folder_id) : undefined, remoteUid: row.remote_uid ? String(row.remote_uid) : undefined }))
  }

  markSyncItem(accountId: string, messageId: string, status: 'complete' | 'pending' | 'failed', error?: string) {
    this.stmt('UPDATE gmail_sync_items SET status=?,attempts=attempts+1,error=? WHERE account_id=? AND message_id=?').run(status, error ?? null, accountId, messageId)
  }

  upsertMessage(message: ParsedMailMessage) {
    const labels = new Set(message.labelIds)
    const syncItem = this.stmt('SELECT status FROM gmail_sync_items WHERE account_id=? AND message_id=?').get(message.accountId, message.id) as DatabaseRow | undefined
    const inventoryCompletion = Boolean(syncItem && syncItem.status !== 'complete')
    const existing = this.stmt('SELECT thread_id FROM gmail_messages WHERE account_id=? AND id=?').get(message.accountId, message.id) as DatabaseRow | undefined
    const previousThreadId = existing?.thread_id ? String(existing.thread_id) : undefined
    this.transaction(() => {
      this.stmt(`
        INSERT INTO gmail_threads(account_id,id,subject,participants_json,sender_email,snippet,last_date,unread,starred,important,trashed,draft,sent,inbox,has_attachments,message_count,label_ids_json)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)
        ON CONFLICT(account_id,id) DO UPDATE SET
          subject=CASE WHEN excluded.last_date>=gmail_threads.last_date THEN excluded.subject ELSE gmail_threads.subject END,
          sender_email=CASE WHEN excluded.last_date>=gmail_threads.last_date THEN excluded.sender_email ELSE gmail_threads.sender_email END,
          snippet=CASE WHEN excluded.last_date>=gmail_threads.last_date THEN excluded.snippet ELSE gmail_threads.snippet END,
          last_date=MAX(gmail_threads.last_date,excluded.last_date),
          unread=MAX(gmail_threads.unread,excluded.unread),starred=MAX(gmail_threads.starred,excluded.starred),
          important=MAX(gmail_threads.important,excluded.important),trashed=MIN(gmail_threads.trashed,excluded.trashed),
          draft=MAX(gmail_threads.draft,excluded.draft),sent=MAX(gmail_threads.sent,excluded.sent),
          inbox=MAX(gmail_threads.inbox,excluded.inbox),has_attachments=MAX(gmail_threads.has_attachments,excluded.has_attachments),
          message_count=(SELECT COUNT(*)+1 FROM gmail_messages WHERE account_id=excluded.account_id AND thread_id=excluded.id AND id<>?),
          label_ids_json=excluded.label_ids_json
      `).run(
        message.accountId, message.threadId, message.subject, JSON.stringify([message.fromName || message.fromEmail]), message.fromEmail,
        message.snippet, message.internalDate, labels.has('UNREAD') ? 1 : 0, labels.has('STARRED') ? 1 : 0,
        labels.has('IMPORTANT') ? 1 : 0, labels.has('TRASH') ? 1 : 0, labels.has('DRAFT') ? 1 : 0,
        labels.has('SENT') ? 1 : 0, labels.has('INBOX') ? 1 : 0, message.attachments.length ? 1 : 0,
        JSON.stringify(message.labelIds), message.id
      )
      this.stmt(`
        INSERT INTO gmail_messages(account_id,id,thread_id,history_id,internal_date,from_name,from_email,to_json,cc_json,subject,header_message_id,references_json,snippet,body_text,body_html,label_ids_json,size_estimate,raw_path,remote_folder_id,remote_uid)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(account_id,id) DO UPDATE SET thread_id=excluded.thread_id,history_id=excluded.history_id,internal_date=excluded.internal_date,
          from_name=excluded.from_name,from_email=excluded.from_email,to_json=excluded.to_json,cc_json=excluded.cc_json,
          subject=excluded.subject,header_message_id=excluded.header_message_id,references_json=excluded.references_json,
          snippet=excluded.snippet,body_text=excluded.body_text,body_html=excluded.body_html,
          label_ids_json=excluded.label_ids_json,size_estimate=excluded.size_estimate,raw_path=excluded.raw_path,
          remote_folder_id=excluded.remote_folder_id,remote_uid=excluded.remote_uid
      `).run(
        message.accountId, message.id, message.threadId, message.historyId, message.internalDate,
        message.fromName, message.fromEmail, JSON.stringify(message.to), JSON.stringify(message.cc), message.subject,
        message.messageIdHeader ?? null, JSON.stringify(message.references), message.snippet, message.text, message.html,
        JSON.stringify(message.labelIds), message.sizeEstimate, message.rawPath, message.remoteFolderId ?? null, message.remoteUid ?? null
      )
      this.stmt('DELETE FROM gmail_attachments WHERE account_id=? AND message_id=?').run(message.accountId, message.id)
      const insertAttachment = this.stmt('INSERT INTO gmail_attachments(account_id,message_id,id,filename,mime_type,size,content_id) VALUES(?,?,?,?,?,?,?)')
      for (const attachment of message.attachments) {
        insertAttachment.run(message.accountId, message.id, attachment.id, attachment.filename, attachment.mimeType, attachment.size, attachment.contentId ?? null)
      }
      this.stmt('DELETE FROM gmail_fts WHERE account_id=? AND message_id=?').run(message.accountId, message.id)
      this.stmt('INSERT INTO gmail_fts(account_id,message_id,thread_id,subject,sender,recipients,body,attachment_names) VALUES(?,?,?,?,?,?,?,?)')
        .run(message.accountId, message.id, message.threadId, message.subject, `${message.fromName} ${message.fromEmail}`, [...message.to, ...message.cc].join(' '), message.text, message.attachments.map((item) => item.filename).join(' '))
      const upsertRecipient = this.stmt(`INSERT INTO gmail_recipients(account_id,email,name,last_used_at) VALUES(?,?,?,?)
        ON CONFLICT(account_id,email) DO UPDATE SET name=COALESCE(excluded.name,gmail_recipients.name),last_used_at=MAX(gmail_recipients.last_used_at,excluded.last_used_at)`)
      const recipients = [{ name: message.fromName || undefined, email: message.fromEmail.toLowerCase() }, ...[...message.to, ...message.cc].map(addressParts)]
      for (const recipient of recipients) {
        if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(recipient.email)) upsertRecipient.run(message.accountId, recipient.email, recipient.name ?? null, message.internalDate)
      }
      this.markSyncItem(message.accountId, message.id, 'complete')
      if (inventoryCompletion) {
        this.stmt('UPDATE gmail_sync_state SET completed=completed+1,transferred_bytes=transferred_bytes+?,updated_at=? WHERE account_id=?')
          .run(message.sizeEstimate, nowIso(), message.accountId)
      }
      this.rebuildThread(message.accountId, message.threadId)
      if (previousThreadId && previousThreadId !== message.threadId) this.rebuildThread(message.accountId, previousThreadId)
    })
  }

  hasMessage(accountId: string, messageId: string) {
    return Boolean(this.stmt('SELECT 1 found FROM gmail_messages WHERE account_id=? AND id=?').get(accountId, messageId))
  }

  remoteMessagesForThreads(accountId: string, threadIds: string[]) {
    if (!threadIds.length) return []
    const rows = this.db.prepare(`SELECT id,thread_id,remote_folder_id,remote_uid,label_ids_json FROM gmail_messages WHERE account_id=? AND thread_id IN (${threadIds.map(() => '?').join(',')})`).all(accountId, ...threadIds) as DatabaseRow[]
    return rows.map((row) => ({
      id: String(row.id),
      threadId: String(row.thread_id),
      remoteFolderId: row.remote_folder_id ? String(row.remote_folder_id) : undefined,
      remoteUid: row.remote_uid ? String(row.remote_uid) : undefined,
      labelIds: json<string[]>(String(row.label_ids_json), [])
    }))
  }

  reconcileRemoteFolder(accountId: string, remoteFolderId: string, currentIds: Set<string>) {
    const rows = this.stmt('SELECT id FROM gmail_messages WHERE account_id=? AND remote_folder_id=?').all(accountId, remoteFolderId) as DatabaseRow[]
    let removed = 0
    for (const row of rows) {
      const id = String(row.id)
      if (currentIds.has(id)) continue
      this.deleteMessage(accountId, id)
      this.stmt('DELETE FROM gmail_sync_items WHERE account_id=? AND message_id=?').run(accountId, id)
      removed += 1
    }
    return removed
  }

  updateMessageLabels(accountId: string, messageId: string, labelIds: string[], historyId: string, location?: { remoteFolderId: string; remoteUid: string }) {
    const row = this.stmt('SELECT thread_id FROM gmail_messages WHERE account_id=? AND id=?').get(accountId, messageId) as DatabaseRow | undefined
    if (!row) return
    if (location) this.stmt('UPDATE gmail_messages SET label_ids_json=?,history_id=?,remote_folder_id=?,remote_uid=? WHERE account_id=? AND id=?')
      .run(JSON.stringify(labelIds), historyId, location.remoteFolderId, location.remoteUid, accountId, messageId)
    else this.stmt('UPDATE gmail_messages SET label_ids_json=?,history_id=? WHERE account_id=? AND id=?').run(JSON.stringify(labelIds), historyId, accountId, messageId)
    this.rebuildThread(accountId, String(row.thread_id))
  }

  deleteMessage(accountId: string, messageId: string) {
    const row = this.stmt('SELECT thread_id,raw_path FROM gmail_messages WHERE account_id=? AND id=?').get(accountId, messageId) as DatabaseRow | undefined
    if (!row) {
      this.stmt('DELETE FROM gmail_sync_items WHERE account_id=? AND message_id=?').run(accountId, messageId)
      return
    }
    this.transaction(() => {
      this.stmt('DELETE FROM gmail_fts WHERE account_id=? AND message_id=?').run(accountId, messageId)
      this.stmt('DELETE FROM gmail_sync_items WHERE account_id=? AND message_id=?').run(accountId, messageId)
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
    const logical = this.logicalMessages(rows)
    const newest = logical.at(-1)!.row
    const labelSets = logical.map((message) => message.labels)
    const participants = Array.from(new Set(logical.map(({ row }) => String(row.from_name || row.from_email)).filter(Boolean)))
    const allLabels = Array.from(new Set(logical.flatMap((message) => [...message.labels])))
    const attachments = Number((this.stmt('SELECT COUNT(*) count FROM gmail_attachments a JOIN gmail_messages m ON m.account_id=a.account_id AND m.id=a.message_id WHERE m.account_id=? AND m.thread_id=?').get(accountId, threadId) as DatabaseRow).count)
    this.stmt(`
      UPDATE gmail_threads SET subject=?,participants_json=?,sender_email=?,snippet=?,last_date=?,unread=?,starred=?,important=?,trashed=?,draft=?,sent=?,inbox=?,has_attachments=?,message_count=?,label_ids_json=?
      WHERE account_id=? AND id=?
    `).run(
      String(newest.subject), JSON.stringify(participants), String(newest.from_email), String(newest.snippet), String(newest.internal_date),
      labelSets.some((set) => set.has('UNREAD')) ? 1 : 0, labelSets.some((set) => set.has('STARRED')) ? 1 : 0,
      labelSets.some((set) => set.has('IMPORTANT')) ? 1 : 0, labelSets.every((set) => set.has('TRASH')) ? 1 : 0,
      labelSets.some((set) => set.has('DRAFT')) ? 1 : 0, labelSets.some((set) => set.has('SENT')) ? 1 : 0,
      labelSets.some((set) => set.has('INBOX')) ? 1 : 0, attachments ? 1 : 0, logical.length, JSON.stringify(allLabels), accountId, threadId
    )
  }

  private logicalMessages(rows: DatabaseRow[]) {
    const grouped = new Map<string, { row: DatabaseRow; labels: Set<string> }>()
    for (const row of rows) {
      const header = row.header_message_id ? String(row.header_message_id).trim().toLowerCase() : ''
      const key = header || `local:${String(row.id)}`
      const existing = grouped.get(key)
      if (!existing) grouped.set(key, { row, labels: new Set(json<string[]>(String(row.label_ids_json), [])) })
      else {
        for (const label of json<string[]>(String(row.label_ids_json), [])) existing.labels.add(label)
        if (String(row.internal_date) > String(existing.row.internal_date)) existing.row = row
      }
    }
    return [...grouped.values()].sort((left, right) => String(left.row.internal_date).localeCompare(String(right.row.internal_date)))
  }

  folderUnreadCounts(accountIds?: string[]): MailFolderUnreadCounts {
    const accountFilter = accountIds?.length
      ? `AND t.account_id IN (${accountIds.map(() => '?').join(',')})`
      : ''
    const row = this.db.prepare(`
      WITH unread_threads AS (
        SELECT t.*,
          EXISTS(
            SELECT 1 FROM mail_snoozes s
            WHERE s.account_id=t.account_id AND s.thread_id=t.id AND s.snoozed_until>?
          ) AS snoozed
        FROM gmail_threads t
        JOIN gmail_accounts a ON a.id=t.account_id
        WHERE t.unread=1 ${accountFilter}
      )
      SELECT
        COALESCE(SUM(CASE WHEN inbox=1 AND trashed=0 AND snoozed=0 THEN 1 ELSE 0 END),0) AS inbox,
        COALESCE(SUM(CASE WHEN starred=1 AND trashed=0 AND snoozed=0 THEN 1 ELSE 0 END),0) AS starred,
        COALESCE(SUM(CASE WHEN important=1 AND trashed=0 AND snoozed=0 THEN 1 ELSE 0 END),0) AS important,
        COALESCE(SUM(CASE WHEN sent=1 AND trashed=0 AND snoozed=0 THEN 1 ELSE 0 END),0) AS sent,
        COALESCE(SUM(CASE WHEN draft=1 AND trashed=0 AND snoozed=0 THEN 1 ELSE 0 END),0) AS drafts,
        COALESCE(SUM(CASE WHEN snoozed=1 THEN 1 ELSE 0 END),0) AS snoozed,
        COALESCE(SUM(CASE WHEN inbox=0 AND trashed=0 AND sent=0 AND draft=0 AND snoozed=0
          AND NOT EXISTS(SELECT 1 FROM json_each(label_ids_json) WHERE value='SPAM') THEN 1 ELSE 0 END),0) AS archive,
        COALESCE(SUM(CASE WHEN snoozed=0 AND EXISTS(SELECT 1 FROM json_each(label_ids_json) WHERE value='SPAM') THEN 1 ELSE 0 END),0) AS spam,
        COALESCE(SUM(CASE WHEN trashed=1 AND snoozed=0 THEN 1 ELSE 0 END),0) AS trash,
        COALESCE(SUM(CASE WHEN trashed=0 AND snoozed=0
          AND NOT EXISTS(SELECT 1 FROM json_each(label_ids_json) WHERE value='SPAM') THEN 1 ELSE 0 END),0) AS all_mail
      FROM unread_threads
    `).get(nowIso(), ...(accountIds ?? [])) as DatabaseRow
    return {
      inbox: Number(row.inbox),
      starred: Number(row.starred),
      important: Number(row.important),
      sent: Number(row.sent),
      drafts: Number(row.drafts),
      scheduled: 0,
      snoozed: Number(row.snoozed),
      archive: Number(row.archive),
      spam: Number(row.spam),
      trash: Number(row.trash),
      all: Number(row.all_mail)
    }
  }

  accountUnreadCounts(): MailAccountUnreadCounts {
    const rows = this.db.prepare(`
      SELECT t.account_id,COUNT(*) AS unread
      FROM gmail_threads t
      JOIN gmail_accounts a ON a.id=t.account_id
      WHERE t.unread=1 AND t.inbox=1 AND t.trashed=0
        AND NOT EXISTS(
          SELECT 1 FROM mail_snoozes s
          WHERE s.account_id=t.account_id AND s.thread_id=t.id AND s.snoozed_until>?
        )
      GROUP BY t.account_id
    `).all(nowIso()) as DatabaseRow[]
    return Object.fromEntries(rows.map((row) => [String(row.account_id), Number(row.unread)]))
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
    if (folder === 'scheduled') where.push('0=1')
    if (folder === 'snoozed') where.push(`EXISTS(SELECT 1 FROM mail_snoozes s WHERE s.account_id=t.account_id AND s.thread_id=t.id AND s.snoozed_until>?)`)
    if (folder === 'archive') where.push(`t.inbox=0 AND t.trashed=0 AND t.sent=0 AND t.draft=0 AND NOT EXISTS(SELECT 1 FROM json_each(t.label_ids_json) WHERE value='SPAM')`)
    if (folder === 'spam') where.push(`EXISTS(SELECT 1 FROM json_each(t.label_ids_json) WHERE value='SPAM')`)
    if (folder === 'trash') where.push('t.trashed=1')
    if (folder === 'all') where.push(`t.trashed=0 AND NOT EXISTS(SELECT 1 FROM json_each(t.label_ids_json) WHERE value='SPAM')`)
    if (folder === 'snoozed') params.push(nowIso())
    else where.push(`NOT EXISTS(SELECT 1 FROM mail_snoozes s WHERE s.account_id=t.account_id AND s.thread_id=t.id AND s.snoozed_until>?)`), params.push(nowIso())
    if (query.labelId) {
      where.push(`EXISTS(SELECT 1 FROM json_each(t.label_ids_json) WHERE value=?)`)
      params.push(query.labelId)
    }
    const filters = query.filters
    if (filters?.from?.trim()) {
      where.push(`EXISTS(SELECT 1 FROM gmail_messages m WHERE m.account_id=t.account_id AND m.thread_id=t.id AND lower(m.from_name||' '||m.from_email) LIKE lower(?) ESCAPE '\\')`)
      params.push(containsPattern(filters.from))
    }
    if (filters?.to?.trim()) {
      where.push(`EXISTS(SELECT 1 FROM gmail_messages m WHERE m.account_id=t.account_id AND m.thread_id=t.id AND lower(m.to_json||' '||m.cc_json) LIKE lower(?) ESCAPE '\\')`)
      params.push(containsPattern(filters.to))
    }
    if (filters?.subject?.trim()) {
      where.push(`EXISTS(SELECT 1 FROM gmail_messages m WHERE m.account_id=t.account_id AND m.thread_id=t.id AND lower(m.subject) LIKE lower(?) ESCAPE '\\')`)
      params.push(containsPattern(filters.subject))
    }
    if (filters?.attachmentName?.trim()) {
      where.push(`EXISTS(SELECT 1 FROM gmail_attachments x JOIN gmail_messages m ON m.account_id=x.account_id AND m.id=x.message_id WHERE m.account_id=t.account_id AND m.thread_id=t.id AND lower(x.filename) LIKE lower(?) ESCAPE '\\')`)
      params.push(containsPattern(filters.attachmentName))
    }
    if (filters?.dateFrom?.trim()) {
      where.push('datetime(t.last_date)>=datetime(?)')
      params.push(filters.dateFrom.trim())
    }
    if (filters?.dateTo?.trim()) {
      where.push(`datetime(t.last_date)<datetime(?, '+1 day')`)
      params.push(filters.dateTo.trim())
    }
    if (typeof filters?.hasAttachments === 'boolean') {
      where.push('t.has_attachments=?')
      params.push(filters.hasAttachments ? 1 : 0)
    }
    if (typeof filters?.unread === 'boolean') {
      where.push('t.unread=?')
      params.push(filters.unread ? 1 : 0)
    }
    if (typeof filters?.starred === 'boolean') {
      where.push('t.starred=?')
      params.push(filters.starred ? 1 : 0)
    }
    if (typeof filters?.important === 'boolean') {
      where.push('t.important=?')
      params.push(filters.important ? 1 : 0)
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
    const sql = `SELECT t.*,(SELECT snoozed_until FROM mail_snoozes s WHERE s.account_id=t.account_id AND s.thread_id=t.id) snoozed_until FROM gmail_threads t JOIN gmail_accounts a ON a.id=t.account_id ${join} WHERE ${where.join(' AND ')} ORDER BY t.last_date DESC,t.id DESC,t.account_id DESC LIMIT ?`
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
      senderEmail: String(row.sender_email || ''),
      snippet: String(row.snippet),
      lastDate: String(row.last_date),
      unread: Boolean(row.unread),
      starred: Boolean(row.starred),
      important: Boolean(row.important),
      trashed: Boolean(row.trashed),
      draft: Boolean(row.draft),
      hasAttachments: Boolean(row.has_attachments),
      messageCount: Number(row.message_count),
      labelIds: json<string[]>(String(row.label_ids_json), []),
      snoozedUntil: row.snoozed_until ? String(row.snoozed_until) : undefined
    }))
    const last = items.at(-1)
    return {
      items,
      total,
      nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ date: last.lastDate, id: last.id, accountId: last.accountId })).toString('base64url') : undefined
    }
  }

  getThread(accountId: string, threadId: string): MailThreadDetail {
    const rows = this.stmt('SELECT * FROM gmail_messages WHERE account_id=? AND thread_id=? ORDER BY internal_date').all(accountId, threadId) as DatabaseRow[]
    if (!rows.length) throw new Error('Thread not found')
    const messages: MailMessageDetail[] = this.logicalMessages(rows).map(({ row, labels }) => ({
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
      labelIds: [...labels],
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
    if (action === 'move') return { add: labelId ? [labelId] : [], remove: [] as string[] }
    return { add: [] as string[], remove: [] as string[] }
  }

  private inverseAction(action: MailActionKind): MailActionKind {
    const inverses: Record<MailActionKind, MailActionKind> = {
      archive: 'unarchive', unarchive: 'archive', read: 'unread', unread: 'read',
      star: 'unstar', unstar: 'star', important: 'unimportant', unimportant: 'important',
      trash: 'untrash', untrash: 'trash', label: 'unlabel', unlabel: 'label', move: 'move'
    }
    return inverses[action]
  }

  applyLocalAction(input: ApplyMailActionInput, operationId: string = crypto.randomUUID(), delayMs = 10_000): PendingOperation {
    if (!this.getAccount(input.accountId)) throw new Error('Account not found')
    if (!input.threadIds.length) throw new Error('Select at least one conversation')
    if ((input.action === 'label' || input.action === 'unlabel' || input.action === 'move') && !input.labelId) throw new Error(input.action === 'move' ? 'Choose a destination' : 'Choose a label')
    const provider = this.getAccount(input.accountId)!.provider
    const destinationLabel = input.labelId ? this.stmt('SELECT name FROM gmail_labels WHERE account_id=? AND id=?').get(input.accountId, input.labelId) as DatabaseRow | undefined : undefined
    const created = nowIso()
    const undoUntil = new Date(Date.now() + delayMs).toISOString()
    const { add, remove } = this.actionLabels(input.action, input.labelId)
    const beforeLabels: Record<string, string[]> = {}
    this.transaction(() => {
      for (const threadId of input.threadIds) {
        const messageRows = this.stmt('SELECT id,label_ids_json FROM gmail_messages WHERE account_id=? AND thread_id=?').all(input.accountId, threadId) as DatabaseRow[]
        if (!messageRows.length) throw new Error(`Conversation ${threadId} was not found`)
        for (const row of messageRows) {
          const original = json<string[]>(String(row.label_ids_json), [])
          beforeLabels[String(row.id)] = original
          const labels = new Set(original)
          if (input.action === 'trash') labels.add('TRASH')
          else if (input.action === 'untrash') labels.delete('TRASH')
          else if (input.action === 'move' && input.labelId) {
            if (provider !== 'gmail') for (const label of [...labels]) if (label.startsWith('folder:')) labels.delete(label)
            for (const label of ['INBOX', 'TRASH', 'SPAM', 'ARCHIVE']) labels.delete(label)
            labels.add(input.labelId)
            const destination = String(destinationLabel?.name ?? input.labelId).toLowerCase()
            if (input.labelId === 'INBOX' || destination === 'inbox') labels.add('INBOX')
            else if (input.labelId === 'TRASH' || /trash|deleted/.test(destination)) labels.add('TRASH')
            else if (input.labelId === 'SPAM' || /spam|junk/.test(destination)) labels.add('SPAM')
            else if (input.labelId === 'ARCHIVE' || destination.includes('archive')) labels.add('ARCHIVE')
          }
          else {
            add.forEach((label) => labels.add(label))
            remove.forEach((label) => labels.delete(label))
          }
          this.stmt('UPDATE gmail_messages SET label_ids_json=? WHERE account_id=? AND id=?').run(JSON.stringify([...labels]), input.accountId, String(row.id))
        }
        this.rebuildThread(input.accountId, threadId)
      }
      this.stmt(`
        INSERT INTO gmail_operations(id,account_id,thread_ids_json,kind,label_id,inverse_kind,status,execute_after,undo_until,created_at,updated_at,before_labels_json)
        VALUES(?,?,?,?,?,?,'queued',?,?,?,?,?)
      `).run(operationId, input.accountId, JSON.stringify(input.threadIds), input.action, input.labelId ?? null, this.inverseAction(input.action), undoUntil, undoUntil, created, created, JSON.stringify(beforeLabels))
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
      this.restoreOperationSnapshot(operationId, 'cancelled')
      return true
    }
    this.applyLocalAction(input, crypto.randomUUID(), 0)
    return true
  }

  dueOperations(limit = 20) {
    return this.stmt(`SELECT * FROM gmail_operations WHERE status='queued' AND execute_after<=? ORDER BY created_at LIMIT ?`).all(nowIso(), limit) as DatabaseRow[]
  }

  updateOperation(id: string, status: PendingOperation['status'], error?: string) {
    this.stmt(`UPDATE gmail_operations SET status=?,attempts=attempts+CASE WHEN ?='running' THEN 1 ELSE 0 END,error=?,updated_at=? WHERE id=?`).run(status, status, error ?? null, nowIso(), id)
  }

  rescheduleOperation(id: string, error: string, delayMs: number) {
    this.stmt(`UPDATE gmail_operations SET status='queued',execute_after=?,error=?,updated_at=? WHERE id=?`).run(new Date(Date.now() + delayMs).toISOString(), error, nowIso(), id)
  }

  operationAttempts(id: string) {
    return Number((this.stmt('SELECT attempts FROM gmail_operations WHERE id=?').get(id) as DatabaseRow | undefined)?.attempts ?? 0)
  }

  restoreOperationSnapshot(id: string, status: 'cancelled' | 'failed', error?: string) {
    const row = this.stmt('SELECT * FROM gmail_operations WHERE id=?').get(id) as DatabaseRow | undefined
    if (!row) return false
    const accountId = String(row.account_id)
    const threads = json<string[]>(String(row.thread_ids_json), [])
    const snapshot = json<Record<string, string[]>>(String(row.before_labels_json), {})
    this.transaction(() => {
      for (const [messageId, labels] of Object.entries(snapshot)) {
        this.stmt('UPDATE gmail_messages SET label_ids_json=? WHERE account_id=? AND id=?').run(JSON.stringify(labels), accountId, messageId)
      }
      for (const threadId of threads) this.rebuildThread(accountId, threadId)
      this.stmt('UPDATE gmail_operations SET status=?,error=?,updated_at=? WHERE id=?').run(status, error ?? null, nowIso(), id)
    })
    return true
  }

  recoverInterruptedWork() {
    const timestamp = nowIso()
    this.stmt(`UPDATE gmail_operations SET status='queued',execute_after=?,error='Recovered after Aerio closed during the provider request',updated_at=? WHERE status='running'`).run(timestamp, timestamp)
    this.stmt(`UPDATE gmail_drafts SET status='failed',error='Aerio closed while this draft was being saved or sent. Review it before retrying.',updated_at=? WHERE status='syncing'`).run(timestamp)
  }

  saveDraft(input: MailDraftInput, result: Partial<MailDraftResult> = {}): MailDraftResult {
    const id = input.id ?? crypto.randomUUID()
    const existing = this.getDraft(id)
    if (existing && input.expectedUpdatedAt && String(existing.updated_at) !== input.expectedUpdatedAt) {
      throw new Error('This draft changed after it was opened. Your version was not overwritten; save it as a copy to keep both versions.')
    }
    if (existing && input.expectedRemoteRevision && String(existing.remote_revision ?? '') !== input.expectedRemoteRevision) {
      throw new Error('This draft changed after it was opened in another mail client. Your version was not overwritten; save it as a copy to keep both versions.')
    }
    const existingUpdatedAt = existing?.updated_at ? Date.parse(String(existing.updated_at)) : 0
    const updatedAt = new Date(Math.max(Date.now(), Number.isFinite(existingUpdatedAt) ? existingUpdatedAt + 1 : 0)).toISOString()
    const existingStatus = existing?.status ? String(existing.status) as MailDraftResult['status'] : undefined
    const retainedDelivery = existingStatus === 'scheduled' || existingStatus === 'send-pending' || existingStatus === 'queued'
    const status = result.status ?? (retainedDelivery ? existingStatus : 'local') ?? 'local'
    const deliveryAt = result.deliveryAt ?? (retainedDelivery && existing?.delivery_at ? String(existing.delivery_at) : undefined)
    this.stmt(`
      INSERT INTO gmail_drafts(id,account_id,gmail_draft_id,remote_revision,thread_id,in_reply_to,references_json,to_json,cc_json,bcc_json,subject,body_text,body_html,attachment_paths_json,status,delivery_at,error,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET gmail_draft_id=COALESCE(excluded.gmail_draft_id,gmail_drafts.gmail_draft_id),remote_revision=COALESCE(excluded.remote_revision,gmail_drafts.remote_revision),thread_id=excluded.thread_id,in_reply_to=excluded.in_reply_to,
        references_json=excluded.references_json,to_json=excluded.to_json,cc_json=excluded.cc_json,bcc_json=excluded.bcc_json,
        subject=excluded.subject,body_text=excluded.body_text,body_html=excluded.body_html,attachment_paths_json=excluded.attachment_paths_json,
        status=excluded.status,delivery_at=excluded.delivery_at,error=excluded.error,updated_at=excluded.updated_at
    `).run(
      id, input.accountId, result.remoteDraftId ?? null, result.remoteRevision ?? null, input.threadId ?? null, input.inReplyTo ?? null,
      JSON.stringify(input.references ?? []), JSON.stringify(input.to), JSON.stringify(input.cc), JSON.stringify(input.bcc),
      input.subject, input.text, input.html ?? null, JSON.stringify(input.attachmentPaths), status, deliveryAt ?? null, result.error ?? null, updatedAt
    )
    const stored = this.getDraft(id)
    return {
      id,
      remoteDraftId: stored?.gmail_draft_id ? String(stored.gmail_draft_id) : result.remoteDraftId,
      remoteRevision: stored?.remote_revision ? String(stored.remote_revision) : result.remoteRevision,
      status,
      updatedAt,
      deliveryAt,
      undoUntil: status === 'send-pending' ? deliveryAt : undefined,
      error: result.error
    }
  }

  getDraft(id: string) {
    return this.stmt('SELECT * FROM gmail_drafts WHERE id=?').get(id) as DatabaseRow | undefined
  }

  private draftRecord(row: DatabaseRow): MailDraftRecord {
    return {
      id: String(row.id),
      accountId: String(row.account_id),
      remoteDraftId: row.gmail_draft_id ? String(row.gmail_draft_id) : undefined,
      remoteRevision: row.remote_revision ? String(row.remote_revision) : undefined,
      threadId: row.thread_id ? String(row.thread_id) : undefined,
      inReplyTo: row.in_reply_to ? String(row.in_reply_to) : undefined,
      references: json<string[]>(String(row.references_json), []),
      to: json<string[]>(String(row.to_json), []),
      cc: json<string[]>(String(row.cc_json), []),
      bcc: json<string[]>(String(row.bcc_json), []),
      subject: String(row.subject),
      text: String(row.body_text),
      html: row.body_html ? String(row.body_html) : undefined,
      attachmentPaths: json<string[]>(String(row.attachment_paths_json), []),
      status: String(row.status) as MailDraftRecord['status'],
      updatedAt: String(row.updated_at),
      deliveryAt: row.delivery_at ? String(row.delivery_at) : undefined,
      undoUntil: String(row.status) === 'send-pending' && row.delivery_at ? String(row.delivery_at) : undefined,
      error: row.error ? String(row.error) : undefined
    }
  }

  getDraftRecord(id: string) {
    const row = this.getDraft(id)
    return row ? this.draftRecord(row) : undefined
  }

  listDrafts(accountIds?: string[]) {
    const where = [`status NOT IN ('sent','discarded','discard-queued')`]
    const params: string[] = []
    if (accountIds?.length) {
      where.push(`account_id IN (${accountIds.map(() => '?').join(',')})`)
      params.push(...accountIds)
    }
    return (this.db.prepare(`SELECT * FROM gmail_drafts WHERE ${where.join(' AND ')} ORDER BY updated_at DESC`).all(...params) as DatabaseRow[]).map((row) => this.draftRecord(row))
  }

  requestDraftDiscard(id: string): MailDraftResult {
    const row = this.getDraft(id)
    if (!row) throw new Error('Draft not found')
    const updatedAt = nowIso()
    this.stmt(`UPDATE gmail_drafts SET status='discard-queued',error=NULL,updated_at=? WHERE id=?`).run(updatedAt, id)
    return { id, remoteDraftId: row.gmail_draft_id ? String(row.gmail_draft_id) : undefined, status: 'discard-queued', updatedAt }
  }

  draftsToDiscard() {
    return this.stmt(`SELECT * FROM gmail_drafts WHERE status='discard-queued' ORDER BY updated_at LIMIT 20`).all() as DatabaseRow[]
  }

  deleteDraftRecord(id: string) {
    this.stmt('DELETE FROM gmail_drafts WHERE id=?').run(id)
  }

  queuedDrafts() {
    return this.stmt(`SELECT * FROM gmail_drafts WHERE status IN ('queued','send-pending','scheduled') AND COALESCE(delivery_at,updated_at)<=? ORDER BY COALESCE(delivery_at,updated_at) LIMIT 20`).all(nowIso()) as DatabaseRow[]
  }

  draftsToSync() {
    return this.stmt(`SELECT * FROM gmail_drafts WHERE status='local' ORDER BY updated_at LIMIT 20`).all() as DatabaseRow[]
  }

  updateDraftResult(id: string, result: MailDraftResult) {
    this.stmt('UPDATE gmail_drafts SET gmail_draft_id=?,remote_revision=COALESCE(?,remote_revision),status=?,delivery_at=?,error=?,updated_at=? WHERE id=?')
      .run(result.remoteDraftId ?? null, result.remoteRevision ?? null, result.status, result.deliveryAt ?? null, result.error ?? null, result.updatedAt, id)
  }

  cancelDraftDelivery(id: string): MailDraftResult {
    const row = this.getDraft(id)
    if (!row) throw new Error('The queued message was not found')
    if (!['send-pending', 'scheduled', 'queued'].includes(String(row.status))) throw new Error('This message can no longer be cancelled')
    const status: MailDraftResult['status'] = row.gmail_draft_id ? 'synced' : 'local'
    const updatedAt = nowIso()
    this.stmt('UPDATE gmail_drafts SET status=?,delivery_at=NULL,error=NULL,updated_at=? WHERE id=?').run(status, updatedAt, id)
    return { id, remoteDraftId: row.gmail_draft_id ? String(row.gmail_draft_id) : undefined, status, updatedAt }
  }

  snoozeThreads(accountId: string, threadIds: string[], until: string): MailSnooze[] {
    const createdAt = nowIso()
    const insert = this.stmt(`INSERT INTO mail_snoozes(account_id,thread_id,snoozed_until,created_at) VALUES(?,?,?,?)
      ON CONFLICT(account_id,thread_id) DO UPDATE SET snoozed_until=excluded.snoozed_until,created_at=excluded.created_at`)
    this.transaction(() => {
      for (const threadId of threadIds) {
        if (!this.stmt('SELECT 1 found FROM gmail_threads WHERE account_id=? AND id=?').get(accountId, threadId)) throw new Error(`Conversation ${threadId} was not found`)
        insert.run(accountId, threadId, until, createdAt)
      }
    })
    return threadIds.map((threadId) => ({ accountId, threadId, snoozedUntil: until }))
  }

  unsnoozeThreads(accountId: string, threadIds: string[]) {
    if (!threadIds.length) return false
    const result = this.db.prepare(`DELETE FROM mail_snoozes WHERE account_id=? AND thread_id IN (${threadIds.map(() => '?').join(',')})`).run(accountId, ...threadIds)
    return Number(result.changes) > 0
  }

  releaseDueSnoozes() {
    const rows = this.stmt('SELECT account_id,thread_id,snoozed_until FROM mail_snoozes WHERE snoozed_until<=? ORDER BY snoozed_until LIMIT 100').all(nowIso()) as DatabaseRow[]
    if (!rows.length) return [] as MailSnooze[]
    this.transaction(() => {
      const remove = this.stmt('DELETE FROM mail_snoozes WHERE account_id=? AND thread_id=?')
      for (const row of rows) remove.run(String(row.account_id), String(row.thread_id))
    })
    return rows.map((row) => ({ accountId: String(row.account_id), threadId: String(row.thread_id), snoozedUntil: String(row.snoozed_until) }))
  }

  private ruleRecord(row: DatabaseRow): MailRule {
    return {
      id: String(row.id),
      accountId: String(row.account_id),
      name: String(row.name),
      enabled: Boolean(row.enabled),
      match: String(row.match_mode) as MailRule['match'],
      conditions: json<MailRule['conditions']>(String(row.conditions_json), []),
      actions: json<MailRule['actions']>(String(row.actions_json), []),
      matchCount: Number(row.match_count),
      lastMatchedAt: row.last_matched_at ? String(row.last_matched_at) : undefined,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    }
  }

  listRules(accountIds?: string[]) {
    const rows = accountIds?.length
      ? this.db.prepare(`SELECT * FROM mail_rules WHERE account_id IN (${accountIds.map(() => '?').join(',')}) ORDER BY enabled DESC,name`).all(...accountIds) as DatabaseRow[]
      : this.stmt('SELECT * FROM mail_rules ORDER BY enabled DESC,name').all() as DatabaseRow[]
    return rows.map((row) => this.ruleRecord(row))
  }

  getRule(id: string) {
    const row = this.stmt('SELECT * FROM mail_rules WHERE id=?').get(id) as DatabaseRow | undefined
    return row ? this.ruleRecord(row) : undefined
  }

  saveRule(input: MailRuleInput): MailRule {
    if (!this.getAccount(input.accountId)) throw new Error('Account not found')
    const id = input.id ?? crypto.randomUUID()
    const timestamp = nowIso()
    this.stmt(`INSERT INTO mail_rules(id,account_id,name,enabled,match_mode,conditions_json,actions_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id,name=excluded.name,enabled=excluded.enabled,
      match_mode=excluded.match_mode,conditions_json=excluded.conditions_json,actions_json=excluded.actions_json,updated_at=excluded.updated_at`)
      .run(id, input.accountId, input.name, input.enabled ? 1 : 0, input.match, JSON.stringify(input.conditions), JSON.stringify(input.actions), timestamp, timestamp)
    return this.getRule(id)!
  }

  deleteRule(id: string) {
    this.stmt('DELETE FROM mail_rules WHERE id=?').run(id)
  }

  matchingRulesForMessage(message: MailRuleMessage) {
    return this.listRules([message.accountId]).filter((rule) => rule.enabled && mailRuleMatches(rule, message))
  }

  matchingThreadIdsForRule(rule: MailRule) {
    const rows = this.stmt(`SELECT m.* FROM gmail_messages m JOIN (
      SELECT account_id,thread_id,MAX(internal_date) internal_date FROM gmail_messages WHERE account_id=? GROUP BY account_id,thread_id
    ) newest ON newest.account_id=m.account_id AND newest.thread_id=m.thread_id AND newest.internal_date=m.internal_date
      WHERE m.account_id=? AND EXISTS(SELECT 1 FROM gmail_messages inbox,json_each(inbox.label_ids_json)
        WHERE inbox.account_id=m.account_id AND inbox.thread_id=m.thread_id AND value='INBOX')`).all(rule.accountId, rule.accountId) as DatabaseRow[]
    return [...new Set(rows.filter((row) => mailRuleMatches(rule, {
      accountId: rule.accountId,
      threadId: String(row.thread_id),
      fromName: String(row.from_name),
      fromEmail: String(row.from_email),
      to: json<string[]>(String(row.to_json), []),
      cc: json<string[]>(String(row.cc_json), []),
      subject: String(row.subject),
      text: String(row.body_text)
    })).map((row) => String(row.thread_id)))]
  }

  recordRuleMatch(id: string, count = 1) {
    if (count <= 0) return
    this.stmt('UPDATE mail_rules SET match_count=match_count+?,last_matched_at=?,updated_at=? WHERE id=?').run(count, nowIso(), nowIso(), id)
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

  diagnosticHealth(): MailDiagnosticHealth {
    const integrityRow = this.db.prepare('PRAGMA integrity_check').get() as DatabaseRow | undefined
    const integrityMessage = String(integrityRow?.integrity_check ?? Object.values(integrityRow ?? {})[0] ?? 'unknown')
    const accounts = this.listAccounts().map((account) => {
      const count = (sql: string, ...params: string[]) => Number((this.db.prepare(sql).get(...params) as DatabaseRow | undefined)?.count ?? 0)
      return {
        accountId: account.id,
        provider: account.provider,
        status: account.status,
        messages: count('SELECT COUNT(*) count FROM gmail_messages WHERE account_id=?', account.id),
        threads: count('SELECT COUNT(*) count FROM gmail_threads WHERE account_id=?', account.id),
        pendingDownloads: count(`SELECT COUNT(*) count FROM gmail_sync_items WHERE account_id=? AND status='pending'`, account.id),
        failedDownloads: count(`SELECT COUNT(*) count FROM gmail_sync_items WHERE account_id=? AND status='failed'`, account.id),
        queuedOperations: count(`SELECT COUNT(*) count FROM gmail_operations WHERE account_id=? AND status IN ('queued','running')`, account.id),
        failedOperations: count(`SELECT COUNT(*) count FROM gmail_operations WHERE account_id=? AND status='failed'`, account.id),
        editableDrafts: count(`SELECT COUNT(*) count FROM gmail_drafts WHERE account_id=? AND status NOT IN ('sent','discarded','discard-queued')`, account.id),
        failedDrafts: count(`SELECT COUNT(*) count FROM gmail_drafts WHERE account_id=? AND status='failed'`, account.id)
      }
    })
    const orphanedMessages = Number((this.db.prepare(`SELECT COUNT(*) count FROM gmail_messages m LEFT JOIN gmail_threads t ON t.account_id=m.account_id AND t.id=m.thread_id WHERE t.id IS NULL`).get() as DatabaseRow).count)
    const orphanedAttachments = Number((this.db.prepare(`SELECT COUNT(*) count FROM gmail_attachments a LEFT JOIN gmail_messages m ON m.account_id=a.account_id AND m.id=a.message_id WHERE m.id IS NULL`).get() as DatabaseRow).count)
    const paths = this.db.prepare('SELECT raw_path FROM gmail_messages').all() as DatabaseRow[]
    const missingRawFiles = paths.reduce((total, row) => total + (this.rawExists(String(row.raw_path)) ? 0 : 1), 0)
    return {
      generatedAt: nowIso(),
      integrity: integrityMessage === 'ok' ? 'ok' : 'error',
      integrityMessage,
      accounts,
      orphanedMessages,
      orphanedAttachments,
      missingRawFiles
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
