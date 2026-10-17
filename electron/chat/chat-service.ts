import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ChatAccountPreferences, ChatAccountSummary, ChatDeviceSummary, ChatEvent, ChatGateStatus, ChatLoginFlows, ChatPasswordLoginInput,
  ChatSearchResult, ChatSnapshot, ChatTimelineItem, ChatTimelinePage, ChatVerificationState
} from '../../src/chat-types'
import { ChatCacheCipher } from './cache-crypto'
import { DEFAULT_CHAT_PREFERENCES, type ChatAccountRecord, type ChatMediaRecord, type ChatStore } from './chat-store'
import type { ChatVault } from './chat-vault'
import { discoverHomeserver, homeserverBase, logout as remoteLogout, passwordLogin, validateHomeserverUrl, whoami, type HomeserverOptions } from './homeserver'
import { assertAttachmentSize, attachmentLimit, decryptAttachment, encryptAttachment, parseMxc, sanitizeMediaName, sanitizeMime, validEncryptedFile } from './media'
import { chatNotificationFor, type ChatNotificationPlan } from './notifications'
import { ChatEncryptionFailure, ChatOutbox, ChatSendRejected, type ChatDispatcher } from './outbox'
import { projectTimeline, searchableText, type ChatOutboxRecord, type ChatStoredEvent } from './projection'
import { ChatServiceError } from './service/event-mapping'
import type { ChatServiceCommand, ChatServiceEvent, ChatServiceStart } from './service/runtime'

/**
 * Main-process Chat orchestrator. Owns the OS-wrapped vault, the encrypted
 * local store, the durable outbox and notification policy; talks to one
 * isolated chat service per account through structured commands. The
 * renderer receives only snapshots and timeline projections.
 */
export interface ChatServiceConnection {
  request<T = unknown>(command: ChatServiceCommand): Promise<T>
  onEvent(listener: (event: ChatServiceEvent) => void): void
  close(): Promise<void>
}

export interface ChatServiceFactory {
  open(account: ChatAccountRecord): Promise<ChatServiceConnection>
  /** Deletes the account's isolated service storage (its SDK crypto store). */
  purge(accountId: string): Promise<void>
  /** Whether the service stores crypto state persistently (IndexedDB) or in memory (tests). */
  persistent: boolean
}

export interface ChatServiceDependencies {
  store: ChatStore
  vault: ChatVault
  factory: ChatServiceFactory
  gate: () => ChatGateStatus
  homeserver?: HomeserverOptions
  mediaDirectory: string
  locked: () => boolean
  notificationsEnabled: () => boolean
  online: () => boolean
  notify: (plan: ChatNotificationPlan) => void
  changed: (event: ChatEvent) => void
  chooseFile: () => Promise<string | undefined>
  chooseSavePath: (name: string) => Promise<string | undefined>
  log?: (event: string, details?: Record<string, unknown>) => void
  now?: () => number
}

interface Session {
  connection: ChatServiceConnection
  ready: boolean
  startedAt: number
  serverUploadLimit?: number
  retryTimer?: ReturnType<typeof setTimeout>
  retryDelay: number
}

const MEDIA_MSGTYPES = new Set(['m.image', 'm.file', 'm.video', 'm.audio'])

export class ChatService {
  private readonly sessions = new Map<string, Session>()
  private readonly verifications = new Map<string, ChatVerificationState>()
  private readonly ciphers = new Map<string, ChatCacheCipher>()
  readonly outbox: ChatOutbox
  private retentionTimer?: ReturnType<typeof setInterval>

  constructor(private readonly deps: ChatServiceDependencies) {
    const dispatcher: ChatDispatcher = {
      send: (accountId, roomId, eventType, content, txnId) => this.serviceCall(accountId, { type: 'send', roomId, eventType, content, txnId }),
      redact: (accountId, roomId, eventId, txnId) => this.serviceCall(accountId, { type: 'redact', roomId, eventId, txnId }),
      upload: (accountId, record) => this.uploadStaged(accountId, record)
    }
    this.outbox = new ChatOutbox(deps.store, dispatcher, (accountId, roomId) => deps.changed({ type: 'timeline', accountId, roomId }))
  }

  /** Cache cipher for an account; keys come only from the OS-wrapped vault. */
  cipherFor(accountId: string) {
    let cipher = this.ciphers.get(accountId)
    if (!cipher) {
      const secrets = this.deps.vault.get(accountId)
      if (!secrets) throw new Error('This Chat account has no local keys. Remove it and sign in again')
      cipher = new ChatCacheCipher(accountId, secrets.cacheKey)
      this.ciphers.set(accountId, cipher)
    }
    return cipher
  }

  private now() { return this.deps.now?.() ?? Date.now() }

  private requireGate() {
    const gate = this.deps.gate()
    if (!gate.enabled) throw new Error(gate.message)
  }

  private requireUnlocked() {
    if (this.deps.locked()) throw new Error('Unlock Aerio to use Chat')
  }

  private requireAccount(accountId: string) {
    const account = this.deps.store.getAccount(accountId)
    if (!account) throw new Error('Chat account not found')
    return account
  }

  /** Startup: interrupted sends go to review, then each account's service starts. */
  async start() {
    const reviewed = this.outbox.recover()
    if (reviewed) this.deps.log?.('chat-outbox-review', { count: reviewed })
    if (!this.deps.gate().enabled) return
    for (const account of this.deps.store.accounts()) await this.startSession(account).catch(() => {})
    this.retentionTimer = setInterval(() => this.pruneAll(), 60 * 60_000)
    this.retentionTimer.unref?.()
    this.pruneAll()
  }

  async stop() {
    clearInterval(this.retentionTimer)
    await Promise.all([...this.sessions.keys()].map((accountId) => this.stopSession(accountId)))
  }

  private pruneAll() {
    for (const account of this.deps.store.accounts()) {
      try { this.removeFiles(this.deps.store.pruneRetention(account.id, this.now())) } catch (error) { this.deps.log?.('chat-retention-failed', { message: error instanceof Error ? error.message : String(error) }) }
    }
  }

  private removeFiles(paths: string[]) {
    for (const path of paths) if (path.startsWith(this.deps.mediaDirectory)) rmSync(path, { force: true })
  }

  // Snapshots

  private summary(account: ChatAccountRecord): ChatAccountSummary {
    return { ...account }
  }

  snapshot(): ChatSnapshot {
    const gate = this.deps.gate()
    if (this.deps.locked() || !gate.enabled) return { gate, accounts: [], rooms: [], verifications: [] }
    return {
      gate,
      accounts: this.deps.store.accounts().map((account) => this.summary(account)),
      rooms: this.deps.store.rooms(),
      verifications: [...this.verifications.values()].filter((state) => state.phase !== 'done' && state.phase !== 'cancelled')
    }
  }

  private publish() {
    this.deps.changed({ type: 'snapshot', snapshot: this.snapshot() })
  }

  /** Lock clears decrypted renderer state (via an empty snapshot) and transient verification emoji. */
  lockChanged(locked: boolean) {
    if (locked) for (const [id, state] of this.verifications) this.verifications.set(id, { ...state, emoji: undefined })
    this.publish()
    if (!locked) for (const accountId of this.sessions.keys()) this.kick(accountId)
  }

  networkChanged() {
    for (const accountId of this.sessions.keys()) this.kick(accountId)
  }

  // Accounts and sessions

  async discover(input: string): Promise<ChatLoginFlows> {
    this.requireGate()
    return discoverHomeserver(input, this.deps.homeserver)
  }

  async login(input: ChatPasswordLoginInput): Promise<ChatAccountSummary> {
    this.requireGate()
    this.requireUnlocked()
    const homeserver = homeserverBase(validateHomeserverUrl(input.homeserver, this.deps.homeserver))
    const session = await passwordLogin(homeserver, input.user, input.password, this.deps.homeserver)
    const confirmed = await whoami(homeserver, session.accessToken, this.deps.homeserver)
    if (confirmed.userId !== session.userId) {
      await remoteLogout(homeserver, session.accessToken, this.deps.homeserver).catch(() => {})
      throw new Error('The homeserver reported a different identity than it signed in. Nothing was saved')
    }
    const existing = this.deps.store.findAccount(homeserver, session.userId)
    const id = existing?.id ?? randomUUID()
    let account: ChatAccountRecord
    if (existing) {
      // Signing in again creates a new device: the old crypto store is discarded, never reused with
      // fresh keys. The local cache key is kept so retained history stays readable.
      await this.stopSession(id)
      await this.deps.factory.purge(id)
      if (this.deps.vault.has(id)) this.deps.vault.replaceDevice(id, session.accessToken, session.deviceId)
      else { this.deps.vault.create(id, session.accessToken, session.deviceId); this.ciphers.delete(id); this.removeFiles(this.deps.store.clearHistory(id)) }
      account = this.deps.store.updateAccount(id, { deviceId: session.deviceId, status: 'connecting', error: undefined, trust: 'unknown', recovery: 'unknown', securityPause: undefined })
    } else {
      this.deps.vault.create(id, session.accessToken, session.deviceId)
      account = {
        id, transport: 'matrix', homeserver, userId: session.userId, deviceId: session.deviceId, status: 'connecting', trust: 'unknown',
        recovery: 'unknown', preferences: DEFAULT_CHAT_PREFERENCES, createdAt: new Date(this.now()).toISOString()
      }
      this.deps.store.insertAccount(account)
    }
    this.deps.log?.('chat-account-connected', { accountId: id, newDevice: true })
    await this.startSession(account)
    this.publish()
    return this.summary(this.requireAccount(id))
  }

  private async startSession(account: ChatAccountRecord) {
    if (this.sessions.has(account.id)) return
    const secrets = this.deps.vault.get(account.id)
    if (!secrets?.accessToken) {
      this.deps.store.updateAccount(account.id, { status: 'needs-auth', error: 'Sign in again to resume Chat' })
      return
    }
    if (secrets.deviceId !== account.deviceId) {
      this.deps.store.updateAccount(account.id, { status: 'paused', securityPause: 'The stored keys belong to a different device. Sign in again to create a new device.' })
      return
    }
    const connection = await this.deps.factory.open(account)
    const session: Session = { connection, ready: false, startedAt: this.now(), retryDelay: 5_000 }
    this.sessions.set(account.id, session)
    connection.onEvent((event) => {
      // A failure applying one batch must never break the service's sync loop.
      try { this.handleServiceEvent(account.id, event) } catch (error) { this.deps.log?.('chat-service-event-failed', { type: event.type, message: error instanceof Error ? error.message : String(error) }) }
    })
    const config: ChatServiceStart = {
      accountId: account.id, homeserver: account.homeserver, userId: account.userId, deviceId: account.deviceId, accessToken: secrets.accessToken,
      cryptoStoreKey: new Uint8Array(secrets.cryptoStoreKey), useIndexedDB: this.deps.factory.persistent
    }
    try {
      await connection.request({ type: 'start', config })
    } catch (error) {
      const detail = error instanceof ChatServiceError ? error.detail : undefined
      this.deps.store.updateAccount(account.id, detail?.kind === 'encryption'
        ? { status: 'paused', securityPause: 'The local encrypted crypto store does not match this account. Sign in again to create a new device.' }
        : { status: 'error', error: error instanceof Error ? error.message : String(error) })
      await this.stopSession(account.id)
      this.publish()
      throw error
    }
    try { session.serverUploadLimit = await connection.request<number | undefined>({ type: 'media-config' }) } catch { /* The 25 MiB default still applies. */ }
  }

  private async stopSession(accountId: string) {
    const session = this.sessions.get(accountId)
    if (!session) return
    this.sessions.delete(accountId)
    clearTimeout(session.retryTimer)
    await session.connection.request({ type: 'stop' }).catch(() => {})
    await session.connection.close().catch(() => {})
  }

  private handleServiceEvent(accountId: string, event: ChatServiceEvent) {
    const account = this.deps.store.getAccount(accountId)
    if (!account) return
    if (event.type === 'status') {
      const session = this.sessions.get(accountId)
      if (session) session.ready = event.status === 'ready'
      this.deps.store.updateAccount(accountId, { status: event.status === 'ready' ? 'ready' : event.status, error: event.error })
      if (event.status === 'ready') this.kick(accountId)
      this.publish()
    } else if (event.type === 'batch') {
      const invited = event.batch.rooms.filter((room) => room.membership === 'invite' && this.deps.store.room(accountId, room.roomId)?.membership !== 'invite')
      const inserted = this.deps.store.applySyncBatch(accountId, event.batch)
      for (const room of invited) this.notifyInvite(account, room.roomId)
      this.recordIncomingMedia(accountId, inserted)
      this.notifyFor(account, inserted)
      for (const roomId of new Set([...event.batch.events.map((item) => item.roomId), ...event.batch.rooms.map((room) => room.roomId)])) this.deps.changed({ type: 'timeline', accountId, roomId })
      this.publish()
    } else if (event.type === 'verification') {
      this.verifications.set(`${accountId}|${event.state.requestId}`, { ...event.state, accountId })
      this.publish()
    } else if (event.type === 'security') {
      this.deps.store.updateAccount(accountId, { trust: event.trust, recovery: event.recovery, securityPause: event.pause })
      this.publish()
    }
  }

  private recordIncomingMedia(accountId: string, events: ChatStoredEvent[]) {
    for (const event of events) {
      const msgtype = event.content.msgtype
      if (event.type !== 'm.room.message' || typeof msgtype !== 'string' || !MEDIA_MSGTYPES.has(msgtype) || this.deps.store.mediaForEvent(accountId, event.eventId)) continue
      const file = event.content.file
      const url = validEncryptedFile(file) ? file.url : event.content.url
      try { parseMxc(url) } catch { continue }
      const info = (event.content.info ?? {}) as { size?: unknown; mimetype?: unknown }
      this.deps.store.insertMedia({
        id: randomUUID(), accountId, roomId: event.roomId, eventId: event.eventId, mxc: url as string, file: validEncryptedFile(file) ? file as unknown as Record<string, unknown> : undefined,
        name: sanitizeMediaName(event.content.body), mime: sanitizeMime(info.mimetype), size: typeof info.size === 'number' ? info.size : 0, encrypted: validEncryptedFile(file), state: 'remote'
      })
    }
  }

  private notifyFor(account: ChatAccountRecord, events: ChatStoredEvent[]) {
    const session = this.sessions.get(account.id)
    const notBefore = Math.max(new Date(account.createdAt).getTime(), session?.startedAt ?? 0) - 60_000
    for (const event of events) {
      const room = this.deps.store.room(account.id, event.roomId)
      const plan = chatNotificationFor(event, {
        account, room, globalEnabled: this.deps.notificationsEnabled(), locked: this.deps.locked(), notBefore,
        checkpoint: this.deps.store.notificationCheckpoint(account.id, event.roomId)
      })
      if (!plan) continue
      this.deps.store.setNotificationCheckpoint(account.id, event.roomId, event.ts, event.eventId)
      this.deps.notify(plan)
    }
  }

  /** Invitations are announced once (checkpointed), generically, and never by inviter name. */
  private notifyInvite(account: ChatAccountRecord, roomId: string) {
    if (this.deps.store.notificationCheckpoint(account.id, roomId)) return
    this.deps.store.setNotificationCheckpoint(account.id, roomId, this.now(), 'invite')
    if (!this.deps.notificationsEnabled() || account.status === 'paused' || this.deps.store.room(account.id, roomId)?.muted) return
    this.deps.notify({ accountId: account.id, roomId, eventId: '', title: 'New chat invitation', body: 'Open Aerio to review it' })
  }

  async removeAccount(accountId: string): Promise<{ remoteLogout: 'done' | 'failed' | 'skipped'; message?: string }> {
    this.requireUnlocked()
    const account = this.requireAccount(accountId)
    let remote: 'done' | 'failed' | 'skipped' = 'skipped'
    let message: string | undefined
    const token = this.deps.vault.has(accountId) ? this.deps.vault.get(accountId)?.accessToken : undefined
    await this.stopSession(accountId)
    if (token) {
      try { await remoteLogout(account.homeserver, token, this.deps.homeserver); remote = 'done' }
      catch (error) { remote = 'failed'; message = `This device may still appear on your Matrix account: ${error instanceof Error ? error.message : String(error)}. Remove it from another client.` }
    }
    this.removeFiles(this.deps.store.removeAccount(accountId))
    this.deps.vault.remove(accountId)
    this.ciphers.delete(accountId)
    await this.deps.factory.purge(accountId).catch(() => {})
    for (const key of [...this.verifications.keys()]) if (key.startsWith(`${accountId}|`)) this.verifications.delete(key)
    this.publish()
    return { remoteLogout: remote, message }
  }

  clearHistory(accountId: string) {
    this.requireUnlocked()
    this.requireAccount(accountId)
    this.removeFiles(this.deps.store.clearHistory(accountId))
    this.publish()
  }

  updatePreferences(accountId: string, patch: Partial<ChatAccountPreferences>): ChatAccountSummary {
    this.requireUnlocked()
    const current = this.requireAccount(accountId).preferences
    const retention = patch.retention ? {
      historyDays: Math.round(Math.min(Math.max(Number(patch.retention.historyDays) || current.retention.historyDays, 1), 3650)),
      mediaCacheMiB: Math.round(Math.min(Math.max(Number(patch.retention.mediaCacheMiB) || current.retention.mediaCacheMiB, 16), 10_240))
    } : current.retention
    const bool = (key: 'notificationPreviews' | 'sendWhileLocked' | 'typingNotifications' | 'readReceipts') => typeof patch[key] === 'boolean' ? patch[key] as boolean : current[key]
    const next = this.deps.store.updateAccount(accountId, { preferences: { retention, notificationPreviews: bool('notificationPreviews'), sendWhileLocked: bool('sendWhileLocked'), typingNotifications: bool('typingNotifications'), readReceipts: bool('readReceipts') } })
    this.removeFiles(this.deps.store.pruneRetention(accountId, this.now()))
    this.publish()
    return this.summary(next)
  }

  // Timeline

  timeline(accountId: string, roomId: string): ChatTimelinePage {
    this.requireUnlocked()
    const account = this.requireAccount(accountId)
    const room = this.deps.store.room(accountId, roomId)
    if (!room) throw new Error('Room not found')
    const references = this.deps.store.mediaReferences(accountId, roomId)
    const outbox = this.deps.store.outbox(accountId, roomId)
    const outboxMedia = new Map(outbox.flatMap((item) => { const reference = references.get(`outbox:${item.id}`); return reference ? [[item.id, reference] as const] : [] }))
    return {
      accountId, roomId, encrypted: room.encrypted, gapBefore: !this.deps.store.reachedStart(accountId, roomId),
      items: projectTimeline(this.deps.store.roomEvents(accountId, roomId), { ownUserId: account.userId, outbox, media: references, outboxMedia })
    }
  }

  async loadOlder(accountId: string, roomId: string): Promise<ChatTimelinePage> {
    this.requireUnlocked()
    // A failed page load leaves the gap in place: it never means the room has no earlier messages.
    await this.serviceCall(accountId, { type: 'paginate', roomId, limit: 50 })
    return this.timeline(accountId, roomId)
  }

  search(accountId: string, query: string): ChatSearchResult[] {
    this.requireUnlocked()
    this.requireAccount(accountId)
    const needle = query.trim().toLowerCase()
    if (!needle) return []
    return searchableText(this.deps.store.accountEvents(accountId)).filter((item) => item.body.toLowerCase().includes(needle)).slice(-100).reverse().map(({ event, body }) => ({
      accountId, roomId: event.roomId, eventId: event.eventId, sender: event.sender, timestamp: new Date(event.ts).toISOString(), snippet: body.length > 160 ? `${body.slice(0, 159)}…` : body
    }))
  }

  // Sending

  private writableRoom(account: ChatAccountRecord, roomId: string) {
    if (account.securityPause) throw new Error(account.securityPause)
    const room = this.deps.store.room(account.id, roomId)
    if (!room || room.membership !== 'join') throw new Error('You are not a member of this room')
    if (room.held) throw new Error(room.held)
    return room
  }

  private enqueue(account: ChatAccountRecord, roomId: string, input: Omit<Parameters<ChatOutbox['enqueue']>[0], 'accountId' | 'roomId' | 'userId' | 'deviceId'>) {
    const record = this.outbox.enqueue({ ...input, accountId: account.id, roomId, userId: account.userId, deviceId: account.deviceId })
    this.kick(account.id)
    return record
  }

  private echo(accountId: string, roomId: string, record: ChatOutboxRecord): ChatTimelineItem {
    return this.timeline(accountId, roomId).items.find((item) => item.outboxId === record.id) ?? {
      id: record.id, outboxId: record.id, sender: record.userId, timestamp: record.createdAt, kind: 'text', body: String(record.content.body ?? ''),
      edited: false, encrypted: false, reactions: [], delivery: record.state, own: true
    }
  }

  send(accountId: string, roomId: string, body: string, replyTo?: string): ChatTimelineItem {
    this.requireUnlocked()
    const account = this.requireAccount(accountId)
    this.writableRoom(account, roomId)
    if (typeof body !== 'string' || !body.trim()) throw new Error('Type a message first')
    const content: Record<string, unknown> = { msgtype: 'm.text', body }
    if (replyTo) {
      if (!this.deps.store.getEvent(accountId, replyTo)) throw new Error('The message you are replying to is not available')
      content['m.relates_to'] = { 'm.in_reply_to': { event_id: replyTo } }
    }
    const record = this.enqueue(account, roomId, { kind: 'message', eventType: 'm.room.message', content })
    return this.echo(accountId, roomId, record)
  }

  /** Resolves a timeline target to a confirmed event ID, or the outbox item it depends on. */
  private target(accountId: string, targetId: string) {
    const event = this.deps.store.getEvent(accountId, targetId)
    if (event) return { eventId: event.eventId, event }
    const queued = this.deps.store.outboxItem(targetId)
    if (queued && queued.accountId === accountId) return queued.eventId ? { eventId: queued.eventId } : { outbox: queued }
    throw new Error('That message is not available')
  }

  edit(accountId: string, roomId: string, targetId: string, body: string) {
    this.requireUnlocked()
    const account = this.requireAccount(accountId)
    this.writableRoom(account, roomId)
    if (!body.trim()) throw new Error('Type the new message text')
    const target = this.target(accountId, targetId)
    if (target.outbox?.state === 'pending') { this.outbox.editPending(target.outbox.id, { ...target.outbox.content, body }); return }
    if (target.event && (target.event.sender !== account.userId || target.event.type !== 'm.room.message')) throw new Error('You can only edit your own messages')
    const newContent = { msgtype: 'm.text', body }
    this.enqueue(account, roomId, {
      kind: 'edit', eventType: 'm.room.message', targetEventId: target.eventId, dependsOn: target.outbox?.id,
      content: { msgtype: 'm.text', body: `* ${body}`, 'm.new_content': newContent, 'm.relates_to': { rel_type: 'm.replace', ...(target.eventId ? { event_id: target.eventId } : {}) } }
    })
  }

  redact(accountId: string, roomId: string, targetId: string) {
    this.requireUnlocked()
    const account = this.requireAccount(accountId)
    const target = this.target(accountId, targetId)
    if (target.outbox && target.outbox.state !== 'running' && target.outbox.state !== 'sent') { this.outbox.cancel(target.outbox.id); return }
    this.writableRoom(account, roomId)
    this.enqueue(account, roomId, { kind: 'redaction', eventType: 'm.room.redaction', targetEventId: target.eventId, dependsOn: target.outbox?.id, content: {} })
  }

  react(accountId: string, roomId: string, targetId: string, key: string) {
    this.requireUnlocked()
    const account = this.requireAccount(accountId)
    this.writableRoom(account, roomId)
    if (!key || key.length > 64) throw new Error('Choose a reaction')
    const target = this.target(accountId, targetId)
    this.enqueue(account, roomId, {
      kind: 'reaction', eventType: 'm.reaction', targetEventId: target.eventId, dependsOn: target.outbox?.id,
      content: { 'm.relates_to': { rel_type: 'm.annotation', key, ...(target.eventId ? { event_id: target.eventId } : {}) } }
    })
  }

  cancelOutgoing(outboxId: string) {
    this.requireUnlocked()
    this.outbox.cancel(outboxId)
    this.removeOrphans(this.deps.store.outboxItem(outboxId)?.accountId)
  }

  retryOutgoing(outboxId: string) {
    this.requireUnlocked()
    const item = this.deps.store.outboxItem(outboxId)
    if (!item) throw new Error('Outgoing chat item not found')
    const account = this.requireAccount(item.accountId)
    this.outbox.retry(outboxId, { deviceId: account.deviceId })
    this.kick(account.id)
  }

  private removeOrphans(accountId?: string) {
    if (!accountId) return
    // Server-side orphan deletion is not generally supported; local staged copies are removed.
    for (const media of this.deps.store.orphanedMedia(accountId)) {
      if (media.localPath) this.removeFiles([media.localPath])
      this.deps.store.updateMedia(media.id, { localPath: undefined, state: 'orphan' })
    }
  }

  private kick(accountId: string) {
    const session = this.sessions.get(accountId)
    const account = this.deps.store.getAccount(accountId)
    if (!session || !account) return
    const canSend = session.ready && this.deps.online() && !account.securityPause && (!this.deps.locked() || account.preferences.sendWhileLocked)
    this.outbox.dispatch(accountId, { userId: account.userId, deviceId: account.deviceId, canSend }).then(() => { session.retryDelay = 5_000 }, () => {
      clearTimeout(session.retryTimer)
      session.retryTimer = setTimeout(() => this.kick(accountId), session.retryDelay)
      session.retryTimer.unref?.()
      session.retryDelay = Math.min(session.retryDelay * 2, 120_000)
    })
  }

  private async serviceCall<T>(accountId: string, command: ChatServiceCommand): Promise<T> {
    const session = this.sessions.get(accountId)
    if (!session) throw new Error('This Chat account is not connected')
    try {
      return await session.connection.request<T>(command)
    } catch (error) {
      if (!(error instanceof ChatServiceError)) throw error
      if (error.detail.kind === 'encryption') throw new ChatEncryptionFailure(error.message)
      if (error.detail.kind === 'rejected') throw new ChatSendRejected(error.message)
      if (error.detail.kind === 'auth') {
        this.deps.store.updateAccount(accountId, { status: 'needs-auth', error: error.message })
        this.publish()
      }
      throw new Error(error.message)
    }
  }

  // Attachments

  async attach(accountId: string, roomId: string): Promise<ChatTimelineItem | undefined> {
    this.requireUnlocked()
    const account = this.requireAccount(accountId)
    const room = this.writableRoom(account, roomId)
    const path = await this.deps.chooseFile()
    if (!path) return undefined
    const stats = statSync(path)
    if (!stats.isFile()) throw new Error('Choose a file to send')
    assertAttachmentSize(stats.size, this.sessions.get(accountId)?.serverUploadLimit)
    const bytes = readFileSync(path)
    // Real bytes, not the earlier stat, decide the limit.
    assertAttachmentSize(bytes.length, this.sessions.get(accountId)?.serverUploadLimit)
    const name = sanitizeMediaName(path)
    const mime = sanitizeMime(mimeFromName(name))
    mkdirSync(this.deps.mediaDirectory, { recursive: true })
    const mediaId = randomUUID()
    const localPath = join(this.deps.mediaDirectory, randomBytes(16).toString('hex'))
    let file: Record<string, unknown> | undefined
    if (room.encrypted) {
      const encrypted = await encryptAttachment(bytes)
      writeFileSync(localPath, encrypted.ciphertext)
      file = encrypted.info as unknown as Record<string, unknown>
    } else {
      writeFileSync(localPath, this.cipherFor(accountId).seal(bytes, { table: 'media-file', record: mediaId }))
    }
    const msgtype = mime.startsWith('image/') ? 'm.image' : mime.startsWith('video/') ? 'm.video' : mime.startsWith('audio/') ? 'm.audio' : 'm.file'
    // The exact staged media and its encryption metadata are recorded before dispatch can start.
    const record = this.outbox.enqueue({ accountId, roomId, userId: account.userId, deviceId: account.deviceId, kind: 'media', eventType: 'm.room.message', mediaId, content: { msgtype, body: name, info: { size: bytes.length, mimetype: mime } } })
    this.deps.store.insertMedia({ id: mediaId, accountId, roomId, outboxId: record.id, name, mime, size: bytes.length, encrypted: room.encrypted, localPath, file, state: 'staged' })
    this.kick(accountId)
    return this.echo(accountId, roomId, record)
  }

  private localMediaBytes(media: ChatMediaRecord) {
    if (!media.localPath) throw new Error('This attachment is no longer stored on this device')
    const stored = readFileSync(media.localPath)
    return media.encrypted ? new Uint8Array(stored) : this.cipherFor(media.accountId).openBuffer(stored.toString(), { table: 'media-file', record: media.id })
  }

  private async uploadStaged(accountId: string, record: ChatOutboxRecord) {
    const media = record.mediaId ? this.deps.store.media(record.mediaId) : undefined
    if (!media || media.accountId !== accountId) throw new ChatSendRejected('The attachment for this message is missing')
    if (!media.mxc) {
      const mxc = await this.serviceCall<string>(accountId, { type: 'upload', bytes: this.localMediaBytes(media), mime: media.encrypted ? 'application/octet-stream' : media.mime })
      parseMxc(mxc)
      this.deps.store.updateMedia(media.id, { mxc, state: 'uploaded' })
      media.mxc = mxc
    }
    return media.encrypted ? { file: { ...media.file, url: media.mxc } } : { url: media.mxc }
  }

  async saveMedia(accountId: string, mediaId: string): Promise<boolean> {
    this.requireUnlocked()
    const media = this.deps.store.media(mediaId)
    if (!media || media.accountId !== accountId) throw new Error('Attachment not found')
    let ciphertext: Uint8Array
    if (media.localPath && media.encrypted) ciphertext = new Uint8Array(readFileSync(media.localPath))
    else if (media.localPath) ciphertext = this.localMediaBytes(media)
    else {
      if (!media.mxc) throw new Error('This attachment is not available')
      // Only the connector-validated mxc from the stored event is fetched; never a URL from the renderer.
      ciphertext = await this.serviceCall<Uint8Array>(accountId, { type: 'download', mxc: media.mxc, limit: attachmentLimit(this.sessions.get(accountId)?.serverUploadLimit) + 1024 })
      mkdirSync(this.deps.mediaDirectory, { recursive: true })
      const localPath = join(this.deps.mediaDirectory, randomBytes(16).toString('hex'))
      writeFileSync(localPath, media.encrypted ? ciphertext : this.cipherFor(accountId).seal(Buffer.from(ciphertext), { table: 'media-file', record: media.id }))
      this.deps.store.updateMedia(media.id, { localPath, state: 'cached', size: media.size || ciphertext.length })
    }
    const plaintext = media.encrypted ? await decryptAttachment(ciphertext, media.file) : ciphertext
    const destination = await this.deps.chooseSavePath(media.name)
    if (!destination) return false
    // Saved only to a user-chosen path; never opened or executed automatically.
    writeFileSync(destination, plaintext)
    return true
  }

  // Rooms

  async markRead(accountId: string, roomId: string) {
    this.requireUnlocked()
    const account = this.requireAccount(accountId)
    const events = this.deps.store.roomEvents(accountId, roomId, 1)
    const last = events[events.length - 1]
    this.deps.store.setRoomFlags(accountId, roomId, { readTs: last?.ts ?? this.now() })
    if (last && account.preferences.readReceipts) await this.serviceCall(accountId, { type: 'read', roomId, eventId: last.eventId }).catch(() => {})
    this.publish()
  }

  async roomAction(accountId: string, roomId: string, action: 'accept' | 'decline' | 'leave' | 'mute' | 'unmute' | 'allow-previews' | 'block-previews' | 'release-hold') {
    this.requireUnlocked()
    this.requireAccount(accountId)
    if (!this.deps.store.room(accountId, roomId)) throw new Error('Room not found')
    if (action === 'accept' || action === 'decline' || action === 'leave') await this.serviceCall(accountId, { type: 'room', roomId, action })
    else if (action === 'mute' || action === 'unmute') this.deps.store.setRoomFlags(accountId, roomId, { muted: action === 'mute' })
    else if (action === 'allow-previews' || action === 'block-previews') this.deps.store.setRoomFlags(accountId, roomId, { previews: action === 'allow-previews' })
    else {
      this.deps.store.setRoomFlags(accountId, roomId, { held: null })
      this.kick(accountId)
    }
    this.publish()
  }

  // Devices, verification and recovery

  devices(accountId: string) {
    this.requireUnlocked()
    return this.serviceCall<ChatDeviceSummary[]>(accountId, { type: 'devices' })
  }

  async verifyOwnDevice(accountId: string) {
    this.requireUnlocked()
    const state = await this.serviceCall<ChatVerificationState>(accountId, { type: 'verify-own' })
    this.verifications.set(`${accountId}|${state.requestId}`, { ...state, accountId })
    this.publish()
    return { ...state, accountId }
  }

  async verificationAction(accountId: string, requestId: string, action: 'accept' | 'start-sas' | 'confirm' | 'mismatch' | 'cancel') {
    this.requireUnlocked()
    await this.serviceCall(accountId, { type: 'verification', requestId, action })
  }

  async restoreFromRecoveryKey(accountId: string, recoveryKey: string) {
    this.requireUnlocked()
    if (typeof recoveryKey !== 'string' || recoveryKey.length > 200) throw new Error('That recovery key is not valid')
    // Reports how many backed-up room keys were imported; it never promises that every message decrypts.
    return this.serviceCall<{ imported: number; total: number }>(accountId, { type: 'recovery-key', key: recoveryKey })
  }

  async setupRecovery(accountId: string) {
    this.requireUnlocked()
    return this.serviceCall<{ recoveryKey?: string; backupComplete?: boolean }>(accountId, { type: 'setup-recovery' })
  }
}

function mimeFromName(name: string) {
  const extension = name.toLowerCase().split('.').pop() ?? ''
  const types: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf', txt: 'text/plain',
    mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', ogg: 'audio/ogg', zip: 'application/zip', csv: 'text/csv', json: 'application/json'
  }
  return types[extension] ?? 'application/octet-stream'
}
