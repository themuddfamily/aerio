import { randomUUID } from 'node:crypto'
import type { ChatOutboxKind } from '../../src/chat-types'
import type { ChatStore } from './chat-store'
import type { ChatOutboxRecord } from './projection'

/**
 * Durable outgoing messages. A transaction ID and the original room, user and
 * device scope are persisted before a local echo is shown. Dispatch reuses the
 * same transaction ID for every attempt, so a lost response can be retried
 * without duplicating (Matrix deduplicates sends per device/token and txn ID).
 * An item interrupted mid-dispatch by a restart goes to `review` unless sync
 * evidence already resolved it; it is never resent blindly.
 */
export interface ChatDispatcher {
  send(accountId: string, roomId: string, eventType: string, content: Record<string, unknown>, txnId: string): Promise<string>
  redact(accountId: string, roomId: string, eventId: string, txnId: string): Promise<string>
  /** Uploads the staged media and returns content to merge into the message (`url` or `file`). */
  upload?(accountId: string, record: ChatOutboxRecord): Promise<Record<string, unknown>>
}

export interface ChatDispatchScope {
  userId: string
  deviceId: string
  /** False while locked without send-while-locked, while offline, or when the account is paused. */
  canSend: boolean
}

/** A failure the server answered definitively (no point retrying with the same content). */
export class ChatSendRejected extends Error {}
/** A crypto/trust failure: the room's writes are held. Never downgraded to plaintext. */
export class ChatEncryptionFailure extends Error {}

const MAX_BODY = 32_000

export class ChatOutbox {
  private running = new Map<string, Promise<void>>()

  constructor(private readonly store: ChatStore, private readonly dispatcher: ChatDispatcher, private readonly changed: (accountId: string, roomId: string) => void = () => {}) {}

  enqueue(input: { accountId: string; roomId: string; userId: string; deviceId: string; kind: ChatOutboxKind; eventType: string; content: Record<string, unknown>; targetEventId?: string; dependsOn?: string; mediaId?: string }): ChatOutboxRecord {
    if (typeof input.content.body === 'string' && input.content.body.length > MAX_BODY) throw new Error('This message is too long to send')
    const now = new Date().toISOString()
    const record: ChatOutboxRecord = {
      id: randomUUID(), txnId: `aerio-${randomUUID()}`, state: 'pending', attempts: 0, createdAt: now, updatedAt: now,
      accountId: input.accountId, roomId: input.roomId, userId: input.userId, deviceId: input.deviceId, kind: input.kind,
      eventType: input.eventType, content: input.content, targetEventId: input.targetEventId, dependsOn: input.dependsOn, mediaId: input.mediaId
    }
    this.store.insertOutbox(record)
    this.changed(record.accountId, record.roomId)
    return record
  }

  /** Changes an undispatched message in place. Once dispatched, changes are separate edit operations. */
  editPending(id: string, content: Record<string, unknown>) {
    const item = this.store.outboxItem(id)
    if (!item || item.state !== 'pending') throw new Error('Only a message that has not been sent can be changed in place')
    this.store.updateOutbox(id, { content })
    this.changed(item.accountId, item.roomId)
  }

  /** Cancels an item that has not been dispatched (and anything depending on it). */
  cancel(id: string) {
    const item = this.store.outboxItem(id)
    if (!item) return
    if (item.state === 'running') throw new Error('This message is being sent and can no longer be cancelled')
    if (item.state === 'sent') throw new Error('This message was already sent. Delete it instead')
    for (const dependent of this.store.outbox(item.accountId, item.roomId).filter((other) => other.dependsOn === id && other.state !== 'sent')) this.cancel(dependent.id)
    if (item.mediaId) {
      const media = this.store.media(item.mediaId)
      // An upload that already reached the server is a tracked orphan, not a delivered attachment.
      if (media && media.state === 'uploaded') this.store.updateMedia(media.id, { state: 'orphan' })
    }
    this.store.deleteOutbox(id)
    this.changed(item.accountId, item.roomId)
  }

  /** Moves a reviewed or failed item back to pending with the same transaction ID. */
  retry(id: string, scope: Pick<ChatDispatchScope, 'deviceId'>) {
    const item = this.store.outboxItem(id)
    if (!item || (item.state !== 'review' && item.state !== 'failed')) throw new Error('Only failed or interrupted messages can be retried')
    if (item.deviceId !== scope.deviceId) throw new Error('This message was queued on a different device session. Copy it into a new message instead')
    this.store.updateOutbox(id, { state: 'pending', error: undefined })
    this.changed(item.accountId, item.roomId)
  }

  /** Startup reconciliation: interrupted dispatches go to review unless sync already confirmed them. */
  recover() {
    return this.store.interruptedToReview()
  }

  /** Dispatches pending items for one account in order. Other accounts progress independently. */
  dispatch(accountId: string, scope: ChatDispatchScope): Promise<void> {
    const existing = this.running.get(accountId)
    if (existing) return existing
    const run = this.drain(accountId, scope).finally(() => this.running.delete(accountId))
    this.running.set(accountId, run)
    return run
  }

  private async drain(accountId: string, scope: ChatDispatchScope) {
    if (!scope.canSend) return
    const blockedRooms = new Set<string>()
    for (;;) {
      const all = this.store.outbox(accountId)
      const next = all.find((item) => item.state === 'pending' && !blockedRooms.has(item.roomId))
      if (!next) return
      const held = this.store.room(accountId, next.roomId)?.held
      // Serialize per room: `next` is the room's first pending item, so any
      // earlier unsent item (failed, review) holds it and everything after it.
      const roomItems = all.filter((item) => item.roomId === next.roomId)
      const earlierUnresolved = roomItems.slice(0, roomItems.indexOf(next)).some((item) => item.state !== 'sent')
      const dependency = next.dependsOn ? this.store.outboxItem(next.dependsOn) : undefined
      if (held || earlierUnresolved || (dependency && dependency.state !== 'sent')) { blockedRooms.add(next.roomId); continue }
      if (next.userId !== this.store.getAccount(accountId)?.userId || next.deviceId !== scope.deviceId) {
        this.store.updateOutbox(next.id, { state: 'review', error: 'The account signed in again as a different device. Review this message before sending it.' })
        this.changed(accountId, next.roomId)
        continue
      }
      await this.sendOne(next, dependency)
    }
  }

  private async sendOne(item: ChatOutboxRecord, dependency?: ChatOutboxRecord) {
    this.store.updateOutbox(item.id, { state: 'running', attempts: item.attempts + 1 })
    this.changed(item.accountId, item.roomId)
    try {
      const target = item.targetEventId ?? dependency?.eventId
      let eventId: string
      if (item.kind === 'redaction') {
        if (!target) throw new ChatSendRejected('The message to delete has not been sent')
        eventId = await this.dispatcher.redact(item.accountId, item.roomId, target, item.txnId)
      } else {
        let content = item.content
        if ((item.kind === 'edit' || item.kind === 'reaction') && target) {
          const relation = content['m.relates_to'] as Record<string, unknown>
          content = { ...content, 'm.relates_to': { ...relation, event_id: target } }
        }
        if (item.kind === 'media') {
          if (!this.dispatcher.upload) throw new ChatSendRejected('Attachments are not available for this account')
          content = { ...content, ...await this.dispatcher.upload(item.accountId, item) }
        }
        eventId = await this.dispatcher.send(item.accountId, item.roomId, item.eventType, content, item.txnId)
      }
      // The sync echo may already have resolved this item; both paths converge on the same event.
      const current = this.store.outboxItem(item.id)
      if (current) this.store.updateOutbox(item.id, { state: 'sent', eventId, error: undefined })
      if (item.mediaId && this.store.media(item.mediaId)) this.store.updateMedia(item.mediaId, { state: 'sent', eventId })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof ChatEncryptionFailure) {
        this.store.updateOutbox(item.id, { state: 'failed', error: message })
        this.store.setRoomFlags(item.accountId, item.roomId, { held: `Encryption or device trust needs attention: ${message}` })
      } else if (error instanceof ChatSendRejected) {
        this.store.updateOutbox(item.id, { state: 'failed', error: message })
      } else {
        // No definitive answer (network loss, timeout): keep the same transaction for a safe retry.
        this.store.updateOutbox(item.id, { state: 'pending', error: message })
        this.changed(item.accountId, item.roomId)
        throw error
      }
    }
    this.changed(item.accountId, item.roomId)
  }
}
