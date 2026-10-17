import { DatabaseSync } from 'node:sqlite'
import type { CalendarEvent } from '../../src/types'
import type { InterchangeCalendar, InterchangeCalendarEvent, InterchangeSnapshot } from '../../src/interchange-types'

interface PayloadRow { payload_json: string }

const CALENDAR_COLORS = ['#2f7d6d', '#7b5cc4', '#c06a3a', '#3f74c9', '#b44f7a', '#5d7f3a']

// Local calendars and read-only internet calendar subscriptions. Provider calendars stay in
// ProductivityStore; this store shares the same database file but owns separate tables.
export class InterchangeStore {
  private readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS interchange_calendars (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('local','subscription')),
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS interchange_events (
        id TEXT PRIMARY KEY,
        calendar_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_interchange_events_calendar ON interchange_events(calendar_id);
    `)
  }

  close() {
    this.db.close()
  }

  calendars(): InterchangeCalendar[] {
    return (this.db.prepare('SELECT payload_json FROM interchange_calendars ORDER BY created_at, id').all() as unknown as PayloadRow[])
      .map((row) => JSON.parse(row.payload_json) as InterchangeCalendar)
  }

  calendar(id: string) {
    const row = this.db.prepare('SELECT payload_json FROM interchange_calendars WHERE id=?').get(id) as unknown as PayloadRow | undefined
    return row ? JSON.parse(row.payload_json) as InterchangeCalendar : undefined
  }

  events(calendarId?: string): InterchangeCalendarEvent[] {
    const rows = calendarId
      ? this.db.prepare('SELECT payload_json FROM interchange_events WHERE calendar_id=? ORDER BY id').all(calendarId)
      : this.db.prepare('SELECT payload_json FROM interchange_events ORDER BY id').all()
    return (rows as unknown as PayloadRow[]).map((row) => JSON.parse(row.payload_json) as InterchangeCalendarEvent)
  }

  event(id: string) {
    const row = this.db.prepare('SELECT payload_json FROM interchange_events WHERE id=?').get(id) as unknown as PayloadRow | undefined
    return row ? JSON.parse(row.payload_json) as InterchangeCalendarEvent : undefined
  }

  snapshot(): InterchangeSnapshot {
    return { calendars: this.calendars(), events: this.events() }
  }

  nextColor() {
    return CALENDAR_COLORS[this.calendars().length % CALENDAR_COLORS.length]
  }

  saveCalendar(calendar: InterchangeCalendar) {
    const timestamp = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO interchange_calendars(id,kind,payload_json,created_at,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at
    `).run(calendar.id, calendar.kind, JSON.stringify(calendar), timestamp, timestamp)
  }

  // Inserts or replaces events in one transaction, stamping each with its calendar's color and access.
  saveEvents(calendarId: string, events: CalendarEvent[]) {
    const calendar = this.calendar(calendarId)
    if (!calendar) throw new Error('That calendar is no longer available')
    this.transaction(() => this.insertEvents(calendar, events))
  }

  deleteEvent(id: string) {
    this.db.prepare('DELETE FROM interchange_events WHERE id=?').run(id)
  }

  // A successful subscription refresh swaps the whole event set atomically.
  replaceSubscription(calendar: InterchangeCalendar, events: CalendarEvent[]) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM interchange_events WHERE calendar_id=?').run(calendar.id)
      this.saveCalendar(calendar)
      this.insertEvents(calendar, events)
    })
  }

  removeCalendar(id: string) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM interchange_events WHERE calendar_id=?').run(id)
      this.db.prepare('DELETE FROM interchange_calendars WHERE id=?').run(id)
    })
  }

  private insertEvents(calendar: InterchangeCalendar, events: CalendarEvent[]) {
    const timestamp = new Date().toISOString()
    const insert = this.db.prepare(`
      INSERT INTO interchange_events(id,calendar_id,payload_json,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET calendar_id=excluded.calendar_id,payload_json=excluded.payload_json,updated_at=excluded.updated_at
    `)
    for (const event of events) {
      const stored: InterchangeCalendarEvent = { ...event, calendarId: calendar.id, color: calendar.color, readOnly: calendar.kind === 'subscription' }
      insert.run(stored.id, calendar.id, JSON.stringify(stored), timestamp)
    }
  }

  private transaction(work: () => void) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      work()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}
