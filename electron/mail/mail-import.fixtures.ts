import { writeFileSync } from 'node:fs'
import PostalMime from 'postal-mime'
import type { MailDatabase } from './database'
import type { ImportedMessageInput } from './mail-import'
import { quoteMboxBody } from './mbox'

// Controlled fixtures for the import tests: small generated messages and
// mailboxes, so no real mail archive is ever checked into the repository.

// Mirrors the worker's parse-and-store path closely enough for import tests:
// the raw source is written byte for byte and attachments are indexed.
export async function storeRawForTest(database: MailDatabase, accountId: string, message: ImportedMessageInput) {
  const parsed = await PostalMime.parse(message.raw)
  const rawPath = database.rawPath(accountId, message.id)
  writeFileSync(rawPath, message.raw)
  database.upsertMessage({
    accountId,
    id: message.id,
    threadId: message.threadId,
    historyId: message.historyId,
    internalDate: message.internalDate ?? (parsed.date ? new Date(parsed.date).toISOString() : new Date().toISOString()),
    fromName: parsed.from?.name ?? '',
    fromEmail: parsed.from?.address ?? '',
    to: [],
    cc: [],
    subject: parsed.subject ?? '(No subject)',
    messageIdHeader: parsed.messageId,
    references: [],
    snippet: (parsed.text ?? '').slice(0, 100),
    text: parsed.text ?? '',
    html: parsed.html ?? '',
    labelIds: message.labelIds,
    sizeEstimate: message.sizeEstimate,
    rawPath,
    attachments: parsed.attachments.map((attachment, index) => ({
      id: `part-${index}`,
      messageId: message.id,
      filename: attachment.filename ?? `attachment-${index + 1}`,
      mimeType: attachment.mimeType,
      size: typeof attachment.content === 'string' ? attachment.content.length : attachment.content.byteLength
    }))
  })
}

export interface Fixture {
  subject: string
  date?: string
  status?: string
  xStatus?: string
  mozilla?: string
  messageId?: string
  body?: string
  attachment?: { name: string; content: string }
}

// Builds a small RFC 5322 message; attachments are base64 parts in multipart/mixed.
export function mime(fixture: Fixture) {
  const headers = [
    'From: Ada Lovelace <ada@example.test>',
    'To: Bob <bob@example.test>',
    `Subject: ${fixture.subject}`,
    ...(fixture.date === undefined ? ['Date: Thu, 16 Oct 2025 09:30:00 +0000'] : fixture.date ? [`Date: ${fixture.date}`] : []),
    `Message-ID: <${fixture.messageId ?? fixture.subject.toLowerCase().replaceAll(/\W+/g, '-')}@example.test>`,
    ...(fixture.status ? [`Status: ${fixture.status}`] : []),
    ...(fixture.xStatus ? [`X-Status: ${fixture.xStatus}`] : []),
    ...(fixture.mozilla ? [`X-Mozilla-Status: ${fixture.mozilla}`] : []),
    'MIME-Version: 1.0'
  ]
  const body = fixture.body ?? `Hello from ${fixture.subject}.`
  if (!fixture.attachment) return `${headers.join('\n')}\nContent-Type: text/plain; charset=utf-8\n\n${body}\n`
  return [
    ...headers,
    'Content-Type: multipart/mixed; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
    '--b1',
    `Content-Type: application/octet-stream; name="${fixture.attachment.name}"`,
    `Content-Disposition: attachment; filename="${fixture.attachment.name}"`,
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(fixture.attachment.content).toString('base64'),
    '--b1--',
    ''
  ].join('\n')
}

export function mbox(messages: string[], variant: 'mboxrd' | 'mboxo' = 'mboxrd') {
  return messages.map((message, index) => `From ada@example.test Thu Oct ${String(10 + index).padStart(2, '0')} 08:00:00 2025\n${quoteMboxBody(Buffer.from(message), variant).toString()}`).join('\n') + '\n'
}
