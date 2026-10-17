import type { ChatMembership } from '../../../src/chat-types'
import type { ChatRoomUpdate } from '../chat-store'
import type { ChatStoredEvent } from '../projection'

/**
 * Converts SDK objects into plain, structured records before they leave the
 * chat service. Only these records cross IPC; SDK objects, keys and tokens
 * never do. Kept free of SDK imports so it can be tested with plain doubles.
 */
export interface MatrixEventLike {
  getId(): string | undefined
  getRoomId(): string | undefined
  getSender(): string | undefined
  getType(): string
  getStateKey(): string | undefined
  getTs(): number
  getContent(): Record<string, unknown>
  isEncrypted(): boolean
  isDecryptionFailure(): boolean
  isBeingDecrypted(): boolean
  shouldAttemptDecryption(): boolean
  isRedacted(): boolean
  getAssociatedId(): string | undefined
  getTxnId(): string | undefined
  getUnsigned(): { transaction_id?: string }
  status: unknown
  decryptionFailureReason?: string | null
}

export interface RoomLike {
  roomId: string
  name: string
  hasEncryptionStateEvent(): boolean
  getMyMembership(): string
  getDMInviter(): string | undefined
  getLastActiveTimestamp?(): number
}

const FAILURE_REASONS: Record<string, string> = {
  MEGOLM_UNKNOWN_INBOUND_SESSION_ID: 'The keys for this message have not reached this device yet',
  MEGOLM_KEY_WITHHELD: 'The sender withheld the keys for this message from this device',
  MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE: 'The sender only shares keys with verified devices. Verify this device to read it',
  HISTORICAL_MESSAGE_NO_KEY_BACKUP: 'This message predates this device and there is no key backup',
  HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED: 'This message predates this device. Restore key backup to read it',
  HISTORICAL_MESSAGE_WORKING_BACKUP: 'This message predates this device. Its keys are not in the backup',
  HISTORICAL_MESSAGE_USER_NOT_JOINED: 'You were not in the room when this was sent',
  SENDER_IDENTITY_PREVIOUSLY_VERIFIED: 'The sender’s verified identity changed. This message is not trusted',
  UNSIGNED_SENDER_DEVICE: 'The sender’s device is not verified by its owner'
}

export function decryptionReason(code: string | null | undefined) {
  return (code && FAILURE_REASONS[code]) || 'This message could not be decrypted on this device'
}

/** Undefined for local echoes and events still awaiting decryption (they are emitted once decrypted). */
export function mapMatrixEvent(event: MatrixEventLike): ChatStoredEvent | undefined {
  const eventId = event.getId()
  const roomId = event.getRoomId()
  const sender = event.getSender()
  if (!eventId || !roomId || !sender || eventId.startsWith('~') || event.status) return undefined
  if (event.isEncrypted() && !event.isDecryptionFailure() && (event.isBeingDecrypted() || event.shouldAttemptDecryption())) return undefined
  const failed = event.isEncrypted() && event.isDecryptionFailure()
  const redacted = event.isRedacted()
  const content = redacted || failed ? {} : { ...event.getContent() }
  const type = failed ? 'm.room.encrypted' : event.getType()
  if (type === 'm.room.redaction') {
    const redacts = event.getAssociatedId()
    if (redacts) content.redacts = redacts
  }
  return {
    eventId, roomId, sender, type, stateKey: event.getStateKey(), ts: event.getTs(), content,
    encrypted: event.isEncrypted(), decryptionError: failed ? decryptionReason(event.decryptionFailureReason) : undefined,
    redacted, txnId: event.getUnsigned().transaction_id ?? event.getTxnId()
  }
}

// The SDK reports Number.MIN_SAFE_INTEGER for rooms without events.
const validTimestamp = (value: number | undefined) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined

const MEMBERSHIPS = new Set<ChatMembership>(['join', 'invite', 'leave', 'ban'])

export function mapRoom(room: RoomLike, directRooms: Set<string>): ChatRoomUpdate {
  const membership = room.getMyMembership()
  const inviter = room.getDMInviter()
  return {
    roomId: room.roomId,
    name: room.name || room.roomId,
    encrypted: room.hasEncryptionStateEvent(),
    membership: MEMBERSHIPS.has(membership as ChatMembership) ? membership as ChatMembership : 'leave',
    isDirect: directRooms.has(room.roomId) || Boolean(inviter),
    inviter,
    lastActivity: validTimestamp(room.getLastActiveTimestamp?.())
  }
}

export type ServiceErrorKind = 'rejected' | 'encryption' | 'network' | 'auth' | 'other'

export interface SerializedServiceError {
  kind: ServiceErrorKind
  message: string
  code?: string
}

/** Classifies an SDK error without leaking request URLs or tokens. */
export function serializeServiceError(error: unknown): SerializedServiceError {
  const value = error as { name?: string; message?: string; errcode?: string; httpStatus?: number }
  const message = typeof value?.message === 'string' ? value.message.replace(/https?:\/\/\S+/g, '[homeserver]').replace(/access_token=[^&\s]+/g, 'access_token=[redacted]') : String(error)
  const code = typeof value?.errcode === 'string' ? value.errcode : undefined
  if (code === 'M_UNKNOWN_TOKEN' || value?.httpStatus === 401) return { kind: 'auth', message: 'The Matrix session is no longer valid. Sign in again', code }
  if (/unknowndevice|unverified|identity.*(changed|verif)|verified user|withheld|olm|megolm|encrypt/i.test(`${value?.name ?? ''} ${message}`)) return { kind: 'encryption', message, code }
  if (typeof value?.httpStatus === 'number' && value.httpStatus >= 400 && value.httpStatus < 500 && value.httpStatus !== 429 && value.httpStatus !== 408) return { kind: 'rejected', message, code }
  if (value?.name === 'ConnectionError' || /fetch failed|network|timed? ?out|ECONN|socket/i.test(message) || value?.httpStatus === 429 || (value?.httpStatus ?? 0) >= 500) return { kind: 'network', message, code }
  return { kind: 'other', message, code }
}

export class ChatServiceError extends Error {
  constructor(readonly detail: SerializedServiceError) { super(detail.message) }
}
