import { parentPort } from 'node:worker_threads'
import { createHash } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statfsSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { join, sep } from 'node:path'
import PostalMime, { type Address, type Attachment as ParsedAttachment } from 'postal-mime'
import type {
  MailDraftInput,
  MailDraftResult,
  MailAccountSummary,
  MailRule,
  MailMessageDetail,
  MailWorkerEvent,
  MailActionKind,
  PendingOperation,
  SyncProgress
} from '../src/mail-types'
import type {
  MailWorkerCommand,
  MailWorkerResult,
  WorkerEventMessage,
  WorkerRequest,
  WorkerResponse,
  WorkerCredentialResponse,
  WorkerOpenPgpResponse,
  AccountCredential
} from './mail-protocol'
import { MailDatabase, type ParsedMailMessage } from './mail/database'
import { GmailApiError, GmailClient, type GmailRawMessage } from './mail/gmail-client'
import { ImapSmtpClient, labelsForImapFolders, type ImapFolder } from './mail/imap-client'
import { MicrosoftGraphClient, MicrosoftGraphError, microsoftLabels, microsoftMessageLabels } from './mail/microsoft-client'
import { MailFolderManager } from './mail/folder-management'
import { applyExchangeAction, ExchangeFolderApi, saveExchangeDraft, sendExchangeMime, syncExchangeMail, type ExchangeProviderState } from './exchange/ews-mail'
import { ewsClientFor } from './exchange/exchange-config'
import { EwsError, type EwsClient } from './exchange/ews-client'
import { EwsAuthError } from './exchange/ews-transport'
import { sanitizeMessageHtmlWithReport } from './mail/message-security'
import { buildNewMailNotification } from './mail/new-mail'
import { messageIdFromMime } from './mail/reply-watches'
import { mailRuleTriggersForLabels } from '../src/lib/mail-rules'
import { parseMessageSource } from './mail/message-source'
import { runMailQuickAction } from './mail/quick-actions'
import { MailImportService } from './mail/mail-import'
import { transferToLocalFolders } from './mail/local-folders'
import { mailProviderKeepsFoldersLocally } from '../src/lib/local-folders'
import { Pop3Service } from './mail/pop3-sync'
import { pop3SmtpConfig } from './mail/pop3-settings'
import { MailArchiveService } from './mail/mail-archive'
import { removeArchivedMessages } from './mail/mail-archive-removal'
import { scanMailDuplicates } from './mail/mail-duplicates'
import { commitDownloadedRaw, downloadGmailMessage, downloadGraphMessage, downloadImapMessage, removePartialDownloads, upgradeStoredMessage, type RawMessageInput } from './mail/offline-download'
import { createOfflineCommands, type OfflineCommands } from './mail/offline-commands'
import { earliestStart, gmailAfterQuery, messageLocations, startForLocations } from '../src/lib/offline-sync'
import { imapMessageLabels } from './mail/imap-client'
import { draftRecipientsAreSyncable } from '../src/lib/mail-address'
import { createCalendarMimeBuffer, createMime, createMimeBuffer } from './mail/mime-builder'
import { calendarPartsFromRaw } from './mail/invitation-parts'
import { describeSenderRejection, parseGmailSendAs, parseMicrosoftProxyAddresses, resolveDraftSender } from './mail/sender-identity'
import { createReceiptService } from './mail/receipts'
import { AttachmentContentIndexer } from './mail/attachment-text-indexer'
import { AttachmentExtractRunner } from './mail/attachment-extract-runner'
import { supportedSendOptions } from '../src/lib/mail-send-options'
import { isLocalOnlyMailAction } from '../src/lib/mail-pins'
import { handleMailFolderPreferenceCommand, type MailFolderPreferenceCommand } from './mail/folder-preferences'
import { categoryHintFromHeaders, handleInboxCategoryCommand, isInboxCategoryCommand } from './mail/inbox-category-worker'
import { isMailboxOwnerCommand, MailboxOwnerService } from './mail/mailbox-owner-worker'
import { PRIMARY_MAILBOX_OWNER } from '../src/mailbox-owner-types'
import { isMicrosoftInferenceLabel } from '../src/lib/mail-categories'
import type { MailMergeJobInput } from '../src/mail-merge-types'
import type { MailCategoryId } from '../src/mail-category-types'
import { clampMailMergeLimits, MAIL_MERGE_MAX_RECIPIENTS, normalizeMergeRecipients } from '../src/lib/mail-merge'
import { MailMergeNotSubmittedError, MailMergeRunner } from './mail/mail-merge-runner'
import { MAIL_MERGE_DAY_MS } from './mail/mail-merge-store'
import {
  BACKGROUND_MAIL_POLL_INTERVAL_MS,
  clampMailPollingInterval,
  mailPollingIntervalForProvider
} from './mail/polling-policy'

const port = parentPort!
if (!port) throw new Error('The Aerio mail worker must run in a worker thread')

let database: MailDatabase | undefined
let attachmentIndexer: AttachmentContentIndexer | undefined
let attachmentExtractor: AttachmentExtractRunner | undefined
let contentPath = ''
let online = true
let operationTimer: NodeJS.Timeout | undefined
let mailMergeTimer: NodeJS.Timeout | undefined
let mailMergeRunnerInstance: MailMergeRunner | undefined
let pollTimer: NodeJS.Timeout | undefined
const paused = new Set<string>()
const syncing = new Set<string>()
const syncScheduled = new Set<string>()
const credentialRequests = new Map<string, { resolve: (value: AccountCredential) => void; reject: (error: Error) => void }>()
const openPgpRequests = new Map<string, { resolve: (value: string) => void; reject: (error: Error) => void }>()
const nextRequestAt = new Map<string, number>()
const draftQueues = new Map<string, Promise<unknown>>()
const lastAutomaticSyncAt = new Map<string, number>()
let pollingIntervalMs = BACKGROUND_MAIL_POLL_INTERVAL_MS
let lastReplyWatchPassAt = 0
const REPLY_WATCH_INTERVAL_MS = 15_000
const UNDO_SEND_DELAY_MS = 10_000
const DRAFT_CONFLICT_MESSAGE = 'This draft changed after it was opened in another mail client. Your version was not overwritten; save it as a copy to keep both versions.'

class DraftConflictError extends Error {
  constructor() { super(DRAFT_CONFLICT_MESSAGE); this.name = 'DraftConflictError' }
}

const emit = (event: MailWorkerEvent) => port.postMessage({ kind: 'event', event } satisfies WorkerEventMessage)
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

function pollAccounts() {
  if (!database || !online) return
  const now = Date.now()
  for (const account of database.listAccounts().filter((item) => !item.archived && item.syncEnabled && item.status !== 'needs-auth' && item.status !== 'paused' && !paused.has(item.id))) {
    const cadence = mailPollingIntervalForProvider(pollingIntervalMs, account.provider)
    if (now - (lastAutomaticSyncAt.get(account.id) ?? 0) < cadence) continue
    lastAutomaticSyncAt.set(account.id, now)
    void syncAccount(account.id)
  }
}

function schedulePolling(intervalMs: number) {
  clearInterval(pollTimer)
  pollingIntervalMs = clampMailPollingInterval(intervalMs)
  pollTimer = setInterval(pollAccounts, pollingIntervalMs)
}

async function getCredential(accountId: string) {
  const id = crypto.randomUUID()
  return new Promise<AccountCredential>((resolve, reject) => {
    credentialRequests.set(id, { resolve, reject })
    port.postMessage({ kind: 'credential-request', id, accountId })
  })
}

const smimeRequested = (input: MailDraftInput) => Boolean(input.smime?.sign || input.smime?.encrypt)
/** OpenPGP or S/MIME protection was asked for; the main process does the crypto either way. */
const protectionRequested = (input: MailDraftInput) => Boolean(input.openPgp?.sign || input.openPgp?.encrypt) || smimeRequested(input)

/**
 * Signs and/or encrypts an outgoing message in the main process when the
 * draft asks for it. Any failure throws, so delivery aborts and the draft is
 * kept: a protected draft is never sent as plaintext.
 */
async function protectOutgoing(mime: Buffer, input: MailDraftInput, from: string | undefined) {
  if (!protectionRequested(input)) return mime
  if (!from) throw new Error('The sender address is unknown, so the message cannot be signed or encrypted. The message was not sent; your draft is kept.')
  const id = crypto.randomUUID()
  const message = await new Promise<string>((resolve, reject) => {
    openPgpRequests.set(id, { resolve, reject })
    port.postMessage({ kind: 'openpgp-request', id, message: mime.toString('utf8'), from, recipients: [...input.to, ...input.cc, ...input.bcc], options: input.openPgp ?? {}, ...(smimeRequested(input) ? { smime: input.smime } : {}) })
  })
  return Buffer.from(message, 'utf8')
}

async function rateLimit(accountId: string) {
  const now = Date.now()
  const slot = Math.max(now, nextRequestAt.get(accountId) ?? now)
  nextRequestAt.set(accountId, slot + 240)
  if (slot > now) await sleep(slot - now)
}

function clientFor(accountId: string) {
  return new GmailClient(accountId, async (id) => {
    await rateLimit(id)
    const credential = await getCredential(id)
    if (credential.type !== 'oauth') throw new Error('The Gmail account does not have OAuth credentials')
    return credential.accessToken
  })
}

async function imapClientFor(accountId: string) {
  const credential = await getCredential(accountId)
  // POP3 accounts send through the same SMTP path; their mail never uses IMAP.
  if (credential.type === 'pop3') return new ImapSmtpClient(pop3SmtpConfig(credential.config))
  if (credential.type !== 'imap') throw new Error('The IMAP account does not have server credentials')
  return new ImapSmtpClient(credential.config)
}

let pop3ServiceInstance: Pop3Service | undefined
let pop3ChangedAt = 0
function pop3Service() {
  if (!database) throw new Error('Database is not initialized')
  pop3ServiceInstance ??= new Pop3Service({
    database,
    credential: async (accountId) => {
      const credential = await getCredential(accountId)
      if (credential.type !== 'pop3') throw new Error('The POP3 account does not have server credentials')
      return credential.config
    },
    store: (accountId, message, commit) => parseRawAndStore(accountId, message, commit),
    assertCanSync,
    emitProgress: (payload) => emit({ type: 'sync-progress', payload }),
    changed: (accountId) => {
      if (Date.now() - pop3ChangedAt < 2_000) return
      pop3ChangedAt = Date.now()
      emit({ type: 'mail-changed', payload: { accountId } })
    }
  })
  return pop3ServiceInstance
}

async function syncPop3Account(accountId: string) {
  if (!database) throw new Error('Database is not initialized')
  const firstSync = !database.getAccountHistory(accountId)
  const result = await pop3Service().sync(accountId)
  database.setAccountHistory(accountId, `pop3:${Date.now()}`, true)
  emit({ type: 'accounts-changed', payload: database.listAccounts() })
  for (const changed of result.changedAccounts) emit({ type: 'mail-changed', payload: { accountId: changed } })
  // The first download of an existing maildrop is not "new mail".
  if (!firstSync) emitNewMail(accountId, result.newMessages)
}

function microsoftClientFor(accountId: string) {
  return new MicrosoftGraphClient(async () => {
    const credential = await getCredential(accountId)
    if (credential.type !== 'oauth') throw new Error('The Microsoft account does not have OAuth credentials')
    return credential.accessToken
  })
}

// One EWS client per Exchange account, so NTLM's authenticated connection is reused; a changed
// password or token replaces it.
const exchangeClients = new Map<string, { key: string; client: EwsClient }>()
async function exchangeClientFor(accountId: string) {
  const credential = await getCredential(accountId)
  if (credential.type !== 'exchange') throw new Error('The Exchange account does not have server credentials')
  const key = JSON.stringify(credential.config)
  const cached = exchangeClients.get(accountId)
  if (cached?.key === key) return cached.client
  cached?.client.close()
  const client = ewsClientFor(credential.config)
  exchangeClients.set(accountId, { key, client })
  return client
}

// Shared/delegated mailboxes and public folders (E40) synchronize after the account's own mailbox.
let mailboxOwnerInstance: MailboxOwnerService | undefined
function mailboxOwners() {
  if (!database) throw new Error('Database is not initialized')
  if (!mailboxOwnerInstance) {
    mailboxOwnerInstance = new MailboxOwnerService({
      database,
      exchangeClient: exchangeClientFor,
      exchangeConfig: async (accountId) => {
        const credential = await getCredential(accountId)
        if (credential.type !== 'exchange') throw new Error('The Exchange account does not have server credentials')
        return credential.config
      },
      microsoftClient: (accountId, mailbox) => mailbox ? new MicrosoftGraphClient(async () => {
        const credential = await getCredential(accountId)
        if (credential.type !== 'oauth') throw new Error('The Microsoft account does not have OAuth credentials')
        return credential.accessToken
      }, { mailbox }) : microsoftClientFor(accountId),
      store: (accountId, message) => parseRawAndStore(accountId, message),
      emit,
      checkpoint: (accountId) => assertCanSync(accountId)
    })
  }
  return mailboxOwnerInstance
}

let folderManagerInstance: MailFolderManager | undefined
function folderManager() {
  if (!database) throw new Error('Database is not initialized')
  if (!folderManagerInstance) {
    const db = database
    folderManagerInstance = new MailFolderManager({ database: db, online: () => online, gmail: clientFor, microsoft: microsoftClientFor, imap: imapClientFor, exchange: async (accountId) => new ExchangeFolderApi(await exchangeClientFor(accountId)) })
  }
  return folderManagerInstance
}

// Imports run here, off the UI and main threads; messages go through the
// same parse-and-store path as synchronized mail.
let importServiceInstance: MailImportService | undefined
let importChangedAt = 0
function importService() {
  if (!database) throw new Error('Database is not initialized')
  if (!importServiceInstance) {
    const db = database
    importServiceInstance = new MailImportService({
      database: db,
      store: (accountId, message) => parseRawAndStore(accountId, message),
      freeBytes: () => {
        const stats = statfsSync(contentPath)
        return Number(stats.bavail) * Number(stats.bsize)
      },
      emit: (job) => emit({ type: 'import-progress', payload: job }),
      changed: (accountId, final) => {
        // Imports touch thousands of messages; refresh open views at most every 2 s.
        if (!final && Date.now() - importChangedAt < 2_000) return
        importChangedAt = Date.now()
        emit({ type: 'mail-changed', payload: { accountId } })
      }
    })
  }
  return importServiceInstance
}

// Automatic archiving (E31): scheduled sweeps into Local Folders. The pass
// runs at startup (catching up on runs missed while Aerio was closed) and
// every minute after that.
let archiveServiceInstance: MailArchiveService | undefined
let archiveTimer: NodeJS.Timeout | undefined
const ARCHIVE_SCHEDULER_INTERVAL_MS = 60_000
function archiveService() {
  if (!database) throw new Error('Database is not initialized')
  if (!archiveServiceInstance) {
    archiveServiceInstance = new MailArchiveService({
      database,
      store: (accountId, message) => parseRawAndStore(accountId, message),
      freeBytes: () => {
        const stats = statfsSync(contentPath)
        return Number(stats.bavail) * Number(stats.bsize)
      },
      emit: (job) => emit({ type: 'archive-progress', payload: job }),
      changed: (accountId, threadIds) => emit({ type: 'mail-changed', payload: { accountId, ...(threadIds ? { threadIds } : {}) } }),
      operationQueued: () => { void processOperations() }
    })
  }
  return archiveServiceInstance
}

function localStoreDeps() {
  if (!database) throw new Error('Database is not initialized')
  return { database, store: (accountId: string, message: Parameters<typeof parseRawAndStore>[1]) => parseRawAndStore(accountId, message) }
}

// Offline download and synchronization scope (E36). Without the offline
// store every download path behaves like the original full download.
let offlineCommandsInstance: OfflineCommands | undefined
const offlineClients = { gmail: clientFor, microsoft: microsoftClientFor, imap: imapClientFor }
function offlineDeps() {
  if (!database) throw new Error('Database is not initialized')
  return { database, storeRaw: (accountId: string, message: RawMessageInput) => parseRawAndStore(accountId, message) }
}
function offlineContext(accountId: string) {
  return database?.offline ? database.offline.context(accountId) : undefined
}
function offline() {
  if (!database) throw new Error('Database is not initialized')
  offlineCommandsInstance ??= createOfflineCommands({
    ...offlineDeps(),
    clients: offlineClients,
    online: () => online,
    resync: (accountId) => {
      const account = database?.getAccount(accountId)
      if (account && account.syncEnabled && !account.archived && !paused.has(accountId)) void syncAccount(accountId)
    },
    changed: (accountId) => emit({ type: 'mail-changed', payload: { accountId } })
  })
  return offlineCommandsInstance
}

function addressList(value?: Address[]) {
  if (!value) return []
  return value.flatMap((address) => {
    if (address.group) return address.group.map((member) => member.name ? `${member.name} <${member.address}>` : member.address)
    return [address.name ? `${address.name} <${address.address}>` : address.address]
  }).filter(Boolean)
}

function sender(value?: Address) {
  if (!value) return { name: '', email: '' }
  if (value.group) {
    const first = value.group[0]
    return { name: first?.name ?? '', email: first?.address ?? '' }
  }
  return { name: value.name ?? '', email: value.address }
}

function attachmentId(attachment: ParsedAttachment, index: number) {
  return `part-${index}-${Buffer.from(`${attachment.filename ?? ''}:${attachment.contentId ?? ''}:${attachment.mimeType}`).toString('base64url').slice(0, 16)}`
}

function decodeRaw(raw: string) {
  return Buffer.from(raw.replaceAll('-', '+').replaceAll('_', '/'), 'base64')
}

async function parseRawAndStore(accountId: string, message: {
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
}, commit?: (record: ParsedMailMessage) => void) {
  if (!database) throw new Error('Database is not initialized')
  const isNew = !database.hasMessage(accountId, message.id)
  const raw = message.raw
  const path = database.rawPath(accountId, message.id)
  // Written to a temporary file and committed only once it parses (E36: interrupted downloads never leave a partial original).
  const parsed = await commitDownloadedRaw(path, raw, () => PostalMime.parse(raw))
  const from = sender(parsed.from)
  const attachments = parsed.attachments.map((attachment, index) => ({
    id: attachmentId(attachment, index),
    messageId: message.id,
    filename: attachment.filename || `attachment-${index + 1}`,
    mimeType: attachment.mimeType || 'application/octet-stream',
    size: typeof attachment.content === 'string'
      ? Buffer.byteLength(attachment.content)
      : attachment.content.byteLength,
    contentId: attachment.contentId
  }))
  const record: ParsedMailMessage = {
    accountId,
    id: message.id,
    threadId: message.threadId,
    historyId: message.historyId,
    internalDate: message.internalDate ?? (parsed.date ? new Date(parsed.date).toISOString() : new Date().toISOString()),
    fromName: from.name,
    fromEmail: from.email,
    to: addressList(parsed.to),
    cc: addressList(parsed.cc),
    subject: parsed.subject ?? '(No subject)',
    messageIdHeader: parsed.messageId,
    references: parsed.references?.split(/\s+/).filter(Boolean) ?? [],
    snippet: message.snippet ?? (parsed.text ?? '').replace(/\s+/g, ' ').slice(0, 240),
    text: parsed.text ?? '',
    html: parsed.html ?? '',
    labelIds: message.labelIds,
    sizeEstimate: message.sizeEstimate ?? raw.byteLength,
    rawPath: path,
    attachments,
    remoteFolderId: message.remoteFolderId,
    remoteUid: message.remoteUid,
    categoryHint: categoryHintFromHeaders(from.email, parsed.headers)
  }
  // `commit` (the POP3 UIDL checkpoint) is saved in the same transaction as the message.
  if (commit) database.transaction(() => { database!.upsertMessage(record); commit(record) })
  else database.upsertMessage(record)
  if (record.attachments.length) attachmentIndexer?.schedule()
  return { record, isNew }
}

async function parseAndStore(accountId: string, message: GmailRawMessage) {
  return parseRawAndStore(accountId, {
    id: message.id,
    threadId: message.threadId,
    historyId: message.historyId ?? '0',
    raw: decodeRaw(message.raw),
    labelIds: message.labelIds ?? [],
    internalDate: new Date(Number(message.internalDate ?? Date.now())).toISOString(),
    snippet: message.snippet,
    sizeEstimate: message.sizeEstimate
  })
}

function progress(accountId: string, phase?: SyncProgress['phase'], message?: string) {
  if (!database) throw new Error('Database is not initialized')
  const current = database.getSyncProgress(accountId)[0] ?? {
    accountId,
    phase: 'idle',
    completed: 0,
    total: 0,
    transferredBytes: 0,
    updatedAt: new Date().toISOString()
  }
  const nextPhase = phase ?? current.phase
  const value: SyncProgress = {
    ...current,
    phase: nextPhase,
    message,
    pausedReason: nextPhase === 'paused' ? current.pausedReason : undefined,
    updatedAt: new Date().toISOString()
  }
  database.updateSyncProgress(value)
  emit({ type: 'sync-progress', payload: value })
  return value
}

function isAuthenticationError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return error instanceof EwsAuthError || (error instanceof GmailApiError && (error.status === 401 || error.status === 403)) ||
    (error instanceof MicrosoftGraphError && (error.status === 401 || error.status === 403)) ||
    /invalid_grant|connect(ed)? again|unauthori[sz]ed|authentication failed|invalid credentials|login failed/i.test(message)
}

async function assertCanSync(accountId: string) {
  while (paused.has(accountId) || !online) {
    const reason = paused.has(accountId) ? 'user' : 'offline'
    const current = progress(accountId, 'paused', reason === 'user' ? 'Sync paused' : 'Waiting for a network connection')
    database?.updateSyncProgress({ ...current, pausedReason: reason, updatedAt: new Date().toISOString() })
    await sleep(1_000)
  }
  if (!contentPath) return
  const stats = statfsSync(contentPath)
  const freeBytes = Number(stats.bavail) * Number(stats.bsize)
  if (freeBytes < 512 * 1024 * 1024) {
    paused.add(accountId)
    const current = progress(accountId, 'paused', 'Sync paused: less than 512 MB of disk space is free')
    database?.updateSyncProgress({ ...current, pausedReason: 'disk', updatedAt: new Date().toISOString() })
    throw new Error('Sync paused because disk space is low')
  }
}

async function downloadInventory(accountId: string) {
  if (!database) throw new Error('Database is not initialized')
  const client = clientFor(accountId)
  const profile = await client.getProfile()
  database.replaceLabels(accountId, await client.listLabels())
  const checkpoint = database.getSyncCheckpoint(accountId)
  const hasInventory = Number(checkpoint?.total ?? 0) > 0
  if (!hasInventory) database.resetInventory(accountId)
  let pageToken = checkpoint?.page_token ? String(checkpoint.page_token) : undefined
  const inventoryComplete = Boolean(checkpoint?.inventory_complete)
  const scope = offlineContext(accountId)
  const scopeStart = scope ? earliestStart(scope) : undefined
  const windowQuery = gmailAfterQuery(scopeStart)
  if (!inventoryComplete) {
    progress(accountId, 'inventory', 'Building the mailbox inventory')
    do {
      await assertCanSync(accountId)
      const page = windowQuery ? await client.listMessages(pageToken, windowQuery) : await client.listMessages(pageToken)
      database.addInventory(accountId, page.messages ?? [])
      pageToken = page.nextPageToken
      const current = progress(accountId, 'inventory', `Indexed ${database.getSyncProgress(accountId)[0]?.total ?? 0} messages`)
      database.updateSyncProgress(current, {
        pageToken: pageToken ?? null,
        initialHistoryId: profile.historyId
      })
    } while (pageToken)
    // Cached mail older than the window keeps its header rows (E36).
    database.offline?.retainOutsideWindow(accountId, scopeStart)
    database.reconcileInventory(accountId)
    database.completeInventory(accountId)
    if (scope) database.setProviderState(accountId, { ...database.getProviderState<GmailScopeState>(accountId, {}), offlineWindowStart: scopeStart?.toISOString() ?? 'all' })
  }

  progress(accountId, 'downloading', 'Downloading messages for offline use')
  database.retryFailedSyncItems(accountId)
  let catchUpHistoryId = String(database.getSyncCheckpoint(accountId)?.initial_history_id ?? profile.historyId)
  let nextCatchUpAt = Date.now() + 15_000
  while (true) {
    await assertCanSync(accountId)
    const pending = database.pendingMessageIds(accountId, 2)
    if (!pending.length) break
    const results = await Promise.all(pending.map(async ({ id }) => {
      try {
        // A full inventory (first sync or Rebuild) downloads again, like before E36.
        await downloadGmailMessage(offlineDeps(), client, accountId, id, scope, true)
        return { id }
      } catch (error) {
        return { id, error: error instanceof Error ? error : new Error(String(error)) }
      }
    }))
    const authenticationFailure = results.find((result) => result.error && isAuthenticationError(result.error))?.error
    if (authenticationFailure) throw authenticationFailure
    for (const result of results) {
      if (result.error) database.markSyncItem(accountId, result.id, 'failed', result.error.message)
    }
    const value = progress(accountId, 'downloading', 'Downloading messages for offline use')
    if (value.completed % 20 < 2) emit({ type: 'mail-changed', payload: { accountId } })
    if (Date.now() >= nextCatchUpAt) {
      const catchUp = await applyGmailHistory(accountId, catchUpHistoryId)
      catchUpHistoryId = catchUp.latestHistoryId
      const catchUpProgress = database.getSyncProgress(accountId)[0]
      if (catchUpProgress) database.updateSyncProgress(catchUpProgress, { initialHistoryId: catchUpHistoryId })
      if (catchUp.changed) emit({ type: 'mail-changed', payload: { accountId } })
      emitNewMail(accountId, catchUp.newMessages)
      nextCatchUpAt = Date.now() + 15_000
    }
  }
  const finalCatchUp = await applyGmailHistory(accountId, catchUpHistoryId)
  catchUpHistoryId = finalCatchUp.latestHistoryId
  const current = database.getSyncProgress(accountId)[0]
  if (current) database.updateSyncProgress(current, { initialHistoryId: catchUpHistoryId })
  if (finalCatchUp.changed) emit({ type: 'mail-changed', payload: { accountId } })
  emitNewMail(accountId, finalCatchUp.newMessages)
  const failed = database.syncFailureCount(accountId)
  if (failed) throw new Error(`${failed.toLocaleString()} message${failed === 1 ? '' : 's'} could not be downloaded after repeated attempts`)
  database.setAccountHistory(accountId, catchUpHistoryId, true)
  const done = progress(accountId, 'complete', 'Mailbox is available offline')
  emit({ type: 'accounts-changed', payload: database.listAccounts() })
  emit({ type: 'mail-changed', payload: { accountId } })
  return done
}

async function applyGmailHistory(accountId: string, startHistoryId: string) {
  if (!database) throw new Error('Database is not initialized')
  const client = clientFor(accountId)
  let pageToken: string | undefined
  let latestHistoryId = startHistoryId
  let changed = false
  const changedMessages = new Map<string, { id: string; threadId: string }>()
  const addedMessageIds = new Set<string>()
  do {
    await assertCanSync(accountId)
    const page = await client.listHistory(startHistoryId, pageToken)
    latestHistoryId = page.historyId ?? latestHistoryId
    for (const history of page.history ?? []) {
      latestHistoryId = history.id || latestHistoryId
      for (const deleted of history.messagesDeleted ?? []) {
        database.deleteMessage(accountId, deleted.message.id)
        changedMessages.delete(deleted.message.id)
        changed = true
      }
      for (const entry of history.messagesAdded ?? []) {
        changedMessages.set(entry.message.id, entry.message)
        addedMessageIds.add(entry.message.id)
        changed = true
      }
      for (const entry of history.labelsAdded ?? []) {
        changedMessages.set(entry.message.id, entry.message)
        changed = true
      }
      for (const entry of history.labelsRemoved ?? []) {
        changedMessages.set(entry.message.id, entry.message)
        changed = true
      }
    }
    pageToken = page.nextPageToken
  } while (pageToken)

  database.addInventory(accountId, [...changedMessages.values()])
  const newMessages: ParsedMailMessage[] = []
  const scope = offlineContext(accountId)
  for (const message of changedMessages.values()) {
    try {
      const result = await downloadGmailMessage(offlineDeps(), client, accountId, message.id, scope)
      if (result.outcome === 'stored' && result.stored.isNew && addedMessageIds.has(message.id)) newMessages.push(result.stored.record)
    } catch (error) {
      if (error instanceof GmailApiError && error.status === 404) database.deleteMessage(accountId, message.id)
      else throw error
    }
  }
  return { latestHistoryId, changed, newMessages }
}

async function incrementalSync(accountId: string) {
  if (!database) throw new Error('Database is not initialized')
  const startHistoryId = database.getAccountHistory(accountId)
  if (!startHistoryId) return downloadInventory(accountId)
  database.replaceLabels(accountId, await clientFor(accountId).listLabels())
  progress(accountId, 'incremental', 'Checking for changes')
  try {
    const result = await applyGmailHistory(accountId, startHistoryId)
    await syncGmailScope(accountId)
    database.setAccountHistory(accountId, result.latestHistoryId, true)
    progress(accountId, 'complete', 'Up to date')
    if (result.changed) emit({ type: 'mail-changed', payload: { accountId } })
    emitNewMail(accountId, result.newMessages)
  } catch (error) {
    if (error instanceof GmailApiError && error.status === 404) {
      database.resetInventory(accountId)
      return downloadInventory(accountId)
    }
    throw error
  }
}

interface GmailScopeState {
  /** The window start the inventory last covered: an ISO date, or 'all'. */
  offlineWindowStart?: string
}

/**
 * After a widened window (E36) lists the newly included range with Gmail's
 * `after:`/`before:` search, then downloads queued messages: that backfill
 * plus content upgrades queued by a policy change.
 */
async function syncGmailScope(accountId: string) {
  const scope = offlineContext(accountId)
  if (!database || !scope) return
  const client = clientFor(accountId)
  const state = database.getProviderState<GmailScopeState>(accountId, {})
  const start = earliestStart(scope)
  const recorded = state.offlineWindowStart
  if (recorded && recorded !== 'all' && (!start || start.getTime() < Date.parse(recorded))) {
    const query = [gmailAfterQuery(start), `before:${Math.floor(Date.parse(recorded) / 1000)}`].filter(Boolean).join(' ')
    let pageToken: string | undefined
    do {
      await assertCanSync(accountId)
      const page = await client.listMessages(pageToken, query)
      database.addInventory(accountId, page.messages ?? [])
      pageToken = page.nextPageToken
    } while (pageToken)
  }
  const current = start?.toISOString() ?? 'all'
  if (recorded !== current) database.setProviderState(accountId, { ...state, offlineWindowStart: current })
  let downloaded = 0
  while (true) {
    await assertCanSync(accountId)
    const pending = database.pendingMessageIds(accountId, 2)
    if (!pending.length) break
    progress(accountId, 'downloading', 'Downloading messages for offline use')
    for (const { id } of pending) {
      try {
        await downloadGmailMessage(offlineDeps(), client, accountId, id, scope)
        downloaded += 1
      } catch (error) {
        if (isAuthenticationError(error)) throw error
        if (error instanceof GmailApiError && error.status === 404) database.deleteMessage(accountId, id)
        else database.markSyncItem(accountId, id, 'failed', error instanceof Error ? error.message : String(error))
      }
    }
    if (downloaded % 20 < 2) emit({ type: 'mail-changed', payload: { accountId } })
  }
}

interface ImapProviderState {
  folders: Record<string, { uidValidity: string; uidNext?: number; highestModseq?: string }>
}

async function syncImapAccount(accountId: string) {
  if (!database) throw new Error('Database is not initialized')
  const client = await imapClientFor(accountId)
  const firstSync = !database.getAccountHistory(accountId)
  const newMessages: ParsedMailMessage[] = []
  progress(accountId, 'inventory', 'Checking IMAP folders')
  await client.withConnection(async (connection) => {
    const folders = await client.listFolders(connection)
    database!.replaceLabels(accountId, labelsForImapFolders(accountId, folders))
    const previous = database!.getProviderState<ImapProviderState>(accountId, { folders: {} })
    previous.folders ??= {}
    const next: ImapProviderState = { folders: {} }
    if (!database!.getAccountHistory(accountId)) database!.resetInventory(accountId)
    const scope = offlineContext(accountId)

    for (const folder of folders) {
      await assertCanSync(accountId)
      // SEARCH SINCE marks the UIDs inside this folder's sync window (E36).
      const since = scope ? startForLocations(scope, messageLocations(imapMessageLabels(folder, new Set(['\\Seen'])))) : undefined
      const inventory = since ? await client.inventoryFolder(connection, folder, since) : await client.inventoryFolder(connection, folder)
      if (previous.folders[folder.path]?.uidValidity && previous.folders[folder.path].uidValidity !== inventory.uidValidity) {
        database!.reconcileRemoteFolder(accountId, folder.path, new Set())
      }
      const currentIds = new Set(inventory.refs.map((item) => item.id))
      const windowUids = inventory.windowUids
      database!.addInventory(accountId, inventory.refs.filter((item) => !windowUids || windowUids.has(item.uid) || database!.hasMessage(accountId, item.id)).map((item) => ({
        id: item.id,
        threadId: item.threadId,
        remoteFolderId: item.folder,
        remoteUid: String(item.uid)
      })))
      for (const item of inventory.refs) {
        if (database!.hasMessage(accountId, item.id)) database!.updateMessageLabels(accountId, item.id, item.labels, `${inventory.uidValidity}:${item.uid}`)
      }
      database!.reconcileRemoteFolder(accountId, folder.path, currentIds)
      next.folders[folder.path] = { uidValidity: inventory.uidValidity, uidNext: inventory.uidNext, highestModseq: inventory.highestModseq }
      progress(accountId, 'inventory', `Indexed ${folder.name}`)
    }

    progress(accountId, 'downloading', 'Downloading new IMAP messages')
    const folderMap = new Map(folders.map((folder) => [folder.path, folder]))
    while (true) {
      await assertCanSync(accountId)
      const pending = database!.pendingMessageIds(accountId, 10)
      if (!pending.length) break
      for (const item of pending) {
        const folder = item.remoteFolderId ? folderMap.get(item.remoteFolderId) : undefined
        const uid = Number(item.remoteUid)
        if (!folder || !Number.isSafeInteger(uid)) {
          database!.markSyncItem(accountId, item.id, 'failed', 'The IMAP message reference is invalid')
          continue
        }
        try {
          const inventory = next.folders[folder.path]
          const result = await downloadImapMessage(offlineDeps(), client, connection, accountId, folder, { id: item.id, threadId: item.threadId, uid, uidValidity: inventory.uidValidity }, scope, firstSync)
          if (result.outcome === 'stored' && result.stored.isNew) newMessages.push(result.stored.record)
        } catch (error) {
          database!.markSyncItem(accountId, item.id, 'failed', error instanceof Error ? error.message : String(error))
        }
      }
    }
    database!.setProviderState(accountId, next)
  })
  database.setAccountHistory(accountId, `imap:${Date.now()}`, true)
  progress(accountId, 'complete', 'Up to date')
  emit({ type: 'accounts-changed', payload: database.listAccounts() })
  emit({ type: 'mail-changed', payload: { accountId } })
  if (!firstSync) emitNewMail(accountId, newMessages)
}

interface MicrosoftProviderState {
  deltaLinks: Record<string, string>
  specialFolders?: Record<string, string>
  /** The sync window each folder's delta was started with (E36): an ISO date, or 'all'. */
  windowStarts?: Record<string, string>
}

async function syncMicrosoftAccount(accountId: string) {
  if (!database) throw new Error('Database is not initialized')
  const client = microsoftClientFor(accountId)
  const firstSync = !database.getAccountHistory(accountId)
  const fullAccountInventory = firstSync
  const newMessages: ParsedMailMessage[] = []
  progress(accountId, 'inventory', 'Checking Microsoft mail folders')
  const folders = await client.listFolders()
  database.replaceLabels(accountId, microsoftLabels(accountId, folders))
  const state = database.getProviderState<MicrosoftProviderState>(accountId, { deltaLinks: {} })
  state.deltaLinks ??= {}
  const currentFolderIds = new Set(folders.map((folder) => folder.id))
  for (const priorFolderId of Object.keys(state.deltaLinks)) {
    if (currentFolderIds.has(priorFolderId)) continue
    database.reconcileRemoteFolder(accountId, priorFolderId, new Set())
    delete state.deltaLinks[priorFolderId]
  }
  state.specialFolders = Object.fromEntries(folders.filter((folder) => folder.specialUse).map((folder) => [folder.specialUse!, folder.id]))
  if (!database.getAccountHistory(accountId)) database.resetInventory(accountId)
  const removed = new Set<string>()
  const active = new Set<string>()
  const scope = offlineContext(accountId)
  if (scope) state.windowStarts ??= {}
  for (const folder of folders) {
    await assertCanSync(accountId)
    // The receivedDateTime filter is fixed when a delta starts, so a widened window (E36) starts a new delta.
    const since = scope ? startForLocations(scope, messageLocations(microsoftMessageLabels(folder, { id: '', isRead: true }))) : undefined
    const windowStart = since?.toISOString() ?? 'all'
    const startedWith = state.windowStarts?.[folder.id]
    if (scope && state.deltaLinks[folder.id] && startedWith && startedWith !== 'all' && (windowStart === 'all' || windowStart < startedWith)) delete state.deltaLinks[folder.id]
    let fullFolderInventory = !state.deltaLinks[folder.id]
    let delta
    try {
      delta = since ? await client.delta(folder.id, state.deltaLinks[folder.id], since) : await client.delta(folder.id, state.deltaLinks[folder.id])
    } catch (error) {
      if (!(error instanceof MicrosoftGraphError) || error.status !== 410 || !state.deltaLinks[folder.id]) throw error
      delete state.deltaLinks[folder.id]
      fullFolderInventory = true
      delta = since ? await client.delta(folder.id, undefined, since) : await client.delta(folder.id)
    }
    if (scope && fullFolderInventory) state.windowStarts![folder.id] = windowStart
    const currentFolderMessages = new Set<string>()
    for (const message of delta.messages) {
      if (message['@removed']) {
        removed.add(message.id)
        continue
      }
      active.add(message.id)
      currentFolderMessages.add(message.id)
      const labels = microsoftMessageLabels(folder, message)
      const threadId = message.conversationId ?? message.id
      database.addInventory(accountId, [{ id: message.id, threadId, remoteFolderId: folder.id, remoteUid: message.id }])
      if (scope) {
        try {
          const result = await downloadGraphMessage(offlineDeps(), client, accountId, { message, folderId: folder.id, labels, threadId, refresh: fullAccountInventory }, scope)
          if (result.outcome === 'stored' && result.stored.isNew) newMessages.push(result.stored.record)
        } catch (error) {
          database.markSyncItem(accountId, message.id, 'failed', error instanceof Error ? error.message : String(error))
        }
        continue
      }
      if (database.hasMessage(accountId, message.id) && !fullAccountInventory) {
        database.updateMessageLabels(accountId, message.id, labels, `graph:${Date.now()}`, { remoteFolderId: folder.id, remoteUid: message.id })
        database.markSyncItem(accountId, message.id, 'complete')
        continue
      }
      try {
        const stored = await parseRawAndStore(accountId, {
          id: message.id,
          threadId,
          historyId: `graph:${Date.now()}`,
          raw: await client.messageRaw(message.id),
          labelIds: labels,
          internalDate: message.receivedDateTime ?? message.sentDateTime,
          remoteFolderId: folder.id,
          remoteUid: message.id
        })
        if (stored.isNew) newMessages.push(stored.record)
      } catch (error) {
        database.markSyncItem(accountId, message.id, 'failed', error instanceof Error ? error.message : String(error))
      }
    }
    // A windowed delta does not list older mail, which keeps its cached header rows.
    if (fullFolderInventory) database.reconcileRemoteFolder(accountId, folder.id, scope ? new Set([...currentFolderMessages, ...database.offline.idsBefore(accountId, folder.id, since)]) : currentFolderMessages)
    if (delta.deltaLink) state.deltaLinks[folder.id] = delta.deltaLink
    progress(accountId, 'downloading', `Updated ${folder.displayName}`)
  }
  for (const id of removed) if (!active.has(id)) database.deleteMessage(accountId, id)
  if (fullAccountInventory && scope) database.offline.retainOutsideWindow(accountId, earliestStart(scope))
  if (fullAccountInventory) database.reconcileInventory(accountId)
  // Content upgrades queued by a policy change (E36).
  if (scope) {
    while (true) {
      await assertCanSync(accountId)
      const pending = database.pendingMessageIds(accountId, 10)
      if (!pending.length) break
      for (const item of pending) {
        try {
          await upgradeStoredMessage(offlineDeps(), offlineClients, accountId, item.id, scope)
        } catch (error) {
          if (isAuthenticationError(error)) throw error
          database.markSyncItem(accountId, item.id, 'failed', error instanceof Error ? error.message : String(error))
        }
      }
    }
  }
  database.setProviderState(accountId, state)
  database.setAccountHistory(accountId, `graph:${Date.now()}`, true)
  progress(accountId, 'complete', 'Up to date')
  emit({ type: 'accounts-changed', payload: database.listAccounts() })
  emit({ type: 'mail-changed', payload: { accountId } })
  if (!firstSync) emitNewMail(accountId, newMessages)
}

async function syncExchangeAccount(accountId: string) {
  if (!database) throw new Error('Database is not initialized')
  const result = await syncExchangeMail({
    accountId,
    database,
    client: await exchangeClientFor(accountId),
    store: (message) => parseRawAndStore(accountId, message),
    progress: (phase, message) => progress(accountId, phase, message),
    checkpoint: () => assertCanSync(accountId)
  })
  database.setAccountHistory(accountId, `ews:${Date.now()}`, true)
  progress(accountId, 'complete', 'Up to date')
  emit({ type: 'accounts-changed', payload: database.listAccounts() })
  emit({ type: 'mail-changed', payload: { accountId } })
  if (!result.firstSync) emitNewMail(accountId, result.newRecords)
}

async function syncAccount(accountId: string, forceFull = false) {
  if (!database || syncing.has(accountId) || syncScheduled.has(accountId)) return
  // Local Folders have no server to synchronize with.
  if (database.getAccount(accountId)?.provider === 'local') return
  syncScheduled.add(accountId)
  while (syncing.size >= 2) {
    await sleep(500)
    if (!database || syncing.has(accountId)) {
      syncScheduled.delete(accountId)
      return
    }
  }
  syncScheduled.delete(accountId)
  syncing.add(accountId)
  database.setAccountStatus(accountId, 'syncing')
  emit({ type: 'accounts-changed', payload: database.listAccounts() })
  try {
    const provider = database.getAccount(accountId)?.provider
    if (database.offline) offline().expire()
    if (forceFull) database.resetInventory(accountId)
    if (provider === 'pop3') await syncPop3Account(accountId)
    else if (provider === 'microsoft') { await syncMicrosoftAccount(accountId); await mailboxOwners().syncAccount(accountId) }
    else if (provider === 'exchange') { await syncExchangeAccount(accountId); await mailboxOwners().syncAccount(accountId) }
    else if (provider && provider !== 'gmail') await syncImapAccount(accountId)
    else if (forceFull || !database.getAccountHistory(accountId)) await downloadInventory(accountId)
    else await incrementalSync(accountId)
    if (database?.offline) offline().maintain(accountId)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const current = database.getSyncProgress(accountId)[0]
    if (paused.has(accountId) && current?.pausedReason === 'disk') {
      database.setAccountStatus(accountId, 'paused', message)
      emit({ type: 'accounts-changed', payload: database.listAccounts() })
      return
    }
    const auth = isAuthenticationError(error)
    database.setAccountStatus(accountId, auth ? 'needs-auth' : 'error', message)
    progress(accountId, 'error', message)
    emit({ type: 'accounts-changed', payload: database.listAccounts() })
  } finally {
    syncing.delete(accountId)
  }
}

function labelsForAction(action: MailActionKind, labelId?: string) {
  if (action === 'archive') return { add: [], remove: ['INBOX'] }
  if (action === 'unarchive') return { add: ['INBOX'], remove: [] }
  if (action === 'read') return { add: [], remove: ['UNREAD'] }
  if (action === 'unread') return { add: ['UNREAD'], remove: [] }
  if (action === 'star') return { add: ['STARRED'], remove: [] }
  if (action === 'unstar') return { add: [], remove: ['STARRED'] }
  if (action === 'important') return { add: ['IMPORTANT'], remove: [] }
  if (action === 'unimportant') return { add: [], remove: ['IMPORTANT'] }
  if (action === 'label') return { add: labelId ? [labelId] : [], remove: [] }
  if (action === 'unlabel') return { add: [], remove: labelId ? [labelId] : [] }
  if (action === 'move') return { add: labelId ? [labelId] : [], remove: ['INBOX', 'TRASH', 'SPAM'].filter((label) => label !== labelId) }
  return { add: [], remove: [] }
}

let operationsProcessing = false

async function processOperations() {
  if (operationsProcessing) return
  operationsProcessing = true
  try {
    await runOperations()
  } finally {
    operationsProcessing = false
  }
}

function processReplyWatches(force = false) {
  if (!database || (!force && Date.now() - lastReplyWatchPassAt < REPLY_WATCH_INTERVAL_MS)) return
  lastReplyWatchPassAt = Date.now()
  try {
    for (const event of database.replyWatches.process()) emit({ type: 'reply-watch', payload: event })
  } catch {
    // A failed pass leaves watches active for the next timer tick.
  }
}

async function runOperations() {
  if (!database) return
  for (const snooze of database.releaseDueSnoozes()) {
    emit({ type: 'operation', payload: snooze.operation })
    emit({ type: 'mail-changed', payload: { accountId: snooze.accountId, threadIds: [snooze.threadId] } })
  }
  processReplyWatches()
  // Local Folders changes are already applied and need no network.
  for (const done of database.localMail?.completeDueOperations() ?? []) {
    emit({ type: 'operation', payload: { id: done.id, accountId: done.accountId, kind: done.kind as MailActionKind, status: 'succeeded' } })
  }
  if (!online) return
  for (const row of database.dueOperations()) {
    const id = String(row.id)
    const accountId = String(row.account_id)
    const kind = String(row.kind) as MailActionKind
    const threadIds = JSON.parse(String(row.thread_ids_json)) as string[]
    const labelId = row.label_id ? String(row.label_id) : undefined
    // Duplicate cleanup trashes single messages; every other operation covers whole conversations.
    const messageIds = row.message_ids_json ? JSON.parse(String(row.message_ids_json)) as string[] : undefined
    // Local Folders, POP3 folders, and local-only actions (pins) never reach a provider.
    if (mailProviderKeepsFoldersLocally(database.getAccount(accountId)?.provider) || isLocalOnlyMailAction(kind)) {
      database.updateOperation(id, 'succeeded')
      emit({ type: 'operation', payload: { id, accountId, kind, status: 'succeeded' } })
      continue
    }
    database.updateOperation(id, 'running')
    emit({ type: 'operation', payload: { id, accountId, kind, status: 'running' } })
    try {
      const provider = database.getAccount(accountId)?.provider ?? 'gmail'
      const archiveRemoval = database.archive.removalFor(row)
      // Actions on a shared mailbox or public folder go to that owner, with its rights enforced (E40).
      const ownerId = provider === 'exchange' || provider === 'microsoft' ? mailboxOwners().operationOwner(row) : PRIMARY_MAILBOX_OWNER
      if (ownerId !== PRIMARY_MAILBOX_OWNER) {
        const outcome = await mailboxOwners().runOperation(row)
        if (outcome.status !== 'succeeded') {
          emit({ type: 'operation', payload: { id, accountId, kind, status: outcome.status === 'held' ? 'queued' : 'failed', error: outcome.error } })
          emit({ type: 'mail-changed', payload: { accountId, threadIds } })
          continue
        }
      } else if (archiveRemoval) {
        // Automatic archiving removes exactly the archived messages, never whole conversations.
        await removeArchivedMessages({
          provider,
          gmail: () => clientFor(accountId),
          microsoft: () => microsoftClientFor(accountId),
          imap: () => imapClientFor(accountId),
          microsoftDeletedItems: database.getProviderState<MicrosoftProviderState>(accountId, { deltaLinks: {} }).specialFolders?.deleteditems
        }, archiveRemoval)
      } else if (provider === 'gmail') {
        const client = clientFor(accountId)
        if (messageIds && kind === 'trash') await client.trashMessages(messageIds)
        else if (messageIds && kind === 'untrash') await client.untrashMessages(messageIds)
        else if (kind === 'trash' || (kind === 'move' && labelId === 'TRASH')) await client.trashThreads(threadIds)
        else if (kind === 'untrash') await client.untrashThreads(threadIds)
        else {
          const labels = labelsForAction(kind, labelId)
          await client.modifyThreads(threadIds, labels.add, labels.remove)
        }
      } else {
        const messages = database.remoteMessagesForThreads(accountId, threadIds).filter((message) => !messageIds || messageIds.includes(message.id))
        if (provider === 'microsoft' && labelId && isMicrosoftInferenceLabel(labelId)) {
          // Inbox tab reassignment: Focused/Other is a message property, not a folder; removing the old value needs no call.
          if (kind === 'label') await microsoftClientFor(accountId).setInferenceClassification(messages.filter((message) => message.labelIds.includes('INBOX')).map((message) => message.id), labelId)
        } else if (provider === 'microsoft') {
          const state = database.getProviderState<MicrosoftProviderState>(accountId, { deltaLinks: {} })
          const special = kind === 'trash' ? 'deleteditems' : kind === 'archive' ? 'archive' : kind === 'untrash' || kind === 'unarchive' ? 'inbox' : undefined
          const destination = labelId?.startsWith('folder:') ? labelId.slice(7) : special ? state.specialFolders?.[special] : undefined
          await microsoftClientFor(accountId).applyAction(messages.map((message) => message.id), kind, destination)
        } else if (provider === 'exchange') {
          const state = database.getProviderState<Partial<ExchangeProviderState>>(accountId, {})
          await applyExchangeAction(await exchangeClientFor(accountId), state.special ?? {}, messages.flatMap((message) => message.remoteUid ? [message.remoteUid] : []), kind, labelId)
        } else {
          await (await imapClientFor(accountId)).applyAction(messages.flatMap((message) => message.remoteFolderId && message.remoteUid
            ? [{ folder: message.remoteFolderId, uid: Number(message.remoteUid) }] : []), kind, labelId)
        }
      }
      database.updateOperation(id, 'succeeded')
      emit({ type: 'operation', payload: { id, accountId, kind, status: 'succeeded' } })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const attempts = database.operationAttempts(id)
      if (attempts < 5) {
        database.rescheduleOperation(id, message, Math.min(5 * 60_000, (2 ** attempts) * 2_000))
        emit({ type: 'operation', payload: { id, accountId, kind, status: 'queued', error: message } })
      } else {
        database.restoreOperationSnapshot(id, 'failed', message)
        emit({ type: 'operation', payload: { id, accountId, kind, status: 'failed', error: message } })
        emit({ type: 'mail-changed', payload: { accountId, threadIds } })
      }
    }
  }
  archiveServiceInstance?.reconcile()
  await processQueuedDrafts()
}

function safeDraftPart(value: string) {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'file'
}

function stageDraftAttachments(input: MailDraftInput): MailDraftInput {
  const id = input.id ?? crypto.randomUUID()
  const directory = join(contentPath, 'drafts', safeDraftPart(id))
  mkdirSync(directory, { recursive: true })
  const staged = input.attachmentPaths.map((source, index) => {
    const resolvedPrefix = `${directory}${sep}`.toLowerCase()
    if (source.toLowerCase().startsWith(resolvedPrefix) && existsSync(source)) return source
    const sourceKey = createHash('sha256').update(source.toLowerCase()).digest('hex').slice(0, 10)
    const target = join(directory, `${index}-${sourceKey}-${safeDraftPart(basename(source))}`)
    if (!existsSync(target)) copyFileSync(source, target)
    return target
  })
  const keep = new Set(staged.map((path) => path.toLowerCase()))
  for (const filename of readdirSync(directory)) {
    const candidate = join(directory, filename)
    if (!keep.has(candidate.toLowerCase())) rmSync(candidate, { force: true })
  }
  return { ...input, id, attachmentPaths: staged }
}

function removeDraftFiles(id: string) {
  rmSync(join(contentPath, 'drafts', safeDraftPart(id)), { recursive: true, force: true })
}

function serializeDraft<T>(id: string, action: () => Promise<T>) {
  const prior = draftQueues.get(id)?.catch(() => undefined) ?? Promise.resolve()
  const current = prior.then(action)
  draftQueues.set(id, current)
  const cleanup = () => {
    if (draftQueues.get(id) === current) draftQueues.delete(id)
  }
  void current.then(cleanup, cleanup)
  return current
}

function draftInputFromRow(row: Record<string, string | number | bigint | null>): MailDraftInput {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    threadId: row.thread_id ? String(row.thread_id) : undefined,
    inReplyTo: row.in_reply_to ? String(row.in_reply_to) : undefined,
    references: JSON.parse(String(row.references_json)),
    to: JSON.parse(String(row.to_json)),
    cc: JSON.parse(String(row.cc_json)),
    bcc: JSON.parse(String(row.bcc_json)),
    subject: String(row.subject),
    text: String(row.body_text),
    html: row.body_html ? String(row.body_html) : undefined,
    attachmentPaths: JSON.parse(String(row.attachment_paths_json)),
    ...(row.send_options_json ? { sendOptions: JSON.parse(String(row.send_options_json)) } : {}),
    ...database!.identities.draftSender(String(row.id)),
    ...database!.openPgp.get(String(row.id)),
    ...database!.smime.get(String(row.id))
  }
}

/** Resolves the draft's From identity; strict mode (delivery) refuses unauthorized aliases. */
function senderFor(input: MailDraftInput, strict: boolean) {
  const account = database!.getAccount(input.accountId)
  if (!account) return undefined
  const identity = input.fromIdentityId ? database!.identities.get(input.fromIdentityId) : undefined
  return resolveDraftSender(account, identity, input, strict)
}

async function refreshIdentities(accountId: string) {
  const account = database!.getAccount(accountId)
  if (!account) throw new Error('Account not found')
  if (account.provider === 'gmail') return database!.identities.replaceProviderIdentities(account, 'gmail', parseGmailSendAs(await clientFor(accountId).listSendAs()))
  if (account.provider === 'microsoft') return database!.identities.replaceProviderIdentities(account, 'microsoft', parseMicrosoftProxyAddresses(await microsoftClientFor(accountId).senderAddresses(), account.email))
  database!.identities.markRefreshed(accountId)
  return database!.identities.list([account])
}

function readRawPrefix(path: string, maxBytes: number) {
  const descriptor = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(maxBytes)
    return buffer.subarray(0, readSync(descriptor, buffer, 0, maxBytes, 0))
  } finally {
    closeSync(descriptor)
  }
}

let receipts: ReturnType<typeof createReceiptService> | undefined
function receiptService() {
  if (!database) throw new Error('Database is not initialized')
  receipts ??= createReceiptService({
    database,
    readRaw: readRawPrefix,
    online: () => online,
    async sendRaw(account, raw, recipients) {
      if (account.archived) throw new Error('Connect this account before sending read receipts')
      if (account.provider === 'gmail') await clientFor(account.id).sendMessage(raw.toString('base64url'))
      else if (account.provider === 'microsoft') await microsoftClientFor(account.id).send(raw)
      else if (account.provider === 'exchange') await sendExchangeMime(await exchangeClientFor(account.id), raw)
      else await (await imapClientFor(account.id)).send(raw, recipients)
    }
  })
  return receipts
}

async function assertRemoteDraftUnchanged(accountId: string, provider: MailAccountSummary['provider'], remoteId?: string, expectedRevision?: string) {
  if (!remoteId || !expectedRevision || provider === 'imap') return
  let currentRevision: string
  try {
    currentRevision = provider === 'gmail'
      ? await clientFor(accountId).draftRevision(remoteId)
      : provider === 'exchange' ? await (await exchangeClientFor(accountId)).changeKey(remoteId)
        : await microsoftClientFor(accountId).draftRevision(remoteId)
  } catch (error) {
    if (((error instanceof GmailApiError || error instanceof MicrosoftGraphError) && error.status === 404) || (error instanceof EwsError && error.code === 'ErrorItemNotFound') || /no longer available for editing/i.test(error instanceof Error ? error.message : '')) {
      throw new DraftConflictError()
    }
    throw error
  }
  if (currentRevision !== expectedRevision) throw new DraftConflictError()
}

async function saveDraft(input: MailDraftInput) {
  if (!database) throw new Error('Database is not initialized')
  input = stageDraftAttachments(input)
  // An encrypted draft stays on this device: syncing it would store plaintext with the provider.
  // POP3 has no server Drafts folder; its drafts are kept only on this device.
  const canSync = online && !input.openPgp?.encrypt && !input.smime?.encrypt && draftRecipientsAreSyncable(input.to, input.cc, input.bcc) && database.getAccount(input.accountId)?.provider !== 'pop3'
  let result = database.saveDraft(input, { status: canSync ? 'syncing' : 'local' })
  if (!canSync) return result
  try {
    const row = database.getDraft(result.id)
    const provider = database.getAccount(input.accountId)?.provider ?? 'gmail'
    const from = senderFor(input, false)?.from
    let remoteId: string
    let remoteRevision: string | undefined
    if (provider === 'gmail') {
      if (row?.gmail_draft_id) await assertRemoteDraftUnchanged(input.accountId, provider, String(row.gmail_draft_id), row.remote_revision ? String(row.remote_revision) : undefined)
      const raw = createMime({ ...input, id: result.id }, from)
      const remote = row?.gmail_draft_id
        ? await clientFor(input.accountId).updateDraft(String(row.gmail_draft_id), raw, input.threadId)
        : await clientFor(input.accountId).createDraft(raw, input.threadId)
      remoteId = remote.id
      remoteRevision = remote.message?.id
    } else if (provider === 'microsoft') {
      if (row?.gmail_draft_id) await assertRemoteDraftUnchanged(input.accountId, provider, String(row.gmail_draft_id), row.remote_revision ? String(row.remote_revision) : undefined)
      const remote = await microsoftClientFor(input.accountId).saveDraft(createMimeBuffer({ ...input, id: result.id }, from), row?.gmail_draft_id ? String(row.gmail_draft_id) : undefined, input.sendOptions)
      remoteId = remote.id
      remoteRevision = remote.revision
    } else if (provider === 'exchange') {
      if (row?.gmail_draft_id) await assertRemoteDraftUnchanged(input.accountId, provider, String(row.gmail_draft_id), row.remote_revision ? String(row.remote_revision) : undefined)
      const remote = await saveExchangeDraft(await exchangeClientFor(input.accountId), createMimeBuffer({ ...input, id: result.id }, from), row?.gmail_draft_id ? String(row.gmail_draft_id) : undefined)
      remoteId = remote.id
      remoteRevision = remote.revision
    } else {
      remoteId = await (await imapClientFor(input.accountId)).saveDraft(createMimeBuffer({ ...input, id: result.id }, from), row?.gmail_draft_id ? String(row.gmail_draft_id) : undefined)
    }
    result = { ...result, remoteDraftId: remoteId, remoteRevision, status: 'synced', updatedAt: new Date().toISOString() }
  } catch (error) {
    result = { ...result, status: 'failed', error: error instanceof Error ? error.message : String(error), updatedAt: new Date().toISOString() }
    database.updateDraftResult(result.id, result)
    if (error instanceof DraftConflictError) throw error
    return result
  }
  database.updateDraftResult(result.id, result)
  return result
}

/**
 * Hands one built message to the provider, sending the remote draft when one
 * exists. Returns the Message-ID and provider thread of what was actually sent
 * so reply watches can match on them.
 */
async function transmitMessage(input: MailDraftInput, provider: MailAccountSummary['provider'], sender: ReturnType<typeof senderFor>, remoteDraftId?: string): Promise<{ messageIdHeader?: string; threadId?: string }> {
  const from = sender?.from
  if ((provider === 'exchange' || provider === 'microsoft') && sender?.identity?.delegation) {
    // Send as / send on behalf of a shared or delegated mailbox (E40).
    const mime = await protectOutgoing(createMimeBuffer(input, from), input, from)
    await mailboxOwners().sendDelegated(database!.getAccount(input.accountId)!, sender.identity, mime, input.sendOptions, remoteDraftId)
    return { messageIdHeader: messageIdFromMime(mime), threadId: input.threadId }
  }
  if (provider === 'gmail') {
    const raw = protectionRequested(input) ? (await protectOutgoing(createMimeBuffer(input, from), input, from)).toString('base64url') : createMime(input, from)
    const reference = remoteDraftId
      ? await clientFor(input.accountId).sendDraft(remoteDraftId, raw)
      : await clientFor(input.accountId).sendMessage(raw, input.threadId)
    return { messageIdHeader: messageIdFromMime(raw), threadId: reference?.threadId }
  }
  if (provider === 'microsoft') {
    // Exchange assigns its own Message-ID; the watch adopts it from the synced Sent copy.
    const mime = await protectOutgoing(createMimeBuffer(input, from), input, from)
    if (protectionRequested(input)) {
      // Sending the stored provider draft would send its plaintext, so send the protected MIME instead.
      const client = microsoftClientFor(input.accountId)
      await client.send(mime, undefined, input.sendOptions)
      if (remoteDraftId) await client.deleteDraft(remoteDraftId).catch(() => undefined)
    } else await microsoftClientFor(input.accountId).send(mime, remoteDraftId, input.sendOptions)
    return { threadId: input.threadId }
  }
  if (provider === 'exchange') {
    // CreateItem with SendAndSaveCopy sends the final MIME; the superseded draft is then removed.
    const client = await exchangeClientFor(input.accountId)
    const mime = await protectOutgoing(createMimeBuffer(input, from), input, from)
    await sendExchangeMime(client, mime, input.sendOptions)
    if (remoteDraftId) await client.deleteItems([remoteDraftId], 'HardDelete').catch(() => undefined)
    return { messageIdHeader: messageIdFromMime(mime), threadId: input.threadId }
  }
  const client = await imapClientFor(input.accountId)
  const recipients = [...input.to, ...input.cc, ...input.bcc]
  const mime = await protectOutgoing(createMimeBuffer(input, from, true), input, from)
  // An alias also becomes the SMTP envelope sender; the server decides whether it is allowed.
  await (sender?.identity ? client.send(mime, recipients, input.sendOptions, sender.identity.email) : client.send(mime, recipients, input.sendOptions))
  if (remoteDraftId) await client.deleteDraft(remoteDraftId)
  // POP3 has no server Sent folder, so Aerio keeps the sent copy locally. It was
  // already delivered, so a failure here must not report the send as failed.
  if (provider === 'pop3') await pop3Service().recordSent(input.accountId, mime).catch(() => undefined)
  return { messageIdHeader: messageIdFromMime(mime) }
}

async function deliverDraft(input: MailDraftInput) {
  if (!database) throw new Error('Database is not initialized')
  input = stageDraftAttachments(input)
  let result = database.saveDraft(input, { status: online ? 'syncing' : 'queued' })
  if (!online) return result
  const provider = database.getAccount(input.accountId)?.provider ?? 'gmail'
  let sender: ReturnType<typeof senderFor>
  try {
    const row = database.getDraft(result.id)
    sender = senderFor(input, true)
    // The stored draft keeps the user's choice; only what the provider can honor is sent.
    input = { ...input, sendOptions: supportedSendOptions(input.sendOptions, provider) }
    if (row?.gmail_draft_id) await assertRemoteDraftUnchanged(input.accountId, provider, String(row.gmail_draft_id), row.remote_revision ? String(row.remote_revision) : undefined)
    const sent = await transmitMessage({ ...input, id: result.id }, provider, sender, row?.gmail_draft_id ? String(row.gmail_draft_id) : undefined)
    result = { ...result, status: 'sent', updatedAt: new Date().toISOString() }
    database.replyWatches.activateForDraft(result.id, { ...sent, sentAt: result.updatedAt })
    removeDraftFiles(result.id)
  } catch (error) {
    const rejected = sender ? describeSenderRejection(error, provider, sender) : undefined
    result = { ...result, status: 'failed', error: rejected?.message ?? (error instanceof Error ? error.message : String(error)), updatedAt: new Date().toISOString() }
  }
  database.updateDraftResult(result.id, result)
  emit({ type: 'draft-delivery', payload: result })
  if (result.status === 'sent') {
    emit({ type: 'mail-changed', payload: { accountId: input.accountId } })
    void syncAccount(input.accountId)
  }
  return result
}

function queueDraftDelivery(input: MailDraftInput, deliveryAt: string, status: 'send-pending' | 'scheduled') {
  if (!database) throw new Error('Database is not initialized')
  input = stageDraftAttachments(input)
  return database.saveDraft(input, { status, deliveryAt })
}

async function discardDraft(id: string) {
  if (!database) throw new Error('Database is not initialized')
  const row = database.getDraft(id)
  if (!row) {
    removeDraftFiles(id)
    return { id, status: 'discarded' as const, updatedAt: new Date().toISOString() }
  }
  const remoteId = row.gmail_draft_id ? String(row.gmail_draft_id) : undefined
  const accountId = String(row.account_id)
  const provider = database.getAccount(accountId)?.provider ?? 'gmail'
  let result: MailDraftResult = { id, remoteDraftId: remoteId, status: 'discarding', updatedAt: new Date().toISOString() }
  database.updateDraftResult(id, result)
  try {
    if (remoteId) {
      if (provider === 'gmail') await clientFor(accountId).deleteDraft(remoteId)
      else if (provider === 'microsoft') await microsoftClientFor(accountId).deleteDraft(remoteId)
      else if (provider === 'exchange') {
        const [failure] = await (await exchangeClientFor(accountId)).deleteItems([remoteId], 'MoveToDeletedItems')
        if (failure && failure.code !== 'ErrorItemNotFound') throw failure
      } else await (await imapClientFor(accountId)).deleteDraft(remoteId)
    }
    database.deleteDraftRecord(id)
    database.replyWatches.cancelForDraft(id)
    removeDraftFiles(id)
    result = { ...result, status: 'discarded', updatedAt: new Date().toISOString() }
  } catch (error) {
    result = { ...result, status: 'failed', error: error instanceof Error ? error.message : String(error), updatedAt: new Date().toISOString() }
    database.updateDraftResult(id, result)
  }
  return result
}

async function processQueuedDrafts() {
  if (!database || !online) return
  for (const row of database.draftsToDiscard()) await serializeDraft(String(row.id), () => discardDraft(String(row.id)))
  for (const row of database.draftsToSync()) {
    const input = draftInputFromRow(row)
    if (draftRecipientsAreSyncable(input.to, input.cc, input.bcc)) await serializeDraft(String(row.id), () => saveDraft(input))
  }
  for (const row of database.queuedDrafts()) await serializeDraft(String(row.id), async () => {
    // A prior draft edit or another delivery can change this row while we wait.
    if (!database || !online) return
    const current = database.getDueDraft(String(row.id))
    if (current) await deliverDraft(draftInputFromRow(current))
  })
}

/**
 * Sends one mail merge delivery. Problems found before the provider is
 * contacted are marked as not submitted so the recipient stays queued.
 */
async function sendMergeDelivery(input: MailDraftInput) {
  let provider: MailAccountSummary['provider']
  let sender: ReturnType<typeof senderFor>
  try {
    const account = database?.getAccount(input.accountId)
    if (!account || account.archived) throw new Error('Connect this account before sending')
    if (account.status === 'needs-auth') throw new Error('Reconnect this account before sending')
    provider = account.provider
    sender = senderFor(input, true)
    input = { ...input, sendOptions: supportedSendOptions(input.sendOptions, provider) }
    const missing = input.attachmentPaths.find((path) => !existsSync(path))
    if (missing) throw new Error(`An attachment is no longer available: ${basename(missing).replace(/^\d+-/, '')}`)
    // Fails here, before submission, when the account's credentials are unavailable.
    await getCredential(input.accountId)
  } catch (error) {
    throw new MailMergeNotSubmittedError(error)
  }
  try {
    return await transmitMessage(input, provider, sender)
  } catch (error) {
    const rejected = sender ? describeSenderRejection(error, provider, sender) : undefined
    throw rejected ? new MailMergeNotSubmittedError(rejected) : error
  }
}

function mailMergeRunner() {
  if (!database) throw new Error('Database is not initialized')
  const store = database.mailMerge
  mailMergeRunnerInstance ??= new MailMergeRunner({
    store,
    online: () => online,
    send: sendMergeDelivery,
    emit: (summary) => {
      emit({ type: 'mail-merge', payload: summary })
      if (summary.status === 'completed' && summary.counts.sent > 0) {
        emit({ type: 'mail-changed', payload: { accountId: summary.accountId } })
        if (!paused.has(summary.accountId)) void syncAccount(summary.accountId)
      }
    }
  })
  return mailMergeRunnerInstance
}

function createMailMerge(input: MailMergeJobInput) {
  if (!database) throw new Error('Database is not initialized')
  const account = database.getAccount(input.accountId)
  if (!account || account.archived) throw new Error('Connect this account before starting a mail merge')
  const { recipients } = normalizeMergeRecipients(input.recipients)
  if (!recipients.length) throw new Error('Add at least one recipient with a complete email address')
  if (recipients.length > MAIL_MERGE_MAX_RECIPIENTS) throw new Error(`A mail merge can have at most ${MAIL_MERGE_MAX_RECIPIENTS.toLocaleString('en-US')} recipients`)
  // Refuse an unusable From address now rather than after the first delivery.
  senderFor({ ...input, to: [], cc: [], bcc: [] }, true)
  const id = crypto.randomUUID()
  // Attachments are copied so discarding the source draft cannot remove them mid-merge.
  const directory = join(contentPath, 'mail-merge', safeDraftPart(id))
  mkdirSync(directory, { recursive: true })
  const attachmentPaths = input.attachmentPaths.map((source, index) => {
    const target = join(directory, `${index}-${safeDraftPart(basename(source).replace(/^\d+(?:-[a-f0-9]{10})?-/, ''))}`)
    copyFileSync(source, target)
    return target
  })
  const job = database.mailMerge.create(id, { ...input, recipients, attachmentPaths, limits: clampMailMergeLimits(input.limits, account.provider, account.email) })
  emit({ type: 'mail-merge', payload: job })
  void mailMergeRunner().tick().catch(() => undefined)
  return job
}

function deleteMailMerge(id: string) {
  if (!database) throw new Error('Database is not initialized')
  database.mailMerge.delete(id)
  rmSync(join(contentPath, 'mail-merge', safeDraftPart(id)), { recursive: true, force: true })
}

/** The stored original, downloaded on demand when the offline scope (E36) kept only headers or the body. */
async function originalPath(accountId: string, messageId: string) {
  if (!database) throw new Error('Database is not initialized')
  if (database.offline) return offline().ensureRaw(accountId, messageId)
  return database.getMessageRaw(accountId, messageId)
}

async function extractAttachment(accountId: string, messageId: string, attachmentIdValue: string, targetPath: string) {
  if (!database) throw new Error('Database is not initialized')
  // Attachments listed before the original was downloaded have metadata ids; match those by name after downloading.
  const listed = database.offline ? database.getAttachment(accountId, messageId, attachmentIdValue) : undefined
  const rawPath = await originalPath(accountId, messageId)
  if (!rawPath || !database.rawExists(rawPath)) throw new Error('The original message is not available offline')
  const parsed = await PostalMime.parse(readFileSync(rawPath))
  const attachment = parsed.attachments.find((item, index) => attachmentId(item, index) === attachmentIdValue)
    ?? (listed ? parsed.attachments.find((item, index) => (item.filename || `attachment-${index + 1}`) === String(listed.filename) && (item.mimeType || 'application/octet-stream') === String(listed.mime_type)) : undefined)
  if (!attachment) throw new Error('Attachment not found')
  const content = typeof attachment.content === 'string'
    ? Buffer.from(attachment.content, attachment.encoding === 'base64' ? 'base64' : 'utf8')
    : Buffer.from(attachment.content instanceof ArrayBuffer ? new Uint8Array(attachment.content) : attachment.content)
  writeFileSync(targetPath, content)
}

/** Every attachment's bytes for one stored message, keyed like the database rows. */
async function messageAttachmentContents(accountId: string, messageId: string) {
  const rawPath = database?.getMessageRaw(accountId, messageId)
  if (!rawPath || !existsSync(rawPath)) return undefined
  const parsed = await PostalMime.parse(readFileSync(rawPath))
  return new Map(parsed.attachments.map((attachment, index) => [attachmentId(attachment, index), typeof attachment.content === 'string'
    ? Buffer.from(attachment.content, attachment.encoding === 'base64' ? 'base64' : 'utf8')
    : Buffer.from(attachment.content instanceof ArrayBuffer ? new Uint8Array(attachment.content) : attachment.content)]))
}

// Attachment text is extracted in a separate worker thread with its own heap
// limit and timeout (see mail/attachment-extract-runner.ts), then indexed for search.
function startAttachmentIndexing(store: MailDatabase['attachmentText']) {
  const workerPath = join(import.meta.dirname, 'attachment-extract-worker.js')
  if (!existsSync(workerPath)) return
  const extractor = new AttachmentExtractRunner({ workerPath })
  attachmentExtractor = extractor
  attachmentIndexer = new AttachmentContentIndexer({
    store,
    readAttachments: messageAttachmentContents,
    extract: (input, signal) => extractor.extract(input, signal)
  })
  attachmentIndexer.schedule()
}

async function stopAttachmentIndexing() {
  const indexer = attachmentIndexer
  const extractor = attachmentExtractor
  attachmentIndexer = undefined
  attachmentExtractor = undefined
  await indexer?.stop()
  await extractor?.close()
}

async function stageMessageAttachments(draftId: string, accountId: string, messageId: string) {
  if (!database) throw new Error('Database is not initialized')
  const rawPath = await originalPath(accountId, messageId)
  if (!rawPath) throw new Error('The original message is not available offline')
  const parsed = await PostalMime.parse(readFileSync(rawPath))
  const directory = join(contentPath, 'drafts', safeDraftPart(draftId))
  mkdirSync(directory, { recursive: true })
  return parsed.attachments.map((attachment, index) => {
    const name = attachment.filename || `attachment-${index + 1}`
    const path = join(directory, `${index}-${safeDraftPart(name)}`)
    const content = typeof attachment.content === 'string'
      ? Buffer.from(attachment.content, attachment.encoding === 'base64' ? 'base64' : 'utf8')
      : Buffer.from(attachment.content instanceof ArrayBuffer ? new Uint8Array(attachment.content) : attachment.content)
    writeFileSync(path, content)
    return { name, size: content.byteLength, path }
  })
}

function applyRuleActions(rule: MailRule, threadIds: string[]) {
  if (!database || !threadIds.length) return 0
  let operations = 0
  for (const action of rule.actions) {
    if (action.action === 'set-category') {
      // Classification is local metadata: no provider operation is queued.
      if (action.category && database.inboxCategories.setOverride(rule.accountId, threadIds, action.category as MailCategoryId, 'mail-rule')) operations += 1
      continue
    }
    for (let index = 0; index < threadIds.length; index += 20) {
      const batch = threadIds.slice(index, index + 20)
      try {
        const operation = database.applyLocalAction({ accountId: rule.accountId, threadIds: batch, action: action.action, labelId: action.labelId }, crypto.randomUUID(), 0)
        emit({ type: 'operation', payload: operation })
        operations += 1
      } catch {
        // A stale destination or removed thread should not stop later rules.
      }
    }
  }
  if (operations) emit({ type: 'mail-changed', payload: { accountId: rule.accountId, threadIds } })
  return operations
}

// Automatic rules for newly synced mail: incoming rules for received mail,
// outgoing rules for new Sent copies. The ledger claims each message per
// trigger before any action runs, so a resync, a folder move that gives an
// IMAP copy a new id, or an overlapping history pass never processes it twice.
// Rule actions only change labels/folders and never create messages, so a
// rule can't trigger itself or another rule.
function applyRulesToNewMail(records: ParsedMailMessage[]) {
  if (!database) return new Set<string>()
  const silenced = new Set<string>()
  const matches = new Map<string, { rule: MailRule; threadIds: Set<string> }>()
  for (const record of records) {
    for (const trigger of mailRuleTriggersForLabels(record.labelIds)) {
      if (!database.hasLocalRules(record.accountId, trigger)) continue
      if (!database.ruleLedger.claim(record.accountId, record, trigger)) continue
      for (const rule of database.matchingRulesForMessage(record, trigger)) {
        const entry = matches.get(rule.id) ?? { rule, threadIds: new Set<string>() }
        entry.threadIds.add(record.threadId)
        matches.set(rule.id, entry)
        if (trigger === 'incoming' && rule.actions.some((action) => ['archive', 'move', 'trash'].includes(action.action))) silenced.add(record.id)
      }
    }
  }
  for (const { rule, threadIds } of matches.values()) {
    const ids = [...threadIds]
    applyRuleActions(rule, ids)
    database.recordRuleMatch(rule.id, ids.length)
  }
  return silenced
}

function emitNewMail(accountId: string, records: ParsedMailMessage[]) {
  const silenced = applyRulesToNewMail(records)
  if (records.length) processReplyWatches(true)
  if (!database?.getAccount(accountId)?.notifications) return
  const payload = buildNewMailNotification(accountId, records.filter((record) => !silenced.has(record.id)))
  if (payload) emit({ type: 'new-mail', payload })
}

async function handle(command: MailWorkerCommand): Promise<MailWorkerResult> {
  if (command.type === 'initialize') {
    contentPath = command.payload.contentPath
    await stopAttachmentIndexing()
    database = new MailDatabase(command.payload.databasePath, contentPath)
    startAttachmentIndexing(database.attachmentText)
    folderManagerInstance = undefined
    importServiceInstance = undefined
    pop3ServiceInstance = undefined
    offlineCommandsInstance = undefined
    // A download cut off by a crash leaves only a temporary file; the message stays queued and downloads again (E36).
    if (database.offline) removePartialDownloads(contentPath)
    mailboxOwnerInstance = undefined
    // Imports that were queued (not running) when Aerio closed continue now;
    // interrupted ones wait for the user to resume them.
    if (database.localMail?.nextQueuedJob()) void importService().pump()
    // Re-read provider folders for any folder change cut off by a restart.
    for (const accountId of database.recoverInterruptedFolderOperations()) void folderManager().refresh(accountId).catch(() => undefined)
    // Deliveries cut off by a restart may have been sent; they wait for review instead of resending.
    database.mailMerge.recoverInterrupted()
    database.mailMerge.pruneSendLog(new Date(Date.now() - 2 * MAIL_MERGE_DAY_MS).toISOString())
    mailMergeRunnerInstance = undefined
    clearInterval(operationTimer)
    clearInterval(pollTimer)
    clearInterval(mailMergeTimer)
    mailMergeTimer = setInterval(() => void mailMergeRunner().tick().catch(() => undefined), 1_000)
    archiveServiceInstance?.halt()
    archiveServiceInstance = undefined
    clearInterval(archiveTimer)
    archiveTimer = setInterval(() => { try { archiveService().tick() } catch { /* Retried on the next pass. */ } }, ARCHIVE_SCHEDULER_INTERVAL_MS)
    try { archiveService().tick() } catch { /* Retried on the next pass. */ }
    operationTimer = setInterval(() => void processOperations(), 2_000)
    schedulePolling(BACKGROUND_MAIL_POLL_INTERVAL_MS)
    return
  }
  if (!database) throw new Error('Database is not initialized')
  if (command.type === 'accounts:list') return database.listAccounts()
  if (command.type === 'accounts:upsert') {
    database.upsertAccount(command.payload)
    attachmentIndexer?.resumeAccount(command.payload.id)
    emit({ type: 'accounts-changed', payload: database.listAccounts() })
    return command.payload
  }
  if (command.type === 'accounts:verify') {
    const account = database.getAccount(command.payload.accountId)
    if (!account) throw new Error('Account not found')
    if (account.provider === 'local') return
    if (account.provider === 'gmail') await clientFor(account.id).getProfile()
    else if (account.provider === 'microsoft') await microsoftClientFor(account.id).listFolders()
    else if (account.provider === 'pop3') {
      await pop3Service().verify(account.id)
      await (await imapClientFor(account.id)).verifySmtp()
    }
    else if (account.provider === 'exchange') await (await exchangeClientFor(account.id)).probe()
    else await (await imapClientFor(account.id)).verify()
    return
  }
  if (command.type === 'accounts:disconnect') {
    paused.add(command.payload.accountId)
    // Stop any extraction in flight for this account; its results could no longer be saved anyway.
    if (command.payload.mode === 'delete') attachmentIndexer?.cancelAccount(command.payload.accountId)
    database.disconnectAccount(command.payload.accountId, command.payload.mode)
    emit({ type: 'accounts-changed', payload: database.listAccounts() })
    return
  }
  if (command.type === 'labels:list') return database.listLabels(command.payload.accountIds)
  if (command.type === 'recipients:suggest') return database.suggestRecipients(command.payload.query, command.payload.accountIds)
  if (command.type === 'mail:list') return database.listThreads(command.payload)
  if (command.type === 'mail:unread-counts') return database.folderUnreadCounts(command.payload.accountIds)
  if (command.type === 'mail:account-unread-counts') return database.accountUnreadCounts()
  if (command.type === 'mail:thread') {
    let thread = database.getThread(command.payload.accountId, command.payload.threadId)
    // Header-only messages download when opened, or carry an offline notice (E36).
    if (database.offline) thread = await offline().annotateThread(command.payload.accountId, thread)
    thread.messages = thread.messages.map((message: MailMessageDetail) => {
      const { html, remoteContent } = sanitizeMessageHtmlWithReport(message.html, command.payload.allowRemoteImages)
      return { ...message, sanitizedHtml: html, remoteContent }
    })
    return thread
  }
  if (command.type === 'mail:export') {
    const rawPath = await originalPath(command.payload.accountId, command.payload.messageId)
    if (!rawPath) throw new Error('The original message is not available offline')
    copyFileSync(rawPath, command.payload.targetPath)
    return
  }
  if (command.type === 'mail:copy') {
    const { accountId, threadId, messageId, destination } = command.payload
    const account = database.getAccount(accountId)
    if (account?.provider === 'local') {
      // A copy between Local Folders duplicates the stored message locally.
      await transferToLocalFolders(localStoreDeps(), { sourceAccountId: accountId, threadIds: [threadId], messageIds: [messageId], destinationLabelId: destination, mode: 'copy' })
      emit({ type: 'mail-changed', payload: { accountId } })
      return
    }
    if (account?.provider === 'pop3') throw new Error('POP3 folders are kept on this computer and can’t hold a second copy of a message. Move it to another folder, or copy it to Local Folders instead.')
    if (!account || account.archived) throw new Error('Connect this account before copying messages')
    if (!online) throw new Error('Copying messages requires an internet connection')
    const target = database.listLabels([accountId]).find((label) => label.id === destination)
    if (!target) throw new Error('The destination folder no longer exists')
    const message = database.remoteMessagesForThreads(accountId, [threadId]).find((item) => item.id === messageId)
    if (!message) throw new Error('Message not found in this conversation')
    if (destination.startsWith('owner:') || [...database.mailboxOwners.ownersOfThreads(accountId, [threadId])].some((owner) => owner !== PRIMARY_MAILBOX_OWNER)) {
      throw new Error('Copying between a shared mailbox or public folder and your own mailbox is not supported. Forward the message instead.')
    }
    if (account.provider === 'gmail') {
      if (target.type !== 'user' && target.id !== 'INBOX') throw new Error('Choose Inbox or a user label as the copy destination')
      await clientFor(accountId).copyToLabel(messageId, destination)
    } else if (account.provider === 'microsoft') {
      if (!destination.startsWith('folder:')) throw new Error('Choose a mail folder')
      await microsoftClientFor(accountId).copyMessage(messageId, destination.slice(7))
    } else if (account.provider === 'exchange') {
      if (!message.remoteUid || !destination.startsWith('folder:')) throw new Error('The source or destination folder is unavailable')
      await (await exchangeClientFor(accountId)).copyItems([message.remoteUid], { id: destination.slice(7), distinguished: false })
    } else {
      if (!message.remoteFolderId || !message.remoteUid || !destination.startsWith('folder:')) throw new Error('The source or destination folder is unavailable')
      await (await imapClientFor(accountId)).copyMessage(message.remoteFolderId, Number(message.remoteUid), destination.slice(7))
    }
    if (!paused.has(accountId)) void syncAccount(accountId)
    emit({ type: 'mail-changed', payload: { accountId } })
    return
  }
  // Imported and copied mail never sends read receipts: it was read elsewhere,
  // often long ago, and Local Folders cannot send mail.
  if ((command.type === 'receipts:inspect' || command.type === 'receipts:respond') && database.getAccount(command.payload.accountId)?.provider === 'local') {
    if (command.type === 'receipts:respond') throw new Error('Messages in Local Folders do not send read receipts')
    return {}
  }
  if (command.type === 'receipts:inspect') {
    return receiptService().inspect(command.payload.accountId, command.payload.messageId, command.payload.policy)
  }
  if (command.type === 'receipts:respond') {
    return receiptService().respond(command.payload.accountId, command.payload.messageId, command.payload.decision, command.payload.policy)
  }
  if (command.type === 'invitations:source') {
    const { accountId, messageId } = command.payload
    const context = database.receiptMessageContext(accountId, messageId)
    const account = database.getAccount(accountId)
    if (!context || !account) throw new Error('Message not found')
    const parts = context.rawPath && existsSync(context.rawPath) ? await calendarPartsFromRaw(readFileSync(context.rawPath)) : []
    const aliases = parts.length ? database.identities.list(database.listAccounts(), [accountId]).map((identity) => identity.email) : []
    return {
      parts,
      account: { id: account.id, email: account.email, displayName: account.displayName, provider: account.provider, archived: account.archived },
      addresses: [...new Set([account.email, ...aliases].filter(Boolean))],
      fromEmail: context.fromEmail,
      subject: context.subject,
      messageIdHeader: context.messageIdHeader
    }
  }
  if (command.type === 'invitations:send') {
    const input = command.payload
    const account = database.getAccount(input.accountId)
    if (!account || account.archived) throw new Error('Connect this account before responding to invitations')
    if (!online) throw new Error('Connect to the internet to send your response')
    const raw = createCalendarMimeBuffer({ ...input, from: account.displayName ? `${account.displayName} <${account.email}>` : account.email })
    if (account.provider === 'gmail') await clientFor(account.id).sendMessage(raw.toString('base64url'))
    else if (account.provider === 'microsoft') await microsoftClientFor(account.id).send(raw)
    else if (account.provider === 'exchange') await sendExchangeMime(await exchangeClientFor(account.id), raw)
    else await (await imapClientFor(account.id)).send(raw, input.to)
    if (!paused.has(account.id)) void syncAccount(account.id)
    return
  }
  if (command.type === 'mail:source') {
    const rawPath = await originalPath(command.payload.accountId, command.payload.messageId)
    if (!rawPath) throw new Error('The original message is not available offline')
    return parseMessageSource(readFileSync(rawPath))
  }
  if (command.type === 'mail:action') {
    // Read-only shared folders and removed mailboxes are refused here with an explanation (E40).
    const plan = mailboxOwners().planAction(command.payload)
    const operation = database.applyLocalAction(plan.input)
    if (plan.ownerId !== PRIMARY_MAILBOX_OWNER) database.mailboxOwners.tagOperation(operation.id, plan.ownerId)
    emit({ type: 'operation', payload: operation })
    emit({ type: 'mail-changed', payload: { accountId: command.payload.accountId, threadIds: command.payload.threadIds } })
    return operation
  }
  if (command.type === 'mail:undo') {
    const undone = database.undoOperation(command.payload.operationId)
    if (undone) emit({ type: 'mail-changed', payload: { accountId: '' } })
    return undone
  }
  if (command.type === 'drafts:list') return database.listDrafts(command.payload.accountIds)
  if (command.type === 'drafts:get') return database.getDraftRecord(command.payload.id)
  if (command.type === 'drafts:save') {
    const id = command.payload.id ?? crypto.randomUUID()
    return serializeDraft(id, () => saveDraft({ ...command.payload, id }))
  }
  if (command.type === 'mail:snooze') {
    const snoozes = database.snoozeThreads(command.payload.accountId, command.payload.threadIds, command.payload.until)
    const operation = database.applyLocalAction({ accountId: command.payload.accountId, threadIds: command.payload.threadIds, action: 'archive' }, crypto.randomUUID(), 0)
    emit({ type: 'operation', payload: operation })
    emit({ type: 'mail-changed', payload: { accountId: command.payload.accountId, threadIds: command.payload.threadIds } })
    return snoozes
  }
  if (command.type === 'mail:unsnooze') {
    const changed = database.unsnoozeThreads(command.payload.accountId, command.payload.threadIds)
    if (changed) {
      const operation = database.applyLocalAction({ accountId: command.payload.accountId, threadIds: command.payload.threadIds, action: 'unarchive' }, crypto.randomUUID(), 0)
      emit({ type: 'operation', payload: operation })
      emit({ type: 'mail-changed', payload: { accountId: command.payload.accountId, threadIds: command.payload.threadIds } })
    }
    return changed
  }
  if (command.type === 'accounts:update') {
    const updated = database.updateAccountSettings(command.payload)
    if (updated.syncEnabled) {
      paused.delete(updated.id)
      if (updated.status === 'paused') database.setAccountStatus(updated.id, 'syncing')
      void syncAccount(updated.id)
    } else {
      paused.add(updated.id)
      database.setAccountStatus(updated.id, 'paused')
      progress(updated.id, 'paused', 'Automatic sync disabled for this account')
    }
    const result = database.getAccount(updated.id)!
    emit({ type: 'accounts-changed', payload: database.listAccounts() })
    return result
  }
  if (command.type === 'drafts:send') {
    const id = command.payload.id ?? crypto.randomUUID()
    const deliveryAt = new Date(Date.now() + UNDO_SEND_DELAY_MS).toISOString()
    return serializeDraft(id, async () => queueDraftDelivery({ ...command.payload, id }, deliveryAt, 'send-pending'))
  }
  if (command.type === 'drafts:schedule') {
    const id = command.payload.input.id ?? crypto.randomUUID()
    return serializeDraft(id, async () => queueDraftDelivery({ ...command.payload.input, id }, command.payload.deliveryAt, 'scheduled'))
  }
  if (command.type === 'drafts:cancel-send') {
    return serializeDraft(command.payload.id, async () => {
      const result = database!.cancelDraftDelivery(command.payload.id)
      database!.replyWatches.cancelForDraft(command.payload.id)
      return result
    })
  }
  if (command.type === 'reply-watches:list') return database.replyWatches.list(command.payload.accountIds)
  if (command.type === 'reply-watches:create') {
    const { accountId, draftId, messageId, deadlineAt } = command.payload
    const watch = draftId
      ? await serializeDraft(draftId, async () => database!.replyWatches.createForDraft(accountId, draftId, deadlineAt))
      : database.replyWatches.createForMessage(accountId, messageId!, deadlineAt)
    processReplyWatches(true)
    return database.replyWatches.get(watch.id) ?? watch
  }
  if (command.type === 'reply-watches:cancel') return database.replyWatches.cancel(command.payload.id)
  if (command.type === 'drafts:delete') {
    if (!database.getDraft(command.payload.id)) return discardDraft(command.payload.id)
    const queued = database.requestDraftDiscard(command.payload.id)
    return online ? serializeDraft(command.payload.id, () => discardDraft(command.payload.id)) : queued
  }
  if (command.type === 'drafts:stage-message-attachments') return stageMessageAttachments(command.payload.draftId, command.payload.accountId, command.payload.messageId)
  if (command.type === 'folders:delete-preview') return folderManager().preview(command.payload.accountId, command.payload.labelId)
  if (command.type.startsWith('folder-preferences:')) return handleMailFolderPreferenceCommand(database, command as MailFolderPreferenceCommand)
  if (command.type === 'folders:create' || command.type === 'folders:update' || command.type === 'folders:delete') {
    const accountId = command.payload.accountId
    const result = command.type === 'folders:create' ? await folderManager().create(command.payload)
      : command.type === 'folders:update' ? await folderManager().update(command.payload)
        : await folderManager().delete(command.payload)
    // Favorites and appearance of a folder deleted through Aerio are dropped with it.
    if (result.deletedId) database.folderPreferences.forget(accountId, [result.deletedId])
    emit({ type: 'mail-changed', payload: { accountId } })
    // Renamed IMAP folders and deleted folders' messages are re-indexed.
    const provider = database.getAccount(accountId)?.provider
    if (provider !== 'gmail' && (command.type === 'folders:delete' || Object.keys(result.renamed).length) && !paused.has(accountId)) void syncAccount(accountId)
    return result
  }
  if (isInboxCategoryCommand(command)) return handleInboxCategoryCommand(database, command, emit)
  if (isMailboxOwnerCommand(command)) return mailboxOwners().handle(command)
  if (command.type === 'rules:list') return database.listRules(command.payload.accountIds)
  if (command.type === 'rules:save') return database.saveRule(command.payload)
  if (command.type === 'rules:delete') return database.deleteRule(command.payload.id)
  if (command.type === 'rules:run') {
    const rule = database.getRule(command.payload.id)
    if (!rule) throw new Error('Rule not found')
    const threadIds = database.matchingThreadIdsForRule(rule)
    const operations = applyRuleActions(rule, threadIds)
    database.recordRuleMatch(rule.id, threadIds.length)
    return { matched: threadIds.length, operations }
  }
  if (command.type === 'identities:list') {
    const accounts = database.listAccounts()
    const selected = command.payload.accountIds?.length ? accounts.filter((account) => command.payload.accountIds!.includes(account.id)) : accounts
    // Provider aliases are discovered once automatically; later changes need an explicit refresh.
    for (const account of selected) {
      if (online && !account.archived && (account.provider === 'gmail' || account.provider === 'microsoft') && !database.identities.refreshedAt(account.id)) {
        try { await refreshIdentities(account.id) } catch { /* Discovery is best effort; manual refresh reports the error. */ }
      }
    }
    return database.identities.list(accounts, command.payload.accountIds)
  }
  if (command.type === 'identities:save') {
    const account = database.getAccount(command.payload.accountId)
    if (!account) throw new Error('Account not found')
    return database.identities.save(account, command.payload)
  }
  if (command.type === 'identities:delete') return database.identities.delete(command.payload.id)
  if (command.type === 'identities:refresh') return refreshIdentities(command.payload.accountId)
  if (command.type === 'signatures:list') return database.identities.listSignatures()
  if (command.type === 'signatures:save') return database.identities.saveSignature(command.payload)
  if (command.type === 'signatures:delete') return database.identities.deleteSignature(command.payload.id)
  if (command.type === 'merge:list') return database.mailMerge.list()
  if (command.type === 'merge:get') return database.mailMerge.get(command.payload.id)
  if (command.type === 'merge:create') return createMailMerge(command.payload)
  if (command.type === 'merge:pause' || command.type === 'merge:resume' || command.type === 'merge:cancel') {
    const store = database.mailMerge
    const summary = command.type === 'merge:pause' ? store.pause(command.payload.id) : command.type === 'merge:resume' ? store.resume(command.payload.id) : store.cancel(command.payload.id)
    emit({ type: 'mail-merge', payload: summary })
    return summary
  }
  if (command.type === 'merge:resolve') {
    const job = database.mailMerge.resolve(command.payload.id, command.payload.positions, command.payload.resolution)
    emit({ type: 'mail-merge', payload: job })
    return job
  }
  if (command.type === 'merge:delete') return deleteMailMerge(command.payload.id)
  if (command.type === 'saved-searches:list') return database.listSavedSearches()
  if (command.type === 'saved-searches:save') return database.saveSavedSearch(command.payload)
  if (command.type === 'saved-searches:delete') return database.deleteSavedSearch(command.payload.id)
  if (command.type === 'quick-actions:list') return database.listQuickActions()
  if (command.type === 'quick-actions:save') return database.saveQuickAction(command.payload)
  if (command.type === 'quick-actions:delete') return database.deleteQuickAction(command.payload.id)
  if (command.type === 'quick-actions:run') {
    const quickAction = database.getQuickAction(command.payload.id)
    if (!quickAction) throw new Error('Quick action not found')
    const { result, changed } = runMailQuickAction(database, quickAction, command.payload.targets)
    for (const operation of result.operations) emit({ type: 'operation', payload: operation })
    for (const target of changed) emit({ type: 'mail-changed', payload: target })
    return result
  }
  if (command.type === 'sync:start') {
    const accounts = command.payload.accountId
      ? database.listAccounts().filter((item) => item.id === command.payload.accountId)
      : database.listAccounts().filter((item) => !item.archived && item.provider !== 'local')
    for (const account of accounts) void syncAccount(account.id)
    return
  }
  if (command.type === 'sync:pause') {
    paused.add(command.payload.accountId)
    progress(command.payload.accountId, 'paused', 'Sync paused')
    database.setAccountStatus(command.payload.accountId, 'paused')
    return
  }
  if (command.type === 'sync:resume') {
    paused.delete(command.payload.accountId)
    database.setAccountStatus(command.payload.accountId, 'syncing')
    void syncAccount(command.payload.accountId)
    return
  }
  if (command.type === 'sync:progress') return database.getSyncProgress()
  if (command.type === 'offline:settings') return offline().settings(command.payload.accountId)
  if (command.type === 'offline:set-account-policy') return offline().setAccountPolicy(command.payload.accountId, command.payload.policy)
  if (command.type === 'offline:set-folder-override') return offline().setFolderOverride(command.payload.accountId, command.payload.labelId, command.payload.override)
  if (command.type === 'offline:extend') return offline().extend(command.payload)
  if (command.type === 'offline:availability') return offline().availability(command.payload.accountId, command.payload.labelId)
  if (command.type === 'offline:search-coverage') return offline().searchCoverage(command.payload.accountIds)
  if (command.type === 'offline:server-search') return offline().serverSearch(command.payload)
  if (command.type === 'offline:reclaim') return offline().reclaim(command.payload.accountId)
  if (command.type === 'storage:stats') {
    const stats = statfsSync(contentPath)
    return database.storageStats(Number(stats.bavail) * Number(stats.bsize))
  }
  if (command.type === 'sync:rebuild') {
    const account = database.getAccount(command.payload.accountId)
    if (!account) throw new Error('Account not found')
    if (account.provider === 'local') throw new Error('Local Folders are stored only on this computer, so there is nothing to download again')
    if (account.provider === 'pop3') throw new Error('POP3 mail lives on this computer once downloaded, and Aerio downloads each message only once, so there is nothing to rebuild')
    if (!account.syncEnabled) throw new Error('Enable synchronization for this account before rebuilding it')
    paused.delete(account.id)
    database.resetForFullSync(account.id)
    void syncAccount(account.id, true)
    return
  }
  if (command.type === 'diagnostics:health') return database.diagnosticHealth()
  if (command.type === 'attachments:list') return database.listAttachments(command.payload)
  if (command.type === 'contacts:history') return database.listContactHistory(command.payload)
  if (command.type === 'attachment:extract') {
    await extractAttachment(command.payload.accountId, command.payload.messageId, command.payload.attachmentId, command.payload.targetPath)
    return
  }
  if (command.type === 'local:ensure') {
    const existed = Boolean(database.localMail.account())
    const account = database.localMail.ensureAccount()
    if (!existed) emit({ type: 'accounts-changed', payload: database.listAccounts() })
    return account
  }
  if (command.type === 'local:transfer') {
    const result = await transferToLocalFolders(localStoreDeps(), command.payload)
    if (result.trashOperation) emit({ type: 'operation', payload: result.trashOperation })
    emit({ type: 'mail-changed', payload: { accountId: command.payload.sourceAccountId, threadIds: command.payload.threadIds } })
    const local = database.localMail.account()
    if (local) emit({ type: 'mail-changed', payload: { accountId: local.id } })
    return result
  }
  if (command.type === 'import:start') {
    const hadLocal = Boolean(database.localMail.account())
    const job = importService().start(command.payload)
    if (!hadLocal) emit({ type: 'accounts-changed', payload: database.listAccounts() })
    return job
  }
  if (command.type === 'duplicates:scan') return scanMailDuplicates(database.duplicates, database, command.payload.scopes)
  if (command.type === 'duplicates:trash') {
    const result = database.duplicates.trash(command.payload)
    if (result.operation) {
      emit({ type: 'operation', payload: result.operation })
      emit({ type: 'mail-changed', payload: { accountId: command.payload.accountId } })
    }
    return result
  }
  if (command.type === 'import:list') return importService().list()
  if (command.type === 'import:pause') return importService().pause(command.payload.id)
  if (command.type === 'import:resume') return importService().resume(command.payload.id)
  if (command.type === 'import:cancel') return importService().cancel(command.payload.id)
  if (command.type === 'import:dismiss') return importService().dismiss(command.payload.id)
  if (command.type === 'import:items') return importService().items(command.payload.jobId)
  if (command.type === 'import:resolve') return importService().resolve(command.payload.jobId, command.payload.keys, command.payload.decision)
  if (command.type === 'archive:get') return archiveService().status(command.payload.accountId)
  if (command.type === 'archive:save') return archiveService().savePolicy(command.payload)
  if (command.type === 'archive:preview') return archiveService().preview(command.payload)
  if (command.type === 'archive:run') return archiveService().runNow(command.payload.accountId)
  if (command.type === 'archive:resume') return archiveService().resume(command.payload.jobId)
  if (command.type === 'archive:cancel') return archiveService().cancel(command.payload.jobId)
  if (command.type === 'archive:items') return archiveService().items(command.payload.jobId)
  if (command.type === 'network') {
    online = command.payload.online
    emit({ type: 'connectivity', payload: { online } })
    if (online) {
      void processOperations()
      pollAccounts()
    }
    return
  }
  if (command.type === 'polling') {
    schedulePolling(command.payload.intervalMs)
    if (command.payload.immediate) pollAccounts()
    return
  }
  if (command.type === 'pop3') return pop3Service().command(command.payload)
  if (command.type === 'shutdown') {
    clearInterval(operationTimer)
    clearInterval(pollTimer)
    clearInterval(mailMergeTimer)
    clearInterval(archiveTimer)
    mailMergeRunnerInstance = undefined
    // An archive run stops at its next message and resumes on the next start.
    archiveServiceInstance?.halt()
    archiveServiceInstance = undefined
    // A running import stops at its next message; it resumes from its saved
    // cursor after the user chooses Resume on the next start.
    importServiceInstance?.halt()
    await stopAttachmentIndexing()
    database.close()
    database = undefined
    for (const { client } of exchangeClients.values()) client.close()
    exchangeClients.clear()
    folderManagerInstance = undefined
    importServiceInstance = undefined
    pop3ServiceInstance = undefined
    offlineCommandsInstance = undefined
    mailboxOwnerInstance = undefined
    return
  }
}

port.on('message', (message: WorkerRequest | WorkerCredentialResponse | WorkerOpenPgpResponse) => {
  if (message.kind === 'openpgp-response') {
    const pending = openPgpRequests.get(message.id)
    if (!pending) return
    openPgpRequests.delete(message.id)
    if (typeof message.message === 'string') pending.resolve(message.message)
    else pending.reject(new Error(message.error ?? 'The message could not be signed or encrypted. The message was not sent; your draft is kept.'))
    return
  }
  if (message.kind === 'credential-response') {
    const pending = credentialRequests.get(message.id)
    if (!pending) return
    credentialRequests.delete(message.id)
    if (message.credential) pending.resolve(message.credential)
    else pending.reject(new Error(message.error ?? 'Unable to access the account credentials'))
    return
  }
  void handle(message.command)
    .then((result) => port.postMessage({ kind: 'response', id: message.id, result } satisfies WorkerResponse))
    .catch((error) => port.postMessage({
      kind: 'response',
      id: message.id,
      error: { code: error instanceof GmailApiError ? `gmail-${error.status}` : 'worker-error', message: error instanceof Error ? error.message : String(error) }
    } satisfies WorkerResponse))
})
