import type { ChatRoomSummary } from '../../src/chat-types'
import type { ChatAccountRecord } from './chat-store'
import type { ChatStoredEvent } from './projection'
import { relationOf } from './projection'

/**
 * Chat notification policy. Notifications are generic by default (no body or
 * room name). A preview requires the account preference, a room that allows
 * previews, and an unlocked app. Mute, membership, paused accounts and the
 * global notification switch always apply, and a persisted per-room checkpoint
 * prevents restart or history replay from notifying again.
 */
export interface ChatNotificationContext {
  account: ChatAccountRecord
  room?: ChatRoomSummary
  globalEnabled: boolean
  locked: boolean
  checkpoint?: { ts: number; eventId: string }
  /** Events older than this (e.g. before the account connected) are history, not news. */
  notBefore: number
}

export interface ChatNotificationPlan {
  title: string
  body: string
  accountId: string
  roomId: string
  eventId: string
}

const NOTIFIABLE = new Set(['m.room.message', 'm.room.encrypted', 'm.sticker'])

export function chatNotificationFor(event: ChatStoredEvent, context: ChatNotificationContext): ChatNotificationPlan | undefined {
  const { account, room } = context
  if (!context.globalEnabled || account.status === 'paused' || account.status === 'needs-auth') return undefined
  if (!room || room.muted) return undefined
  if (event.sender === account.userId || event.redacted) return undefined
  if (event.ts < context.notBefore) return undefined
  if (context.checkpoint && (event.ts < context.checkpoint.ts || event.eventId === context.checkpoint.eventId)) return undefined
  const base = { accountId: account.id, roomId: event.roomId, eventId: event.eventId }
  if (room.membership === 'invite') {
    if (event.type !== 'm.room.member' || event.stateKey !== account.userId) return undefined
    return { ...base, title: 'New chat invitation', body: 'Open Aerio to review it' }
  }
  if (room.membership !== 'join' || !NOTIFIABLE.has(event.type)) return undefined
  // Edits and other relations are not new messages.
  if (relationOf(event.content).relType === 'm.replace') return undefined
  const previewAllowed = account.preferences.notificationPreviews && room.previews && !context.locked && !event.decryptionError && typeof event.content.body === 'string'
  if (!previewAllowed) return { ...base, title: 'New chat message', body: 'Open Aerio to read it' }
  const body = String(event.content.body).replace(/\s+/g, ' ').trim()
  return { ...base, title: room.name, body: body.length > 140 ? `${body.slice(0, 139)}…` : body || 'New message' }
}
