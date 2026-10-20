import { describe, expect, it, vi } from 'vitest'
import { IceWarpChatAdapter } from './icewarp'
import { IceWarpApi, iceWarpServer } from '../../icewarp-api'
import type { ProviderChatSession } from './adapter'
import type { ProviderChatRoom } from '../../../src/provider-chat-types'
const server = 'https://icewarp.example.test'
const session = (): ProviderChatSession => ({ account: { id: 'local', provider: 'icewarp', remoteUserId: server + '|user-id', name: 'Sam', status: 'ready', notificationPreviews: false }, secret: { server, token: 'private-token', userId: 'user-id', user: 'sam@example.test', owned: 'false' } })
const channel = { id: 'BASE64+/==', name: 'Engineering', is_member: true, is_active: true }
const room = (): ProviderChatRoom => ({ accountId: 'local', id: channel.id, name: channel.name, kind: 'channel', unread: 0, canSend: true, canReadReceipt: false, threaded: true, resource: { server, channel: channel.id } })
const message = { channel: channel.id, ts: '1792483200.000001', text: 'Hello', user: 'sam@example.test', user_name: 'Sam' }
function fixture(...values: unknown[]) {
  const fetcher = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => { const value = values.shift(); if (value instanceof Error) throw value; return value instanceof Response ? value : Response.json(value) })
  return { adapter: new IceWarpChatAdapter(fetcher as typeof fetch), fetcher }
}
describe('IceWarp documented TeamChat API', () => {
  it('requires HTTPS, supports a documented API suffix and refuses URL credential/control surfaces', () => {
    expect(iceWarpServer(server + '/teamchatapi/')).toBe(server)
    for (const value of ['http://icewarp.test', 'https://u:p@icewarp.test', server + '?token=secret', server + '#secret', server + '/a%2fb', server + '/a/../b']) expect(() => iceWarpServer(value)).toThrow(/HTTPS/)
  })
  it('authenticates a server-scoped token without putting credentials in URLs', async () => {
    const { adapter, fetcher } = fixture({ ok: true, user_id: 'user-id', user: 'sam@example.test' })
    expect(await adapter.connect({ server, token: 'private-token' })).toMatchObject({ remoteUserId: server + '|user-id', secret: { server, token: 'private-token', owned: 'false' } })
    expect(String(fetcher.mock.calls[0][0])).toBe(server + '/teamchatapi/auth.test')
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit', body: JSON.stringify({ token: 'private-token' }) })
    await expect(fixture({ ok: true, user_id: 'other', user: 'other@example.test' }).adapter.connect({ server, token: 'token' }, session())).rejects.toMatchObject({ kind: 'auth' })
  })
  it('never forwards saved credentials to a changed server or signs in a different reconnect user', async () => {
    const { adapter, fetcher } = fixture()
    await expect(adapter.connect({ server: 'https://attacker.test' }, session())).rejects.toMatchObject({ kind: 'auth' })
    await expect(adapter.connect({ server, username: 'another@example.test', password: 'explicit-password' }, session())).rejects.toMatchObject({ kind: 'auth' })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('exchanges a password once and persists only the verified token/identity', async () => {
    const { adapter, fetcher } = fixture({ ok: true, authorized: 'true', token: 'obtained-token' }, { ok: true, user_id: 'user-id', user: 'sam@example.test' })
    const result = await adapter.connect({ server, username: 'sam@example.test', password: 'private-password' })
    expect(result.secret).not.toHaveProperty('password')
    expect(result.secret).toMatchObject({ token: 'obtained-token', owned: 'true' })
    expect(JSON.parse(fetcher.mock.calls[0][1]?.body as string)).toEqual({ username: 'sam@example.test', password: 'private-password' })
    await expect(fixture({ ok: true, authorized: false }).adapter.connect({ server, username: 'sam', password: 'pw' })).rejects.toMatchObject({ kind: 'auth' })
  })
  it('lists only joined active rooms with explicit text/thread capabilities', async () => {
    const { adapter, fetcher } = fixture({ ok: true, channels: [channel, { ...channel, id: 'not-member', is_member: false }, { ...channel, id: 'inactive', is_active: false }, { ...channel, id: 'readonly', permissions: { items_write: false } }] })
    const rooms = await adapter.rooms(session())
    expect(rooms.map((item) => item.id)).toEqual([channel.id, 'readonly'])
    expect(rooms[0]).toMatchObject({ canSend: true, canReadReceipt: false, threaded: true })
    expect(rooms[1].canSend).toBe(false)
    expect(JSON.parse(fetcher.mock.calls[0][1]?.body as string)).toMatchObject({ collection_type: '1', include_permissions: true })
  })
  it('paginates thread history and comments, sanitizes text and binds results to the room', async () => {
    const { adapter, fetcher } = fixture({ ok: true, messages: [{ ...message, text: 'Hello\u202e' }], has_more: true }, { ok: true, messages: [{ ...message, thread_ts: message.ts, ts: '1792483201.000001' }] })
    expect(await adapter.messages(session(), room(), {})).toMatchObject({ items: [{ id: message.ts, own: true, body: 'Hello' }], cursor: '2' })
    const comments = await adapter.messages(session(), room(), { threadId: message.ts, cursor: '2' })
    expect(comments.items[0].replyToId).toBe(message.ts)
    expect(String(fetcher.mock.calls[1][0])).toContain('/threads.comments')
    expect(JSON.parse(fetcher.mock.calls[1][1]?.body as string)).toMatchObject({ page: 2, count: 50, ts: message.ts })
    await expect(fixture({ ok: true, messages: [{ ...message, channel: 'foreign' }] }).adapter.messages(session(), room(), {})).rejects.toThrow(/invalid room history/)
    await expect(fixture({ ok: true, messages: [], has_more: true }).adapter.messages(session(), room(), {})).rejects.toThrow(/did not advance/)
  })
  it('rejects cross-account/server rooms and malformed cursors before making requests', async () => {
    const { adapter, fetcher } = fixture()
    await expect(adapter.messages(session(), { ...room(), accountId: 'other' }, {})).rejects.toMatchObject({ kind: 'permission' })
    await expect(adapter.messages(session(), { ...room(), resource: { ...room().resource, server: 'https://other.test' } }, {})).rejects.toMatchObject({ kind: 'permission' })
    for (const cursor of ['0', '-1', '1\n', '1.2', '10000']) await expect(adapter.messages(session(), room(), { cursor })).rejects.toMatchObject({ kind: 'rejected' })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('checks current room membership and write permission before posting a thread comment', async () => {
    const { adapter, fetcher } = fixture({ ok: true, channel }, { ok: true, permissions: { items_write: true } }, { ok: true, channel: channel.id, message })
    expect(await adapter.send(session(), room(), 'Hello', message.ts)).toMatchObject({ id: message.ts, replyToId: message.ts, own: true })
    expect(String(fetcher.mock.calls[2][0])).toBe(server + '/teamchatapi/chat.postMessage')
    expect(JSON.parse(fetcher.mock.calls[2][1]?.body as string)).toEqual({ channel: channel.id, text: 'Hello', ts: message.ts, token: 'private-token' })
    const denied = fixture({ ok: true, channel }, { ok: true, permissions: { items_write: false } })
    await expect(denied.adapter.send(session(), room(), 'Secret')).rejects.toMatchObject({ kind: 'permission' })
    expect(denied.fetcher).toHaveBeenCalledTimes(2)
  })
  it('reports lost/malformed send receipts as uncertain without automatic replay', async () => {
    for (const value of [new Error('private-token'), new Response('invalid'), new Response('', { status: 503 }), { ok: true, message: { ...message, user: 'other' } }, { ok: true, channel: 'foreign', message }]) {
      const { adapter, fetcher } = fixture({ ok: true, channel }, { ok: true, permissions: { items_write: true } }, value)
      await expect(adapter.send(session(), room(), 'Hello')).rejects.toMatchObject({ kind: 'uncertain' })
      expect(fetcher).toHaveBeenCalledTimes(3)
    }
  })
  it('classifies auth, permissions, throttling and oversized responses without exposing raw errors', async () => {
    for (const [value, kind] of [[{ ok: false, error: 'invalid_token', detail: 'private-token' }, 'auth'], [{ ok: false, error: 'no_permission' }, 'permission'], [new Response('', { status: 429 }), 'rate-limit'], [new Response('x'.repeat(4_000_001)), 'rejected']] as const) {
      try { await fixture(value).adapter.rooms(session()); throw Error('expected failure') } catch (error: any) { expect(error.kind).toBe(kind); expect(error.message).not.toContain('private-token') }
    }
    const fetcher = vi.fn()
    await expect(new IceWarpApi(server, 'token', fetcher).request('arbitrary.admin')).rejects.toMatchObject({ kind: 'rejected' })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('revokes only tokens obtained by Aerio when disconnecting', async () => {
    const { adapter, fetcher } = fixture({ ok: true })
    await adapter.disconnect(session()); expect(fetcher).not.toHaveBeenCalled()
    await adapter.disconnect({ ...session(), secret: { ...session().secret, owned: 'true' } })
    expect(String(fetcher.mock.calls[0][0])).toContain('/auth.revoke')
  })
})
