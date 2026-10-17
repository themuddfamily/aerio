import { DatabaseSync } from 'node:sqlite'
import type { DuplicateCleanupEntry, DuplicateDismissal } from '../../src/duplicate-cleanup-types'
import type { TaskEntity } from '../../src/task-provider-types'
import type { CalendarEvent, Task } from '../../src/types'

// Duplicate cleanup journal and "Not duplicates" decisions (E32). Stored in productivity.sqlite
// next to the contact merge journal, so profile backups include them.

export const DUPLICATE_JOURNAL_LIMIT = 100

export interface JournalMailOperation {
  accountId: string
  operationId: string
  items: { itemId: string; title: string }[]
}

export interface JournalEvent {
  itemId: string
  title: string
  source: 'provider' | 'dav' | 'local'
  calendarId: string
  // Snapshots taken before deletion; undo recreates them.
  events: CalendarEvent[]
}

export interface JournalTaskDelete {
  entityId: string
  operationId?: string
  entity: TaskEntity
}

export type JournalTask =
  | { itemId: string; title: string; source: 'provider'; accountId: string; listId: string; deletes: JournalTaskDelete[] }
  | { itemId: string; title: string; source: 'local'; task: Task; index: number }

export interface StoredDuplicateCleanupEntry extends DuplicateCleanupEntry {
  mail?: JournalMailOperation[]
  events?: JournalEvent[]
  tasks?: JournalTask[]
}

interface PayloadRow { payload_json: string }

export class DuplicateCleanupStore {
  private readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS duplicate_cleanup_journal (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_duplicate_cleanup_journal_created ON duplicate_cleanup_journal(created_at DESC);
      CREATE TABLE IF NOT EXISTS duplicate_dismissals (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `)
  }

  close() {
    this.db.close()
  }

  saveEntry(entry: StoredDuplicateCleanupEntry, keep = DUPLICATE_JOURNAL_LIMIT) {
    this.db.prepare(`
      INSERT INTO duplicate_cleanup_journal(id,kind,payload_json,created_at) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json
    `).run(entry.id, entry.kind, JSON.stringify(entry), entry.createdAt)
    this.db.prepare('DELETE FROM duplicate_cleanup_journal WHERE id NOT IN (SELECT id FROM duplicate_cleanup_journal ORDER BY created_at DESC, id DESC LIMIT ?)').run(keep)
  }

  entry(id: string) {
    const row = this.db.prepare('SELECT payload_json FROM duplicate_cleanup_journal WHERE id=?').get(id) as unknown as PayloadRow | undefined
    return row ? JSON.parse(row.payload_json) as StoredDuplicateCleanupEntry : undefined
  }

  entries(): StoredDuplicateCleanupEntry[] {
    return (this.db.prepare('SELECT payload_json FROM duplicate_cleanup_journal ORDER BY created_at DESC, id DESC').all() as unknown as PayloadRow[])
      .map((row) => JSON.parse(row.payload_json) as StoredDuplicateCleanupEntry)
  }

  dismissals(): DuplicateDismissal[] {
    return (this.db.prepare('SELECT payload_json FROM duplicate_dismissals ORDER BY created_at DESC, id').all() as unknown as PayloadRow[])
      .map((row) => JSON.parse(row.payload_json) as DuplicateDismissal)
  }

  saveDismissal(dismissal: DuplicateDismissal) {
    this.db.prepare(`
      INSERT INTO duplicate_dismissals(id,kind,payload_json,created_at) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json
    `).run(dismissal.id, dismissal.kind, JSON.stringify(dismissal), dismissal.createdAt)
  }

  deleteDismissal(id: string) {
    this.db.prepare('DELETE FROM duplicate_dismissals WHERE id=?').run(id)
  }
}
