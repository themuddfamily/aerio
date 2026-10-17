import { createHash } from 'node:crypto'
import { decodeWords } from 'postal-mime'

const MAX_HEADER_BYTES = 256 * 1024

// Reads the top-level header block of a raw message without decoding the
// body, so duplicate checks and flag mapping stay cheap for large archives.
export function readHeaderBlock(raw: Buffer) {
  const limit = Math.min(raw.length, MAX_HEADER_BYTES)
  let end = limit
  for (let index = 0; index < limit; index += 1) {
    if (raw[index] !== 0x0a) continue
    const next = raw[index + 1]
    if (next === 0x0a || (next === 0x0d && raw[index + 2] === 0x0a)) {
      end = index
      break
    }
  }
  const headers = new Map<string, string[]>()
  let name = ''
  let value = ''
  const flush = () => {
    if (!name) return
    headers.set(name, [...(headers.get(name) ?? []), value.trim()])
    name = ''
    value = ''
  }
  for (const line of raw.subarray(0, end).toString('latin1').split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && name) {
      value += ` ${line.trim()}`
      continue
    }
    flush()
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    name = line.slice(0, colon).trim().toLowerCase()
    value = line.slice(colon + 1)
  }
  flush()
  return headers
}

const first = (headers: Map<string, string[]>, name: string) => headers.get(name)?.[0]
const messageIds = (value: string | undefined) => value?.match(/<[^<>\s]+>/g)?.map((item) => item.toLowerCase()) ?? []

export interface ImportFlags {
  read?: boolean
  flagged?: boolean
  answered?: boolean
  /** Thunderbird keeps deleted ("expunged") messages in the mbox until it is compacted. */
  deleted?: boolean
}

// Maps the flag headers written by mbox clients: Status/X-Status (elm, mutt,
// Apple Mail, Eudora) and X-Mozilla-Status (Thunderbird, SeaMonkey).
export function importFlags(headers: Map<string, string[]>): ImportFlags {
  const flags: ImportFlags = {}
  const mozilla = first(headers, 'x-mozilla-status')
  if (mozilla && /^[0-9a-f]{1,4}$/i.test(mozilla)) {
    const bits = Number.parseInt(mozilla, 16)
    flags.read = Boolean(bits & 0x0001)
    flags.answered = Boolean(bits & 0x0002)
    flags.flagged = Boolean(bits & 0x0004)
    flags.deleted = Boolean(bits & 0x0008)
  }
  const status = first(headers, 'status')
  if (status !== undefined) flags.read = /R/.test(status)
  const extra = first(headers, 'x-status')
  if (extra !== undefined) {
    if (/F/.test(extra)) flags.flagged = true
    if (/A/.test(extra)) flags.answered = true
    if (/D/.test(extra)) flags.deleted = true
  }
  return flags
}

export interface ImportMetadata {
  messageId?: string
  /** Thread key shared with the IMAP sync: the first References entry, else In-Reply-To, else Message-ID. */
  threadRoot?: string
  date?: string
  subject: string
  from: string
  flags: ImportFlags
}

const decoded = (value: string | undefined) => {
  if (!value) return ''
  try { return decodeWords(value).replace(/\s+/g, ' ').trim() } catch { return value.trim() }
}

export function importMetadata(raw: Buffer): ImportMetadata {
  const headers = readHeaderBlock(raw)
  const messageId = messageIds(first(headers, 'message-id'))[0]
  const references = messageIds(first(headers, 'references'))
  const inReplyTo = messageIds(first(headers, 'in-reply-to'))[0]
  const dateHeader = first(headers, 'date')
  const parsedDate = dateHeader ? Date.parse(dateHeader) : Number.NaN
  return {
    messageId,
    threadRoot: references[0] ?? inReplyTo ?? messageId,
    date: Number.isFinite(parsedDate) ? new Date(parsedDate).toISOString() : undefined,
    subject: decoded(first(headers, 'subject')).slice(0, 500),
    from: decoded(first(headers, 'from')).slice(0, 500),
    flags: importFlags(headers)
  }
}

export const sha256 = (raw: Buffer) => createHash('sha256').update(raw).digest('hex')

// Local Folders thread messages by their root Message-ID so replies imported
// from different files or copied from other accounts join one conversation.
export const importThreadId = (root: string) => createHash('sha256').update(root).digest('base64url').slice(0, 32)
