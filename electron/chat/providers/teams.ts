import sanitizeHtml from 'sanitize-html'
import { decodeHTML } from 'entities'
import type { ProviderChatMessage, ProviderChatRoom } from '../../../src/provider-chat-types'
import { ProviderChatError, type ProviderChatAdapter, type ProviderChatSession } from './adapter'

export const TEAMS_CHAT_SCOPES = ['Chat.ReadWrite', 'ChatMessage.Send']
export const TEAMS_CHANNEL_SCOPES = ['Team.ReadBasic.All', 'Channel.ReadBasic.All', 'ChannelMessage.Read.All', 'ChannelMessage.Send']
const graph = 'https://graph.microsoft.com/v1.0'
const text = (value: unknown, limit = 65_536) => typeof value === 'string' ? value.slice(0, limit) : ''
const pathId = (value: string) => encodeURIComponent(value)
const plain = (value: unknown) => decodeHTML(sanitizeHtml(text(value).replace(/<\/(?:p|div|li)>|<br\s*\/?\s*>/gi, '\n'), { allowedTags: [], allowedAttributes: {} })).trim()
const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : '1970-01-01T00:00:00.000Z'

export interface TeamsChatDependencies {
  configured(): boolean
  authorize(expected: { accountId: string; email: string } | undefined, scopes: string[]): Promise<{ accountId: string; email: string; displayName: string }>
  token(accountId: string): Promise<string>
  scopes(accountId: string): string[] | undefined
  request?: typeof fetch
}

export class TeamsChatAdapter implements ProviderChatAdapter {
  constructor(private readonly deps: TeamsChatDependencies) {}
  descriptor() {
    return { id: 'teams' as const, name: 'Microsoft Teams', available: this.deps.configured(), detail: 'Work or school account via Microsoft Graph. Chats; optionally joined-team channels with administrator consent. Teams encryption is managed by Microsoft, not Matrix E2EE.', fields: [{ key: 'channels', label: 'Include joined-team channels (additional permissions; administrator consent may be required)', type: 'checkbox' as const }] }
  }
  private async json(accountId: string, path: string, method = 'GET', body?: unknown, expectedPath?: string): Promise<any> {
    const url = new URL(path.startsWith('https:') ? path : graph + path)
    if (url.origin !== 'https://graph.microsoft.com' || !url.pathname.startsWith('/v1.0/') || url.username || url.password || (expectedPath && url.pathname !== expectedPath) || url.href.length > 12_000) throw new ProviderChatError('Invalid Teams pagination or resource URL', 'rejected')
    let response: Response
    let token: string
    try { token = await this.deps.token(accountId) } catch { throw new ProviderChatError('Teams sign-in expired. Reconnect this account.', 'auth') }
    try {
      response = await (this.deps.request ?? fetch)(url, { method, redirect: 'error', signal: AbortSignal.timeout(20_000), headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    } catch (error) {
      if (error instanceof ProviderChatError) throw error
      if (method !== 'GET') throw new ProviderChatError('Teams did not confirm this operation. Check Teams before sending again.', 'uncertain')
      throw new ProviderChatError('Teams could not be reached. Check your connection or reconnect the account.', 'network')
    }
    if (!response.ok) {
      const kind = response.status === 401 ? 'auth' : response.status === 403 ? 'permission' : response.status === 429 ? 'rate-limit' : response.status >= 500 && method !== 'GET' ? 'uncertain' : 'rejected'
      const message = kind === 'auth' ? 'Teams sign-in expired. Reconnect this account.' : kind === 'permission' ? 'Teams access was denied. Use a work or school account and reconnect with the required permissions; your tenant may require administrator approval.' : kind === 'rate-limit' ? 'Teams is rate limiting requests. Wait before refreshing or sending again.' : kind === 'uncertain' ? 'Teams did not confirm delivery. Check Teams before sending again.' : `Teams rejected the request (HTTP ${response.status}).`
      throw new ProviderChatError(message, kind, Number(response.headers.get('retry-after')) || undefined)
    }
    if (response.status === 204) return undefined
    if (Number(response.headers.get('content-length') ?? 0) > 4_000_000) throw new ProviderChatError('Teams response exceeded the supported size', method === 'GET' ? 'rejected' : 'uncertain')
    const reader = response.body?.getReader()
    if (!reader) throw new ProviderChatError('Teams returned an empty response', method === 'GET' ? 'rejected' : 'uncertain')
    const chunks: Uint8Array[] = []; let length = 0
    try {
      while (true) { const result = await reader.read(); if (result.done) break; length += result.value.byteLength; if (length > 4_000_000) throw new Error('oversized'); chunks.push(result.value) }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch { throw new ProviderChatError('Teams returned an invalid response', method === 'GET' ? 'rejected' : 'uncertain') }
    finally { await reader.cancel().catch(() => {}) }
  }
  private async collection(accountId: string, path: string) {
    const rows: any[] = []; let next: string | undefined = path
    const expectedPath = new URL(graph + path).pathname
    const visited = new Set<string>()
    while (next) {
      if (visited.has(next) || visited.size >= 100) throw new ProviderChatError('Teams collection exceeds the supported pagination limit', 'rejected')
      visited.add(next)
      const data = await this.json(accountId, next, 'GET', undefined, expectedPath)
      if (!Array.isArray(data.value)) throw new ProviderChatError('Teams returned an invalid collection', 'rejected')
      rows.push(...data.value); next = typeof data['@odata.nextLink'] === 'string' ? data['@odata.nextLink'] : undefined
    }
    return rows
  }
  async connect(input: Record<string, string | boolean>, existing?: ProviderChatSession) {
    const channels = input.channels === undefined ? existing?.secret.channels === 'true' : input.channels === true
    const authorized = await this.deps.authorize(existing ? { accountId: existing.secret.microsoftAccountId, email: existing.secret.email } : undefined, [...TEAMS_CHAT_SCOPES, ...(channels ? TEAMS_CHANNEL_SCOPES : [])])
    const scopes = new Set(this.deps.scopes(authorized.accountId) ?? [])
    if (!TEAMS_CHAT_SCOPES.every((scope) => scopes.has(scope))) throw new ProviderChatError('Microsoft did not grant Teams chat permissions. Reconnect and review your tenant consent policy.', 'permission')
    if (channels && !TEAMS_CHANNEL_SCOPES.every((scope) => scopes.has(scope))) throw new ProviderChatError('Microsoft did not grant the requested Teams channel permissions.', 'permission')
    const profile = await this.json(authorized.accountId, '/me?$select=id,displayName')
    if (!text(profile.id)) throw new ProviderChatError('Teams did not return a user identity', 'auth')
    await this.json(authorized.accountId, '/me/chats?$top=1')
    let tenantId = ''
    try { const token = await this.deps.token(authorized.accountId); const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()); if (typeof claims.tid === 'string' && /^[\da-f-]{36}$/i.test(claims.tid)) tenantId = claims.tid } catch { /* Opaque access tokens can still read and send; server read receipts are unavailable. */ }
    return { remoteUserId: profile.id, name: authorized.displayName || authorized.email, secret: { microsoftAccountId: authorized.accountId, email: authorized.email, channels: String(channels), tenantId } }
  }
  async rooms(session: ProviderChatSession): Promise<ProviderChatRoom[]> {
    const source = session.secret.microsoftAccountId
    const chats = await this.collection(source, '/me/chats?$top=50&$expand=members,lastMessagePreview')
    const rooms: ProviderChatRoom[] = chats.filter((chat) => text(chat.id) && !chat.viewpoint?.isHidden).map((chat) => {
      const names = (Array.isArray(chat.members) ? chat.members : []).filter((member: any) => member.userId !== session.account.remoteUserId).map((member: any) => text(member.displayName || member.email, 200)).filter(Boolean)
      const lastActivity = chat.lastMessagePreview?.createdDateTime ?? chat.lastUpdatedDateTime
      return { accountId: session.account.id, id: `chat:${chat.id}`, name: text(chat.topic, 500) || names.join(', ') || 'Teams chat', kind: chat.chatType === 'oneOnOne' ? 'direct' : 'group', unread: lastActivity && Date.parse(lastActivity) > Date.parse(chat.viewpoint?.lastMessageReadDateTime ?? '1970-01-01') ? 1 : 0, lastActivity: lastActivity ? date(lastActivity) : undefined, canSend: true, canReadReceipt: Boolean(session.secret.tenantId), threaded: false, resource: { chatId: chat.id } }
    })
    if (session.secret.channels === 'true') for (const team of await this.collection(source, '/me/joinedTeams')) {
      if (!text(team.id)) continue
      for (const channel of await this.collection(source, `/teams/${pathId(team.id)}/channels`)) {
        if (!text(channel.id)) continue
        rooms.push({ accountId: session.account.id, id: `channel:${team.id}:${channel.id}`, name: `${text(team.displayName, 200)} / ${text(channel.displayName, 200)}`, kind: 'channel', unread: 0, canSend: !team.isArchived, canReadReceipt: false, threaded: true, resource: { teamId: team.id, channelId: channel.id } })
      }
    }
    return rooms
  }
  private endpoint(room: ProviderChatRoom, threadId?: string) {
    if (room.kind !== 'channel' && room.resource.chatId) {
      if (threadId) throw new ProviderChatError('Thread replies are available for Teams channel posts only', 'rejected')
      return `/chats/${pathId(room.resource.chatId)}/messages`
    }
    if (!room.resource.teamId || !room.resource.channelId) throw new ProviderChatError('Invalid Teams channel identity', 'rejected')
    return `/teams/${pathId(room.resource.teamId)}/channels/${pathId(room.resource.channelId)}/messages${threadId ? `/${pathId(threadId)}/replies` : ''}`
  }
  private message(session: ProviderChatSession, item: any): ProviderChatMessage {
    if (!text(item.id)) throw new ProviderChatError('Teams returned a message without an identity', 'rejected')
    const senderId = text(item.from?.user?.id || item.from?.application?.id, 500)
    return { id: item.id, senderId, sender: text(item.from?.user?.displayName || item.from?.application?.displayName, 500) || 'Teams system', timestamp: date(item.createdDateTime), body: item.deletedDateTime ? 'Message deleted' : item.body?.contentType === 'html' ? plain(item.body.content) : text(item.body?.content) || (item.attachments?.length ? '[Attachment — open in Teams]' : '[Unsupported Teams message]'), own: senderId === session.account.remoteUserId, deleted: Boolean(item.deletedDateTime), ...(item.replyToId ? { replyToId: text(item.replyToId, 512) } : {}) }
  }
  async messages(session: ProviderChatSession, room: ProviderChatRoom, options: { cursor?: string; threadId?: string }) {
    const endpoint = this.endpoint(room, options.threadId)
    const data = await this.json(session.secret.microsoftAccountId, options.cursor ?? `${endpoint}?$top=50`, 'GET', undefined, new URL(graph + endpoint).pathname)
    if (!Array.isArray(data.value)) throw new ProviderChatError('Teams returned an invalid message page', 'rejected')
    return { items: data.value.map((item: any) => this.message(session, item)), ...(typeof data['@odata.nextLink'] === 'string' ? { cursor: data['@odata.nextLink'] } : {}) }
  }
  async send(session: ProviderChatSession, room: ProviderChatRoom, body: string, threadId?: string) {
    return this.message(session, await this.json(session.secret.microsoftAccountId, this.endpoint(room, threadId), 'POST', { body: { contentType: 'text', content: body } }))
  }
  async markRead(session: ProviderChatSession, room: ProviderChatRoom) {
    if (!room.canReadReceipt || !room.resource.chatId) throw new ProviderChatError('Teams does not expose read markers for this conversation in Aerio', 'rejected')
    await this.json(session.secret.microsoftAccountId, `/chats/${pathId(room.resource.chatId)}/markChatReadForUser`, 'POST', { user: { id: session.account.remoteUserId, tenantId: session.secret.tenantId } })
  }
}
