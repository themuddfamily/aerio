import type { DatabaseSync } from 'node:sqlite'
import type {
  MailAttachmentFileType,
  MailAttachmentListItem,
  MailAttachmentPage,
  MailAttachmentQuery
} from '../../src/mail-types'

// Cross-account attachment browsing over the cached gmail_attachments metadata.
// Nothing here touches message content: open/save still go through the
// per-message `attachment:extract` path, which re-parses the stored raw message.

interface DatabaseRow {
  [key: string]: string | number | bigint | null
}

interface FileTypeRule {
  type: Exclude<MailAttachmentFileType, 'other'>
  extensions: string[]
  // SQL LIKE patterns matched against the lower-cased MIME type.
  mimePatterns: string[]
}

// Extensions are checked before MIME types because many senders label
// everything application/octet-stream; rule order breaks ties within a pass.
const FILE_TYPE_RULES: FileTypeRule[] = [
  { type: 'pdf', extensions: ['pdf'], mimePatterns: ['application/pdf', 'application/x-pdf'] },
  { type: 'calendar', extensions: ['ics', 'vcs'], mimePatterns: ['text/calendar', 'application/ics'] },
  { type: 'spreadsheet', extensions: ['xls', 'xlsx', 'xlsm', 'ods', 'csv', 'tsv', 'numbers'], mimePatterns: ['application/vnd.ms-excel%', '%spreadsheetml%', 'application/vnd.oasis.opendocument.spreadsheet', 'text/csv', 'text/tab-separated-values'] },
  { type: 'presentation', extensions: ['ppt', 'pptx', 'odp', 'key'], mimePatterns: ['application/vnd.ms-powerpoint%', '%presentationml%', 'application/vnd.oasis.opendocument.presentation'] },
  { type: 'document', extensions: ['doc', 'docx', 'odt', 'rtf', 'txt', 'md', 'pages'], mimePatterns: ['application/msword', '%wordprocessingml%', 'application/vnd.oasis.opendocument.text', 'application/rtf', 'text/rtf', 'text/plain', 'text/markdown'] },
  { type: 'archive', extensions: ['zip', '7z', 'rar', 'gz', 'tgz', 'tar', 'bz2', 'xz'], mimePatterns: ['application/zip', 'application/x-zip-compressed', 'application/x-7z-compressed', 'application/x-rar-compressed', 'application/vnd.rar', 'application/gzip', 'application/x-gzip', 'application/x-tar', 'application/x-bzip2', 'application/x-xz'] },
  { type: 'image', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tif', 'tiff', 'svg'], mimePatterns: ['image/%'] },
  { type: 'audio', extensions: ['mp3', 'm4a', 'wav', 'flac', 'ogg', 'aac'], mimePatterns: ['audio/%'] },
  { type: 'video', extensions: ['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm'], mimePatterns: ['video/%'] }
]

export const MAIL_ATTACHMENT_FILE_TYPES: MailAttachmentFileType[] = [...FILE_TYPE_RULES.map((rule) => rule.type), 'other']

const likeToRegExp = (pattern: string) => new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('%', '.*').replaceAll('_', '.')}$`)
const mimeMatchers = new Map(FILE_TYPE_RULES.map((rule) => [rule.type, rule.mimePatterns.map(likeToRegExp)]))

/** Mirrors `fileTypeSql` so renderer-facing values and SQL filters agree. */
export function attachmentFileType(mimeType: string, filename: string): MailAttachmentFileType {
  const name = filename.trim().toLowerCase()
  const mime = mimeType.trim().toLowerCase()
  for (const rule of FILE_TYPE_RULES) if (rule.extensions.some((extension) => name.endsWith(`.${extension}`))) return rule.type
  for (const rule of FILE_TYPE_RULES) if (mimeMatchers.get(rule.type)!.some((matcher) => matcher.test(mime))) return rule.type
  return 'other'
}

const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`

function fileTypeSql(nameColumn: string, mimeColumn: string) {
  const name = `lower(trim(${nameColumn}))`
  const mime = `lower(trim(${mimeColumn}))`
  const byExtension = FILE_TYPE_RULES.map((rule) => `WHEN ${rule.extensions.map((extension) => `${name} LIKE ${sqlString(`%.${extension}`)}`).join(' OR ')} THEN ${sqlString(rule.type)}`)
  const byMime = FILE_TYPE_RULES.map((rule) => `WHEN ${rule.mimePatterns.map((pattern) => `${mime} LIKE ${sqlString(pattern)}`).join(' OR ')} THEN ${sqlString(rule.type)}`)
  return `CASE ${[...byExtension, ...byMime].join(' ')} ELSE 'other' END`
}

const FILE_TYPE_SQL = fileTypeSql('a.filename', 'a.mime_type')

interface AttachmentCursor { date: string; accountId: string; messageId: string; id: string }

const encodeCursor = (cursor: AttachmentCursor) => Buffer.from(JSON.stringify(cursor)).toString('base64url')

function decodeCursor(value: string): AttachmentCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<AttachmentCursor>
    if ([parsed.date, parsed.accountId, parsed.messageId, parsed.id].every((part) => typeof part === 'string')) return parsed as AttachmentCursor
  } catch { /* Reported below. */ }
  throw new Error('The attachment list position is no longer valid')
}

const text = (value: unknown, max = 200) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined
const bytes = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
const isoDate = (value: unknown) => {
  const candidate = text(value, 40)
  return candidate && !Number.isNaN(Date.parse(candidate)) ? candidate : undefined
}

/** Drops malformed renderer input instead of letting it reach SQL. */
export function normalizeAttachmentQuery(input: unknown): MailAttachmentQuery {
  const query = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const accountIds = Array.isArray(query.accountIds) ? query.accountIds.filter((id): id is string => typeof id === 'string' && id.length > 0).slice(0, 100) : undefined
  const fileTypes = Array.isArray(query.fileTypes) ? [...new Set(query.fileTypes.filter((type): type is MailAttachmentFileType => MAIL_ATTACHMENT_FILE_TYPES.includes(type as MailAttachmentFileType)))] : undefined
  const pageSize = typeof query.pageSize === 'number' && Number.isFinite(query.pageSize) ? Math.min(Math.max(Math.floor(query.pageSize), 1), 100) : 50
  return {
    accountIds: accountIds?.length ? accountIds : undefined,
    includeArchivedAccounts: query.includeArchivedAccounts !== false,
    includeInline: query.includeInline === true,
    search: text(query.search),
    sender: text(query.sender),
    recipient: text(query.recipient),
    dateFrom: isoDate(query.dateFrom),
    dateTo: isoDate(query.dateTo),
    fileTypes: fileTypes?.length ? fileTypes : undefined,
    minSize: bytes(query.minSize),
    maxSize: bytes(query.maxSize),
    cursor: text(query.cursor, 2_000),
    pageSize
  }
}

const containsPattern = (value: string) => `%${value.trim().replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
const json = <T>(value: unknown, fallback: T): T => {
  try {
    return typeof value === 'string' && value ? JSON.parse(value) as T : fallback
  } catch {
    return fallback
  }
}

export function listAttachmentPage(db: DatabaseSync, input: unknown, rawExists: (path: string) => boolean): MailAttachmentPage {
  const query = normalizeAttachmentQuery(input)
  const where: string[] = [
    // Trash and spam are excluded the same way the "All mail" folder excludes them.
    't.trashed=0',
    `NOT EXISTS(SELECT 1 FROM json_each(t.label_ids_json) WHERE value='SPAM')`,
    // Provider copies of one logical message (e.g. IMAP folders) appear once, as
    // the newest copy, matching how the thread reader groups by Message-ID.
    `NOT EXISTS(SELECT 1 FROM gmail_messages d WHERE d.account_id=m.account_id AND d.thread_id=m.thread_id AND d.id<>m.id
      AND trim(coalesce(m.header_message_id,''))<>'' AND lower(trim(d.header_message_id))=lower(trim(m.header_message_id))
      AND (d.internal_date>m.internal_date OR (d.internal_date=m.internal_date AND d.id>m.id)))`
  ]
  const params: (string | number)[] = []
  if (query.accountIds) {
    where.push(`a.account_id IN (${query.accountIds.map(() => '?').join(',')})`)
    params.push(...query.accountIds)
  }
  if (!query.includeArchivedAccounts) where.push('acc.archived=0')
  if (!query.includeInline) where.push(`NOT (coalesce(a.content_id,'')<>'' AND lower(a.mime_type) LIKE 'image/%')`)
  if (query.search) {
    where.push(`lower(a.filename) LIKE lower(?) ESCAPE '\\'`)
    params.push(containsPattern(query.search))
  }
  if (query.sender) {
    where.push(`lower(m.from_name||' '||m.from_email) LIKE lower(?) ESCAPE '\\'`)
    params.push(containsPattern(query.sender))
  }
  if (query.recipient) {
    where.push(`lower(m.to_json||' '||m.cc_json) LIKE lower(?) ESCAPE '\\'`)
    params.push(containsPattern(query.recipient))
  }
  if (query.dateFrom) {
    where.push('datetime(m.internal_date)>=datetime(?)')
    params.push(query.dateFrom)
  }
  if (query.dateTo) {
    where.push(`datetime(m.internal_date)<datetime(?, '+1 day')`)
    params.push(query.dateTo)
  }
  if (query.fileTypes) {
    where.push(`(${FILE_TYPE_SQL}) IN (${query.fileTypes.map(() => '?').join(',')})`)
    params.push(...query.fileTypes)
  }
  if (query.minSize !== undefined) {
    where.push('a.size>=?')
    params.push(query.minSize)
  }
  if (query.maxSize !== undefined) {
    where.push('a.size<=?')
    params.push(query.maxSize)
  }
  const from = `FROM gmail_attachments a
    JOIN gmail_messages m ON m.account_id=a.account_id AND m.id=a.message_id
    JOIN gmail_threads t ON t.account_id=m.account_id AND t.id=m.thread_id
    JOIN gmail_accounts acc ON acc.id=a.account_id`
  const total = Number((db.prepare(`SELECT COUNT(*) total ${from} WHERE ${where.join(' AND ')}`).get(...params) as DatabaseRow).total)
  const pageWhere = [...where]
  const pageParams = [...params]
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor)
    pageWhere.push('(m.internal_date,a.account_id,a.message_id,a.id)<(?,?,?,?)')
    pageParams.push(cursor.date, cursor.accountId, cursor.messageId, cursor.id)
  }
  const pageSize = query.pageSize ?? 50
  const rows = db.prepare(`
    SELECT a.account_id,a.message_id,a.id,a.filename,a.mime_type,a.size,${FILE_TYPE_SQL} file_type,
      m.thread_id,m.internal_date,m.from_name,m.from_email,m.to_json,m.cc_json,m.subject,m.raw_path,acc.archived
    ${from}
    WHERE ${pageWhere.join(' AND ')}
    ORDER BY m.internal_date DESC,a.account_id DESC,a.message_id DESC,a.id DESC
    LIMIT ?
  `).all(...pageParams, pageSize + 1) as DatabaseRow[]
  const visible = rows.slice(0, pageSize)
  const availability = new Map<string, boolean>()
  const items: MailAttachmentListItem[] = visible.map((row) => {
    const rawPath = String(row.raw_path ?? '')
    if (!availability.has(rawPath)) availability.set(rawPath, Boolean(rawPath) && rawExists(rawPath))
    return {
      accountId: String(row.account_id),
      threadId: String(row.thread_id),
      messageId: String(row.message_id),
      attachmentId: String(row.id),
      filename: String(row.filename),
      mimeType: String(row.mime_type),
      size: Number(row.size),
      fileType: String(row.file_type) as MailAttachmentFileType,
      date: String(row.internal_date),
      fromName: String(row.from_name ?? ''),
      fromEmail: String(row.from_email ?? ''),
      to: json<string[]>(row.to_json, []),
      cc: json<string[]>(row.cc_json, []),
      subject: String(row.subject || '(No subject)'),
      available: availability.get(rawPath)!,
      accountArchived: Boolean(row.archived)
    }
  })
  const last = visible.at(-1)
  return {
    items,
    total,
    nextCursor: rows.length > pageSize && last
      ? encodeCursor({ date: String(last.internal_date), accountId: String(last.account_id), messageId: String(last.message_id), id: String(last.id) })
      : undefined
  }
}
