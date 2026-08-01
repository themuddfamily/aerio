import { DatabaseSync } from 'node:sqlite'
import type {
  ProductivityModule, ProductivityProvider, ProductivitySnapshot, ProviderProductivityData,
  SyncedCalendar, SyncedCalendarEvent, SyncedContact
} from '../../src/productivity-types'
import type { LocalModuleSnapshot } from '../../src/productivity-types'

interface PayloadRow { payload_json: string }
interface SyncRow { account_id: string; module: ProductivityModule; phase: 'idle' | 'syncing' | 'ready' | 'error'; last_synced_at: string | null; error: string | null }

export class ProductivityStore {
  private readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS productivity_calendars (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_productivity_calendars_account ON productivity_calendars(account_id);
      CREATE TABLE IF NOT EXISTS productivity_events (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_productivity_events_account ON productivity_events(account_id);
      CREATE TABLE IF NOT EXISTS productivity_contacts (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_productivity_contacts_account ON productivity_contacts(account_id);
      CREATE TABLE IF NOT EXISTS productivity_sync_state (
        account_id TEXT NOT NULL,
        module TEXT NOT NULL CHECK(module IN ('calendar','contacts')),
        phase TEXT NOT NULL CHECK(phase IN ('idle','syncing','ready','error')),
        last_synced_at TEXT,
        error TEXT,
        PRIMARY KEY(account_id, module)
      );
      CREATE TABLE IF NOT EXISTS local_module_state (
        module TEXT PRIMARY KEY CHECK(module IN ('tasks','notes')),
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
  }

  close() {
    this.db.close()
  }

  setSyncing(accountId: string) {
    for (const module of ['calendar', 'contacts'] satisfies ProductivityModule[]) this.setState(accountId, module, 'syncing')
  }

  setError(accountId: string, error: string) {
    for (const module of ['calendar', 'contacts'] satisfies ProductivityModule[]) this.setState(accountId, module, 'error', error)
  }

  removeAccount(accountId: string) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const table of ['productivity_calendars', 'productivity_events', 'productivity_contacts', 'productivity_sync_state']) {
        this.db.prepare(`DELETE FROM ${table} WHERE account_id=?`).run(accountId)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  replaceAccount(accountId: string, provider: ProductivityProvider, data: ProviderProductivityData) {
    const timestamp = new Date().toISOString()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const table of ['productivity_calendars', 'productivity_events', 'productivity_contacts']) {
        this.db.prepare(`DELETE FROM ${table} WHERE account_id=?`).run(accountId)
      }
      const insertCalendar = this.db.prepare('INSERT INTO productivity_calendars(id,account_id,provider,payload_json,updated_at) VALUES(?,?,?,?,?)')
      const insertEvent = this.db.prepare('INSERT INTO productivity_events(id,account_id,provider,payload_json,updated_at) VALUES(?,?,?,?,?)')
      const insertContact = this.db.prepare('INSERT INTO productivity_contacts(id,account_id,provider,payload_json,updated_at) VALUES(?,?,?,?,?)')
      for (const calendar of data.calendars) insertCalendar.run(calendar.id, accountId, provider, JSON.stringify(calendar), timestamp)
      for (const event of data.events) insertEvent.run(event.id, accountId, provider, JSON.stringify(event), timestamp)
      for (const contact of data.contacts) insertContact.run(contact.id, accountId, provider, JSON.stringify(contact), timestamp)
      for (const module of ['calendar', 'contacts'] satisfies ProductivityModule[]) this.setState(accountId, module, 'ready', undefined, timestamp)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  snapshot(): ProductivitySnapshot {
    const read = <T>(table: string) => (this.db.prepare(`SELECT payload_json FROM ${table} ORDER BY updated_at DESC`).all() as unknown as PayloadRow[])
      .map((row) => JSON.parse(row.payload_json) as T)
    const sync = (this.db.prepare('SELECT account_id,module,phase,last_synced_at,error FROM productivity_sync_state ORDER BY account_id,module').all() as unknown as SyncRow[])
      .map((row) => ({
        accountId: row.account_id,
        module: row.module,
        phase: row.phase,
        lastSyncedAt: row.last_synced_at ?? undefined,
        error: row.error ?? undefined
      }))
    return {
      calendars: read<SyncedCalendar>('productivity_calendars'),
      events: read<SyncedCalendarEvent>('productivity_events'),
      contacts: read<SyncedContact>('productivity_contacts'),
      sync
    }
  }

  localSnapshot(): LocalModuleSnapshot {
    const rows = this.db.prepare('SELECT module,payload_json FROM local_module_state').all() as unknown as { module: 'tasks' | 'notes'; payload_json: string }[]
    const values = new Map(rows.map((row) => [row.module, JSON.parse(row.payload_json) as unknown[]]))
    return {
      tasks: (values.get('tasks') ?? []) as LocalModuleSnapshot['tasks'],
      notes: (values.get('notes') ?? []) as LocalModuleSnapshot['notes']
    }
  }

  saveLocal(snapshot: LocalModuleSnapshot) {
    const timestamp = new Date().toISOString()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const save = this.db.prepare(`
        INSERT INTO local_module_state(module,payload_json,updated_at) VALUES(?,?,?)
        ON CONFLICT(module) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at
      `)
      save.run('tasks', JSON.stringify(snapshot.tasks), timestamp)
      save.run('notes', JSON.stringify(snapshot.notes), timestamp)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private setState(accountId: string, module: ProductivityModule, phase: 'syncing' | 'ready' | 'error', error?: string, lastSyncedAt?: string) {
    this.db.prepare(`
      INSERT INTO productivity_sync_state(account_id,module,phase,last_synced_at,error) VALUES(?,?,?,?,?)
      ON CONFLICT(account_id,module) DO UPDATE SET phase=excluded.phase,last_synced_at=COALESCE(excluded.last_synced_at,productivity_sync_state.last_synced_at),error=excluded.error
    `).run(accountId, module, phase, lastSyncedAt ?? null, error ?? null)
  }
}
