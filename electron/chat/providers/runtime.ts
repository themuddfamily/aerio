import { randomUUID } from 'node:crypto'
import type { ProviderChatAccount, ProviderChatEvent, ProviderChatId, ProviderChatMessage, ProviderChatPage, ProviderChatSnapshot } from '../../../src/provider-chat-types'
import { ChatCacheCipher } from '../cache-crypto'
import type { ChatVault } from '../chat-vault'
import { ProviderChatError, type ProviderChatAdapter, type ProviderChatSession } from './adapter'
import { ProviderChatStore } from './store'

export interface ProviderChatRuntimeOptions {
  path: string; vault: ChatVault; adapters: ProviderChatAdapter[]
  assertSecure(): void; locked(): boolean; online(): boolean; notificationsEnabled(): boolean
  changed(event: ProviderChatEvent): void
  notify(title: string, body: string, accountId: string, roomId: string): void
}
export class ProviderChatRuntime {
  readonly store: ProviderChatStore
  private readonly adapters = new Map<ProviderChatId, ProviderChatAdapter>()
  private readonly refreshing = new Map<string, Promise<void>>()
  private readonly epochs = new Map<string, number>()
  private timer?: ReturnType<typeof setInterval>
  private closed = false
  constructor(private readonly options: ProviderChatRuntimeOptions) {
    for (const adapter of options.adapters) this.adapters.set(adapter.descriptor().id, adapter)
    this.store = new ProviderChatStore(options.path, (id) => {
      const secret = options.vault.get(id)
      if (!secret) throw new Error('This Chat account is missing its local encryption key. Remove it and reconnect.')
      return new ChatCacheCipher(id, secret.cacheKey)
    })
  }
  private guard() { if (this.closed) throw new Error('Chat is closed'); this.options.assertSecure(); if (this.options.locked()) throw new Error('Unlock Aerio to use Chat') }
  snapshot(): ProviderChatSnapshot {
    const providers = [...this.adapters.values()].map((adapter) => adapter.descriptor())
    try { this.options.assertSecure() } catch (error) { return { available: false, detail: error instanceof Error ? error.message : 'Secure credential storage is unavailable', providers, accounts: [], rooms: [] } }
    if (this.options.locked()) return { available: true, detail: 'Unlock Aerio to use Chat', providers, accounts: [], rooms: [] }
    try { return { available: true, providers, accounts: this.store.accounts(), rooms: this.store.rooms() } }
    catch (error) { return { available: true, detail: error instanceof Error ? error.message : 'Chat cache could not be opened', providers, accounts: [], rooms: [] } }
  }
  broadcast() { if (!this.closed) this.options.changed({ type: 'snapshot', snapshot: this.snapshot() }) }
  start() {
    this.timer = setInterval(() => { void this.refreshAll() }, 30_000); this.timer.unref?.()
    void this.refreshAll()
  }
  async refreshAll() {
    if (this.closed || this.options.locked() || !this.options.online() || !this.snapshot().available) return
    for (const account of this.snapshot().accounts) if (!account.retryAt || Date.parse(account.retryAt) <= Date.now()) await this.refresh(account.id).catch(() => {})
  }
  private session(id: string): ProviderChatSession {
    const account = this.store.account(id)
    const secrets = this.options.vault.get(id)
    if (!account || !secrets) throw new Error('Chat account not found')
    return { account, secret: JSON.parse(secrets.accessToken) }
  }
  private adapter(session: ProviderChatSession) { const adapter = this.adapters.get(session.account.provider); if (!adapter) throw new Error('Chat provider is unavailable'); return adapter }
  private active(id: string, epoch: number) {
    if (this.closed || (this.epochs.get(id) ?? 0) !== epoch || !this.store.account(id)) throw new Error('This Chat connection changed while the request was running')
  }
  private networkReady(session: ProviderChatSession) {
    if (!this.options.online()) throw new ProviderChatError('Offline — cached Chat history is available', 'network')
    const retryAt = Date.parse(session.account.retryAt ?? '')
    if (retryAt > Date.now()) throw new ProviderChatError(`The provider requested a pause. Try again after ${new Date(retryAt).toLocaleTimeString()}.`, 'rate-limit', Math.ceil((retryAt - Date.now()) / 1000))
  }
  private failure(account: ProviderChatAccount, error: unknown, epoch: number) {
    if (this.closed || (this.epochs.get(account.id) ?? 0) !== epoch) return
    const current = this.store.account(account.id)
    if (!current) return
    const retryAt = error instanceof ProviderChatError && error.kind === 'rate-limit' ? (Date.parse(current.retryAt ?? '') > Date.now() ? current.retryAt : new Date(Date.now() + Math.max(1, Math.min(error.retryAfter ?? 60, 86_400)) * 1000).toISOString()) : current.retryAt
    this.store.saveAccount({ ...current, retryAt, status: error instanceof ProviderChatError && error.kind === 'auth' ? 'needs-auth' : !this.options.online() ? 'offline' : 'error', error: error instanceof Error ? error.message : 'Chat provider failed' }); this.broadcast()
  }
  async connect(provider: ProviderChatId, input: Record<string, string | boolean>, id?: string) {
    this.guard(); if (!this.options.online()) throw new Error('Connect to the internet before signing in')
    const adapter = this.adapters.get(provider)
    if (!adapter?.descriptor().available) throw new Error(adapter?.descriptor().detail ?? 'Chat provider is unavailable')
    const existing = id ? this.session(id) : undefined
    const epoch = id ? this.epochs.get(id) ?? 0 : 0
    if (existing && existing.account.provider !== provider) throw new Error('Chat account provider mismatch')
    const connection = await adapter.connect(input, existing)
    this.guard()
    if (id) this.active(id, epoch)
    if (existing && existing.account.remoteUserId !== connection.remoteUserId) throw new Error('Reconnect with the same Chat identity')
    const duplicate = this.store.accounts().find((account) => account.provider === provider && account.remoteUserId === connection.remoteUserId)
    const accountId = id ?? duplicate?.id ?? randomUUID()
    this.epochs.set(accountId, (this.epochs.get(accountId) ?? 0) + 1)
    this.refreshing.delete(accountId)
    const account: ProviderChatAccount = { id: accountId, provider, remoteUserId: connection.remoteUserId, name: connection.name, status: 'ready', notificationPreviews: existing?.account.notificationPreviews ?? duplicate?.notificationPreviews ?? false }
    if (this.options.vault.has(accountId)) this.options.vault.updateToken(accountId, JSON.stringify(connection.secret))
    else this.options.vault.create(accountId, JSON.stringify(connection.secret), provider)
    this.store.saveAccount(account); this.broadcast()
    await this.refresh(accountId)
    return account
  }
  async remove(id: string) {
    this.guard(); const session = this.session(id)
    this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1)
    this.refreshing.delete(id)
    this.store.remove(id); this.options.vault.remove(id); this.broadcast()
    await this.adapter(session).disconnect?.(session)
  }
  async preferences(id: string, previews: boolean) { this.guard(); const { account } = this.session(id); this.store.saveAccount({ ...account, notificationPreviews: previews }); this.broadcast() }
  async refresh(id: string): Promise<void> {
    this.guard(); if (!this.options.online()) throw new Error('Offline — cached Chat history is available')
    const pending = this.refreshing.get(id); if (pending) return pending
    const session = this.session(id), previous = this.store.rooms(id), epoch = this.epochs.get(id) ?? 0
    this.networkReady(session)
    const refresh = async () => {
      try {
        const rooms = await this.adapter(session).rooms(session); this.guard(); this.active(id, epoch)
        if (rooms.length > 10_000 || rooms.some((room) => room.accountId !== id || !room.id || !room.name)) throw new Error('Chat provider returned invalid rooms')
        this.store.saveRooms(id, rooms); this.store.saveAccount({ ...this.store.account(id)!, status: 'ready', error: undefined, retryAt: undefined })
        for (const room of rooms) {
          const before = previous.find((item) => item.id === room.id)
          if (before?.lastActivity && room.unread > 0 && room.lastActivity && Date.parse(room.lastActivity) > Date.parse(before.lastActivity) && this.options.notificationsEnabled()) this.options.notify(session.account.provider === 'teams' ? 'Microsoft Teams' : 'Chat', session.account.notificationPreviews ? `New activity in ${room.name}` : 'New chat activity', id, room.id)
        }
        this.broadcast()
      } catch (error) { this.failure(session.account, error, epoch); throw error }
    }
    const promise = refresh(); this.refreshing.set(id, promise)
    try { await promise } finally { if (this.refreshing.get(id) === promise) this.refreshing.delete(id) }
  }
  private room(id: string, roomId: string) { const room = this.store.rooms(id).find((room) => room.id === roomId); if (!room) throw new Error('Chat room not found in this account'); return room }
  private withPending(accountId: string, roomId: string, page: ProviderChatPage, threadId?: string): ProviderChatPage {
    return { ...page, items: [...new Map([...page.items, ...this.store.pending(accountId, roomId, threadId)].map((item) => [item.id, item])).values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp)) }
  }
  async messages(id: string, roomId: string, options: { cursor?: string; threadId?: string } = {}) {
    this.guard(); const session = this.session(id), room = this.room(id, roomId), epoch = this.epochs.get(id) ?? 0
    const cached = this.store.page(id, roomId, options.threadId)
    try {
      this.networkReady(session)
      const page = await this.adapter(session).messages(session, room, options); this.guard(); this.active(id, epoch)
      if (options.cursor) return this.withPending(id, roomId, page, options.threadId)
      this.store.savePage(id, roomId, page, options.threadId)
      return this.withPending(id, roomId, page, options.threadId)
    } catch (error) {
      if (this.closed || this.options.locked()) throw error
      this.active(id, epoch)
      this.failure(session.account, error, epoch)
      if (cached && !options.cursor) return this.withPending(id, roomId, { ...cached, stale: true, error: error instanceof Error ? error.message : 'Chat update failed' }, options.threadId)
      throw error
    }
  }
  async send(id: string, roomId: string, body: string, threadId?: string) {
    this.guard(); if (!this.options.online()) throw new Error('Offline — reconnect before sending. Your draft remains in the editor.')
    const session = this.session(id), room = this.room(id, roomId), epoch = this.epochs.get(id) ?? 0
    this.networkReady(session)
    if (!room.canSend || (threadId && !room.threaded)) throw new Error('Sending is not supported in this conversation')
    if (!body.trim() || body.length > 28_000) throw new Error('Enter a message of at most 28,000 characters')
    const local: ProviderChatMessage = { id: randomUUID(), senderId: session.account.remoteUserId, sender: session.account.name, timestamp: new Date().toISOString(), body, own: true, delivery: 'sending', ...(threadId ? { replyToId: threadId } : {}) }
    this.store.saveSend(id, roomId, local, threadId)
    this.options.changed({ type: 'messages', accountId: id, roomId })
    let sent: ProviderChatMessage
    try {
      sent = await this.adapter(session).send(session, room, body, threadId, local.id)
      this.active(id, epoch)
      this.store.saveSend(id, roomId, { ...local, delivery: 'sent' }, threadId)
      const page = this.store.page(id, roomId, threadId) ?? { items: [] }
      this.store.savePage(id, roomId, { ...page, items: [...page.items.filter((item) => item.id !== sent.id), sent] }, threadId)
    } catch (error) {
      if (!this.closed && (this.epochs.get(id) ?? 0) === epoch && this.store.account(id)) {
        const uncertain = !(error instanceof ProviderChatError) || ['uncertain', 'network'].includes(error.kind)
        this.store.saveSend(id, roomId, { ...local, delivery: uncertain ? 'review' : 'failed', error: error instanceof Error ? error.message : 'Message failed' }, threadId)
        this.failure(session.account, error, epoch)
        this.options.changed({ type: 'messages', accountId: id, roomId })
      }
      throw error
    }
    this.options.changed({ type: 'messages', accountId: id, roomId }); this.guard(); return { ...sent, delivery: 'sent' as const }
  }
  async markRead(id: string, roomId: string) {
    this.guard(); const session = this.session(id), room = this.room(id, roomId), epoch = this.epochs.get(id) ?? 0
    this.networkReady(session)
    if (!room.canReadReceipt || !this.adapter(session).markRead) throw new Error('This provider does not support a server read marker here')
    try { await this.adapter(session).markRead!(session, room) } catch (error) { this.failure(session.account, error, epoch); throw error }
    this.guard(); this.active(id, epoch)
    this.store.saveRooms(id, this.store.rooms(id).map((item) => item.id === roomId ? { ...item, unread: 0 } : item)); this.broadcast()
  }
  close() { this.closed = true; clearInterval(this.timer); this.store.close() }
}
