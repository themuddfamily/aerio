/** Non-Matrix providers use these display contracts. Tokens and adapter SDK objects never cross IPC. */
export type ProviderChatId = 'teams' | 'slack' | 'xmpp' | 'rocketchat' | 'icewarp'
export interface ProviderChatField { key: string; label: string; type: 'text' | 'password' | 'checkbox'; required?: boolean }
export interface ProviderChatDescriptor { id: ProviderChatId; name: string; available: boolean; detail: string; fields: ProviderChatField[] }
export interface ProviderChatAccount { id: string; provider: ProviderChatId; remoteUserId: string; name: string; status: 'ready' | 'offline' | 'needs-auth' | 'error'; error?: string; retryAt?: string; notificationPreviews: boolean }
export interface ProviderChatRoom {
  accountId: string; id: string; name: string; kind: 'direct' | 'group' | 'channel'; unread: number
  lastActivity?: string; canSend: boolean; canReadReceipt: boolean; threaded: boolean
  /** Opaque provider identifiers, validated by its adapter and retained by the desktop runtime. */
  resource: Record<string, string>
  detail?: string
}
export interface ProviderChatMessage { id: string; senderId: string; sender: string; timestamp: string; body: string; own: boolean; deleted?: boolean; replyToId?: string; delivery?: 'sending' | 'sent' | 'failed' | 'review'; error?: string }
export interface ProviderChatPage { items: ProviderChatMessage[]; cursor?: string; stale?: boolean; error?: string; /** Session-only history must be merged with the encrypted local page. */ partial?: boolean }
export interface ProviderChatSnapshot { available: boolean; detail?: string; providers: ProviderChatDescriptor[]; accounts: ProviderChatAccount[]; rooms: ProviderChatRoom[] }
export type ProviderChatEvent = { type: 'snapshot'; snapshot: ProviderChatSnapshot } | { type: 'messages'; accountId: string; roomId: string } | { type: 'open-room'; accountId: string; roomId: string }
export interface ProviderChatApi {
  snapshot(): Promise<ProviderChatSnapshot>
  connect(provider: ProviderChatId, input: Record<string, string | boolean>, accountId?: string): Promise<ProviderChatAccount>
  remove(accountId: string): Promise<void>
  refresh(accountId: string): Promise<void>
  messages(accountId: string, roomId: string, options?: { cursor?: string; threadId?: string }): Promise<ProviderChatPage>
  send(accountId: string, roomId: string, body: string, threadId?: string): Promise<ProviderChatMessage>
  markRead(accountId: string, roomId: string): Promise<void>
  preferences(accountId: string, notificationPreviews: boolean): Promise<void>
  onEvent(callback: (event: ProviderChatEvent) => void): () => void
}
