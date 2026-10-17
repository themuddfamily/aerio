import { DatabaseSync } from 'node:sqlite'
import type { DirectoryEntry, DirectoryEntryKind } from '../../src/directory-types'

// The offline address book (directory.sqlite): per-account copies of organization directory
// entries, refreshed atomically. A refresh writes into `directory_staging` and only a complete
// listing replaces `directory_entries`, in one transaction; a failed refresh discards the staging
// rows and records its error while the previous cache stays in use. This file is a cache that can
// be rebuilt from the server at any time, so it is not part of profile backups.

export type DirectoryCacheMode = 'full' | 'incremental'

export interface DirectoryCacheRecord {
  accountId: string
  mode?: DirectoryCacheMode
  lastSuccessAt?: string
  lastAttemptAt?: string
  error?: string
  /** Why the provider refused directory consent (Authorization_RequestDenied, admin consent required). */
  consentError?: string
  entries: number
}

/** Entries learned from online lookups (incremental mode) or listed by a full refresh. */
export type DirectoryEntryOrigin = 'listing' | 'lookup'

const ENTRY_COLUMNS = 'account_id TEXT NOT NULL, entry_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL, search_text TEXT NOT NULL, origin TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(account_id, entry_id)'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS directory_entries(${ENTRY_COLUMNS});
  CREATE INDEX IF NOT EXISTS directory_entries_name ON directory_entries(account_id, name);
  CREATE TABLE IF NOT EXISTS directory_staging(${ENTRY_COLUMNS});
  CREATE TABLE IF NOT EXISTS directory_cache_state(account_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL);
`

const MAX_FIELD = 500

/** Lower-cased words a cache search matches against: name, address, title, department, office. */
export function directorySearchText(entry: DirectoryEntry) {
  return [entry.name, entry.email, entry.title, entry.department, entry.company, entry.office, entry.building]
    .filter(Boolean).join(' ').toLowerCase().slice(0, 2_000)
}

const clean = (entry: DirectoryEntry): DirectoryEntry => {
  const result: DirectoryEntry = { ...entry }
  for (const key of ['name', 'email', 'title', 'department', 'company', 'office', 'phone', 'mobile', 'building'] as const) {
    const value = result[key]
    if (typeof value === 'string') result[key] = value.slice(0, MAX_FIELD)
  }
  delete result.ambiguous
  return result
}

const escapeLike = (value: string) => value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')

export class DirectoryStore {
  private readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode=WAL;')
    this.db.exec(SCHEMA)
  }

  close() { this.db.close() }

  private transaction<T>(work: () => T): T {
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

  state(accountId: string): DirectoryCacheRecord {
    const row = this.db.prepare('SELECT payload_json FROM directory_cache_state WHERE account_id=?').get(accountId) as { payload_json: string } | undefined
    const stored = row ? JSON.parse(row.payload_json) as DirectoryCacheRecord : { accountId, entries: 0 }
    return { ...stored, entries: this.count(accountId) }
  }

  private saveState(record: DirectoryCacheRecord) {
    this.db.prepare('INSERT INTO directory_cache_state(account_id,payload_json,updated_at) VALUES(?,?,?) ON CONFLICT(account_id) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at')
      .run(record.accountId, JSON.stringify(record), new Date().toISOString())
  }

  updateState(accountId: string, change: Partial<Omit<DirectoryCacheRecord, 'accountId' | 'entries'>>) {
    const next: DirectoryCacheRecord = { ...this.state(accountId), ...change, accountId }
    for (const key of Object.keys(change) as (keyof typeof change)[]) if (change[key] === undefined) delete next[key]
    this.saveState(next)
    return next
  }

  count(accountId: string) {
    return Number((this.db.prepare('SELECT COUNT(*) count FROM directory_entries WHERE account_id=?').get(accountId) as { count: number }).count)
  }

  accountIds() {
    return (this.db.prepare('SELECT account_id FROM directory_cache_state UNION SELECT DISTINCT account_id FROM directory_entries').all() as { account_id: string }[]).map((row) => row.account_id)
  }

  // --- Atomic refresh ------------------------------------------------------------------------

  /** Starts a refresh: clears any staging rows a crashed refresh left behind. */
  beginRefresh(accountId: string, at: string) {
    this.db.prepare('DELETE FROM directory_staging WHERE account_id=?').run(accountId)
    this.updateState(accountId, { lastAttemptAt: at })
  }

  stage(accountId: string, entries: DirectoryEntry[]) {
    if (!entries.length) return
    this.transaction(() => {
      const insert = this.db.prepare('INSERT OR REPLACE INTO directory_staging(account_id,entry_id,kind,name,email,search_text,origin,payload_json) VALUES(?,?,?,?,?,?,?,?)')
      for (const raw of entries) {
        if (raw.accountId !== accountId || !raw.email) continue
        const entry = clean(raw)
        insert.run(accountId, entry.id, entry.kind, entry.name, entry.email.toLowerCase(), directorySearchText(entry), 'listing', JSON.stringify(entry))
      }
    })
  }

  /**
   * Replaces the cache with the staged listing in one transaction. In incremental mode, entries
   * learned from earlier lookups that the listing did not include are kept.
   */
  commitRefresh(accountId: string, mode: DirectoryCacheMode, at: string) {
    this.transaction(() => {
      if (mode === 'incremental') {
        this.db.prepare(`INSERT OR IGNORE INTO directory_staging(account_id,entry_id,kind,name,email,search_text,origin,payload_json)
          SELECT account_id,entry_id,kind,name,email,search_text,origin,payload_json FROM directory_entries WHERE account_id=? AND origin='lookup'`).run(accountId)
      }
      this.db.prepare('DELETE FROM directory_entries WHERE account_id=?').run(accountId)
      this.db.prepare(`INSERT INTO directory_entries(account_id,entry_id,kind,name,email,search_text,origin,payload_json)
        SELECT account_id,entry_id,kind,name,email,search_text,origin,payload_json FROM directory_staging WHERE account_id=?`).run(accountId)
      this.db.prepare('DELETE FROM directory_staging WHERE account_id=?').run(accountId)
      this.saveState({ ...this.state(accountId), mode, lastSuccessAt: at, lastAttemptAt: at, error: undefined, accountId })
    })
    return this.state(accountId)
  }

  /** A failed refresh: the staged rows are dropped and the live cache is untouched. */
  abortRefresh(accountId: string, error: string, at: string) {
    this.db.prepare('DELETE FROM directory_staging WHERE account_id=?').run(accountId)
    return this.updateState(accountId, { error: error.slice(0, 1_000), lastAttemptAt: at })
  }

  /** Incremental (lookup-backed) caches remember entries resolved online. */
  remember(accountId: string, entries: DirectoryEntry[]) {
    if (!entries.length) return
    this.transaction(() => {
      const insert = this.db.prepare(`INSERT INTO directory_entries(account_id,entry_id,kind,name,email,search_text,origin,payload_json) VALUES(?,?,?,?,?,?,'lookup',?)
        ON CONFLICT(account_id,entry_id) DO UPDATE SET kind=excluded.kind,name=excluded.name,email=excluded.email,search_text=excluded.search_text,payload_json=excluded.payload_json`)
      for (const raw of entries) {
        if (raw.accountId !== accountId || !raw.email) continue
        const entry = clean(raw)
        insert.run(accountId, entry.id, entry.kind, entry.name, entry.email.toLowerCase(), directorySearchText(entry), JSON.stringify(entry))
      }
    })
  }

  // --- Lookup --------------------------------------------------------------------------------

  /** Every query word must appear in the entry (name, address, title, department, office). */
  search(accountIds: string[], query: string, kinds: DirectoryEntryKind[] | undefined, limit: number): DirectoryEntry[] {
    if (!accountIds.length) return []
    const where = [`account_id IN (${accountIds.map(() => '?').join(',')})`]
    const params: (string | number)[] = [...accountIds]
    for (const word of query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8)) {
      where.push(`search_text LIKE ? ESCAPE '\\'`)
      params.push(`%${escapeLike(word)}%`)
    }
    if (kinds?.length) {
      where.push(`kind IN (${kinds.map(() => '?').join(',')})`)
      params.push(...kinds)
    }
    params.push(limit)
    return (this.db.prepare(`SELECT payload_json FROM directory_entries WHERE ${where.join(' AND ')} ORDER BY name COLLATE NOCASE, email LIMIT ?`).all(...params) as { payload_json: string }[])
      .map((row) => JSON.parse(row.payload_json) as DirectoryEntry)
  }

  entryByEmail(accountId: string, email: string) {
    const row = this.db.prepare('SELECT payload_json FROM directory_entries WHERE account_id=? AND email=? LIMIT 1').get(accountId, email.toLowerCase()) as { payload_json: string } | undefined
    return row ? JSON.parse(row.payload_json) as DirectoryEntry : undefined
  }

  removeAccount(accountId: string) {
    this.transaction(() => {
      for (const table of ['directory_entries', 'directory_staging', 'directory_cache_state']) this.db.prepare(`DELETE FROM ${table} WHERE account_id=?`).run(accountId)
    })
  }
}
