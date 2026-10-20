import type { ProviderChatDescriptor, ProviderChatMessage, ProviderChatPage, ProviderChatRoom } from '../../../src/provider-chat-types'
import type { ProviderChatAdapter, ProviderChatConnection, ProviderChatSession } from './adapter'
import { IceWarpApi, IceWarpApiError, iceWarpId, iceWarpServer, iceWarpText, iceWarpTimestamp, type IceWarpObject } from '../../icewarp-api'

/** TeamChat rooms and threaded text through IceWarp's actual user API; no admin API or REST bridge. */
export class IceWarpChatAdapter implements ProviderChatAdapter {
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  descriptor(): ProviderChatDescriptor {
    return { id: 'icewarp', name: 'IceWarp TeamChat', available: true, detail: 'Connect an HTTPS IceWarp server with a TeamChat token, or username and password to obtain one. Active joined rooms, paged thread history, text posts and comments are supported. Refresh polls for updates. Direct conversations, uploads, reactions, calls and read markers are unavailable.', fields: [{ key: 'server', label: 'IceWarp server HTTPS URL', type: 'text', required: true }, { key: 'token', label: 'TeamChat API token (or sign in below)', type: 'password' }, { key: 'username', label: 'Username (when obtaining a token)', type: 'text' }, { key: 'password', label: 'Password (used once to obtain a token)', type: 'password' }] }
  }
  private api(session: ProviderChatSession) { return new IceWarpApi(session.secret.server, session.secret.token, this.fetcher) }
  async connect(input: Record<string, string | boolean>, existing?: ProviderChatSession): Promise<ProviderChatConnection> {
    const server = iceWarpServer(input.server || existing?.secret.server)
    if (existing && server !== iceWarpServer(existing.secret.server)) throw new IceWarpApiError('Reconnect the same IceWarp server, or add another account. Saved credentials cannot be sent to a different server.', 'auth')
    if (existing && typeof input.username === 'string' && input.username.trim() && input.username.trim().toLowerCase() !== existing.secret.user.toLowerCase()) throw new IceWarpApiError('Reconnect the same IceWarp user, or add another account.', 'auth')
    let token = typeof input.token === 'string' && input.token.trim() || existing?.secret.token || ''
    let owned = existing?.secret.owned ?? 'false'
    if (typeof input.token === 'string' && input.token.trim()) owned = 'false'
    if (typeof input.password === 'string' && input.password) {
      if (typeof input.username !== 'string' || !input.username.trim() || input.username.length > 320 || input.password.length > 4096) throw new IceWarpApiError('Enter an IceWarp username and password, or a TeamChat token.', 'auth')
      const login = await new IceWarpApi(server, '', this.fetcher).request('iwauthentication.login.plain', { username: input.username.trim(), password: input.password })
      if (!['true', true].includes(login.authorized) || typeof login.token !== 'string' || !login.token) throw new IceWarpApiError('IceWarp did not authorize this sign-in. Use a server-issued TeamChat token if single sign-on or MFA is required.', 'auth')
      token = login.token; owned = 'true'
    }
    const identity = await new IceWarpApi(server, token, this.fetcher).request('auth.test')
    if (!iceWarpId(identity.user_id) || typeof identity.user !== 'string' || !identity.user) throw new IceWarpApiError('IceWarp did not identify the connected user.', 'auth')
    const remoteUserId = `${server}|${identity.user_id}`
    if (existing && existing.account.remoteUserId !== remoteUserId) throw new IceWarpApiError('Reconnect the same IceWarp server and user, or add another account.', 'auth')
    return { remoteUserId, name: `${iceWarpText(identity.user, 320)} · ${new URL(server).host}`, secret: { server, token, user: identity.user, userId: identity.user_id, owned } }
  }
  private room(session: ProviderChatSession, room: ProviderChatRoom) {
    if (room.accountId !== session.account.id || room.resource.server !== session.secret.server || room.resource.channel !== room.id || !iceWarpId(room.id)) throw new IceWarpApiError('This TeamChat room belongs to another account or server.', 'permission')
    return room.id
  }
  async rooms(session: ProviderChatSession): Promise<ProviderChatRoom[]> {
    const result = await this.api(session).request('channels.list', { collection_type: '1', include_unread_count: true, include_permissions: true })
    if (!Array.isArray(result.channels) || result.channels.length > 10_000) throw new IceWarpApiError('IceWarp returned an invalid room list.', 'rejected')
    return result.channels.filter((channel: IceWarpObject) => channel && iceWarpId(channel.id) && channel.is_member === true && channel.is_active === true).map((channel: IceWarpObject) => ({ accountId: session.account.id, id: channel.id, name: iceWarpText(channel.name, 300) || channel.id, kind: 'channel' as const, unread: Math.max(0, Math.min(1_000_000, Math.floor(Number(channel.unread_count) || 0))), canSend: channel.permissions?.items_write !== false, canReadReceipt: false, threaded: true, resource: { server: session.secret.server, channel: channel.id } }))
  }
  private message(session: ProviderChatSession, channel: string, data: IceWarpObject, threadId?: string): ProviderChatMessage | undefined {
    if (!data || !iceWarpTimestamp(data.ts) || (data.channel !== undefined && data.channel !== channel) || (threadId && data.thread_ts && data.thread_ts !== threadId)) return
    const ms = Number(data.ts) * 1000
    if (!Number.isFinite(ms) || ms > 8.64e15) return
    return { id: data.ts, senderId: iceWarpText(data.user, 320), sender: iceWarpText(data.user_name || data.user, 320) || 'IceWarp', timestamp: new Date(ms).toISOString(), body: iceWarpText(data.text) || (Array.isArray(data.attachments) && data.attachments.length ? '[Attachment — open IceWarp to view]' : ''), own: data.user === session.secret.user, ...(threadId || iceWarpTimestamp(data.thread_ts) ? { replyToId: threadId || data.thread_ts } : {}) }
  }
  async messages(session: ProviderChatSession, room: ProviderChatRoom, options: { cursor?: string; threadId?: string }): Promise<ProviderChatPage> {
    const channel = this.room(session, room)
    const page = options.cursor === undefined ? 1 : /^[1-9]\d{0,3}$/.test(options.cursor) ? Number(options.cursor) : 0
    if (!page || options.threadId && !iceWarpTimestamp(options.threadId)) throw new IceWarpApiError('Invalid TeamChat history page or thread.', 'rejected')
    const result = await this.api(session).request(options.threadId ? 'threads.comments' : 'threads.list', { channel, count: 50, page, ...(options.threadId ? { ts: options.threadId } : {}) })
    if (!Array.isArray(result.messages) || result.messages.length > 1000 || result.messages.some((message: IceWarpObject) => message && message.channel !== undefined && message.channel !== channel)) throw new IceWarpApiError('IceWarp returned invalid room history.', 'rejected')
    const items = result.messages.map((data: IceWarpObject) => this.message(session, channel, data, options.threadId)).filter((value: ProviderChatMessage | undefined): value is ProviderChatMessage => Boolean(value)).sort((a: ProviderChatMessage, b: ProviderChatMessage) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id))
    const more = result.has_more === true || Number(result.paging?.pages) > page
    if (more && (!items.length || page >= 9999)) throw new IceWarpApiError('IceWarp history did not advance within supported limits.', 'rejected')
    return { items, ...(more ? { cursor: String(page + 1) } : {}) }
  }
  async send(session: ProviderChatSession, room: ProviderChatRoom, body: string, threadId?: string): Promise<ProviderChatMessage> {
    const channel = this.room(session, room)
    if (!room.canSend || !body.trim() || body.length > 28_000 || threadId && !iceWarpTimestamp(threadId)) throw new IceWarpApiError('Enter a valid message in a writable TeamChat room.', 'rejected')
    const current = (await this.api(session).request('channels.info', { channel, include_permissions: true, exclude_members: true })).channel
    if (!current || current.id !== channel || current.is_member !== true || current.is_active !== true) throw new IceWarpApiError('The TeamChat room is no longer joined and active.', 'permission')
    const permissions = (await this.api(session).request('channels.userPermissions', { channel })).permissions
    if (permissions?.items_write !== true) throw new IceWarpApiError('IceWarp does not permit posting in this room.', 'permission')
    // No documented client message ID: a lost receipt is uncertain and must never be replayed automatically.
    const result = await this.api(session).request('chat.postMessage', { channel, text: body, ...(threadId ? { ts: threadId } : {}) }, true)
    if (result.channel !== undefined && result.channel !== channel) throw new IceWarpApiError('IceWarp did not identify the sent room. Review delivery before retrying.', 'uncertain')
    const sent = this.message(session, channel, result.message, threadId)
    if (!sent || sent.senderId !== session.secret.user || sent.body !== iceWarpText(body)) throw new IceWarpApiError('IceWarp did not confirm the sent message. Review delivery before retrying.', 'uncertain')
    return sent
  }
  async disconnect(session: ProviderChatSession) { if (session.secret.owned === 'true') await this.api(session).request('auth.revoke') }
}
