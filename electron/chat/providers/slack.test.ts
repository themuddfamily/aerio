import { describe, expect, it, vi } from 'vitest'
import { SlackChatAdapter } from './slack'
import type { ProviderChatSession } from './adapter'
import type { ProviderChatRoom } from '../../../src/provider-chat-types'

const session = (): ProviderChatSession => ({ account: { id: 'local-1', provider: 'slack', remoteUserId: 'T123:U123', name: 'Workspace', status: 'ready', notificationPreviews: false }, secret: { token: 'xoxp-private-token', teamId: 'T123', userId: 'U123', tokenKind: 'user' } })
const room = (): ProviderChatRoom => ({ accountId: 'local-1', id: 'C123', name: 'general', kind: 'channel', unread: 0, canSend: true, canReadReceipt: true, threaded: true, resource: { channel: 'C123', teamId: 'T123' } })
function fixture(...results: unknown[]) {
  const fetcher = vi.fn(async () => {
    const result = results.shift()
    if (result instanceof Error) throw result
    if (result instanceof Response) return result
    return Response.json(result)
  })
  return { fetcher, adapter: new SlackChatAdapter(fetcher as typeof fetch) }
}
const success = { ok: true, user_id: 'U123', team_id: 'T123', team: 'Example', user: 'Sam' }
const channel = { id: 'C123', name: 'general', is_member: true }
describe('Slack provider adapter', () => {
  it('validates credentials remotely and scopes identities to the workspace', async () => {
    const { adapter, fetcher } = fixture(success, { ...success, team_id: 'T456' })
    const connected = await adapter.connect({ token: ' xoxp-private-token ' })
    expect(connected).toMatchObject({ remoteUserId: 'T123:U123', secret: { token: 'xoxp-private-token', teamId: 'T123', userId: 'U123', tokenKind: 'user' } })
    expect((await adapter.connect({ token: 'xoxp-other-token' })).remoteUserId).toBe('T456:U123')
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit]
    expect(String(url)).toBe('https://slack.com/api/auth.test')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer xoxp-private-token' } })
    expect(String(url)).not.toContain('private-token')
  })
  it('rejects invalid tokens before any request and rejects identity changes on reconnect', async () => {
    const { adapter, fetcher } = fixture({ ...success, team_id: 'T456' })
    for (const token of ['', 'password', 'xoxp-has\nnewline', 'xoxp-' + 'x'.repeat(2048)]) await expect(adapter.connect({ token })).rejects.toMatchObject({ kind: 'auth' })
    expect(fetcher).not.toHaveBeenCalled()
    await expect(adapter.connect({}, session())).rejects.toMatchObject({ kind: 'auth' })
  })
  it('paginates public/private channels, direct and group conversations without duplicating IDs', async () => {
    const { adapter, fetcher } = fixture(
      { ok: true, channels: [channel, { id: 'D123', is_im: true, user: 'U234' }, { id: 'C999', is_member: false }, { id: 'C555', is_archived: true }], response_metadata: { next_cursor: 'next=' } },
      { ok: true, channels: [channel, { id: 'G123', name: 'Group', is_mpim: true, unread_count: 2 }] })
    const rooms = await adapter.rooms(session())
    expect(rooms.map((item) => item.id)).toEqual(['C123', 'D123', 'C999', 'G123'])
    expect(rooms.find((item) => item.id === 'C999')?.canSend).toBe(false)
    expect(rooms.find((item) => item.id === 'D123')).toMatchObject({ kind: 'direct', canSend: true })
    expect(rooms.find((item) => item.id === 'G123')).toMatchObject({ kind: 'group', unread: 2 })
    const url = String((fetcher.mock.calls[1] as unknown[])[0])
    expect(new URL(url).searchParams.get('cursor')).toBe('next=')
    expect(new URL(url).searchParams.get('team_id')).toBe('T123')
  })
  it('rejects repeated, oversized and missing pagination cursors rather than silently truncating', async () => {
    const response = { ok: true, channels: [], response_metadata: { next_cursor: 'repeat' } }
    await expect(fixture(response, response).adapter.rooms(session())).rejects.toThrow(/repeated/)
    for (const response_metadata of [{ next_cursor: 'x'.repeat(2001) }, { next_cursor: 'bad\nvalue' }, { next_cursor: 123 }]) await expect(fixture({ ok: true, channels: [], response_metadata }).adapter.rooms(session())).rejects.toThrow(/cursor/)
    await expect(fixture({ ok: true, messages: [], has_more: true }).adapter.messages(session(), room(), {})).rejects.toThrow(/cursor/)
  })
  it('maps chronological messages, own identity, thread references and safe plain text', async () => {
    const { adapter } = fixture({ ok: true, messages: [
      { ts: '1700000000.1', user: 'U123', text: 'Hi &lt;Sam&gt;\u202e', thread_ts: '1699999999.000001' },
      { ts: '1700000000.01', user: 'U456', user_profile: { display_name: 'Other' }, files: [{ name: 'plan.pdf' }, null] },
      null, { ts: 'bad', text: 'ignore' }
    ], response_metadata: { next_cursor: 'older=' } })
    const page = await adapter.messages(session(), room(), {})
    expect(page.cursor).toBe('older=')
    expect(page.items.map((item) => item.id)).toEqual(['1700000000.01', '1700000000.1'])
    expect(page.items[0]).toMatchObject({ sender: 'Other', own: false, body: '[File: plan.pdf]\n[File: attachment]' })
    expect(page.items[1]).toMatchObject({ own: true, body: 'Hi <Sam>', replyToId: '1699999999.000001' })
  })
  it('uses the replies endpoint and cursor for an explicitly selected thread', async () => {
    const { adapter, fetcher } = fixture({ ok: true, messages: [] })
    await adapter.messages(session(), room(), { threadId: '1700000000.000001', cursor: 'older=' })
    const url = (fetcher.mock.calls[0] as unknown[])[0] as URL
    expect(url.pathname).toBe('/api/conversations.replies')
    expect(url.searchParams.get('ts')).toBe('1700000000.000001')
    expect(url.searchParams.get('limit')).toBe('15')
    expect(url.searchParams.get('cursor')).toBe('older=')
  })
  it('forbids cross-account/workspace/channel operations and malformed thread/cursor values', async () => {
    const { adapter, fetcher } = fixture()
    for (const modified of [{ accountId: 'other' }, { resource: { channel: 'C123', teamId: 'T999' } }, { id: 'C999' }]) {
      const invalid = { ...room(), ...modified }
      await expect(adapter.messages(session(), invalid, {})).rejects.toMatchObject({ kind: 'permission' })
      await expect(adapter.send(session(), invalid, 'hello')).rejects.toMatchObject({ kind: 'permission' })
      await expect(adapter.markRead(session(), invalid)).rejects.toMatchObject({ kind: 'permission' })
    }
    await expect(adapter.messages(session(), room(), { threadId: 'bad' })).rejects.toThrow(/Invalid/)
    await expect(adapter.messages(session(), room(), { cursor: 'bad\n' })).rejects.toThrow(/Invalid/)
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('sends literal text with the durable request ID and returns the provider receipt', async () => {
    const { adapter, fetcher } = fixture({ ok: true, channel: 'C123', ts: '1700000000.000001', message: { text: 'Hello', user: 'U123' } })
    const message = await adapter.send(session(), room(), 'Hello', '1699999999.000001', '12345678-1234-1234-1234-123456789abc')
    expect(message).toMatchObject({ id: '1700000000.000001', own: true, body: 'Hello' })
    expect(JSON.parse((fetcher.mock.calls[0] as unknown as [URL, RequestInit])[1].body as string)).toEqual({ channel: 'C123', text: 'Hello', mrkdwn: false, unfurl_links: false, unfurl_media: false, thread_ts: '1699999999.000001', client_msg_id: '12345678-1234-1234-1234-123456789abc' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('never claims delivery on transport loss, malformed/oversized receipt, server error or wrong channel', async () => {
    const responses = [new Error('private-token'), new Response('bad json'), new Response('x'.repeat(2_000_001)), new Response('', { status: 503 }), { ok: false, error: 'internal_error' }, { ok: true, channel: 'C999', ts: '1700000000.1' }, { ok: true, channel: 'C123' }]
    for (const response of responses) {
      const { adapter, fetcher } = fixture(response)
      await expect(adapter.send(session(), room(), 'private message')).rejects.toMatchObject({ kind: 'uncertain' })
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
  })
  it('classifies auth, scope, rejected and rate-limit responses without leaking remote messages', async () => {
    for (const [response, kind] of [[{ ok: false, error: 'invalid_auth' }, 'auth'], [{ ok: false, error: 'missing_scope' }, 'permission'], [{ ok: false, error: 'private-token and private message' }, 'rejected'], [new Response('', { status: 429, headers: { 'Retry-After': '120' } }), 'rate-limit']] as const) {
      try { await fixture(response).adapter.messages(session(), room(), {}); throw Error('expected failure') } catch (error: any) {
        expect(error.kind).toBe(kind); expect(error.message).not.toContain('private-token'); expect(error.message).not.toContain('private message')
        if (kind === 'rate-limit') expect(error.retryAfter).toBe(120)
      }
    }
  })
  it('does not attempt writes with missing membership or invalid input', async () => {
    const { adapter, fetcher } = fixture()
    await expect(adapter.send(session(), { ...room(), canSend: false }, 'Hello')).rejects.toMatchObject({ kind: 'permission' })
    for (const body of ['', '   ', 'x'.repeat(40001)]) await expect(adapter.send(session(), room(), body)).rejects.toMatchObject({ kind: 'rejected' })
    await expect(adapter.send(session(), room(), 'Hi', 'bad')).rejects.toMatchObject({ kind: 'rejected' })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('marks a user conversation through its latest timestamp, but exposes bot limitations', async () => {
    const { adapter, fetcher } = fixture({ ok: true, messages: [{ ts: '1700000000.1' }] }, { ok: true })
    await adapter.markRead(session(), room())
    expect(JSON.parse((fetcher.mock.calls[1] as unknown as [URL, RequestInit])[1].body as string)).toEqual({ channel: 'C123', ts: '1700000000.1' })
    const botSession = session(); botSession.secret.tokenKind = 'bot'
    const bot = fixture({ ok: true, channels: [channel, { id: 'D123', is_im: true }] })
    const botRooms = await bot.adapter.rooms(botSession)
    expect(botRooms[0]).toMatchObject({ canReadReceipt: false, threaded: false })
    expect(botRooms[1].threaded).toBe(true)
    await expect(bot.adapter.markRead(botSession, botRooms[0])).rejects.toMatchObject({ kind: 'permission' })
    await expect(bot.adapter.messages(botSession, botRooms[0], { threadId: '1700000000.1' })).rejects.toMatchObject({ kind: 'permission' })
    expect(bot.fetcher).toHaveBeenCalledTimes(1)
  })
})
