import type { DatabaseSync, StatementSync } from 'node:sqlite'

/**
 * Local conversation pins (E34). A pin belongs to one account's conversation,
 * keyed by (account_id, thread_id). Pins are never sent to a provider, are not
 * tied to the cached thread row (so a resync that drops and re-creates the
 * thread keeps the pin), and are removed with the account when its local data
 * is deleted. They live in the mail database, so profile backups include them.
 */

interface DatabaseRow {
  [key: string]: string | number | bigint | null
}

/** threadId -> pinnedAt before an operation, or null when it was not pinned. */
export type MailPinSnapshot = Record<string, string | null>

/** Joins each listed thread to its pin; `p` is the pin alias used by the ordering fragments. */
export const MAIL_PIN_JOIN = 'LEFT JOIN mail_pins p ON p.account_id=t.account_id AND p.thread_id=t.id'
// Unpinned rows sort as '' which is below every ISO timestamp, so pinned rows come first.
const PIN_SORT_KEY = `COALESCE(p.pinned_at,'')`
/**
 * Pinned conversations first, most recently pinned on top, then the normal
 * newest-first date order. Pinned rows sort by pin time rather than by their
 * last message, so new mail never reshuffles the pinned group.
 */
export const MAIL_THREAD_ORDER = `${PIN_SORT_KEY} DESC,t.last_date DESC,t.id DESC,t.account_id DESC`
/** Keyset condition for the row after a cursor; it starts with a marker the count query filters out. */
export const MAIL_THREAD_CURSOR_CLAUSE = `(${PIN_SORT_KEY}<? OR (${PIN_SORT_KEY}=? AND (t.last_date<? OR (t.last_date=? AND (t.id<? OR (t.id=? AND t.account_id<?))))))`
export const MAIL_THREAD_CURSOR_PARAMS = 7

export interface MailThreadCursor {
  /** Empty when the cursor row was not pinned (the date-ordered partition). */
  pinnedAt: string
  date: string
  id: string
  accountId: string
}

export function encodeMailThreadCursor(cursor: MailThreadCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

/** Cursors issued before pinning existed carry no pinnedAt and continue in the unpinned partition. */
export function decodeMailThreadCursor(value: string): MailThreadCursor {
  let parsed: Partial<Record<keyof MailThreadCursor, unknown>> = {}
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
    if (decoded && typeof decoded === 'object') parsed = decoded as typeof parsed
  } catch {
    parsed = {}
  }
  const text = (item: unknown) => typeof item === 'string' ? item : ''
  return { pinnedAt: text(parsed.pinnedAt), date: text(parsed.date), id: text(parsed.id), accountId: text(parsed.accountId) }
}

export function mailThreadCursorParams(cursor: MailThreadCursor) {
  return [cursor.pinnedAt, cursor.pinnedAt, cursor.date, cursor.date, cursor.id, cursor.id, cursor.accountId]
}

const UNDO_RETENTION_MS = 7 * 24 * 60 * 60_000

export class MailPinStore {
  private statements = new Map<string, StatementSync>()

  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mail_pins (
        account_id TEXT NOT NULL REFERENCES gmail_accounts(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL,
        pinned_at TEXT NOT NULL,
        PRIMARY KEY (account_id, thread_id)
      );
      CREATE TABLE IF NOT EXISTS mail_pin_operations (
        operation_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES gmail_accounts(id) ON DELETE CASCADE,
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `)
  }

  private stmt(sql: string) {
    let statement = this.statements.get(sql)
    if (!statement) {
      statement = this.db.prepare(sql)
      this.statements.set(sql, statement)
    }
    return statement
  }

  pinnedAt(accountId: string, threadId: string) {
    const row = this.stmt('SELECT pinned_at FROM mail_pins WHERE account_id=? AND thread_id=?').get(accountId, threadId) as DatabaseRow | undefined
    return row ? String(row.pinned_at) : undefined
  }

  snapshot(accountId: string, threadIds: string[]): MailPinSnapshot {
    return Object.fromEntries([...new Set(threadIds)].map((threadId) => [threadId, this.pinnedAt(accountId, threadId) ?? null]))
  }

  /**
   * Pins or unpins conversations and returns their prior state. Re-pinning an
   * already pinned conversation keeps its original pin time and position.
   */
  set(accountId: string, threadIds: string[], pinned: boolean, at = new Date().toISOString()): MailPinSnapshot {
    const before = this.snapshot(accountId, threadIds)
    for (const threadId of Object.keys(before)) {
      if (pinned) this.stmt('INSERT INTO mail_pins(account_id,thread_id,pinned_at) VALUES(?,?,?) ON CONFLICT(account_id,thread_id) DO NOTHING').run(accountId, threadId, at)
      else this.stmt('DELETE FROM mail_pins WHERE account_id=? AND thread_id=?').run(accountId, threadId)
    }
    return before
  }

  recordUndo(operationId: string, accountId: string, snapshot: MailPinSnapshot, at = new Date()) {
    this.stmt('DELETE FROM mail_pin_operations WHERE created_at<?').run(new Date(at.getTime() - UNDO_RETENTION_MS).toISOString())
    this.stmt('INSERT INTO mail_pin_operations(operation_id,account_id,snapshot_json,created_at) VALUES(?,?,?,?)').run(operationId, accountId, JSON.stringify(snapshot), at.toISOString())
  }

  /** Restores the exact pin state captured before an operation; false when no snapshot remains. */
  restore(operationId: string) {
    const row = this.stmt('SELECT account_id,snapshot_json FROM mail_pin_operations WHERE operation_id=?').get(operationId) as DatabaseRow | undefined
    if (!row) return false
    const accountId = String(row.account_id)
    let snapshot: MailPinSnapshot = {}
    try { snapshot = JSON.parse(String(row.snapshot_json)) as MailPinSnapshot } catch { snapshot = {} }
    for (const [threadId, pinnedAt] of Object.entries(snapshot)) {
      if (typeof pinnedAt === 'string') this.stmt('INSERT INTO mail_pins(account_id,thread_id,pinned_at) VALUES(?,?,?) ON CONFLICT(account_id,thread_id) DO UPDATE SET pinned_at=excluded.pinned_at').run(accountId, threadId, pinnedAt)
      else this.stmt('DELETE FROM mail_pins WHERE account_id=? AND thread_id=?').run(accountId, threadId)
    }
    this.stmt('DELETE FROM mail_pin_operations WHERE operation_id=?').run(operationId)
    return true
  }

  count(accountId?: string) {
    const row = (accountId
      ? this.stmt('SELECT COUNT(*) count FROM mail_pins WHERE account_id=?').get(accountId)
      : this.stmt('SELECT COUNT(*) count FROM mail_pins').get()) as DatabaseRow
    return Number(row.count)
  }
}
