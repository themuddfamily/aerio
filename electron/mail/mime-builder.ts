import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { MailDraftInput, MailSendOptions } from '../../src/mail-types'
import { normalizeSendOptions } from '../../src/lib/mail-send-options'
import { prepareOutgoingHtml, type InlineImagePart } from './outgoing-html'

const encodeHeader = (value: string) => value.replaceAll(/[\r\n]+/g, ' ').trim()

// Importance uses both the RFC 2156 header and the widely read X-Priority.
// Receipt headers are requests addressed back to the sender, never promises.
export function sendOptionHeaders(value: MailSendOptions | undefined, from?: string) {
  const options = normalizeSendOptions(value)
  if (!options) return []
  const headers: string[] = []
  if (options.importance === 'high') headers.push('Importance: High', 'X-Priority: 1 (Highest)')
  if (options.importance === 'low') headers.push('Importance: Low', 'X-Priority: 5 (Lowest)')
  if (from && options.requestReadReceipt) headers.push(`Disposition-Notification-To: ${encodeHeader(from)}`)
  if (from && options.requestDeliveryReceipt) headers.push(`Return-Receipt-To: ${encodeHeader(from)}`)
  return headers
}

const attachmentName = (path: string) => basename(path).replace(/^\d+(?:-[a-f0-9]{10})?-/, '')
const base64Lines = (content: Buffer) => content.toString('base64').replace(/.{76}/g, '$&\r\n')

// Embedded images travel with the HTML in multipart/related so clients resolve cid: references without fetching anything.
function htmlSection(html: string, images: InlineImagePart[]) {
  const htmlPart = `Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${html}`
  if (!images.length) return htmlPart
  const relatedBoundary = `aerio-rel-${crypto.randomUUID()}`
  const parts = images.map((image) => `--${relatedBoundary}\r\nContent-Type: ${image.mimeType}; name="${image.filename}"\r\n` +
    `Content-Transfer-Encoding: base64\r\nContent-ID: <${image.contentId}>\r\nContent-Disposition: inline; filename="${image.filename}"\r\n\r\n${base64Lines(image.content)}`)
  return `Content-Type: multipart/related; type="text/html"; boundary="${relatedBoundary}"\r\n\r\n` +
    `--${relatedBoundary}\r\n${htmlPart}\r\n${parts.join('\r\n')}\r\n--${relatedBoundary}--`
}

export function createMimeBuffer(input: MailDraftInput, from?: string, omitBcc = false) {
  const boundary = `aerio-${crypto.randomUUID()}`
  const alternativeBoundary = `aerio-alt-${crypto.randomUUID()}`
  const headers = [
    `Message-ID: <${crypto.randomUUID()}@aerio.local>`,
    `Date: ${new Date().toUTCString()}`,
    ...(from ? [`From: ${encodeHeader(from)}`] : []),
    `To: ${input.to.map(encodeHeader).join(', ')}`,
    ...(input.cc.length ? [`Cc: ${input.cc.map(encodeHeader).join(', ')}`] : []),
    ...(!omitBcc && input.bcc.length ? [`Bcc: ${input.bcc.map(encodeHeader).join(', ')}`] : []),
    ...(input.replyTo?.length ? [`Reply-To: ${input.replyTo.map(encodeHeader).join(', ')}`] : []),
    `Subject: ${encodeHeader(input.subject)}`,
    ...sendOptionHeaders(input.sendOptions, from),
    'MIME-Version: 1.0',
    ...(input.inReplyTo ? [`In-Reply-To: ${encodeHeader(input.inReplyTo)}`] : []),
    ...(input.references?.length ? [`References: ${input.references.map(encodeHeader).join(' ')}`] : []),
    `Content-Type: multipart/mixed; boundary="${boundary}"`
  ]
  const outgoing = input.html ? prepareOutgoingHtml(input.html) : undefined
  const sections = outgoing?.html
    ? [`--${boundary}\r\nContent-Type: multipart/alternative; boundary="${alternativeBoundary}"\r\n\r\n` +
      `--${alternativeBoundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${input.text}\r\n` +
      `--${alternativeBoundary}\r\n${htmlSection(outgoing.html, outgoing.images)}\r\n` +
      `--${alternativeBoundary}--`]
    : [`--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${input.text}`]
  for (const path of input.attachmentPaths) {
    const name = encodeHeader(attachmentName(path)).replaceAll('"', '')
    sections.push(`--${boundary}\r\nContent-Type: application/octet-stream; name="${name}"\r\nContent-Disposition: attachment; filename="${name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Lines(readFileSync(path))}`)
  }
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${sections.join('\r\n')}\r\n--${boundary}--\r\n`)
}

export function createMime(input: MailDraftInput, from?: string) {
  return createMimeBuffer(input, from).toString('base64url')
}
