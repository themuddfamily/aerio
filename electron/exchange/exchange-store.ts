import { DatabaseSync } from 'node:sqlite'
import type { CalendarEvent, Contact } from '../../src/types'
import type { SyncedCalendarEvent, SyncedContact } from '../../src/productivity-types'
import type { ExchangeAccountStatus, ExchangeReviewStatus } from '../../src/exchange-types'

// Exchange Calendar and Contacts state (exchange.sqlite): per-account status, discovered calendar
// and contacts folders with their SyncFolderItems states, the last synchronized copy of every item
// with its ChangeKey, and a durable queue of local writes with conflict review. Passwords and
// tokens are never stored here; they live in the OS-encrypted credential vault with the mail
// account. Mail itself is stored by the mail worker in aerio.sqlite.

export interface ExchangeAccountRecord {
  accountId: string
  status: ExchangeAccountStatus
  error?: string
  lastSyncedAt?: string
  serverVersion?: string
}

export interface ExchangeFolderRecord {
  key: string
  accountId: string
  folderId: string
  kind: 'calendar' | 'contacts'
  name: string
  color: string
  canWrite: boolean
  primary: boolean
  syncState?: string
  lastSyncedAt?: string
  error?: string
}

export interface ExchangeItemRecord {
  accountId: string
  folderKey: string
  itemId: string
  kind: 'event' | 'contact'
  changeKey?: string
  /** A calendar master maps to the series plus its modified occurrences. */
  events?: SyncedCalendarEvent[]
  /** ChangeKeys of the master and each modified occurrence, by ItemId. */
  changeKeys?: Record<string, string>
  contact?: SyncedContact
}

export type ExchangeOperationStatus = 'queued' | ExchangeReviewStatus

export interface ExchangeOperationRecord {
  id: string
  accountId: string
  folderKey: string
  kind: 'event' | 'contact'
  action: 'create' | 'update' | 'delete'
  /** The id the change is shown under in Calendar/Contacts. */
  localId: string
  /** Target EWS item (updates/deletes); absent for creates until the server assigns one. */
  itemId?: string
  changeKey?: string
  /** One generated occurrence of a series, addressed by its master and 1-based InstanceIndex. */
  occurrence?: { masterItemId: string; masterEventId: string; instanceIndex: number; originalStart: string }
  /** The edited record (create/update). */
  data?: CalendarEvent | Contact
  /** The synchronized record the edit was made against, used to send only changed fields. */
  base?: SyncedCalendarEvent | SyncedContact
  status: ExchangeOperationStatus
  error?: string
  attempts: number
  nextAttemptAt?: string
  serverData?: SyncedCalendarEvent | SyncedContact
  serverChangeKey?: string
  serverDeleted?: boolean
  createdAt: string
  updatedAt: string
}

export const RESTORED_EXCHANGE_WRITE_MESSAGE = 'Held after restoring a profile backup. Send it again if the change is still needed.'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS exchange_accounts(account_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS exchange_folders(key TEXT PRIMARY KEY, account_id TEXT NOT NULL, payload_json TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS exchange_folders_account ON exchange_folders(account_id);
  CREATE TABLE IF NOT EXISTS exchange_items(account_id TEXT NOT NULL, item_id TEXT NOT NULL, folder_key TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(account_id,item_id));
  CREATE INDEX IF NOT EXISTS exchange_items_folder ON exchange_items(folder_key);
  CREATE TABLE IF NOT EXISTS exchange_operations(id TEXT PRIMARY KEY, account_id TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS exchange_operations_account ON exchange_operations(account_id, created_at);
`

interface PayloadRow { payload_json: string }

export class ExchangeStore {
  private readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;')
    this.db.exec(SCHEMA)
  }

  close() { this.db.close() }

  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private rows<T>(sql: string, ...params: (string | number)[]) {
    return (this.db.prepare(sql).all(...params) as unknown as PayloadRow[]).map((row) => JSON.parse(row.payload_json) as T)
  }

  private row<T>(sql: string, ...params: (string | number)[]) {
    const row = this.db.prepare(sql).get(...params) as unknown as PayloadRow | undefined
    return row ? JSON.parse(row.payload_json) as T : undefined
  }

  // Accounts
  accounts() { return this.rows<ExchangeAccountRecord>('SELECT payload_json FROM exchange_accounts ORDER BY account_id') }
  account(accountId: string) { return this.row<ExchangeAccountRecord>('SELECT payload_json FROM exchange_accounts WHERE account_id=?', accountId) }
  saveAccount(record: ExchangeAccountRecord) {
    this.db.prepare('INSERT INTO exchange_accounts(account_id,payload_json,updated_at) VALUES(?,?,?) ON CONFLICT(account_id) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at')
      .run(record.accountId, JSON.stringify(record), new Date().toISOString())
  }
  removeAccount(accountId: string) {
    this.transaction(() => {
      for (const table of ['exchange_accounts', 'exchange_folders', 'exchange_items', 'exchange_operations']) this.db.prepare(`DELETE FROM ${table} WHERE account_id=?`).run(accountId)
    })
  }

  // Folders
  folders(accountId?: string) {
    return accountId
      ? this.rows<ExchangeFolderRecord>('SELECT payload_json FROM exchange_folders WHERE account_id=? ORDER BY key', accountId)
      : this.rows<ExchangeFolderRecord>('SELECT payload_json FROM exchange_folders ORDER BY key')
  }
  folder(key: string) { return this.row<ExchangeFolderRecord>('SELECT payload_json FROM exchange_folders WHERE key=?', key) }
  saveFolder(record: ExchangeFolderRecord) {
    this.db.prepare('INSERT INTO exchange_folders(key,account_id,payload_json) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET payload_json=excluded.payload_json').run(record.key, record.accountId, JSON.stringify(record))
  }
  removeFolder(key: string) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM exchange_items WHERE folder_key=?').run(key)
      this.db.prepare('DELETE FROM exchange_folders WHERE key=?').run(key)
    })
  }
  clearFolderItems(key: string) { this.db.prepare('DELETE FROM exchange_items WHERE folder_key=?').run(key) }

  // Items
  items(folderKey: string) { return this.rows<ExchangeItemRecord>('SELECT payload_json FROM exchange_items WHERE folder_key=?', folderKey) }
  item(accountId: string, itemId: string) { return this.row<ExchangeItemRecord>('SELECT payload_json FROM exchange_items WHERE account_id=? AND item_id=?', accountId, itemId) }
  saveItem(record: ExchangeItemRecord) {
    this.db.prepare('INSERT INTO exchange_items(account_id,item_id,folder_key,kind,payload_json) VALUES(?,?,?,?,?) ON CONFLICT(account_id,item_id) DO UPDATE SET folder_key=excluded.folder_key,kind=excluded.kind,payload_json=excluded.payload_json')
      .run(record.accountId, record.itemId, record.folderKey, record.kind, JSON.stringify(record))
  }
  removeItem(accountId: string, itemId: string) { this.db.prepare('DELETE FROM exchange_items WHERE account_id=? AND item_id=?').run(accountId, itemId) }

  // Operations
  operations(filter: { accountId?: string; status?: ExchangeOperationStatus[] } = {}) {
    const all = filter.accountId
      ? this.rows<ExchangeOperationRecord>('SELECT payload_json FROM exchange_operations WHERE account_id=? ORDER BY created_at, rowid', filter.accountId)
      : this.rows<ExchangeOperationRecord>('SELECT payload_json FROM exchange_operations ORDER BY created_at, rowid')
    return filter.status ? all.filter((operation) => filter.status!.includes(operation.status)) : all
  }
  operation(id: string) { return this.row<ExchangeOperationRecord>('SELECT payload_json FROM exchange_operations WHERE id=?', id) }
  operationFor(accountId: string, localId: string) { return this.operations({ accountId }).find((operation) => operation.localId === localId) }
  saveOperation(record: ExchangeOperationRecord) {
    this.db.prepare('INSERT INTO exchange_operations(id,account_id,status,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload_json=excluded.payload_json,updated_at=excluded.updated_at')
      .run(record.id, record.accountId, record.status, JSON.stringify(record), record.createdAt, record.updatedAt)
  }
  deleteOperation(id: string) { this.db.prepare('DELETE FROM exchange_operations WHERE id=?').run(id) }
}

/** Restored backups hold queued writes for review so an old change is never resent silently. */
export function prepareRestoredExchangeDatabase(db: DatabaseSync) {
  db.exec(SCHEMA)
  const timestamp = new Date().toISOString()
  let held = 0
  for (const row of db.prepare(`SELECT id,payload_json FROM exchange_operations WHERE status='queued'`).all() as unknown as { id: string; payload_json: string }[]) {
    const operation = JSON.parse(row.payload_json) as ExchangeOperationRecord
    db.prepare(`UPDATE exchange_operations SET status='held',payload_json=?,updated_at=? WHERE id=?`).run(JSON.stringify({ ...operation, status: 'held', error: RESTORED_EXCHANGE_WRITE_MESSAGE, updatedAt: timestamp }), timestamp, row.id)
    held++
  }
  let accounts = 0
  for (const row of db.prepare('SELECT account_id,payload_json FROM exchange_accounts').all() as unknown as { account_id: string; payload_json: string }[]) {
    const account = JSON.parse(row.payload_json) as ExchangeAccountRecord
    db.prepare('UPDATE exchange_accounts SET payload_json=?,updated_at=? WHERE account_id=?').run(JSON.stringify({ ...account, status: 'needs-auth', error: 'Restored from a profile backup. Enter the password again to resume synchronization.' }), timestamp, row.account_id)
    accounts++
  }
  return { held, accounts }
}
