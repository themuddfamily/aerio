import { createRequire } from 'node:module'
import type { McpAutomationStore } from './mcp/store'
import { McpToolError, type McpToolService } from './mcp/service'

export interface AppleScriptNative {
  start(callback: (id: number, request: string, token: string) => void): void
  complete(id: number, response: string): void
  close(): void
}
export interface AppleScriptOptions {
  platform: NodeJS.Platform; addonPath: string
  runtime(): { store: Pick<McpAutomationStore, 'authenticate' | 'settings' | 'touch'>; service: Pick<McpToolService, 'call'> } | null
  locked(): boolean
  load?(path: string): AppleScriptNative
}
/** Inbound Apple events use precisely the issued-client, scope and capability boundary used by MCP. */
export function initializeAppleScript(options: AppleScriptOptions) {
  if (options.platform !== 'darwin') return { available: false, close() {} }
  const native = (options.load ?? createRequire(import.meta.url))(options.addonPath) as AppleScriptNative
  let closed = false
  const handle = async (request: string, token: string) => {
    const runtime = options.runtime()
    if (!runtime) throw new McpToolError('disabled', 'External automation is not ready.')
    if (typeof request !== 'string' || Buffer.byteLength(request) > 1024 * 1024) throw new McpToolError('invalid-arguments', 'AppleScript request must be a JSON tool call smaller than 1 MiB.')
    const client = runtime.store.authenticate(token)
    if (!client) throw new McpToolError('unauthorized', 'Use an active client token issued in External automation settings.')
    if (options.locked()) throw new McpToolError('locked', 'Unlock Aerio before using AppleScript automation.')
    if (!runtime.store.settings().enabled) throw new McpToolError('disabled', 'Enable External automation in Aerio settings.')
    const permissions = JSON.stringify(runtime.store.settings())
    let input: { name?: unknown; arguments?: unknown }
    try { input = JSON.parse(request); if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.name !== 'string' || !input.arguments || typeof input.arguments !== 'object' || Array.isArray(input.arguments)) throw new Error() }
    catch { throw new McpToolError('invalid-arguments', 'Use a JSON object containing a tool name and arguments object.') }
    runtime.store.touch(client.id)
    const result = await runtime.service.call(client.id, input.name, input.arguments)
    if (closed || options.locked()) throw new McpToolError('locked', 'Aerio locked or closed before the result was returned.')
    if (!runtime.store.authenticate(token)) throw new McpToolError('unauthorized', 'This automation client was revoked.')
    if (!runtime.store.settings().enabled) throw new McpToolError('disabled', 'External automation was disabled.')
    if (JSON.stringify(runtime.store.settings()) !== permissions) throw new McpToolError('conflict', 'Automation permissions changed while this request was running. Check Aerio before retrying an action.')
    const response = JSON.stringify({ ok: true, result })
    if (Buffer.byteLength(response) > 2 * 1024 * 1024) throw new McpToolError('too-large', 'AppleScript result exceeds 2 MiB. Request less content.')
    return response
  }
  native.start((id, request, token) => {
    void handle(request, token).catch((error) => JSON.stringify({ ok: false, error: { code: error instanceof McpToolError ? error.code : 'failed', message: error instanceof McpToolError ? error.message : 'Aerio could not complete this automation request.' } })).then((response) => { if (!closed) native.complete(id, response) })
  })
  return { available: true, close() { closed = true; native.close() } }
}
