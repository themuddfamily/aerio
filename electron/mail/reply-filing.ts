import type { DatabaseSync } from 'node:sqlite'
import type { ParsedMailMessage } from './database'
import type { ApplyMailActionInput, PendingOperation } from '../../src/mail-types'

/** Filing observes sent copies and only queues folder changes; it never sends mail. */
export class ReplyFilingStore {
  constructor(private db: DatabaseSync, private transaction: <T>(callback: () => T) => T) {
    db.exec(`CREATE TABLE IF NOT EXISTS mail_reply_filing_settings(account_id TEXT PRIMARY KEY REFERENCES gmail_accounts(id) ON DELETE CASCADE,enabled_at TEXT);
      CREATE TABLE IF NOT EXISTS mail_reply_filing_jobs(account_id TEXT NOT NULL REFERENCES gmail_accounts(id) ON DELETE CASCADE,identity TEXT NOT NULL,message_id TEXT NOT NULL,reference_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',error TEXT,PRIMARY KEY(account_id,identity));`)
  }
  enabled(accountId: string) { return Boolean(this.db.prepare('SELECT enabled_at FROM mail_reply_filing_settings WHERE account_id=?').get(accountId)?.enabled_at) }
  issues(accountId: string) {
    return this.db.prepare("SELECT j.error,m.subject FROM mail_reply_filing_jobs j LEFT JOIN gmail_messages m ON m.account_id=j.account_id AND m.id=j.message_id WHERE j.account_id=? AND j.status IN ('pending','review') LIMIT 20").all(accountId)
      .map((row) => ({ subject: String(row.subject ?? 'Sent reply'), reason: String(row.error ?? 'Waiting for the original message to be downloaded before filing this reply.') }))
  }
  configure(accountId: string, enabled: boolean) {
    if (typeof enabled !== 'boolean') throw new Error('Invalid reply filing preference')
    if (enabled && this.enabled(accountId)) return
    this.db.prepare('INSERT INTO mail_reply_filing_settings(account_id,enabled_at) VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET enabled_at=excluded.enabled_at').run(accountId, enabled ? new Date().toISOString() : null)
    if (!enabled) this.db.prepare("DELETE FROM mail_reply_filing_jobs WHERE account_id=? AND status='pending'").run(accountId)
  }
  observe(records: ParsedMailMessage[]) {
    for (const message of records) {
      if (!message.labelIds.includes('SENT') || !message.references.length) continue
      const since = this.db.prepare('SELECT enabled_at FROM mail_reply_filing_settings WHERE account_id=?').get(message.accountId)?.enabled_at
      if (!since || !Number.isFinite(Date.parse(message.internalDate)) || Date.parse(message.internalDate) < Date.parse(String(since))) continue
      const identity = message.messageIdHeader?.trim().toLowerCase() || message.id
      this.db.prepare('INSERT OR IGNORE INTO mail_reply_filing_jobs(account_id,identity,message_id,reference_id) VALUES(?,?,?,?)').run(message.accountId, identity, message.id, message.references.at(-1)!)
    }
  }
  process(accountId: string, provider: string, queue: (input: ApplyMailActionInput, messageId: string) => PendingOperation): PendingOperation[] {
    if (!this.enabled(accountId)) return []
    const operations: PendingOperation[] = []
    const jobs = this.db.prepare("SELECT * FROM mail_reply_filing_jobs WHERE account_id=? AND status='pending'").all(accountId)
    for (const job of jobs) {
      const reference = String(job.reference_id).trim().replace(/^<|>$/g, '').toLowerCase()
      const source = this.db.prepare("SELECT label_ids_json FROM gmail_messages WHERE account_id=? AND lower(trim(header_message_id,'<> '))=? ORDER BY internal_date LIMIT 1").get(accountId, reference)
      const sent = this.db.prepare('SELECT thread_id FROM gmail_messages WHERE account_id=? AND id=?').get(accountId, String(job.message_id))
      if (!source || !sent) continue // A later sync can bring the original into the cache.
      const labels = JSON.parse(String(source.label_ids_json)) as string[]
      const physical = labels.filter((id) => id.startsWith('folder:'))
      const destinations = provider === 'gmail'
        ? labels.filter((id) => id === 'INBOX' || this.db.prepare("SELECT 1 FROM gmail_labels WHERE account_id=? AND id=? AND type='user'").get(accountId, id))
        : physical.length ? physical : labels.filter((id) => id === 'INBOX' || id === 'ARCHIVE')
      if (provider !== 'gmail' && destinations.length > 1) {
        this.db.prepare("UPDATE mail_reply_filing_jobs SET status='review',error='The original has several folder locations; choose a destination manually.' WHERE account_id=? AND identity=?").run(accountId, String(job.identity))
        continue
      }
      // Transaction includes the job claim and every local/provider operation. A failed
      // destination leaves this job pending; replay cannot create duplicate operations.
      const staged: PendingOperation[] = []
      try {
        this.transaction(() => {
          for (const labelId of destinations) staged.push(queue({ accountId, threadIds: [String(sent.thread_id)], action: provider === 'gmail' ? 'label' : 'move', labelId }, String(job.message_id)))
          this.db.prepare("UPDATE mail_reply_filing_jobs SET status='queued',error=NULL WHERE account_id=? AND identity=?").run(accountId, String(job.identity))
        })
        operations.push(...staged)
      } catch {
        this.db.prepare("UPDATE mail_reply_filing_jobs SET error='The destination is unavailable. Aerio will retry filing after synchronization; the reply will not be sent again.' WHERE account_id=? AND identity=?").run(accountId, String(job.identity))
      }
    }
    return operations
  }
}
