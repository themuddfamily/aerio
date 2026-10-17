import { createHash } from 'node:crypto'
import { readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import PostalMime, { type Address } from 'postal-mime'
import type { ImapFlow } from 'imapflow'
import type { MailDatabase, ParsedMailMessage } from './database'
import type { GmailClient, GmailMessageResource, GmailRawMessage } from './gmail-client'
import { microsoftMessageLabels, type GraphMessage, type MicrosoftGraphClient } from './microsoft-client'
import type { ImapFolder, ImapSmtpClient } from './imap-client'
import { gmailHeaderBlock, gmailPartialContent, graphPartialContent, type PartialAttachmentInfo, type PartialMessageContent } from './offline-parts'
import { stateSatisfies, uniformPolicy, wantedContent, type MailWantedContent, type OfflinePolicyContext } from '../../src/lib/offline-sync'
import type { MailOfflineContentState } from '../../src/offline-sync-types'

/**
 * Policy-aware message downloads for each provider (E36). With no policy
 * context the functions behave exactly like the original full download.
 */

export interface RawMessageInput {
  id: string
  threadId: string
  historyId: string
  raw: Buffer
  labelIds: string[]
  internalDate?: string
  snippet?: string
  sizeEstimate?: number
  remoteFolderId?: string
  remoteUid?: string
}

export interface StoredMessage {
  record: ParsedMailMessage
  isNew: boolean
}

export interface OfflineDownloadDeps {
  database: MailDatabase
  /** Parses and stores a complete original (written to a temporary file, then committed). */
  storeRaw(accountId: string, message: RawMessageInput): Promise<StoredMessage>
}

export type DownloadOutcome =
  | { outcome: 'stored'; stored: StoredMessage }
  | { outcome: 'current' | 'outside' }

type GmailOfflineClient = Pick<GmailClient, 'getRawMessage' | 'getMessage' | 'listMessages'>
type GraphOfflineClient = Pick<MicrosoftGraphClient, 'messageRaw' | 'messageFields' | 'attachmentList' | 'search'>
type ImapOfflineClient = Pick<ImapSmtpClient, 'fetchRaw' | 'fetchPartial' | 'withConnection' | 'listFolders' | 'searchText'>

export interface OfflineProviderClients {
  gmail(accountId: string): GmailOfflineClient
  microsoft(accountId: string): GraphOfflineClient
  imap(accountId: string): Promise<ImapOfflineClient>
}

const stored = (value: StoredMessage): DownloadOutcome => ({ outcome: 'stored', stored: value })

// ---- Interrupted downloads ------------------------------------------------

/**
 * Writes a downloaded original next to its final path and renames it into
 * place only after `validate` accepts it, so an interrupted or unparsable
 * download never leaves a truncated message where a complete one is expected.
 */
export async function commitDownloadedRaw<T>(path: string, raw: Buffer, validate: () => Promise<T>) {
  const temporary = `${path}.partial`
  writeFileSync(temporary, raw)
  try {
    const result = await validate()
    renameSync(temporary, path)
    return result
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

/** Removes `.partial` files left by a download that was cut off by a crash or power loss. */
export function removePartialDownloads(contentPath: string) {
  let removed = 0
  const visit = (directory: string, depth: number) => {
    let entries: import('node:fs').Dirent[]
    try { entries = readdirSync(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries ?? []) {
      const path = join(directory, entry.name)
      if (entry.isDirectory() && depth < 2 && entry.name !== 'drafts' && entry.name !== 'mail-merge') visit(path, depth + 1)
      else if (entry.isFile() && entry.name.endsWith('.eml.partial')) {
        try { rmSync(path, { force: true }); removed += 1 } catch { /* Retried on the next start. */ }
      }
    }
  }
  visit(contentPath, 0)
  return removed
}

// ---- Partial messages ------------------------------------------------------

function addressList(value?: Address[]) {
  if (!value) return []
  return value.flatMap((address) => {
    if (address.group) return address.group.map((member) => member.name ? `${member.name} <${member.address}>` : member.address)
    return [address.name ? `${address.name} <${address.address}>` : address.address]
  }).filter(Boolean)
}

function sender(value?: Address) {
  if (!value) return { name: '', email: '' }
  if (value.group) return { name: value.group[0]?.name ?? '', email: value.group[0]?.address ?? '' }
  return { name: value.name ?? '', email: value.address ?? '' }
}

/** Plain text for search and snippets when a provider only returned HTML. */
export function htmlToSearchText(html: string) {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .trim()
}

/** Attachment ids for metadata-only rows never collide with ids parsed from a full original. */
export function partialAttachmentId(attachment: PartialAttachmentInfo, index: number) {
  return `remote-${index}-${Buffer.from(`${attachment.filename}:${attachment.contentId ?? ''}:${attachment.mimeType}`).toString('base64url').slice(0, 16)}`
}

export interface PartialStoreInput {
  id: string
  threadId: string
  historyId: string
  labelIds: string[]
  internalDate?: string
  snippet?: string
  sizeEstimate?: number
  remoteFolderId?: string
  remoteUid?: string
  content: PartialMessageContent
  state: Exclude<MailOfflineContentState, 'full'>
}

/** Stores a header row, or headers plus body, without an original on disk. */
export async function storePartialMessage(deps: OfflineDownloadDeps, accountId: string, input: PartialStoreInput): Promise<StoredMessage> {
  const { database } = deps
  const parsed = await PostalMime.parse(Buffer.from(input.content.headers || '\r\n\r\n', 'utf8'))
  const isNew = !database.hasMessage(accountId, input.id)
  const from = sender(parsed.from)
  const html = input.state === 'body' ? input.content.html : ''
  const text = input.state === 'body' ? input.content.text || htmlToSearchText(html) : ''
  const headerDate = parsed.date && Number.isFinite(Date.parse(parsed.date)) ? new Date(parsed.date).toISOString() : undefined
  const record: ParsedMailMessage = {
    accountId,
    id: input.id,
    threadId: input.threadId,
    historyId: input.historyId,
    internalDate: input.internalDate ?? headerDate ?? new Date().toISOString(),
    fromName: from.name,
    fromEmail: from.email,
    to: addressList(parsed.to),
    cc: addressList(parsed.cc),
    subject: parsed.subject ?? '(No subject)',
    messageIdHeader: parsed.messageId,
    references: parsed.references?.split(/\s+/).filter(Boolean) ?? [],
    snippet: (input.snippet ?? text).replace(/\s+/g, ' ').trim().slice(0, 240),
    text,
    html,
    labelIds: input.labelIds,
    sizeEstimate: input.sizeEstimate ?? 0,
    rawPath: database.rawPath(accountId, input.id),
    attachments: input.content.attachments.map((attachment, index) => ({
      id: partialAttachmentId(attachment, index),
      messageId: input.id,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size: attachment.size,
      ...(attachment.contentId ? { contentId: attachment.contentId } : {})
    })),
    remoteFolderId: input.remoteFolderId,
    remoteUid: input.remoteUid,
    contentState: input.state
  }
  database.upsertMessage(record)
  return { record, isNew }
}

/** IMAP has no provider thread ids everywhere; threads follow the first References entry like full downloads. */
export async function imapThreadId(headers: string | Buffer, fallback: string) {
  const parsed = await PostalMime.parse(typeof headers === 'string' ? Buffer.from(headers || '\r\n\r\n', 'utf8') : headers)
  const rootHeader = parsed.references?.split(/\s+/).filter(Boolean)[0] ?? parsed.inReplyTo ?? parsed.messageId ?? fallback
  return createHash('sha256').update(rootHeader).digest('base64url').slice(0, 32)
}

const gmailDate = (internalDate?: string) => new Date(Number(internalDate ?? Date.now())).toISOString()

export function gmailRawInput(message: GmailRawMessage): RawMessageInput {
  return {
    id: message.id,
    threadId: message.threadId,
    historyId: message.historyId ?? '0',
    raw: Buffer.from(message.raw.replaceAll('-', '+').replaceAll('_', '/'), 'base64'),
    labelIds: message.labelIds ?? [],
    internalDate: gmailDate(message.internalDate),
    snippet: message.snippet,
    sizeEstimate: message.sizeEstimate
  }
}

function gmailPartialInput(resource: GmailMessageResource, state: PartialStoreInput['state']): PartialStoreInput {
  return {
    id: resource.id,
    threadId: resource.threadId,
    historyId: resource.historyId ?? '0',
    labelIds: resource.labelIds ?? [],
    internalDate: gmailDate(resource.internalDate),
    snippet: resource.snippet,
    sizeEstimate: resource.sizeEstimate,
    content: state === 'body' ? gmailPartialContent(resource.payload) : { headers: gmailHeaderBlock(resource.payload), text: '', html: '', attachments: [] },
    state
  }
}

/**
 * What is really stored: an original recorded as stored but missing on disk
 * (removed outside Aerio) counts as body-only so it is downloaded again.
 * `refresh` (first sync or Rebuild) ignores the cache entirely.
 */
function storedState(database: MailDatabase, accountId: string, messageId: string, refresh = false): MailOfflineContentState | undefined {
  if (refresh) return undefined
  const state = database.offline.contentState(accountId, messageId)
  if (state !== 'full') return state
  const path = database.getMessageRaw(accountId, messageId)
  return path && database.rawExists(path) ? 'full' : 'body'
}

/** True when a stored message already holds what its locations want (or is out of scope, which keeps what it has). */
function alreadyCurrent(existing: MailOfflineContentState | undefined, wanted: MailWantedContent) {
  return Boolean(existing) && (wanted === 'outside' || stateSatisfies(existing!, wanted))
}

// ---- Gmail -----------------------------------------------------------------

/**
 * Gmail: `format=raw` for full content, `format=full` (bodies, attachment
 * references only) or `format=metadata` (headers). When policies differ by
 * label, the labels are read first so each message gets the most complete
 * content any of its labels asks for.
 */
export async function downloadGmailMessage(deps: OfflineDownloadDeps, client: GmailOfflineClient, accountId: string, id: string, context?: OfflinePolicyContext, refresh = false): Promise<DownloadOutcome> {
  if (!context) return stored(await deps.storeRaw(accountId, gmailRawInput(await client.getRawMessage(id))))
  const { database } = deps
  const existing = storedState(database, accountId, id, refresh)
  const uniform = uniformPolicy(context)
  let metadata: GmailMessageResource | undefined
  let wanted: MailWantedContent
  if (!existing && uniform && !uniform.start) wanted = uniform.policy.downloadMode
  else {
    metadata = await client.getMessage(id, 'metadata')
    wanted = wantedContent(context, gmailDate(metadata.internalDate), metadata.labelIds ?? [])
    if (alreadyCurrent(existing, wanted)) {
      database.updateMessageLabels(accountId, id, metadata.labelIds ?? [], metadata.historyId ?? '0')
      database.markSyncItem(accountId, id, 'complete')
      return { outcome: 'current' }
    }
    if (wanted === 'outside') {
      database.offline.dropSyncItem(accountId, id)
      return { outcome: 'outside' }
    }
  }
  if (wanted === 'full') return stored(await deps.storeRaw(accountId, gmailRawInput(await client.getRawMessage(id))))
  if (wanted === 'bodies') return stored(await storePartialMessage(deps, accountId, gmailPartialInput(await client.getMessage(id, 'full'), 'body')))
  return stored(await storePartialMessage(deps, accountId, gmailPartialInput(metadata ?? await client.getMessage(id, 'metadata'), 'headers')))
}

// ---- Microsoft Graph -----------------------------------------------------

export interface GraphDownloadInput {
  message: GraphMessage
  folderId: string
  labels: string[]
  threadId: string
  /** A rebuild downloads again even when the message is cached. */
  refresh?: boolean
}

/** Graph: MIME `$value` for full content, or `$select` header fields (plus `body`) without attachment bytes. */
export async function downloadGraphMessage(deps: OfflineDownloadDeps, client: GraphOfflineClient, accountId: string, input: GraphDownloadInput, context?: OfflinePolicyContext): Promise<DownloadOutcome> {
  const { database } = deps
  const { message, folderId, labels, threadId } = input
  const historyId = `graph:${Date.now()}`
  const internalDate = message.receivedDateTime ?? message.sentDateTime
  if (context) {
    const existing = storedState(database, accountId, message.id, input.refresh)
    const wanted = wantedContent(context, internalDate ?? '', labels)
    if (alreadyCurrent(existing, wanted)) {
      database.updateMessageLabels(accountId, message.id, labels, historyId, { remoteFolderId: folderId, remoteUid: message.id })
      database.markSyncItem(accountId, message.id, 'complete')
      return { outcome: 'current' }
    }
    if (wanted === 'outside') {
      database.offline.dropSyncItem(accountId, message.id)
      return { outcome: 'outside' }
    }
    if (wanted !== 'full') return stored(await storeGraphPartial(deps, client, accountId, { ...input, historyId, internalDate }, wanted === 'bodies' ? 'body' : 'headers'))
  }
  return stored(await deps.storeRaw(accountId, {
    id: message.id, threadId, historyId, raw: await client.messageRaw(message.id), labelIds: labels, internalDate, remoteFolderId: folderId, remoteUid: message.id
  }))
}

async function storeGraphPartial(deps: OfflineDownloadDeps, client: GraphOfflineClient, accountId: string, input: GraphDownloadInput & { historyId: string; internalDate?: string }, state: PartialStoreInput['state']) {
  const fields = await client.messageFields(input.message.id, state === 'body')
  const attachments = state === 'body' && fields.hasAttachments ? await client.attachmentList(input.message.id) : []
  return storePartialMessage(deps, accountId, {
    id: input.message.id,
    threadId: input.threadId,
    historyId: input.historyId,
    labelIds: input.labels,
    internalDate: input.internalDate ?? fields.receivedDateTime ?? fields.sentDateTime,
    snippet: fields.bodyPreview,
    content: graphPartialContent(fields, attachments),
    state,
    remoteFolderId: input.folderId,
    remoteUid: input.message.id
  })
}

// ---- IMAP ------------------------------------------------------------------

export interface ImapDownloadItem {
  id: string
  threadId: string
  uid: number
  uidValidity: string
}

/** IMAP: FETCH BODY[] for full content, or BODYSTRUCTURE and header fields (plus only the text parts) otherwise. */
export async function downloadImapMessage(deps: OfflineDownloadDeps, client: Pick<ImapSmtpClient, 'fetchRaw' | 'fetchPartial'>, connection: ImapFlow, accountId: string, folder: ImapFolder, item: ImapDownloadItem, context?: OfflinePolicyContext, refresh = false): Promise<DownloadOutcome> {
  const { database } = deps
  const historyId = `${item.uidValidity}:${item.uid}`
  if (context) {
    const existing = storedState(database, accountId, item.id, refresh)
    const uniform = uniformPolicy(context)
    if (existing || !uniform || uniform.start || uniform.policy.downloadMode !== 'full') {
      const header = await client.fetchPartial(connection, folder, item.uid, false)
      const wanted = wantedContent(context, header.internalDate, header.labels)
      if (alreadyCurrent(existing, wanted)) {
        database.markSyncItem(accountId, item.id, 'complete')
        return { outcome: 'current' }
      }
      if (wanted === 'outside') {
        database.offline.dropSyncItem(accountId, item.id)
        return { outcome: 'outside' }
      }
      if (wanted !== 'full') {
        const content = wanted === 'bodies' ? await client.fetchPartial(connection, folder, item.uid, true) : header
        return stored(await storePartialMessage(deps, accountId, {
          id: item.id,
          threadId: await imapThreadId(content.headers, item.threadId),
          historyId,
          labelIds: content.labels,
          internalDate: content.internalDate,
          sizeEstimate: content.size,
          content: { headers: content.headers, text: content.text, html: content.html, attachments: content.attachments },
          state: wanted === 'bodies' ? 'body' : 'headers',
          remoteFolderId: folder.path,
          remoteUid: String(item.uid)
        }))
      }
    }
  }
  const fetched = await client.fetchRaw(connection, folder, { id: item.id, threadId: item.threadId, folder: folder.path, uid: item.uid, uidValidity: item.uidValidity, labels: [] })
  return stored(await deps.storeRaw(accountId, {
    id: item.id,
    threadId: await imapThreadId(fetched.raw, item.threadId),
    historyId,
    raw: fetched.raw,
    labelIds: fetched.labels,
    internalDate: fetched.internalDate,
    sizeEstimate: fetched.size,
    remoteFolderId: folder.path,
    remoteUid: String(item.uid)
  }))
}

// ---- On demand -------------------------------------------------------------

/** Downloads the complete original of a cached message, e.g. when a header-only message is opened or an attachment is requested. */
export async function fetchFullMessage(deps: OfflineDownloadDeps, clients: OfflineProviderClients, accountId: string, messageId: string): Promise<StoredMessage> {
  const { database } = deps
  const row = database.offline.messageRow(accountId, messageId)
  if (!row) throw new Error('Message not found')
  const provider = database.getAccount(accountId)?.provider
  if (!provider || provider === 'local') throw new Error('The original message is not available offline')
  if (provider === 'gmail') {
    const raw = await clients.gmail(accountId).getRawMessage(messageId)
    return deps.storeRaw(accountId, { ...gmailRawInput(raw), threadId: row.threadId, internalDate: row.internalDate })
  }
  if (provider === 'microsoft') {
    return deps.storeRaw(accountId, {
      id: messageId, threadId: row.threadId, historyId: row.historyId, raw: await clients.microsoft(accountId).messageRaw(messageId),
      labelIds: row.labelIds, internalDate: row.internalDate, remoteFolderId: row.remoteFolderId, remoteUid: row.remoteUid
    })
  }
  const uid = Number(row.remoteUid)
  if (!row.remoteFolderId || !Number.isSafeInteger(uid)) throw new Error('The IMAP message reference is invalid')
  const client = await clients.imap(accountId)
  const raw = await client.withConnection((connection) => client.fetchRaw(connection, { path: row.remoteFolderId!, name: row.remoteFolderId! }, {
    id: messageId, threadId: row.threadId, folder: row.remoteFolderId!, uid, uidValidity: row.historyId.split(':')[0] ?? '', labels: []
  }))
  return deps.storeRaw(accountId, {
    id: messageId, threadId: row.threadId, historyId: row.historyId, raw: raw.raw, labelIds: row.labelIds,
    internalDate: row.internalDate, sizeEstimate: raw.size, remoteFolderId: row.remoteFolderId, remoteUid: row.remoteUid
  })
}

/** Downloads whatever a cached message is missing for its current policy (queued after a policy upgrade). */
export async function upgradeStoredMessage(deps: OfflineDownloadDeps, clients: OfflineProviderClients, accountId: string, messageId: string, context: OfflinePolicyContext): Promise<DownloadOutcome> {
  const { database } = deps
  const row = database.offline.messageRow(accountId, messageId)
  if (!row) {
    // Never cached (its first download failed); it is retried by the next full synchronization instead.
    database.markSyncItem(accountId, messageId, 'failed', 'The message has not been downloaded yet')
    return { outcome: 'current' }
  }
  const wanted = wantedContent(context, row.internalDate, row.labelIds)
  if (alreadyCurrent(row.state, wanted)) {
    database.markSyncItem(accountId, messageId, 'complete')
    return { outcome: 'current' }
  }
  if (wanted === 'full') return stored(await fetchFullMessage(deps, clients, accountId, messageId))
  const provider = database.getAccount(accountId)?.provider
  if (provider === 'gmail') return stored(await storePartialMessage(deps, accountId, { ...gmailPartialInput(await clients.gmail(accountId).getMessage(messageId, 'full'), 'body'), threadId: row.threadId }))
  if (provider === 'microsoft') {
    return stored(await storeGraphPartial(deps, clients.microsoft(accountId), accountId, {
      message: { id: messageId }, folderId: row.remoteFolderId ?? '', labels: row.labelIds, threadId: row.threadId, historyId: row.historyId, internalDate: row.internalDate
    }, 'body'))
  }
  const uid = Number(row.remoteUid)
  if (!row.remoteFolderId || !Number.isSafeInteger(uid)) throw new Error('The IMAP message reference is invalid')
  const client = await clients.imap(accountId)
  const content = await client.withConnection((connection) => client.fetchPartial(connection, { path: row.remoteFolderId!, name: row.remoteFolderId! }, uid, true))
  return stored(await storePartialMessage(deps, accountId, {
    id: messageId, threadId: row.threadId, historyId: row.historyId, labelIds: row.labelIds, internalDate: row.internalDate, sizeEstimate: content.size,
    content: { headers: content.headers, text: content.text, html: content.html, attachments: content.attachments },
    state: 'body', remoteFolderId: row.remoteFolderId, remoteUid: row.remoteUid
  }))
}

// ---- Server search -----------------------------------------------------------

export const SERVER_SEARCH_LIMIT = 250

/**
 * Searches the whole mailbox on the provider. Matches that are not cached yet
 * are added as header rows so they can be listed and opened (their bodies
 * download on open).
 */
export async function searchServer(deps: OfflineDownloadDeps, clients: OfflineProviderClients, accountId: string, query: string, limit = SERVER_SEARCH_LIMIT) {
  const { database } = deps
  const provider = database.getAccount(accountId)?.provider
  if (!provider || provider === 'local') throw new Error('Local Folders are searched on this computer only')
  const threadIds = new Set<string>()
  let added = 0
  const known = (id: string) => {
    const row = database.offline.messageRow(accountId, id)
    if (row) threadIds.add(row.threadId)
    return Boolean(row)
  }
  if (provider === 'gmail') {
    const client = clients.gmail(accountId)
    const page = await client.listMessages(undefined, query)
    for (const ref of (page.messages ?? []).slice(0, limit)) {
      if (known(ref.id)) continue
      const result = await storePartialMessage(deps, accountId, gmailPartialInput(await client.getMessage(ref.id, 'metadata'), 'headers'))
      threadIds.add(result.record.threadId)
      added += 1
    }
  } else if (provider === 'microsoft') {
    const client = clients.microsoft(accountId)
    const folders = new Map(database.listLabels([accountId]).map((label) => [label.id, label.name]))
    for (const message of await client.search(query, limit)) {
      if (known(message.id)) continue
      const folderId = message.parentFolderId ?? ''
      const labels = microsoftMessageLabels({ id: folderId, displayName: folders.get(`folder:${folderId}`) ?? '' }, message)
      const result = await storeGraphPartial(deps, client, accountId, { message, folderId, labels, threadId: message.conversationId ?? message.id, historyId: `graph:${Date.now()}` }, 'headers')
      threadIds.add(result.record.threadId)
      added += 1
    }
  } else {
    const client = await clients.imap(accountId)
    await client.withConnection(async (connection) => {
      let remaining = limit
      for (const folder of await client.listFolders(connection)) {
        if (remaining <= 0) break
        for (const match of (await client.searchText(connection, folder, query)).slice(0, remaining)) {
          remaining -= 1
          if (known(match.id)) continue
          const content = await client.fetchPartial(connection, folder, match.uid, false)
          const result = await storePartialMessage(deps, accountId, {
            id: match.id,
            threadId: await imapThreadId(content.headers, match.id),
            historyId: `${match.uidValidity}:${match.uid}`,
            labelIds: content.labels,
            internalDate: content.internalDate,
            sizeEstimate: content.size,
            content: { headers: content.headers, text: '', html: '', attachments: content.attachments },
            state: 'headers',
            remoteFolderId: folder.path,
            remoteUid: String(match.uid)
          })
          threadIds.add(result.record.threadId)
          added += 1
        }
      }
    })
  }
  return { threadIds: [...threadIds], added }
}
