import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { MailAttachmentTextIndex, MailAttachmentTextStatus } from '../../src/mail-types'
import { ATTACHMENT_TEXT_EXTRACTOR_VERSION, type AttachmentTextResult } from './attachment-text-types'

interface DatabaseRow {
  [key: string]: string | number | bigint | null
}

/** An attachment that has not been extracted by the current extractor version. */
export interface PendingAttachment {
  accountId: string
  messageId: string
  attachmentId: string
  filename: string
  mimeType: string
  size: number
}

export type AttachmentTextStats = Record<MailAttachmentTextStatus, number>

// Extracted text shares the FTS row with the message, so one huge message can't bloat the index.
export const MAX_MESSAGE_ATTACHMENT_TEXT = 1_000_000

const nowIso = () => new Date().toISOString()

/**
 * Extracted attachment text, one row per attachment. Rows are keyed by the
 * attachment id and size so a changed attachment is re-extracted, and they are
 * removed with their message or account. The text is copied into the
 * message's `gmail_fts.attachment_names` column, which is what `attachment:`
 * searches and unscoped searches match against.
 */
export class AttachmentTextStore {
  private statements = new Map<string, StatementSync>()

  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mail_attachment_text (
        account_id TEXT NOT NULL REFERENCES gmail_accounts(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL,
        attachment_id TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        text TEXT NOT NULL DEFAULT '',
        truncated INTEGER NOT NULL DEFAULT 0,
        detail TEXT,
        extractor_version INTEGER NOT NULL,
        indexed_at TEXT NOT NULL,
        PRIMARY KEY (account_id, message_id, attachment_id)
      );
    `)
  }

  private stmt(sql: string) {
    const cached = this.statements.get(sql)
    if (cached) return cached
    const statement = this.db.prepare(sql)
    this.statements.set(sql, statement)
    return statement
  }

  /** Newest messages first, so recent mail becomes searchable before the backlog. */
  pending(limit: number, excludedAccountIds: Iterable<string> = []) {
    const excluded = [...excludedAccountIds]
    const rows = this.db.prepare(`
      SELECT a.account_id,a.message_id,a.id,a.filename,a.mime_type,a.size
      FROM gmail_attachments a
      JOIN gmail_messages m ON m.account_id=a.account_id AND m.id=a.message_id
      LEFT JOIN mail_attachment_text r ON r.account_id=a.account_id AND r.message_id=a.message_id AND r.attachment_id=a.id
      WHERE (r.account_id IS NULL OR r.extractor_version<? OR r.size<>a.size)
        ${excluded.length ? `AND a.account_id NOT IN (${excluded.map(() => '?').join(',')})` : ''}
      ORDER BY m.internal_date DESC, a.account_id, a.message_id, a.id
      LIMIT ?
    `).all(ATTACHMENT_TEXT_EXTRACTOR_VERSION, ...excluded, Math.max(1, limit)) as DatabaseRow[]
    return rows.map((row): PendingAttachment => ({
      accountId: String(row.account_id),
      messageId: String(row.message_id),
      attachmentId: String(row.id),
      filename: String(row.filename),
      mimeType: String(row.mime_type),
      size: Number(row.size)
    }))
  }

  /**
   * Records an extraction result. Returns false, writing nothing, when the
   * attachment was deleted (with its message or account) while it was parsed.
   */
  save(attachment: PendingAttachment, result: AttachmentTextResult) {
    const change = this.stmt(`
      INSERT INTO mail_attachment_text(account_id,message_id,attachment_id,size,status,text,truncated,detail,extractor_version,indexed_at)
      SELECT a.account_id,a.message_id,a.id,a.size,?,?,?,?,?,? FROM gmail_attachments a
      WHERE a.account_id=? AND a.message_id=? AND a.id=? AND a.size=?
      ON CONFLICT(account_id,message_id,attachment_id) DO UPDATE SET size=excluded.size,status=excluded.status,text=excluded.text,
        truncated=excluded.truncated,detail=excluded.detail,extractor_version=excluded.extractor_version,indexed_at=excluded.indexed_at
    `).run(
      result.status, result.status === 'indexed' ? result.text : '', result.truncated ? 1 : 0, result.detail ?? null,
      ATTACHMENT_TEXT_EXTRACTOR_VERSION, nowIso(), attachment.accountId, attachment.messageId, attachment.attachmentId, attachment.size
    )
    return Number(change.changes) > 0
  }

  /** Drops rows for attachments the message no longer has, or whose size changed. */
  prune(accountId: string, messageId: string) {
    this.stmt(`DELETE FROM mail_attachment_text WHERE account_id=? AND message_id=? AND NOT EXISTS(
      SELECT 1 FROM gmail_attachments a WHERE a.account_id=mail_attachment_text.account_id AND a.message_id=mail_attachment_text.message_id
        AND a.id=mail_attachment_text.attachment_id AND a.size=mail_attachment_text.size)`).run(accountId, messageId)
  }

  /** The value for the message's `attachment_names` FTS column: filenames, then extracted text. */
  searchValue(accountId: string, messageId: string) {
    const names = (this.stmt('SELECT filename FROM gmail_attachments WHERE account_id=? AND message_id=? ORDER BY filename').all(accountId, messageId) as DatabaseRow[])
      .map((row) => String(row.filename))
    const texts = (this.stmt(`SELECT text FROM mail_attachment_text WHERE account_id=? AND message_id=? AND status='indexed' ORDER BY attachment_id`).all(accountId, messageId) as DatabaseRow[])
      .map((row) => String(row.text))
    return [names.join(' '), ...texts].join('\n').slice(0, MAX_MESSAGE_ATTACHMENT_TEXT)
  }

  /** Rewrites the message's search row so newly extracted text becomes searchable. */
  refreshSearch(accountId: string, messageId: string) {
    this.stmt('UPDATE gmail_fts SET attachment_names=? WHERE account_id=? AND message_id=?').run(this.searchValue(accountId, messageId), accountId, messageId)
  }

  /** The user-facing index state of one attachment; anything not processed by the current extractor is pending. */
  textIndex(accountId: string, messageId: string, attachmentId: string, size: number): MailAttachmentTextIndex {
    const row = this.stmt('SELECT size,status,truncated,detail,extractor_version,indexed_at FROM mail_attachment_text WHERE account_id=? AND message_id=? AND attachment_id=?')
      .get(accountId, messageId, attachmentId) as DatabaseRow | undefined
    if (!row || Number(row.extractor_version) < ATTACHMENT_TEXT_EXTRACTOR_VERSION || Number(row.size) !== size) return { status: 'pending' }
    return {
      status: String(row.status) as MailAttachmentTextStatus,
      ...(row.truncated ? { truncated: true } : {}),
      ...(row.detail ? { detail: String(row.detail) } : {}),
      indexedAt: String(row.indexed_at)
    }
  }

  stats(accountId?: string): AttachmentTextStats {
    const stats: AttachmentTextStats = { pending: 0, indexed: 0, empty: 0, unsupported: 0, encrypted: 0, 'too-large': 0, timeout: 0, 'memory-limit': 0, failed: 0 }
    const scope = accountId ? 'WHERE a.account_id=?' : ''
    const rows = this.db.prepare(`
      SELECT CASE WHEN r.account_id IS NULL OR r.extractor_version<? OR r.size<>a.size THEN 'pending' ELSE r.status END status, COUNT(*) count
      FROM gmail_attachments a
      LEFT JOIN mail_attachment_text r ON r.account_id=a.account_id AND r.message_id=a.message_id AND r.attachment_id=a.id
      ${scope} GROUP BY 1
    `).all(ATTACHMENT_TEXT_EXTRACTOR_VERSION, ...(accountId ? [accountId] : [])) as DatabaseRow[]
    for (const row of rows) stats[String(row.status) as MailAttachmentTextStatus] = Number(row.count)
    return stats
  }

  deleteMessage(accountId: string, messageId: string) {
    this.stmt('DELETE FROM mail_attachment_text WHERE account_id=? AND message_id=?').run(accountId, messageId)
  }

  deleteAccount(accountId: string) {
    this.stmt('DELETE FROM mail_attachment_text WHERE account_id=?').run(accountId)
  }
}
