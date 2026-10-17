import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MailDraftInput } from '../../src/mail-types'
import type { McpIssuedClient, McpStatus } from '../../src/mcp-types'
import { mcpClientConfig, registerMcpAutomation } from './automation-ipc'
import { runMcpBridge } from './bridge-runtime'
import { fakeWorker, temporaryDirectory } from './test-fixtures'

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step() })

function testEndpoint(directory: string) {
  return process.platform === 'win32' ? `\\\\.\\pipe\\aerio-mcp-test-${randomUUID()}` : join(directory, 'mcp.sock')
}

function app() {
  const temporary = temporaryDirectory('app')
  const handlers = new Map<string, (...args: any[]) => any>()
  const worker = fakeWorker()
  let locked = false
  const diagnostics: unknown[][] = []
  const sendDraft = vi.fn((input: MailDraftInput) => worker.request({ type: 'drafts:send', payload: input }) as Promise<any>)
  const changed = vi.fn()
  const automation = registerMcpAutomation({
    ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => { handlers.set(channel, handler) } } as any,
    userData: temporary.directory,
    endpoint: testEndpoint(temporary.directory),
    launch: { command: 'node', args: [join(temporary.directory, 'bridge.js')] },
    worker: () => worker,
    isLocked: () => locked,
    validateDraft: (input) => input,
    approveAttachmentPaths: vi.fn(),
    sendDraft,
    openMessage: vi.fn(),
    changed,
    diagnostic: (...args) => { diagnostics.push(args) }
  })
  cleanup.push(async () => { await automation.stop(); temporary.remove() })
  const invoke = async <T = any>(channel: string, ...args: unknown[]): Promise<T> => handlers.get(channel)!({}, ...args)
  return { automation, invoke, worker, sendDraft, diagnostics, changed, setLocked: (value: boolean) => { locked = value } }
}

function bridge(endpoint: string, token: string) {
  const input = new PassThrough()
  const output = new PassThrough()
  const messages: any[] = []
  let buffer = ''
  output.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      messages.push(JSON.parse(buffer.slice(0, index)))
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
    }
  })
  const log = vi.fn()
  const done = runMcpBridge({ input, output, log, endpoint, token, version: '9.9.9', timeoutMs: 5_000 })
  cleanup.push(async () => { input.end(); await done })
  let nextId = 1
  const rpc = async (method: string, params?: Record<string, unknown>) => {
    const id = nextId++
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`)
    await vi.waitFor(() => expect(messages.some((message) => message.id === id)).toBe(true), { timeout: 5_000 })
    return messages.find((message) => message.id === id)
  }
  const call = async (name: string, args: Record<string, unknown> = {}) => (await rpc('tools/call', { name, arguments: args })).result
  const start = () => rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'vitest', version: '1' } })
  return { rpc, call, start, messages, log, input }
}

const enable = (aerio: ReturnType<typeof app>, capabilities = { write: false, send: false, delete: false }, accountScope: 'all' | string[] = 'all') =>
  aerio.invoke<McpStatus>('mcp:save', { enabled: true, capabilities, accountScope })

describe('external automation end to end (bridge ↔ local channel ↔ main)', () => {
  it('reports that Aerio is not running while the bridge is off, but still lists the tool catalog', async () => {
    const aerio = app()
    expect((await aerio.invoke<McpStatus>('mcp:status')).listening).toBe(false)
    const client = bridge(aerio.automation.status().endpoint, 'aerio_mcp_unused')
    await client.start()
    expect((await client.rpc('tools/list')).result.tools).toHaveLength(15)
    expect(await client.call('list_accounts')).toMatchObject({ isError: true, structuredContent: { error: { code: 'app-not-running' } } })
  })

  it('issues a client, enforces capabilities, notifies capability changes, and records last use', async () => {
    const aerio = app()
    const status = await enable(aerio)
    expect(status).toMatchObject({ listening: true, settings: { enabled: true } })
    const issued = await aerio.invoke<McpIssuedClient>('mcp:client:create', 'Claude Desktop')
    const config = JSON.parse(issued.config.claudeDesktop)
    expect(config).toEqual({ mcpServers: { aerio: { command: 'node', args: [expect.stringMatching(/bridge\.js$/)], env: { AERIO_MCP_TOKEN: issued.token, AERIO_MCP_ENDPOINT: status.endpoint } } } })
    expect(JSON.parse(issued.config.generic).mcpServers.aerio).toMatchObject({ type: 'stdio', env: { AERIO_MCP_TOKEN: issued.token } })

    const client = bridge(status.endpoint, issued.token)
    expect((await client.start()).result.protocolVersion).toBe('2025-06-18')
    expect((await client.rpc('tools/list')).result.tools.map((tool: { name: string }) => tool.name)).toEqual(['list_accounts', 'list_folders', 'search_mail', 'get_conversation', 'get_message', 'get_attachment', 'open_in_aerio'])
    const accounts = await client.call('list_accounts')
    expect(accounts).toMatchObject({ isError: false, structuredContent: { accounts: [expect.objectContaining({ id: 'acct-work' }), expect.objectContaining({ id: 'acct-home' })] } })
    expect(await client.call('archive', { accountId: 'acct-work', conversationIds: ['acct-work-thread-0'] })).toMatchObject({ isError: true, structuredContent: { error: { code: 'capability-disabled' } } })
    const current = await aerio.invoke<McpStatus>('mcp:status')
    expect(current.clients).toEqual([expect.objectContaining({ id: issued.client.id, name: 'Claude Desktop', connected: true, lastUsedAt: expect.any(String) })])

    client.messages.length = 0
    await enable(aerio, { write: true, send: false, delete: false })
    await vi.waitFor(() => expect(client.messages).toContainEqual({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }))
    expect((await client.rpc('tools/list')).result.tools).toHaveLength(13)
    expect(await client.call('archive', { accountId: 'acct-work', conversationIds: ['acct-work-thread-0'] })).toMatchObject({ isError: false, structuredContent: { action: 'archive', status: 'queued' } })
    expect(aerio.changed).toHaveBeenCalled()
  })

  it('maps invalid arguments to JSON-RPC invalid params and returns attachments through the channel', async () => {
    const aerio = app()
    await enable(aerio)
    const { token } = await aerio.invoke<McpIssuedClient>('mcp:client:create', 'Script')
    const client = bridge(aerio.automation.status().endpoint, token)
    await client.start()
    const invalid = await client.rpc('tools/call', { name: 'get_message', arguments: { accountId: 'acct-work' } })
    expect(invalid.error).toMatchObject({ code: -32602, data: { code: 'invalid-arguments', details: ['conversationId is required', 'messageId is required'] } })
    expect((await client.rpc('tools/call', { name: 'no_such_tool', arguments: {} })).error).toMatchObject({ code: -32602, data: { code: 'unknown-tool' } })
    const attachment = await client.call('get_attachment', { accountId: 'acct-work', conversationId: 'acct-work-thread-0', messageId: 'acct-work-thread-0-m2', attachmentId: 'att-pdf' })
    expect(attachment.structuredContent).toMatchObject({ filename: 'report.pdf', data: Buffer.from('bytes of att-pdf').toString('base64') })
    expect(attachment.content[1]).toMatchObject({ type: 'resource', resource: { mimeType: 'application/pdf' } })
  })

  it('answers "locked" without data while Aerio is locked and refuses Settings changes', async () => {
    const aerio = app()
    await enable(aerio)
    const { token } = await aerio.invoke<McpIssuedClient>('mcp:client:create', 'Assistant')
    const client = bridge(aerio.automation.status().endpoint, token)
    await client.start()
    aerio.setLocked(true)
    aerio.worker.request.mockClear()
    const locked = await client.call('search_mail', { query: 'report' })
    expect(locked).toMatchObject({ isError: true, structuredContent: { error: { code: 'locked' } } })
    expect(JSON.stringify(locked)).not.toMatch(/Quarterly|grace/)
    expect(aerio.worker.request).not.toHaveBeenCalled()
    await expect(aerio.invoke('mcp:client:create', 'Another')).rejects.toThrow(/Unlock Aerio/)
    await expect(enable(aerio)).rejects.toThrow(/Unlock Aerio/)
    aerio.setLocked(false)
    expect((await client.call('search_mail', { query: 'report' })).isError).toBe(false)
  })

  it('rejects unknown tokens and cuts off a revoked client immediately', async () => {
    const aerio = app()
    await enable(aerio)
    const intruder = bridge(aerio.automation.status().endpoint, 'aerio_mcp_forged-token-value')
    await intruder.start()
    expect(await intruder.call('list_accounts')).toMatchObject({ isError: true, structuredContent: { error: { code: 'unauthorized' } } })
    const noToken = bridge(aerio.automation.status().endpoint, '')
    await noToken.start()
    expect(await noToken.call('list_accounts')).toMatchObject({ isError: true, structuredContent: { error: { code: 'unauthorized' } } })

    const issued = await aerio.invoke<McpIssuedClient>('mcp:client:create', 'Revocable')
    const client = bridge(aerio.automation.status().endpoint, issued.token)
    await client.start()
    expect((await client.call('list_accounts')).isError).toBe(false)
    const status = await aerio.invoke<McpStatus>('mcp:client:revoke', issued.client.id)
    expect(status.clients).toEqual([])
    expect(await client.call('list_accounts')).toMatchObject({ isError: true, structuredContent: { error: { code: 'unauthorized' } } })
    expect(aerio.diagnostics.some(([, event]) => event === 'mcp-auth-rejected')).toBe(true)
  })

  it('prevents duplicate sends across retries through the full stack', async () => {
    const aerio = app()
    await enable(aerio, { write: true, send: true, delete: false })
    const { token } = await aerio.invoke<McpIssuedClient>('mcp:client:create', 'Sender')
    const client = bridge(aerio.automation.status().endpoint, token)
    await client.start()
    const draft = (await client.call('create_draft', { accountId: 'acct-work', to: ['grace@example.test'], subject: 'Numbers', text: 'Here they are' })).structuredContent
    const first = await client.call('send_draft', { draftId: draft.draftId, idempotencyKey: 'e2e-send-key-1' })
    const second = await client.call('send_draft', { draftId: draft.draftId, idempotencyKey: 'e2e-send-key-1' })
    expect(first.structuredContent).toMatchObject({ status: 'send-pending', duplicate: false })
    expect(second.structuredContent).toMatchObject({ status: 'send-pending', duplicate: true })
    expect(aerio.sendDraft).toHaveBeenCalledOnce()
  })

  it('writes redacted diagnostics for tool calls', async () => {
    const aerio = app()
    await enable(aerio, { write: true, send: false, delete: false })
    const { token } = await aerio.invoke<McpIssuedClient>('mcp:client:create', 'Logger')
    const client = bridge(aerio.automation.status().endpoint, token)
    await client.start()
    await client.call('create_draft', { accountId: 'acct-work', to: ['grace@example.test'], subject: 'Acquisition plans', text: 'Top secret body' })
    await client.call('get_conversation', { accountId: 'acct-work', conversationId: 'acct-work-thread-0' })
    await client.call('get_conversation', { accountId: 'acct-work', conversationId: 'missing-thread' })
    const toolCalls = aerio.diagnostics.filter(([, event]) => event === 'mcp-tool-call')
    expect(toolCalls).toHaveLength(3)
    expect(toolCalls[0][2]).toMatchObject({ tool: 'create_draft', outcome: 'ok', argumentNames: ['accountId', 'subject', 'text', 'to'] })
    expect(toolCalls[2][2]).toMatchObject({ tool: 'get_conversation', outcome: 'refused', errorCode: 'not-found' })
    const logged = JSON.stringify([aerio.diagnostics, client.log.mock.calls])
    for (const secret of ['grace@example.test', 'ada@example.test', 'Acquisition plans', 'Top secret body', 'First message body', 'Quarterly', token]) expect(logged).not.toContain(secret)
  })

  it('reports that Aerio is not running after shutdown or when the bridge is turned off', async () => {
    const aerio = app()
    await enable(aerio)
    const { token } = await aerio.invoke<McpIssuedClient>('mcp:client:create', 'Shutdown')
    const client = bridge(aerio.automation.status().endpoint, token)
    await client.start()
    expect((await client.call('list_accounts')).isError).toBe(false)
    await aerio.invoke('mcp:save', { enabled: false, capabilities: { write: false, send: false, delete: false }, accountScope: 'all' })
    expect(aerio.automation.status().listening).toBe(false)
    expect(await client.call('list_accounts')).toMatchObject({ isError: true, structuredContent: { error: { code: 'app-not-running' } } })
    await enable(aerio)
    expect((await client.call('list_accounts')).isError).toBe(false)
    await aerio.automation.server.stop('shutdown')
    expect(await client.call('list_accounts')).toMatchObject({ isError: true, structuredContent: { error: { code: 'app-not-running' } } })
  })
})

describe('client configuration snippet', () => {
  it('produces Claude Desktop and generic mcpServers JSON with the token only in the environment', () => {
    const config = mcpClientConfig({ command: 'C:\\Program Files\\Aerio\\Aerio.exe', args: ['--mcp'] }, '\\\\.\\pipe\\aerio-mcp-abc', 'aerio_mcp_token')
    expect(JSON.parse(config.claudeDesktop)).toEqual({ mcpServers: { aerio: { command: 'C:\\Program Files\\Aerio\\Aerio.exe', args: ['--mcp'], env: { AERIO_MCP_TOKEN: 'aerio_mcp_token', AERIO_MCP_ENDPOINT: '\\\\.\\pipe\\aerio-mcp-abc' } } } })
    expect(JSON.parse(config.generic)).toEqual({ mcpServers: { aerio: { type: 'stdio', command: 'C:\\Program Files\\Aerio\\Aerio.exe', args: ['--mcp'], env: { AERIO_MCP_TOKEN: 'aerio_mcp_token', AERIO_MCP_ENDPOINT: '\\\\.\\pipe\\aerio-mcp-abc' } } } })
    expect(config.args).toEqual(['--mcp'])
  })
})
