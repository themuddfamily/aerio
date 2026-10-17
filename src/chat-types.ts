// Renderer-facing Chat (Matrix connector) contracts. The renderer only ever
// receives display snapshots and issues commands: access tokens, cache keys,
// crypto-store keys and SDK objects stay in the main process and the isolated
// chat service. See docs/chat-matrix-connector.md.

export type ChatTransport = 'matrix'

export type ChatGateCheckId = 'secure-storage' | 'service-runtime' | 'crypto-persistence' | 'interoperability'

export interface ChatGateCheck {
  id: ChatGateCheckId
  label: string
  passed: boolean
  detail: string
  checkedAt?: string
}

/**
 * Whether the Chat workspace may appear. `enabled` requires every check.
 * `preview` is a developer opt-in (AERIO_CHAT_PREVIEW=1) that only waives the
 * hosted interoperability evidence; secure storage and crypto persistence are
 * never waived.
 */
export interface ChatGateStatus {
  enabled: boolean
  preview: boolean
  checks: ChatGateCheck[]
  sdkVersion: string
  message: string
}

export type ChatAccountStatus = 'connecting' | 'ready' | 'offline' | 'needs-auth' | 'paused' | 'error'
export type ChatTrustState = 'verified' | 'unverified' | 'unknown'
export type ChatRecoveryState = 'unknown' | 'not-set-up' | 'available' | 'restored' | 'needs-key'

export interface ChatRetention {
  /** Days of decrypted history kept locally. Server retention is separate. */
  historyDays: number
  /** Ciphertext/media cache budget per account. */
  mediaCacheMiB: number
}

export interface ChatAccountPreferences {
  retention: ChatRetention
  /** Message bodies in notifications; still requires an unlocked app and a room that allows previews. */
  notificationPreviews: boolean
  /** Whether queued messages are dispatched while Aerio is locked. */
  sendWhileLocked: boolean
  typingNotifications: boolean
  readReceipts: boolean
}

export interface ChatAccountSummary {
  id: string
  transport: ChatTransport
  /** Canonical homeserver origin the account authenticates to. */
  homeserver: string
  /** Exact remote Matrix user ID; never inferred from mail identity. */
  userId: string
  deviceId: string
  displayName?: string
  status: ChatAccountStatus
  error?: string
  trust: ChatTrustState
  recovery: ChatRecoveryState
  /** Set when the remote identity or crypto state changed unexpectedly; sending is paused. */
  securityPause?: string
  preferences: ChatAccountPreferences
  createdAt: string
}

export type ChatMembership = 'join' | 'invite' | 'leave' | 'ban'

export interface ChatRoomSummary {
  accountId: string
  roomId: string
  name: string
  encrypted: boolean
  membership: ChatMembership
  isDirect: boolean
  /** Full Matrix ID of whoever invited this account; display names are untrusted. */
  inviter?: string
  unread: number
  muted: boolean
  /** Room allows notification previews. */
  previews: boolean
  /** Writes are held (membership loss, trust failure) until explicitly resolved. */
  held?: string
  lastActivity?: string
}

export type ChatOutboxState = 'pending' | 'running' | 'sent' | 'failed' | 'review'
export type ChatOutboxKind = 'message' | 'edit' | 'redaction' | 'reaction' | 'media'

export interface ChatMediaReference {
  mediaId: string
  name: string
  size: number
  mime: string
  encrypted: boolean
}

export interface ChatReplyPreview {
  eventId: string
  sender?: string
  body?: string
  /** The target is not in local history yet. */
  missing: boolean
}

export interface ChatReaction {
  key: string
  count: number
  mine: boolean
}

export type ChatTimelineKind = 'text' | 'notice' | 'emote' | 'media' | 'undecryptable' | 'redacted' | 'membership' | 'unsupported'

export interface ChatTimelineItem {
  /** Event ID when confirmed, otherwise the outbox ID. */
  id: string
  eventId?: string
  outboxId?: string
  sender: string
  timestamp: string
  kind: ChatTimelineKind
  body?: string
  edited: boolean
  encrypted: boolean
  /** Why an undecryptable event cannot be shown; no guessed text replaces it. */
  decryptionError?: string
  replyTo?: ChatReplyPreview
  reactions: ChatReaction[]
  media?: ChatMediaReference
  /** Local delivery state; `sent` means accepted by the server, not read. */
  delivery?: ChatOutboxState
  deliveryError?: string
  own: boolean
}

export interface ChatTimelinePage {
  accountId: string
  roomId: string
  items: ChatTimelineItem[]
  /** Older history exists (or may exist) before the first item. A failed load never clears it. */
  gapBefore: boolean
  encrypted: boolean
}

export interface ChatSearchResult {
  accountId: string
  roomId: string
  eventId: string
  sender: string
  timestamp: string
  snippet: string
}

export interface ChatDeviceSummary {
  deviceId: string
  displayName?: string
  verified: boolean
  current: boolean
}

export type ChatVerificationPhase = 'requested' | 'ready' | 'started' | 'show-sas' | 'done' | 'cancelled'

export interface ChatVerificationState {
  requestId: string
  accountId: string
  otherUserId: string
  otherDeviceId?: string
  selfVerification: boolean
  initiatedByMe: boolean
  phase: ChatVerificationPhase
  emoji?: { symbol: string; name: string }[]
  reason?: string
}

export interface ChatLoginFlows {
  homeserver: string
  versions: string[]
  password: boolean
  sso: boolean
  unsupported: string[]
}

export interface ChatPasswordLoginInput {
  homeserver: string
  user: string
  password: string
}

export interface ChatSnapshot {
  gate: ChatGateStatus
  accounts: ChatAccountSummary[]
  rooms: ChatRoomSummary[]
  verifications: ChatVerificationState[]
}

export type ChatEvent =
  | { type: 'snapshot'; snapshot: ChatSnapshot }
  | { type: 'timeline'; accountId: string; roomId: string }
  | { type: 'open-room'; accountId: string; roomId: string; eventId?: string }

export interface ChatDesktopApi {
  snapshot(): Promise<ChatSnapshot>
  discover(input: string): Promise<ChatLoginFlows>
  login(input: ChatPasswordLoginInput): Promise<ChatAccountSummary>
  removeAccount(accountId: string): Promise<{ remoteLogout: 'done' | 'failed' | 'skipped'; message?: string }>
  clearHistory(accountId: string): Promise<void>
  updatePreferences(accountId: string, preferences: Partial<ChatAccountPreferences>): Promise<ChatAccountSummary>
  timeline(accountId: string, roomId: string): Promise<ChatTimelinePage>
  loadOlder(accountId: string, roomId: string): Promise<ChatTimelinePage>
  search(accountId: string, query: string): Promise<ChatSearchResult[]>
  send(accountId: string, roomId: string, body: string, replyTo?: string): Promise<ChatTimelineItem>
  edit(accountId: string, roomId: string, targetId: string, body: string): Promise<void>
  redact(accountId: string, roomId: string, targetId: string): Promise<void>
  react(accountId: string, roomId: string, targetId: string, key: string): Promise<void>
  cancelOutgoing(outboxId: string): Promise<void>
  retryOutgoing(outboxId: string): Promise<void>
  attach(accountId: string, roomId: string): Promise<ChatTimelineItem | undefined>
  saveMedia(accountId: string, mediaId: string): Promise<boolean>
  markRead(accountId: string, roomId: string): Promise<void>
  roomAction(accountId: string, roomId: string, action: 'accept' | 'decline' | 'leave' | 'mute' | 'unmute' | 'allow-previews' | 'block-previews' | 'release-hold'): Promise<void>
  devices(accountId: string): Promise<ChatDeviceSummary[]>
  verifyOwnDevice(accountId: string): Promise<ChatVerificationState>
  verificationAction(accountId: string, requestId: string, action: 'accept' | 'start-sas' | 'confirm' | 'mismatch' | 'cancel'): Promise<void>
  restoreFromRecoveryKey(accountId: string, recoveryKey: string): Promise<void>
  onEvent(callback: (event: ChatEvent) => void): () => void
}
