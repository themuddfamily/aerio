import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { closeSync, openSync, readSync } from 'node:fs'
import type { MailRuleTrigger } from '../../src/mail-types'
import { normalizeMessageId } from './reply-watches'

const RETENTION_MS = 180 * 24 * 60 * 60_000
const HEADER_READ_LIMIT = 256 * 1024

/**
 * The key a message is processed under. The Message-ID survives a move
 * between IMAP folders (which assigns a new local id) and resyncs, so a
 * message moved by a rule isn't treated as new mail and processed again.
 */
export function ruleLedgerKey(message: { id: string; messageIdHeader?: string }) {
  const header = normalizeMessageId(message.messageIdHeader)
  return header ? `mid:${header}` : `id:${message.id}`
}

// Records every message that automatic rules have processed, per trigger, so
// one message is never processed twice: not after a resync, not when its
// copy appears in another folder, and not when both Gmail history and a
// follow-up sync report it.
export class RuleRunLedger {
  private statements = new Map<string, StatementSync>()

  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mail_rule_processed (
        account_id TEXT NOT NULL REFERENCES gmail_accounts(id) ON DELETE CASCADE,
        message_key TEXT NOT NULL,
        trigger_mode TEXT NOT NULL,
        message_id TEXT NOT NULL,
        processed_at TEXT NOT NULL,
        PRIMARY KEY (account_id, message_key, trigger_mode)
      );
      CREATE INDEX IF NOT EXISTS mail_rule_processed_age ON mail_rule_processed(processed_at);
    `)
    this.prune()
  }

  private stmt(sql: string) {
    const cached = this.statements.get(sql)
    if (cached) return cached
    const statement = this.db.prepare(sql)
    this.statements.set(sql, statement)
    return statement
  }

  /** Atomically records the message; false when it was already processed for this trigger. */
  claim(accountId: string, message: { id: string; messageIdHeader?: string }, trigger: MailRuleTrigger) {
    const result = this.stmt('INSERT OR IGNORE INTO mail_rule_processed(account_id,message_key,trigger_mode,message_id,processed_at) VALUES(?,?,?,?,?)')
      .run(accountId, ruleLedgerKey(message), trigger, message.id, new Date().toISOString())
    return Number(result.changes) > 0
  }

  processed(accountId: string, message: { id: string; messageIdHeader?: string }, trigger: MailRuleTrigger) {
    return Boolean(this.stmt('SELECT 1 FROM mail_rule_processed WHERE account_id=? AND message_key=? AND trigger_mode=?').get(accountId, ruleLedgerKey(message), trigger))
  }

  prune(now = Date.now()) {
    this.stmt('DELETE FROM mail_rule_processed WHERE processed_at<?').run(new Date(now - RETENTION_MS).toISOString())
  }
}

/** Parses an RFC 5322 header block into lower-case names and unfolded values. */
export function parseHeaderBlock(source: string): Record<string, string[]> {
  const end = source.search(/\r?\n\r?\n/)
  const block = (end >= 0 ? source.slice(0, end) : source).replace(/\r?\n[ \t]+/g, ' ')
  const headers: Record<string, string[]> = {}
  for (const line of block.split(/\r?\n/)) {
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const name = line.slice(0, separator).trim().toLowerCase()
    if (!name || /\s/.test(name)) continue
    ;(headers[name] ??= []).push(line.slice(separator + 1).trim())
  }
  return headers
}

/** Reads only the header block of a stored raw message; undefined when the file is unavailable. */
export function readRawHeaders(path: string): Record<string, string[]> | undefined {
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, 'r')
    const buffer = Buffer.alloc(HEADER_READ_LIMIT)
    const length = readSync(descriptor, buffer, 0, buffer.length, 0)
    return parseHeaderBlock(buffer.subarray(0, length).toString('utf8'))
  } catch {
    return undefined
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}
