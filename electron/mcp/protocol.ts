/**
 * Model Context Protocol server core: JSON-RPC 2.0 messages, lifecycle,
 * version negotiation, and the tools feature. Transport-agnostic; the stdio
 * bridge feeds it one newline-delimited message at a time.
 */

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0]

export const JSON_RPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  /** Server-defined: a request arrived before `initialize`. */
  notInitialized: -32002
} as const

export interface McpProtocolTool {
  name: string
  title?: string
  description: string
  inputSchema: unknown
  annotations?: unknown
}

export type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; mimeType: string; blob: string } }

export type McpToolOutcome =
  | { ok: true; result: Record<string, unknown>; content?: McpContent[] }
  | { ok: false; code: string; message: string; details?: string[] }

/** Where tool listings and calls are answered: the authenticated channel to Aerio's main process. */
export interface McpBackend {
  listTools(): Promise<McpProtocolTool[]>
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolOutcome>
}

export interface McpServerInfo {
  name: string
  title: string
  version: string
  instructions?: string
}

type JsonRpcId = string | number
interface JsonRpcError { code: number; message: string; data?: unknown }
type Outgoing =
  | { jsonrpc: '2.0'; id: JsonRpcId | null; result: unknown }
  | { jsonrpc: '2.0'; id: JsonRpcId | null; error: JsonRpcError }
  | { jsonrpc: '2.0'; method: string; params?: Record<string, unknown> }

class RpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) { super(message) }
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const validId = (value: unknown): value is JsonRpcId => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))

/** Tool-level failures that are really malformed requests become JSON-RPC errors, not tool results. */
const PROTOCOL_ERROR_CODES = new Set(['invalid-arguments', 'unknown-tool'])

export interface McpProtocolServerOptions {
  info: McpServerInfo
  backend: McpBackend
  send(message: Outgoing | Outgoing[]): void
  /** tools/list page size; the default fits every Aerio tool on one page. */
  pageSize?: number
  /** Called once per notable protocol event; never receives arguments or results. */
  log?(event: string, details?: Record<string, unknown>): void
}

export class McpProtocolServer {
  private initializeAnswered = false
  private negotiatedVersion?: string
  private clientName?: string

  constructor(private readonly options: McpProtocolServerOptions) {}

  get protocolVersion() { return this.negotiatedVersion }
  get initialized() { return this.initializeAnswered }
  get client() { return this.clientName }

  /** Handles one newline-delimited message (a request, notification, response, or batch). */
  async handleLine(line: string) {
    const text = line.trim()
    if (!text) return
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch {
      this.options.send(this.error(null, new RpcError(JSON_RPC_ERRORS.parseError, 'Parse error')))
      return
    }
    if (Array.isArray(parsed)) {
      if (!parsed.length) { this.options.send(this.error(null, new RpcError(JSON_RPC_ERRORS.invalidRequest, 'Invalid Request: empty batch'))); return }
      const replies = (await Promise.all(parsed.map((item) => this.handleMessage(item)))).filter((reply): reply is Outgoing => Boolean(reply))
      if (replies.length) this.options.send(replies)
      return
    }
    const reply = await this.handleMessage(parsed)
    if (reply) this.options.send(reply)
  }

  /** Tells the client to fetch tools/list again (capabilities or the connection changed). */
  notifyToolsChanged() {
    if (this.initializeAnswered) this.options.send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
  }

  private error(id: JsonRpcId | null, error: RpcError): Outgoing {
    return { jsonrpc: '2.0', id, error: { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) } }
  }

  private async handleMessage(message: unknown): Promise<Outgoing | undefined> {
    if (!isRecord(message) || message.jsonrpc !== '2.0') {
      return this.error(isRecord(message) && validId(message.id) ? message.id : null, new RpcError(JSON_RPC_ERRORS.invalidRequest, 'Invalid Request'))
    }
    // A response to a server request; Aerio's bridge never sends any, so these are ignored.
    if (message.method === undefined && ('result' in message || 'error' in message)) return
    const hasId = 'id' in message
    if (typeof message.method !== 'string' || (hasId && !validId(message.id))) {
      return this.error(validId(message.id) ? message.id : null, new RpcError(JSON_RPC_ERRORS.invalidRequest, 'Invalid Request'))
    }
    if (message.params !== undefined && !isRecord(message.params) && !Array.isArray(message.params)) {
      return hasId ? this.error(message.id as JsonRpcId, new RpcError(JSON_RPC_ERRORS.invalidRequest, 'Invalid Request: params must be an object')) : undefined
    }
    const params = isRecord(message.params) ? message.params : {}
    if (!hasId) {
      this.handleNotification(message.method)
      return
    }
    const id = message.id as JsonRpcId
    try {
      return { jsonrpc: '2.0', id, result: await this.dispatch(message.method, params) }
    } catch (error) {
      if (error instanceof RpcError) return this.error(id, error)
      this.options.log?.('internal-error', { method: message.method })
      return this.error(id, new RpcError(JSON_RPC_ERRORS.internalError, 'Internal error'))
    }
  }

  private handleNotification(method: string) {
    if (method === 'notifications/initialized') this.options.log?.('initialized', { protocolVersion: this.negotiatedVersion })
    // notifications/cancelled and unknown notifications need no reply.
  }

  private async dispatch(method: string, params: Record<string, unknown>) {
    if (method === 'ping') return {}
    if (method === 'initialize') return this.initialize(params)
    if (!this.initializeAnswered) {
      if (method === 'tools/list' || method === 'tools/call') throw new RpcError(JSON_RPC_ERRORS.notInitialized, 'Server not initialized')
    }
    if (method === 'tools/list') return this.listTools(params)
    if (method === 'tools/call') return this.callTool(params)
    throw new RpcError(JSON_RPC_ERRORS.methodNotFound, `Method not found: ${method}`)
  }

  private initialize(params: Record<string, unknown>) {
    if (typeof params.protocolVersion !== 'string' || !params.protocolVersion) throw new RpcError(JSON_RPC_ERRORS.invalidParams, 'initialize requires a protocolVersion')
    if (params.capabilities !== undefined && !isRecord(params.capabilities)) throw new RpcError(JSON_RPC_ERRORS.invalidParams, 'capabilities must be an object')
    const requested = params.protocolVersion
    // Echo a supported version; otherwise offer the newest one and let the client decide.
    this.negotiatedVersion = (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : LATEST_PROTOCOL_VERSION
    const clientInfo = isRecord(params.clientInfo) ? params.clientInfo : {}
    this.clientName = typeof clientInfo.name === 'string' ? clientInfo.name.slice(0, 100) : undefined
    this.initializeAnswered = true
    this.options.log?.('initialize', { requestedVersion: requested.slice(0, 40), protocolVersion: this.negotiatedVersion })
    const { name, title, version, instructions } = this.options.info
    return {
      protocolVersion: this.negotiatedVersion,
      capabilities: { tools: { listChanged: true } },
      serverInfo: this.negotiatedVersion === '2024-11-05' ? { name, version } : { name, title, version },
      ...(instructions ? { instructions } : {})
    }
  }

  private async listTools(params: Record<string, unknown>) {
    const pageSize = Math.max(1, this.options.pageSize ?? 100)
    let offset = 0
    if (params.cursor !== undefined) {
      offset = typeof params.cursor === 'string' ? decodeCursor(params.cursor) : -1
      if (offset < 0) throw new RpcError(JSON_RPC_ERRORS.invalidParams, 'Invalid cursor')
    }
    const tools = await this.options.backend.listTools()
    if (offset > tools.length) throw new RpcError(JSON_RPC_ERRORS.invalidParams, 'Invalid cursor')
    const page = tools.slice(offset, offset + pageSize).map((tool) => this.negotiatedVersion === '2024-11-05'
      ? { name: tool.name, description: tool.description, inputSchema: tool.inputSchema }
      : tool)
    const next = offset + pageSize
    return { tools: page, ...(next < tools.length ? { nextCursor: encodeCursor(next) } : {}) }
  }

  private async callTool(params: Record<string, unknown>) {
    if (typeof params.name !== 'string' || !params.name) throw new RpcError(JSON_RPC_ERRORS.invalidParams, 'tools/call requires a tool name')
    if (params.arguments !== undefined && !isRecord(params.arguments)) throw new RpcError(JSON_RPC_ERRORS.invalidParams, 'arguments must be an object')
    const outcome = await this.options.backend.callTool(params.name, (params.arguments as Record<string, unknown> | undefined) ?? {})
    if (!outcome.ok) {
      if (PROTOCOL_ERROR_CODES.has(outcome.code)) throw new RpcError(JSON_RPC_ERRORS.invalidParams, outcome.message, { code: outcome.code, ...(outcome.details ? { details: outcome.details } : {}) })
      const error = { code: outcome.code, message: outcome.message }
      return {
        content: [{ type: 'text', text: `${outcome.message} (${outcome.code})` }],
        ...(this.supportsStructuredContent() ? { structuredContent: { error } } : {}),
        isError: true
      }
    }
    return {
      content: outcome.content ?? [{ type: 'text', text: JSON.stringify(outcome.result, null, 2) }],
      ...(this.supportsStructuredContent() ? { structuredContent: outcome.result } : {}),
      isError: false
    }
  }

  private supportsStructuredContent() {
    return this.negotiatedVersion === '2025-06-18'
  }
}

export function encodeCursor(offset: number) {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url')
}

export function decodeCursor(cursor: string) {
  if (!cursor || cursor.length > 200) return -1
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { offset?: unknown }
    return typeof value?.offset === 'number' && Number.isSafeInteger(value.offset) && value.offset >= 0 ? value.offset : -1
  } catch {
    return -1
  }
}
