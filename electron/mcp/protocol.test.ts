import { describe, expect, it, vi } from 'vitest'
import { JSON_RPC_ERRORS, LATEST_PROTOCOL_VERSION, McpProtocolServer, decodeCursor, encodeCursor, type McpBackend, type McpProtocolTool } from './protocol'

const tools: McpProtocolTool[] = Array.from({ length: 7 }, (_, index) => ({
  name: `tool_${index}`, title: `Tool ${index}`, description: `Tool number ${index}`, inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true }
}))

function harness(backend: Partial<McpBackend> = {}, pageSize?: number) {
  const sent: any[] = []
  const server = new McpProtocolServer({
    info: { name: 'aerio', title: 'Aerio', version: '1.2.3', instructions: 'Use the tools.' },
    backend: {
      listTools: backend.listTools ?? (async () => tools),
      callTool: backend.callTool ?? (async (name) => ({ ok: true, result: { called: name } }))
    },
    send: (message) => sent.push(message),
    pageSize
  })
  const request = async (message: unknown) => {
    sent.length = 0
    await server.handleLine(typeof message === 'string' ? message : JSON.stringify(message))
    return sent.length === 1 ? sent[0] : sent.length ? [...sent] : undefined
  }
  const initialize = (protocolVersion = '2025-06-18') => request({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion, capabilities: {}, clientInfo: { name: 'test-client', version: '1' } } })
  return { server, sent, request, initialize }
}

describe('MCP lifecycle and version negotiation', () => {
  it('answers initialize with the requested supported version, tool capability, and server info', async () => {
    const { initialize, server } = harness()
    expect(await initialize('2025-03-26')).toEqual({
      jsonrpc: '2.0', id: 0,
      result: { protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'aerio', title: 'Aerio', version: '1.2.3' }, instructions: 'Use the tools.' }
    })
    expect(server.initialized).toBe(true)
    expect(server.client).toBe('test-client')
  })

  it('offers the latest version when the client asks for an unknown one, and omits title for 2024-11-05', async () => {
    expect((await harness().initialize('1999-01-01')).result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION)
    expect((await harness().initialize('2024-11-05')).result.serverInfo).toEqual({ name: 'aerio', version: '1.2.3' })
  })

  it('rejects initialize without a protocol version and tool requests before initialize', async () => {
    const { request } = harness()
    expect((await request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).error.code).toBe(JSON_RPC_ERRORS.invalidParams)
    expect((await request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: 'all' } })).error.code).toBe(JSON_RPC_ERRORS.invalidParams)
    expect(await request({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).toEqual({ jsonrpc: '2.0', id: 2, error: { code: JSON_RPC_ERRORS.notInitialized, message: 'Server not initialized' } })
    expect((await request({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'x' } })).error.code).toBe(JSON_RPC_ERRORS.notInitialized)
    // ping is allowed at any time.
    expect(await request({ jsonrpc: '2.0', id: 'p', method: 'ping' })).toEqual({ jsonrpc: '2.0', id: 'p', result: {} })
  })
})

describe('JSON-RPC 2.0 framing', () => {
  it('returns standard errors for parse failures, invalid requests, and unknown methods', async () => {
    const { request, initialize } = harness()
    await initialize()
    expect(await request('{not json')).toEqual({ jsonrpc: '2.0', id: null, error: { code: JSON_RPC_ERRORS.parseError, message: 'Parse error' } })
    expect((await request({ id: 1, method: 'ping' })).error.code).toBe(JSON_RPC_ERRORS.invalidRequest)
    expect(await request({ jsonrpc: '1.0', id: 9, method: 'ping' })).toMatchObject({ id: 9, error: { code: JSON_RPC_ERRORS.invalidRequest } })
    expect(await request({ jsonrpc: '2.0', id: { nested: true }, method: 'ping' })).toMatchObject({ id: null, error: { code: JSON_RPC_ERRORS.invalidRequest } })
    expect(await request({ jsonrpc: '2.0', id: 4, method: 7 })).toMatchObject({ id: 4, error: { code: JSON_RPC_ERRORS.invalidRequest } })
    expect(await request({ jsonrpc: '2.0', id: 5, method: 'ping', params: 'x' })).toMatchObject({ id: 5, error: { code: JSON_RPC_ERRORS.invalidRequest } })
    expect(await request({ jsonrpc: '2.0', id: 6, method: 'resources/list' })).toMatchObject({ id: 6, error: { code: JSON_RPC_ERRORS.methodNotFound } })
    expect(await request('[]')).toMatchObject({ id: null, error: { code: JSON_RPC_ERRORS.invalidRequest } })
  })

  it('sends nothing for notifications or client responses and answers batches together', async () => {
    const { request, initialize } = harness()
    await initialize()
    expect(await request({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeUndefined()
    expect(await request({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } })).toBeUndefined()
    expect(await request({ jsonrpc: '2.0', id: 3, result: {} })).toBeUndefined()
    expect(await request('   ')).toBeUndefined()
    const batch = await request([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'nope' }])
    expect(batch).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }, { jsonrpc: '2.0', id: 2, error: { code: JSON_RPC_ERRORS.methodNotFound, message: 'Method not found: nope' } }])
  })

  it('hides unexpected backend failures behind an internal error', async () => {
    const log = vi.fn()
    const sent: any[] = []
    const server = new McpProtocolServer({ info: { name: 'aerio', title: 'Aerio', version: '1' }, backend: { listTools: async () => { throw new Error('secret@example.com broke') }, callTool: vi.fn() }, send: (message) => sent.push(message), log })
    await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }))
    await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))
    expect(sent[1]).toEqual({ jsonrpc: '2.0', id: 2, error: { code: JSON_RPC_ERRORS.internalError, message: 'Internal error' } })
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret@example.com')
  })
})

describe('tools feature', () => {
  it('paginates tools/list with opaque cursors and rejects invalid ones', async () => {
    const { request, initialize } = harness({}, 3)
    await initialize()
    const first = (await request({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result
    expect(first.tools.map((tool: McpProtocolTool) => tool.name)).toEqual(['tool_0', 'tool_1', 'tool_2'])
    const second = (await request({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { cursor: first.nextCursor } })).result
    expect(second.tools.map((tool: McpProtocolTool) => tool.name)).toEqual(['tool_3', 'tool_4', 'tool_5'])
    const last = (await request({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: { cursor: second.nextCursor } })).result
    expect(last).toEqual({ tools: [expect.objectContaining({ name: 'tool_6' })] })
    for (const cursor of ['garbage', 7, encodeCursor(99), Buffer.from('{"offset":-1}').toString('base64url')]) {
      expect((await request({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: { cursor } })).error).toMatchObject({ code: JSON_RPC_ERRORS.invalidParams, message: 'Invalid cursor' })
    }
    expect(decodeCursor(encodeCursor(5))).toBe(5)
    expect(decodeCursor('x'.repeat(201))).toBe(-1)
  })

  it('lists every tool on one page by default and strips newer fields for 2024-11-05 clients', async () => {
    const modern = harness()
    await modern.initialize()
    const page = (await modern.request({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result
    expect(page.tools).toHaveLength(7)
    expect(page.nextCursor).toBeUndefined()
    const legacy = harness()
    await legacy.initialize('2024-11-05')
    expect((await legacy.request({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools[0]).toEqual({ name: 'tool_0', description: 'Tool number 0', inputSchema: tools[0].inputSchema })
  })

  it('returns results with structured content, tool failures as isError results, and argument problems as invalid params', async () => {
    const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'bad_args') return { ok: false as const, code: 'invalid-arguments', message: 'Invalid arguments for bad_args: x is required', details: ['x is required'] }
      if (name === 'missing') return { ok: false as const, code: 'unknown-tool', message: 'Unknown tool: missing' }
      if (name === 'locked') return { ok: false as const, code: 'locked', message: 'Aerio is locked.' }
      return { ok: true as const, result: { echoed: args } }
    })
    const { request, initialize } = harness({ callTool })
    await initialize()
    expect((await request({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { a: 1 } } })).result).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ echoed: { a: 1 } }, null, 2) }], structuredContent: { echoed: { a: 1 } }, isError: false
    })
    expect((await request({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo' } })).result.structuredContent).toEqual({ echoed: {} })
    expect((await request({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'locked' } })).result).toEqual({
      content: [{ type: 'text', text: 'Aerio is locked. (locked)' }], structuredContent: { error: { code: 'locked', message: 'Aerio is locked.' } }, isError: true
    })
    expect((await request({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'bad_args' } })).error).toEqual({
      code: JSON_RPC_ERRORS.invalidParams, message: 'Invalid arguments for bad_args: x is required', data: { code: 'invalid-arguments', details: ['x is required'] }
    })
    expect((await request({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'missing' } })).error).toMatchObject({ code: JSON_RPC_ERRORS.invalidParams, data: { code: 'unknown-tool' } })
    expect((await request({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: {} })).error.code).toBe(JSON_RPC_ERRORS.invalidParams)
    expect((await request({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'echo', arguments: [1] } })).error.code).toBe(JSON_RPC_ERRORS.invalidParams)
    expect(callTool).toHaveBeenCalledTimes(5)
  })

  it('omits structuredContent for clients older than 2025-06-18 and sends list_changed only after initialize', async () => {
    const { request, initialize, server, sent } = harness()
    server.notifyToolsChanged()
    expect(sent).toEqual([])
    await initialize('2025-03-26')
    const result = (await request({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo' } })).result
    expect(result).not.toHaveProperty('structuredContent')
    sent.length = 0
    server.notifyToolsChanged()
    expect(sent).toEqual([{ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }])
  })
})
