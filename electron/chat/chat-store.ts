import { DatabaseSync } from 'node:sqlite'
import type {
  ChatAccountPreferences, ChatAccountStatus, ChatMediaReference, ChatMembership, ChatOutboxState, ChatRecoveryState,
  ChatRoomSummary, ChatTrustState
} from '../../src/chat-types'
import type { ChatCacheCipher } from './cache-crypto'
import type { ChatOutboxRecord, ChatStoredEvent } from './projection'

/**
 * `chat.sqlite`: Chat's own local store, separate from mail, productivity and
 * profile backups. Message content, room names, drafts, outbox payloads and
 * media metadata are sealed with the account's cache key (see cache-crypto.ts);
 * structural columns (IDs, timestamps, states) stay queryable. Events are
 * immutable and keyed by event ID so replayed sync batches never duplicate.
 */
export const DEFAULT_CHAT_PREFERENCES: ChatAccountPreferences = {
  retention: { historyDays: 30, mediaCacheMiB: 250 },
  notificationPreviews: false,
  sendWhileLocked: false,
  typingNotifications: false,
  readReceipts: false
}

export interface ChatAccountRecord {
  id: string
  transport: 'matrix'
  homeserver: string
  userId: string
  deviceId: string
  displayName?: string
  status: ChatAccountStatus
  error?: string
  trust: ChatTrustState
  recovery: ChatRecoveryState
  securityPause?: string
  preferences: ChatAccountPreferences
  createdAt: string
}

export interface ChatRoomUpdate {
  roomId: string
  name: string
  encrypted: boolean
  membership: ChatMembership
  isDirect: boolean
  inviter?: string
  lastActivity?: number
}

export interface ChatSyncBatch {
  rooms: ChatRoomUpdate[]
  events: ChatStoredEvent[]
  /** Rooms whose timeline start is now known (no earlier history). */
  reachedStart?: string[]
}

export interface ChatMediaRecord {
  id: string
  accountId: string
  roomId: string
  eventId?: string
  outboxId?: string
  mxc?: string
  /** Matrix EncryptedFile metadata (key, iv, hashes) when the room is encrypted. */
  file?: Record<string, unknown>
  name: string
  mime: string
  size: number
  encrypted: boolean
  localPath?: string
  state: 'staged' | 'uploaded' | 'sent' | 'orphan' | 'remote' | 'cached'
}

type Row = Record<string, unknown>
const text = (value: unknown) => value === null || value === undefined ? undefined : String(value)
const ACTIVE_OUTBOX: ChatOutboxState[] = ['pending', 'running', 'failed', 'review']

export class ChatStore {
  private readonly db: DatabaseSync

  constructor(path: string, private readonly cipherFor: (accountId: string) => ChatCacheCipher) {
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS chat_accounts (
        id TEXT PRIMARY KEY, transport TEXT NOT NULL, homeserver TEXT NOT NULL, user_id TEXT NOT NULL, device_id TEXT NOT NULL,
        display_name TEXT, status TEXT NOT NULL, error TEXT, trust TEXT NOT NULL DEFAULT 'unknown', recovery TEXT NOT NULL DEFAULT 'unknown',
        security_pause TEXT, preferences_json TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(transport, homeserver, user_id)
      );
      CREATE TABLE IF NOT EXISTS chat_rooms (
        account_id TEXT NOT NULL REFERENCES chat_accounts(id) ON DELETE CASCADE, room_id TEXT NOT NULL,
        name_sealed TEXT NOT NULL, encrypted INTEGER NOT NULL, membership TEXT NOT NULL, is_direct INTEGER NOT NULL,
        inviter TEXT, muted INTEGER NOT NULL DEFAULT 0, previews INTEGER NOT NULL DEFAULT 0, held TEXT,
        read_ts INTEGER NOT NULL DEFAULT 0, last_ts INTEGER, reached_start INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(account_id, room_id)
      );
      CREATE TABLE IF NOT EXISTS chat_events (
        account_id TEXT NOT NULL REFERENCES chat_accounts(id) ON DELETE CASCADE, event_id TEXT NOT NULL, room_id TEXT NOT NULL,
        sender TEXT NOT NULL, type TEXT NOT NULL, state_key TEXT, origin_ts INTEGER NOT NULL, content_sealed TEXT NOT NULL,
        encrypted INTEGER NOT NULL, decryption_error TEXT, redacted INTEGER NOT NULL DEFAULT 0, txn_id TEXT,
        rel_type TEXT, rel_target TEXT,
        PRIMARY KEY(account_id, event_id)
      );
      CREATE INDEX IF NOT EXISTS idx_chat_events_room ON chat_events(account_id, room_id, origin_ts);
      CREATE INDEX IF NOT EXISTS idx_chat_events_target ON chat_events(account_id, rel_target);
      CREATE TABLE IF NOT EXISTS chat_outbox (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES chat_accounts(id) ON DELETE CASCADE, room_id TEXT NOT NULL,
        txn_id TEXT NOT NULL, user_id TEXT NOT NULL, device_id TEXT NOT NULL, kind TEXT NOT NULL, event_type TEXT NOT NULL,
        content_sealed TEXT NOT NULL, target_event_id TEXT, depends_on TEXT, media_id TEXT,
        state TEXT NOT NULL CHECK(state IN ('pending','running','sent','failed','review')),
        attempts INTEGER NOT NULL DEFAULT 0, error TEXT, event_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(account_id, device_id, txn_id)
      );
      CREATE INDEX IF NOT EXISTS idx_chat_outbox_queue ON chat_outbox(account_id, state, created_at);
      CREATE TABLE IF NOT EXISTS chat_media (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES chat_accounts(id) ON DELETE CASCADE, room_id TEXT NOT NULL,
        event_id TEXT, outbox_id TEXT, mxc TEXT, meta_sealed TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
        encrypted INTEGER NOT NULL, local_path TEXT, state TEXT NOT NULL, last_used INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_media_event ON chat_media(account_id, event_id);
      CREATE TABLE IF NOT EXISTS chat_drafts (
        account_id TEXT NOT NULL REFERENCES chat_accounts(id) ON DELETE CASCADE, room_id TEXT NOT NULL,
        body_sealed TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(account_id, room_id)
      );
      CREATE TABLE IF NOT EXISTS chat_notification_checkpoints (
        account_id TEXT NOT NULL REFERENCES chat_accounts(id) ON DELETE CASCADE, room_id TEXT NOT NULL,
        last_ts INTEGER NOT NULL, last_event_id TEXT NOT NULL, PRIMARY KEY(account_id, room_id)
      );
    `)
  }

  close() { this.db.close() }

  private transaction<T>(callback: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = callback()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  // Accounts

  private account(row: Row): ChatAccountRecord {
    let preferences = DEFAULT_CHAT_PREFERENCES
    try { preferences = { ...DEFAULT_CHAT_PREFERENCES, ...JSON.parse(String(row.preferences_json)) } } catch { /* Defaults keep an unreadable preference row safe. */ }
    return {
      id: String(row.id), transport: 'matrix', homeserver: String(row.homeserver), userId: String(row.user_id), deviceId: String(row.device_id),
      displayName: text(row.display_name), status: row.status as ChatAccountStatus, error: text(row.error), trust: row.trust as ChatTrustState,
      recovery: row.recovery as ChatRecoveryState, securityPause: text(row.security_pause), preferences, createdAt: String(row.created_at)
    }
  }

  accounts(): ChatAccountRecord[] {
    return this.db.prepare('SELECT * FROM chat_accounts ORDER BY created_at, id').all().map((row) => this.account(row))
  }

  getAccount(id: string) {
    const row = this.db.prepare('SELECT * FROM chat_accounts WHERE id=?').get(id)
    return row ? this.account(row) : undefined
  }

  findAccount(homeserver: string, userId: string) {
    const row = this.db.prepare("SELECT * FROM chat_accounts WHERE transport='matrix' AND homeserver=? AND user_id=?").get(homeserver, userId)
    return row ? this.account(row) : undefined
  }

  insertAccount(record: ChatAccountRecord) {
    this.db.prepare('INSERT INTO chat_accounts(id,transport,homeserver,user_id,device_id,display_name,status,error,trust,recovery,security_pause,preferences_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      record.id, record.transport, record.homeserver, record.userId, record.deviceId, record.displayName ?? null, record.status, record.error ?? null,
      record.trust, record.recovery, record.securityPause ?? null, JSON.stringify(record.preferences), record.createdAt
    )
  }

  updateAccount(id: string, patch: Partial<Omit<ChatAccountRecord, 'id' | 'transport' | 'homeserver' | 'userId' | 'createdAt'>>) {
    const current = this.getAccount(id)
    if (!current) throw new Error('Chat account not found')
    const next = { ...current, ...patch, preferences: patch.preferences ? { ...current.preferences, ...patch.preferences } : current.preferences }
    this.db.prepare('UPDATE chat_accounts SET device_id=?,display_name=?,status=?,error=?,trust=?,recovery=?,security_pause=?,preferences_json=? WHERE id=?').run(
      next.deviceId, next.displayName ?? null, next.status, next.error ?? null, next.trust, next.recovery, next.securityPause ?? null, JSON.stringify(next.preferences), id
    )
    return next
  }

  /** Deletes every row for the account and returns managed media paths for the caller to remove. */
  removeAccount(id: string) {
    return this.transaction(() => {
      const paths = this.db.prepare('SELECT local_path FROM chat_media WHERE account_id=? AND local_path IS NOT NULL').all(id).map((row) => String(row.local_path))
      for (const table of ['chat_notification_checkpoints', 'chat_drafts', 'chat_media', 'chat_outbox', 'chat_events', 'chat_rooms']) this.db.prepare(`DELETE FROM ${table} WHERE account_id=?`).run(id)
      this.db.prepare('DELETE FROM chat_accounts WHERE id=?').run(id)
      return paths
    })
  }

  // Rooms

  rooms(accountId?: string): ChatRoomSummary[] {
    const rows = accountId
      ? this.db.prepare('SELECT * FROM chat_rooms WHERE account_id=? ORDER BY last_ts DESC').all(accountId)
      : this.db.prepare('SELECT * FROM chat_rooms ORDER BY last_ts DESC').all()
    return rows.map((row) => {
      const account = String(row.account_id)
      const room = String(row.room_id)
      let name = room
      try { name = this.cipherFor(account).open(String(row.name_sealed), { table: 'rooms', record: room }) } catch { /* A room name that cannot be opened falls back to its ID. */ }
      const unread = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM chat_events WHERE account_id=? AND room_id=? AND origin_ts>? AND type IN ('m.room.message','m.room.encrypted','m.sticker') AND rel_type IS NOT 'm.replace' AND redacted=0 AND sender<>(SELECT user_id FROM chat_accounts WHERE id=?)`).get(account, room, Number(row.read_ts), account) as { count: number }).count)
      return {
        accountId: account, roomId: room, name, encrypted: Boolean(row.encrypted), membership: row.membership as ChatMembership,
        isDirect: Boolean(row.is_direct), inviter: text(row.inviter), unread, muted: Boolean(row.muted), previews: Boolean(row.previews),
        held: text(row.held), lastActivity: Number(row.last_ts) > 0 ? new Date(Number(row.last_ts)).toISOString() : undefined
      }
    })
  }

  room(accountId: string, roomId: string) {
    return this.rooms(accountId).find((room) => room.roomId === roomId)
  }

  setRoomFlags(accountId: string, roomId: string, flags: { muted?: boolean; previews?: boolean; held?: string | null; readTs?: number }) {
    const sets: string[] = []; const values: (string | number | null)[] = []
    if (flags.muted !== undefined) { sets.push('muted=?'); values.push(Number(flags.muted)) }
    if (flags.previews !== undefined) { sets.push('previews=?'); values.push(Number(flags.previews)) }
    if (flags.held !== undefined) { sets.push('held=?'); values.push(flags.held) }
    if (flags.readTs !== undefined) { sets.push('read_ts=MAX(read_ts,?)'); values.push(flags.readTs) }
    if (!sets.length) return
    this.db.prepare(`UPDATE chat_rooms SET ${sets.join(',')} WHERE account_id=? AND room_id=?`).run(...values, accountId, roomId)
  }

  reachedStart(accountId: string, roomId: string) {
    return Boolean((this.db.prepare('SELECT reached_start FROM chat_rooms WHERE account_id=? AND room_id=?').get(accountId, roomId) as { reached_start?: number } | undefined)?.reached_start)
  }

  // Sync batches

  /**
   * Applies one ordered sync display batch atomically. Replays are harmless:
   * known event IDs are skipped (an undecryptable copy may be upgraded once
   * keys arrive). Returns the events that were new to this store.
   */
  applySyncBatch(accountId: string, batch: ChatSyncBatch): ChatStoredEvent[] {
    const account = this.getAccount(accountId)
    if (!account) throw new Error('Chat account not found')
    const cipher = this.cipherFor(accountId)
    return this.transaction(() => {
      for (const room of batch.rooms) {
        const existing = this.db.prepare('SELECT membership, held FROM chat_rooms WHERE account_id=? AND room_id=?').get(accountId, room.roomId) as { membership: string; held: string | null } | undefined
        const lostMembership = existing?.membership === 'join' && (room.membership === 'leave' || room.membership === 'ban')
        const held = lostMembership ? 'You are no longer a member of this room. Queued messages are held.' : existing?.held ?? null
        this.db.prepare(`INSERT INTO chat_rooms(account_id,room_id,name_sealed,encrypted,membership,is_direct,inviter,held,last_ts) VALUES(?,?,?,?,?,?,?,?,?)
          ON CONFLICT(account_id,room_id) DO UPDATE SET name_sealed=excluded.name_sealed, encrypted=MAX(chat_rooms.encrypted,excluded.encrypted),
          membership=excluded.membership, is_direct=excluded.is_direct, inviter=excluded.inviter, held=excluded.held, last_ts=COALESCE(MAX(chat_rooms.last_ts,excluded.last_ts),chat_rooms.last_ts,excluded.last_ts)`).run(
          accountId, room.roomId, cipher.seal(room.name, { table: 'rooms', record: room.roomId }), Number(room.encrypted), room.membership, Number(room.isDirect),
          room.inviter ?? null, held, room.lastActivity ?? null
        )
      }
      const inserted: ChatStoredEvent[] = []
      for (const event of batch.events) {
        const existing = this.db.prepare('SELECT decryption_error, redacted FROM chat_events WHERE account_id=? AND event_id=?').get(accountId, event.eventId) as { decryption_error: string | null; redacted: number } | undefined
        const relation = event.content['m.relates_to'] as { rel_type?: unknown; event_id?: unknown } | undefined
        const sealed = cipher.sealJson(event.redacted ? {} : event.content, { table: 'events', record: event.eventId })
        if (!existing) {
          this.db.prepare('INSERT INTO chat_events(account_id,event_id,room_id,sender,type,state_key,origin_ts,content_sealed,encrypted,decryption_error,redacted,txn_id,rel_type,rel_target) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
            accountId, event.eventId, event.roomId, event.sender, event.type, event.stateKey ?? null, event.ts, sealed, Number(event.encrypted),
            event.decryptionError ?? null, Number(event.redacted), event.txnId ?? null,
            typeof relation?.rel_type === 'string' ? relation.rel_type : null, typeof relation?.event_id === 'string' ? relation.event_id : null
          )
          inserted.push(event)
          if (event.type !== 'm.reaction' && event.stateKey === undefined) this.db.prepare('UPDATE chat_rooms SET last_ts=MAX(COALESCE(last_ts,0),?) WHERE account_id=? AND room_id=?').run(event.ts, accountId, event.roomId)
        } else if (existing.decryption_error && !event.decryptionError && !existing.redacted) {
          // Keys arrived later: replace the undecryptable placeholder with the real content.
          this.db.prepare('UPDATE chat_events SET type=?,content_sealed=?,decryption_error=NULL,rel_type=?,rel_target=? WHERE account_id=? AND event_id=?').run(
            event.type, sealed, typeof relation?.rel_type === 'string' ? relation.rel_type : null, typeof relation?.event_id === 'string' ? relation.event_id : null, accountId, event.eventId
          )
        }
        if (event.redacted && existing && !existing.redacted) this.redactLocal(accountId, event.eventId)
        if (event.type === 'm.room.redaction' && typeof event.content.redacts === 'string') this.redactLocal(accountId, event.content.redacts)
        if (event.txnId) {
          // Sync echo for our own device: resolves the outbox item whichever of echo/HTTP arrives first.
          this.db.prepare("UPDATE chat_outbox SET state='sent',event_id=?,error=NULL,updated_at=? WHERE account_id=? AND device_id=? AND txn_id=? AND state<>'sent'").run(event.eventId, new Date().toISOString(), accountId, account.deviceId, event.txnId)
        }
      }
      for (const roomId of batch.reachedStart ?? []) this.db.prepare('UPDATE chat_rooms SET reached_start=1 WHERE account_id=? AND room_id=?').run(accountId, roomId)
      return inserted
    })
  }

  /** Removes the locally retained decrypted copy of a redacted event. */
  private redactLocal(accountId: string, eventId: string) {
    this.db.prepare('UPDATE chat_events SET content_sealed=?,redacted=1 WHERE account_id=? AND event_id=?').run(this.cipherFor(accountId).sealJson({}, { table: 'events', record: eventId }), accountId, eventId)
    this.db.prepare("UPDATE chat_media SET state='orphan' WHERE account_id=? AND event_id=? AND state IN ('remote','cached')").run(accountId, eventId)
  }

  private event(accountId: string, row: Row): ChatStoredEvent {
    const eventId = String(row.event_id)
    let content: Record<string, unknown> = {}
    let decryptionError = text(row.decryption_error)
    try { content = this.cipherFor(accountId).openJson(String(row.content_sealed), { table: 'events', record: eventId }) } catch { decryptionError = 'The local copy of this message could not be opened' }
    return {
      eventId, roomId: String(row.room_id), sender: String(row.sender), type: String(row.type), stateKey: text(row.state_key), ts: Number(row.origin_ts),
      content, encrypted: Boolean(row.encrypted), decryptionError, redacted: Boolean(row.redacted), txnId: text(row.txn_id)
    }
  }

  /** The newest `limit` events in a room, in chronological order, with their relationship events. */
  roomEvents(accountId: string, roomId: string, limit = 300): ChatStoredEvent[] {
    return this.db.prepare('SELECT * FROM chat_events WHERE account_id=? AND room_id=? ORDER BY origin_ts DESC, event_id DESC LIMIT ?').all(accountId, roomId, limit).reverse().map((row) => this.event(accountId, row))
  }

  getEvent(accountId: string, eventId: string) {
    const row = this.db.prepare('SELECT * FROM chat_events WHERE account_id=? AND event_id=?').get(accountId, eventId)
    return row ? this.event(accountId, row) : undefined
  }

  accountEvents(accountId: string): ChatStoredEvent[] {
    return this.db.prepare("SELECT * FROM chat_events WHERE account_id=? AND type='m.room.message' ORDER BY origin_ts").all(accountId).map((row) => this.event(accountId, row))
  }

  // Outbox

  private outboxRecord(row: Row): ChatOutboxRecord {
    const id = String(row.id)
    const accountId = String(row.account_id)
    let content: Record<string, unknown> = {}
    try { content = this.cipherFor(accountId).openJson(String(row.content_sealed), { table: 'outbox', record: id }) } catch { /* Shown as an empty item in review. */ }
    return {
      id, accountId, roomId: String(row.room_id), txnId: String(row.txn_id), userId: String(row.user_id), deviceId: String(row.device_id),
      kind: row.kind as ChatOutboxRecord['kind'], eventType: String(row.event_type), content, targetEventId: text(row.target_event_id),
      dependsOn: text(row.depends_on), mediaId: text(row.media_id), state: row.state as ChatOutboxState, attempts: Number(row.attempts),
      error: text(row.error), eventId: text(row.event_id), createdAt: String(row.created_at), updatedAt: String(row.updated_at)
    }
  }

  insertOutbox(record: ChatOutboxRecord) {
    this.db.prepare('INSERT INTO chat_outbox(id,account_id,room_id,txn_id,user_id,device_id,kind,event_type,content_sealed,target_event_id,depends_on,media_id,state,attempts,error,event_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      record.id, record.accountId, record.roomId, record.txnId, record.userId, record.deviceId, record.kind, record.eventType,
      this.cipherFor(record.accountId).sealJson(record.content, { table: 'outbox', record: record.id }), record.targetEventId ?? null,
      record.dependsOn ?? null, record.mediaId ?? null, record.state, record.attempts, record.error ?? null, record.eventId ?? null, record.createdAt, record.updatedAt
    )
  }

  updateOutbox(id: string, patch: Partial<Pick<ChatOutboxRecord, 'state' | 'attempts' | 'error' | 'eventId' | 'content'>>) {
    const current = this.outboxItem(id)
    if (!current) throw new Error('Outgoing chat item not found')
    const next = { ...current, ...patch }
    this.db.prepare('UPDATE chat_outbox SET state=?,attempts=?,error=?,event_id=?,content_sealed=?,updated_at=? WHERE id=?').run(
      next.state, next.attempts, 'error' in patch ? patch.error ?? null : current.error ?? null, next.eventId ?? null,
      this.cipherFor(current.accountId).sealJson(next.content, { table: 'outbox', record: id }), new Date().toISOString(), id
    )
    return this.outboxItem(id)!
  }

  outboxItem(id: string) {
    const row = this.db.prepare('SELECT * FROM chat_outbox WHERE id=?').get(id)
    return row ? this.outboxRecord(row) : undefined
  }

  outbox(accountId: string, roomId?: string, states?: ChatOutboxState[]): ChatOutboxRecord[] {
    const rows = roomId
      ? this.db.prepare('SELECT * FROM chat_outbox WHERE account_id=? AND room_id=? ORDER BY created_at, rowid').all(accountId, roomId)
      : this.db.prepare('SELECT * FROM chat_outbox WHERE account_id=? ORDER BY created_at, rowid').all(accountId)
    const records = rows.map((row) => this.outboxRecord(row))
    return states ? records.filter((record) => states.includes(record.state)) : records
  }

  deleteOutbox(id: string) {
    this.db.prepare('DELETE FROM chat_outbox WHERE id=?').run(id)
  }

  /** Marks interrupted dispatches for review; they are never resent automatically. */
  interruptedToReview() {
    return Number(this.db.prepare("UPDATE chat_outbox SET state='review',error='Aerio stopped while this was sending. Check the room before retrying.' WHERE state='running'").run().changes)
  }

  // Media

  insertMedia(record: ChatMediaRecord) {
    this.db.prepare('INSERT INTO chat_media(id,account_id,room_id,event_id,outbox_id,mxc,meta_sealed,mime,size,encrypted,local_path,state,last_used) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      record.id, record.accountId, record.roomId, record.eventId ?? null, record.outboxId ?? null, record.mxc ?? null,
      this.cipherFor(record.accountId).sealJson({ name: record.name, file: record.file }, { table: 'media', record: record.id }),
      record.mime, record.size, Number(record.encrypted), record.localPath ?? null, record.state, Date.now()
    )
  }

  updateMedia(id: string, patch: Partial<Pick<ChatMediaRecord, 'mxc' | 'state' | 'localPath' | 'eventId' | 'file' | 'size'>>) {
    const current = this.media(id)
    if (!current) throw new Error('Chat media not found')
    const next = { ...current, ...patch }
    this.db.prepare('UPDATE chat_media SET mxc=?,state=?,local_path=?,event_id=?,size=?,meta_sealed=?,last_used=? WHERE id=?').run(
      next.mxc ?? null, next.state, next.localPath ?? null, next.eventId ?? null, next.size,
      this.cipherFor(current.accountId).sealJson({ name: next.name, file: next.file }, { table: 'media', record: id }), Date.now(), id
    )
    return next
  }

  private mediaRecord(row: Row): ChatMediaRecord {
    const id = String(row.id)
    const accountId = String(row.account_id)
    let meta: { name?: string; file?: Record<string, unknown> } = {}
    try { meta = this.cipherFor(accountId).openJson(String(row.meta_sealed), { table: 'media', record: id }) } catch { /* Metadata that cannot be opened is shown as unnamed. */ }
    return {
      id, accountId, roomId: String(row.room_id), eventId: text(row.event_id), outboxId: text(row.outbox_id), mxc: text(row.mxc), file: meta.file,
      name: meta.name ?? 'attachment', mime: String(row.mime), size: Number(row.size), encrypted: Boolean(row.encrypted), localPath: text(row.local_path),
      state: row.state as ChatMediaRecord['state']
    }
  }

  media(id: string) {
    const row = this.db.prepare('SELECT * FROM chat_media WHERE id=?').get(id)
    return row ? this.mediaRecord(row) : undefined
  }

  mediaForEvent(accountId: string, eventId: string) {
    const row = this.db.prepare('SELECT * FROM chat_media WHERE account_id=? AND event_id=? ORDER BY rowid LIMIT 1').get(accountId, eventId)
    return row ? this.mediaRecord(row) : undefined
  }

  mediaReferences(accountId: string, roomId: string): Map<string, ChatMediaReference> {
    const map = new Map<string, ChatMediaReference>()
    for (const row of this.db.prepare('SELECT * FROM chat_media WHERE account_id=? AND room_id=?').all(accountId, roomId)) {
      const record = this.mediaRecord(row)
      const reference = { mediaId: record.id, name: record.name, size: record.size, mime: record.mime, encrypted: record.encrypted }
      if (record.eventId) map.set(record.eventId, reference)
      if (record.outboxId) map.set(`outbox:${record.outboxId}`, reference)
    }
    return map
  }

  /** Orphaned uploads whose outbox item no longer exists or was cancelled. */
  orphanedMedia(accountId: string) {
    return this.db.prepare(`SELECT * FROM chat_media WHERE account_id=? AND (state='orphan' OR (outbox_id IS NOT NULL AND state IN ('staged','uploaded') AND outbox_id NOT IN (SELECT id FROM chat_outbox WHERE state IN ('pending','running','failed','review'))))`).all(accountId).map((row) => this.mediaRecord(row))
  }

  deleteMedia(id: string) {
    this.db.prepare('DELETE FROM chat_media WHERE id=?').run(id)
  }

  // Drafts and notification checkpoints

  saveDraft(accountId: string, roomId: string, body: string) {
    if (!body) { this.db.prepare('DELETE FROM chat_drafts WHERE account_id=? AND room_id=?').run(accountId, roomId); return }
    this.db.prepare('INSERT INTO chat_drafts(account_id,room_id,body_sealed,updated_at) VALUES(?,?,?,?) ON CONFLICT(account_id,room_id) DO UPDATE SET body_sealed=excluded.body_sealed, updated_at=excluded.updated_at').run(
      accountId, roomId, this.cipherFor(accountId).seal(body, { table: 'drafts', record: roomId }), new Date().toISOString()
    )
  }

  draft(accountId: string, roomId: string) {
    const row = this.db.prepare('SELECT body_sealed FROM chat_drafts WHERE account_id=? AND room_id=?').get(accountId, roomId) as { body_sealed: string } | undefined
    return row ? this.cipherFor(accountId).open(row.body_sealed, { table: 'drafts', record: roomId }) : ''
  }

  notificationCheckpoint(accountId: string, roomId: string) {
    const row = this.db.prepare('SELECT last_ts, last_event_id FROM chat_notification_checkpoints WHERE account_id=? AND room_id=?').get(accountId, roomId) as { last_ts: number; last_event_id: string } | undefined
    return row ? { ts: Number(row.last_ts), eventId: row.last_event_id } : undefined
  }

  setNotificationCheckpoint(accountId: string, roomId: string, ts: number, eventId: string) {
    this.db.prepare('INSERT INTO chat_notification_checkpoints(account_id,room_id,last_ts,last_event_id) VALUES(?,?,?,?) ON CONFLICT(account_id,room_id) DO UPDATE SET last_ts=MAX(last_ts,excluded.last_ts), last_event_id=CASE WHEN excluded.last_ts>=last_ts THEN excluded.last_event_id ELSE last_event_id END').run(accountId, roomId, ts, eventId)
  }

  // Retention

  /**
   * Prunes decrypted history older than the account's retention and trims the
   * cached-media budget. Pending drafts and outbox items, the events they act
   * on, and notification checkpoints are never pruned. Returns media files to delete.
   */
  pruneRetention(accountId: string, now = Date.now()) {
    const account = this.getAccount(accountId)
    if (!account) return []
    const cutoff = now - account.preferences.retention.historyDays * 86_400_000
    return this.transaction(() => {
      const keep = `SELECT target_event_id FROM chat_outbox WHERE account_id=? AND state IN (${ACTIVE_OUTBOX.map(() => '?').join(',')}) AND target_event_id IS NOT NULL`
      const pruned = this.db.prepare(`SELECT DISTINCT room_id FROM chat_events WHERE account_id=? AND origin_ts<? AND event_id NOT IN (${keep})`).all(accountId, cutoff, accountId, ...ACTIVE_OUTBOX).map((row) => String(row.room_id))
      this.db.prepare(`DELETE FROM chat_events WHERE account_id=? AND origin_ts<? AND event_id NOT IN (${keep})`).run(accountId, cutoff, accountId, ...ACTIVE_OUTBOX)
      for (const roomId of pruned) this.db.prepare('UPDATE chat_rooms SET reached_start=0 WHERE account_id=? AND room_id=?').run(accountId, roomId)
      // Sent items are only needed until their event is in local history (or for a week).
      this.db.prepare("DELETE FROM chat_outbox WHERE account_id=? AND state='sent' AND (event_id IN (SELECT event_id FROM chat_events WHERE account_id=?) OR updated_at<?)").run(accountId, accountId, new Date(now - 7 * 86_400_000).toISOString())
      const paths: string[] = []
      // Media whose event was pruned becomes unreferenced.
      for (const row of this.db.prepare("SELECT id, local_path FROM chat_media WHERE account_id=? AND event_id IS NOT NULL AND outbox_id IS NULL AND event_id NOT IN (SELECT event_id FROM chat_events WHERE account_id=?)").all(accountId, accountId)) {
        if (row.local_path) paths.push(String(row.local_path))
        this.db.prepare('DELETE FROM chat_media WHERE id=?').run(String(row.id))
      }
      const budget = account.preferences.retention.mediaCacheMiB * 1024 * 1024
      let used = Number((this.db.prepare("SELECT COALESCE(SUM(size),0) AS total FROM chat_media WHERE account_id=? AND state='cached'").get(accountId) as { total: number }).total)
      for (const row of this.db.prepare("SELECT id, local_path, size FROM chat_media WHERE account_id=? AND state='cached' ORDER BY last_used").all(accountId)) {
        if (used <= budget) break
        if (row.local_path) paths.push(String(row.local_path))
        this.db.prepare("UPDATE chat_media SET state='remote', local_path=NULL WHERE id=?").run(String(row.id))
        used -= Number(row.size)
      }
      return paths
    })
  }

  /** Deletes local history and derived media while keeping the account, outbox, drafts and checkpoints. */
  clearHistory(accountId: string) {
    return this.transaction(() => {
      const paths = this.db.prepare("SELECT local_path FROM chat_media WHERE account_id=? AND outbox_id IS NULL AND local_path IS NOT NULL").all(accountId).map((row) => String(row.local_path))
      this.db.prepare('DELETE FROM chat_media WHERE account_id=? AND outbox_id IS NULL').run(accountId)
      this.db.prepare('DELETE FROM chat_events WHERE account_id=?').run(accountId)
      this.db.prepare('UPDATE chat_rooms SET reached_start=0 WHERE account_id=?').run(accountId)
      return paths
    })
  }
}
