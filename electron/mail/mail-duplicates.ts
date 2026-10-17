import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import PostalMime from 'postal-mime'
import type { DuplicateConfidence, DuplicateExclusion, DuplicateItem, DuplicateReasonCode } from '../../src/duplicate-cleanup-types'
import type { MailProviderId, PendingOperation } from '../../src/mail-types'
import { DuplicateUnion, normalizeText, suggestedKeeper } from '../../src/lib/duplicate-grouping'
import type { MailDatabase } from './database'

// Existing-mail duplicate scanner (E32). Messages are only compared inside one location:
// a Gmail account (labels are views of one message, never separate copies) or one
// IMAP/Microsoft/Local folder. The same Message-ID in several IMAP folders is one logical
// message in many places, so it is never offered for removal. Removal trashes individual
// messages through the queued operation pipeline, so the normal Undo applies.

type Row = Record<string, string | number | bigint | null>

export interface MailDuplicateScope { accountId: string; labelIds?: string[] }

export interface MailDuplicateItem extends DuplicateItem {
  accountId: string
  messageId: string
  revision: string
}

export interface MailDuplicateGroup {
  confidence: DuplicateConfidence
  codes: DuplicateReasonCode[]
  notes: string[]
  keeperId: string
  items: MailDuplicateItem[]
}

export interface MailDuplicateScan {
  scanned: number
  groups: MailDuplicateGroup[]
  excluded: DuplicateExclusion[]
}

export interface MailDuplicateTrashInput {
  accountId: string
  items: { messageId: string; revision: string; keeper?: { messageId: string; revision: string } }[]
}

export interface MailDuplicateTrashResult {
  operation?: PendingOperation
  results: { messageId: string; outcome: 'removed' | 'stale' | 'failed'; message?: string }[]
}

export interface MailDuplicateRecord {
  accountId: string
  id: string
  threadId: string
  revision: string
  date: string
  fromName: string
  fromEmail: string
  subject: string
  messageIdHeader: string
  size: number
  labels: string[]
  location: string
  locationLabel: string
  rawPath?: string
  attachments: { filename: string; mimeType: string; size: number }[]
}

export interface MailDuplicateContent {
  contentHash: string
  attachmentHashes: string[]
}

const FLAG_LABELS = new Set(['UNREAD', 'STARRED', 'IMPORTANT'])
const EXCLUDED_LABELS = new Set(['TRASH', 'SPAM', 'DRAFT'])
const FINGERPRINT_WINDOW_MS = 2_000
const MAX_RAW_BYTES = 60 * 1024 * 1024
const json = <T>(value: unknown, fallback: T): T => {
  try { return typeof value === 'string' && value ? JSON.parse(value) as T : fallback } catch { return fallback }
}
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')

// Headers added or rewritten in transit or by a mail store; two deliveries of the same
// message differ only in these, so they are left out of the content hash.
const TRANSIENT_HEADER = /^(received|return-path|delivered-to|x-received|arc-[a-z-]+|authentication-results|received-spf|x-gm-[a-z-]+|x-google-[a-z-]+|x-ms-exchange-[a-z-]+|x-microsoft-[a-z-]+|x-apple-[a-z-]+|x-original-to|x-uid|x-keywords|x-status|status|x-mozilla-[a-z-]+|content-length|lines|x-imap[a-z-]*|x-account-key|x-spam-[a-z-]+|x-virus-[a-z-]+)$/i

export const normalizeMessageId = (value: string | undefined | null) => (value ?? '').trim().replace(/^<|>$/g, '').trim().toLowerCase()
export const normalizeSubject = (value: string) => normalizeText(value).replace(/^((re|fw|fwd|aw|wg)\s*:\s*)+/i, '')

export function normalizedContentHash(raw: Buffer) {
  const text = raw.toString('latin1').replace(/\r\n?/g, '\n')
  const split = text.indexOf('\n\n')
  const headerText = split === -1 ? text : text.slice(0, split)
  const body = split === -1 ? '' : text.slice(split + 2)
  const headers: string[] = []
  for (const line of headerText.split('\n')) {
    if (/^[ \t]/.test(line) && headers.length) headers[headers.length - 1] += ` ${line.trim()}`
    else if (line.trim()) headers.push(line)
  }
  const kept = headers.flatMap((header) => {
    const colon = header.indexOf(':')
    if (colon <= 0) return []
    const name = header.slice(0, colon).trim().toLowerCase()
    if (TRANSIENT_HEADER.test(name)) return []
    return [`${name}:${header.slice(colon + 1).replace(/\s+/g, ' ').trim()}`]
  })
  const normalizedBody = body.split('\n').map((line) => line.replace(/[ \t]+$/, '')).join('\n').replace(/\n+$/, '')
  return sha256(`${kept.join('\n')}\n\n${normalizedBody}`)
}

export async function mailDuplicateContent(raw: Buffer): Promise<MailDuplicateContent> {
  let attachmentHashes: string[] = []
  try {
    const parsed = await PostalMime.parse(raw)
    attachmentHashes = parsed.attachments.map((attachment) => sha256(typeof attachment.content === 'string'
      ? Buffer.from(attachment.content, attachment.encoding === 'base64' ? 'base64' : 'utf8')
      : Buffer.from(attachment.content instanceof ArrayBuffer ? new Uint8Array(attachment.content) : attachment.content))).sort()
  } catch {
    // An unparsable message still has a content hash; its attachments compare as raw content.
  }
  return { contentHash: normalizedContentHash(raw), attachmentHashes }
}

export function readStoredRaw(path: string | undefined) {
  if (!path || !existsSync(path)) return undefined
  try {
    if (statSync(path).size > MAX_RAW_BYTES) return undefined
    return readFileSync(path)
  } catch {
    return undefined
  }
}

function location(provider: MailProviderId, row: Row, labels: string[], names: Map<string, string>) {
  const folder = row.remote_folder_id ? String(row.remote_folder_id) : ''
  if (folder) return { key: `folder:${folder}`, label: names.get(`folder:${folder}`) ?? folder }
  // A Gmail message is one record however many labels it carries.
  if (provider === 'gmail') return { key: 'account', label: 'All Mail' }
  const folders = labels.filter((label) => !FLAG_LABELS.has(label) && !label.startsWith('CATEGORY_')).sort()
  return { key: `labels:${folders.join('|')}`, label: folders.map((label) => names.get(label) ?? label).join(', ') || 'Inbox' }
}

const revisionOf = (row: Row) => `${String(row.history_id)}|${json<string[]>(row.label_ids_json, []).includes('TRASH') ? 'trash' : 'live'}`

export class MailDuplicateStore {
  constructor(private readonly db: DatabaseSync, private readonly database: Pick<MailDatabase, 'getAccount' | 'applyLocalAction'>) {}

  labelNames(accountId: string) {
    return new Map((this.db.prepare('SELECT id,name FROM gmail_labels WHERE account_id=?').all(accountId) as Row[]).map((row) => [String(row.id), String(row.name)]))
  }

  records(scope: MailDuplicateScope): MailDuplicateRecord[] {
    const account = this.database.getAccount(scope.accountId)
    if (!account) return []
    const names = this.labelNames(scope.accountId)
    const wanted = scope.labelIds?.length ? new Set(scope.labelIds) : undefined
    const attachments = new Map<string, MailDuplicateRecord['attachments']>()
    for (const row of this.db.prepare('SELECT message_id,filename,mime_type,size FROM gmail_attachments WHERE account_id=?').all(scope.accountId) as Row[]) {
      const list = attachments.get(String(row.message_id)) ?? []
      list.push({ filename: String(row.filename), mimeType: String(row.mime_type), size: Number(row.size) })
      attachments.set(String(row.message_id), list)
    }
    const rows = this.db.prepare(`SELECT id,thread_id,history_id,internal_date,from_name,from_email,subject,header_message_id,label_ids_json,size_estimate,raw_path,remote_folder_id
      FROM gmail_messages WHERE account_id=? ORDER BY internal_date,id`).all(scope.accountId) as Row[]
    return rows.flatMap((row) => {
      const labels = json<string[]>(row.label_ids_json, [])
      if (labels.some((label) => EXCLUDED_LABELS.has(label))) return []
      if (wanted && !labels.some((label) => wanted.has(label))) return []
      const place = location(account.provider, row, labels, names)
      return [{
        accountId: scope.accountId,
        id: String(row.id),
        threadId: String(row.thread_id),
        revision: revisionOf(row),
        date: String(row.internal_date),
        fromName: String(row.from_name ?? ''),
        fromEmail: String(row.from_email ?? '').toLowerCase(),
        subject: String(row.subject ?? ''),
        messageIdHeader: normalizeMessageId(row.header_message_id ? String(row.header_message_id) : ''),
        size: Number(row.size_estimate ?? 0),
        labels,
        location: place.key,
        locationLabel: place.label,
        rawPath: row.raw_path ? String(row.raw_path) : undefined,
        attachments: (attachments.get(String(row.id)) ?? []).sort((a, b) => a.filename.localeCompare(b.filename) || a.size - b.size)
      }]
    })
  }

  current(accountId: string, messageIds: string[]) {
    const result = new Map<string, { threadId: string; revision: string }>()
    const statement = this.db.prepare('SELECT thread_id,history_id,label_ids_json FROM gmail_messages WHERE account_id=? AND id=?')
    for (const id of messageIds) {
      const row = statement.get(accountId, id) as Row | undefined
      if (row) result.set(id, { threadId: String(row.thread_id), revision: revisionOf(row) })
    }
    return result
  }

  // Trashes only the listed messages (never whole conversations), after checking that
  // none changed since the scan. Stale messages are skipped and reported.
  trash(input: MailDuplicateTrashInput): MailDuplicateTrashResult {
    const current = this.current(input.accountId, input.items.flatMap((item) => item.keeper ? [item.messageId, item.keeper.messageId] : [item.messageId]))
    const results: MailDuplicateTrashResult['results'] = []
    const ready: string[] = []
    for (const item of input.items) {
      const now = current.get(item.messageId)
      const keeper = item.keeper ? current.get(item.keeper.messageId) : undefined
      if (item.keeper && (!keeper || keeper.revision !== item.keeper.revision)) results.push({ messageId: item.messageId, outcome: 'stale', message: 'The copy you chose to keep changed or was removed since the scan. Scan again.' })
      else if (!now) results.push({ messageId: item.messageId, outcome: 'stale', message: 'This message is no longer in the mailbox' })
      else if (now.revision !== item.revision) results.push({ messageId: item.messageId, outcome: 'stale', message: 'This message changed since the scan; scan again to review it' })
      else ready.push(item.messageId)
    }
    if (!ready.length) return { results }
    const threadIds = [...new Set(ready.map((id) => current.get(id)!.threadId))]
    try {
      const operation = this.database.applyLocalAction({ accountId: input.accountId, threadIds, action: 'trash' }, crypto.randomUUID(), 10_000, ready)
      for (const id of ready) results.push({ messageId: id, outcome: 'removed' })
      return { operation, results }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      for (const id of ready) results.push({ messageId: id, outcome: 'failed', message })
      return { results }
    }
  }
}

const attachmentMetadata = (record: MailDuplicateRecord) => record.attachments.map((item) => `${item.filename.toLowerCase()}|${item.mimeType.toLowerCase()}|${item.size}`).join('\n')
const formatSize = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`

function mailItem(record: MailDuplicateRecord, content: MailDuplicateContent | undefined, ownerLabel: string, names: Map<string, string>): MailDuplicateItem {
  const visibleLabels = record.labels.filter((label) => !FLAG_LABELS.has(label)).map((label) => names.get(label) ?? label)
  return {
    id: `mail:${record.accountId}:${record.id}`,
    accountId: record.accountId,
    messageId: record.id,
    revision: record.revision,
    title: record.subject || '(no subject)',
    ownerLabel,
    containerLabel: record.locationLabel,
    date: record.date,
    summary: `${record.fromName || record.fromEmail} · ${formatSize(record.size)}`,
    details: [
      { label: 'From', value: record.fromName ? `${record.fromName} <${record.fromEmail}>` : record.fromEmail },
      { label: 'Subject', value: record.subject || '(no subject)' },
      { label: 'Date', value: record.date },
      { label: 'Size', value: formatSize(record.size) },
      { label: 'Message-ID', value: record.messageIdHeader || 'None' },
      { label: 'Folder', value: record.locationLabel },
      { label: 'Labels', value: visibleLabels.join(', ') || 'None' },
      { label: 'Attachments', value: record.attachments.map((item) => item.filename).join(', ') || 'None' },
      { label: 'Downloaded', value: content ? 'Yes' : 'No' }
    ],
    completeness: (content ? 2 : 0) + record.attachments.length + visibleLabels.length / 10,
    createdAt: record.date,
    removable: true
  }
}

// Groups duplicate records. `content` reads and hashes a stored message; it is only called
// for messages that already share a Message-ID or a sender and subject in one location.
export async function groupMailDuplicates(
  records: MailDuplicateRecord[],
  content: (record: MailDuplicateRecord) => Promise<MailDuplicateContent | undefined>,
  ownerLabel: (accountId: string) => string = () => '',
  labelNames: (accountId: string) => Map<string, string> = () => new Map()
): Promise<MailDuplicateGroup[]> {
  const byLocation = new Map<string, MailDuplicateRecord[]>()
  for (const record of records) {
    const key = `${record.accountId}\u0000${record.location}`
    byLocation.set(key, [...(byLocation.get(key) ?? []), record])
  }
  const groups: MailDuplicateGroup[] = []
  for (const members of byLocation.values()) {
    const byMessageId = new Map<string, MailDuplicateRecord[]>()
    const bySender = new Map<string, MailDuplicateRecord[]>()
    for (const record of members) {
      if (record.messageIdHeader) byMessageId.set(record.messageIdHeader, [...(byMessageId.get(record.messageIdHeader) ?? []), record])
      const sender = `${record.fromEmail}\u0000${normalizeSubject(record.subject)}`
      bySender.set(sender, [...(bySender.get(sender) ?? []), record])
    }
    const candidates = new Set<MailDuplicateRecord>()
    for (const bucket of [...byMessageId.values(), ...bySender.values()]) if (bucket.length > 1) bucket.forEach((record) => candidates.add(record))
    if (!candidates.size) continue
    const contents = new Map<string, MailDuplicateContent | undefined>()
    for (const record of candidates) contents.set(record.id, await content(record))
    const union = new DuplicateUnion()
    for (const bucket of byMessageId.values()) for (const record of bucket.slice(1)) union.join(bucket[0].id, record.id, 'message-id')
    const byHash = new Map<string, MailDuplicateRecord[]>()
    for (const record of candidates) {
      const hash = contents.get(record.id)?.contentHash
      if (hash) byHash.set(hash, [...(byHash.get(hash) ?? []), record])
    }
    for (const bucket of byHash.values()) for (const record of bucket.slice(1)) union.join(bucket[0].id, record.id, 'content-hash')
    for (const bucket of bySender.values()) {
      const sorted = [...bucket].sort((a, b) => Date.parse(a.date) - Date.parse(b.date))
      for (let i = 0; i < sorted.length; i += 1) {
        for (let j = i + 1; j < sorted.length && Date.parse(sorted[j].date) - Date.parse(sorted[i].date) <= FINGERPRINT_WINDOW_MS; j += 1) {
          if (sorted[i].size === sorted[j].size && (!sorted[i].messageIdHeader || sorted[i].messageIdHeader !== sorted[j].messageIdHeader)) union.join(sorted[i].id, sorted[j].id, 'message-fingerprint')
        }
      }
    }
    const recordById = new Map(members.map((record) => [record.id, record]))
    for (const component of union.groups()) {
      const componentRecords = component.ids.map((id) => recordById.get(id)!)
      // Different attachments mean different messages, whatever the headers say.
      const allContent = componentRecords.every((record) => contents.get(record.id))
      const signature = (record: MailDuplicateRecord) => allContent ? contents.get(record.id)!.attachmentHashes.join('\n') : attachmentMetadata(record)
      const bySignature = new Map<string, MailDuplicateRecord[]>()
      for (const record of componentRecords) bySignature.set(signature(record), [...(bySignature.get(signature(record)) ?? []), record])
      const split = bySignature.size > 1
      for (const subset of bySignature.values()) {
        if (subset.length < 2) continue
        const hashes = subset.map((record) => contents.get(record.id)?.contentHash)
        const sameContent = hashes.every((hash) => hash && hash === hashes[0])
        const sameMessageId = Boolean(subset[0].messageIdHeader) && subset.every((record) => record.messageIdHeader === subset[0].messageIdHeader)
        const codes: DuplicateReasonCode[] = []
        if (sameMessageId) codes.push('message-id')
        if (sameContent) codes.push('content-hash')
        if (!sameMessageId) codes.push('message-fingerprint')
        const notes: string[] = []
        if (!allContent) notes.push('Some copies are not downloaded, so their content and attachments were compared by name and size only.')
        if (sameMessageId && !sameContent && allContent) notes.push('These copies share a Message-ID but their content differs. Compare them before removing one.')
        if (!sameMessageId) notes.push('The Message-IDs differ; these were matched by sender, subject, size, and time only.')
        if (split) notes.push('Copies with different attachments were kept out of this group.')
        const items = subset.map((record) => mailItem(record, contents.get(record.id), ownerLabel(record.accountId), labelNames(record.accountId)))
        groups.push({
          confidence: sameContent ? 'high' : sameMessageId ? 'medium' : 'low',
          codes,
          notes,
          keeperId: suggestedKeeper(items),
          items
        })
      }
    }
  }
  return groups
}

export async function scanMailDuplicates(
  store: Pick<MailDuplicateStore, 'records' | 'labelNames'>,
  database: Pick<MailDatabase, 'getAccount'>,
  scopes: MailDuplicateScope[],
  content: (record: MailDuplicateRecord) => Promise<MailDuplicateContent | undefined> = async (record) => {
    const raw = readStoredRaw(record.rawPath)
    return raw ? mailDuplicateContent(raw) : undefined
  }
): Promise<MailDuplicateScan> {
  const excluded: DuplicateExclusion[] = []
  const records: MailDuplicateRecord[] = []
  const names = new Map<string, Map<string, string>>()
  const owners = new Map<string, string>()
  for (const scope of scopes) {
    const account = database.getAccount(scope.accountId)
    if (!account) {
      excluded.push({ label: scope.accountId, reason: 'This account is no longer available' })
      continue
    }
    owners.set(account.id, account.email || account.displayName)
    if (account.archived) {
      excluded.push({ label: account.email, reason: 'Archived accounts are read-only. Reconnect the account to clean up its mail.' })
      continue
    }
    names.set(account.id, store.labelNames(account.id))
    records.push(...store.records(scope))
  }
  const groups = await groupMailDuplicates(records, content, (accountId) => owners.get(accountId) ?? accountId, (accountId) => names.get(accountId) ?? new Map())
  return { scanned: records.length, groups, excluded }
}
