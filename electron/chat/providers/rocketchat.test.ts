import { describe, expect, it, vi } from 'vitest'
import { RocketChatAdapter, rocketChatServer } from './rocketchat'
import type { ProviderChatSession } from './adapter'
import type { ProviderChatRoom } from '../../../src/provider-chat-types'
const server = 'https://chat.example.test/team'
const session = (): ProviderChatSession => ({ account: { id: 'local', provider: 'rocketchat', remoteUserId: server + '|user-1', name: 'Sam', status: 'ready', notificationPreviews: false }, secret: { server, userId: 'user-1', token: 'private-token' } })
const room = (): ProviderChatRoom => ({ accountId: 'local', id: 'GENERAL', name: 'general', kind: 'channel', unread: 0, canSend: true, canReadReceipt: true, threaded: true, resource: { server, roomId: 'GENERAL', type: 'c', encrypted: 'false' } })
const rooms = { success: true, update: [{ _id: 'GENERAL', t: 'c', name: 'general', lastMessage: { ts: '2026-10-20T10:00:00Z' } }] }
const subscriptions = { success: true, update: [{ rid: 'GENERAL', name: 'general', unread: 2 }] }
const message = { _id: 'message-1', rid: 'GENERAL', ts: '2026-10-20T10:00:00Z', msg: 'Hello', u: { _id: 'user-1', name: 'Sam' } }
function fixture(...values: unknown[]) {
  const fetcher = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => { const value = values.shift(); if (value instanceof Error) throw value; return value instanceof Response ? value : Response.json(value) })
  return { adapter: new RocketChatAdapter(fetcher as typeof fetch), fetcher }
}
describe('Rocket.Chat connector', () => {
  it('accepts HTTPS base paths and rejects plaintext, embedded credentials and URL control surfaces', () => {
    expect(rocketChatServer(server + '/')).toBe(server)
    for (const value of ['http://chat.test', 'https://user:password@chat.test', 'https://chat.test/?token=secret', 'https://chat.test/#secret', 'file:///tmp/chat', 'https://chat.test/a%2Fb']) expect(() => rocketChatServer(value)).toThrow(/HTTPS/)
  })
  it('validates the personal token and namespaces identity by server', async () => {
    const { adapter, fetcher } = fixture({ success: true, _id: 'user-1', name: 'Sam' })
    const connected = await adapter.connect({ server: server + '/', userId: 'user-1', token: 'private-token' })
    expect(connected).toMatchObject({ remoteUserId: server + '|user-1', secret: { server, userId: 'user-1', token: 'private-token' } })
    const [url, init] = fetcher.mock.calls[0]
    expect(String(url)).toBe(server + '/api/v1/me')
    expect(init).toMatchObject({ redirect: 'error', headers: { 'X-User-Id': 'user-1', 'X-Auth-Token': 'private-token' } })
    expect(String(url)).not.toContain('private-token')
    await expect(fixture({ success: true, _id: 'other-user' }).adapter.connect({ server, userId: 'user-1', token: 'token' })).rejects.toMatchObject({ kind: 'auth' })
    await expect(fixture({ success: true, _id: 'user-1' }).adapter.connect({ server: 'https://other.test' }, session())).rejects.toMatchObject({ kind: 'auth' })
  })
  it('uses only joined rooms and accurately represents encrypted/read-only capabilities', async () => {
    const { adapter } = fixture({ success: true, update: [...rooms.update, { _id: 'private', t: 'p', encrypted: true, name: 'private' }, { _id: 'dm', t: 'd', usersCount: 3, usernames: ['Sam', 'Jo', 'Al'] }, { _id: 'unjoined', t: 'c' }, { _id: 'archived', t: 'c', archived: true }] }, { success: true, update: [...subscriptions.update, { rid: 'private', name: 'secret' }, { rid: 'dm' }, { rid: 'archived' }] })
    const result = await adapter.rooms(session())
    expect(result.map((item) => item.id)).toEqual(['GENERAL', 'private', 'dm'])
    expect(result[0]).toMatchObject({ unread: 2, lastActivity: '2026-10-20T10:00:00.000Z', canSend: true })
    expect(result[1]).toMatchObject({ canSend: false, threaded: false, resource: { encrypted: 'true' } })
    expect(result[2]).toMatchObject({ kind: 'group', name: 'Sam, Jo, Al' })
  })
  it('maps safe text, file placeholders, own sender and threads in chronological order', async () => {
    const { adapter } = fixture({ success: true, messages: [{ ...message, _id: 'new', ts: '2026-10-20T10:02:00Z', msg: 'Text\u202e', tmid: 'message-1' }, { ...message, msg: '', attachments: [{ title: 'plan.pdf' }] }, { ...message, _id: 'encrypted', ts: '2026-10-20T10:01:00Z', t: 'e2e', msg: 'ciphertext' }] })
    const result = await adapter.messages(session(), room(), {})
    expect(result.items.map((item) => item.id)).toEqual(['message-1', 'encrypted', 'new'])
    expect(result.items[0]).toMatchObject({ own: true, body: '[Attachment: plan.pdf]' })
    expect(result.items[1].body).toMatch(/Encrypted message/)
    expect(result.items[2]).toMatchObject({ body: 'Text', replyToId: 'message-1' })
  })
  it('selects public/private/direct history endpoints and advances older pages', async () => {
    for (const [type, endpoint] of [['c', 'channels'], ['p', 'groups'], ['d', 'im']]) {
      const { adapter, fetcher } = fixture({ success: true, messages: Array.from({ length: 50 }, (_, i) => ({ ...message, _id: 'message-' + i })) })
      expect((await adapter.messages(session(), { ...room(), resource: { ...room().resource, type } }, { cursor: '50' })).cursor).toBe('100')
      const url = fetcher.mock.calls[0][0] as URL
      expect(url.pathname).toBe('/team/api/v1/' + endpoint + '.history')
      expect(url.searchParams.get('offset')).toBe('50')
      expect(url.searchParams.get('roomId')).toBe('GENERAL')
    }
  })
  it('loads threads and rejects responses belonging to another room', async () => {
    const { adapter, fetcher } = fixture({ success: true, messages: [{ ...message, tmid: 'root' }], total: 1 })
    const result = await adapter.messages(session(), room(), { threadId: 'root' })
    expect(result.cursor).toBeUndefined()
    expect((fetcher.mock.calls[0][0] as URL).searchParams.get('tmid')).toBe('root')
    await expect(fixture({ success: true, messages: [{ ...message, rid: 'other' }] }).adapter.messages(session(), room(), {})).rejects.toThrow(/invalid room history/)
    await expect(fixture({ success: true, messages: [], total: 5 }).adapter.messages(session(), room(), {})).rejects.toThrow(/did not advance/)
  })
  it('rejects local cross-account/server resources and invalid cursors before network access', async () => {
    const { adapter, fetcher } = fixture()
    for (const invalid of [{ ...room(), accountId: 'other' }, { ...room(), resource: { ...room().resource, server: 'https://other.test' } }, { ...room(), id: 'other' }]) await expect(adapter.messages(session(), invalid, {})).rejects.toMatchObject({ kind: 'permission' })
    for (const cursor of ['-1', '1.5', '1000001', 'bad', '0\n']) await expect(adapter.messages(session(), room(), { cursor })).rejects.toMatchObject({ kind: 'rejected' })
    await expect(adapter.messages(session(), { ...room(), resource: { ...room().resource, encrypted: 'true' } }, {})).rejects.toMatchObject({ kind: 'permission' })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('sends a persisted message ID with thread parent and verifies the receipt', async () => {
    const { adapter, fetcher } = fixture(rooms, subscriptions, { success: true, message })
    expect(await adapter.send(session(), room(), 'Hello', 'root', 'message-1')).toMatchObject({ id: 'message-1', own: true, body: 'Hello' })
    expect(JSON.parse(fetcher.mock.calls[2][1]?.body as string)).toEqual({ message: { _id: 'message-1', rid: 'GENERAL', msg: 'Hello', tmid: 'root' }, previewUrls: [] })
  })
  it('checks current membership/encryption again before sending any plaintext', async () => {
    const { adapter, fetcher } = fixture({ success: true, update: [{ ...rooms.update[0], encrypted: true }] }, subscriptions)
    await expect(adapter.send(session(), room(), 'private text')).rejects.toMatchObject({ kind: 'permission' })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls.every((call) => call[1]?.method === 'GET')).toBe(true)
  })
  it('reports uncertain sends without replaying on lost, malformed or mismatched receipts', async () => {
    for (const response of [new Error('private-token'), new Response('bad'), new Response('', { status: 503 }), { success: true, message: { ...message, _id: 'other' } }, { success: true, message: { ...message, rid: 'other' } }]) {
      const { adapter, fetcher } = fixture(rooms, subscriptions, response)
      await expect(adapter.send(session(), room(), 'private text', undefined, 'message-1')).rejects.toMatchObject({ kind: 'uncertain' })
      expect(fetcher).toHaveBeenCalledTimes(3)
    }
  })
  it('classifies authorization, permission, malformed and rate-limit failures safely', async () => {
    for (const [response, kind] of [[new Response('', { status: 401 }), 'auth'], [new Response('', { status: 403 }), 'permission'], [new Response('', { status: 429, headers: { 'Retry-After': '80' } }), 'rate-limit'], [{ success: false, error: 'private-token' }, 'rejected'], [new Response('x'.repeat(4_000_001)), 'rejected']] as const) {
      try { await fixture(response).adapter.rooms(session()); throw Error('expected failure') } catch (error: any) { expect(error.kind).toBe(kind); expect(error.message).not.toContain('private-token'); if (kind === 'rate-limit') expect(error.retryAfter).toBe(80) }
    }
  })
  it('marks only the trusted room as read', async () => {
    const { adapter, fetcher } = fixture({ success: true })
    await adapter.markRead(session(), room())
    expect(String(fetcher.mock.calls[0][0])).toBe(server + '/api/v1/subscriptions.read')
    expect(JSON.parse(fetcher.mock.calls[0][1]?.body as string)).toEqual({ roomId: 'GENERAL' })
  })
})
