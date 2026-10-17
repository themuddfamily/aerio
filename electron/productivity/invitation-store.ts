import { DatabaseSync } from 'node:sqlite'
import type { InvitationRecord } from '../../src/lib/itip'

interface PayloadRow { payload_json: string }

// The newest iTIP REQUEST or CANCEL seen per account, UID, and RECURRENCE-ID, plus the response sent from
// Aerio. This is what duplicate and stale detection compares against. Shares productivity.sqlite.
export class InvitationStore {
  private readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS meeting_invitations (
        account_id TEXT NOT NULL,
        uid TEXT NOT NULL,
        recurrence_id TEXT NOT NULL DEFAULT '',
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(account_id, uid, recurrence_id)
      );
    `)
  }

  close() {
    this.db.close()
  }

  get(accountId: string, uid: string, recurrenceId?: string) {
    const row = this.db.prepare('SELECT payload_json FROM meeting_invitations WHERE account_id=? AND uid=? AND recurrence_id=?')
      .get(accountId, uid, recurrenceId ?? '') as unknown as PayloadRow | undefined
    return row ? JSON.parse(row.payload_json) as InvitationRecord : undefined
  }

  save(accountId: string, record: InvitationRecord) {
    this.db.prepare(`
      INSERT INTO meeting_invitations(account_id,uid,recurrence_id,payload_json,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(account_id,uid,recurrence_id) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at
    `).run(accountId, record.uid, record.recurrenceId ?? '', JSON.stringify(record), new Date().toISOString())
  }

  removeAccount(accountId: string) {
    this.db.prepare('DELETE FROM meeting_invitations WHERE account_id=?').run(accountId)
  }
}
