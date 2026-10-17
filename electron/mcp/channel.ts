/**
 * The authenticated local channel between the stdio bridge and Aerio's main
 * process: a named pipe on Windows or a unix domain socket elsewhere, carrying
 * newline-delimited JSON. The first bridge message must present a client
 * token issued in Settings; main closes the socket on any other first message.
 */
import { createHash } from 'node:crypto'
import { connect as netConnect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { posix, win32 } from 'node:path'

export const CHANNEL_VERSION = 1
/** Large enough for a 10 MB attachment in base64 plus its JSON envelope. */
export const MAX_CHANNEL_LINE_BYTES = 32 * 1024 * 1024
const MAX_UNIX_SOCKET_PATH = 100

export type ChannelErrorCode =
  | 'app-not-running' | 'unauthorized' | 'disabled' | 'locked' | 'capability-disabled' | 'account-not-allowed'
  | 'invalid-arguments' | 'unknown-tool' | 'not-found' | 'too-large' | 'conflict' | 'already-sent' | 'timeout' | 'failed'

export interface ChannelError { code: ChannelErrorCode; message: string; details?: string[] }

export type BridgeToMain =
  | { type: 'hello'; version: number; token: string; client?: { name?: string; version?: string } }
  | { type: 'request'; id: number; method: 'tools/list' | 'tools/call'; params?: { name?: string; arguments?: Record<string, unknown> } }

export type MainToBridge =
  | { type: 'welcome'; version: number; clientId: string; clientName: string }
  | { type: 'rejected'; error: ChannelError }
  | { type: 'response'; id: number; result?: unknown; error?: ChannelError }
  | { type: 'event'; event: 'tools-changed' | 'revoked' | 'shutdown' | 'disabled' }

export const APP_NOT_RUNNING: ChannelError = {
  code: 'app-not-running',
  message: 'Aerio is not running, or external automation is turned off in Settings › External automation (MCP). Start Aerio and try again.'
}

export const REVOKED: ChannelError = { code: 'unauthorized', message: 'This client was revoked in Aerio Settings › External automation (MCP).' }

/** Where main listens for this profile. Stable for a given profile folder, so the bridge can find it. */
export function mcpEndpoint(userData: string, platform: NodeJS.Platform = process.platform, temporary = tmpdir()) {
  const paths = platform === 'win32' ? win32 : posix
  const absolute = paths.resolve(userData)
  const hash = createHash('sha256').update(platform === 'win32' ? absolute.toLowerCase() : absolute).digest('hex').slice(0, 16)
  if (platform === 'win32') return `\\\\.\\pipe\\aerio-mcp-${hash}`
  const inProfile = paths.join(absolute, 'mcp.sock')
  // sun_path is limited to about 104 bytes; deep profile folders fall back to the temp directory.
  return Buffer.byteLength(inProfile) <= MAX_UNIX_SOCKET_PATH ? inProfile : paths.join(temporary, `aerio-mcp-${hash}.sock`)
}

/** Splits a byte stream into newline-delimited lines, refusing oversized lines. */
export class LineSplitter {
  private buffer = ''

  constructor(private readonly onLine: (line: string) => void, private readonly onOverflow: () => void, private readonly maximum = MAX_CHANNEL_LINE_BYTES) {}

  push(chunk: Buffer | string) {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    let index = this.buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '')
      this.buffer = this.buffer.slice(index + 1)
      if (line.trim()) this.onLine(line)
      index = this.buffer.indexOf('\n')
    }
    if (this.buffer.length > this.maximum) {
      this.buffer = ''
      this.onOverflow()
    }
  }

  /** A final line without a trailing newline (stdin closed mid-line). */
  flush() {
    const rest = this.buffer.trim()
    this.buffer = ''
    if (rest) this.onLine(rest)
  }
}

export function writeLine(socket: Pick<Socket, 'write' | 'destroyed'>, message: unknown) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`)
}

export interface ChannelClientOptions {
  endpoint: string
  token: string
  client?: { name?: string; version?: string }
  connect?: (path: string) => Socket
  timeoutMs?: number
  onEvent?: (event: Extract<MainToBridge, { type: 'event' }>['event']) => void
}

type Pending = { resolve(value: { result?: unknown; error?: ChannelError }): void; timer: NodeJS.Timeout }

/** The bridge's side of the channel. It connects on demand and reconnects after Aerio restarts. */
export class AerioChannelClient {
  private socket?: Socket
  private ready?: Promise<ChannelError | undefined>
  private nextId = 1
  private readonly pending = new Map<number, Pending>()

  constructor(private readonly options: ChannelClientOptions) {}

  async request(method: 'tools/list' | 'tools/call', params?: { name?: string; arguments?: Record<string, unknown> }): Promise<{ result?: unknown; error?: ChannelError }> {
    if (!this.options.token) return { error: { code: 'unauthorized', message: 'No client token. Issue one in Aerio Settings › External automation (MCP) and set AERIO_MCP_TOKEN.' } }
    const failure = await this.connect()
    if (failure) return { error: failure }
    const socket = this.socket
    if (!socket || socket.destroyed) return { error: APP_NOT_RUNNING }
    const id = this.nextId++
    return new Promise((resolvePending) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolvePending({ error: { code: 'timeout', message: 'Aerio did not answer in time.' } })
      }, this.options.timeoutMs ?? 120_000)
      timer.unref?.()
      this.pending.set(id, { resolve: resolvePending, timer })
      writeLine(socket, { type: 'request', id, method, ...(params ? { params } : {}) } satisfies BridgeToMain)
    })
  }

  close() {
    this.socket?.destroy()
    this.reset(APP_NOT_RUNNING)
  }

  private connect(): Promise<ChannelError | undefined> {
    if (this.ready) return this.ready
    this.ready = new Promise((resolveReady) => {
      let settled = false
      let welcomed = false
      const settle = (error?: ChannelError) => {
        if (settled) return
        settled = true
        if (error) {
          this.ready = undefined
          socket.destroy()
        }
        resolveReady(error)
      }
      const socket = (this.options.connect ?? netConnect)(this.options.endpoint)
      this.socket = socket
      const splitter = new LineSplitter((line) => {
        let message: MainToBridge
        try { message = JSON.parse(line) as MainToBridge } catch { return }
        if (message.type === 'welcome') { welcomed = true; settle() }
        else if (message.type === 'rejected') settle(message.error)
        else if (message.type === 'response') {
          const waiting = this.pending.get(message.id)
          if (!waiting) return
          clearTimeout(waiting.timer)
          this.pending.delete(message.id)
          waiting.resolve(message.error ? { error: message.error } : { result: message.result })
        } else if (message.type === 'event') {
          // Main is about to close this session: forget it now so the next request reconnects
          // and gets an authoritative answer (unauthorized after revocation, not running after shutdown).
          if (message.event !== 'tools-changed' && this.socket === socket) {
            this.socket = undefined
            this.ready = undefined
            this.reset(message.event === 'revoked' ? REVOKED : APP_NOT_RUNNING)
            socket.destroy()
          }
          this.options.onEvent?.(message.event)
        }
      }, () => socket.destroy())
      socket.on('connect', () => writeLine(socket, { type: 'hello', version: CHANNEL_VERSION, token: this.options.token, client: this.options.client } satisfies BridgeToMain))
      socket.on('data', (chunk: Buffer) => splitter.push(chunk))
      socket.on('error', () => settle(APP_NOT_RUNNING))
      socket.on('close', () => {
        settle(APP_NOT_RUNNING)
        if (this.socket === socket) {
          this.socket = undefined
          this.ready = undefined
          this.reset(APP_NOT_RUNNING)
          // Only a session that was established can change; a refused connect has nothing to report.
          if (welcomed) this.options.onEvent?.('shutdown')
        }
      })
    })
    return this.ready
  }

  private reset(error: ChannelError) {
    for (const [id, waiting] of this.pending) {
      clearTimeout(waiting.timer)
      waiting.resolve({ error })
      this.pending.delete(id)
    }
  }
}
