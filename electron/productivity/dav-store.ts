import { DatabaseSync } from 'node:sqlite'
import type { DavAccountStatus, DavCollectionKind, DavPresetId, DavReviewStatus } from '../../src/dav-types'

// CalDAV/CardDAV state in its own database (dav.sqlite): accounts, discovered collections with
// their sync tokens and ctags, the last server copy of every resource with its ETag, and a durable
// queue of local writes. Passwords are never stored here; see DavCredentialVault.

export interface DavAccountRecord {
  id: string
  preset: DavPresetId
  name: string
  username: string
  serverUrl: string
  calendarRoots: string[]
  contactsRoots: string[]
  principalUrl?: string
  calendarHomeUrl?: string
  addressbookHomeUrl?: string
  status: DavAccountStatus
  error?: string
  lastSyncedAt?: string
}

export interface DavCollectionRecord {
  id: string
  accountId: string
  url: string
  kind: DavCollectionKind
  name: string
  color: string
  description?: string
  components: string[]
  readOnly: boolean
  shared: boolean
  enabled: boolean
  ctag?: string
  syncToken?: string
  supportsSyncCollection: boolean
  syncMode: 'sync-collection' | 'ctag'
  lastSyncedAt?: string
  error?: string
}

export interface DavResourceRecord {
  collectionId: string
  href: string
  etag?: string
  data: string
}

export type DavOperationAction = 'create' | 'update' | 'delete'
export type DavOperationStatus = 'queued' | DavReviewStatus

export interface DavOperationRecord {
  id: string
  accountId: string
  collectionId: string
  href: string
  kind: 'event' | 'contact'
  action: DavOperationAction
  // The resource body to PUT (create/update); undefined for deletes.
  data?: string
  // The ETag the change was made against; creates use If-None-Match: * instead.
  ifMatch?: string
  status: DavOperationStatus
  error?: string
  attempts: number
  nextAttemptAt?: string
  // What the server held when a conditional write was refused (412) or the item vanished.
  serverEtag?: string
  serverData?: string
  serverDeleted?: boolean
  createdAt: string
  updatedAt: string
}

interface PayloadRow { payload_json: string }
interface ResourceRow { collection_id: string; href: string; etag: string | null; data: string }
interface OperationRow {
  id: string; account_id: string; collection_id: string; href: string; kind: 'event' | 'contact'; action: DavOperationAction
  data: string | null; if_match: string | null; status: DavOperationStatus; error: string | null; attempts: number
  next_attempt_at: string | null; server_etag: string | null; server_data: string | null; server_deleted: number
  created_at: string; updated_at: string
}

const operationFromRow = (row: OperationRow): DavOperationRecord => ({
  id: row.id, accountId: row.account_id, collectionId: row.collection_id, href: row.href, kind: row.kind, action: row.action,
  ...(row.data !== null ? { data: row.data } : {}),
  ...(row.if_match !== null ? { ifMatch: row.if_match } : {}),
  status: row.status,
  ...(row.error !== null ? { error: row.error } : {}),
  attempts: row.attempts,
  ...(row.next_attempt_at !== null ? { nextAttemptAt: row.next_attempt_at } : {}),
  ...(row.server_etag !== null ? { serverEtag: row.server_etag } : {}),
  ...(row.server_data !== null ? { serverData: row.server_data } : {}),
  ...(row.server_deleted ? { serverDeleted: true } : {}),
  createdAt: row.created_at, updatedAt: row.updated_at
})

export const DAV_SCHEMA = `
  CREATE TABLE IF NOT EXISTS dav_accounts (
    id TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS dav_collections (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    url TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_dav_collections_account ON dav_collections(account_id);
  CREATE TABLE IF NOT EXISTS dav_resources (
    collection_id TEXT NOT NULL,
    href TEXT NOT NULL,
    etag TEXT,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(collection_id, href)
  );
  CREATE TABLE IF NOT EXISTS dav_operations (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    collection_id TEXT NOT NULL,
    href TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('event','contact')),
    action TEXT NOT NULL CHECK(action IN ('create','update','delete')),
    data TEXT,
    if_match TEXT,
    status TEXT NOT NULL CHECK(status IN ('queued','conflict','failed','held')),
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    server_etag TEXT,
    server_data TEXT,
    server_deleted INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_dav_operations_href ON dav_operations(collection_id, href);
  CREATE INDEX IF NOT EXISTS idx_dav_operations_account ON dav_operations(account_id, status);
`

export class DavStore {
  private readonly db: DatabaseSync
  private depth = 0

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; ${DAV_SCHEMA}`)
  }

  close() {
    this.db.close()
  }

  accounts(): DavAccountRecord[] {
    return (this.db.prepare('SELECT payload_json FROM dav_accounts ORDER BY created_at, id').all() as unknown as PayloadRow[])
      .map((row) => JSON.parse(row.payload_json) as DavAccountRecord)
  }

  account(id: string) {
    const row = this.db.prepare('SELECT payload_json FROM dav_accounts WHERE id=?').get(id) as unknown as PayloadRow | undefined
    return row ? JSON.parse(row.payload_json) as DavAccountRecord : undefined
  }

  saveAccount(account: DavAccountRecord) {
    const timestamp = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO dav_accounts(id,payload_json,created_at,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at
    `).run(account.id, JSON.stringify(account), timestamp, timestamp)
  }

  removeAccount(id: string) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM dav_resources WHERE collection_id IN (SELECT id FROM dav_collections WHERE account_id=?)').run(id)
      this.db.prepare('DELETE FROM dav_collections WHERE account_id=?').run(id)
      this.db.prepare('DELETE FROM dav_operations WHERE account_id=?').run(id)
      this.db.prepare('DELETE FROM dav_accounts WHERE id=?').run(id)
    })
  }

  collections(accountId?: string): DavCollectionRecord[] {
    const rows = accountId
      ? this.db.prepare('SELECT payload_json FROM dav_collections WHERE account_id=? ORDER BY rowid').all(accountId)
      : this.db.prepare('SELECT payload_json FROM dav_collections ORDER BY rowid').all()
    return (rows as unknown as PayloadRow[]).map((row) => JSON.parse(row.payload_json) as DavCollectionRecord)
  }

  collection(id: string) {
    const row = this.db.prepare('SELECT payload_json FROM dav_collections WHERE id=?').get(id) as unknown as PayloadRow | undefined
    return row ? JSON.parse(row.payload_json) as DavCollectionRecord : undefined
  }

  saveCollection(collection: DavCollectionRecord) {
    this.db.prepare(`
      INSERT INTO dav_collections(id,account_id,url,payload_json,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET url=excluded.url,payload_json=excluded.payload_json,updated_at=excluded.updated_at
    `).run(collection.id, collection.accountId, collection.url, JSON.stringify(collection), new Date().toISOString())
  }

  /** Removes a collection the server no longer lists, along with its cached resources. */
  removeCollection(id: string) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM dav_resources WHERE collection_id=?').run(id)
      this.db.prepare('DELETE FROM dav_collections WHERE id=?').run(id)
    })
  }

  resources(collectionId: string): DavResourceRecord[] {
    return (this.db.prepare('SELECT collection_id,href,etag,data FROM dav_resources WHERE collection_id=? ORDER BY href').all(collectionId) as unknown as ResourceRow[])
      .map((row) => ({ collectionId: row.collection_id, href: row.href, data: row.data, ...(row.etag !== null ? { etag: row.etag } : {}) }))
  }

  resource(collectionId: string, href: string): DavResourceRecord | undefined {
    const row = this.db.prepare('SELECT collection_id,href,etag,data FROM dav_resources WHERE collection_id=? AND href=?').get(collectionId, href) as unknown as ResourceRow | undefined
    return row ? { collectionId: row.collection_id, href: row.href, data: row.data, ...(row.etag !== null ? { etag: row.etag } : {}) } : undefined
  }

  etags(collectionId: string) {
    const rows = this.db.prepare('SELECT href,etag FROM dav_resources WHERE collection_id=?').all(collectionId) as unknown as { href: string; etag: string | null }[]
    return new Map(rows.map((row) => [row.href, row.etag ?? undefined]))
  }

  /** Applies one pull: changed resources, removals, and the collection's new revision markers. */
  applyChanges(collection: DavCollectionRecord, changed: { href: string; etag?: string; data: string }[], removed: string[]) {
    const timestamp = new Date().toISOString()
    this.transaction(() => {
      const upsert = this.db.prepare(`
        INSERT INTO dav_resources(collection_id,href,etag,data,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(collection_id,href) DO UPDATE SET etag=excluded.etag,data=excluded.data,updated_at=excluded.updated_at
      `)
      for (const resource of changed) upsert.run(collection.id, resource.href, resource.etag ?? null, resource.data, timestamp)
      const remove = this.db.prepare('DELETE FROM dav_resources WHERE collection_id=? AND href=?')
      for (const href of removed) remove.run(collection.id, href)
      this.saveCollection(collection)
    })
  }

  saveResource(resource: DavResourceRecord) {
    this.applyChanges(this.collection(resource.collectionId)!, [resource], [])
  }

  removeResource(collectionId: string, href: string) {
    this.db.prepare('DELETE FROM dav_resources WHERE collection_id=? AND href=?').run(collectionId, href)
  }

  operations(filter: { accountId?: string; status?: DavOperationStatus[] } = {}): DavOperationRecord[] {
    const clauses: string[] = []
    const values: string[] = []
    if (filter.accountId) { clauses.push('account_id=?'); values.push(filter.accountId) }
    if (filter.status?.length) { clauses.push(`status IN (${filter.status.map(() => '?').join(',')})`); values.push(...filter.status) }
    const sql = `SELECT * FROM dav_operations ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at, rowid`
    return (this.db.prepare(sql).all(...values) as unknown as OperationRow[]).map(operationFromRow)
  }

  operation(id: string) {
    const row = this.db.prepare('SELECT * FROM dav_operations WHERE id=?').get(id) as unknown as OperationRow | undefined
    return row ? operationFromRow(row) : undefined
  }

  operationFor(collectionId: string, href: string) {
    const row = this.db.prepare('SELECT * FROM dav_operations WHERE collection_id=? AND href=?').get(collectionId, href) as unknown as OperationRow | undefined
    return row ? operationFromRow(row) : undefined
  }

  saveOperation(operation: DavOperationRecord) {
    this.db.prepare(`
      INSERT INTO dav_operations(id,account_id,collection_id,href,kind,action,data,if_match,status,error,attempts,next_attempt_at,server_etag,server_data,server_deleted,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET action=excluded.action,data=excluded.data,if_match=excluded.if_match,status=excluded.status,error=excluded.error,
        attempts=excluded.attempts,next_attempt_at=excluded.next_attempt_at,server_etag=excluded.server_etag,server_data=excluded.server_data,
        server_deleted=excluded.server_deleted,updated_at=excluded.updated_at
    `).run(
      operation.id, operation.accountId, operation.collectionId, operation.href, operation.kind, operation.action,
      operation.data ?? null, operation.ifMatch ?? null, operation.status, operation.error ?? null, operation.attempts,
      operation.nextAttemptAt ?? null, operation.serverEtag ?? null, operation.serverData ?? null, operation.serverDeleted ? 1 : 0,
      operation.createdAt, operation.updatedAt
    )
  }

  deleteOperation(id: string) {
    this.db.prepare('DELETE FROM dav_operations WHERE id=?').run(id)
  }

  /** Completes a write: the server copy replaces the cache and the queue entry is removed in one step. */
  completeOperation(operation: DavOperationRecord, resource: DavResourceRecord | undefined) {
    this.transaction(() => {
      if (resource) {
        this.db.prepare(`
          INSERT INTO dav_resources(collection_id,href,etag,data,updated_at) VALUES(?,?,?,?,?)
          ON CONFLICT(collection_id,href) DO UPDATE SET etag=excluded.etag,data=excluded.data,updated_at=excluded.updated_at
        `).run(resource.collectionId, resource.href, resource.etag ?? null, resource.data, new Date().toISOString())
      } else this.removeResource(operation.collectionId, operation.href)
      this.deleteOperation(operation.id)
    })
  }

  // Re-entrant: nested calls join the outer transaction so composite updates stay atomic.
  transaction(work: () => void) {
    if (this.depth > 0) {
      this.depth++
      try { work() } finally { this.depth-- }
      return
    }
    this.db.exec('BEGIN IMMEDIATE')
    this.depth = 1
    try {
      work()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    } finally {
      this.depth = 0
    }
  }
}

export const RESTORED_DAV_MESSAGE = 'Restored from a profile backup. Enter the app password again to resume synchronization.'
export const RESTORED_DAV_WRITE_MESSAGE = 'Held after restoring a profile backup. Send it again if the change is still needed.'

/** Profile-restore preparation: passwords are not in backups, and restored writes wait for review. */
export function prepareRestoredDavDatabase(db: DatabaseSync) {
  db.exec(DAV_SCHEMA)
  const timestamp = new Date().toISOString()
  let accounts = 0
  for (const row of db.prepare('SELECT id,payload_json FROM dav_accounts').all() as unknown as { id: string; payload_json: string }[]) {
    const account = JSON.parse(row.payload_json) as DavAccountRecord
    db.prepare('UPDATE dav_accounts SET payload_json=?,updated_at=? WHERE id=?').run(JSON.stringify({ ...account, status: 'needs-auth', error: RESTORED_DAV_MESSAGE }), timestamp, row.id)
    accounts++
  }
  const held = Number(db.prepare(`UPDATE dav_operations SET status='held',error=?,updated_at=? WHERE status='queued'`).run(RESTORED_DAV_WRITE_MESSAGE, timestamp).changes)
  return { accounts, held }
}
