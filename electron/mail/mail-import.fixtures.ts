import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import PostalMime from 'postal-mime'
import type { MailDatabase } from './database'
import type { ImportedMessageInput } from './mail-import'
import { quoteMboxBody } from './mbox'
import type { PstAttachmentSource, PstMessageSource } from './pst-mime'

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

// Real Outlook files: the sample data shipped in the pst-extractor package
// (MIT), read in place and never copied into this repository. enron.pst is
// a Unicode PST with compressible encryption built from the public Enron
// corpus; the two .ost files are Outlook 2013+ (4 KB page) caches of the
// library author's test mailboxes. There is no ANSI sample.
const PST_SAMPLES = join(dirname(createRequire(import.meta.url).resolve('pst-extractor/package.json')), 'example', 'testdata')
export const ENRON_PST = join(PST_SAMPLES, 'enron.pst')
export const OUTLOOK_OST = join(PST_SAMPLES, 'pstextractortest@outlook.com.ost')
export const PDF_OST = join(PST_SAMPLES, 'pstextractortestpdf@outlook.com.ost')

// The 564-byte header of an Outlook data file (version 23 = Unicode PST,
// 36 = Outlook 2013+ 4 KB pages, 14/15 = ANSI) with the given bCryptMethod.
// Only the header checks can read it; real PST content comes from the
// sample files that ship with pst-extractor.
export function pstHeader({ version = 23, encryption = 1 }: { version?: number; encryption?: number } = {}) {
  const header = Buffer.alloc(564)
  header.write('!BDN', 0, 'latin1')
  header.write('SM', 8, 'latin1')
  header[10] = version
  header[version === 14 || version === 15 ? 461 : 513] = encryption
  return header
}

// A mocked MAPI message, as the PST reader would produce it.
export function pstMessage(overrides: Partial<PstMessageSource> = {}, attachments: PstAttachmentSource[] = []): PstMessageSource {
  return {
    messageClass: 'IPM.Note',
    subject: 'Quarterly report',
    senderName: 'Ada Lovelace',
    senderEmail: 'ada@example.test',
    senderAddrType: 'SMTP',
    senderSmtp: '',
    representingName: '',
    representingEmail: '',
    representingAddrType: '',
    representingSmtp: '',
    recipients: [{ type: 1, name: 'Bob', email: 'bob@example.test', addrType: 'SMTP', smtp: '' }],
    displayTo: 'Bob',
    displayCc: '',
    submitTime: new Date('2025-10-16T09:30:00Z'),
    deliveryTime: new Date('2025-10-16T09:31:00Z'),
    creationTime: null,
    internetMessageId: '<report@example.test>',
    inReplyTo: '',
    references: '',
    transportHeaders: '',
    body: 'Plain body',
    html: '',
    rtfCompressed: null,
    importance: 1,
    read: true,
    flagged: false,
    size: 1_000,
    attachments: () => attachments,
    ...overrides
  }
}

export function pstAttachment(overrides: Partial<PstAttachmentSource> & { content?: Buffer } = {}): PstAttachmentSource {
  const { content = Buffer.from('%PDF-1.4 fixture'), ...rest } = overrides
  return { method: 1, filename: 'report.pdf', mimeType: 'application/pdf', contentId: '', size: content.length, data: () => content, embedded: () => null, ...rest }
}

// Wraps raw RTF as an uncompressed ("MELA") PidTagRtfCompressed stream.
export function uncompressedRtf(rtf: string) {
  const body = Buffer.from(rtf, 'latin1')
  const header = Buffer.alloc(16)
  header.writeUInt32LE(body.length + 12, 0)
  header.writeUInt32LE(body.length, 4)
  header.writeUInt32LE(0x414c454d, 8)
  return Buffer.concat([header, body])
}

// Encodes RTF as LZFu using literals only, which every decoder must accept.
export function literalLzfu(rtf: string) {
  const body = Buffer.from(rtf, 'latin1')
  const chunks: number[] = []
  let write = 207
  for (let index = 0; index < body.length; index += 8) {
    const run = body.subarray(index, index + 8)
    chunks.push(0, ...run)
    write = (write + run.length) % 4096
  }
  // End marker: a reference to the current write position.
  chunks.push(1, (write >> 4) & 0xff, (write & 0x0f) << 4)
  const data = Buffer.from(chunks)
  const header = Buffer.alloc(16)
  header.writeUInt32LE(data.length + 12, 0)
  header.writeUInt32LE(body.length, 4)
  header.writeUInt32LE(0x75465a4c, 8)
  return Buffer.concat([header, data])
}
