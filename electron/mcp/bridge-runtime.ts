import type { Socket } from 'node:net'
import { AerioChannelClient, LineSplitter, type ChannelError } from './channel'
import { McpProtocolServer, type McpBackend, type McpContent, type McpProtocolTool, type McpToolOutcome } from './protocol'
import { MCP_TOOLS, protocolTool } from './tools'
import { mcpDiagnosticDetails } from './redact'

/** Client requests are small; anything bigger than this is refused as a parse error. */
const MAX_STDIN_LINE_BYTES = 4 * 1024 * 1024

export const MCP_BRIDGE_INSTRUCTIONS = 'Aerio mail on this computer. Use list_accounts and search_mail to find conversations, then get_conversation or get_message to read them. Write, send, and delete tools appear only when the user has enabled them in Aerio Settings › External automation (MCP). Calls fail with "locked" while Aerio is locked and with "app-not-running" while Aerio is closed.'

export interface McpBridgeOptions {
  input: NodeJS.ReadableStream
  output: Pick<NodeJS.WritableStream, 'write'>
  /** Diagnostics only (stderr); never receives arguments, content, or addresses. */
  log?: (line: string) => void
  endpoint: string
  token: string
  version: string
  connect?: (path: string) => Socket
  timeoutMs?: number
}

/** Bridge back-end: forwards to Aerio, falling back to the static catalog when Aerio is unreachable. */
export function channelBackend(channel: Pick<AerioChannelClient, 'request'>): McpBackend {
  return {
    async listTools(): Promise<McpProtocolTool[]> {
      const reply = await channel.request('tools/list')
      if (reply.error) return MCP_TOOLS.map(protocolTool)
      const tools = (reply.result as { tools?: McpProtocolTool[] } | undefined)?.tools
      return Array.isArray(tools) ? tools : []
    },
    async callTool(name, args): Promise<McpToolOutcome> {
      const reply = await channel.request('tools/call', { name, arguments: args })
      if (reply.error) return { ok: false, ...(reply.error as ChannelError) }
      const value = reply.result as { result?: Record<string, unknown>; content?: McpContent[] } | undefined
      return { ok: true, result: value?.result ?? {}, ...(value?.content ? { content: value.content } : {}) }
    }
  }
}

/**
 * Runs the stdio MCP server until stdin closes. stdout carries only protocol
 * messages, one JSON-RPC message per line, as the stdio transport requires.
 */
export function runMcpBridge(options: McpBridgeOptions) {
  const log = (event: string, details: Record<string, unknown> = {}) => options.log?.(`[aerio-mcp] ${event} ${JSON.stringify(details)}`)
  let server: McpProtocolServer | undefined
  const channel = new AerioChannelClient({
    endpoint: options.endpoint,
    token: options.token,
    client: { name: 'aerio-mcp-bridge', version: options.version },
    connect: options.connect,
    timeoutMs: options.timeoutMs,
    onEvent: (event) => {
      log('channel-event', { event })
      server?.notifyToolsChanged()
    }
  })
  const backend = channelBackend(channel)
  server = new McpProtocolServer({
    info: { name: 'aerio', title: 'Aerio', version: options.version, instructions: MCP_BRIDGE_INSTRUCTIONS },
    backend: {
      listTools: backend.listTools,
      async callTool(name, args) {
        const started = Date.now()
        const outcome = await backend.callTool(name, args)
        log('tool-call', mcpDiagnosticDetails({ tool: name, arguments: args, outcome: outcome.ok ? 'ok' : 'error', errorCode: outcome.ok ? undefined : outcome.code, durationMs: Date.now() - started }))
        return outcome
      }
    },
    send: (message) => { options.output.write(`${JSON.stringify(message)}\n`) },
    log
  })
  const inFlight = new Set<Promise<void>>()
  const splitter = new LineSplitter(
    (line) => {
      // Requests run concurrently; JSON-RPC ids pair each reply with its request.
      const handling = server!.handleLine(line).catch(() => undefined).finally(() => inFlight.delete(handling))
      inFlight.add(handling)
    },
    () => options.output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: message too large' } })}\n`),
    MAX_STDIN_LINE_BYTES
  )
  return new Promise<void>((resolveDone) => {
    options.input.on('data', (chunk: Buffer | string) => splitter.push(chunk))
    options.input.on('end', () => {
      splitter.flush()
      // Answer everything already received before disconnecting from Aerio.
      void Promise.all([...inFlight]).then(() => {
        channel.close()
        log('stdin-closed')
        resolveDone()
      })
    })
  })
}
