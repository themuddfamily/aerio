import { createHash, randomUUID } from 'node:crypto'
import type { EventEmitter } from 'node:events'
import { client, jid, xml, type Client, type Options } from '@xmpp/client'
import { proxyUrlForHost } from '../../network-proxy-runtime'
import type { ProviderChatMessage, ProviderChatPage, ProviderChatRoom } from '../../../src/provider-chat-types'
import { ProviderChatError, type ProviderChatAdapter, type ProviderChatSecret, type ProviderChatSession } from './adapter'

type Element = ReturnType<typeof xml>
const ns = { roster: 'jabber:iq:roster', disco: 'http://jabber.org/protocol/disco#info', muc: 'http://jabber.org/protocol/muc', mucUser: 'http://jabber.org/protocol/muc#user', mam: 'urn:xmpp:mam:2', rsm: 'http://jabber.org/protocol/rsm', data: 'jabber:x:data', forward: 'urn:xmpp:forward:0', delay: 'urn:xmpp:delay', sid: 'urn:xmpp:sid:0', sm: 'urn:xmpp:sm:3', receipt: 'urn:xmpp:receipts' }
const string = (value: unknown) => typeof value === 'string' ? value.trim() : ''
function bare(value: string) {
  if (!value || value.length > 1024 || /[\s\u0000-\u001f]/u.test(value)) throw new ProviderChatError('Enter a valid XMPP address (name@example.org)', 'rejected')
  const address = jid(value)
  if (!address.getLocal() || !address.getDomain() || address.getResource()) throw new ProviderChatError('Use an XMPP address without a resource suffix', 'rejected')
  return address.bare().toString()
}
function senderBare(value: string) { try { return jid(value).bare().toString() } catch { return '' } }
function endpoint(value: string, address: string) {
  let url: URL
  try { url = new URL(value || `xmpp://${jid(address).getDomain()}:5222`) } catch { throw new ProviderChatError('Enter an xmpps://, xmpp:// (required STARTTLS), or wss:// endpoint', 'rejected') }
  if (!['xmpps:', 'xmpp:', 'wss:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash || (url.protocol !== 'wss:' && (url.search || (url.pathname && url.pathname !== '/')))) throw new ProviderChatError('Use a secure XMPP endpoint without embedded credentials; plain WebSocket is unsupported', 'rejected')
  url.hostname = url.hostname.toLowerCase()
  return url.toString().replace(/\/$/, url.protocol === 'wss:' ? '/' : '')
}
function list(value: string) { const items = [...new Set(value.split(/[,;\n]+/).map((entry) => entry.trim()).filter(Boolean).map(bare))]; if (items.length > 100) throw new ProviderChatError('Configure at most 100 contacts or rooms', 'rejected'); return items }
function failure(error: unknown, sending = false): ProviderChatError {
  if (error instanceof ProviderChatError) return error
  const value = error as { name?: string; condition?: string }
  if (value?.name === 'SASLError' || ['not-authorized', 'account-disabled', 'credentials-expired'].includes(value?.condition ?? '')) return new ProviderChatError('XMPP sign-in was rejected. Reconnect with the correct account credentials.', 'auth')
  if (['forbidden', 'not-allowed', 'registration-required', 'not-acceptable'].includes(value?.condition ?? '')) return new ProviderChatError('The XMPP server denied this operation or room membership.', 'permission')
  if (['service-unavailable', 'feature-not-implemented', 'item-not-found', 'remote-server-not-found', 'recipient-unavailable', 'conflict'].includes(value?.condition ?? '')) return new ProviderChatError(`XMPP rejected the operation (${value.condition}).`, 'rejected')
  return new ProviderChatError(sending ? 'XMPP did not confirm this send. Check the conversation before sending again.' : 'XMPP connection failed. Check the server certificate, endpoint and network, then reconnect.', sending ? 'uncertain' : 'network')
}
interface State {
  xmpp: Client; key: string; identity: string; nickname: string; stopped: boolean
  rooms: Map<string, ProviderChatRoom>; messages: Map<string, ProviderChatMessage[]>; joined: Set<string>; features: Map<string, Set<string>>
}
export interface XmppDependencies { create?: (options: Options) => Client; timeout?: number }
/** Uses xmpp.js for XML streams, TLS, SASL, resource binding, IQ routing and stream acknowledgements. */
export class XmppChatAdapter implements ProviderChatAdapter {
  private readonly connections = new Map<string, Promise<State>>()
  private generation = 0
  private readonly epochs = new Map<string, number>()
  private readonly timeout: number
  constructor(private readonly deps: XmppDependencies = {}) { this.timeout = deps.timeout ?? 15_000 }
  descriptor() {
    return { id: 'xmpp' as const, name: 'XMPP / Jabber', available: true, detail: 'Existing account over verified TLS (STARTTLS, direct TLS or WSS). Roster, direct chat and configured existing MUC rooms; server history when advertised. No OMEMO or Matrix E2EE. A send is confirmed by server acknowledgement or room echo, not recipient reading.', fields: [
      { key: 'jid', label: 'XMPP address', type: 'text' as const }, { key: 'password', label: 'Password (leave blank to keep it when reconnecting)', type: 'password' as const },
      { key: 'service', label: 'Endpoint (optional; default STARTTLS on your XMPP domain)', type: 'text' as const },
      { key: 'contacts', label: 'Additional contact addresses (comma separated)', type: 'text' as const }, { key: 'rooms', label: 'Existing MUC room addresses (comma separated)', type: 'text' as const }, { key: 'nickname', label: 'Room nickname (optional)', type: 'text' as const }
    ] }
  }
  private stopped(state: State) { if (state.stopped) throw new ProviderChatError('XMPP connection was closed; refresh after unlocking or reconnecting.', 'network') }
  private async stop(state: State) { state.stopped = true; state.messages.clear(); state.xmpp.reconnect.stop(); await state.xmpp.stop().catch(() => {}) }
  suspend() {
    this.generation++
    const pending = [...this.connections.values()]; this.connections.clear()
    for (const connection of pending) void connection.then((state) => this.stop(state)).catch(() => {})
  }
  async disconnect(session: ProviderChatSession) { const id = session.account.id, pending = this.connections.get(id); this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1); this.connections.delete(id); if (pending) await this.stop(await pending) }
  private async iq(state: State, type: 'get' | 'set', child: Element, to?: string) {
    this.stopped(state)
    try { const result = await state.xmpp.iqCaller.request(xml('iq', { type, ...(to ? { to } : {}) }, child), this.timeout); this.stopped(state); return result }
    catch (error) { throw failure(error) }
  }
  private async features(state: State, target: string) {
    const cached = state.features.get(target); if (cached) return cached
    try {
      const response = await this.iq(state, 'get', xml('query', { xmlns: ns.disco }), target)
      const query = response.getChild('query', ns.disco)
      const features = new Set((query?.getChildren('feature') ?? []).map((item) => item.attrs.var).filter(Boolean))
      state.features.set(target, features); return features
    } catch (error) {
      if (error instanceof ProviderChatError && error.kind === 'rejected') { const features = new Set<string>(); state.features.set(target, features); return features }
      throw error
    }
  }
  private room(state: State, accountId: string, target: string, name: string, muc: boolean) {
    const id = `${muc ? 'muc' : 'jid'}:${target}`, previous = state.rooms.get(id)
    const room: ProviderChatRoom = previous ?? { accountId, id, name, kind: muc ? 'group' : 'direct', unread: 0, canSend: true, canReadReceipt: false, threaded: false, resource: { jid: target, muc: String(muc) } }
    room.name = name; state.rooms.set(id, room); return room
  }
  private message(state: State, room: ProviderChatRoom, stanza: Element, archiveId?: string, stamp?: string): ProviderChatMessage | undefined {
    const body = stanza.getChildText('body')
    if (!body || stanza.attrs.type === 'error') return undefined
    const from = stanza.attrs.from ?? '', fromBare = senderBare(from), muc = room.resource.muc === 'true'
    if (muc ? fromBare !== room.resource.jid : !([state.identity, room.resource.jid].includes(fromBare) && [state.identity, room.resource.jid].includes(senderBare(stanza.attrs.to ?? state.identity)))) return undefined
    const delay = stamp ?? stanza.getChild('delay', ns.delay)?.attrs.stamp
    const timestamp = delay && Number.isFinite(Date.parse(delay)) ? new Date(delay).toISOString() : new Date().toISOString()
    const sid = stanza.getChildren('stanza-id', ns.sid).find((item) => item.attrs.by === (muc ? room.resource.jid : state.identity))?.attrs.id
    const id = stanza.attrs.id ? `wire:${muc ? from : fromBare}:${stanza.attrs.id}` : sid || archiveId ? `archive:${sid || archiveId}` : `wire:${from}:${createHash('sha256').update(`${timestamp}\0${body}`).digest('hex')}`
    const resource = from.slice(from.indexOf('/') + 1)
    return { id, senderId: from, sender: muc ? resource || room.name : fromBare, timestamp, body: body.length > 28_000 ? `${body.slice(0, 28_000)}…` : body, own: muc ? from === `${room.resource.jid}/${state.nickname}` : fromBare === state.identity }
  }
  private append(state: State, room: ProviderChatRoom, message: ProviderChatMessage, unread: boolean) {
    const previous = state.messages.get(room.id) ?? []
    if (previous.some((item) => item.id === message.id)) return
    state.messages.set(room.id, [...previous, message].slice(-500))
    if (!room.lastActivity || message.timestamp > room.lastActivity) room.lastActivity = message.timestamp
    if (unread && !message.own) room.unread = Math.min(999, room.unread + 1)
  }
  private receive(state: State, accountId: string, stanza: Element) {
    if (!state.stopped && stanza.is('presence')) {
      const from = stanza.attrs.from ?? '', room = state.rooms.get(`muc:${senderBare(from)}`)
      if (room && from === `${room.resource.jid}/${state.nickname}`) {
        const own = stanza.getChild('x', ns.mucUser)
        if (own?.getChildren('status').some((item) => item.attrs.code === '110')) {
          room.canSend = !['error', 'unavailable'].includes(stanza.attrs.type) && own.getChild('item')?.attrs.role !== 'visitor'
          if (stanza.attrs.type === 'unavailable') { state.joined.delete(room.resource.jid); room.detail = 'Room membership ended. Refresh to rejoin if permitted.' }
        }
      }
      return
    }
    if (state.stopped || !stanza.is('message') || stanza.getChild('result', ns.mam) || stanza.attrs.type === 'error') return
    const from = senderBare(stanza.attrs.from ?? '')
    if (!from || !stanza.getChildText('body')) return
    const muc = stanza.attrs.type === 'groupchat'
    const existing = state.rooms.get(`muc:${from}`)
    if (muc && (!existing || !state.joined.has(from))) return
    if (!muc && !['chat', 'normal', undefined].includes(stanza.attrs.type)) return
    let target: string
    try { target = bare(from) } catch { return }
    const room = muc ? existing! : this.room(state, accountId, target, state.rooms.get(`jid:${target}`)?.name ?? target, false)
    const message = this.message(state, room, stanza)
    if (message) {
      this.append(state, room, message, !stanza.getChild('delay', ns.delay))
      if (!muc && !message.own && stanza.attrs.id && stanza.getChild('request', ns.receipt)) void state.xmpp.send(xml('message', { to: stanza.attrs.from, type: 'chat' }, xml('received', { xmlns: ns.receipt, id: stanza.attrs.id }))).catch(() => {})
    }
  }
  private async open(accountId: string, secret: ProviderChatSecret): Promise<State> {
    const identity = bare(secret.jid), service = endpoint(secret.service, identity), generation = this.generation
    this.proxyGuard(service)
    let authenticated = false
    const xmpp = (this.deps.create ?? client)({ service, domain: jid(identity).getDomain(), resource: `Aerio-${randomUUID().slice(0, 12)}`, timeout: this.timeout,
      credentials: async (authenticate, mechanisms, _fast, entity) => {
        if (generation !== this.generation) throw new ProviderChatError('XMPP connection was suspended before authentication', 'network')
        // xmpp.js considers localhost plain sockets secure; require actual TLS/WSS even there.
        const secure = service.startsWith('wss:') ? entity.isSecure() : (entity.socket as unknown as { secure?: boolean } | null)?.secure === true
        if (!secure) throw new ProviderChatError('The XMPP server did not negotiate TLS. No credentials were sent.', 'rejected')
        const mechanism = ['SCRAM-SHA-1', 'PLAIN'].find((item) => mechanisms.includes(item))
        if (!mechanism) throw new ProviderChatError('The XMPP server offers no supported authenticated SASL mechanism.', 'auth')
        await authenticate({ username: jid(identity).getLocal(), password: secret.password }, mechanism, xml('user-agent', {}, xml('software', {}, 'Aerio')))
        authenticated = true
      }
    })
    const state: State = { xmpp, identity, nickname: secret.nickname, key: JSON.stringify(secret), stopped: false, rooms: new Map(), messages: new Map(), joined: new Set(), features: new Map() }
    const connect = xmpp.connect.bind(xmpp)
    xmpp.connect = async (target: string) => {
      if (endpoint(target, identity) !== service) throw new ProviderChatError('XMPP server redirection is not permitted. Configure the intended endpoint explicitly.', 'rejected')
      this.proxyGuard(service)
      return connect(target)
    }
    // Resource binding emits online before xmpp.js finishes optional SM negotiation. Sending presence/IQs
    // during that gap can reset inbound counters after they have already been acknowledged (notably WSS).
    let managementOffered = false, managementSettled = false
    let settleManagement!: () => void
    const managementReady = new Promise<void>((resolve) => { settleManagement = resolve })
    const negotiated = (element: Element) => {
      if (element.is('features', 'http://etherx.jabber.org/streams') && element.getChild('sm', ns.sm)) managementOffered = true
      if (element.getNS() === ns.sm && ['enabled', 'failed', 'resumed'].includes(element.name)) {
        setImmediate(() => { managementSettled = true; settleManagement() })
      }
    }
    xmpp.on('element', negotiated)
    xmpp.reconnect.stop() // Never replay the library's unacknowledged stream-management queue.
    xmpp.on('error', () => {}) // Errors are surfaced through awaited operations/status rather than logging credentials.
    xmpp.on('stanza', (stanza: Element) => this.receive(state, accountId, stanza))
    try {
      let timer: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([(async () => { await xmpp.start(); if (managementOffered && !managementSettled) await managementReady })(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new ProviderChatError('XMPP connection timed out', 'network')), this.timeout) })]) }
      finally { clearTimeout(timer) }
      if (generation !== this.generation) throw new ProviderChatError('XMPP connection was suspended', 'network')
      if (!authenticated || xmpp.jid?.bare().toString() !== identity) throw new ProviderChatError('The XMPP server bound a different account identity', 'auth')
      xmpp.removeListener('element', negotiated)
      await xmpp.send(xml('presence'))
      return state
    } catch (error) { xmpp.removeListener('element', negotiated); await this.stop(state); throw failure(error) }
  }
  private async state(session: ProviderChatSession): Promise<State> {
    try { this.proxyGuard(session.secret.service) } catch (error) { void this.disconnect(session).catch(() => {}); throw error }
    const generation = this.generation, epoch = this.epochs.get(session.account.id) ?? 0
    const unchanged = () => { if (generation !== this.generation || epoch !== (this.epochs.get(session.account.id) ?? 0)) throw new ProviderChatError('XMPP connection changed while opening', 'network') }
    let pending = this.connections.get(session.account.id)
    if (pending) {
      const previous = await pending.catch(() => undefined)
      unchanged()
      if (previous && !previous.stopped && previous.key === JSON.stringify(session.secret) && previous.xmpp.status === 'online') return previous
      if (previous) await this.stop(previous)
      unchanged()
      if (this.connections.get(session.account.id) !== pending) return this.state(session)
      this.connections.delete(session.account.id)
    }
    pending = this.open(session.account.id, session.secret); this.connections.set(session.account.id, pending)
    try { return await pending } catch (error) { if (this.connections.get(session.account.id) === pending) this.connections.delete(session.account.id); throw error }
  }
  private proxyGuard(service: string) {
    if (proxyUrlForHost(new URL(service).hostname)) throw new ProviderChatError('This XMPP endpoint requires the configured manual proxy, which this connector does not support (including WSS). No direct fallback was used. Review Network settings or use an explicitly configured host bypass.', 'rejected')
  }
  async connect(input: Record<string, string | boolean>, existing?: ProviderChatSession) {
    const identity = bare(string(input.jid) || existing?.secret.jid || '')
    const service = endpoint(string(input.service) || existing?.secret.service || '', identity)
    if (existing && (identity !== existing.secret.jid || service !== existing.secret.service)) throw new ProviderChatError('Reconnect with the same XMPP address and endpoint. Add a new connection to use another server or identity.', 'rejected')
    const password = (typeof input.password === 'string' ? input.password : '') || existing?.secret.password || ''
    if (!password || password.length > 4096) throw new ProviderChatError('Enter the XMPP account password', 'auth')
    const nickname = string(input.nickname) || existing?.secret.nickname || jid(identity).getLocal()!
    if (nickname.length > 100 || /[\u0000-\u001f/]/u.test(nickname)) throw new ProviderChatError('Use a room nickname without control characters or slashes', 'rejected')
    const configured = (key: 'contacts' | 'rooms') => input[key] === undefined && existing ? JSON.parse(existing.secret[key] || '[]').join(',') : string(input[key])
    const secret = { jid: identity, service, password, nickname, contacts: JSON.stringify(list(configured('contacts'))), rooms: JSON.stringify(list(configured('rooms'))) }
    const state = await this.open(`probe:${randomUUID()}`, secret)
    try { await this.iq(state, 'get', xml('query', { xmlns: ns.roster })) } finally { await this.stop(state) }
    return { remoteUserId: `${service}|${identity}`, name: identity, secret }
  }
  private async join(state: State, room: ProviderChatRoom) {
    const target = room.resource.jid
    if (state.joined.has(target)) return
    const features = await this.features(state, target)
    if (!features.has(ns.muc)) { room.canSend = false; room.detail = 'This address does not advertise an existing MUC room.'; return }
    state.joined.add(target)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => done(new ProviderChatError('The XMPP room did not confirm membership. Refresh to try again.', 'network')), this.timeout)
      const listener = (stanza: Element) => {
        if (!stanza.is('presence') || senderBare(stanza.attrs.from ?? '') !== target) return
        if (stanza.attrs.type === 'error') { const error = stanza.getChild('error'); done(failure({ condition: error?.getChildElements().find((child) => child.name !== 'text')?.name })); return }
        const own = stanza.getChild('x', ns.mucUser)
        if (stanza.attrs.from !== `${target}/${state.nickname}` || !own?.getChildren('status').some((item) => item.attrs.code === '110')) return
        room.canSend = own.getChild('item')?.attrs.role !== 'visitor'
        done()
      }
      const done = (error?: Error) => { clearTimeout(timer); state.xmpp.removeListener('stanza', listener); if (error) { state.joined.delete(target); reject(error) } else resolve() }
      state.xmpp.on('stanza', listener)
      void state.xmpp.send(xml('presence', { to: `${target}/${state.nickname}` }, xml('x', { xmlns: ns.muc }, xml('history', { maxstanzas: '50' })))).catch((error) => done(failure(error)))
    })
  }
  async rooms(session: ProviderChatSession) {
    const state = await this.state(session)
    const roster = (await this.iq(state, 'get', xml('query', { xmlns: ns.roster }))).getChild('query', ns.roster)
    for (const item of roster?.getChildren('item') ?? []) {
      if (item.attrs.subscription === 'remove') continue
      try { const target = bare(item.attrs.jid); this.room(state, session.account.id, target, string(item.attrs.name) || target, false) } catch { /* Ignore malformed remote roster entries. */ }
    }
    for (const target of JSON.parse(session.secret.contacts || '[]') as string[]) this.room(state, session.account.id, bare(target), target, false)
    await this.features(state, state.identity)
    for (const target of JSON.parse(session.secret.rooms || '[]') as string[]) {
      const room = this.room(state, session.account.id, bare(target), target, true)
      try { await this.join(state, room) } catch (error) { room.canSend = false; room.detail = error instanceof Error ? error.message : 'Room membership unavailable' }
    }
    for (const room of state.rooms.values()) {
      if (!room.detail) room.detail = (state.features.get(room.resource.muc === 'true' ? room.resource.jid : state.identity)?.has(ns.mam) ? 'Server message archive available.' : 'Server history unavailable; encrypted local history and messages received by this Aerio session are shown.') + ' Read markers, threads, files and end-to-end encryption are not supported here.'
    }
    this.stopped(state); return [...state.rooms.values()]
  }
  private async selected(session: ProviderChatSession, room: ProviderChatRoom) {
    const state = await this.state(session)
    if (!state.rooms.has(room.id)) await this.rooms(session)
    const current = state.rooms.get(room.id)
    if (!current || current.resource.jid !== room.resource.jid || current.resource.muc !== room.resource.muc) throw new ProviderChatError('XMPP conversation is not part of this account', 'rejected')
    return { state, room: current }
  }
  private async archive(state: State, room: ProviderChatRoom, cursor?: string): Promise<ProviderChatPage> {
    const muc = room.resource.muc === 'true', target = muc ? room.resource.jid : state.identity
    let before = ''
    if (cursor) {
      try { const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString()); if (parsed.room !== room.id || typeof parsed.before !== 'string' || parsed.before.length > 2048) throw new Error(); before = parsed.before }
      catch { throw new ProviderChatError('Invalid XMPP history cursor for this conversation', 'rejected') }
    }
    const queryId = randomUUID(), items: ProviderChatMessage[] = []
    const listener = (stanza: Element) => {
      if (!stanza.is('message') || (muc && !stanza.attrs.from) || (stanza.attrs.from && senderBare(stanza.attrs.from) !== target)) return
      const result = stanza.getChild('result', ns.mam)
      if (result?.attrs.queryid !== queryId || !result.attrs.id || items.length >= 100) return
      const forwarded = result.getChild('forwarded', ns.forward), message = forwarded?.getChild('message')
      if (!message) return
      const mapped = this.message(state, room, message, result.attrs.id, forwarded?.getChild('delay', ns.delay)?.attrs.stamp)
      if (mapped) items.push(mapped)
    }
    state.xmpp.on('stanza', listener)
    try {
      const response = await this.iq(state, 'set', xml('query', { xmlns: ns.mam, queryid: queryId },
        xml('x', { xmlns: ns.data, type: 'submit' }, xml('field', { var: 'FORM_TYPE', type: 'hidden' }, xml('value', {}, ns.mam)), ...(muc ? [] : [xml('field', { var: 'with' }, xml('value', {}, room.resource.jid))])),
        xml('set', { xmlns: ns.rsm }, xml('max', {}, '50'), xml('before', {}, before))), target)
      const fin = response.getChild('fin', ns.mam)
      if (!fin) throw new ProviderChatError('XMPP archive did not return a completion marker', 'network')
      const first = fin.getChild('set', ns.rsm)?.getChildText('first')
      return { items, ...(!['true', '1'].includes(fin.attrs.complete) && first && items.length ? { cursor: Buffer.from(JSON.stringify({ room: room.id, before: first })).toString('base64url') } : {}) }
    } finally { state.xmpp.removeListener('stanza', listener) }
  }
  async messages(session: ProviderChatSession, input: ProviderChatRoom, options: { cursor?: string; threadId?: string }) {
    if (options.threadId) throw new ProviderChatError('XMPP thread views are not supported', 'rejected')
    const { state, room } = await this.selected(session, input), archive = state.features.get(room.resource.muc === 'true' ? room.resource.jid : state.identity)?.has(ns.mam)
    if (!archive) { if (options.cursor) throw new ProviderChatError('This XMPP server does not advertise message archives', 'rejected'); return { items: state.messages.get(room.id) ?? [], partial: true } }
    const page = await this.archive(state, room, options.cursor)
    if (!options.cursor) page.items = [...new Map([...page.items, ...(state.messages.get(room.id) ?? [])].map((item) => [item.id, item])).values()]
    return page
  }
  async send(session: ProviderChatSession, input: ProviderChatRoom, body: string, threadId?: string, clientRequestId: string = randomUUID()) {
    if (threadId) throw new ProviderChatError('XMPP thread replies are not supported', 'rejected')
    const { state, room } = await this.selected(session, input)
    if (!room.canSend) throw new ProviderChatError('XMPP room membership does not permit sending', 'permission')
    const muc = room.resource.muc === 'true', target = room.resource.jid
    const stanza = xml('message', { to: target, type: muc ? 'groupchat' : 'chat', id: clientRequestId }, xml('body', {}, body), xml('origin-id', { xmlns: ns.sid, id: clientRequestId }), ...(muc ? [] : [xml('request', { xmlns: ns.receipt })]))
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => done(new ProviderChatError('XMPP send was not acknowledged. Check the provider before sending again.', 'uncertain')), this.timeout)
        const ack = (message: Element) => { if (message.is('message') && message.attrs.id === clientRequestId) done() }
        const listener = (message: Element) => {
          if (!message.is('message') || senderBare(message.attrs.from ?? '') !== target) return
          if (message.attrs.id === clientRequestId && message.attrs.type === 'error') { done(failure({ condition: message.getChild('error')?.getChildElements().find((child) => child.name !== 'text')?.name }, true)); return }
          if ((muc && message.attrs.from === `${target}/${state.nickname}` && message.attrs.id === clientRequestId && message.getChildText('body') === body) || (!muc && message.getChild('received', ns.receipt)?.attrs.id === clientRequestId)) done()
        }
        const disconnected = () => done(new ProviderChatError('XMPP disconnected before confirming the send. Check the provider before sending again.', 'uncertain'))
        // Upstream runtime emits documented ack events; its DefinitelyTyped interface omits EventEmitter.
        const management = state.xmpp.streamManagement as typeof state.xmpp.streamManagement & EventEmitter
        const done = (error?: Error) => { clearTimeout(timer); management.removeListener('ack', ack); state.xmpp.removeListener('stanza', listener); state.xmpp.removeListener('disconnect', disconnected); error ? reject(error) : resolve() }
        management.on('ack', ack); state.xmpp.on('stanza', listener); state.xmpp.on('disconnect', disconnected)
        void state.xmpp.send(stanza).then(() => { if (state.xmpp.streamManagement.enabled) return state.xmpp.send(xml('r', { xmlns: ns.sm })) }).catch((error) => done(failure(error, true)))
      })
      this.stopped(state)
      const message = this.message(state, room, xml('message', { from: muc ? `${target}/${state.nickname}` : state.identity, to: target, id: clientRequestId }, xml('body', {}, body)))!
      this.append(state, room, message, false); return message
    } catch (error) { throw failure(error, true) }
  }
}
