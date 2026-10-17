import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * A controlled loopback Matrix homeserver for automated tests only. It speaks
 * enough of the client-server API (login, sync, rooms, send with transaction
 * idempotency, pagination, redaction, device keys, one-time key claims,
 * to-device messages and media) for two real `matrix-js-sdk` Rust-crypto
 * devices to exchange encrypted messages. It is not a conformance target:
 * passing against it does not establish hosted interoperability.
 */

interface MatrixEvent {
  event_id: string
  room_id: string
  sender: string
  type: string
  state_key?: string
  content: Record<string, unknown>
  origin_server_ts: number
  unsigned?: Record<string, unknown>
  redacts?: string
}

interface StoredEvent { pos: number; event: MatrixEvent; txn?: { token: string; txnId: string } }
interface Session { userId: string; deviceId: string; token: string }
interface Device { keys?: Record<string, unknown>; oneTimeKeys: Map<string, unknown>; fallbackKeys: Map<string, unknown> }
interface Room { id: string; events: StoredEvent[]; state: Map<string, MatrixEvent> }

export interface FakeHomeserverOptions {
  /** Fail the next N `send` requests after recording them (simulates a lost response). */
  dropSendResponses?: number
  uploadLimit?: number
}

export class FakeHomeserver {
  private server: Server
  private pos = 0
  private counter = 0
  readonly users = new Map<string, string>()
  readonly sessions = new Map<string, Session>()
  readonly devices = new Map<string, Map<string, Device>>()
  readonly rooms = new Map<string, Room>()
  private readonly toDevice = new Map<string, { pos: number; message: Record<string, unknown> }[]>()
  private readonly deviceListChanges: { pos: number; userId: string }[] = []
  private readonly crossSigning = new Map<string, Record<string, unknown>>()
  private readonly txns = new Map<string, string>()
  private readonly media = new Map<string, { bytes: Buffer; type: string }>()
  private backup?: { version: string; algorithm: unknown; auth_data: unknown; rooms: Record<string, { sessions: Record<string, unknown> }> }
  private readonly accountData = new Map<string, { pos: number; content: Record<string, unknown> }>()
  private waiters = new Set<() => void>()
  readonly requests: { method: string; path: string; authorization?: string; body?: string }[] = []
  dropSendResponses: number
  uploadLimit: number
  url = ''

  constructor(options: FakeHomeserverOptions = {}) {
    this.dropSendResponses = options.dropSendResponses ?? 0
    this.uploadLimit = options.uploadLimit ?? 50 * 1024 * 1024
    this.server = createServer((request, response) => { void this.handle(request, response) })
  }

  async start() {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    return this
  }

  async stop() {
    for (const wake of this.waiters) wake()
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  addUser(localpart: string, password: string) {
    const userId = `@${localpart}:localhost`
    this.users.set(userId, password)
    return userId
  }

  /** Server-side helper: create a room directly (bypassing the client API). */
  createRoomAs(userId: string, options: { encrypted?: boolean; invite?: string[]; join?: string[]; name?: string } = {}) {
    const room: Room = { id: `!r${++this.counter}:localhost`, events: [], state: new Map() }
    this.rooms.set(room.id, room)
    this.append(room, { sender: userId, type: 'm.room.create', state_key: '', content: { creator: userId, room_version: '10' } })
    this.append(room, { sender: userId, type: 'm.room.member', state_key: userId, content: { membership: 'join' } })
    this.append(room, { sender: userId, type: 'm.room.power_levels', state_key: '', content: { users: { [userId]: 100 }, users_default: 0, events_default: 0, state_default: 50, redact: 50 } })
    this.append(room, { sender: userId, type: 'm.room.join_rules', state_key: '', content: { join_rule: 'invite' } })
    this.append(room, { sender: userId, type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'shared' } })
    if (options.name) this.append(room, { sender: userId, type: 'm.room.name', state_key: '', content: { name: options.name } })
    if (options.encrypted) this.append(room, { sender: userId, type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } })
    for (const invitee of options.invite ?? []) this.append(room, { sender: userId, type: 'm.room.member', state_key: invitee, content: { membership: 'invite' } })
    for (const member of options.join ?? []) this.append(room, { sender: member, type: 'm.room.member', state_key: member, content: { membership: 'join' } })
    return room.id
  }

  /** Server-side helper: post an event as a user. */
  post(roomId: string, sender: string, type: string, content: Record<string, unknown>, stateKey?: string) {
    return this.append(this.rooms.get(roomId)!, { sender, type, content, ...(stateKey === undefined ? {} : { state_key: stateKey }) }).event_id
  }

  membership(roomId: string, userId: string) {
    return (this.rooms.get(roomId)?.state.get(`m.room.member|${userId}`)?.content.membership as string | undefined) ?? 'leave'
  }

  private append(room: Room, partial: Omit<MatrixEvent, 'event_id' | 'room_id' | 'origin_server_ts'>, txn?: { token: string; txnId: string }) {
    const event: MatrixEvent = { ...partial, event_id: `$e${++this.counter}`, room_id: room.id, origin_server_ts: Date.now() }
    if (event.state_key !== undefined) room.state.set(`${event.type}|${event.state_key}`, event)
    if (event.type === 'm.room.redaction' && event.redacts) {
      const target = room.events.find((item) => item.event.event_id === event.redacts)
      if (target) { target.event.content = {}; target.event.unsigned = { ...target.event.unsigned, redacted_because: event } }
    }
    room.events.push({ pos: ++this.pos, event, txn })
    this.wake()
    return event
  }

  private wake() {
    const waiters = this.waiters
    this.waiters = new Set()
    for (const wake of waiters) wake()
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const raw = Buffer.concat(chunks)
    const authorization = request.headers.authorization
    this.requests.push({ method: request.method ?? 'GET', path: url.pathname, authorization, body: raw.length && raw.length < 20_000 ? raw.toString() : undefined })
    const send = (status: number, body: unknown) => {
      if (response.destroyed) return
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    try {
      const result = await this.route(request.method ?? 'GET', url, raw, authorization, request.headers['content-type'])
      if (Buffer.isBuffer(result)) { response.writeHead(200, { 'Content-Type': 'application/octet-stream' }); response.end(result); return }
      if (result === 'drop') { response.destroy(); return }
      const reply = result as { status?: number; body: unknown }
      send(reply.status ?? 200, reply.body)
    } catch (error) {
      send(500, { errcode: 'M_UNKNOWN', error: error instanceof Error ? error.message : String(error) })
    }
  }

  private session(authorization?: string) {
    const token = authorization?.replace(/^Bearer /, '')
    return token ? this.sessions.get(token) : undefined
  }

  private device(userId: string, deviceId: string) {
    if (!this.devices.has(userId)) this.devices.set(userId, new Map())
    const devices = this.devices.get(userId)!
    if (!devices.has(deviceId)) devices.set(deviceId, { oneTimeKeys: new Map(), fallbackKeys: new Map() })
    return devices.get(deviceId)!
  }

  private sharesRoom(a: string, b: string) {
    if (a === b) return true
    for (const room of this.rooms.values()) {
      const ma = room.state.get(`m.room.member|${a}`)?.content.membership
      const mb = room.state.get(`m.room.member|${b}`)?.content.membership
      if ((ma === 'join' || ma === 'invite') && (mb === 'join' || mb === 'invite')) return true
    }
    return false
  }

  private async route(method: string, url: URL, raw: Buffer, authorization: string | undefined, contentType?: string): Promise<{ status?: number; body: unknown } | Buffer | 'drop'> {
    const path = url.pathname
    const body = () => (raw.length ? JSON.parse(raw.toString()) : {}) as Record<string, any>
    if (path === '/.well-known/matrix/client') return { status: 404, body: {} }
    if (path === '/_matrix/client/versions') return { body: { versions: ['v1.1', 'v1.5', 'v1.11'], unstable_features: {} } }
    if (path === '/_matrix/client/v3/login' && method === 'GET') return { body: { flows: [{ type: 'm.login.password' }, { type: 'm.login.sso' }] } }
    if (path === '/_matrix/client/v3/login' && method === 'POST') {
      const input = body()
      const localpart = String(input.identifier?.user ?? input.user ?? '')
      const userId = localpart.startsWith('@') ? localpart : `@${localpart}:localhost`
      if (this.users.get(userId) !== input.password) return { status: 403, body: { errcode: 'M_FORBIDDEN', error: 'Invalid password' } }
      const session = { userId, deviceId: typeof input.device_id === 'string' ? input.device_id : `DEV${randomBytes(4).toString('hex').toUpperCase()}`, token: `syt_${randomBytes(12).toString('hex')}` }
      this.sessions.set(session.token, session)
      this.device(userId, session.deviceId)
      return { body: { user_id: userId, device_id: session.deviceId, access_token: session.token } }
    }
    if (path.startsWith('/_matrix/media/v3/config') || path.startsWith('/_matrix/client/v1/media/config')) return { body: { 'm.upload.size': this.uploadLimit } }
    const session = this.session(authorization)
    if (!session) return { status: 401, body: { errcode: 'M_UNKNOWN_TOKEN', error: 'Unknown token' } }
    const { userId, deviceId } = session
    const segments = path.split('/').map(decodeURIComponent)
    if (path === '/_matrix/client/v3/account/whoami') return { body: { user_id: userId, device_id: deviceId } }
    if (path === '/_matrix/client/v3/logout') { this.sessions.delete(session.token); this.devices.get(userId)?.delete(deviceId); this.deviceListChanges.push({ pos: ++this.pos, userId }); return { body: {} } }
    if (path.startsWith('/_matrix/client/v3/pushrules')) return { body: { global: { override: [], content: [], room: [], sender: [], underride: [] } } }
    if (path.includes('/filter')) return method === 'POST' ? { body: { filter_id: '1' } } : { body: {} }
    if (path === '/_matrix/client/v3/capabilities') return { body: { capabilities: {} } }
    if (path.includes('/account_data/') && segments[6] === 'account_data') {
      const key = `${userId}|${segments[7]}`
      if (method === 'PUT') { this.accountData.set(key, { pos: ++this.pos, content: body() }); this.wake(); return { body: {} } }
      const stored = this.accountData.get(key)
      return stored ? { body: stored.content } : { status: 404, body: { errcode: 'M_NOT_FOUND', error: 'Not found' } }
    }
    if (path.includes('/account_data/')) return method === 'GET' ? { status: 404, body: { errcode: 'M_NOT_FOUND', error: 'Not found' } } : { body: {} }
    if (path.startsWith('/_matrix/client/v3/room_keys/version')) {
      if (method === 'POST') { this.backup = { version: String(++this.counter), algorithm: body().algorithm, auth_data: body().auth_data, rooms: {} }; return { body: { version: this.backup.version } } }
      if (method === 'PUT' && this.backup) { this.backup.auth_data = body().auth_data; return { body: {} } }
      if (method === 'DELETE') { this.backup = undefined; return { body: {} } }
      return this.backup ? { body: { version: this.backup.version, algorithm: this.backup.algorithm, auth_data: this.backup.auth_data, count: 0, etag: '0' } } : { status: 404, body: { errcode: 'M_NOT_FOUND', error: 'No backup' } }
    }
    if (path.startsWith('/_matrix/client/v3/room_keys/keys')) {
      if (!this.backup) return { status: 404, body: { errcode: 'M_NOT_FOUND', error: 'No backup' } }
      if (method === 'PUT') {
        for (const [room, value] of Object.entries((body().rooms ?? {}) as Record<string, { sessions: Record<string, unknown> }>)) this.backup.rooms[room] = { sessions: { ...this.backup.rooms[room]?.sessions, ...value.sessions } }
        return { body: { etag: '1', count: Object.values(this.backup.rooms).reduce((total, room) => total + Object.keys(room.sessions).length, 0) } }
      }
      return { body: { rooms: this.backup.rooms } }
    }
    if (path.startsWith('/_matrix/client/v3/profile/')) return { body: {} }
    if (path === '/_matrix/client/v3/keys/changes') return { body: { changed: [], left: [] } }
    if (path === '/_matrix/client/v3/voip/turnServer') return { body: {} }
    if (path.startsWith('/_matrix/client/v3/thirdparty')) return { body: {} }
    if (path === '/_matrix/client/v3/keys/upload') {
      const input = body()
      const device = this.device(userId, deviceId)
      if (input.device_keys) { device.keys = input.device_keys; this.deviceListChanges.push({ pos: ++this.pos, userId }); this.wake() }
      for (const [id, key] of Object.entries(input.one_time_keys ?? {})) device.oneTimeKeys.set(id, key)
      for (const [id, key] of Object.entries(input.fallback_keys ?? {})) { device.fallbackKeys.clear(); device.fallbackKeys.set(id, key) }
      return { body: { one_time_key_counts: { signed_curve25519: device.oneTimeKeys.size } } }
    }
    if (path === '/_matrix/client/v3/keys/device_signing/upload') {
      const input = body()
      this.crossSigning.set(userId, { ...this.crossSigning.get(userId), ...input })
      this.deviceListChanges.push({ pos: ++this.pos, userId }); this.wake()
      return { body: {} }
    }
    if (path === '/_matrix/client/v3/keys/signatures/upload') {
      for (const [target, keys] of Object.entries(body())) {
        for (const [keyId, signed] of Object.entries(keys as Record<string, any>)) {
          const device = this.devices.get(target)?.get(keyId)
          if (device?.keys) device.keys = { ...device.keys, signatures: mergeSignatures(device.keys.signatures as any, signed.signatures) }
          const cross = this.crossSigning.get(target)
          const master = cross?.master_key as Record<string, any> | undefined
          if (master && Object.keys(master.keys ?? {}).some((id) => id.endsWith(keyId))) master.signatures = mergeSignatures(master.signatures, signed.signatures)
        }
        this.deviceListChanges.push({ pos: ++this.pos, userId: target })
      }
      this.wake()
      return { body: { failures: {} } }
    }
    if (path === '/_matrix/client/v3/keys/query') {
      const requested = Object.keys(body().device_keys ?? {})
      const deviceKeys: Record<string, Record<string, unknown>> = {}
      const master: Record<string, unknown> = {}; const selfSigning: Record<string, unknown> = {}; const userSigning: Record<string, unknown> = {}
      for (const user of requested) {
        deviceKeys[user] = {}
        for (const [id, device] of this.devices.get(user) ?? []) if (device.keys) deviceKeys[user][id] = device.keys
        const cross = this.crossSigning.get(user)
        if (cross?.master_key) master[user] = cross.master_key
        if (cross?.self_signing_key) selfSigning[user] = cross.self_signing_key
        if (cross?.user_signing_key && user === userId) userSigning[user] = cross.user_signing_key
      }
      return { body: { device_keys: deviceKeys, failures: {}, master_keys: master, self_signing_keys: selfSigning, user_signing_keys: userSigning } }
    }
    if (path === '/_matrix/client/v3/keys/claim') {
      const claimed: Record<string, Record<string, Record<string, unknown>>> = {}
      for (const [user, devices] of Object.entries(body().one_time_keys ?? {})) {
        claimed[user] = {}
        for (const [id] of Object.entries(devices as Record<string, string>)) {
          const device = this.devices.get(user)?.get(id)
          if (!device) continue
          const [keyId, key] = device.oneTimeKeys.entries().next().value ?? device.fallbackKeys.entries().next().value ?? []
          if (!keyId) continue
          device.oneTimeKeys.delete(keyId)
          claimed[user][id] = { [keyId]: key }
        }
      }
      return { body: { one_time_keys: claimed, failures: {} } }
    }
    if (segments[4] === 'sendToDevice') {
      const type = segments[5]
      for (const [user, devices] of Object.entries(body().messages ?? {})) {
        for (const [target, content] of Object.entries(devices as Record<string, unknown>)) {
          const targets = target === '*' ? [...(this.devices.get(user)?.keys() ?? [])] : [target]
          for (const id of targets) {
            const key = `${user}|${id}`
            if (!this.toDevice.has(key)) this.toDevice.set(key, [])
            this.toDevice.get(key)!.push({ pos: ++this.pos, message: { sender: userId, type, content } })
          }
        }
      }
      this.wake()
      return { body: {} }
    }
    if (path === '/_matrix/client/v3/createRoom') {
      const input = body()
      const roomId = this.createRoomAs(userId, { name: input.name, invite: input.invite, encrypted: (input.initial_state ?? []).some((event: any) => event.type === 'm.room.encryption') })
      return { body: { room_id: roomId } }
    }
    if (path.startsWith('/_matrix/client/v3/join/') || (segments[4] === 'rooms' && segments[6] === 'join')) {
      const roomId = segments[4] === 'join' ? segments[5] : segments[5]
      const room = this.rooms.get(roomId)
      if (!room) return { status: 404, body: { errcode: 'M_NOT_FOUND', error: 'No room' } }
      if (this.membership(roomId, userId) !== 'invite' && this.membership(roomId, userId) !== 'join') return { status: 403, body: { errcode: 'M_FORBIDDEN', error: 'Not invited' } }
      this.append(room, { sender: userId, type: 'm.room.member', state_key: userId, content: { membership: 'join' } })
      return { body: { room_id: roomId } }
    }
    if (segments[4] === 'rooms') {
      const room = this.rooms.get(segments[5])
      if (!room) return { status: 404, body: { errcode: 'M_NOT_FOUND', error: 'No room' } }
      const action = segments[6]
      const membership = this.membership(room.id, userId)
      if (action === 'leave') { this.append(room, { sender: userId, type: 'm.room.member', state_key: userId, content: { membership: 'leave' } }); return { body: {} } }
      if (action === 'send' || action === 'redact') {
        const txnId = segments[action === 'send' ? 8 : 8]
        const key = `${session.token}|${txnId}`
        const existing = this.txns.get(key)
        if (existing) return { body: { event_id: existing } }
        if (membership !== 'join') return { status: 403, body: { errcode: 'M_FORBIDDEN', error: 'Not joined' } }
        const event = action === 'send'
          ? this.append(room, { sender: userId, type: segments[7], content: body() }, { token: session.token, txnId })
          : this.append(room, { sender: userId, type: 'm.room.redaction', content: body(), redacts: segments[7] }, { token: session.token, txnId })
        this.txns.set(key, event.event_id)
        if (action === 'send' && this.dropSendResponses > 0) { this.dropSendResponses -= 1; return 'drop' }
        return { body: { event_id: event.event_id } }
      }
      if (action === 'state' && method === 'PUT') {
        if (membership !== 'join') return { status: 403, body: { errcode: 'M_FORBIDDEN', error: 'Not joined' } }
        return { body: { event_id: this.append(room, { sender: userId, type: segments[7], state_key: segments[8] ?? '', content: body() }).event_id } }
      }
      if (action === 'state') return { body: [...room.state.values()] }
      if (action === 'members' || action === 'joined_members') {
        const members = [...room.state.values()].filter((event) => event.type === 'm.room.member')
        return action === 'members'
          ? { body: { chunk: members } }
          : { body: { joined: Object.fromEntries(members.filter((event) => event.content.membership === 'join').map((event) => [event.state_key, {}])) } }
      }
      if (action === 'messages') {
        const from = Number(url.searchParams.get('from')?.replace(/^p/, '') ?? this.pos + 1)
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 10), 100)
        const older = room.events.filter((item) => item.pos < from).slice(-limit).reverse()
        const end = older.length ? `p${older[older.length - 1].pos}` : undefined
        return { body: { start: `p${from}`, ...(end && older[older.length - 1].pos > room.events[0].pos ? { end } : {}), chunk: older.map((item) => this.view(item, session)) } }
      }
      if (action === 'read_markers' || action === 'receipt' || action === 'typing') return { body: {} }
      if (action === 'report') return { body: {} }
    }
    if (path === '/_matrix/media/v3/upload' || path === '/_matrix/client/v1/media/upload') {
      if (raw.length > this.uploadLimit) return { status: 413, body: { errcode: 'M_TOO_LARGE', error: 'Too large' } }
      const id = randomBytes(8).toString('hex')
      this.media.set(id, { bytes: raw, type: contentType ?? 'application/octet-stream' })
      return { body: { content_uri: `mxc://localhost/${id}` } }
    }
    if (path.startsWith('/_matrix/client/v1/media/download/')) {
      const item = this.media.get(segments[7])
      return item ? item.bytes : { status: 404, body: { errcode: 'M_NOT_FOUND', error: 'No media' } }
    }
    if (path === '/_matrix/client/v3/sync') return { body: await this.sync(session, url) }
    return { status: 404, body: { errcode: 'M_UNRECOGNIZED', error: `Unrecognized ${method} ${path}` } }
  }

  private view(item: StoredEvent, session: Session) {
    const event = { ...item.event, unsigned: { ...item.event.unsigned } }
    if (item.txn?.token === session.token) event.unsigned.transaction_id = item.txn.txnId
    return event
  }

  private async sync(session: Session, url: URL) {
    const since = url.searchParams.has('since') ? Number(url.searchParams.get('since')) : undefined
    const timeout = Math.min(Number(url.searchParams.get('timeout') ?? 0), 2_000)
    const hasNews = () => this.pos > (since ?? -1)
    if (since !== undefined && !hasNews() && timeout > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { this.waiters.delete(wake); resolve() }, timeout)
        const wake = () => { clearTimeout(timer); resolve() }
        this.waiters.add(wake)
      })
    }
    const { userId, deviceId } = session
    const join: Record<string, unknown> = {}; const invite: Record<string, unknown> = {}; const leave: Record<string, unknown> = {}
    for (const room of this.rooms.values()) {
      const membership = this.membership(room.id, userId)
      const memberEvent = room.state.get(`m.room.member|${userId}`)
      const memberPos = room.events.find((item) => item.event.event_id === memberEvent?.event_id)?.pos ?? 0
      if (membership === 'join') {
        const fresh = since === undefined || memberPos > since
        const timeline = room.events.filter((item) => since === undefined || item.pos > since).slice(fresh && since === undefined ? -50 : 0)
        if (!fresh && !timeline.length) continue
        const first = timeline[0]?.pos ?? this.pos + 1
        const state = fresh ? room.events.filter((item) => item.pos < first && item.event.state_key !== undefined && room.state.get(`${item.event.type}|${item.event.state_key}`)?.event_id === item.event.event_id).map((item) => this.view(item, session)) : []
        join[room.id] = {
          // A newly joined room with earlier history is reported as limited, like real servers.
          timeline: { events: timeline.map((item) => this.view(item, session)), limited: fresh && room.events[0].pos < first, prev_batch: `p${first}` },
          state: { events: state }, ephemeral: { events: [] }, account_data: { events: [] },
          unread_notifications: { notification_count: 0, highlight_count: 0 }, summary: {}
        }
      } else if (membership === 'invite' && (since === undefined || memberPos > since)) {
        invite[room.id] = { invite_state: { events: [...room.state.values()].filter((event) => ['m.room.name', 'm.room.encryption', 'm.room.create', 'm.room.member', 'm.room.join_rules'].includes(event.type)).map((event) => ({ type: event.type, state_key: event.state_key, sender: event.sender, content: event.content })) } }
      } else if (since !== undefined && memberPos > since && (membership === 'leave' || membership === 'ban')) {
        leave[room.id] = { timeline: { events: room.events.filter((item) => item.pos > since).map((item) => this.view(item, session)), limited: false }, state: { events: [] } }
      }
    }
    const key = `${userId}|${deviceId}`
    const toDevice = (this.toDevice.get(key) ?? []).splice(0)
    const changed = [...new Set(this.deviceListChanges.filter((change) => since !== undefined && change.pos > since && this.sharesRoom(userId, change.userId)).map((change) => change.userId))]
    const device = this.device(userId, deviceId)
    return {
      next_batch: String(this.pos),
      rooms: { join, invite, leave },
      to_device: { events: toDevice.map((item) => item.message) },
      device_lists: { changed, left: [] },
      device_one_time_keys_count: { signed_curve25519: device.oneTimeKeys.size },
      device_unused_fallback_key_types: device.fallbackKeys.size ? ['signed_curve25519'] : [],
      account_data: { events: [...this.accountData].filter(([key, value]) => key.startsWith(`${userId}|`) && (since === undefined || value.pos > since)).map(([key, value]) => ({ type: key.slice(userId.length + 1), content: value.content })) },
      presence: { events: [] }
    }
  }
}

function mergeSignatures(existing: Record<string, Record<string, string>> | undefined, added: Record<string, Record<string, string>> | undefined) {
  const result: Record<string, Record<string, string>> = { ...existing }
  for (const [user, signatures] of Object.entries(added ?? {})) result[user] = { ...result[user], ...signatures }
  return result
}
