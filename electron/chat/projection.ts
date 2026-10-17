import type { ChatMediaReference, ChatOutboxKind, ChatOutboxState, ChatReaction, ChatTimelineItem, ChatTimelineKind } from '../../src/chat-types'

/**
 * Derives the visible timeline from immutable stored events. Edits, replies,
 * reactions and redactions never rewrite the underlying event: they are applied
 * here, and only after validating the sender, room and target. A relationship
 * whose target is not in local history waits for it rather than touching an
 * unrelated event. Undecryptable events stay visible with their reason.
 */
export interface ChatStoredEvent {
  eventId: string
  roomId: string
  sender: string
  type: string
  stateKey?: string
  ts: number
  /** Decrypted clear content; empty for redacted or undecryptable events. */
  content: Record<string, unknown>
  encrypted: boolean
  decryptionError?: string
  redacted: boolean
  txnId?: string
}

export interface ChatOutboxRecord {
  id: string
  accountId: string
  roomId: string
  txnId: string
  userId: string
  deviceId: string
  kind: ChatOutboxKind
  eventType: string
  content: Record<string, unknown>
  /** For edits, redactions and reactions: the confirmed event they act on. */
  targetEventId?: string
  /** An earlier outbox item that must be sent first. */
  dependsOn?: string
  mediaId?: string
  state: ChatOutboxState
  attempts: number
  error?: string
  eventId?: string
  createdAt: string
  updatedAt: string
}

export interface RelationInfo {
  relType?: string
  target?: string
  key?: string
  inReplyTo?: string
}

const MEDIA_TYPES = new Set(['m.image', 'm.file', 'm.video', 'm.audio'])
const MAX_REACTION_KEY = 64

export function relationOf(content: Record<string, unknown>): RelationInfo {
  const relation = content['m.relates_to']
  if (!relation || typeof relation !== 'object') return {}
  const value = relation as Record<string, unknown>
  const inReplyTo = (value['m.in_reply_to'] as { event_id?: unknown } | undefined)?.event_id
  return {
    relType: typeof value.rel_type === 'string' ? value.rel_type : undefined,
    target: typeof value.event_id === 'string' ? value.event_id : undefined,
    key: typeof value.key === 'string' ? value.key : undefined,
    inReplyTo: typeof inReplyTo === 'string' ? inReplyTo : undefined
  }
}

/** Removes the legacy `> quoted` reply fallback from a reply body. */
export function stripReplyFallback(body: string) {
  const lines = body.split('\n')
  let index = 0
  while (index < lines.length && lines[index].startsWith('>')) index += 1
  if (index === 0) return body
  if (lines[index] === '') index += 1
  return lines.slice(index).join('\n')
}

const isEdit = (event: ChatStoredEvent) => event.type === 'm.room.message' && relationOf(event.content).relType === 'm.replace'
const isBaseMessage = (event: ChatStoredEvent) => (event.type === 'm.room.message' && !isEdit(event)) || event.type === 'm.sticker' || (event.type === 'm.room.encrypted')

function kindOf(event: ChatStoredEvent): ChatTimelineKind {
  if (event.redacted) return 'redacted'
  if (event.type === 'm.room.encrypted') return 'undecryptable'
  if (event.type === 'm.room.member') return 'membership'
  if (event.type === 'm.sticker') return 'media'
  const msgtype = event.content.msgtype
  if (msgtype === 'm.text') return 'text'
  if (msgtype === 'm.notice') return 'notice'
  if (msgtype === 'm.emote') return 'emote'
  if (typeof msgtype === 'string' && MEDIA_TYPES.has(msgtype)) return 'media'
  return 'unsupported'
}

function bodyOf(content: Record<string, unknown>, reply: boolean) {
  const body = typeof content.body === 'string' ? content.body : undefined
  return body !== undefined && reply ? stripReplyFallback(body) : body
}

function membershipText(event: ChatStoredEvent) {
  const target = event.stateKey ?? event.sender
  const membership = event.content.membership
  if (event.redacted) return undefined
  if (membership === 'join') return `${target} joined`
  if (membership === 'invite') return `${event.sender} invited ${target}`
  if (membership === 'leave') return event.sender === target ? `${target} left` : `${event.sender} removed ${target}`
  if (membership === 'ban') return `${event.sender} banned ${target}`
  return undefined
}

function latestFirst(a: ChatStoredEvent, b: ChatStoredEvent) {
  return b.ts - a.ts || (a.eventId < b.eventId ? 1 : -1)
}

/** Valid edits keyed by target, newest first. */
export function validEdits(events: ChatStoredEvent[], byId: Map<string, ChatStoredEvent>) {
  const edits = new Map<string, ChatStoredEvent>()
  for (const edit of events.filter((event) => isEdit(event) && !event.redacted).sort(latestFirst)) {
    const target = byId.get(relationOf(edit.content).target ?? '')
    const replacement = edit.content['m.new_content']
    if (!target || target.redacted || target.type !== 'm.room.message' || isEdit(target)) continue
    if (target.sender !== edit.sender || target.roomId !== edit.roomId) continue
    if (!replacement || typeof replacement !== 'object' || typeof (replacement as { body?: unknown }).body !== 'string') continue
    if (!edits.has(target.eventId)) edits.set(target.eventId, edit)
  }
  return edits
}

export interface ProjectionContext {
  ownUserId: string
  outbox?: ChatOutboxRecord[]
  media?: Map<string, ChatMediaReference>
  /** Outbox media keyed by outbox ID, for pending attachment echoes. */
  outboxMedia?: Map<string, ChatMediaReference>
}

export function projectTimeline(events: ChatStoredEvent[], context: ProjectionContext): ChatTimelineItem[] {
  const byId = new Map(events.map((event) => [event.eventId, event]))
  const edits = validEdits(events, byId)
  const reactions = new Map<string, Map<string, Set<string>>>()
  for (const event of events) {
    if (event.type !== 'm.reaction' || event.redacted) continue
    const relation = relationOf(event.content)
    const target = byId.get(relation.target ?? '')
    if (relation.relType !== 'm.annotation' || !relation.key || relation.key.length > MAX_REACTION_KEY || !target || target.redacted || target.roomId !== event.roomId) continue
    if (!reactions.has(target.eventId)) reactions.set(target.eventId, new Map())
    const keys = reactions.get(target.eventId)!
    if (!keys.has(relation.key)) keys.set(relation.key, new Set())
    keys.get(relation.key)!.add(event.sender)
  }
  const outbox = context.outbox ?? []
  const outboxByTxn = new Map(outbox.map((item) => [item.txnId, item]))
  const confirmedTxns = new Set<string>()
  const items: ChatTimelineItem[] = []
  for (const event of events) {
    const membership = event.type === 'm.room.member'
    if (!isBaseMessage(event) && !membership) continue
    const kind = kindOf(event)
    const edit = edits.get(event.eventId)
    const content = edit ? (edit.content['m.new_content'] as Record<string, unknown>) : event.content
    const relation = relationOf(event.content)
    const replyTarget = relation.inReplyTo ? byId.get(relation.inReplyTo) : undefined
    const replyEdit = replyTarget ? edits.get(replyTarget.eventId) : undefined
    const ownEcho = event.txnId ? outboxByTxn.get(event.txnId) : undefined
    if (ownEcho) confirmedTxns.add(ownEcho.txnId)
    const body = membership ? membershipText(event) : kind === 'redacted' || kind === 'undecryptable' ? undefined : bodyOf(content, Boolean(relation.inReplyTo))
    if (membership && !body) continue
    const keyed = reactions.get(event.eventId)
    items.push({
      id: event.eventId,
      eventId: event.eventId,
      outboxId: ownEcho?.id,
      sender: event.sender,
      timestamp: new Date(event.ts).toISOString(),
      kind,
      body,
      edited: Boolean(edit),
      encrypted: event.encrypted,
      decryptionError: kind === 'undecryptable' ? event.decryptionError ?? 'The keys for this message are not available on this device' : undefined,
      replyTo: relation.inReplyTo ? {
        eventId: relation.inReplyTo,
        sender: replyTarget?.sender,
        body: replyTarget && !replyTarget.redacted ? bodyOf(replyEdit ? replyEdit.content['m.new_content'] as Record<string, unknown> : replyTarget.content, true) : undefined,
        missing: !replyTarget
      } : undefined,
      reactions: keyed ? [...keyed].map(([key, senders]): ChatReaction => ({ key, count: senders.size, mine: senders.has(context.ownUserId) })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)) : [],
      media: kind === 'media' ? context.media?.get(event.eventId) : undefined,
      delivery: ownEcho ? 'sent' : undefined,
      own: event.sender === context.ownUserId
    })
  }
  for (const item of outbox) {
    if ((item.kind !== 'message' && item.kind !== 'media') || confirmedTxns.has(item.txnId) || (item.eventId && byId.has(item.eventId))) continue
    const relation = relationOf(item.content)
    const replyTarget = relation.inReplyTo ? byId.get(relation.inReplyTo) : undefined
    items.push({
      id: item.eventId ?? item.id,
      eventId: item.eventId,
      outboxId: item.id,
      sender: item.userId,
      timestamp: item.createdAt,
      kind: item.kind === 'media' ? 'media' : 'text',
      body: bodyOf(item.content, Boolean(relation.inReplyTo)),
      edited: false,
      encrypted: false,
      replyTo: relation.inReplyTo ? { eventId: relation.inReplyTo, sender: replyTarget?.sender, body: replyTarget ? bodyOf(replyTarget.content, true) : undefined, missing: !replyTarget } : undefined,
      reactions: [],
      media: item.mediaId ? context.outboxMedia?.get(item.id) : undefined,
      delivery: item.state,
      deliveryError: item.error,
      own: true
    })
  }
  return items.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id))
}

/** Plain text per retained, unredacted message (latest valid edit applied) for local search. */
export function searchableText(events: ChatStoredEvent[]) {
  const byId = new Map(events.map((event) => [event.eventId, event]))
  const edits = validEdits(events, byId)
  return events.filter((event) => event.type === 'm.room.message' && !isEdit(event) && !event.redacted).flatMap((event) => {
    const edit = edits.get(event.eventId)
    const body = bodyOf(edit ? edit.content['m.new_content'] as Record<string, unknown> : event.content, Boolean(relationOf(event.content).inReplyTo))
    return body ? [{ event, body }] : []
  })
}
