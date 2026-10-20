import { EventEmitter } from 'node:events'
import { client, jid, xml, type Options } from '@xmpp/client'
import { afterEach, expect, it, vi } from 'vitest'
import { XmppChatAdapter } from './xmpp'
import type { ProviderChatSession } from './adapter'
import { proxyUrlForHost } from '../../network-proxy-runtime'
vi.mock('../../network-proxy-runtime', () => ({ proxyUrlForHost: vi.fn() }))
const ns = { roster: 'jabber:iq:roster', disco: 'http://jabber.org/protocol/disco#info', muc: 'http://jabber.org/protocol/muc', user: 'http://jabber.org/protocol/muc#user', mam: 'urn:xmpp:mam:2', forward: 'urn:xmpp:forward:0', delay: 'urn:xmpp:delay', rsm: 'http://jabber.org/protocol/rsm' }
const adapters: XmppChatAdapter[] = []
afterEach(() => { adapters.splice(0).forEach((adapter) => adapter.suspend()); vi.mocked(proxyUrlForHost).mockReset() })
const input = { jid: 'alice@example.org', password: ' secret ', service: 'xmpp://example.org:5222', rooms: 'room@conference.example.org' }
const session: ProviderChatSession = { account: { id: 'a', provider: 'xmpp', remoteUserId: '', name: 'Alice', status: 'ready', notificationPreviews: false }, secret: { jid: input.jid, password: input.password, service: input.service, contacts: '[]', rooms: JSON.stringify([input.rooms]), nickname: 'alice' } }
function setup(options: { secure?: boolean; mam?: boolean; sm?: boolean; confirm?: boolean; authError?: boolean; mucError?: boolean; delayedManagement?: boolean } = {}) {
  const clients: any[] = []
  const create = vi.fn((config: Options) => {
    const entity = new EventEmitter() as any
    entity.options = config; entity.status = 'offline'; entity.socket = { secure: options.secure !== false }; entity.jid = jid('alice@example.org/aerio')
    entity.reconnect = { stop: vi.fn() }; entity.streamManagement = Object.assign(new EventEmitter(), { enabled: options.sm !== false })
    entity.isSecure = () => entity.socket.secure
    entity.connect = vi.fn(async () => {})
    entity.authenticate = vi.fn(async (creds) => { if (options.authError) throw Object.assign(new Error(), { name: 'SASLError' }); expect(creds.password).toBe(' secret ') })
    entity.start = vi.fn(async () => {
      await (config.credentials as any)(entity.authenticate, ['SCRAM-SHA-1', 'PLAIN'], null, entity); entity.status = 'online'
      if (options.delayedManagement) {
        entity.streamManagement.enabled = false
        entity.emit('element', xml('features', { xmlns: 'http://etherx.jabber.org/streams' }, xml('sm', { xmlns: 'urn:xmpp:sm:3' })))
        setTimeout(() => { entity.streamManagement.enabled = true; entity.emit('element', xml('enabled', { xmlns: 'urn:xmpp:sm:3' })) }, 5)
      }
    })
    entity.stop = vi.fn(async () => { entity.status = 'offline'; entity.emit('disconnect') })
    entity.send = vi.fn(async (stanza) => {
      if (options.delayedManagement) expect(entity.streamManagement.enabled).toBe(true)
      if (stanza.is('presence') && stanza.attrs.to) {
        const from = stanza.attrs.to
        entity.emit('stanza', options.mucError ? xml('presence', { from, type: 'error' }, xml('error', {}, xml('forbidden', { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' }))) : xml('presence', { from }, xml('x', { xmlns: ns.user }, xml('item', { role: 'participant' }), xml('status', { code: '110' }))))
      }
      if (stanza.is('message') && options.confirm !== false) {
        if (entity.streamManagement.enabled) entity.streamManagement.emit('ack', stanza)
        else if (stanza.attrs.type === 'groupchat') entity.emit('stanza', xml('message', { from: `${input.rooms}/alice`, type: 'groupchat', id: stanza.attrs.id }, xml('body', {}, stanza.getChildText('body'))))
      }
    })
    entity.iqCaller = { request: vi.fn(async (stanza) => {
      if (options.delayedManagement) expect(entity.streamManagement.enabled).toBe(true)
      const child = stanza.getChildElements()[0]
      if (child.attrs.xmlns === ns.roster) return xml('iq', {}, xml('query', { xmlns: ns.roster }, xml('item', { jid: 'bob@example.org', name: 'Bob', subscription: 'both' })))
      if (child.attrs.xmlns === ns.disco) return xml('iq', {}, xml('query', { xmlns: ns.disco }, ...(stanza.attrs.to === input.rooms ? [xml('feature', { var: ns.muc })] : []), ...(options.mam === false ? [] : [xml('feature', { var: ns.mam })])))
      if (child.attrs.xmlns === ns.mam) {
        const emit = (from: string, sender: string, id: string, body: string) => entity.emit('stanza', xml('message', { from }, xml('result', { xmlns: ns.mam, queryid: child.attrs.queryid, id }, xml('forwarded', { xmlns: ns.forward }, xml('delay', { xmlns: ns.delay, stamp: '2026-01-01T00:00:00Z' }), xml('message', { from: sender, to: input.jid }, xml('body', {}, body))))))
        emit('evil@example.org', 'bob@example.org', 'spoofed-archive', 'Spoofed archive')
        emit(stanza.attrs.to, 'stranger@example.org', 'wrong-room', 'Other conversation')
        emit(stanza.attrs.to, stanza.attrs.to === input.rooms ? `${input.rooms}/bob` : 'bob@example.org', 'archive-1', 'Archived message')
        return xml('iq', {}, xml('fin', { xmlns: ns.mam, complete: 'false' }, xml('set', { xmlns: ns.rsm }, xml('first', {}, 'archive-1'))))
      }
      throw new Error('Unexpected IQ')
    }) }
    clients.push(entity); return entity as ReturnType<typeof client>
  })
  const adapter = new XmppChatAdapter({ create, timeout: 25 }); adapters.push(adapter)
  return { adapter, create, clients }
}
it('authenticates with library SASL only after real TLS, preserves passwords, and scopes identity to endpoint', async () => {
  const f = setup(), connected = await f.adapter.connect(input)
  expect(connected.remoteUserId).toBe('xmpp://example.org:5222|alice@example.org')
  expect(f.clients[0].authenticate).toHaveBeenCalledWith({ username: 'alice', password: ' secret ' }, 'SCRAM-SHA-1', expect.anything())
  expect(f.clients[0].reconnect.stop).toHaveBeenCalled(); expect(f.clients[0].stop).toHaveBeenCalled()
  const plain = setup({ secure: false })
  await expect(plain.adapter.connect({ ...input, service: 'xmpp://localhost:5222' })).rejects.toThrow('No credentials were sent')
  expect(plain.clients[0].authenticate).not.toHaveBeenCalled()
})
it.each(['ws://example.org/xmpp', 'http://example.org', 'xmpps://alice:secret@example.org', 'xmpp://example.org/not-a-stream'])('rejects insecure or malformed endpoint %s', async (service) => {
  const f = setup(); await expect(f.adapter.connect({ ...input, service })).rejects.toThrow(/secure|endpoint/); expect(f.create).not.toHaveBeenCalled()
})
it('surfaces authentication rejection without leaking account passwords', async () => {
  const f = setup({ authError: true }); await expect(f.adapter.connect(input)).rejects.toMatchObject({ kind: 'auth' }); expect(f.clients[0].stop).toHaveBeenCalled()
})
it.each<Record<string, string>>([{ service: 'xmpps://other.example.org:5223' }, { jid: 'bob@example.org' }])('refuses changed reconnect identity before reusing credentials or opening a socket: %j', async (changed) => {
  const f = setup()
  await expect(f.adapter.connect({ ...changed, password: '' }, session)).rejects.toThrow('same XMPP address and endpoint')
  expect(f.create).not.toHaveBeenCalled()
})
it.each(['xmpp://example.org:5222', 'xmpps://example.org:5223', 'wss://example.org/xmpp'])('refuses non-bypassed manual proxy routing before creating a connection: %s', async (service) => {
  const f = setup(); vi.mocked(proxyUrlForHost).mockReturnValue('http://proxy.example.org:8080')
  await expect(f.adapter.connect({ ...input, service })).rejects.toThrow('No direct fallback')
  expect(f.create).not.toHaveBeenCalled()
})
it('loads roster and joins configured existing MUC with explicit archive/read/encryption capabilities', async () => {
  const f = setup(), rooms = await f.adapter.rooms(session)
  expect(rooms).toHaveLength(2)
  expect(rooms[0]).toMatchObject({ id: 'jid:bob@example.org', name: 'Bob', canReadReceipt: false, threaded: false })
  expect(rooms[1]).toMatchObject({ id: `muc:${input.rooms}`, canSend: true, detail: expect.stringContaining('Server message archive available') })
  const presence = f.clients[0].send.mock.calls.find(([stanza]: any[]) => stanza.is('presence') && stanza.attrs.to)?.[0]
  expect(presence.attrs.to).toBe(`${input.rooms}/alice`); expect(presence.getChild('x', ns.muc)).toBeDefined()
})
it('waits for optional stream-management negotiation after online before sending application presence or IQs', async () => {
  const f = setup({ delayedManagement: true }); await f.adapter.connect(input)
  expect(f.clients[0].send).toHaveBeenCalled(); expect(f.clients[0].iqCaller.request).toHaveBeenCalled()
})
it('blocks library-directed server redirection before opening an unconfigured endpoint', async () => {
  const f = setup(); await f.adapter.rooms(session)
  await expect(f.clients[0].connect('xmpps://redirect.example.org:5223')).rejects.toThrow('redirection is not permitted')
})
it('queries MAM/RSM pages and rejects archive spoofing, unrelated participants and cross-room cursors', async () => {
  const f = setup(), rooms = await f.adapter.rooms(session), page = await f.adapter.messages(session, rooms[0], {})
  expect(page.items.map((message) => message.body)).toEqual(['Archived message']); expect(page.cursor).toBeDefined()
  await f.adapter.messages(session, rooms[0], { cursor: page.cursor })
  const request = f.clients[0].iqCaller.request.mock.calls.at(-1)[0]
  expect(request.getChild('query', ns.mam).getChild('set', ns.rsm).getChildText('before')).toBe('archive-1')
  await expect(f.adapter.messages(session, rooms[1], { cursor: page.cursor })).rejects.toThrow('cursor')
  await expect(f.adapter.messages(session, rooms[0], { threadId: 'root' })).rejects.toThrow('thread')
})
it('retains session messages when MAM is unavailable and reports partial history for encrypted-cache merge', async () => {
  const f = setup({ mam: false }), rooms = await f.adapter.rooms(session), entity = f.clients[0]
  entity.emit('stanza', xml('message', { from: 'bob@example.org/laptop', to: input.jid, id: 'live1', type: 'chat' }, xml('body', {}, 'Live message')))
  const page = await f.adapter.messages(session, rooms[0], {})
  expect(page).toMatchObject({ partial: true, items: [{ body: 'Live message' }] })
  expect((await f.adapter.rooms(session))[0]).toMatchObject({ name: 'Bob', unread: 1, detail: expect.stringContaining('Server history unavailable') })
})
it('confirms server handling through SM without enabling automatic reconnect/replay', async () => {
  const f = setup(), rooms = await f.adapter.rooms(session)
  expect(await f.adapter.send(session, rooms[0], 'Hello', undefined, 'durable-id')).toMatchObject({ body: 'Hello', own: true, id: 'wire:alice@example.org:durable-id' })
  const sent = f.clients[0].send.mock.calls.find(([stanza]: any[]) => stanza.is('message'))[0]
  expect(sent.attrs.id).toBe('durable-id'); expect(sent.getChildText('body')).toBe('Hello')
  expect(f.clients[0].reconnect.stop).toHaveBeenCalledTimes(1)
})
it('confirms MUC sends from the room echo when stream acknowledgements are unavailable', async () => {
  const f = setup({ sm: false }), rooms = await f.adapter.rooms(session)
  expect(await f.adapter.send(session, rooms[1], 'Room text')).toMatchObject({ body: 'Room text', own: true })
})
it('marks unacknowledged socket writes uncertain and makes no automatic send retry', async () => {
  const f = setup({ sm: false, confirm: false }), rooms = await f.adapter.rooms(session)
  await expect(f.adapter.send(session, rooms[0], 'Maybe delivered')).rejects.toMatchObject({ kind: 'uncertain' })
  expect(f.clients[0].send.mock.calls.filter(([stanza]: any[]) => stanza.is('message'))).toHaveLength(1)
})
it('reports forbidden MUC membership and closes sessions on suspension', async () => {
  const f = setup({ mucError: true }), rooms = await f.adapter.rooms(session)
  expect(rooms[1]).toMatchObject({ canSend: false, detail: expect.stringContaining('denied') })
  await expect(f.adapter.send(session, rooms[1], 'No access')).rejects.toMatchObject({ kind: 'permission' })
  f.adapter.suspend(); await Promise.resolve(); await Promise.resolve()
  expect(f.clients[0].stop).toHaveBeenCalled()
})
