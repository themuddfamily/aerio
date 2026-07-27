import { parentPort } from 'node:worker_threads'
import { readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
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
  WorkerTokenResponse
} from './mail-protocol'
import { MailDatabase, type ParsedMailMessage } from './mail/database'
import { GmailApiError, GmailClient, type GmailRawMessage } from './mail/gmail-client'
import { sanitizeMessageHtml } from './mail/message-security'

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
const tokenRequests = new Map<string, { resolve: (value: string) => void; reject: (error: Error) => void }>()
const nextRequestAt = new Map<string, number>()

const emit = (event: GmailWorkerEvent) => port.postMessage({ kind: 'event', event } satisfies WorkerEventMessage)
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

function schedulePolling(intervalMs: number) {
  clearInterval(pollTimer)
  pollTimer = setInterval(() => {
    if (!database || !online) return
    for (const account of database.listAccounts().filter((item) => !item.archived && item.status !== 'needs-auth')) void syncAccount(account.id)
  }, Math.min(Math.max(intervalMs, 60_000), 5 * 60_000))
}

async function getToken(accountId: string) {
  const id = crypto.randomUUID()
  return new Promise<string>((resolve, reject) => {
    tokenRequests.set(id, { resolve, reject })
    port.postMessage({ kind: 'token-request', id, accountId })
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
    return getToken(id)
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

async function parseAndStore(accountId: string, message: GmailRawMessage) {
  if (!database) throw new Error('Database is not initialized')
  const raw = decodeRaw(message.raw)
  const path = database.rawPath(accountId, message.id)
  const temporary = `${path}.partial`
  writeFileSync(temporary, raw)
  renameSync(temporary, path)
  const parsed = await PostalMime.parse(raw)
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
    historyId: message.historyId ?? '0',
    internalDate: new Date(Number(message.internalDate ?? Date.now())).toISOString(),
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
    labelIds: message.labelIds ?? [],
    sizeEstimate: message.sizeEstimate ?? raw.byteLength,
    rawPath: path,
    attachments
  }
  database.upsertMessage(record)
  return record
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
  if (!hasInventory || pageToken) {
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
  }

  progress(accountId, 'downloading', 'Downloading messages for offline use')
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
    for (const result of results) {
      if (result.error) database.markSyncItem(accountId, result.id, 'failed', result.error.message)
    }
    const value = database.getSyncProgress(accountId)[0]
    if (value) {
      emit({ type: 'sync-progress', payload: value })
      if (value.completed % 20 < 2) emit({ type: 'mail-changed', payload: { accountId } })
    }
  }
  database.setAccountHistory(accountId, profile.historyId, true)
  const done = progress(accountId, 'complete', 'Mailbox is available offline')
  emit({ type: 'accounts-changed', payload: database.listAccounts() })
  emit({ type: 'mail-changed', payload: { accountId } })
  return done
}

async function incrementalSync(accountId: string) {
  if (!database) throw new Error('Database is not initialized')
  const startHistoryId = database.getAccountHistory(accountId)
  if (!startHistoryId) return downloadInventory(accountId)
  const client = clientFor(accountId)
  progress(accountId, 'incremental', 'Checking for changes')
  let pageToken: string | undefined
  let latestHistoryId = startHistoryId
  try {
    do {
      await assertCanSync(accountId)
      const page = await client.listHistory(startHistoryId, pageToken)
      latestHistoryId = page.historyId ?? latestHistoryId
      for (const history of page.history ?? []) {
        latestHistoryId = history.id || latestHistoryId
        for (const deleted of history.messagesDeleted ?? []) database.deleteMessage(accountId, deleted.message.id)
        const changed = new Set<string>()
        for (const entry of history.messagesAdded ?? []) changed.add(entry.message.id)
        for (const entry of history.labelsAdded ?? []) changed.add(entry.message.id)
        for (const entry of history.labelsRemoved ?? []) changed.add(entry.message.id)
        for (const messageId of changed) {
          try {
            await parseAndStore(accountId, await client.getRawMessage(messageId))
          } catch (error) {
            if (error instanceof GmailApiError && error.status === 404) database.deleteMessage(accountId, messageId)
            else throw error
          }
        }
      }
      pageToken = page.nextPageToken
    } while (pageToken)
  } catch (error) {
    if (error instanceof GmailApiError && error.status === 404) {
      database.resetInventory(accountId)
      return downloadInventory(accountId)
    }
    throw error
  }
  database.setAccountHistory(accountId, latestHistoryId, true)
  progress(accountId, 'complete', 'Up to date')
  emit({ type: 'mail-changed', payload: { accountId } })
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
    if (forceFull || !database.getAccountHistory(accountId)) await downloadInventory(accountId)
    else await incrementalSync(accountId)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const current = database.getSyncProgress(accountId)[0]
    if (paused.has(accountId) && current?.pausedReason === 'disk') {
      database.setAccountStatus(accountId, 'paused', message)
      emit({ type: 'accounts-changed', payload: database.listAccounts() })
      return
    }
    const auth = (error instanceof GmailApiError && (error.status === 401 || error.status === 403)) ||
      /invalid_grant|connect(ed)? again|unauthori[sz]ed/i.test(message)
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
      const client = clientFor(accountId)
      if (kind === 'trash') await client.trashThreads(threadIds)
      else if (kind === 'untrash') await client.untrashThreads(threadIds)
      else {
        const labels = labelsForAction(kind, labelId)
        await client.modifyThreads(threadIds, labels.add, labels.remove)
      }
      database.updateOperation(id, 'succeeded')
      emit({ type: 'operation', payload: { id, accountId, kind, status: 'succeeded' } })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      database.updateOperation(id, 'failed', message)
      emit({ type: 'operation', payload: { id, accountId, kind, status: 'failed', error: message } })
    }
  }
  await processQueuedDrafts()
}

function encodeHeader(value: string) {
  return value.replaceAll(/[\r\n]+/g, ' ').trim()
}

function createMime(input: GmailDraftInput) {
  const boundary = `aerio-${crypto.randomUUID()}`
  const headers = [
    `To: ${input.to.map(encodeHeader).join(', ')}`,
    ...(input.cc.length ? [`Cc: ${input.cc.map(encodeHeader).join(', ')}`] : []),
    ...(input.bcc.length ? [`Bcc: ${input.bcc.map(encodeHeader).join(', ')}`] : []),
    `Subject: ${encodeHeader(input.subject)}`,
    'MIME-Version: 1.0',
    ...(input.inReplyTo ? [`In-Reply-To: ${encodeHeader(input.inReplyTo)}`] : []),
    ...(input.references?.length ? [`References: ${input.references.map(encodeHeader).join(' ')}`] : []),
    `Content-Type: multipart/mixed; boundary="${boundary}"`
  ]
  const sections = [
    `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${input.text}`
  ]
  for (const path of input.attachmentPaths) {
    const name = encodeHeader(basename(path)).replaceAll('"', '')
    const content = readFileSync(path).toString('base64').replace(/.{76}/g, '$&\r\n')
    sections.push(`--${boundary}\r\nContent-Type: application/octet-stream; name="${name}"\r\nContent-Disposition: attachment; filename="${name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${content}`)
  }
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${sections.join('\r\n')}\r\n--${boundary}--\r\n`).toString('base64url')
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
  let result = database.saveDraft(input, { status: online ? 'syncing' : 'local' })
  if (!online) return result
  try {
    const row = database.getDraft(result.id)
    const raw = createMime({ ...input, id: result.id })
    const remote = row?.gmail_draft_id
      ? await clientFor(input.accountId).updateDraft(String(row.gmail_draft_id), raw, input.threadId)
      : await clientFor(input.accountId).createDraft(raw, input.threadId)
    result = { ...result, gmailDraftId: remote.id, status: 'synced', updatedAt: new Date().toISOString() }
  } catch (error) {
    result = { ...result, status: 'failed', error: error instanceof Error ? error.message : String(error), updatedAt: new Date().toISOString() }
  }
  database.updateDraftResult(result.id, result)
  return result
}

async function sendDraft(input: GmailDraftInput) {
  if (!database) throw new Error('Database is not initialized')
  let result = database.saveDraft(input, { status: online ? 'syncing' : 'queued' })
  if (!online) return result
  try {
    const row = database.getDraft(result.id)
    const raw = createMime({ ...input, id: result.id })
    if (row?.gmail_draft_id) await clientFor(input.accountId).sendDraft(String(row.gmail_draft_id), raw)
    else await clientFor(input.accountId).sendMessage(raw, input.threadId)
    result = { ...result, status: 'sent', updatedAt: new Date().toISOString() }
  } catch (error) {
    result = { ...result, status: 'failed', error: error instanceof Error ? error.message : String(error), updatedAt: new Date().toISOString() }
  }
  database.updateDraftResult(result.id, result)
  return result
}

async function processQueuedDrafts() {
  if (!database || !online) return
  for (const row of database.draftsToSync()) await saveDraft(draftInputFromRow(row))
  for (const row of database.queuedDrafts()) await sendDraft(draftInputFromRow(row))
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

async function handle(command: MailWorkerCommand): Promise<MailWorkerResult> {
  if (command.type === 'initialize') {
    contentPath = command.payload.contentPath
    database = new MailDatabase(command.payload.databasePath, contentPath)
    clearInterval(operationTimer)
    clearInterval(pollTimer)
    operationTimer = setInterval(() => void processOperations(), 2_000)
    schedulePolling(60_000)
    return
  }
  if (!database) throw new Error('Database is not initialized')
  if (command.type === 'accounts:list') return database.listAccounts()
  if (command.type === 'accounts:upsert') {
    database.upsertAccount(command.payload)
    emit({ type: 'accounts-changed', payload: database.listAccounts() })
    return command.payload
  }
  if (command.type === 'accounts:disconnect') {
    paused.add(command.payload.accountId)
    database.disconnectAccount(command.payload.accountId, command.payload.mode)
    emit({ type: 'accounts-changed', payload: database.listAccounts() })
    return
  }
  if (command.type === 'labels:list') return database.listLabels(command.payload.accountIds)
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
  if (command.type === 'drafts:save') return saveDraft(command.payload)
  if (command.type === 'drafts:send') return sendDraft(command.payload)
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
  if (command.type === 'attachment:extract') {
    await extractAttachment(command.payload.accountId, command.payload.messageId, command.payload.attachmentId, command.payload.targetPath)
    return
  }
  if (command.type === 'network') {
    online = command.payload.online
    emit({ type: 'connectivity', payload: { online } })
    if (online) void processOperations()
    return
  }
  if (command.type === 'polling') {
    schedulePolling(command.payload.intervalMs)
    if (command.payload.intervalMs <= 60_000) {
      for (const account of database.listAccounts().filter((item) => !item.archived && item.status !== 'needs-auth')) void syncAccount(account.id)
    }
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

port.on('message', (message: WorkerRequest | WorkerTokenResponse) => {
  if (message.kind === 'token-response') {
    const pending = tokenRequests.get(message.id)
    if (!pending) return
    tokenRequests.delete(message.id)
    if (message.token) pending.resolve(message.token)
    else pending.reject(new Error(message.error ?? 'Unable to access the Gmail token'))
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
