import PostalMime from 'postal-mime'
import { isCalendarAttachment, ITIP_MAX_CHARS } from '../../src/lib/itip'

const MAX_PARTS = 4

type ParsedAttachment = Awaited<ReturnType<typeof PostalMime.parse>>['attachments'][number]

function attachmentText(attachment: ParsedAttachment) {
  if (typeof attachment.content === 'string') {
    return attachment.encoding === 'base64' ? Buffer.from(attachment.content, 'base64').toString('utf8') : attachment.content
  }
  return Buffer.from(attachment.content instanceof ArrayBuffer ? new Uint8Array(attachment.content) : attachment.content).toString('utf8')
}

// The text/calendar parts of a stored message, in MIME order. Senders such as Outlook and Gmail include the
// same invitation twice (an inline text/calendar alternative and an invite.ics attachment); identical copies
// are returned once. Oversized parts are skipped rather than truncated, which would corrupt them.
export async function calendarPartsFromRaw(raw: Uint8Array) {
  const parsed = await PostalMime.parse(raw)
  const parts: string[] = []
  for (const attachment of parsed.attachments) {
    if (!isCalendarAttachment(attachment)) continue
    const size = typeof attachment.content === 'string' ? attachment.content.length : attachment.content.byteLength
    if (size > ITIP_MAX_CHARS * 2) continue
    const text = attachmentText(attachment).replace(/^﻿/, '')
    if (text.length > ITIP_MAX_CHARS || parts.includes(text)) continue
    parts.push(text)
    if (parts.length >= MAX_PARTS) break
  }
  return parts
}
