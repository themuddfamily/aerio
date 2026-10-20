import { expect, it, vi } from 'vitest'
import { TeamsChatAdapter, TEAMS_CHANNEL_SCOPES, TEAMS_CHAT_SCOPES } from './teams'
import type { ProviderChatSession } from './adapter'
import type { ProviderChatRoom } from '../../../src/provider-chat-types'
const session: ProviderChatSession = { account: { id: 'a', provider: 'teams', remoteUserId: 'user', name: 'Alice', status: 'ready', notificationPreviews: false }, secret: { microsoftAccountId: 'ms', email: 'alice@example.org', tenantId: 'tenant', channels: 'false' } }
const room: ProviderChatRoom = { accountId: 'a', id: 'chat:c', name: 'Chat', kind: 'direct', unread: 1, canSend: true, canReadReceipt: true, threaded: false, resource: { chatId: 'c' } }
const wire = { id: 'm', from: { user: { id: 'user', displayName: 'Alice' } }, createdDateTime: '2026-01-01T00:00:00Z', body: { contentType: 'html', content: '<p>Hello &amp; bye</p><script>danger()</script>' } }
function setup(respond: (url: URL, init?: RequestInit) => Response | Promise<Response> = () => Response.json({ value: [] })) {
  const request = vi.fn(async (url: any, init?: RequestInit) => respond(new URL(url), init))
  const authorize = vi.fn(async () => ({ accountId: 'ms', email: 'alice@example.org', displayName: 'Alice' }))
  const token = vi.fn(async () => 'token')
  const adapter = new TeamsChatAdapter({ configured: () => true, authorize, token, scopes: () => [...TEAMS_CHAT_SCOPES, ...TEAMS_CHANNEL_SCOPES], request: request as typeof fetch })
  return { adapter, request, authorize, token }
}
it('requests chat scopes by default and additional channel scopes only on explicit opt-in', async () => {
  const f = setup((url) => Response.json(url.pathname === '/v1.0/me' ? { id: 'user' } : { value: [] }))
  await f.adapter.connect({}); expect(f.authorize).toHaveBeenLastCalledWith(undefined, TEAMS_CHAT_SCOPES)
  await f.adapter.connect({ channels: true }, session)
  expect(f.authorize).toHaveBeenLastCalledWith({ accountId: 'ms', email: 'alice@example.org' }, [...TEAMS_CHAT_SCOPES, ...TEAMS_CHANNEL_SCOPES])
})
it('maps paginated chats, hides hidden chats and exposes channel capabilities accurately', async () => {
  const f = setup((url) => {
    if (url.pathname.endsWith('/joinedTeams')) return Response.json({ value: [{ id: 't', displayName: 'Team', isArchived: true }] })
    if (url.pathname.endsWith('/channels')) return Response.json({ value: [{ id: 'ch', displayName: 'General' }] })
    if (url.searchParams.has('skip')) return Response.json({ value: [{ id: 'hidden', viewpoint: { isHidden: true } }] })
    return Response.json({ value: [{ id: 'c', chatType: 'oneOnOne', members: [{ userId: 'user', displayName: 'Alice' }, { userId: 'bob', displayName: 'Bob' }], lastMessagePreview: { createdDateTime: '2026-01-02T00:00:00Z' }, viewpoint: { lastMessageReadDateTime: '2026-01-01T00:00:00Z' } }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/chats?skip=2' })
  })
  const rooms = await f.adapter.rooms({ ...session, secret: { ...session.secret, channels: 'true' } })
  expect(rooms).toHaveLength(2)
  expect(rooms[0]).toMatchObject({ name: 'Bob', unread: 1, kind: 'direct', canReadReceipt: true })
  expect(rooms[1]).toMatchObject({ kind: 'channel', canSend: false, canReadReceipt: false, threaded: true })
})
it('renders messages as plain text and preserves paging without following hostile or other-room cursors', async () => {
  const f = setup(() => Response.json({ value: [wire], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/chats/c/messages?skip=2' }))
  const page = await f.adapter.messages(session, room, {})
  expect(page.items[0]).toMatchObject({ body: 'Hello & bye', own: true })
  await expect(f.adapter.messages(session, room, { cursor: 'https://evil.example/v1.0/chats/c/messages' })).rejects.toThrow('Invalid Teams')
  await expect(f.adapter.messages(session, room, { cursor: 'https://graph.microsoft.com/v1.0/chats/other/messages' })).rejects.toThrow('Invalid Teams')
  expect(f.request).toHaveBeenCalledTimes(1)
})
it('sends text and channel replies through official endpoints and posts explicit server read markers', async () => {
  const f = setup((url) => url.pathname.endsWith('markChatReadForUser') ? new Response(null, { status: 204 }) : Response.json(wire, { status: 201 }))
  await f.adapter.send(session, room, '<literal>')
  expect(JSON.parse(String(f.request.mock.calls[0][1]?.body))).toEqual({ body: { contentType: 'text', content: '<literal>' } })
  const channel: ProviderChatRoom = { ...room, kind: 'channel', threaded: true, resource: { teamId: 't', channelId: 'ch' } }
  await f.adapter.send(session, channel, 'reply', 'root')
  expect(String(f.request.mock.calls[1][0])).toContain('/teams/t/channels/ch/messages/root/replies')
  await f.adapter.markRead(session, room)
  expect(JSON.parse(String(f.request.mock.calls[2][1]?.body))).toEqual({ user: { id: 'user', tenantId: 'tenant' } })
  await expect(f.adapter.messages(session, room, { threadId: 'bad' })).rejects.toThrow('channel posts only')
})
it.each([[401, 'auth'], [403, 'permission'], [429, 'rate-limit'], [500, 'uncertain']] as const)('classifies HTTP %s and honors provider backoff', async (status, kind) => {
  const f = setup(() => new Response(null, { status, headers: { 'Retry-After': '123' } }))
  await expect(f.adapter.send(session, room, 'hello')).rejects.toMatchObject({ kind, retryAfter: 123 })
  expect(f.request).toHaveBeenCalledTimes(1)
})
it('distinguishes preflight token expiry from unconfirmed network sends without retrying', async () => {
  const f = setup(() => { throw new Error('socket closed') })
  await expect(f.adapter.send(session, room, 'hello')).rejects.toMatchObject({ kind: 'uncertain' })
  f.token.mockRejectedValue(new Error('expired'))
  await expect(f.adapter.send(session, room, 'hello')).rejects.toMatchObject({ kind: 'auth' })
  expect(f.request).toHaveBeenCalledTimes(1)
})
