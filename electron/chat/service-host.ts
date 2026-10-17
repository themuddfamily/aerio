import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { extname, join, normalize, relative, isAbsolute } from 'node:path'
import type { ChatServiceConnection, ChatServiceFactory } from './chat-service'
import type { ChatAccountRecord } from './chat-store'
import { ChatServiceError, type SerializedServiceError } from './service/event-mapping'
import type { ChatServiceCommand, ChatServiceEvent } from './service/runtime'

/**
 * Hosts one isolated chat service per account: a hidden, sandboxed
 * webContents (not a BrowserWindow, so app-wide renderer broadcasts never reach
 * it) on its own persistent partition. It loads only Aerio's packaged service
 * bundle from a private scheme, has no Node integration, denies permissions,
 * popups, navigation and downloads, and its network is limited to the selected
 * homeserver. The main process identifies the account by sender webContents.
 */
export const CHAT_SERVICE_SCHEME = 'aerio-chat-service'

interface WebContentsLike {
  id: number
  loadURL(url: string): Promise<void>
  close(): void
  isDestroyed(): boolean
  send(channel: string, ...args: unknown[]): void
  setWindowOpenHandler(handler: () => { action: 'deny' }): void
  on(event: string, listener: (...args: any[]) => void): void
}

interface SessionLike {
  protocol: { handle(scheme: string, handler: (request: Request) => Response | Promise<Response>): void; isProtocolHandled(scheme: string): boolean }
  webRequest: { onBeforeRequest(listener: (details: { url: string }, callback: (response: { cancel: boolean }) => void) => void): void }
  setPermissionRequestHandler(handler: (webContents: unknown, permission: string, callback: (granted: boolean) => void) => void): void
  setPermissionCheckHandler(handler: () => boolean): void
  on(event: 'will-download', listener: (event: { preventDefault(): void }) => void): void
  clearStorageData(): Promise<void>
}

export interface ChatServiceElectron {
  /** A detached view; the host keeps it referenced so its webContents is not collected. */
  createView(options: { partition: string; preload: string }): { webContents: WebContentsLike }
  fromPartition(partition: string): SessionLike
  ipcMain: { on(channel: string, listener: (event: { sender: { id: number } }, ...args: any[]) => void): void }
}

export interface ChatServiceHostOptions {
  electron: ChatServiceElectron
  /** Directory holding the built service bundle (index.html, assets, wasm). */
  serviceDirectory: string
  preload: string
  /** Automated fixtures may use loopback HTTP homeservers. */
  allowLoopbackHttp?: boolean
  log?: (event: string, details?: Record<string, unknown>) => void
  startTimeoutMs?: number
}

const CONTENT_TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css', '.json': 'application/json' }

export function chatServicePartition(accountId: string) {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(accountId)) throw new Error('Invalid chat account ID')
  return `persist:aerio-chat-${accountId}`
}

/** Serves only files inside the service directory; anything else is 404. */
export function serviceFileResponse(directory: string, url: string): Response {
  const parsed = new URL(url)
  if (parsed.protocol !== `${CHAT_SERVICE_SCHEME}:` || parsed.hostname !== 'app') return new Response('Not found', { status: 404 })
  const path = normalize(join(directory, decodeURIComponent(parsed.pathname)))
  const inside = relative(directory, path)
  if (!inside || inside.startsWith('..') || isAbsolute(inside) || !existsSync(path)) return new Response('Not found', { status: 404 })
  // Electron's protocol bridge needs a plain Uint8Array body, not a pooled Buffer.
  return new Response(Uint8Array.from(readFileSync(path)), { headers: { 'Content-Type': CONTENT_TYPES[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' } })
}

/** Network policy for a service partition: its own bundle and one homeserver origin. */
export function serviceRequestAllowed(url: string, homeserverOrigin: string | undefined, allowLoopbackHttp = false) {
  let parsed: URL
  try { parsed = new URL(url) } catch { return false }
  if (parsed.protocol === `${CHAT_SERVICE_SCHEME}:`) return parsed.hostname === 'app'
  if (!homeserverOrigin) return false
  if (parsed.protocol !== 'https:' && !(allowLoopbackHttp && parsed.protocol === 'http:' && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(parsed.hostname))) return false
  return parsed.origin === homeserverOrigin
}

interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }

class WebContentsConnection implements ChatServiceConnection {
  private counter = 0
  private readonly pending = new Map<number, Pending>()
  private readonly listeners: ((event: ChatServiceEvent) => void)[] = []
  closed = false

  constructor(private readonly view: { webContents: WebContentsLike }, private readonly onClose: () => void) {}

  get contents() { return this.view.webContents }

  request<T>(command: ChatServiceCommand): Promise<T> {
    if (this.closed || this.contents.isDestroyed()) return Promise.reject(new ChatServiceError({ kind: 'network', message: 'The chat service is not running' }))
    const id = ++this.counter
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new ChatServiceError({ kind: 'network', message: 'The chat service did not respond' })) }, command.type === 'start' || command.type === 'recovery-key' || command.type === 'setup-recovery' ? 180_000 : 120_000)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      this.contents.send('chat-service:command', { id, command })
    })
  }

  reply(id: number, result: { ok: true; value: unknown } | { ok: false; error: SerializedServiceError }) {
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    clearTimeout(entry.timer)
    if (result.ok) entry.resolve(result.value)
    else entry.reject(new ChatServiceError({ kind: result.error?.kind ?? 'other', message: String(result.error?.message ?? 'The chat service failed'), code: result.error?.code }))
  }

  dispatch(event: ChatServiceEvent) {
    for (const listener of this.listeners) listener(event)
  }

  onEvent(listener: (event: ChatServiceEvent) => void) {
    this.listeners.push(listener)
  }

  fail(message: string) {
    this.closed = true
    for (const [id, entry] of this.pending) { clearTimeout(entry.timer); entry.reject(new ChatServiceError({ kind: 'network', message })); this.pending.delete(id) }
    this.dispatch({ type: 'status', status: 'error', error: message })
    this.onClose()
  }

  async close() {
    if (this.closed) return
    this.closed = true
    for (const [id, entry] of this.pending) { clearTimeout(entry.timer); entry.reject(new ChatServiceError({ kind: 'network', message: 'The chat service stopped' })); this.pending.delete(id) }
    if (!this.contents.isDestroyed()) this.contents.close()
    this.onClose()
  }
}

export class ChatServiceHost implements ChatServiceFactory {
  readonly persistent = true
  private readonly connections = new Map<number, WebContentsConnection>()
  private readonly ready = new Map<number, () => void>()
  private readonly homeservers = new Map<string, string | undefined>()
  private readonly configured = new Set<string>()

  constructor(private readonly options: ChatServiceHostOptions) {
    options.electron.ipcMain.on('chat-service:reply', (event, id: number, result) => this.connections.get(event.sender.id)?.reply(id, result))
    options.electron.ipcMain.on('chat-service:event', (event, payload: ChatServiceEvent | { type: 'ready' }) => {
      if (!payload || typeof payload !== 'object') return
      if (payload.type === 'ready') { this.ready.get(event.sender.id)?.(); return }
      this.connections.get(event.sender.id)?.dispatch(payload)
    })
  }

  /** Renderer IPC must never come from a service webContents. */
  isServiceSender(id: number) {
    return this.connections.has(id) || this.ready.has(id)
  }

  available() {
    return existsSync(join(this.options.serviceDirectory, 'index.html')) && existsSync(this.options.preload)
  }

  private configure(partition: string) {
    if (this.configured.has(partition)) return
    this.configured.add(partition)
    const session = this.options.electron.fromPartition(partition)
    if (!session.protocol.isProtocolHandled(CHAT_SERVICE_SCHEME)) session.protocol.handle(CHAT_SERVICE_SCHEME, (request) => serviceFileResponse(this.options.serviceDirectory, request.url))
    session.webRequest.onBeforeRequest((details, callback) => {
      const allowed = serviceRequestAllowed(details.url, this.homeservers.get(partition), this.options.allowLoopbackHttp)
      if (!allowed) this.options.log?.('chat-service-request-blocked', { scheme: details.url.split(':')[0] })
      callback({ cancel: !allowed })
    })
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    session.setPermissionCheckHandler(() => false)
    session.on('will-download', (event) => event.preventDefault())
  }

  private async launch(partition: string, homeserverOrigin?: string): Promise<WebContentsConnection> {
    this.configure(partition)
    this.homeservers.set(partition, homeserverOrigin)
    const view = this.options.electron.createView({ partition, preload: this.options.preload })
    const contents = view.webContents
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event: { preventDefault(): void }) => event.preventDefault())
    contents.on('will-redirect', (event: { preventDefault(): void }) => event.preventDefault())
    const connection = new WebContentsConnection(view, () => { this.connections.delete(contents.id); this.ready.delete(contents.id) })
    this.connections.set(contents.id, connection)
    contents.on('render-process-gone', (_event: unknown, details: { reason?: string }) => {
      this.options.log?.('chat-service-crashed', { reason: details?.reason })
      connection.fail('The chat service stopped unexpectedly. Aerio will reconnect.')
    })
    const readyPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The chat service did not start')), this.options.startTimeoutMs ?? 30_000)
      this.ready.set(contents.id, () => { clearTimeout(timer); resolve() })
    })
    await contents.loadURL(`${CHAT_SERVICE_SCHEME}://app/index.html`)
    try { await readyPromise } catch (error) { await connection.close(); throw error }
    return connection
  }

  open(account: ChatAccountRecord) {
    return this.launch(chatServicePartition(account.id), new URL(account.homeserver).origin)
  }

  async purge(accountId: string) {
    // The caller stops the account's service first; this deletes its SDK crypto store and caches.
    await this.options.electron.fromPartition(chatServicePartition(accountId)).clearStorageData()
  }

  /**
   * Gate probe in the real runtime: create an encrypted crypto store in a
   * throwaway partition, close the service, reopen it with the same key and
   * confirm the same identity, then confirm a different key cannot open it.
   */
  async selfTest(): Promise<{ passed: boolean; detail: string }> {
    const partition = `persist:aerio-chat-selftest-${randomBytes(4).toString('hex')}`
    const key = new Uint8Array(randomBytes(32))
    const probe = { type: 'self-test' as const, prefix: 'aerio-gate', key, userId: '@aerio-self-test:aerio.invalid', deviceId: 'AERIOGATE' }
    const run = async (command: ChatServiceCommand) => {
      const connection = await this.launch(partition)
      try { return await connection.request<{ ed25519: string }>(command) } finally { await connection.close() }
    }
    try {
      const created = await run(probe)
      const reopened = await run(probe)
      if (!created?.ed25519 || created.ed25519 !== reopened?.ed25519) return { passed: false, detail: 'The crypto store did not keep the device identity across a service restart.' }
      let refusal = ''
      try { await run({ ...probe, key: new Uint8Array(randomBytes(32)) }) } catch (error) { refusal = error instanceof Error ? error.message : String(error) }
      if (!refusal) return { passed: false, detail: 'The crypto store opened with a different key, so it is not encrypted.' }
      return { passed: true, detail: `Rust crypto initialized in the isolated service, kept its identity across a restart, and refused a different storage key (${refusal.slice(0, 120)}).` }
    } catch (error) {
      return { passed: false, detail: `The chat service self-test failed: ${error instanceof Error ? error.message : String(error)}` }
    } finally {
      await this.options.electron.fromPartition(partition).clearStorageData().catch(() => {})
    }
  }
}
