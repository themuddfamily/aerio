import type { DatabaseSync } from 'node:sqlite'
import type { MailContactHistoryItem, MailContactHistoryPage, MailContactHistoryQuery } from '../../src/mail-types'
import { VISIBLE_MESSAGE_WHERE, normalizeParticipants, participantSql } from './attachment-index'

// A contact's communication history: cached messages sent by or to any of its addresses across
// the chosen accounts. Like the attachments workspace, this reads cached metadata only. Messages
// of a deleted account disappear with its rows; archived accounts stay and are labelled.

interface DatabaseRow {
  [key: string]: string | number | bigint | null
}

interface HistoryCursor { date: string; accountId: string; messageId: string }

const encodeCursor = (cursor: HistoryCursor) => Buffer.from(JSON.stringify(cursor)).toString('base64url')

function decodeCursor(value: string): HistoryCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<HistoryCursor>
    if ([parsed.date, parsed.accountId, parsed.messageId].every((part) => typeof part === 'string')) return parsed as HistoryCursor
  } catch { /* Reported below. */ }
  throw new Error('The message history position is no longer valid')
}

const json = <T>(value: unknown, fallback: T): T => {
  try {
    return typeof value === 'string' && value ? JSON.parse(value) as T : fallback
  } catch {
    return fallback
  }
}

/** Drops malformed renderer input instead of letting it reach SQL. */
export function normalizeContactHistoryQuery(input: unknown): MailContactHistoryQuery {
  const query = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const accountIds = Array.isArray(query.accountIds) ? query.accountIds.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200).slice(0, 100) : undefined
  const pageSize = typeof query.pageSize === 'number' && Number.isFinite(query.pageSize) ? Math.min(Math.max(Math.floor(query.pageSize), 1), 100) : 25
  return {
    addresses: normalizeParticipants(query.addresses) ?? [],
    // An explicit empty selection means "no accounts", not "all accounts".
    accountIds: accountIds ?? undefined,
    includeArchivedAccounts: query.includeArchivedAccounts !== false,
    cursor: typeof query.cursor === 'string' && query.cursor.length <= 2_000 ? query.cursor : undefined,
    pageSize
  }
}

export function listContactHistoryPage(db: DatabaseSync, input: unknown): MailContactHistoryPage {
  const query = normalizeContactHistoryQuery(input)
  if (!query.addresses.length || (query.accountIds && !query.accountIds.length)) return { items: [], total: 0 }
  const match = participantSql('m', query.addresses.length)
  const where = [...VISIBLE_MESSAGE_WHERE, match.sql]
  const params: (string | number)[] = [...match.params(query.addresses)]
  if (query.accountIds) {
    where.push(`m.account_id IN (${query.accountIds.map(() => '?').join(',')})`)
    params.push(...query.accountIds)
  }
  if (!query.includeArchivedAccounts) where.push('acc.archived=0')
  const from = `FROM gmail_messages m
    JOIN gmail_threads t ON t.account_id=m.account_id AND t.id=m.thread_id
    JOIN gmail_accounts acc ON acc.id=m.account_id`
  const total = Number((db.prepare(`SELECT COUNT(*) total ${from} WHERE ${where.join(' AND ')}`).get(...params) as DatabaseRow).total)
  const pageWhere = [...where]
  const pageParams = [...params]
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor)
    pageWhere.push('(m.internal_date,m.account_id,m.id)<(?,?,?)')
    pageParams.push(cursor.date, cursor.accountId, cursor.messageId)
  }
  const pageSize = query.pageSize ?? 25
  const senders = query.addresses.map(() => '?').join(',')
  const rows = db.prepare(`
    SELECT m.account_id,m.id,m.thread_id,m.internal_date,m.from_name,m.from_email,m.to_json,m.cc_json,m.subject,m.snippet,
      acc.email account_email,acc.archived,
      CASE WHEN lower(trim(m.from_email)) IN (${senders}) THEN 'from' ELSE 'to' END direction,
      (SELECT COUNT(*) FROM gmail_attachments a WHERE a.account_id=m.account_id AND a.message_id=m.id
        AND NOT (coalesce(a.content_id,'')<>'' AND lower(a.mime_type) LIKE 'image/%')) attachment_count
    ${from}
    WHERE ${pageWhere.join(' AND ')}
    ORDER BY m.internal_date DESC,m.account_id DESC,m.id DESC
    LIMIT ?
  `).all(...query.addresses, ...pageParams, pageSize + 1) as DatabaseRow[]
  const visible = rows.slice(0, pageSize)
  const items: MailContactHistoryItem[] = visible.map((row) => ({
    accountId: String(row.account_id),
    accountEmail: String(row.account_email),
    accountArchived: Boolean(row.archived),
    threadId: String(row.thread_id),
    messageId: String(row.id),
    date: String(row.internal_date),
    fromName: String(row.from_name ?? ''),
    fromEmail: String(row.from_email ?? ''),
    to: json<string[]>(row.to_json, []),
    cc: json<string[]>(row.cc_json, []),
    subject: String(row.subject || '(No subject)'),
    snippet: String(row.snippet ?? ''),
    direction: row.direction === 'from' ? 'from' : 'to',
    attachmentCount: Number(row.attachment_count ?? 0)
  }))
  const last = visible.at(-1)
  return {
    items,
    total,
    nextCursor: rows.length > pageSize && last
      ? encodeCursor({ date: String(last.internal_date), accountId: String(last.account_id), messageId: String(last.id) })
      : undefined
  }
}
