import { parentPort } from 'node:worker_threads'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statfsSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { join, sep } from 'node:path'
import PostalMime, { type Address, type Attachment as ParsedAttachment } from 'postal-mime'
import type {
  GmailDraftInput,
  GmailDraftResult,
  GmailMessageDetail,
  GmailWorkerEvent,
  MailActionKind,
  PendingOperation,
  SyncProgress
} from '../src/gmail-types'
import type {
  MailWorkerCommand,
  MailWorkerResult,
  WorkerEventMessage,
  WorkerRequest,
  WorkerResponse,
  WorkerCredentialResponse,
  AccountCredential
} from './mail-protocol'
import { MailDatabase, type ParsedMailMessage } from './mail/database'
import { GmailApiError, GmailClient, type GmailRawMessage } from './mail/gmail-client'
import { ImapSmtpClient, labelsForImapFolders, type ImapFolder } from './mail/imap-client'
import { MicrosoftGraphClient, MicrosoftGraphError, microsoftLabels, type GraphFolder, type GraphMessage } from './mail/microsoft-client'
import { sanitizeMessageHtml } from './mail/message-security'
import { buildNewMailNotification } from './mail/new-mail'
import { createMime, createMimeBuffer } from './mail/mime-builder'
import {
  BACKGROUND_MAIL_POLL_INTERVAL_MS,
  clampMailPollingInterval,
  mailPollingIntervalForProvider
} from './mail/polling-policy'

const port = parentPort!
if (!port) throw new Error('The Aerio mail worker must run in a worker thread')

let database: MailDatabase | undefined
let contentPath = ''
let online = true
let operationTimer: NodeJS.Timeout | undefined
let pollTimer: NodeJS.Timeout | undefined
const paused = new Set<string>()
const syncing = new Set<string>()
const syncScheduled = new Set<string>()
const credentialRequests = new Map<string, { resolve: (value: AccountCredential) => void; reject: (error: Error) => void }>()
const nextRequestAt = new Map<string, number>()
const draftQueues = new Map<string, Promise<unknown>>()
const lastAutomaticSyncAt = new Map<string, number>()
let pollingIntervalMs = BACKGROUND_MAIL_POLL_INTERVAL_MS

const emit = (event: GmailWorkerEvent) => port.postMessage({ kind: 'event', event } satisfies WorkerEventMessage)
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
  if (credential.type !== 'imap') throw new Error('The IMAP account does not have server credentials')
  return new ImapSmtpClient(credential.config)
}

function microsoftClientFor(accountId: string) {
  return new MicrosoftGraphClient(async () => {
    const credential = await getCredential(accountId)
    if (credential.type !== 'oauth') throw new Error('The Microsoft account does not have OAuth credentials')
    return credential.accessToken
  })
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
}) {
  if (!database) throw new Error('Database is not initialized')
  const isNew = !database.hasMessage(accountId, message.id)
  const raw = message.raw
  const path = database.rawPath(accountId, message.id)
  const temporary = `${path}.partial`
  writeFileSync(temporary, raw)
  let parsed: Awaited<ReturnType<typeof PostalMime.parse>>
  try {
    parsed = await PostalMime.parse(raw)
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
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
    remoteUid: message.remoteUid
  }
  database.upsertMessage(record)
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
  return (error instanceof GmailApiError && (error.status === 401 || error.status === 403)) ||
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
  if (!inventoryComplete) {
    progress(accountId, 'inventory', 'Building the mailbox inventory')
    do {
      await assertCanSync(accountId)
      const page = await client.listMessages(pageToken)
      database.addInventory(accountId, page.messages ?? [])
      pageToken = page.nextPageToken
      const current = progress(accountId, 'inventory', `Indexed ${database.getSyncProgress(accountId)[0]?.total ?? 0} messages`)
      database.updateSyncProgress(current, {
        pageToken: pageToken ?? null,
        initialHistoryId: profile.historyId
      })
    } while (pageToken)
    database.reconcileInventory(accountId)
    database.completeInventory(accountId)
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
        const message = await client.getRawMessage(id)
        await parseAndStore(accountId, message)
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
  for (const message of changedMessages.values()) {
    try {
      const stored = await parseAndStore(accountId, await client.getRawMessage(message.id))
      if (stored.isNew && addedMessageIds.has(message.id)) newMessages.push(stored.record)
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
  progress(accountId, 'incremental', 'Checking for changes')
  try {
    const result = await applyGmailHistory(accountId, startHistoryId)
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
    const next: ImapProviderState = { folders: {} }
    if (!database!.getAccountHistory(accountId)) database!.resetInventory(accountId)

    for (const folder of folders) {
      await assertCanSync(accountId)
      const inventory = await client.inventoryFolder(connection, folder)
      if (previous.folders[folder.path]?.uidValidity && previous.folders[folder.path].uidValidity !== inventory.uidValidity) {
        database!.reconcileRemoteFolder(accountId, folder.path, new Set())
      }
      const currentIds = new Set(inventory.refs.map((item) => item.id))
      database!.addInventory(accountId, inventory.refs.map((item) => ({
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
          const fetched = await client.fetchRaw(connection, folder, { id: item.id, threadId: item.threadId, folder: folder.path, uid, uidValidity: inventory.uidValidity, labels: [] })
          const parsed = await PostalMime.parse(fetched.raw)
          const rootHeader = parsed.references?.split(/\s+/).filter(Boolean)[0] ?? parsed.inReplyTo ?? parsed.messageId ?? item.threadId
          const threadId = createHash('sha256').update(rootHeader).digest('base64url').slice(0, 32)
          const stored = await parseRawAndStore(accountId, {
            id: item.id,
            threadId,
            historyId: `${inventory.uidValidity}:${uid}`,
            raw: fetched.raw,
            labelIds: fetched.labels,
            internalDate: fetched.internalDate,
            sizeEstimate: fetched.size,
            remoteFolderId: folder.path,
            remoteUid: String(uid)
          })
          if (stored.isNew) newMessages.push(stored.record)
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
}

function microsoftSystemLabels(folder: GraphFolder, message: GraphMessage) {
  const value = folder.displayName.toLowerCase()
  const special = folder.specialUse
  const labels = [`folder:${folder.id}`]
  if (special === 'inbox' || value === 'inbox') labels.push('INBOX')
  if (special === 'sentitems' || value.includes('sent')) labels.push('SENT')
  if (special === 'drafts' || value.includes('draft') || message.isDraft) labels.push('DRAFT')
  if (special === 'junkemail' || value.includes('junk') || value.includes('spam')) labels.push('SPAM')
  if (special === 'deleteditems' || value.includes('deleted') || value.includes('trash')) labels.push('TRASH')
  if (special === 'archive' || value.includes('archive')) labels.push('ARCHIVE')
  if (!message.isRead) labels.push('UNREAD')
  if (message.flag?.flagStatus === 'flagged') labels.push('STARRED')
  if (message.importance === 'high') labels.push('IMPORTANT')
  return labels
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
  for (const folder of folders) {
    await assertCanSync(accountId)
    let fullFolderInventory = !state.deltaLinks[folder.id]
    let delta
    try {
      delta = await client.delta(folder.id, state.deltaLinks[folder.id])
    } catch (error) {
      if (!(error instanceof MicrosoftGraphError) || error.status !== 410 || !state.deltaLinks[folder.id]) throw error
      delete state.deltaLinks[folder.id]
      fullFolderInventory = true
      delta = await client.delta(folder.id)
    }
    const currentFolderMessages = new Set<string>()
    for (const message of delta.messages) {
      if (message['@removed']) {
        removed.add(message.id)
        continue
      }
      active.add(message.id)
      currentFolderMessages.add(message.id)
      const labels = microsoftSystemLabels(folder, message)
      const threadId = message.conversationId ?? message.id
      database.addInventory(accountId, [{ id: message.id, threadId, remoteFolderId: folder.id, remoteUid: message.id }])
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
    if (fullFolderInventory) database.reconcileRemoteFolder(accountId, folder.id, currentFolderMessages)
    if (delta.deltaLink) state.deltaLinks[folder.id] = delta.deltaLink
    progress(accountId, 'downloading', `Updated ${folder.displayName}`)
  }
  for (const id of removed) if (!active.has(id)) database.deleteMessage(accountId, id)
  if (fullAccountInventory) database.reconcileInventory(accountId)
  database.setProviderState(accountId, state)
  database.setAccountHistory(accountId, `graph:${Date.now()}`, true)
  progress(accountId, 'complete', 'Up to date')
  emit({ type: 'accounts-changed', payload: database.listAccounts() })
  emit({ type: 'mail-changed', payload: { accountId } })
  if (!firstSync) emitNewMail(accountId, newMessages)
}

async function syncAccount(accountId: string, forceFull = false) {
  if (!database || syncing.has(accountId) || syncScheduled.has(accountId)) return
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
    if (forceFull) database.resetInventory(accountId)
    if (provider === 'microsoft') await syncMicrosoftAccount(accountId)
    else if (provider && provider !== 'gmail') await syncImapAccount(accountId)
    else if (forceFull || !database.getAccountHistory(accountId)) await downloadInventory(accountId)
    else await incrementalSync(accountId)
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

async function processOperations() {
  if (!database || !online) return
  for (const row of database.dueOperations()) {
    const id = String(row.id)
    const accountId = String(row.account_id)
    const kind = String(row.kind) as MailActionKind
    const threadIds = JSON.parse(String(row.thread_ids_json)) as string[]
    const labelId = row.label_id ? String(row.label_id) : undefined
    database.updateOperation(id, 'running')
    emit({ type: 'operation', payload: { id, accountId, kind, status: 'running' } })
    try {
      const provider = database.getAccount(accountId)?.provider ?? 'gmail'
      if (provider === 'gmail') {
        const client = clientFor(accountId)
        if (kind === 'trash' || (kind === 'move' && labelId === 'TRASH')) await client.trashThreads(threadIds)
        else if (kind === 'untrash') await client.untrashThreads(threadIds)
        else {
          const labels = labelsForAction(kind, labelId)
          await client.modifyThreads(threadIds, labels.add, labels.remove)
        }
      } else {
        const messages = database.remoteMessagesForThreads(accountId, threadIds)
        if (provider === 'microsoft') {
          const state = database.getProviderState<MicrosoftProviderState>(accountId, { deltaLinks: {} })
          const special = kind === 'trash' ? 'deleteditems' : kind === 'archive' ? 'archive' : kind === 'untrash' || kind === 'unarchive' ? 'inbox' : undefined
          const destination = labelId?.startsWith('folder:') ? labelId.slice(7) : special ? state.specialFolders?.[special] : undefined
          await microsoftClientFor(accountId).applyAction(messages.map((message) => message.id), kind, destination)
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
  await processQueuedDrafts()
}

function safeDraftPart(value: string) {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'file'
}

function stageDraftAttachments(input: GmailDraftInput): GmailDraftInput {
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

function draftInputFromRow(row: Record<string, string | number | bigint | null>): GmailDraftInput {
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
    attachmentPaths: JSON.parse(String(row.attachment_paths_json))
  }
}

async function saveDraft(input: GmailDraftInput) {
  if (!database) throw new Error('Database is not initialized')
  input = stageDraftAttachments(input)
  let result = database.saveDraft(input, { status: online ? 'syncing' : 'local' })
  if (!online) return result
  try {
    const row = database.getDraft(result.id)
    const provider = database.getAccount(input.accountId)?.provider ?? 'gmail'
    const account = database.getAccount(input.accountId)
    const from = account ? `${account.displayName} <${account.email}>` : undefined
    let remoteId: string
    if (provider === 'gmail') {
      const raw = createMime({ ...input, id: result.id }, from)
      const remote = row?.gmail_draft_id
        ? await clientFor(input.accountId).updateDraft(String(row.gmail_draft_id), raw, input.threadId)
        : await clientFor(input.accountId).createDraft(raw, input.threadId)
      remoteId = remote.id
    } else if (provider === 'microsoft') {
      remoteId = await microsoftClientFor(input.accountId).saveDraft(createMimeBuffer({ ...input, id: result.id }, from), row?.gmail_draft_id ? String(row.gmail_draft_id) : undefined)
    } else {
      remoteId = await (await imapClientFor(input.accountId)).saveDraft(createMimeBuffer({ ...input, id: result.id }, from), row?.gmail_draft_id ? String(row.gmail_draft_id) : undefined)
    }
    result = { ...result, gmailDraftId: remoteId, status: 'synced', updatedAt: new Date().toISOString() }
  } catch (error) {
    result = { ...result, status: 'failed', error: error instanceof Error ? error.message : String(error), updatedAt: new Date().toISOString() }
  }
  database.updateDraftResult(result.id, result)
  return result
}

async function sendDraft(input: GmailDraftInput) {
  if (!database) throw new Error('Database is not initialized')
  input = stageDraftAttachments(input)
  let result = database.saveDraft(input, { status: online ? 'syncing' : 'queued' })
  if (!online) return result
  try {
    const row = database.getDraft(result.id)
    const provider = database.getAccount(input.accountId)?.provider ?? 'gmail'
    const account = database.getAccount(input.accountId)
    const from = account ? `${account.displayName} <${account.email}>` : undefined
    if (provider === 'gmail') {
      const raw = createMime({ ...input, id: result.id }, from)
      if (row?.gmail_draft_id) await clientFor(input.accountId).sendDraft(String(row.gmail_draft_id), raw)
      else await clientFor(input.accountId).sendMessage(raw, input.threadId)
    } else if (provider === 'microsoft') {
      await microsoftClientFor(input.accountId).send(createMimeBuffer({ ...input, id: result.id }, from), row?.gmail_draft_id ? String(row.gmail_draft_id) : undefined)
    } else {
      const client = await imapClientFor(input.accountId)
      await client.send(createMimeBuffer({ ...input, id: result.id }, from, true), [...input.to, ...input.cc, ...input.bcc])
      if (row?.gmail_draft_id) await client.deleteDraft(String(row.gmail_draft_id))
    }
    result = { ...result, status: 'sent', updatedAt: new Date().toISOString() }
    removeDraftFiles(result.id)
  } catch (error) {
    result = { ...result, status: 'failed', error: error instanceof Error ? error.message : String(error), updatedAt: new Date().toISOString() }
  }
  database.updateDraftResult(result.id, result)
  return result
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
  let result: GmailDraftResult = { id, gmailDraftId: remoteId, status: 'discarding', updatedAt: new Date().toISOString() }
  database.updateDraftResult(id, result)
  try {
    if (remoteId) {
      if (provider === 'gmail') await clientFor(accountId).deleteDraft(remoteId)
      else if (provider === 'microsoft') await microsoftClientFor(accountId).deleteDraft(remoteId)
      else await (await imapClientFor(accountId)).deleteDraft(remoteId)
    }
    database.deleteDraftRecord(id)
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
  for (const row of database.draftsToSync()) await serializeDraft(String(row.id), () => saveDraft(draftInputFromRow(row)))
  for (const row of database.queuedDrafts()) await serializeDraft(String(row.id), () => sendDraft(draftInputFromRow(row)))
}

async function extractAttachment(accountId: string, messageId: string, attachmentIdValue: string, targetPath: string) {
  if (!database) throw new Error('Database is not initialized')
  const rawPath = database.getMessageRaw(accountId, messageId)
  if (!rawPath) throw new Error('The original message is not available offline')
  const parsed = await PostalMime.parse(readFileSync(rawPath))
  const attachment = parsed.attachments.find((item, index) => attachmentId(item, index) === attachmentIdValue)
  if (!attachment) throw new Error('Attachment not found')
  const content = typeof attachment.content === 'string'
    ? Buffer.from(attachment.content, attachment.encoding === 'base64' ? 'base64' : 'utf8')
    : Buffer.from(attachment.content instanceof ArrayBuffer ? new Uint8Array(attachment.content) : attachment.content)
  writeFileSync(targetPath, content)
}

async function stageMessageAttachments(draftId: string, accountId: string, messageId: string) {
  if (!database) throw new Error('Database is not initialized')
  const rawPath = database.getMessageRaw(accountId, messageId)
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

function emitNewMail(accountId: string, records: ParsedMailMessage[]) {
  if (!database?.getAccount(accountId)?.notifications) return
  const payload = buildNewMailNotification(accountId, records)
  if (payload) emit({ type: 'new-mail', payload })
}

async function handle(command: MailWorkerCommand): Promise<MailWorkerResult> {
  if (command.type === 'initialize') {
    contentPath = command.payload.contentPath
    database = new MailDatabase(command.payload.databasePath, contentPath)
    clearInterval(operationTimer)
    clearInterval(pollTimer)
    operationTimer = setInterval(() => void processOperations(), 2_000)
    schedulePolling(BACKGROUND_MAIL_POLL_INTERVAL_MS)
    return
  }
  if (!database) throw new Error('Database is not initialized')
  if (command.type === 'accounts:list') return database.listAccounts()
  if (command.type === 'accounts:upsert') {
    database.upsertAccount(command.payload)
    emit({ type: 'accounts-changed', payload: database.listAccounts() })
    return command.payload
  }
  if (command.type === 'accounts:verify') {
    const account = database.getAccount(command.payload.accountId)
    if (!account) throw new Error('Account not found')
    if (account.provider === 'gmail') await clientFor(account.id).getProfile()
    else if (account.provider === 'microsoft') await microsoftClientFor(account.id).listFolders()
    else await (await imapClientFor(account.id)).verify()
    return
  }
  if (command.type === 'accounts:disconnect') {
    paused.add(command.payload.accountId)
    database.disconnectAccount(command.payload.accountId, command.payload.mode)
    emit({ type: 'accounts-changed', payload: database.listAccounts() })
    return
  }
  if (command.type === 'labels:list') return database.listLabels(command.payload.accountIds)
  if (command.type === 'recipients:suggest') return database.suggestRecipients(command.payload.query, command.payload.accountIds)
  if (command.type === 'mail:list') return database.listThreads(command.payload)
  if (command.type === 'mail:thread') {
    const thread = database.getThread(command.payload.accountId, command.payload.threadId)
    thread.messages = thread.messages.map((message: GmailMessageDetail) => ({
      ...message,
      sanitizedHtml: sanitizeMessageHtml(message.html, command.payload.allowRemoteImages)
    }))
    return thread
  }
  if (command.type === 'mail:action') {
    const operation = database.applyLocalAction(command.payload)
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
    return serializeDraft(id, () => sendDraft({ ...command.payload, id }))
  }
  if (command.type === 'drafts:delete') {
    if (!database.getDraft(command.payload.id)) return discardDraft(command.payload.id)
    const queued = database.requestDraftDiscard(command.payload.id)
    return online ? serializeDraft(command.payload.id, () => discardDraft(command.payload.id)) : queued
  }
  if (command.type === 'drafts:stage-message-attachments') return stageMessageAttachments(command.payload.draftId, command.payload.accountId, command.payload.messageId)
  if (command.type === 'sync:start') {
    const accounts = command.payload.accountId
      ? database.listAccounts().filter((item) => item.id === command.payload.accountId)
      : database.listAccounts().filter((item) => !item.archived)
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
  if (command.type === 'storage:stats') {
    const stats = statfsSync(contentPath)
    return database.storageStats(Number(stats.bavail) * Number(stats.bsize))
  }
  if (command.type === 'sync:rebuild') {
    const account = database.getAccount(command.payload.accountId)
    if (!account) throw new Error('Account not found')
    if (!account.syncEnabled) throw new Error('Enable synchronization for this account before rebuilding it')
    paused.delete(account.id)
    database.resetForFullSync(account.id)
    void syncAccount(account.id, true)
    return
  }
  if (command.type === 'diagnostics:health') return database.diagnosticHealth()
  if (command.type === 'attachment:extract') {
    await extractAttachment(command.payload.accountId, command.payload.messageId, command.payload.attachmentId, command.payload.targetPath)
    return
  }
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
  if (command.type === 'shutdown') {
    clearInterval(operationTimer)
    clearInterval(pollTimer)
    database.close()
    database = undefined
    return
  }
}

port.on('message', (message: WorkerRequest | WorkerCredentialResponse) => {
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
