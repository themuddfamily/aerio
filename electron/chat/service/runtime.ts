import {
  ClientEvent, createClient, EventTimeline, EventType, MatrixEventEvent, RoomEvent, SyncState,
  type MatrixClient, type MatrixEvent, type Room
} from 'matrix-js-sdk'
import {
  AllDevicesIsolationMode, CryptoEvent, decodeRecoveryKey, VerificationPhase, VerificationRequestEvent, VerifierEvent,
  type ShowSasCallbacks, type VerificationRequest, type Verifier
} from 'matrix-js-sdk/lib/crypto-api/index.js'
import { logger } from 'matrix-js-sdk/lib/logger.js'
import type { ChatDeviceSummary, ChatRecoveryState, ChatTrustState, ChatVerificationPhase, ChatVerificationState } from '../../../src/chat-types'
import type { ChatSyncBatch } from '../chat-store'
import { mediaDownloadPath, readBoundedBody } from '../media'
import { ChatServiceError, mapMatrixEvent, mapRoom, serializeServiceError } from './event-mapping'

export { ChatServiceError }

/**
 * The Matrix session that runs inside the isolated chat service (a hidden,
 * sandboxed webContents with its own persistent partition), never in the
 * visible renderer. It owns the SDK client, Rust crypto (with an encrypted
 * IndexedDB store when `useIndexedDB` is set) and verification flows, and
 * reports only structured records. The same code runs under Node in tests
 * with an in-memory crypto store.
 */
export interface ChatServiceStart {
  accountId: string
  homeserver: string
  userId: string
  deviceId: string
  accessToken: string
  /** 32-byte key the SDK uses to encrypt its IndexedDB crypto store. */
  cryptoStoreKey?: Uint8Array
  useIndexedDB: boolean
  cryptoDatabasePrefix?: string
}

export type ChatServiceStatus = 'connecting' | 'ready' | 'offline' | 'needs-auth' | 'error'

export type ChatServiceEvent =
  | { type: 'status'; status: ChatServiceStatus; error?: string }
  | { type: 'batch'; batch: ChatSyncBatch }
  | { type: 'verification'; state: ChatVerificationState }
  | { type: 'security'; trust: ChatTrustState; recovery: ChatRecoveryState; pause?: string }

export type ChatServiceCommand =
  | { type: 'start'; config: ChatServiceStart }
  | { type: 'stop' }
  | { type: 'send'; roomId: string; eventType: string; content: Record<string, unknown>; txnId: string }
  | { type: 'redact'; roomId: string; eventId: string; txnId: string }
  | { type: 'paginate'; roomId: string; limit: number }
  | { type: 'room'; roomId: string; action: 'accept' | 'decline' | 'leave' }
  | { type: 'read'; roomId: string; eventId: string }
  | { type: 'upload'; bytes: Uint8Array; mime: string }
  | { type: 'download'; mxc: string; limit: number }
  | { type: 'media-config' }
  | { type: 'devices' }
  | { type: 'verify-own' }
  | { type: 'verification'; requestId: string; action: 'accept' | 'start-sas' | 'confirm' | 'mismatch' | 'cancel' }
  | { type: 'recovery-key'; key: string }
  | { type: 'setup-recovery' }
  | { type: 'logout' }
  | { type: 'self-test'; prefix: string; key: Uint8Array; userId: string; deviceId: string }

const PHASES: Record<number, ChatVerificationPhase> = {
  [VerificationPhase.Unsent]: 'requested', [VerificationPhase.Requested]: 'requested', [VerificationPhase.Ready]: 'ready',
  [VerificationPhase.Started]: 'started', [VerificationPhase.Cancelled]: 'cancelled', [VerificationPhase.Done]: 'done'
}

/** The SDK delays its first backup upload by up to 10 s; allow for that plus the upload itself. */
const BACKUP_UPLOAD_WAIT_MS = 20_000

let quietLogger = false
function quiet() {
  if (quietLogger) return
  quietLogger = true
  // SDK logs can contain room and user identifiers; keep only warnings.
  ;(logger as unknown as { setLevel?: (level: string) => void }).setLevel?.('warn')
}

export class ChatServiceRuntime {
  private client?: MatrixClient
  private config?: ChatServiceStart
  private pending: ChatSyncBatch = { rooms: [], events: [] }
  private flushTimer?: ReturnType<typeof setTimeout>
  private readonly requests = new Map<string, VerificationRequest>()
  private readonly sas = new Map<string, ShowSasCallbacks>()
  private recoveryKey?: Uint8Array<ArrayBuffer>
  private requestCounter = 0

  constructor(private readonly emit: (event: ChatServiceEvent) => void, private readonly fetchFn: typeof fetch = (...args) => fetch(...args)) {
    quiet()
  }

  async handle(command: ChatServiceCommand): Promise<unknown> {
    try {
      return await this.dispatch(command)
    } catch (error) {
      if (error instanceof ChatServiceError) throw error
      throw new ChatServiceError(serializeServiceError(error))
    }
  }

  private requireClient() {
    if (!this.client || !this.config) throw new ChatServiceError({ kind: 'other', message: 'The chat service has not started' })
    return { client: this.client, config: this.config }
  }

  private async dispatch(command: ChatServiceCommand): Promise<unknown> {
    switch (command.type) {
      case 'start': return this.start(command.config)
      case 'stop': this.stop(); return undefined
      case 'self-test': return this.selfTest(command)
      case 'send': return this.send(command.roomId, command.eventType, command.content, command.txnId)
      case 'redact': {
        const { client } = this.requireClient()
        return (await client.redactEvent(command.roomId, command.eventId, command.txnId)).event_id
      }
      case 'paginate': return this.paginate(command.roomId, command.limit)
      case 'room': {
        const { client } = this.requireClient()
        if (command.action === 'accept') await client.joinRoom(command.roomId)
        else await client.leave(command.roomId)
        return undefined
      }
      case 'read': {
        const { client } = this.requireClient()
        const room = client.getRoom(command.roomId)
        const event = room?.findEventById(command.eventId)
        // Read receipts default off: only the private fully-read marker is moved.
        if (room && event) await client.setRoomReadMarkers(command.roomId, command.eventId)
        return undefined
      }
      case 'upload': {
        const { client } = this.requireClient()
        const response = await client.uploadContent(new Blob([command.bytes as Uint8Array<ArrayBuffer>], { type: command.mime }), { type: command.mime, includeFilename: false })
        return response.content_uri
      }
      case 'download': {
        const { config } = this.requireClient()
        const response = await this.fetchFn(`${config.homeserver}${mediaDownloadPath(command.mxc)}`, { headers: { Authorization: `Bearer ${config.accessToken}` }, redirect: 'error' })
        if (!response.ok) throw new ChatServiceError({ kind: response.status === 404 ? 'rejected' : 'network', message: 'The attachment could not be downloaded' })
        return readBoundedBody(response, command.limit)
      }
      case 'media-config': {
        const { client } = this.requireClient()
        try { return (await client.getMediaConfig(true))['m.upload.size'] } catch { return undefined }
      }
      case 'devices': return this.devices()
      case 'verify-own': {
        const crypto = this.requireCrypto()
        return this.track(await crypto.requestOwnUserVerification())
      }
      case 'verification': return this.verificationAction(command.requestId, command.action)
      case 'recovery-key': return this.restoreRecovery(command.key)
      case 'setup-recovery': return this.setupRecovery()
      case 'logout': {
        const { client } = this.requireClient()
        await client.logout(true)
        return undefined
      }
    }
  }

  private requireCrypto() {
    const crypto = this.requireClient().client.getCrypto()
    if (!crypto) throw new ChatServiceError({ kind: 'encryption', message: 'End-to-end encryption is not available in this session' })
    return crypto
  }

  private async start(config: ChatServiceStart) {
    if (this.client) throw new ChatServiceError({ kind: 'other', message: 'The chat service is already running' })
    this.config = config
    this.emit({ type: 'status', status: 'connecting' })
    const client = createClient({
      baseUrl: config.homeserver, userId: config.userId, deviceId: config.deviceId, accessToken: config.accessToken,
      fetchFn: this.fetchFn, timelineSupport: true,
      verificationMethods: ['m.sas.v1'],
      cryptoCallbacks: {
        getSecretStorageKey: async ({ keys }) => {
          const keyId = Object.keys(keys)[0]
          return this.recoveryKey && keyId ? [keyId, this.recoveryKey] : null
        }
      }
    })
    this.client = client
    try {
      // A store created for another user/device fails here instead of being reused with fresh keys.
      await client.initRustCrypto({
        useIndexedDB: config.useIndexedDB,
        cryptoDatabasePrefix: config.cryptoDatabasePrefix ?? `aerio-chat-${config.accountId}`,
        storageKey: config.cryptoStoreKey
      })
    } catch (error) {
      this.client = undefined
      client.stopClient()
      const message = error instanceof Error ? error.message : String(error)
      this.emit({ type: 'status', status: 'error', error: 'The encrypted crypto store does not match this account and device' })
      throw new ChatServiceError({ kind: 'encryption', message })
    }
    const crypto = client.getCrypto()!
    // Sending fails rather than silently sharing keys when a verified user's identity changes.
    crypto.setDeviceIsolationMode(new AllDevicesIsolationMode(true))
    this.listen(client)
    await client.startClient({ initialSyncLimit: 30, lazyLoadMembers: true })
    return { ed25519: (await crypto.getOwnDeviceKeys()).ed25519 }
  }

  private listen(client: MatrixClient) {
    const direct = () => {
      const content = client.getAccountData(EventType.Direct)?.getContent() as Record<string, string[]> | undefined
      return new Set(Object.values(content ?? {}).flat())
    }
    const queueRoom = (room: Room | undefined) => {
      if (!room) return
      this.pending.rooms = this.pending.rooms.filter((item) => item.roomId !== room.roomId)
      this.pending.rooms.push(mapRoom(room, direct()))
      this.scheduleFlush()
    }
    const queueEvent = (event: MatrixEvent) => {
      const mapped = mapMatrixEvent(event)
      if (!mapped) return
      queueRoom(client.getRoom(mapped.roomId) ?? undefined)
      this.pending.events.push(mapped)
      this.scheduleFlush()
    }
    client.on(RoomEvent.Timeline, (event, room) => { queueEvent(event); if (room) queueRoom(room) })
    client.on(MatrixEventEvent.Decrypted, (event) => queueEvent(event))
    client.on(RoomEvent.Redaction, (event) => queueEvent(event))
    client.on(RoomEvent.MyMembership, (room) => queueRoom(room))
    client.on(RoomEvent.Name, (room) => queueRoom(room))
    client.on(ClientEvent.Room, (room) => queueRoom(room))
    client.on(ClientEvent.Sync, (state, _previous, data) => {
      if (state === SyncState.Prepared || state === SyncState.Syncing) {
        this.emit({ type: 'status', status: 'ready' })
        if (state === SyncState.Prepared) void this.reportSecurity()
      } else if (state === SyncState.Error || state === SyncState.Reconnecting) {
        const auth = (data?.error as { errcode?: string } | undefined)?.errcode === 'M_UNKNOWN_TOKEN'
        this.emit({ type: 'status', status: auth ? 'needs-auth' : 'offline' })
      }
    })
    client.on(CryptoEvent.VerificationRequestReceived, (request) => { this.track(request) })
    client.on(CryptoEvent.UserTrustStatusChanged, (userId) => { if (userId === this.config?.userId) void this.reportSecurity() })
    client.on(CryptoEvent.KeyBackupStatus, () => { void this.reportSecurity() })
  }

  private scheduleFlush() {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => this.flush(), 25)
  }

  /** Emits queued display records as one ordered batch. */
  flush() {
    clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    if (!this.pending.rooms.length && !this.pending.events.length && !this.pending.reachedStart?.length) return
    const batch = this.pending
    this.pending = { rooms: [], events: [] }
    this.emit({ type: 'batch', batch })
  }

  private async reportSecurity() {
    const crypto = this.client?.getCrypto()
    const config = this.config
    if (!crypto || !config) return
    try {
      const device = await crypto.getDeviceVerificationStatus(config.userId, config.deviceId)
      const own = await crypto.getUserVerificationStatus(config.userId)
      const backup = await crypto.getKeyBackupInfo().catch(() => null)
      const active = await crypto.getActiveSessionBackupVersion().catch(() => null)
      const recovery: ChatRecoveryState = !backup ? 'not-set-up' : active ? 'available' : 'needs-key'
      const pause = own.wasCrossSigningVerified() && !own.isCrossSigningVerified()
        ? 'Your Matrix identity changed since it was verified. Review your devices before sending.' : undefined
      this.emit({ type: 'security', trust: device?.isVerified() ? 'verified' : 'unverified', recovery, pause })
    } catch {
      this.emit({ type: 'security', trust: 'unknown', recovery: 'unknown' })
    }
  }

  private async send(roomId: string, eventType: string, content: Record<string, unknown>, txnId: string) {
    const { client } = this.requireClient()
    const room = client.getRoom(roomId)
    if (!room || room.getMyMembership() !== 'join') throw new ChatServiceError({ kind: 'rejected', message: 'You are not a member of this room' })
    if (room.hasEncryptionStateEvent() && !client.getCrypto()) throw new ChatServiceError({ kind: 'encryption', message: 'This room is encrypted and encryption is unavailable. The message was not sent' })
    try {
      // The SDK encrypts for encrypted rooms and fails rather than downgrading to plaintext.
      const sendEvent = client.sendEvent as unknown as (roomId: string, type: string, content: Record<string, unknown>, txnId?: string) => Promise<{ event_id: string }>
      const response = await sendEvent.call(client, roomId, eventType, content, txnId)
      return response.event_id
    } catch (error) {
      // Drop the SDK's failed local echo; Aerio's own outbox keeps the message.
      const echo = room.getPendingEvents?.().find((event) => event.getTxnId() === txnId)
      if (echo) client.cancelPendingEvent(echo)
      throw error
    }
  }

  private async paginate(roomId: string, limit: number) {
    const { client } = this.requireClient()
    const room = client.getRoom(roomId)
    if (!room) throw new ChatServiceError({ kind: 'rejected', message: 'Room not found' })
    await client.scrollback(room, Math.min(Math.max(limit, 1), 100))
    const reachedStart = room.getLiveTimeline().getPaginationToken(EventTimeline.BACKWARDS) === null
    // Scrollback events are emitted through the timeline listener; include the result in the same batch.
    if (reachedStart) this.pending.reachedStart = [...(this.pending.reachedStart ?? []), roomId]
    this.flush()
    return { reachedStart }
  }

  private async devices(): Promise<ChatDeviceSummary[]> {
    const { config } = this.requireClient()
    const crypto = this.requireCrypto()
    const map = await crypto.getUserDeviceInfo([config.userId], true)
    const devices = [...(map.get(config.userId)?.values() ?? [])]
    return Promise.all(devices.map(async (device) => ({
      deviceId: device.deviceId,
      displayName: device.displayName,
      verified: Boolean((await crypto.getDeviceVerificationStatus(config.userId, device.deviceId))?.isVerified()),
      current: device.deviceId === config.deviceId
    })))
  }

  private track(request: VerificationRequest): ChatVerificationState {
    const existing = [...this.requests].find(([, value]) => value === request)
    const requestId = existing?.[0] ?? request.transactionId ?? `local-${++this.requestCounter}`
    if (!existing) {
      this.requests.set(requestId, request)
      request.on(VerificationRequestEvent.Change, () => {
        if (request.phase === VerificationPhase.Started && request.verifier) this.attachVerifier(requestId, request.verifier)
        this.emitVerification(requestId)
      })
      this.emitVerification(requestId)
    }
    return this.verificationState(requestId)
  }

  private attachVerifier(requestId: string, verifier: Verifier) {
    if ((verifier as unknown as { aerioAttached?: boolean }).aerioAttached) return
    (verifier as unknown as { aerioAttached?: boolean }).aerioAttached = true
    verifier.on(VerifierEvent.ShowSas, (callbacks) => {
      this.sas.set(requestId, callbacks)
      this.emitVerification(requestId)
    })
    verifier.on(VerifierEvent.Cancel, () => this.emitVerification(requestId))
    void verifier.verify().then(() => this.reportSecurity()).catch(() => this.emitVerification(requestId))
  }

  private verificationState(requestId: string): ChatVerificationState {
    const request = this.requests.get(requestId)!
    const sas = this.sas.get(requestId)
    const phase = sas && request.phase === VerificationPhase.Started ? 'show-sas' : PHASES[request.phase] ?? 'requested'
    return {
      requestId, accountId: this.config?.accountId ?? '', otherUserId: request.otherUserId, otherDeviceId: request.otherDeviceId,
      selfVerification: request.isSelfVerification, initiatedByMe: request.initiatedByMe, phase,
      emoji: phase === 'show-sas' ? sas?.sas.emoji?.map(([symbol, name]) => ({ symbol, name })) : undefined,
      reason: request.phase === VerificationPhase.Cancelled ? request.cancellationCode ?? 'cancelled' : undefined
    }
  }

  private emitVerification(requestId: string) {
    if (!this.requests.has(requestId)) return
    this.emit({ type: 'verification', state: this.verificationState(requestId) })
  }

  private async verificationAction(requestId: string, action: 'accept' | 'start-sas' | 'confirm' | 'mismatch' | 'cancel') {
    const request = this.requests.get(requestId)
    if (!request) throw new ChatServiceError({ kind: 'rejected', message: 'This verification request is no longer active' })
    if (action === 'accept') await request.accept()
    else if (action === 'start-sas') this.attachVerifier(requestId, await request.startVerification('m.sas.v1'))
    else if (action === 'confirm') {
      const sas = this.sas.get(requestId)
      if (!sas) throw new ChatServiceError({ kind: 'rejected', message: 'There are no emoji to confirm yet' })
      await sas.confirm()
    } else if (action === 'mismatch') this.sas.get(requestId)?.mismatch()
    else await request.cancel()
    this.emitVerification(requestId)
  }

  private async restoreRecovery(key: string) {
    const crypto = this.requireCrypto()
    try { this.recoveryKey = decodeRecoveryKey(key.trim()) } catch { throw new ChatServiceError({ kind: 'rejected', message: 'That recovery key is not valid' }) }
    try {
      // Imports cross-signing secrets from secret storage, then the backup key, then restores room keys.
      await crypto.bootstrapCrossSigning({})
      await crypto.loadSessionBackupPrivateKeyFromSecretStorage()
      await crypto.checkKeyBackupAndEnable()
      const result = await crypto.restoreKeyBackup()
      await this.reportSecurity()
      return { imported: result.imported, total: result.total }
    } finally {
      this.recoveryKey = undefined
    }
  }

  /**
   * First-device onboarding: creates cross-signing keys (servers that require
   * interactive auth for this refuse; the error is reported, not bypassed),
   * secret storage and a key backup, and returns the generated recovery key
   * once so the user can record it. Aerio does not store it.
   */
  private async setupRecovery() {
    const crypto = this.requireCrypto()
    const { client } = this.requireClient()
    let encoded: string | undefined
    // The SDK uploads existing room keys after a random start delay. Wait (bounded) for that
    // first upload so "recovery is set up" also means earlier history is in the backup.
    let uploaded!: () => void
    const backedUp = new Promise<void>((resolve) => { uploaded = resolve })
    const onRemaining = (remaining: number) => { if (remaining === 0) uploaded() }
    client.on(CryptoEvent.KeyBackupSessionsRemaining, onRemaining)
    try {
      await crypto.bootstrapCrossSigning({ authUploadDeviceSigningKeys: async (makeRequest) => { await makeRequest(null) } })
      await crypto.bootstrapSecretStorage({
        createSecretStorageKey: async () => {
          const generated = await crypto.createRecoveryKeyFromPassphrase()
          encoded = generated.encodedPrivateKey
          // The SDK asks for the new key back while it stores secrets under it.
          this.recoveryKey = generated.privateKey
          return generated
        },
        setupNewKeyBackup: true
      })
      let timer: ReturnType<typeof setTimeout> | undefined
      const complete = await Promise.race([
        backedUp.then(() => true),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), BACKUP_UPLOAD_WAIT_MS) })
      ])
      clearTimeout(timer)
      await this.reportSecurity()
      return { recoveryKey: encoded, backupComplete: complete }
    } finally {
      client.off(CryptoEvent.KeyBackupSessionsRemaining, onRemaining)
      this.recoveryKey = undefined
    }
  }

  /** Gate probe: creates or reopens an encrypted crypto store and reports the device identity key. */
  private async selfTest(command: Extract<ChatServiceCommand, { type: 'self-test' }>) {
    const client = createClient({ baseUrl: 'https://aerio-self-test.invalid', userId: command.userId, deviceId: command.deviceId, accessToken: 'self-test', fetchFn: async () => { throw new TypeError('offline self-test') } })
    try {
      await client.initRustCrypto({ useIndexedDB: true, cryptoDatabasePrefix: command.prefix, storageKey: command.key })
      return { ed25519: (await client.getCrypto()!.getOwnDeviceKeys()).ed25519 }
    } finally {
      client.stopClient()
    }
  }

  stop() {
    this.flush()
    this.client?.stopClient()
    this.client = undefined
    for (const request of this.requests.values()) if (request.pending) void request.cancel().catch(() => {})
    this.requests.clear()
    this.sas.clear()
  }
}
