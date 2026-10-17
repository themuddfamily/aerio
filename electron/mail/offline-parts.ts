import type { MessageStructureObject } from 'imapflow'
import type { GmailMessagePart } from './gmail-client'
import type { GraphAttachmentInfo, GraphMessageFields, GraphRecipient } from './microsoft-client'

/**
 * Provider-neutral pieces of a message that was downloaded without its MIME
 * original (E36 headers-only and bodies-without-attachments modes).
 */
export interface PartialAttachmentInfo {
  filename: string
  mimeType: string
  size: number
  contentId?: string
}

export interface PartialMessageContent {
  /** RFC 5322 header block, parsed the same way as a full message's headers. */
  headers: string
  text: string
  html: string
  attachments: PartialAttachmentInfo[]
}

export function decodeText(bytes: Buffer, charset?: string) {
  const label = (charset || 'utf-8').trim().toLowerCase().replace(/^"|"$/g, '')
  try {
    return new TextDecoder(label).decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

export function decodeQuotedPrintable(value: string) {
  const soft = value.replace(/=\r?\n/g, '')
  const bytes: number[] = []
  for (let index = 0; index < soft.length; index += 1) {
    const char = soft[index]
    const hex = soft.slice(index + 1, index + 3)
    if (char === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16))
      index += 2
    } else {
      const code = soft.charCodeAt(index)
      if (code < 0x80) bytes.push(code)
      else bytes.push(...Buffer.from(char, 'utf8'))
    }
  }
  return Buffer.from(bytes)
}

export function decodeTransfer(content: Buffer, encoding?: string) {
  const value = (encoding ?? '').toLowerCase()
  if (value === 'base64') return Buffer.from(content.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64')
  if (value === 'quoted-printable') return decodeQuotedPrintable(content.toString('latin1'))
  return content
}

// ---- Gmail ---------------------------------------------------------------

const header = (part: GmailMessagePart | undefined, name: string) => part?.headers?.find((item) => item.name.toLowerCase() === name.toLowerCase())?.value
const charsetOf = (contentType?: string) => contentType?.match(/charset\s*=\s*"?([^";\s]+)"?/i)?.[1]

export function gmailHeaderBlock(payload?: GmailMessagePart) {
  return (payload?.headers ?? [])
    .filter((item) => item.name && !/[\r\n]/.test(item.name))
    .map((item) => `${item.name}: ${item.value.replace(/\r?\n(?![\t ])/g, '\r\n ')}`)
    .join('\r\n') + '\r\n\r\n'
}

/**
 * Text and HTML bodies from a `format=full` payload, plus attachment
 * metadata. Attachment bytes stay on Gmail (they arrive as attachmentId
 * references), so nothing large is downloaded.
 */
export function gmailPartialContent(payload?: GmailMessagePart): PartialMessageContent {
  const result: PartialMessageContent = { headers: gmailHeaderBlock(payload), text: '', html: '', attachments: [] }
  const visit = (part: GmailMessagePart | undefined) => {
    if (!part) return
    const mimeType = (part.mimeType ?? '').toLowerCase()
    if (part.parts?.length && mimeType.startsWith('multipart/')) {
      for (const child of part.parts) visit(child)
      return
    }
    const disposition = header(part, 'Content-Disposition')?.toLowerCase() ?? ''
    const isAttachment = Boolean(part.filename) || Boolean(part.body?.attachmentId) || disposition.startsWith('attachment')
    if (!isAttachment && (mimeType === 'text/plain' || mimeType === 'text/html') && part.body?.data) {
      const text = decodeText(Buffer.from(part.body.data.replaceAll('-', '+').replaceAll('_', '/'), 'base64'), charsetOf(header(part, 'Content-Type')))
      if (mimeType === 'text/plain' && !result.text) result.text = text
      if (mimeType === 'text/html' && !result.html) result.html = text
      return
    }
    if (isAttachment || (mimeType && !mimeType.startsWith('multipart/'))) {
      if (!isAttachment && mimeType.startsWith('text/')) return
      result.attachments.push({
        filename: part.filename || `attachment-${result.attachments.length + 1}`,
        mimeType: mimeType || 'application/octet-stream',
        size: Number(part.body?.size ?? 0),
        ...(header(part, 'Content-ID') ? { contentId: header(part, 'Content-ID')!.replace(/^<|>$/g, '') } : {})
      })
    }
  }
  visit(payload)
  return result
}

// ---- Microsoft Graph -----------------------------------------------------

const encodeWord = (value: string) => /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
const graphAddress = (recipient?: GraphRecipient) => {
  const address = recipient?.emailAddress?.address?.replace(/[\r\n<>]/g, '') ?? ''
  const name = recipient?.emailAddress?.name?.replace(/[\r\n"]/g, '') ?? ''
  if (!address) return ''
  return name && name !== address ? `"${encodeWord(name)}" <${address}>` : address
}

/** Builds the header block Graph describes as fields, so it parses like any other message. */
export function graphHeaderBlock(message: GraphMessageFields) {
  const lines: string[] = []
  const from = graphAddress(message.from)
  if (from) lines.push(`From: ${from}`)
  const to = (message.toRecipients ?? []).map(graphAddress).filter(Boolean)
  if (to.length) lines.push(`To: ${to.join(', ')}`)
  const cc = (message.ccRecipients ?? []).map(graphAddress).filter(Boolean)
  if (cc.length) lines.push(`Cc: ${cc.join(', ')}`)
  if (message.subject) lines.push(`Subject: ${encodeWord(message.subject.replace(/[\r\n]+/g, ' '))}`)
  const date = message.receivedDateTime ?? message.sentDateTime
  if (date && Number.isFinite(Date.parse(date))) lines.push(`Date: ${new Date(date).toUTCString()}`)
  if (message.internetMessageId) lines.push(`Message-ID: ${message.internetMessageId.replace(/[\r\n]/g, '')}`)
  for (const name of ['References', 'In-Reply-To']) {
    const value = message.internetMessageHeaders?.find((item) => item.name.toLowerCase() === name.toLowerCase())?.value
    if (value) lines.push(`${name}: ${value.replace(/[\r\n]+/g, ' ')}`)
  }
  return lines.join('\r\n') + '\r\n\r\n'
}

export function graphPartialContent(message: GraphMessageFields, attachments: GraphAttachmentInfo[] = []): PartialMessageContent {
  const body = message.body?.content ?? ''
  return {
    headers: graphHeaderBlock(message),
    text: message.body?.contentType === 'text' ? body : '',
    html: message.body?.contentType === 'html' ? body : '',
    attachments: attachments.map((item, index) => ({ filename: item.name || `attachment-${index + 1}`, mimeType: item.contentType || 'application/octet-stream', size: Number(item.size ?? 0) }))
  }
}

// ---- IMAP ----------------------------------------------------------------

export interface ImapBodyPart {
  part: string
  type: 'text/plain' | 'text/html'
  charset?: string
  encoding?: string
}

/** Walks a BODYSTRUCTURE: the first plain and HTML bodies to fetch, and attachment metadata. */
export function imapStructureParts(root?: MessageStructureObject) {
  const bodies: ImapBodyPart[] = []
  const attachments: PartialAttachmentInfo[] = []
  const visit = (node: MessageStructureObject | undefined) => {
    if (!node) return
    const type = (node.type ?? '').toLowerCase()
    if (type.startsWith('multipart/')) {
      for (const child of node.childNodes ?? []) visit(child)
      return
    }
    const filename = node.dispositionParameters?.filename ?? node.parameters?.name
    const disposition = (node.disposition ?? '').toLowerCase()
    const isAttachment = disposition === 'attachment' || Boolean(filename) || type === 'message/rfc822'
    if (!isAttachment && (type === 'text/plain' || type === 'text/html')) {
      if (!bodies.some((item) => item.type === type)) bodies.push({ part: node.part ?? '1', type, charset: node.parameters?.charset, encoding: node.encoding })
      return
    }
    if (!isAttachment && type.startsWith('text/')) return
    attachments.push({
      filename: filename || `attachment-${attachments.length + 1}`,
      mimeType: type || 'application/octet-stream',
      size: Number(node.size ?? 0),
      ...(node.id ? { contentId: node.id.replace(/^<|>$/g, '') } : {})
    })
  }
  visit(root)
  return { bodies, attachments }
}

export function decodeImapBody(content: Buffer, part: ImapBodyPart) {
  return decodeText(decodeTransfer(content, part.encoding), part.charset)
}
