import type { DatabaseSync } from 'node:sqlite'
import { AERIO_PIN_LABEL, type ImapPinTarget, type MailPinSyncSupport } from '../../src/mail-pin-sync-types'
import type { MailPinStore } from './mail-pins'

/** Provider capability and readback state share the mail DB and its restart/backup lifecycle. */
export class MailPinSyncStore {
  constructor(private readonly db: DatabaseSync, private readonly pins: MailPinStore) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mail_pin_sync_folders (account_id TEXT NOT NULL REFERENCES gmail_accounts(id) ON DELETE CASCADE, folder_id TEXT NOT NULL, mode TEXT NOT NULL, reason TEXT NOT NULL, PRIMARY KEY(account_id,folder_id));
      CREATE TABLE IF NOT EXISTS mail_pin_sync_threads (account_id TEXT NOT NULL REFERENCES gmail_accounts(id) ON DELETE CASCADE, thread_id TEXT NOT NULL, PRIMARY KEY(account_id,thread_id));
    `)
  }
  recordFolder(accountId: string, folder: string, support: MailPinSyncSupport) {
    this.db.prepare('INSERT INTO mail_pin_sync_folders(account_id,folder_id,mode,reason) VALUES(?,?,?,?) ON CONFLICT(account_id,folder_id) DO UPDATE SET mode=excluded.mode,reason=excluded.reason').run(accountId, folder, support.mode, support.reason)
  }
  targets(accountId: string, threadIds: string[]): ImapPinTarget[] {
    if (!threadIds.length) return []
    const rows = this.db.prepare(`SELECT remote_folder_id folder,remote_uid uid,history_id history FROM gmail_messages WHERE account_id=? AND thread_id IN (${threadIds.map(() => '?').join(',')})`).all(accountId, ...threadIds) as { folder: string | null; uid: string | null; history: string }[]
    return rows.flatMap((row) => row.folder && row.uid && /^\d+:\d+$/.test(row.history) && row.history.split(':')[1] === row.uid && Number.isSafeInteger(Number(row.uid)) && Number(row.uid) > 0 ? [{ folder: row.folder, uid: Number(row.uid), uidValidity: row.history.split(':')[0] }] : [])
  }
  capability(accountId: string, threadId: string): MailPinSyncSupport {
    const account = this.db.prepare('SELECT provider,archived FROM gmail_accounts WHERE id=?').get(accountId) as { provider: string; archived: number } | undefined
    if (!account || account.provider !== 'imap' || account.archived) return { mode: 'local-only', reason: 'Pins stay on this computer. This provider has no verified dedicated pin mapping in Aerio.' }
    const targets = this.targets(accountId, [threadId])
    const total = Number((this.db.prepare('SELECT COUNT(*) count FROM gmail_messages WHERE account_id=? AND thread_id=?').get(accountId, threadId) as { count: number }).count)
    if (!targets.length || targets.length !== total) return { mode: 'local-only', reason: 'Pins stay on this computer until every message has a verified IMAP folder and UID identity.' }
    for (const folder of new Set(targets.map((target) => target.folder))) {
      const support = this.db.prepare('SELECT mode,reason FROM mail_pin_sync_folders WHERE account_id=? AND folder_id=?').get(accountId, folder) as MailPinSyncSupport | undefined
      if (!support || support.mode !== 'imap-keyword') return support ?? { mode: 'local-only', reason: 'Pins stay on this computer until a sync verifies permanent keyword support for this folder.' }
    }
    return { mode: 'imap-keyword', reason: `Pins sync between Aerio installations through the dedicated IMAP $AerioPinned keyword; other clients may not recognize it.${this.pending(accountId, threadId) ? ' A pin change is queued for synchronization.' : ''}` }
  }
  pending(accountId: string, threadId: string) {
    return Boolean(this.db.prepare(`SELECT 1 FROM gmail_operations o,json_each(o.thread_ids_json) ids WHERE o.account_id=? AND ids.value=? AND o.kind IN ('pin','unpin') AND o.status IN ('queued','running') LIMIT 1`).get(accountId, threadId))
  }
  /** An older retry must never overwrite a later queued or committed pin decision. */
  activeThreadIds(accountId: string, operationId: string, threadIds: string[]) {
    return threadIds.filter((threadId) => !this.db.prepare(`SELECT 1 FROM gmail_operations o,json_each(o.thread_ids_json) ids WHERE o.account_id=? AND ids.value=? AND o.kind IN ('pin','unpin') AND o.status IN ('queued','running','succeeded') AND o.rowid>(SELECT rowid FROM gmail_operations WHERE id=?) LIMIT 1`).get(accountId, threadId, operationId))
  }
  /** Returns old local pins to upload once when first enabling provider synchronization. */
  reconcile(accountId: string): string[] {
    const uploads: string[] = []
    const threads = this.db.prepare('SELECT DISTINCT thread_id FROM gmail_messages WHERE account_id=?').all(accountId) as { thread_id: string }[]
    for (const { thread_id: threadId } of threads) {
      if (this.capability(accountId, threadId).mode !== 'imap-keyword' || this.pending(accountId, threadId)) continue
      const remotePinned = (this.db.prepare('SELECT label_ids_json FROM gmail_messages WHERE account_id=? AND thread_id=?').all(accountId, threadId) as { label_ids_json: string }[])
        .some((row) => (JSON.parse(row.label_ids_json) as string[]).some((label) => label.toLowerCase() === AERIO_PIN_LABEL.toLowerCase()))
      const seen = this.db.prepare('SELECT 1 FROM mail_pin_sync_threads WHERE account_id=? AND thread_id=?').get(accountId, threadId)
      this.db.prepare('INSERT OR IGNORE INTO mail_pin_sync_threads(account_id,thread_id) VALUES(?,?)').run(accountId, threadId)
      if (!seen && !remotePinned && this.pins.pinnedAt(accountId, threadId)) uploads.push(threadId)
      else this.pins.set(accountId, [threadId], remotePinned)
    }
    return uploads
  }
  acknowledge(accountId: string, results: { folder: string; uid: number; pinned: boolean }[]) {
    for (const result of results) {
      const rows = this.db.prepare('SELECT id,label_ids_json FROM gmail_messages WHERE account_id=? AND remote_folder_id=? AND remote_uid=?').all(accountId, result.folder, String(result.uid)) as { id: string; label_ids_json: string }[]
      for (const row of rows) {
        const labels = (JSON.parse(row.label_ids_json) as string[]).filter((label) => label.toLowerCase() !== AERIO_PIN_LABEL.toLowerCase())
        if (result.pinned) labels.push(AERIO_PIN_LABEL)
        this.db.prepare('UPDATE gmail_messages SET label_ids_json=? WHERE account_id=? AND id=?').run(JSON.stringify(labels), accountId, row.id)
      }
    }
  }
}
