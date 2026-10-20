import { DatabaseSync } from 'node:sqlite'
import type { HostedMeetingProvider } from '../../src/meeting-host-types'
import type { HostedMeeting, OnlineMeetingRequest } from './online-meetings'

// Zoom and Webex meetings Aerio created, keyed by the conference request id (E47). Shares productivity.sqlite
// and therefore the profile backup.
//
// - creating: an attempt was recorded before the provider call; its outcome is unknown until it is confirmed.
//   A later attempt under the same request id searches the host's meetings before creating again.
// - created: the meeting exists; `event_id` is set once the calendar event carrying it was written.
// - cancelled / detached: the meeting was cancelled, or its event was deleted with the meeting kept.

export type MeetingLinkState = 'creating' | 'created' | 'cancelled' | 'detached'

export interface MeetingLink {
  requestId: string
  provider: HostedMeetingProvider
  state: MeetingLinkState
  request: OnlineMeetingRequest
  meeting?: HostedMeeting
  accountId?: string
  calendarId?: string
  eventId?: string
  cancelOnDelete: boolean
  lastError?: string
  updatedAt: string
}

interface LinkRow {
  request_id: string
  provider: HostedMeetingProvider
  state: MeetingLinkState
  request_json: string
  meeting_json: string | null
  account_id: string | null
  calendar_id: string | null
  event_id: string | null
  cancel_on_delete: number
  last_error: string | null
  updated_at: string
}

const fromRow = (row: LinkRow): MeetingLink => ({
  requestId: row.request_id,
  provider: row.provider,
  state: row.state,
  request: JSON.parse(row.request_json) as OnlineMeetingRequest,
  ...(row.meeting_json ? { meeting: JSON.parse(row.meeting_json) as HostedMeeting } : {}),
  ...(row.account_id ? { accountId: row.account_id } : {}),
  ...(row.calendar_id ? { calendarId: row.calendar_id } : {}),
  ...(row.event_id ? { eventId: row.event_id } : {}),
  cancelOnDelete: row.cancel_on_delete !== 0,
  ...(row.last_error ? { lastError: row.last_error } : {}),
  updatedAt: row.updated_at
})

export class MeetingLinkStore {
  private readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS online_meeting_links (
        request_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        state TEXT NOT NULL,
        request_json TEXT NOT NULL,
        meeting_json TEXT,
        account_id TEXT,
        calendar_id TEXT,
        event_id TEXT,
        cancel_on_delete INTEGER NOT NULL DEFAULT 1,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS online_meeting_links_event ON online_meeting_links(event_id);
    `)
  }

  close() {
    this.db.close()
  }

  get(requestId: string) {
    const row = this.db.prepare('SELECT * FROM online_meeting_links WHERE request_id=?').get(requestId) as unknown as LinkRow | undefined
    return row ? fromRow(row) : undefined
  }

  forEvent(eventId: string) {
    const row = this.db.prepare(`SELECT * FROM online_meeting_links WHERE event_id=? AND state='created' ORDER BY updated_at DESC LIMIT 1`).get(eventId) as unknown as LinkRow | undefined
    return row ? fromRow(row) : undefined
  }

  // Created meetings by event id, for re-attaching them to events after synchronization.
  linkedEvents() {
    const rows = this.db.prepare(`SELECT * FROM online_meeting_links WHERE state='created' AND event_id IS NOT NULL`).all() as unknown as LinkRow[]
    return new Map(rows.map((row) => [row.event_id!, fromRow(row)]))
  }

  // Recorded before the provider call, so a crash or lost response leaves evidence of the attempt.
  begin(requestId: string, provider: HostedMeetingProvider, request: OnlineMeetingRequest) {
    this.db.prepare(`
      INSERT INTO online_meeting_links(request_id,provider,state,request_json,updated_at) VALUES(?,?,'creating',?,?)
      ON CONFLICT(request_id) DO UPDATE SET request_json=excluded.request_json,updated_at=excluded.updated_at
    `).run(requestId, provider, JSON.stringify(request), new Date().toISOString())
  }

  noteError(requestId: string, error: string) {
    this.db.prepare('UPDATE online_meeting_links SET last_error=?,updated_at=? WHERE request_id=?').run(error.slice(0, 500), new Date().toISOString(), requestId)
  }

  // The attempt certainly created nothing (the provider refused it).
  forget(requestId: string) {
    this.db.prepare(`DELETE FROM online_meeting_links WHERE request_id=? AND state='creating'`).run(requestId)
  }

  created(requestId: string, meeting: HostedMeeting, request: OnlineMeetingRequest) {
    this.db.prepare(`UPDATE online_meeting_links SET state='created',meeting_json=?,request_json=?,last_error=NULL,updated_at=? WHERE request_id=?`)
      .run(JSON.stringify(meeting), JSON.stringify(request), new Date().toISOString(), requestId)
  }

  linkEvent(requestId: string, event: { accountId: string; calendarId: string; eventId: string }) {
    this.db.prepare('UPDATE online_meeting_links SET account_id=?,calendar_id=?,event_id=?,updated_at=? WHERE request_id=?')
      .run(event.accountId, event.calendarId, event.eventId, new Date().toISOString(), requestId)
  }

  setState(requestId: string, state: MeetingLinkState) {
    this.db.prepare('UPDATE online_meeting_links SET state=?,last_error=NULL,updated_at=? WHERE request_id=?').run(state, new Date().toISOString(), requestId)
  }

  setCancelOnDelete(requestId: string, cancel: boolean) {
    this.db.prepare('UPDATE online_meeting_links SET cancel_on_delete=?,updated_at=? WHERE request_id=?').run(cancel ? 1 : 0, new Date().toISOString(), requestId)
    return this.get(requestId)
  }
}
