import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import sanitizeHtml from 'sanitize-html'
import type { GmailDraftInput } from '../../src/gmail-types'

const encodeHeader = (value: string) => value.replaceAll(/[\r\n]+/g, ' ').trim()
const attachmentName = (path: string) => basename(path).replace(/^\d+(?:-[a-f0-9]{10})?-/, '')

export function createMimeBuffer(input: GmailDraftInput, from?: string, omitBcc = false) {
  const boundary = `aerio-${crypto.randomUUID()}`
  const alternativeBoundary = `aerio-alt-${crypto.randomUUID()}`
  const headers = [
    ...(from ? [`From: ${encodeHeader(from)}`] : []),
    `To: ${input.to.map(encodeHeader).join(', ')}`,
    ...(input.cc.length ? [`Cc: ${input.cc.map(encodeHeader).join(', ')}`] : []),
    ...(!omitBcc && input.bcc.length ? [`Bcc: ${input.bcc.map(encodeHeader).join(', ')}`] : []),
    `Subject: ${encodeHeader(input.subject)}`,
    'MIME-Version: 1.0',
    ...(input.inReplyTo ? [`In-Reply-To: ${encodeHeader(input.inReplyTo)}`] : []),
    ...(input.references?.length ? [`References: ${input.references.map(encodeHeader).join(' ')}`] : []),
    `Content-Type: multipart/mixed; boundary="${boundary}"`
  ]
  const safeHtml = input.html ? sanitizeHtml(input.html, {
    allowedTags: ['p', 'br', 'div', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'a'],
    allowedAttributes: { a: ['href', 'title'] },
    allowedSchemes: ['http', 'https', 'mailto']
  }) : ''
  const sections = safeHtml
    ? [`--${boundary}\r\nContent-Type: multipart/alternative; boundary="${alternativeBoundary}"\r\n\r\n` +
      `--${alternativeBoundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${input.text}\r\n` +
      `--${alternativeBoundary}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${safeHtml}\r\n` +
      `--${alternativeBoundary}--`]
    : [`--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${input.text}`]
  for (const path of input.attachmentPaths) {
    const name = encodeHeader(attachmentName(path)).replaceAll('"', '')
    const content = readFileSync(path).toString('base64').replace(/.{76}/g, '$&\r\n')
    sections.push(`--${boundary}\r\nContent-Type: application/octet-stream; name="${name}"\r\nContent-Disposition: attachment; filename="${name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${content}`)
  }
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${sections.join('\r\n')}\r\n--${boundary}--\r\n`)
}

export function createMime(input: GmailDraftInput, from?: string) {
  return createMimeBuffer(input, from).toString('base64url')
}
