import { createHash } from 'node:crypto'
import { decompressRtf, RtfTooLargeError, rtfToBody } from './rtf'

// Converts an Outlook (MAPI) message read from a PST/OST file into an
// RFC 5322 MIME message, so it can go through the ordinary import pipeline.
// The output is deterministic (no random boundaries or current dates): the
// same PST message always produces the same bytes, which lets duplicate
// review re-read it later and verify it against the recorded hash.

export interface PstRecipientSource {
  /** 1 = To, 2 = Cc, 3 = Bcc (PidTagRecipientType). */
  type: number
  name: string
  email: string
  addrType: string
  smtp: string
}

export interface PstAttachmentSource {
  /** PidTagAttachMethod: 1 by value, 2–4 by reference, 5 embedded message, 6 OLE. */
  method: number
  filename: string
  mimeType: string
  contentId: string
  /** Size of the attachment data as recorded in the file. */
  size: number
  data(): Buffer | null
  embedded(): PstMessageSource | null
}

export interface PstMessageSource {
  messageClass: string
  subject: string
  senderName: string
  senderEmail: string
  senderAddrType: string
  senderSmtp: string
  representingName: string
  representingEmail: string
  representingAddrType: string
  representingSmtp: string
  recipients: PstRecipientSource[]
  displayTo: string
  displayCc: string
  submitTime: Date | null
  deliveryTime: Date | null
  creationTime: Date | null
  internetMessageId: string
  inReplyTo: string
  references: string
  transportHeaders: string
  body: string
  html: string
  rtfCompressed: Buffer | null
  /** PidTagImportance: 0 low, 1 normal, 2 high. */
  importance: number
  read: boolean
  /** PidTagFlagStatus is followupFlagged (2). */
  flagged: boolean
  /** Recorded size of the whole message (PidTagMessageSize). */
  size: number
  attachments(): PstAttachmentSource[]
}

export class PstMessageTooLargeError extends Error {}

export interface PstMimeOptions {
  maxBytes: number
  /** Stable seed for MIME boundaries, e.g. the message's node id. */
  seed: string
}

const MAX_EMBEDDING_DEPTH = 8
const CRLF = '\r\n'

// Transport headers Aerio regenerates from MAPI properties (or which describe
// the original MIME structure, which is rebuilt) are not copied.
const REPLACED_HEADERS = new Set([
  'from', 'sender', 'to', 'cc', 'bcc', 'subject', 'date', 'message-id', 'in-reply-to', 'references', 'importance',
  'mime-version', 'content-type', 'content-transfer-encoding', 'content-disposition', 'content-id', 'content-length',
  'content-description', 'lines', 'status', 'x-status', 'x-mozilla-status', 'x-mozilla-status2', 'x-ms-has-attach', 'x-ms-tnef-correlator'
])

/** Mail-like message classes; contacts, appointments, tasks and notes are not mail. */
export function isMailMessageClass(messageClass: string) {
  const value = messageClass.toUpperCase()
  if (!value) return true
  return value === 'IPM' || value.startsWith('IPM.NOTE') || value.startsWith('IPM.SCHEDULE.MEETING') || value.startsWith('IPM.POST')
    || value.startsWith('REPORT.') || value.startsWith('IPM.OUTLOOK.RECALL') || value.startsWith('IPM.RECALL')
}

export function pstMessageToMime(message: PstMessageSource, options: PstMimeOptions): Buffer {
  const budget = { remaining: options.maxBytes }
  if (message.size > options.maxBytes * 2) throw new PstMessageTooLargeError('The message is larger than the import limit')
  const raw = Buffer.from(buildMessage(message, options.seed, budget, 0), 'utf8')
  if (raw.length > options.maxBytes) throw new PstMessageTooLargeError('The message is larger than the import limit')
  return raw
}

function buildMessage(message: PstMessageSource, seed: string, budget: { remaining: number }, depth: number): string {
  const boundaryBase = `=_Aerio_${createHash('sha256').update(`${seed}:${depth}`).digest('hex').slice(0, 24)}`
  let boundaryIndex = 0
  const boundary = () => `${boundaryBase}_${depth}_${boundaryIndex++}`
  const headers = messageHeaders(message)
  const { text, html } = messageBodies(message, budget)
  const attachments = message.attachments()

  // Inline images referenced from the HTML go in multipart/related; the rest
  // of the attachments in multipart/mixed.
  const parts = attachments.map((attachment, index) => attachmentPart(attachment, index, seed, budget, depth)).filter((part): part is AttachmentPart => Boolean(part))
  const inline = html ? parts.filter((part) => part.contentId && html.includes(`cid:${part.contentId}`)) : []
  // A Content-ID the HTML never refers to is an ordinary attachment.
  const regular = parts.filter((part) => !inline.includes(part)).map((part) => part.contentId
    ? { ...part, entity: { ...part.entity, headers: part.entity.headers.map((header) => header.replace(/^Content-Disposition: inline;/, 'Content-Disposition: attachment;')) } }
    : part)

  let body: { headers: string[]; content: string }
  const textPart = textEntity(text ?? '', 'plain')
  if (html) {
    const htmlPart = textEntity(html, 'html')
    body = text ? multipart('alternative', boundary(), [textPart, htmlPart]) : htmlPart
    if (inline.length) body = multipart('related', boundary(), [body, ...inline.map((part) => part.entity)], 'type="multipart/alternative"')
  } else {
    body = textPart
  }
  if (regular.length) body = multipart('mixed', boundary(), [body, ...regular.map((part) => part.entity)])
  return [...headers, 'MIME-Version: 1.0', ...body.headers, '', body.content].join(CRLF)
}

function messageHeaders(message: PstMessageSource) {
  const headers: string[] = []
  const from = address(message.representingName || message.senderName, smtpOf(message.representingSmtp, message.representingEmail, message.representingAddrType) || smtpOf(message.senderSmtp, message.senderEmail, message.senderAddrType))
  const sender = smtpOf(message.senderSmtp, message.senderEmail, message.senderAddrType)
  const date = message.submitTime ?? message.deliveryTime ?? message.creationTime
  if (date && Number.isFinite(date.getTime()) && date.getTime() > 0) headers.push(`Date: ${rfc5322Date(date)}`)
  if (from) headers.push(`From: ${from}`)
  const representingSmtp = smtpOf(message.representingSmtp, message.representingEmail, message.representingAddrType)
  if (sender && representingSmtp && sender.toLowerCase() !== representingSmtp.toLowerCase()) headers.push(`Sender: ${address(message.senderName, sender)}`)
  const byType = (type: number) => message.recipients.filter((recipient) => recipient.type === type).map((recipient) => address(recipient.name, smtpOf(recipient.smtp, recipient.email, recipient.addrType))).filter(Boolean)
  const to = message.recipients.length ? byType(1) : displayList(message.displayTo)
  const cc = message.recipients.length ? byType(2) : displayList(message.displayCc)
  const bcc = byType(3)
  if (to.length) headers.push(foldList('To', to))
  if (cc.length) headers.push(foldList('Cc', cc))
  if (bcc.length) headers.push(foldList('Bcc', bcc))
  headers.push(`Subject: ${encodeHeader(message.subject)}`)
  const messageId = messageIdToken(message.internetMessageId)
  if (messageId) headers.push(`Message-ID: ${messageId}`)
  const inReplyTo = messageIdToken(message.inReplyTo)
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`)
  const references = message.references.match(/<[^<>\s]+>/g)
  if (references?.length) headers.push(`References: ${references.slice(0, 100).join(`${CRLF} `)}`)
  if (message.importance === 2) headers.push('Importance: high', 'X-Priority: 1')
  else if (message.importance === 0) headers.push('Importance: low', 'X-Priority: 5')
  return [...headers, ...preservedTransportHeaders(message.transportHeaders)]
}

// Keeps trace and informational headers (Received, Reply-To, List-*, DKIM,
// X-…) from the original internet headers, dropping malformed lines.
function preservedTransportHeaders(raw: string) {
  if (!raw) return []
  const output: string[] = []
  let keep = false
  for (const line of raw.slice(0, 256 * 1024).split(/\r?\n/)) {
    if (!line) break
    if (/^[ \t]/.test(line)) {
      if (keep) output.push(sanitizeLine(line))
      continue
    }
    const match = /^([!-9;-~]+):/.exec(line)
    keep = Boolean(match) && !REPLACED_HEADERS.has(match![1].toLowerCase())
    if (keep) output.push(sanitizeLine(line))
  }
  return output.slice(0, 2_000)
}

const sanitizeLine = (line: string) => line.replaceAll(/[\u0000\r\n]/g, '').slice(0, 4_000)

function smtpOf(smtp: string, email: string, addrType: string) {
  const usable = (value: string) => /^[^\s@<>"(),;:]+@[^\s@<>"(),;:]+$/.test(value.trim()) ? value.trim() : ''
  return usable(smtp) || (!addrType || addrType.toUpperCase() === 'SMTP' ? usable(email) : '') || ''
}

// Without an SMTP address (for example an unresolved Exchange recipient) only
// the display name is kept, as an empty group so the header stays valid.
function address(name: string, email: string) {
  const display = name.replaceAll(/[\r\n\u0000]/g, ' ').replaceAll(/\s+/g, ' ').trim()
  if (email) return display && display.toLowerCase() !== email.toLowerCase() ? `${phrase(display)} <${email}>` : `<${email}>`
  return display ? `${phrase(display)}:;` : ''
}

const displayList = (value: string) => value.split(';').map((name) => name.trim()).filter(Boolean).map((name) => address(name, ''))

function phrase(text: string) {
  if (/[^\x20-\x7e]/.test(text)) return encodeWord(text)
  if (/^[\w !#$%&'*+\-/=?^`{|}~]+$/.test(text)) return text
  return `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function encodeHeader(text: string) {
  const clean = text.replaceAll(/[\r\n\u0000]/g, ' ').trim()
  return /[^\x20-\x7e]/.test(clean) || clean.length > 900 ? encodeWord(clean.slice(0, 2_000)) : clean
}

// RFC 2047 B-encoded words of at most 45 input bytes, split on whole characters.
function encodeWord(text: string) {
  const words: string[] = []
  let chunk = ''
  for (const character of text) {
    if (Buffer.byteLength(chunk + character) > 45) {
      words.push(chunk)
      chunk = ''
    }
    chunk += character
  }
  if (chunk) words.push(chunk)
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word).toString('base64')}?=`).join(`${CRLF} `)
}

function foldList(name: string, values: string[]) {
  return `${name}: ${values.slice(0, 5_000).join(`,${CRLF} `)}`
}

const messageIdToken = (value: string) => /<[^<>\s]+>/.exec(value)?.[0] ?? (/^[^<>\s@]+@[^<>\s@]+$/.test(value.trim()) ? `<${value.trim()}>` : '')

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const two = (value: number) => String(value).padStart(2, '0')
export const rfc5322Date = (date: Date) =>
  `${DAYS[date.getUTCDay()]}, ${two(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())} +0000`

// Picks the bodies to keep: HTML (stored directly or encapsulated in the
// compressed RTF body) and plain text. Non-HTML RTF only supplies plain text
// when the message has no text body of its own.
function messageBodies(message: PstMessageSource, budget: { remaining: number }) {
  let text = message.body || undefined
  let html = message.html || undefined
  if (!html && message.rtfCompressed?.length) {
    try {
      const rtf = rtfToBody(decompressRtf(message.rtfCompressed, budget.remaining), budget.remaining)
      if (rtf.kind === 'html' && rtf.content.trim()) html = rtf.content
      else if (!text && rtf.content) text = rtf.content
    } catch (error) {
      if (error instanceof RtfTooLargeError) throw new PstMessageTooLargeError('The message is larger than the import limit')
      // An unreadable RTF body leaves the message with its other bodies.
    }
  }
  charge(budget, (text?.length ?? 0) + (html?.length ?? 0))
  return { text, html }
}

function charge(budget: { remaining: number }, bytes: number) {
  budget.remaining -= bytes
  if (budget.remaining < 0) throw new PstMessageTooLargeError('The message is larger than the import limit')
}

interface Entity {
  headers: string[]
  content: string
}

interface AttachmentPart {
  contentId?: string
  entity: Entity
}

function textEntity(content: string, subtype: 'plain' | 'html'): Entity {
  return {
    headers: [`Content-Type: text/${subtype}; charset=utf-8`, 'Content-Transfer-Encoding: base64'],
    content: base64Lines(Buffer.from(content, 'utf8'))
  }
}

function multipart(subtype: string, boundary: string, parts: Entity[], extra?: string): Entity {
  const content = [
    ...parts.flatMap((part) => [`--${boundary}`, ...part.headers, '', part.content]),
    `--${boundary}--`,
    ''
  ].join(CRLF)
  return { headers: [`Content-Type: multipart/${subtype}; boundary="${boundary}"${extra ? `; ${extra}` : ''}`], content }
}

const base64Lines = (data: Buffer) => data.toString('base64').replaceAll(/.{1,76}/g, (line) => `${line}${CRLF}`).replace(/\r\n$/, '')

function attachmentPart(attachment: PstAttachmentSource, index: number, seed: string, budget: { remaining: number }, depth: number): AttachmentPart | undefined {
  const filename = attachment.filename.replaceAll(/[\r\n\u0000"\\/]/g, '_').trim().slice(0, 255)
  if (attachment.method === 5) {
    const embedded = depth < MAX_EMBEDDING_DEPTH ? attachment.embedded() : null
    if (!embedded) return undefined
    const name = filename || `${embedded.subject.replaceAll(/[\r\n\u0000"\\/]/g, '_').trim().slice(0, 200) || 'message'}.eml`
    const content = buildMessage(embedded, `${seed}/${index}`, budget, depth + 1)
    return {
      entity: {
        headers: ['Content-Type: message/rfc822', 'Content-Transfer-Encoding: 8bit', `Content-Disposition: attachment; ${filenameParameter(name.endsWith('.eml') ? name : `${name}.eml`)}`],
        content
      }
    }
  }
  // Attachments by reference point outside the PST and carry no data.
  if (attachment.method >= 2 && attachment.method <= 4) return undefined
  charge(budget, Math.max(0, attachment.size))
  const data = attachment.data()
  if (!data) return undefined
  charge(budget, Math.max(0, data.length - attachment.size) + Math.ceil(data.length / 3))
  const contentId = attachment.contentId.replaceAll(/[<>\s]/g, '').slice(0, 500) || undefined
  const mimeType = /^[\w.+-]+\/[\w.+-]+$/.test(attachment.mimeType.trim()) ? attachment.mimeType.trim().toLowerCase() : 'application/octet-stream'
  const name = filename || `attachment-${index + 1}`
  return {
    contentId,
    entity: {
      headers: [
        `Content-Type: ${mimeType}; ${filenameParameter(name, 'name')}`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: ${contentId ? 'inline' : 'attachment'}; ${filenameParameter(name)}`,
        ...(contentId ? [`Content-ID: <${contentId}>`] : [])
      ],
      content: base64Lines(data)
    }
  }
}

// RFC 2231 for non-ASCII names, a quoted string otherwise.
function filenameParameter(name: string, parameter = 'filename') {
  if (/^[\x20-\x7e]*$/.test(name)) return `${parameter}="${name}"`
  return `${parameter}*=UTF-8''${encodeURIComponent(name).replaceAll(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`
}
