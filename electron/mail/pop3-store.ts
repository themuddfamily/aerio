import type { DatabaseSync } from 'node:sqlite'
import type { Pop3AccountStatus, Pop3Destination, Pop3RetentionPolicy, Pop3ServerSettings } from '../../src/pop3-types'
import { DEFAULT_POP3_RETENTION } from '../../src/pop3-types'

type Row = Record<string, string | number | bigint | null>

const nowIso = () => new Date().toISOString()
const json = <T>(value: unknown, fallback: T): T => {
  try { return typeof value === 'string' && value ? JSON.parse(value) as T : fallback } catch { return fallback }
}

export type Pop3UidlState = 'stored' | 'delete-pending' | 'deleted' | 'skipped'
export type Pop3RemovalReason = 'downloaded' | 'age' | 'deleted-in-aerio'

export interface Pop3StoredSettings {
  /** Connection settings without the password, kept so they survive a profile restore. */
  server: Pop3ServerSettings
  retention: Pop3RetentionPolicy
  destination: Pop3Destination
}

export interface Pop3UidlRow {
  uidl: string
  state: Pop3UidlState
  messageAccountId?: string
  messageId?: string
  size: number
  onServer: boolean
  downloadedAt: string
  removalReason?: Pop3RemovalReason
  deletedAt?: string
  error?: string
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Durable POP3 state in the mail database. `pop3_uidls` is the download
 * checkpoint: one row per server UIDL, written in the same transaction as the
 * stored message, so a message is either downloaded and recorded or neither.
 * Rows are kept after the local message is deleted so it is never downloaded
 * again, and they record whether Aerio has removed it from the server.
 */
export class Pop3Store {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pop3_accounts (
        account_id TEXT PRIMARY KEY REFERENCES gmail_accounts(id) ON DELETE CASCADE,
        server_json TEXT NOT NULL,
        retention_json TEXT NOT NULL,
        destination_json TEXT NOT NULL,
        last_check_at TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pop3_uidls (
        account_id TEXT NOT NULL REFERENCES gmail_accounts(id) ON DELETE CASCADE,
        uidl TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('stored','delete-pending','deleted','skipped')),
        message_account_id TEXT,
        message_id TEXT,
        size INTEGER NOT NULL DEFAULT 0,
        on_server INTEGER NOT NULL DEFAULT 1,
        downloaded_at TEXT NOT NULL,
        removal_reason TEXT,
        deleted_at TEXT,
        last_seen_at TEXT,
        error TEXT,
        PRIMARY KEY (account_id, uidl)
      );
      CREATE INDEX IF NOT EXISTS pop3_uidls_message ON pop3_uidls(message_account_id, message_id);
    `)
  }

  saveSettings(accountId: string, settings: Pop3StoredSettings) {
    this.db.prepare(`INSERT INTO pop3_accounts(account_id,server_json,retention_json,destination_json,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(account_id) DO UPDATE SET server_json=excluded.server_json,retention_json=excluded.retention_json,destination_json=excluded.destination_json,updated_at=excluded.updated_at`)
      .run(accountId, JSON.stringify(settings.server), JSON.stringify(settings.retention), JSON.stringify(settings.destination), nowIso())
  }

  settings(accountId: string): Pop3StoredSettings | undefined {
    const row = this.db.prepare('SELECT * FROM pop3_accounts WHERE account_id=?').get(accountId) as Row | undefined
    if (!row) return undefined
    return {
      server: json<Pop3ServerSettings>(row.server_json, undefined as unknown as Pop3ServerSettings),
      retention: { ...DEFAULT_POP3_RETENTION, ...json<Partial<Pop3RetentionPolicy>>(row.retention_json, {}) },
      destination: json<Pop3Destination>(row.destination_json, { kind: 'account' })
    }
  }

  recordCheck(accountId: string, error?: string) {
    this.db.prepare('UPDATE pop3_accounts SET last_check_at=?,last_error=? WHERE account_id=?').run(nowIso(), error ?? null, accountId)
  }

  private fromRow(row: Row): Pop3UidlRow {
    return {
      uidl: String(row.uidl),
      state: String(row.state) as Pop3UidlState,
      ...(row.message_account_id ? { messageAccountId: String(row.message_account_id) } : {}),
      ...(row.message_id ? { messageId: String(row.message_id) } : {}),
      size: Number(row.size),
      onServer: Boolean(row.on_server),
      downloadedAt: String(row.downloaded_at),
      ...(row.removal_reason ? { removalReason: String(row.removal_reason) as Pop3RemovalReason } : {}),
      ...(row.deleted_at ? { deletedAt: String(row.deleted_at) } : {}),
      ...(row.error ? { error: String(row.error) } : {})
    }
  }

  rows(accountId: string) {
    return new Map((this.db.prepare('SELECT * FROM pop3_uidls WHERE account_id=?').all(accountId) as Row[]).map((row) => [String(row.uidl), this.fromRow(row)]))
  }

  row(accountId: string, uidl: string) {
    const row = this.db.prepare('SELECT * FROM pop3_uidls WHERE account_id=? AND uidl=?').get(accountId, uidl) as Row | undefined
    return row ? this.fromRow(row) : undefined
  }

  /** Called inside the transaction that stores the message. */
  recordStored(accountId: string, uidl: string, stored: { messageAccountId: string; messageId: string; size: number }) {
    this.db.prepare(`INSERT INTO pop3_uidls(account_id,uidl,state,message_account_id,message_id,size,on_server,downloaded_at,last_seen_at) VALUES(?,?,'stored',?,?,?,1,?,?)
      ON CONFLICT(account_id,uidl) DO UPDATE SET state='stored',message_account_id=excluded.message_account_id,message_id=excluded.message_id,size=excluded.size,on_server=1,error=NULL`)
      .run(accountId, uidl, stored.messageAccountId, stored.messageId, stored.size, nowIso(), nowIso())
  }

  /** A message Aerio will not download (too large); it is left on the server and not retried. */
  recordSkipped(accountId: string, uidl: string, size: number, error: string) {
    this.db.prepare(`INSERT INTO pop3_uidls(account_id,uidl,state,size,on_server,downloaded_at,last_seen_at,error) VALUES(?,?,'skipped',?,1,?,?,?)
      ON CONFLICT(account_id,uidl) DO UPDATE SET state='skipped',size=excluded.size,error=excluded.error`)
      .run(accountId, uidl, size, nowIso(), nowIso(), error)
  }

  /**
   * Records which UIDLs the server lists now. A row the server no longer lists
   * stays (so the message is never downloaded again); a pending removal that
   * the server no longer lists has been removed.
   */
  markSeen(accountId: string, listed: Set<string>) {
    const timestamp = nowIso()
    const seen = this.db.prepare('UPDATE pop3_uidls SET on_server=1,last_seen_at=? WHERE account_id=? AND uidl=?')
    const gone = this.db.prepare(`UPDATE pop3_uidls SET on_server=0,state=CASE WHEN state='delete-pending' THEN 'deleted' ELSE state END,deleted_at=CASE WHEN state='delete-pending' THEN ? ELSE deleted_at END WHERE account_id=? AND uidl=?`)
    this.transaction(() => {
      for (const row of this.db.prepare('SELECT uidl FROM pop3_uidls WHERE account_id=?').all(accountId) as Row[]) {
        const uidl = String(row.uidl)
        if (listed.has(uidl)) seen.run(timestamp, accountId, uidl)
        else gone.run(timestamp, accountId, uidl)
      }
    })
  }

  /**
   * Downloaded messages the retention policy removes from the server now.
   * Only rows already committed as stored qualify. "Deleted in Aerio" means the
   * local copy is gone, or is in Trash with no undoable change still pending.
   */
  removalCandidates(accountId: string, policy: Pop3RetentionPolicy, now = Date.now()) {
    const rows = this.db.prepare(`
      SELECT u.uidl,u.downloaded_at,u.message_account_id,u.message_id,
        m.id present,
        CASE WHEN m.id IS NOT NULL AND EXISTS(SELECT 1 FROM json_each(m.label_ids_json) WHERE value='TRASH') THEN 1 ELSE 0 END trashed,
        CASE WHEN m.id IS NOT NULL AND EXISTS(
          SELECT 1 FROM gmail_operations o, json_each(o.thread_ids_json) t
          WHERE o.account_id=m.account_id AND o.status IN ('queued','running') AND t.value=m.thread_id
        ) THEN 1 ELSE 0 END undoable
      FROM pop3_uidls u
      LEFT JOIN gmail_messages m ON m.account_id=u.message_account_id AND m.id=u.message_id
      WHERE u.account_id=? AND u.on_server=1 AND u.state IN ('stored','delete-pending')
    `).all(accountId) as Row[]
    const result: { uidl: string; reason: Pop3RemovalReason }[] = []
    for (const row of rows) {
      const uidl = String(row.uidl)
      if (!policy.leaveOnServer) {
        result.push({ uidl, reason: 'downloaded' })
        continue
      }
      if (policy.removeWhenDeleted && (!row.present || (Number(row.trashed) === 1 && Number(row.undoable) === 0))) {
        result.push({ uidl, reason: 'deleted-in-aerio' })
        continue
      }
      if (policy.deleteAfterDays && Date.parse(String(row.downloaded_at)) <= now - policy.deleteAfterDays * DAY_MS) result.push({ uidl, reason: 'age' })
    }
    return result
  }

  /**
   * Durably records the removals before any DELE is sent. Earlier pending
   * removals that no longer qualify (the message was restored from Trash, or
   * the policy changed) go back to stored.
   */
  markRemovalPending(accountId: string, candidates: { uidl: string; reason: Pop3RemovalReason }[]) {
    const pending = this.db.prepare(`UPDATE pop3_uidls SET state='delete-pending',removal_reason=? WHERE account_id=? AND uidl=? AND state IN ('stored','delete-pending')`)
    this.transaction(() => {
      this.db.prepare(`UPDATE pop3_uidls SET state='stored',removal_reason=NULL WHERE account_id=? AND state='delete-pending' AND on_server=1`).run(accountId)
      for (const candidate of candidates) pending.run(candidate.reason, accountId, candidate.uidl)
    })
  }

  /** The server confirmed the session's UPDATE state, so these messages are gone. */
  markRemoved(accountId: string, uidls: string[]) {
    const removed = this.db.prepare(`UPDATE pop3_uidls SET state='deleted',on_server=0,deleted_at=? WHERE account_id=? AND uidl=? AND state='delete-pending'`)
    const timestamp = nowIso()
    this.transaction(() => { for (const uidl of uidls) removed.run(timestamp, accountId, uidl) })
  }

  /**
   * Forces committed transactions from the write-ahead log into the database
   * file (and to disk), so a message counts as durably stored before the
   * server is asked to remove it. Returns false if the checkpoint could not
   * complete; deletions then wait for the next session.
   */
  flushToDisk() {
    try {
      const result = this.db.prepare('PRAGMA wal_checkpoint(FULL)').get() as Row | undefined
      return !result || Number(result.busy) === 0
    } catch {
      return false
    }
  }

  status(accountId: string): Pop3AccountStatus {
    const count = (where: string) => Number((this.db.prepare(`SELECT COUNT(*) count FROM pop3_uidls WHERE account_id=? AND ${where}`).get(accountId) as Row).count)
    const account = this.db.prepare('SELECT last_check_at,last_error FROM pop3_accounts WHERE account_id=?').get(accountId) as Row | undefined
    return {
      accountId,
      downloaded: count(`state IN ('stored','delete-pending','deleted')`),
      onServer: count(`state IN ('stored','delete-pending') AND on_server=1`),
      pendingRemoval: count(`state='delete-pending'`),
      removedFromServer: count(`state='deleted'`),
      skipped: count(`state='skipped'`),
      ...(account?.last_check_at ? { lastCheckAt: String(account.last_check_at) } : {}),
      ...(account?.last_error ? { lastError: String(account.last_error) } : {})
    }
  }

  private transaction(callback: () => void) {
    this.db.exec('SAVEPOINT pop3_store')
    try {
      callback()
      this.db.exec('RELEASE pop3_store')
    } catch (error) {
      this.db.exec('ROLLBACK TO pop3_store')
      this.db.exec('RELEASE pop3_store')
      throw error
    }
  }
}
