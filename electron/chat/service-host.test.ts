import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { ChatAccountRecord } from './chat-store'
import { ChatServiceHost, chatServicePartition, serviceFileResponse, serviceRequestAllowed, type ChatServiceElectron } from './service-host'
import type { ChatServiceCommand, ChatServiceEvent } from './service/runtime'

/**
 * Chat service host with a fake Electron: partition hardening (protocol,
 * network policy, permissions, downloads, navigation, popups), the ready
 * handshake, command/reply routing by sender webContents, crash handling and
 * the gate self-test sequence. The real packaged boundary is exercised by the
 * Electron self-test recorded in chat-gate.json.
 */
const root = mkdtempSync(join(tmpdir(), 'aerio-chat-host-'))
const serviceDirectory = join(root, 'chat-service')
mkdirSync(join(serviceDirectory, 'assets'), { recursive: true })
writeFileSync(join(serviceDirectory, 'index.html'), '<!doctype html>')
writeFileSync(join(serviceDirectory, 'assets', 'crypto.wasm'), Buffer.from([0, 97, 115, 109]))
writeFileSync(join(root, 'secret.txt'), 'outside')
const preload = join(root, 'chat-service-preload.cjs')
writeFileSync(preload, '')

afterAll(() => rmSync(root, { recursive: true, force: true }))

type Responder = (command: ChatServiceCommand, contents: FakeContents) => { ok: true; value: unknown } | { ok: false; error: { kind: string; message: string } } | undefined

class FakeContents {
  static next = 100
  id = FakeContents.next++
  destroyed = false
  sent: { channel: string; message: any }[] = []
  handlers = new Map<string, (...args: any[]) => void>()
  windowOpen?: () => { action: 'deny' }
  constructor(private readonly electron: FakeElectron, readonly partition: string) {}
  async loadURL(url: string) {
    this.electron.loaded.push(url)
    if (this.electron.announceReady) queueMicrotask(() => this.electron.emit('chat-service:event', this.id, { type: 'ready' }))
  }
  close() { this.destroyed = true }
  isDestroyed() { return this.destroyed }
  send(channel: string, message: any) {
    this.sent.push({ channel, message })
    const reply = this.electron.responder(message.command, this)
    if (reply) queueMicrotask(() => this.electron.emit('chat-service:reply', this.id, message.id, reply))
  }
  setWindowOpenHandler(handler: () => { action: 'deny' }) { this.windowOpen = handler }
  on(event: string, listener: (...args: any[]) => void) { this.handlers.set(event, listener) }
}

class FakeSession {
  handled = new Map<string, (request: Request) => Response | Promise<Response>>()
  beforeRequest?: (details: { url: string }, callback: (response: { cancel: boolean }) => void) => void
  permissionRequest?: (contents: unknown, permission: string, callback: (granted: boolean) => void) => void
  permissionCheck?: () => boolean
  download?: (event: { preventDefault(): void }) => void
  cleared = 0
  protocol = {
    handle: (scheme: string, handler: (request: Request) => Response | Promise<Response>) => { this.handled.set(scheme, handler) },
    isProtocolHandled: (scheme: string) => this.handled.has(scheme)
  }
  webRequest = { onBeforeRequest: (listener: NonNullable<FakeSession['beforeRequest']>) => { this.beforeRequest = listener } }
  setPermissionRequestHandler(handler: NonNullable<FakeSession['permissionRequest']>) { this.permissionRequest = handler }
  setPermissionCheckHandler(handler: () => boolean) { this.permissionCheck = handler }
  on(_event: 'will-download', listener: (event: { preventDefault(): void }) => void) { this.download = listener }
  async clearStorageData() { this.cleared += 1 }
  allowed(url: string) {
    let cancel = true
    this.beforeRequest?.({ url }, (response) => { cancel = response.cancel })
    return !cancel
  }
}

class FakeElectron {
  sessions = new Map<string, FakeSession>()
  contents: FakeContents[] = []
  loaded: string[] = []
  listeners = new Map<string, (event: { sender: { id: number } }, ...args: any[]) => void>()
  announceReady = true
  responder: Responder = (command) => ({ ok: true, value: { echo: command.type } })
  emit(channel: string, senderId: number, ...args: unknown[]) { this.listeners.get(channel)?.({ sender: { id: senderId } }, ...args) }
  api(): ChatServiceElectron {
    return {
      createView: ({ partition }) => { const contents = new FakeContents(this, partition); this.contents.push(contents); return { webContents: contents } },
      fromPartition: (partition) => {
        if (!this.sessions.has(partition)) this.sessions.set(partition, new FakeSession())
        return this.sessions.get(partition)! as never
      },
      ipcMain: { on: (channel, listener) => { this.listeners.set(channel, listener) } }
    }
  }
}

const account = (id: string, homeserver = 'https://matrix.example.org'): ChatAccountRecord => ({ id, homeserver } as ChatAccountRecord)

function host(electron = new FakeElectron(), options: { startTimeoutMs?: number; allowLoopbackHttp?: boolean } = {}) {
  const log = vi.fn()
  return { electron, log, host: new ChatServiceHost({ electron: electron.api(), serviceDirectory, preload, log, ...options }) }
}

describe('chat service host helpers', () => {
  it('derives partitions only from safe account IDs', () => {
    expect(chatServicePartition('3f1c-account')).toBe('persist:aerio-chat-3f1c-account')
    expect(() => chatServicePartition('../other')).toThrow('Invalid chat account ID')
    expect(() => chatServicePartition('')).toThrow('Invalid chat account ID')
    expect(() => chatServicePartition('a'.repeat(65))).toThrow('Invalid chat account ID')
  })

  it('serves only files inside the packaged service directory', async () => {
    const index = serviceFileResponse(serviceDirectory, 'aerio-chat-service://app/index.html')
    expect(index.status).toBe(200)
    expect(index.headers.get('Content-Type')).toBe('text/html')
    expect(index.headers.get('Cache-Control')).toBe('no-store')
    expect(serviceFileResponse(serviceDirectory, 'aerio-chat-service://app/assets/crypto.wasm').headers.get('Content-Type')).toBe('application/wasm')
    expect(serviceFileResponse(serviceDirectory, 'aerio-chat-service://app/../secret.txt').status).toBe(404)
    expect(serviceFileResponse(serviceDirectory, 'aerio-chat-service://app/%2e%2e/secret.txt').status).toBe(404)
    expect(serviceFileResponse(serviceDirectory, 'aerio-chat-service://app/').status).toBe(404)
    expect(serviceFileResponse(serviceDirectory, 'aerio-chat-service://other/index.html').status).toBe(404)
    expect(serviceFileResponse(serviceDirectory, 'https://app/index.html').status).toBe(404)
    expect(serviceFileResponse(serviceDirectory, 'aerio-chat-service://app/missing.js').status).toBe(404)
  })

  it('limits service network access to its bundle and one HTTPS homeserver origin', () => {
    const origin = 'https://matrix.example.org'
    expect(serviceRequestAllowed('aerio-chat-service://app/assets/x.js', undefined)).toBe(true)
    expect(serviceRequestAllowed('aerio-chat-service://evil/x.js', origin)).toBe(false)
    expect(serviceRequestAllowed('https://matrix.example.org/_matrix/client/v3/sync', origin)).toBe(true)
    expect(serviceRequestAllowed('https://matrix.example.org:8448/_matrix/client/v3/sync', origin)).toBe(false)
    expect(serviceRequestAllowed('https://evil.example/_matrix', origin)).toBe(false)
    expect(serviceRequestAllowed('http://matrix.example.org/_matrix', 'http://matrix.example.org', true)).toBe(false)
    expect(serviceRequestAllowed('http://127.0.0.1:8008/_matrix', 'http://127.0.0.1:8008')).toBe(false)
    expect(serviceRequestAllowed('http://127.0.0.1:8008/_matrix', 'http://127.0.0.1:8008', true)).toBe(true)
    expect(serviceRequestAllowed('https://matrix.example.org/x', undefined)).toBe(false)
    expect(serviceRequestAllowed('not a url', origin)).toBe(false)
  })
})

describe('chat service host', () => {
  it('hardens the account partition and routes commands, replies and events by sender', async () => {
    const { host: subject, electron, log } = host()
    expect(subject.available()).toBe(true)
    const connection = await subject.open(account('acct-1'))
    const session = electron.sessions.get('persist:aerio-chat-acct-1')!
    const contents = electron.contents[0]
    expect(electron.loaded).toEqual(['aerio-chat-service://app/index.html'])
    expect(session.handled.has('aerio-chat-service')).toBe(true)
    expect(session.allowed('https://matrix.example.org/_matrix/client/v3/sync')).toBe(true)
    expect(session.allowed('https://tracker.example/pixel.png')).toBe(false)
    expect(log).toHaveBeenCalledWith('chat-service-request-blocked', { scheme: 'https' })
    let granted = true
    session.permissionRequest?.({}, 'notifications', (value) => { granted = value })
    expect(granted).toBe(false)
    expect(session.permissionCheck?.()).toBe(false)
    const download = { preventDefault: vi.fn() }
    session.download?.(download)
    expect(download.preventDefault).toHaveBeenCalled()
    expect(contents.windowOpen?.()).toEqual({ action: 'deny' })
    const navigation = { preventDefault: vi.fn() }
    contents.handlers.get('will-navigate')?.(navigation)
    contents.handlers.get('will-redirect')?.(navigation)
    expect(navigation.preventDefault).toHaveBeenCalledTimes(2)
    expect(subject.isServiceSender(contents.id)).toBe(true)
    expect(subject.isServiceSender(1)).toBe(false)

    await expect(connection.request({ type: 'devices' })).resolves.toEqual({ echo: 'devices' })
    electron.responder = () => ({ ok: false, error: { kind: 'rejected', message: 'Room not found' } })
    await expect(connection.request({ type: 'paginate', roomId: '!r', limit: 1 })).rejects.toMatchObject({ detail: { kind: 'rejected', message: 'Room not found' } })

    const events: ChatServiceEvent[] = []
    connection.onEvent((event) => events.push(event))
    electron.emit('chat-service:event', contents.id, { type: 'status', status: 'ready' })
    // Events and replies from any other webContents are ignored.
    electron.emit('chat-service:event', 4242, { type: 'status', status: 'offline' })
    electron.emit('chat-service:event', contents.id, null)
    electron.emit('chat-service:reply', 4242, 1, { ok: true, value: 'forged' })
    expect(events).toEqual([{ type: 'status', status: 'ready' }])

    await connection.close()
    expect(contents.isDestroyed()).toBe(true)
    expect(subject.isServiceSender(contents.id)).toBe(false)
    await expect(connection.request({ type: 'devices' })).rejects.toMatchObject({ detail: { kind: 'network' } })
    // A second account gets its own partition; the shared scheme handler is configured once per partition.
    await subject.open(account('acct-2', 'https://other.example'))
    expect(electron.sessions.get('persist:aerio-chat-acct-2')!.allowed('https://matrix.example.org/_matrix')).toBe(false)
    expect(electron.sessions.get('persist:aerio-chat-acct-2')!.allowed('https://other.example/_matrix')).toBe(true)
    await subject.purge('acct-1')
    expect(session.cleared).toBe(1)
  })

  it('fails pending requests and reports an error when the service process is gone', async () => {
    const { host: subject, electron, log } = host()
    electron.responder = () => undefined
    const connection = await subject.open(account('acct-crash'))
    const events: ChatServiceEvent[] = []
    connection.onEvent((event) => events.push(event))
    const pending = connection.request({ type: 'devices' })
    electron.contents[0].handlers.get('render-process-gone')?.({}, { reason: 'crashed' })
    await expect(pending).rejects.toMatchObject({ detail: { kind: 'network', message: expect.stringMatching(/stopped unexpectedly/) } })
    expect(events).toEqual([{ type: 'status', status: 'error', error: expect.stringMatching(/stopped unexpectedly/) }])
    expect(log).toHaveBeenCalledWith('chat-service-crashed', { reason: 'crashed' })
    expect(subject.isServiceSender(electron.contents[0].id)).toBe(false)
  })

  it('closes a service that never announces readiness', async () => {
    const electron = new FakeElectron()
    electron.announceReady = false
    const { host: subject } = host(electron, { startTimeoutMs: 20 })
    await expect(subject.open(account('acct-slow'))).rejects.toThrow('The chat service did not start')
    expect(electron.contents[0].isDestroyed()).toBe(true)
  })

  it('reports unavailable when the service bundle or preload is missing', () => {
    const subject = new ChatServiceHost({ electron: new FakeElectron().api(), serviceDirectory: join(root, 'missing'), preload })
    expect(subject.available()).toBe(false)
  })

  it('passes the self-test only when the store reopens with the same identity and refuses another key', async () => {
    const run = async (behaviour: (command: Extract<ChatServiceCommand, { type: 'self-test' }>, call: number) => ReturnType<Responder>) => {
      const electron = new FakeElectron()
      const keys: string[] = []
      electron.responder = (command) => {
        if (command.type !== 'self-test') return undefined
        keys.push(Buffer.from(command.key).toString('hex'))
        return behaviour(command, keys.length)
      }
      const { host: subject } = host(electron)
      const result = await subject.selfTest()
      // Every probe partition is temporary and cleared afterwards.
      expect([...electron.sessions.values()].every((session) => session.cleared === 1)).toBe(true)
      expect(electron.contents.every((contents) => contents.isDestroyed())).toBe(true)
      return { result, keys }
    }
    const passing = await run((_command, call) => call < 3 ? { ok: true, value: { ed25519: 'same-identity' } } : { ok: false, error: { kind: 'encryption', message: 'the account in the store doesn\'t match' } })
    expect(passing.result).toMatchObject({ passed: true, detail: expect.stringContaining('refused a different storage key') })
    expect(passing.keys[0]).toBe(passing.keys[1])
    expect(passing.keys[2]).not.toBe(passing.keys[0])
    expect((await run((_command, call) => ({ ok: true, value: { ed25519: `identity-${call}` } }))).result).toMatchObject({ passed: false, detail: expect.stringMatching(/did not keep the device identity/) })
    expect((await run(() => ({ ok: true, value: { ed25519: 'same' } }))).result).toMatchObject({ passed: false, detail: expect.stringMatching(/opened with a different key/) })
    expect((await run(() => ({ ok: false, error: { kind: 'encryption', message: 'WASM failed to load' } }))).result).toMatchObject({ passed: false, detail: expect.stringMatching(/self-test failed: WASM failed to load/) })
  })
})
