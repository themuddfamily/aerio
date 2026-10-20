import type { ProviderChatDescriptor, ProviderChatMessage, ProviderChatPage, ProviderChatRoom } from '../../../src/provider-chat-types'
import { ProviderChatError, type ProviderChatAdapter, type ProviderChatConnection, type ProviderChatSession } from './adapter'

type SlackObject = Record<string, any>
const identity = (value: unknown): value is string => typeof value === 'string' && /^[A-Z][A-Z0-9]{1,99}$/.test(value)
const slackTimestamp = (value: unknown): value is string => typeof value === 'string' && /^\d{1,12}\.\d{1,6}$/.test(value) && Number.isFinite(new Date(Number(value) * 1000).getTime())
const plain = (value: unknown, length = 40_000) => typeof value === 'string' ? value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, length).replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&') : ''
const cursor = (value: unknown) => typeof value === 'string' && value.length <= 2000 && !/[\x00-\x1f]/.test(value) ? value : ''
const nextCursor = (response: SlackObject) => {
  const value = response.response_metadata?.next_cursor
  if (value !== undefined && value !== '' && cursor(value) !== value || response.has_more === true && !cursor(value)) throw new ProviderChatError('Slack returned an invalid pagination cursor. Refresh the conversation.', 'rejected')
  return cursor(value)
}
const GET_METHODS = new Set(['conversations.list', 'conversations.history', 'conversations.replies', 'users.info'])

/** Fixed-host official Web API adapter. The shared runtime seals credentials/cache and owns delivery review. */
export class SlackChatAdapter implements ProviderChatAdapter {
  constructor(private fetcher: typeof fetch = fetch) {}
  descriptor(): ProviderChatDescriptor {
    return { id: 'slack', name: 'Slack', available: true, detail: 'Connect a workspace user or bot API token. Reads joined channels and conversations, text messages and threads. Workspace scopes and Slack rate limits apply. File upload, reactions and presence are not supported.', fields: [{ key: 'token', label: 'Workspace API token', type: 'password', required: true }] }
  }
  private async request(method: string, token: string, parameters: Record<string, string | boolean | number> = {}, delivery = false): Promise<SlackObject> {
    const url = new URL(`https://slack.com/api/${method}`)
    const get = GET_METHODS.has(method)
    if (get) for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, String(value))
    let response: Response
    try {
      response = await this.fetcher(url, { method: get ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' }, ...(get ? {} : { body: JSON.stringify(parameters) }), redirect: 'error', signal: AbortSignal.timeout(15_000) })
    } catch { throw new ProviderChatError(delivery ? 'Slack delivery could not be confirmed. Review the conversation before sending again.' : 'Slack could not be reached.', delivery ? 'uncertain' : 'network') }
    const retry = Math.max(1, Math.min(Number(response.headers.get('Retry-After')) || 60, 3600))
    if (response.status === 429) throw new ProviderChatError('Slack rate limit reached. Wait before trying again.', 'rate-limit', retry)
    if (response.status === 401 || response.status === 403) throw new ProviderChatError('Reconnect Slack with an authorized workspace token.', 'auth')
    if (!response.ok) throw new ProviderChatError('Slack did not confirm the request.', delivery && response.status >= 500 ? 'uncertain' : 'rejected')
    let result: SlackObject
    try {
      const reader = response.body?.getReader()
      if (!reader) throw Error('missing body')
      const chunks: Uint8Array[] = []; let size = 0
      try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 2_000_000) throw Error('too large'); chunks.push(part.value) } }
      finally { await reader.cancel().catch(() => {}) }
      result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw Error('invalid response')
    } catch { throw new ProviderChatError('Slack returned an invalid response.', delivery ? 'uncertain' : 'rejected') }
    if (result.ok !== true) {
      const error = result.error
      if (['invalid_auth', 'not_authed', 'token_expired', 'token_revoked', 'account_inactive'].includes(error)) throw new ProviderChatError('Slack authorization expired or was revoked. Reconnect with a workspace token.', 'auth')
      if (['missing_scope', 'no_permission', 'not_in_channel', 'restricted_action', 'ekm_access_denied'].includes(error)) throw new ProviderChatError('Slack denied access. Check token scopes, conversation membership and workspace policy.', 'permission')
      if (error === 'ratelimited') throw new ProviderChatError('Slack rate limit reached.', 'rate-limit', retry)
      if (delivery && ['internal_error', 'fatal_error', 'request_timeout', 'service_unavailable'].includes(error)) throw new ProviderChatError('Slack delivery outcome is unknown. Review the conversation before sending again.', 'uncertain')
      throw new ProviderChatError('Slack rejected this request. Check the conversation, message and workspace permissions.', 'rejected')
    }
    return result
  }
  async connect(input: Record<string, string | boolean>, existing?: ProviderChatSession): Promise<ProviderChatConnection> {
    const token = (typeof input.token === 'string' ? input.token.trim() : '') || existing?.secret.token || ''
    if ((!/^xox[bp]-\S+$/.test(token) && !/^xoxe\.xox[bp]-\S+$/.test(token)) || token.length > 2048) throw new ProviderChatError('Enter a Slack workspace user or bot API token.', 'auth')
    const result = await this.request('auth.test', token)
    if (!identity(result.user_id) || !identity(result.team_id)) throw new ProviderChatError('Slack did not return a valid workspace identity.', 'auth')
    const remoteUserId = `${result.team_id}:${result.user_id}`
    if (existing && (existing.secret.teamId !== result.team_id || existing.account.remoteUserId !== remoteUserId)) throw new ProviderChatError('This token belongs to a different Slack identity. Add it as another account.', 'auth')
    return { remoteUserId, name: `${plain(result.team, 100) || result.team_id} · ${plain(result.user, 100) || result.user_id}`, secret: { token, teamId: result.team_id, userId: result.user_id, tokenKind: result.bot_id ? 'bot' : 'user' } }
  }
  private channel(session: ProviderChatSession, room: ProviderChatRoom) {
    if (room.accountId !== session.account.id || room.resource.teamId !== session.secret.teamId || !identity(room.resource.channel) || room.id !== room.resource.channel) throw new ProviderChatError('This Slack conversation does not belong to the connected workspace.', 'permission')
    return room.resource.channel
  }
  async rooms(session: ProviderChatSession): Promise<ProviderChatRoom[]> {
    const result: ProviderChatRoom[] = []; let next = ''; const seen = new Set<string>()
    for (let page = 0; page < 100; page++) {
      const response = await this.request('conversations.list', session.secret.token, { team_id: session.secret.teamId, types: 'public_channel,private_channel,mpim,im', exclude_archived: true, limit: 200, ...(next ? { cursor: next } : {}) })
      if (!Array.isArray(response.channels)) throw new ProviderChatError('Slack returned an invalid conversation list.', 'rejected')
      for (const channel of response.channels) {
        if (!identity(channel?.id) || channel.is_archived) continue
        // Public channels returned for a user token need not be joined; avoid promising writable membership.
        const canSend = channel.is_im || channel.is_mpim || channel.is_member === true
        result.push({ accountId: session.account.id, id: channel.id, name: plain(channel.name, 300) || `Direct message with ${plain(channel.user, 100) || channel.id}`, kind: channel.is_im ? 'direct' : channel.is_mpim ? 'group' : 'channel', unread: Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(Number(channel.unread_count_display ?? channel.unread_count) || 0))), canSend: Boolean(canSend), canReadReceipt: session.secret.tokenKind === 'user', threaded: session.secret.tokenKind === 'user' || Boolean(channel.is_im || channel.is_mpim), resource: { channel: channel.id, teamId: session.secret.teamId } })
      }
      next = nextCursor(response)
      if (!next) return [...new Map(result.map((room) => [room.id, room])).values()]
      if (seen.has(next)) throw new ProviderChatError('Slack repeated a conversation cursor. Refresh the workspace.', 'rejected')
      seen.add(next)
    }
    throw new ProviderChatError('Slack returned too many conversation pages. Narrow workspace access before connecting.', 'rejected')
  }
  private mapMessage(session: ProviderChatSession, item: SlackObject): ProviderChatMessage | undefined {
    if (!item || typeof item !== 'object' || !slackTimestamp(item.ts)) return
    const senderId = plain(item.user || item.bot_id, 100)
    const embeddedName = plain(item.user_profile?.display_name || item.user_profile?.real_name || item.username, 200)
    return { id: item.ts, senderId, sender: embeddedName || senderId || 'Slack', timestamp: new Date(Number(item.ts) * 1000).toISOString(), body: plain(item.text) || (Array.isArray(item.files) ? item.files.map((file: SlackObject) => `[File: ${plain(file?.name, 200) || 'attachment'}]`).join('\n') : ''), own: senderId === session.secret.userId, ...(slackTimestamp(item.thread_ts) && item.thread_ts !== item.ts ? { replyToId: item.thread_ts } : {}), ...(item.subtype === 'message_deleted' ? { deleted: true } : {}) }
  }
  async messages(session: ProviderChatSession, room: ProviderChatRoom, options: { cursor?: string; threadId?: string }): Promise<ProviderChatPage> {
    const channel = this.channel(session, room)
    if (options.cursor && cursor(options.cursor) !== options.cursor || options.threadId && !slackTimestamp(options.threadId)) throw new ProviderChatError('Invalid Slack history cursor or thread.', 'rejected')
    if (options.threadId && !room.threaded) throw new ProviderChatError('Slack bot tokens cannot read channel threads. Use a workspace user token.', 'permission')
    const response = await this.request(options.threadId ? 'conversations.replies' : 'conversations.history', session.secret.token, { channel, limit: 15, ...(options.cursor ? { cursor: options.cursor } : {}), ...(options.threadId ? { ts: options.threadId } : {}) })
    if (!Array.isArray(response.messages)) throw new ProviderChatError('Slack returned invalid messages.', 'rejected')
    const items = response.messages.map((message: SlackObject) => this.mapMessage(session, message)).filter((item: ProviderChatMessage | undefined): item is ProviderChatMessage => Boolean(item))
      .sort((a: ProviderChatMessage, b: ProviderChatMessage) => {
        const order = (id: string) => { const [seconds, fraction] = id.split('.'); return seconds.padStart(12, '0') + fraction.padEnd(6, '0') }
        return order(a.id).localeCompare(order(b.id))
      })
    const next = nextCursor(response)
    return { items, ...(next ? { cursor: next } : {}) }
  }
  async send(session: ProviderChatSession, room: ProviderChatRoom, body: string, threadId?: string, clientRequestId?: string): Promise<ProviderChatMessage> {
    const channel = this.channel(session, room)
    if (!room.canSend) throw new ProviderChatError('Join this Slack conversation before sending.', 'permission')
    if (!body.trim() || body.length > 40_000 || threadId && !slackTimestamp(threadId) || clientRequestId && !/^[0-9a-f-]{36}$/i.test(clientRequestId)) throw new ProviderChatError('Enter a valid Slack message and thread.', 'rejected')
    const response = await this.request('chat.postMessage', session.secret.token, { channel, text: body, mrkdwn: false, unfurl_links: false, unfurl_media: false, ...(threadId ? { thread_ts: threadId } : {}), ...(clientRequestId ? { client_msg_id: clientRequestId } : {}) }, true)
    const sent = this.mapMessage(session, { ...response.message, ts: response.ts, user: response.message?.user || session.secret.userId })
    if (!sent || response.channel !== channel) throw new ProviderChatError('Slack accepted the request but did not identify its sent message. Review the conversation before retrying.', 'uncertain')
    return sent
  }
  async markRead(session: ProviderChatSession, room: ProviderChatRoom): Promise<void> {
    if (!room.canReadReceipt) throw new ProviderChatError('Slack bot tokens do not provide personal read markers.', 'permission')
    const channel = this.channel(session, room)
    const latest = await this.request('conversations.history', session.secret.token, { channel, limit: 1 })
    const ts = latest.messages?.[0]?.ts
    if (slackTimestamp(ts)) await this.request('conversations.mark', session.secret.token, { channel, ts })
  }
}
