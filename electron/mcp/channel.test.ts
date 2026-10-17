import { randomUUID } from 'node:crypto'
import { connect } from 'node:net'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bridgeEndpoint, isMcpBridgeLaunch, mcpLaunchCommand, startMcpBridgeMode } from './bridge-mode'
import { CHANNEL_VERSION, LineSplitter, mcpEndpoint } from './channel'
import { McpLocalServer } from './server'
import { temporaryDirectory } from './test-fixtures'

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step() })

describe('local channel endpoint', () => {
  it('derives a stable per-profile named pipe on Windows and a profile socket elsewhere', () => {
    const windows = mcpEndpoint('C:\\Users\\Ada\\AppData\\Roaming\\Aerio', 'win32')
    expect(windows).toMatch(/^\\\\\.\\pipe\\aerio-mcp-[0-9a-f]{16}$/)
    expect(mcpEndpoint('c:\\users\\ada\\appdata\\roaming\\aerio', 'win32')).toBe(windows)
    expect(mcpEndpoint('C:\\Users\\Grace\\AppData\\Roaming\\Aerio', 'win32')).not.toBe(windows)
    expect(mcpEndpoint('/home/ada/.config/Aerio', 'linux')).toBe('/home/ada/.config/Aerio/mcp.sock')
    // Unix socket paths are limited to about 104 bytes.
    const deep = `/home/ada/${'nested/'.repeat(20)}Aerio`
    expect(mcpEndpoint(deep, 'darwin', '/tmp')).toMatch(/aerio-mcp-[0-9a-f]{16}\.sock$/)
  })
})

describe('line framing', () => {
  it('splits chunks into lines, ignores blank lines, flushes a final partial line, and refuses oversized lines', () => {
    const lines: string[] = []
    const overflow = vi.fn()
    const splitter = new LineSplitter((line) => lines.push(line), overflow, 16)
    splitter.push('{"a":1}\r\n\n{"b"')
    splitter.push(Buffer.from(':2}\n{"c":3}'))
    expect(lines).toEqual(['{"a":1}', '{"b":2}'])
    splitter.flush()
    expect(lines.at(-1)).toBe('{"c":3}')
    splitter.push('x'.repeat(17))
    expect(overflow).toHaveBeenCalledOnce()
  })
})

describe('bridge launch', () => {
  it('detects --mcp and builds the packaged and development launch commands', () => {
    expect(isMcpBridgeLaunch(['Aerio.exe', '--mcp'])).toBe(true)
    expect(isMcpBridgeLaunch(['Aerio.exe', '--aerio-login'])).toBe(false)
    expect(mcpLaunchCommand({ isPackaged: true, getAppPath: () => 'unused' }, 'C:\\Aerio\\Aerio.exe')).toEqual({ command: 'C:\\Aerio\\Aerio.exe', args: ['--mcp'] })
    expect(mcpLaunchCommand({ isPackaged: false, getAppPath: () => join('repo') })).toEqual({ command: 'node', args: [join('repo', 'dist-electron', 'mcp', 'bridge.js')] })
    expect(bridgeEndpoint(['--endpoint=/tmp/a.sock'], {})).toBe('/tmp/a.sock')
    expect(bridgeEndpoint([], { AERIO_MCP_ENDPOINT: '/tmp/b.sock' })).toBe('/tmp/b.sock')
    expect(bridgeEndpoint([], {})).toBe('')
  })

  it('runs the bridge inside the Aerio executable without the app and exits when stdin closes', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const written: string[] = []
    output.on('data', (chunk: Buffer) => written.push(chunk.toString()))
    const app = { getPath: vi.fn(() => join('profile')), getVersion: () => '4.5.6', isPackaged: true, getAppPath: () => '', exit: vi.fn(), dock: { hide: vi.fn() } }
    const done = startMcpBridgeMode(app, ['Aerio', '--mcp'], { AERIO_MCP_TOKEN: 'aerio_mcp_x' }, { input, output, log: () => undefined })
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`)
    input.end()
    await done
    expect(app.dock.hide).toHaveBeenCalled()
    expect(app.getPath).toHaveBeenCalledWith('userData')
    expect(JSON.parse(written.join(''))).toMatchObject({ id: 1, result: { serverInfo: { name: 'aerio', version: '4.5.6' } } })
    expect(app.exit).toHaveBeenCalledWith(0)
  })
})

describe('main-process listener', () => {
  function listener(overrides: Partial<ConstructorParameters<typeof McpLocalServer>[0]> = {}) {
    const temporary = temporaryDirectory('server')
    const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\aerio-mcp-test-${randomUUID()}` : join(temporary.directory, 'mcp.sock')
    const log = vi.fn()
    const server = new McpLocalServer({
      endpoint,
      authenticate: (token) => token === 'aerio_mcp_good' ? { id: 'mcp-1', name: 'Test', createdAt: '2026-10-01T00:00:00.000Z' } : undefined,
      clientExists: () => true,
      touch: vi.fn(),
      listTools: () => [],
      callTool: async () => ({ result: {} }),
      log,
      ...overrides
    })
    cleanup.push(async () => { await server.stop(); temporary.remove() })
    return { server, endpoint, log }
  }

  function talk(endpoint: string) {
    const socket = connect(endpoint)
    const received: any[] = []
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      let index = buffer.indexOf('\n')
      while (index >= 0) { received.push(JSON.parse(buffer.slice(0, index))); buffer = buffer.slice(index + 1); index = buffer.indexOf('\n') }
    })
    const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()))
    socket.on('error', () => undefined)
    cleanup.push(() => { socket.destroy() })
    return { socket, received, closed, send: (message: unknown) => socket.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`) }
  }

  it('closes connections whose first message is not a matching hello', async () => {
    const { server, endpoint } = listener()
    await server.start()
    const wrongVersion = talk(endpoint)
    wrongVersion.send({ type: 'hello', version: CHANNEL_VERSION + 1, token: 'aerio_mcp_good' })
    await wrongVersion.closed
    expect(wrongVersion.received[0]).toMatchObject({ type: 'rejected', error: { code: 'unauthorized' } })
    const garbage = talk(endpoint)
    garbage.send('not json')
    await garbage.closed
    expect(garbage.received).toEqual([])
    const request = talk(endpoint)
    request.send({ type: 'request', id: 1, method: 'tools/list' })
    await request.closed
    expect(request.received[0]).toMatchObject({ type: 'rejected' })
  })

  it('answers requests after a valid hello and reports unsupported methods and failures as channel errors', async () => {
    const { server, endpoint } = listener({ callTool: async () => { throw new Error('worker exploded') } })
    await server.start()
    expect(server.listening).toBe(true)
    await server.start()
    const client = talk(endpoint)
    client.send({ type: 'hello', version: CHANNEL_VERSION, token: 'aerio_mcp_good' })
    await vi.waitFor(() => expect(client.received[0]).toEqual({ type: 'welcome', version: CHANNEL_VERSION, clientId: 'mcp-1', clientName: 'Test' }))
    expect(server.connectedClientIds()).toEqual(new Set(['mcp-1']))
    client.send({ type: 'request', id: 1, method: 'tools/list' })
    client.send({ type: 'request', id: 2, method: 'tools/call', params: { name: 'x' } })
    client.send({ type: 'request', id: 3, method: 'resources/list' })
    client.send({ type: 'event', event: 'ignored' })
    await vi.waitFor(() => expect(client.received).toHaveLength(4))
    expect(client.received.slice(1)).toEqual(expect.arrayContaining([
      { type: 'response', id: 1, result: { tools: [] } },
      { type: 'response', id: 2, error: { code: 'failed', message: 'worker exploded' } },
      { type: 'response', id: 3, error: { code: 'unknown-tool', message: 'Unsupported request' } }
    ]))
    server.broadcast('tools-changed')
    await vi.waitFor(() => expect(client.received.at(-1)).toEqual({ type: 'event', event: 'tools-changed' }))
    await server.stop('disabled')
    await client.closed
    expect(client.received.at(-1)).toEqual({ type: 'event', event: 'disabled' })
    expect(server.listening).toBe(false)
  })

  it('limits concurrent requests per connection', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { server, endpoint } = listener({ callTool: async () => { await gate; return { result: { ok: true } } } })
    await server.start()
    const client = talk(endpoint)
    client.send({ type: 'hello', version: CHANNEL_VERSION, token: 'aerio_mcp_good' })
    await vi.waitFor(() => expect(client.received).toHaveLength(1))
    for (let id = 1; id <= 17; id++) client.send({ type: 'request', id, method: 'tools/call', params: { name: 'slow' } })
    await vi.waitFor(() => expect(client.received.some((message) => message.id === 17)).toBe(true))
    expect(client.received.find((message) => message.id === 17)).toMatchObject({ error: { message: /Too many requests/ } })
    release()
    await vi.waitFor(() => expect(client.received.filter((message) => message.type === 'response')).toHaveLength(17))
  })

  it('reports a listen failure without leaving a half-started server', async () => {
    const { server, log } = listener({ endpoint: process.platform === 'win32' ? 'not-a-pipe-name' : join(temporaryDirectory('missing').directory, 'no', 'such', 'dir', 'mcp.sock') })
    await expect(server.start()).rejects.toThrow()
    expect(server.listening).toBe(false)
    expect(log).toHaveBeenCalledWith('mcp-listen-failed', {}, expect.anything())
  })
})
