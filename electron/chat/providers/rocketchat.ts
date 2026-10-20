import { randomUUID } from 'node:crypto'
import type { ProviderChatDescriptor, ProviderChatMessage, ProviderChatPage, ProviderChatRoom } from '../../../src/provider-chat-types'
import { ProviderChatError, type ProviderChatAdapter, type ProviderChatConnection, type ProviderChatSession } from './adapter'

type ObjectValue = Record<string, any>
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,200}$/.test(value)
const text = (value: unknown, limit = 28_000) => typeof value === 'string' ? value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, limit) : ''
const date = (value: unknown): string | undefined => typeof value === 'string' && value.length <= 100 && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined
export function rocketChatServer(value: unknown): string {
  try {
    const url = new URL(typeof value === 'string' ? value.trim() : '')
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || /%2f|%5c|%2e/i.test(url.pathname)) throw Error()
    return url.href.replace(/\/+$/, '')
  } catch { throw new ProviderChatError('Enter the HTTPS base URL of your Rocket.Chat workspace, without credentials, query or fragment.', 'rejected') }
}

/** Official REST APIs only; encrypted rooms require Rocket.Chat's own E2EE client and are read-only here. */
export class RocketChatAdapter implements ProviderChatAdapter {
  constructor(private fetcher: typeof fetch = fetch) {}
  descriptor(): ProviderChatDescriptor {
    return { id: 'rocketchat', name: 'Rocket.Chat', available: true, detail: 'Connect your HTTPS workspace with a personal access token and user ID. Joined channels, groups, direct messages, text threads and read markers are supported. Encrypted rooms, uploads, reactions and presence are not supported.', fields: [{ key: 'server', label: 'Workspace HTTPS URL', type: 'text', required: true }, { key: 'userId', label: 'User ID', type: 'text', required: true }, { key: 'token', label: 'Personal access token', type: 'password', required: true }] }
  }
  private async request(secret: Record<string, string>, method: string, parameters: Record<string, unknown> = {}, delivery = false): Promise<ObjectValue> {
    const post = method === 'chat.sendMessage' || method === 'subscriptions.read'
    const url = new URL(`${rocketChatServer(secret.server)}/api/v1/${method}`)
    if (!id(secret.userId) || !secret.token || /[\x00-\x20\x7f]/.test(secret.token) || secret.token.length > 8192) throw new ProviderChatError('Reconnect Rocket.Chat with a valid personal access token and user ID.', 'auth')
    if (!post) for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, String(value))
    let response: Response
    try { response = await this.fetcher(url, { method: post ? 'POST' : 'GET', headers: { 'X-Auth-Token': secret.token, 'X-User-Id': secret.userId, 'Content-Type': 'application/json' }, ...(post ? { body: JSON.stringify(parameters) } : {}), redirect: 'error', signal: AbortSignal.timeout(20_000) }) }
    catch { throw new ProviderChatError(delivery ? 'Rocket.Chat delivery is unknown. Review the conversation before sending again.' : 'Rocket.Chat could not be reached.', delivery ? 'uncertain' : 'network') }
    if (response.status === 429) throw new ProviderChatError('Rocket.Chat rate limit reached. Wait before trying again.', 'rate-limit', Math.max(1, Math.min(3600, Number(response.headers.get('Retry-After')) || 60)))
    if (response.status === 401) throw new ProviderChatError('Rocket.Chat authorization expired. Reconnect your account.', 'auth')
    if (response.status === 403) throw new ProviderChatError('Rocket.Chat denied access. Check room membership and workspace permissions.', 'permission')
    if (!response.ok) throw new ProviderChatError('Rocket.Chat did not confirm this request.', delivery && response.status >= 500 ? 'uncertain' : 'rejected')
    let result: ObjectValue
    try {
      const reader = response.body?.getReader(); if (!reader) throw Error()
      const chunks: Uint8Array[] = []; let size = 0
      try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 4_000_000) throw Error(); chunks.push(part.value) } }
      finally { await reader.cancel().catch(() => {}) }
      result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw Error()
    } catch { throw new ProviderChatError('Rocket.Chat returned an invalid response.', delivery ? 'uncertain' : 'rejected') }
    if (result.success !== true) throw new ProviderChatError('Rocket.Chat rejected the request. Check access and workspace policy.', delivery && result.success !== false ? 'uncertain' : 'rejected')
    return result
  }
  async connect(input: Record<string, string | boolean>, existing?: ProviderChatSession): Promise<ProviderChatConnection> {
    const secret = { server: rocketChatServer(input.server || existing?.secret.server), userId: typeof input.userId === 'string' && input.userId.trim() || existing?.secret.userId || '', token: typeof input.token === 'string' && input.token.trim() || existing?.secret.token || '' }
    if (existing && (secret.server !== existing.secret.server || secret.userId !== existing.secret.userId)) throw new ProviderChatError('Reconnect the same Rocket.Chat workspace and user, or add another account.', 'auth')
    const result = await this.request(secret, 'me')
    if (!id(result._id) || result._id !== secret.userId) throw new ProviderChatError('Rocket.Chat returned a different account identity.', 'auth')
    const remoteUserId = `${secret.server}|${result._id}`
    if (existing && existing.account.remoteUserId !== remoteUserId) throw new ProviderChatError('Reconnect the same Rocket.Chat workspace and user, or add another account.', 'auth')
    return { remoteUserId, name: `${text(result.name || result.username, 200) || result._id} · ${new URL(secret.server).host}`, secret }
  }
  private room(session: ProviderChatSession, room: ProviderChatRoom): string {
    if (room.accountId !== session.account.id || room.resource.server !== session.secret.server || room.resource.roomId !== room.id || !id(room.id) || !['c', 'p', 'd'].includes(room.resource.type)) throw new ProviderChatError('This Rocket.Chat room does not belong to the connected workspace.', 'permission')
    return room.id
  }
  async rooms(session: ProviderChatSession): Promise<ProviderChatRoom[]> {
    const rooms = await this.request(session.secret, 'rooms.get'), subscriptions = await this.request(session.secret, 'subscriptions.get')
    if (!Array.isArray(rooms.update) || !Array.isArray(subscriptions.update) || rooms.update.length > 10_000 || subscriptions.update.length > 10_000) throw new ProviderChatError('Rocket.Chat returned an invalid room list.', 'rejected')
    const subscribed = new Map<string, ObjectValue>(subscriptions.update.filter((item: ObjectValue) => item && id(item.rid)).map((item: ObjectValue) => [item.rid, item]))
    const result: ProviderChatRoom[] = []
    for (const room of rooms.update) {
      if (!room || !id(room._id) || !['c', 'p', 'd'].includes(room.t) || room.archived) continue
      const subscription = subscribed.get(room._id); if (!subscription) continue
      const encrypted = room.encrypted === true || Boolean(room.e2eKeyId || subscription.E2EKey)
      const activity = date(room.lastMessage?.ts || room.lm)
      result.push({ accountId: session.account.id, id: room._id, name: text(subscription.fname || subscription.name || room.fname || room.name || (Array.isArray(room.usernames) ? room.usernames.join(', ') : ''), 300) || room._id, kind: room.t === 'd' ? (room.usersCount > 2 ? 'group' : 'direct') : room.t === 'p' ? 'group' : 'channel', unread: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(Number(subscription.unread) || 0))), ...(activity ? { lastActivity: activity } : {}), canSend: !encrypted && room.ro !== true && room.broadcast !== true, canReadReceipt: true, threaded: !encrypted, resource: { server: session.secret.server, roomId: room._id, type: room.t, encrypted: String(encrypted) } })
    }
    return [...new Map(result.map((item) => [item.id, item])).values()]
  }
  private message(session: ProviderChatSession, roomId: string, input: ObjectValue): ProviderChatMessage | undefined {
    if (!input || !id(input._id) || input.rid !== roomId) return
    const timestamp = date(input.ts); if (!timestamp) return
    const encrypted = input.t === 'e2e' || input.e2e === true
    return { id: input._id, senderId: text(input.u?._id, 200), sender: text(input.u?.name || input.u?.username || input.u?._id, 200) || 'Rocket.Chat', timestamp, body: encrypted ? '[Encrypted message — open Rocket.Chat to decrypt]' : text(input.msg) || (Array.isArray(input.attachments) ? input.attachments.map((item: ObjectValue) => `[Attachment: ${text(item?.title, 200) || 'attachment'}]`).join('\n').slice(0, 28_000) : ''), own: input.u?._id === session.secret.userId, ...(id(input.tmid) ? { replyToId: input.tmid } : {}), ...(input.t === 'rm' ? { deleted: true } : {}) }
  }
  async messages(session: ProviderChatSession, room: ProviderChatRoom, options: { cursor?: string; threadId?: string }): Promise<ProviderChatPage> {
    const roomId = this.room(session, room)
    if (room.resource.encrypted === 'true') throw new ProviderChatError('Open Rocket.Chat to view this encrypted room. Aerio does not hold its encryption keys.', 'permission')
    if (options.threadId && !id(options.threadId)) throw new ProviderChatError('Invalid Rocket.Chat thread.', 'rejected')
    const offset = options.cursor === undefined ? 0 : /^\d{1,7}$/.test(options.cursor) ? Number(options.cursor) : -1
    if (offset < 0 || offset > 1_000_000) throw new ProviderChatError('Invalid Rocket.Chat history position.', 'rejected')
    const result = await this.request(session.secret, options.threadId ? 'chat.getThreadMessages' : `${room.resource.type === 'c' ? 'channels' : room.resource.type === 'p' ? 'groups' : 'im'}.history`, { ...(options.threadId ? { tmid: options.threadId } : { roomId, showThreadMessages: false }), count: 50, offset, sort: JSON.stringify({ ts: -1, _id: -1 }) })
    if (!Array.isArray(result.messages) || result.messages.length > 1000 || result.messages.some((item: ObjectValue) => item && item.rid !== roomId)) throw new ProviderChatError('Rocket.Chat returned invalid room history.', 'rejected')
    const items = result.messages.map((item: ObjectValue) => this.message(session, roomId, item)).filter((item: ProviderChatMessage | undefined): item is ProviderChatMessage => Boolean(item)).sort((a: ProviderChatMessage, b: ProviderChatMessage) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id))
    const more = Number.isSafeInteger(result.total) ? offset + result.messages.length < result.total : result.messages.length === 50
    if (more && !result.messages.length) throw new ProviderChatError('Rocket.Chat history did not advance.', 'rejected')
    return { items, ...(more ? { cursor: String(offset + result.messages.length) } : {}) }
  }
  async send(session: ProviderChatSession, room: ProviderChatRoom, body: string, threadId?: string, clientRequestId: string = randomUUID()): Promise<ProviderChatMessage> {
    const roomId = this.room(session, room)
    if (!room.canSend || room.resource.encrypted === 'true') throw new ProviderChatError('Sending is unavailable in this read-only or encrypted room.', 'permission')
    if (!body.trim() || body.length > 28_000 || !id(clientRequestId) || threadId && !id(threadId)) throw new ProviderChatError('Enter a valid Rocket.Chat message and thread.', 'rejected')
    // Room encryption/membership may have changed since the last background poll.
    const current = (await this.rooms(session)).find((item) => item.id === roomId)
    if (!current?.canSend || current.resource.encrypted === 'true') throw new ProviderChatError('The Rocket.Chat room became read-only, encrypted or unavailable. Refresh before sending.', 'permission')
    const result = await this.request(session.secret, 'chat.sendMessage', { message: { _id: clientRequestId, rid: roomId, msg: body, ...(threadId ? { tmid: threadId } : {}) }, previewUrls: [] }, true)
    const sent = this.message(session, roomId, result.message)
    if (!sent || sent.id !== clientRequestId) throw new ProviderChatError('Rocket.Chat did not identify the sent message. Review delivery before trying again.', 'uncertain')
    return sent
  }
  async markRead(session: ProviderChatSession, room: ProviderChatRoom): Promise<void> { await this.request(session.secret, 'subscriptions.read', { roomId: this.room(session, room) }) }
}
