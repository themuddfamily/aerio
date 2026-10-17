import { chmodSync, existsSync, unlinkSync } from 'node:fs'
import { createServer as netCreateServer, type Server, type Socket } from 'node:net'
import { CHANNEL_VERSION, LineSplitter, writeLine, type BridgeToMain, type ChannelError, type MainToBridge } from './channel'
import type { McpClientRecord } from './store'
import { McpToolError, type McpToolResult } from './service'

const HELLO_TIMEOUT_MS = 10_000
/** Requests from one bridge are bounded so a runaway client cannot queue unbounded work. */
const MAX_CONCURRENT_REQUESTS = 16

export interface McpLocalServerDeps {
  endpoint: string
  authenticate(token: unknown): McpClientRecord | undefined
  /** Re-checked on every request so revocation applies to open connections at once. */
  clientExists(id: string): boolean
  touch(id: string): void
  listTools(clientId: string): unknown[]
  callTool(clientId: string, name: unknown, args: unknown): Promise<McpToolResult>
  log(event: string, details?: Record<string, unknown>, error?: unknown): void
  createServer?: () => Server
  platform?: NodeJS.Platform
}

interface Connection { socket: Socket; clientId?: string; active: number }

function channelError(error: unknown): ChannelError {
  if (error instanceof McpToolError) return { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) }
  return { code: 'failed', message: error instanceof Error ? error.message.slice(0, 1_000) : 'The request failed' }
}

/** Main-process listener for the stdio bridge. It exists only while external automation is enabled. */
export class McpLocalServer {
  private server?: Server
  private readonly connections = new Set<Connection>()

  constructor(private readonly deps: McpLocalServerDeps) {}

  get listening() { return Boolean(this.server?.listening) }

  connectedClientIds() {
    return new Set([...this.connections].flatMap((connection) => connection.clientId ? [connection.clientId] : []))
  }

  async start() {
    if (this.server) return
    const platform = this.deps.platform ?? process.platform
    // The single-instance lock means a leftover socket file belongs to a previous run.
    if (platform !== 'win32' && existsSync(this.deps.endpoint)) unlinkSync(this.deps.endpoint)
    const server = (this.deps.createServer ?? netCreateServer)()
    server.on('connection', (socket: Socket) => this.accept(socket))
    this.server = server
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(this.deps.endpoint, () => { server.off('error', reject); resolve() })
      })
    } catch (error) {
      this.server = undefined
      this.deps.log('mcp-listen-failed', {}, error)
      throw error
    }
    server.on('error', (error) => this.deps.log('mcp-server-error', {}, error))
    if (platform !== 'win32') {
      try { chmodSync(this.deps.endpoint, 0o600) } catch { /* The token check still applies. */ }
    }
    this.deps.log('mcp-listening')
  }

  async stop(reason: 'shutdown' | 'disabled' = 'shutdown') {
    const server = this.server
    this.server = undefined
    for (const connection of this.connections) {
      writeLine(connection.socket, { type: 'event', event: reason } satisfies MainToBridge)
      connection.socket.destroy()
    }
    this.connections.clear()
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if ((this.deps.platform ?? process.platform) !== 'win32' && existsSync(this.deps.endpoint)) {
      try { unlinkSync(this.deps.endpoint) } catch { /* Removed again on the next start. */ }
    }
    this.deps.log('mcp-stopped', { reason })
  }

  /** Closes every connection authenticated as this client (revocation). */
  disconnectClient(clientId: string) {
    for (const connection of [...this.connections]) {
      if (connection.clientId !== clientId) continue
      writeLine(connection.socket, { type: 'event', event: 'revoked' } satisfies MainToBridge)
      this.connections.delete(connection)
      // The token no longer authenticates; requests already on the wire during this short grace
      // are answered `unauthorized` (clientExists is re-checked) instead of vanishing with the socket.
      setTimeout(() => connection.socket.destroy(), 500).unref?.()
    }
  }

  broadcast(event: 'tools-changed') {
    for (const connection of this.connections) if (connection.clientId) writeLine(connection.socket, { type: 'event', event } satisfies MainToBridge)
  }

  private accept(socket: Socket) {
    const connection: Connection = { socket, active: 0 }
    this.connections.add(connection)
    const helloTimer = setTimeout(() => socket.destroy(), HELLO_TIMEOUT_MS)
    helloTimer.unref?.()
    const reject = (error: ChannelError) => {
      writeLine(socket, { type: 'rejected', error } satisfies MainToBridge)
      socket.end()
      setTimeout(() => socket.destroy(), 1_000).unref?.()
    }
    const splitter = new LineSplitter((line) => {
      let message: BridgeToMain
      try { message = JSON.parse(line) as BridgeToMain } catch { socket.destroy(); return }
      if (!connection.clientId) {
        clearTimeout(helloTimer)
        if (message?.type !== 'hello' || message.version !== CHANNEL_VERSION) {
          reject({ code: 'unauthorized', message: 'This bridge version does not match Aerio. Update the client configuration from Aerio Settings.' })
          return
        }
        const client = this.deps.authenticate(message.token)
        if (!client) {
          this.deps.log('mcp-auth-rejected')
          reject({ code: 'unauthorized', message: 'The client token is not valid or was revoked. Issue a new one in Aerio Settings › External automation (MCP).' })
          return
        }
        connection.clientId = client.id
        this.deps.touch(client.id)
        writeLine(socket, { type: 'welcome', version: CHANNEL_VERSION, clientId: client.id, clientName: client.name } satisfies MainToBridge)
        this.deps.log('mcp-client-connected', { clientId: client.id })
        return
      }
      if (message?.type !== 'request' || typeof message.id !== 'number') return
      void this.answer(connection, message)
    }, () => socket.destroy())
    socket.on('data', (chunk: Buffer) => splitter.push(chunk))
    socket.on('error', () => socket.destroy())
    socket.on('close', () => {
      clearTimeout(helloTimer)
      this.connections.delete(connection)
      if (connection.clientId) this.deps.log('mcp-client-disconnected', { clientId: connection.clientId })
    })
  }

  private async answer(connection: Connection, message: Extract<BridgeToMain, { type: 'request' }>) {
    const clientId = connection.clientId!
    const respond = (body: { result?: unknown; error?: ChannelError }) => writeLine(connection.socket, { type: 'response', id: message.id, ...body } satisfies MainToBridge)
    if (!this.deps.clientExists(clientId)) {
      respond({ error: { code: 'unauthorized', message: 'This client was revoked in Aerio Settings.' } })
      connection.socket.destroy()
      return
    }
    if (connection.active >= MAX_CONCURRENT_REQUESTS) {
      respond({ error: { code: 'failed', message: 'Too many requests at once. Wait for earlier calls to finish.' } })
      return
    }
    connection.active++
    try {
      this.deps.touch(clientId)
      if (message.method === 'tools/list') respond({ result: { tools: this.deps.listTools(clientId) } })
      else if (message.method === 'tools/call') respond({ result: await this.deps.callTool(clientId, message.params?.name, message.params?.arguments ?? {}) })
      else respond({ error: { code: 'unknown-tool', message: 'Unsupported request' } })
    } catch (error) {
      respond({ error: channelError(error) })
    } finally {
      connection.active--
    }
  }
}
