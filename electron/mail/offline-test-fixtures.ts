import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import PostalMime from 'postal-mime'
import { MailDatabase, type ParsedMailMessage } from './database'
import { commitDownloadedRaw, type OfflineDownloadDeps, type RawMessageInput } from './offline-download'
import type { MailAccountSummary } from '../../src/mail-types'

/** Test doubles for offline-scope tests (E36): a real mail database in a temporary folder and an in-process store. */

const directories: string[] = []
const databases: MailDatabase[] = []

export function cleanupOfflineFixtures() {
  for (const database of databases.splice(0)) {
    try { database.close() } catch { /* Already closed by the test. */ }
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
}

export function offlineDatabase(provider: MailAccountSummary['provider'] = 'gmail', accountId = 'account-1') {
  const directory = mkdtempSync(join(tmpdir(), 'aerio-offline-'))
  directories.push(directory)
  const contentPath = join(directory, 'mail')
  const database = new MailDatabase(join(directory, 'aerio.sqlite'), contentPath)
  databases.push(database)
  addAccount(database, provider, accountId)
  return { database, directory, contentPath }
}

export function addAccount(database: MailDatabase, provider: MailAccountSummary['provider'], id: string) {
  database.upsertAccount({ id, provider, email: `${id}@example.com`, displayName: id, color: '#6558e8', status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true, lastSyncAt: '2026-10-01T00:00:00.000Z' })
}

export function mime(input: { messageId: string; subject: string; date: string; body?: string; attachment?: { name: string; content: string }; from?: string }) {
  const boundary = 'b-offline'
  const headers = [
    `From: ${input.from ?? 'Ada Lovelace <ada@example.com>'}`,
    'To: person@example.com',
    `Subject: ${input.subject}`,
    `Date: ${new Date(input.date).toUTCString()}`,
    `Message-ID: ${input.messageId}`,
    'MIME-Version: 1.0'
  ]
  if (!input.attachment) return Buffer.from([...headers, 'Content-Type: text/plain; charset=utf-8', '', input.body ?? 'Body text', ''].join('\r\n'))
  return Buffer.from([
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    input.body ?? 'Body text',
    `--${boundary}`,
    `Content-Type: text/plain; name="${input.attachment.name}"`,
    `Content-Disposition: attachment; filename="${input.attachment.name}"`,
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(input.attachment.content).toString('base64'),
    `--${boundary}--`,
    ''
  ].join('\r\n'))
}

/** The worker's parse-and-store path in miniature: temporary file, commit, then upsert. */
export function offlineDeps(database: MailDatabase): OfflineDownloadDeps & { stored: RawMessageInput[] } {
  const stored: RawMessageInput[] = []
  return {
    database,
    stored,
    async storeRaw(accountId, message) {
      const isNew = !database.hasMessage(accountId, message.id)
      const path = database.rawPath(accountId, message.id)
      const parsed = await commitDownloadedRaw(path, message.raw, () => PostalMime.parse(message.raw))
      const record: ParsedMailMessage = {
        accountId,
        id: message.id,
        threadId: message.threadId,
        historyId: message.historyId,
        internalDate: message.internalDate ?? new Date(parsed.date ?? Date.now()).toISOString(),
        fromName: parsed.from?.name ?? '',
        fromEmail: parsed.from?.address ?? '',
        to: (parsed.to ?? []).map((item) => item.address ?? ''),
        cc: [],
        subject: parsed.subject ?? '(No subject)',
        messageIdHeader: parsed.messageId,
        references: [],
        snippet: message.snippet ?? (parsed.text ?? '').slice(0, 240),
        text: parsed.text ?? '',
        html: parsed.html ?? '',
        labelIds: message.labelIds,
        sizeEstimate: message.sizeEstimate ?? message.raw.byteLength,
        rawPath: path,
        attachments: parsed.attachments.map((attachment, index) => ({ id: `part-${index}`, messageId: message.id, filename: attachment.filename ?? `attachment-${index + 1}`, mimeType: attachment.mimeType, size: typeof attachment.content === 'string' ? attachment.content.length : attachment.content.byteLength })),
        remoteFolderId: message.remoteFolderId,
        remoteUid: message.remoteUid
      }
      database.upsertMessage(record)
      stored.push(message)
      return { record, isNew }
    }
  }
}

/** Stores a complete message directly, as an earlier full sync would have. */
export async function seedFull(database: MailDatabase, accountId: string, input: { id: string; threadId?: string; date: string; labels: string[]; messageId?: string; remoteFolderId?: string; remoteUid?: string; attachment?: boolean }) {
  const raw = mime({ messageId: input.messageId ?? `<${input.id}@example.com>`, subject: `Subject ${input.id}`, date: input.date, body: `Body of ${input.id}`, ...(input.attachment ? { attachment: { name: 'notes.txt', content: 'attachment text' } } : {}) })
  await offlineDeps(database).storeRaw(accountId, { id: input.id, threadId: input.threadId ?? `thread-${input.id}`, historyId: '1', raw, labelIds: input.labels, internalDate: input.date, remoteFolderId: input.remoteFolderId, remoteUid: input.remoteUid })
  return database.rawPath(accountId, input.id)
}

export function writeStray(path: string, content = 'partial') {
  writeFileSync(path, content)
}
