import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ChatEvent, ChatGateStatus } from '../../src/chat-types'
import { ChatService, type ChatServiceFactory } from './chat-service'
import { ChatStore } from './chat-store'
import { ChatVault, type ChatSecretCodec } from './chat-vault'
import type { ChatNotificationPlan } from './notifications'
import { ChatServiceRuntime, type ChatServiceEvent } from './service/runtime'
import { FakeHomeserver } from './test-homeserver'

/**
 * End-to-end orchestrator tests: ChatService (vault, encrypted store, outbox,
 * notifications, lifecycle) driving real SDK runtimes in-process against the
 * loopback fixture. The Electron service boundary is replaced by a direct
 * in-process connection; its packaging is covered by the gate self-test.
 */
const codec: ChatSecretCodec = {
  assertSecure: () => {},
  encrypt: (value) => Buffer.from(Buffer.from(value).map((byte) => byte ^ 0x5a)),
  decrypt: (value) => Buffer.from(value.map((byte) => byte ^ 0x5a)).toString()
}
const openGate: ChatGateStatus = { enabled: true, preview: false, checks: [], sdkVersion: 'test', message: 'Chat is available.' }

let server: FakeHomeserver
const roots: string[] = []
const services: ChatService[] = []
const stores: ChatStore[] = []

function inProcessFactory(): ChatServiceFactory & { purged: string[] } {
  const purged: string[] = []
  return {
    persistent: false,
    purged,
    purge: async (accountId) => { purged.push(accountId) },
    open: async () => {
      const listeners: ((event: ChatServiceEvent) => void)[] = []
      const runtime = new ChatServiceRuntime((event) => listeners.forEach((listener) => listener(event)))
      return { request: (command) => runtime.handle(command) as never, onEvent: (listener) => { listeners.push(listener) }, close: async () => runtime.stop() }
    }
  }
}

interface Harness {
  service: ChatService
  store: ChatStore
  vault: ChatVault
  root: string
  state: { locked: boolean; online: boolean; gate: ChatGateStatus; chosen?: string; savePath?: string }
  notifications: ChatNotificationPlan[]
  events: ChatEvent[]
  factory: ReturnType<typeof inProcessFactory>
}

function harness(existing?: Pick<Harness, 'root' | 'state'>): Harness {
  const root = existing?.root ?? mkdtempSync(join(tmpdir(), 'aerio-chat-service-'))
  if (!existing) roots.push(root)
  const state = existing?.state ?? { locked: false, online: true, gate: openGate }
  const vault = new ChatVault(join(root, 'chat-vault.dat'), codec)
  let service: ChatService | undefined
  const store = new ChatStore(join(root, 'chat.sqlite'), (id) => service!.cipherFor(id))
  const notifications: ChatNotificationPlan[] = []
  const events: ChatEvent[] = []
  const factory = inProcessFactory()
  service = new ChatService({
    store, vault, factory, gate: () => state.gate, homeserver: { allowLoopbackHttp: true }, mediaDirectory: join(root, 'chat-media'),
    locked: () => state.locked, notificationsEnabled: () => true, online: () => state.online,
    notify: (plan) => notifications.push(plan), changed: (event) => events.push(event),
    chooseFile: async () => state.chosen, chooseSavePath: async () => state.savePath
  })
  services.push(service)
  stores.push(store)
  return { service, store, vault, root, state, notifications, events, factory }
}

async function waitFor<T>(probe: () => T | undefined | false, timeout = 30_000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = probe()
    if (value) return value
    if (Date.now() - started > timeout) throw new Error('Timed out')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

beforeAll(async () => {
  server = await new FakeHomeserver({ uploadLimit: 1024 * 1024 }).start()
  server.addUser('alice', 'alice-pw')
  server.addUser('bob', 'bob-pw')
})

afterAll(async () => {
  for (const service of services) await service.stop().catch(() => {})
  await server.stop()
  for (const store of stores) { try { store.close() } catch { /* Already closed. */ } }
  for (const root of roots) { try { rmSync(root, { recursive: true, force: true }) } catch { /* Windows may hold WAL files briefly. */ } }
})

describe('ChatService', () => {
  let alice: Harness
  let bob: Harness
  let aliceId: string
  let bobId: string
  let roomId: string

  it('refuses everything except a diagnostic snapshot while the gate is closed', async () => {
    const closed = harness()
    closed.state.gate = { ...openGate, enabled: false, message: 'Chat stays unavailable until these checks pass: two-device interoperability.' }
    expect(closed.service.snapshot()).toMatchObject({ gate: { enabled: false }, accounts: [] })
    await expect(closed.service.login({ homeserver: server.url, user: 'alice', password: 'alice-pw' })).rejects.toThrow('two-device interoperability')
    await expect(closed.service.discover(server.url)).rejects.toThrow('unavailable')
  })

  it('connects accounts with a validated homeserver and stores the token only in the vault', async () => {
    alice = harness(); bob = harness()
    expect((await alice.service.discover(server.url)).password).toBe(true)
    await expect(alice.service.login({ homeserver: server.url, user: 'alice', password: 'nope' })).rejects.toThrow('rejected these credentials')
    const account = await alice.service.login({ homeserver: server.url, user: 'alice', password: 'alice-pw' })
    aliceId = account.id
    expect(account).toMatchObject({ userId: '@alice:localhost', homeserver: server.url, transport: 'matrix' })
    expect(JSON.stringify(account)).not.toMatch(/syt_/)
    bobId = (await bob.service.login({ homeserver: server.url, user: 'bob', password: 'bob-pw' })).id
    await waitFor(() => alice.store.getAccount(aliceId)?.status === 'ready' && bob.store.getAccount(bobId)?.status === 'ready')
    const token = alice.vault.get(aliceId)!.accessToken
    expect(readFileSync(join(alice.root, 'chat-vault.dat'), 'utf8')).not.toContain(token)
    expect(readFileSync(join(alice.root, 'chat.sqlite')).includes(Buffer.from(token))).toBe(false)
  }, 60_000)

  it('delivers an encrypted message through the durable outbox with generic notifications', async () => {
    roomId = server.createRoomAs('@alice:localhost', { encrypted: true, invite: ['@bob:localhost'], name: 'Launch' })
    await waitFor(() => bob.store.room(bobId, roomId)?.membership === 'invite')
    expect(bob.notifications.at(-1)).toMatchObject({ title: 'New chat invitation' })
    await bob.service.roomAction(bobId, roomId, 'accept')
    await waitFor(() => alice.store.room(aliceId, roomId)?.membership === 'join' && server.membership(roomId, '@bob:localhost') === 'join')
    await waitFor(() => alice.store.roomEvents(aliceId, roomId).some((event) => event.stateKey === '@bob:localhost' && event.content.membership === 'join'))
    const echo = alice.service.send(aliceId, roomId, 'liftoff at nine')
    expect(echo).toMatchObject({ body: 'liftoff at nine', own: true })
    const item = await waitFor(() => bob.service.timeline(bobId, roomId).items.find((entry) => entry.body === 'liftoff at nine'))
    expect(item).toMatchObject({ encrypted: true, sender: '@alice:localhost', own: false })
    await waitFor(() => alice.service.timeline(aliceId, roomId).items.find((entry) => entry.body === 'liftoff at nine' && entry.delivery === 'sent'))
    expect(alice.service.timeline(aliceId, roomId).items.filter((entry) => entry.body === 'liftoff at nine')).toHaveLength(1)
    const notification = await waitFor(() => bob.notifications.find((plan) => plan.roomId === roomId && plan.title === 'New chat message'))
    expect(notification.body).toBe('Open Aerio to read it')
    expect(bob.service.search(bobId, 'LIFTOFF')).toMatchObject([{ snippet: 'liftoff at nine' }])
    expect(bob.store.room(bobId, roomId)?.unread).toBeGreaterThan(0)
    await bob.service.markRead(bobId, roomId)
    expect(bob.store.room(bobId, roomId)?.unread).toBe(0)
  }, 90_000)

  it('edits, reacts to and deletes messages through validated relations', async () => {
    const sent = alice.service.timeline(aliceId, roomId).items.find((entry) => entry.body === 'liftoff at nine')!
    alice.service.edit(aliceId, roomId, sent.eventId!, 'liftoff at ten')
    alice.service.react(aliceId, roomId, sent.eventId!, '🚀')
    await waitFor(() => bob.service.timeline(bobId, roomId).items.find((entry) => entry.eventId === sent.eventId && entry.body === 'liftoff at ten' && entry.edited && entry.reactions.length))
    expect(() => bob.service.edit(bobId, roomId, sent.eventId!, 'forged')).toThrow('your own messages')
    alice.service.redact(aliceId, roomId, sent.eventId!)
    await waitFor(() => bob.service.timeline(bobId, roomId).items.find((entry) => entry.eventId === sent.eventId && entry.kind === 'redacted'))
    expect(bob.service.search(bobId, 'liftoff')).toEqual([])
  }, 60_000)

  it('queues while locked or offline and sends after unlock or reconnect', async () => {
    alice.state.locked = true
    expect(alice.service.snapshot().accounts).toEqual([])
    expect(() => alice.service.timeline(aliceId, roomId)).toThrow('Unlock Aerio')
    alice.state.locked = false
    alice.state.online = false
    alice.service.send(aliceId, roomId, 'sent when back online')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(alice.store.outbox(aliceId, roomId).find((entry) => entry.content.body === 'sent when back online')?.state).toBe('pending')
    alice.state.online = true
    alice.service.networkChanged()
    await waitFor(() => bob.service.timeline(bobId, roomId).items.find((entry) => entry.body === 'sent when back online'))
    // Locked without send-while-locked: the item waits for unlock.
    alice.state.locked = true
    alice.store.updateAccount(aliceId, { preferences: { ...alice.store.getAccount(aliceId)!.preferences, sendWhileLocked: false } })
    const queued = alice.service.outbox.enqueue({ accountId: aliceId, roomId, userId: '@alice:localhost', deviceId: alice.store.getAccount(aliceId)!.deviceId, kind: 'message', eventType: 'm.room.message', content: { msgtype: 'm.text', body: 'after unlock' } })
    alice.service.networkChanged()
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(alice.store.outboxItem(queued.id)?.state).toBe('pending')
    alice.state.locked = false
    alice.service.lockChanged(false)
    await waitFor(() => alice.store.outboxItem(queued.id)?.state === 'sent')
  }, 60_000)

  it('sends encrypted attachments within limits and saves them only to a chosen path', async () => {
    const file = join(alice.root, 'notes.txt')
    writeFileSync(file, 'attachment body')
    alice.state.chosen = file
    const echo = await alice.service.attach(aliceId, roomId)
    expect(echo).toMatchObject({ kind: 'media', media: { name: 'notes.txt', encrypted: true } })
    const received = await waitFor(() => bob.service.timeline(bobId, roomId).items.find((entry) => entry.kind === 'media' && entry.media?.name === 'notes.txt'))
    const uploaded = [...server.requests].reverse().find((request) => request.path.endsWith('/upload'))!
    expect(uploaded.body ?? '').not.toContain('attachment body')
    bob.state.savePath = join(bob.root, 'saved.txt')
    expect(await bob.service.saveMedia(bobId, received.media!.mediaId)).toBe(true)
    expect(readFileSync(bob.state.savePath, 'utf8')).toBe('attachment body')
    bob.state.savePath = undefined
    expect(await bob.service.saveMedia(bobId, received.media!.mediaId)).toBe(false)
    const big = join(alice.root, 'big.bin')
    writeFileSync(big, Buffer.alloc(1024 * 1024 + 1))
    alice.state.chosen = big
    await expect(alice.service.attach(aliceId, roomId)).rejects.toThrow('limited to 1 MiB')
    alice.state.chosen = undefined
    expect(await alice.service.attach(aliceId, roomId)).toBeUndefined()
    await expect(bob.service.saveMedia(aliceId, received.media!.mediaId)).rejects.toThrow('not found')
  }, 60_000)

  it('reviews interrupted sends after a restart instead of resending them', async () => {
    const stuck = alice.service.outbox.enqueue({ accountId: aliceId, roomId, userId: '@alice:localhost', deviceId: alice.store.getAccount(aliceId)!.deviceId, kind: 'message', eventType: 'm.room.message', content: { msgtype: 'm.text', body: 'maybe sent' } })
    alice.store.updateOutbox(stuck.id, { state: 'running' })
    await alice.service.stop()
    alice.store.close()
    const restarted = harness({ root: alice.root, state: alice.state })
    await restarted.service.start()
    expect(restarted.store.outboxItem(stuck.id)?.state).toBe('review')
    expect(restarted.service.timeline(aliceId, roomId).items.find((entry) => entry.outboxId === stuck.id)?.delivery).toBe('review')
    restarted.service.retryOutgoing(stuck.id)
    await waitFor(() => restarted.store.outboxItem(stuck.id)?.state === 'sent')
    alice = restarted
  }, 60_000)

  it('removes an account: remote logout, vault, local data and service storage', async () => {
    const token = alice.vault.get(aliceId)!.accessToken
    const outcome = await alice.service.removeAccount(aliceId)
    expect(outcome.remoteLogout).toBe('done')
    expect(server.sessions.has(token)).toBe(false)
    expect(alice.vault.has(aliceId)).toBe(false)
    expect(alice.store.getAccount(aliceId)).toBeUndefined()
    expect(alice.store.rooms(aliceId)).toEqual([])
    expect(alice.factory.purged).toContain(aliceId)
    expect(existsSync(join(alice.root, 'chat-vault.dat'))).toBe(false)
    bob.service.clearHistory(bobId)
    expect(bob.store.roomEvents(bobId, roomId)).toEqual([])
    expect(bob.store.getAccount(bobId)).toBeDefined()
  }, 60_000)
})

describe('ChatService validation', () => {
  it('rejects writes to held rooms and unknown targets', async () => {
    const h = harness()
    h.vault.create('acc', 'token', 'D1')
    h.store.insertAccount({ id: 'acc', transport: 'matrix', homeserver: 'https://example.org', userId: '@me:example.org', deviceId: 'D1', status: 'ready', trust: 'unknown', recovery: 'unknown', preferences: (await import('./chat-store')).DEFAULT_CHAT_PREFERENCES, createdAt: new Date().toISOString() })
    h.store.applySyncBatch('acc', { rooms: [{ roomId: '!r', name: 'R', encrypted: true, membership: 'join', isDirect: false }], events: [] })
    expect(() => h.service.send('acc', '!r', '   ')).toThrow('Type a message')
    expect(() => h.service.send('acc', '!r', 'hi', '$missing')).toThrow('not available')
    expect(() => h.service.send('acc', '!missing', 'hi')).toThrow('not a member')
    h.store.setRoomFlags('acc', '!r', { held: 'Held for review' })
    expect(() => h.service.send('acc', '!r', 'hi')).toThrow('Held for review')
    await h.service.roomAction('acc', '!r', 'release-hold')
    const echo = h.service.send('acc', '!r', 'queued offline')
    expect(echo.delivery).toBe('pending')
    h.service.edit('acc', '!r', echo.outboxId!, 'changed before sending')
    expect(h.store.outboxItem(echo.outboxId!)?.content.body).toBe('changed before sending')
    h.service.redact('acc', '!r', echo.outboxId!)
    expect(h.store.outboxItem(echo.outboxId!)).toBeUndefined()
    await h.service.roomAction('acc', '!r', 'mute')
    await h.service.roomAction('acc', '!r', 'allow-previews')
    expect(h.store.room('acc', '!r')).toMatchObject({ muted: true, previews: true })
    expect(h.service.updatePreferences('acc', { retention: { historyDays: 0.2, mediaCacheMiB: 1 }, notificationPreviews: true }).preferences).toMatchObject({ retention: { historyDays: 1, mediaCacheMiB: 16 }, notificationPreviews: true })
    await expect(h.service.devices('acc')).rejects.toThrow('not connected')
    expect(() => h.service.react('acc', '!r', '$nothing', '👍')).toThrow('not available')
    vi.useRealTimers()
  })
})
