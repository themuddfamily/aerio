import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMain } from 'electron'
import type { McpClientConfig, McpIssuedClient, McpStatus } from '../../src/mcp-types'
import type { MailDraftInput, MailDraftResult } from '../../src/mail-types'
import type { MessageWindowRequest } from '../../src/types'
import type { MailWorkerCommand, MailWorkerResult } from '../mail-protocol'
import { mcpEndpoint } from './channel'
import { mcpDiagnosticDetails, redactMcpText } from './redact'
import { McpLocalServer, type McpLocalServerDeps } from './server'
import { McpToolError, McpToolService } from './service'
import { McpAutomationStore } from './store'

export interface McpAutomationOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  userData: string
  /** How an MCP client starts the bridge on this device (no token). */
  launch: { command: string; args: string[] }
  worker(): { request<T extends MailWorkerResult = void>(command: MailWorkerCommand): Promise<T> }
  isLocked(): boolean
  validateDraft(input: MailDraftInput): MailDraftInput
  approveAttachmentPaths(paths: string[]): void
  sendDraft(input: MailDraftInput): Promise<MailDraftResult>
  openMessage(input: MessageWindowRequest): void
  /** Pushes a fresh status to renderer windows. */
  changed(status: McpStatus): void
  diagnostic(level: 'info' | 'warn' | 'error', event: string, details?: Record<string, unknown>, message?: string): void
  store?: McpAutomationStore
  endpoint?: string
  createServer?: McpLocalServerDeps['createServer']
}

export function mcpClientConfig(launch: { command: string; args: string[] }, endpoint: string, token: string): McpClientConfig {
  const server = { command: launch.command, args: launch.args, env: { AERIO_MCP_TOKEN: token, AERIO_MCP_ENDPOINT: endpoint } }
  return {
    command: launch.command,
    args: launch.args,
    claudeDesktop: JSON.stringify({ mcpServers: { aerio: server } }, null, 2),
    generic: JSON.stringify({ mcpServers: { aerio: { type: 'stdio', ...server } } }, null, 2)
  }
}

/** Wires Settings › External automation (MCP) IPC, the tool service, and the local channel. */
export function registerMcpAutomation(options: McpAutomationOptions) {
  const store = options.store ?? new McpAutomationStore(join(options.userData, 'mcp-automation.sqlite'))
  const endpoint = options.endpoint ?? mcpEndpoint(options.userData)
  const worker = () => options.worker()
  const service = new McpToolService({
    request: (command) => worker().request(command),
    settings: () => store.settings(),
    isLocked: options.isLocked,
    validateDraft: options.validateDraft,
    approveAttachmentPaths: options.approveAttachmentPaths,
    sendDraft: options.sendDraft,
    openMessage: options.openMessage,
    readAttachment: async (accountId, messageId, attachmentId) => {
      const directory = join(tmpdir(), 'aerio-mcp')
      mkdirSync(directory, { recursive: true })
      const targetPath = join(directory, randomUUID())
      try {
        await worker().request({ type: 'attachment:extract', payload: { accountId, messageId, attachmentId, targetPath } })
        return readFileSync(targetPath)
      } finally {
        rmSync(targetPath, { force: true })
      }
    },
    sends: store
  })
  const server = new McpLocalServer({
    endpoint,
    createServer: options.createServer,
    authenticate: (token) => store.authenticate(token),
    clientExists: (id) => Boolean(store.client(id)),
    touch: (id) => store.touch(id),
    listTools: () => service.listTools(),
    callTool: async (clientId, name, args) => {
      const started = Date.now()
      try {
        const result = await service.call(clientId, name, args)
        options.diagnostic('info', 'mcp-tool-call', mcpDiagnosticDetails({ tool: String(name), clientId, outcome: 'ok', arguments: args, durationMs: Date.now() - started, duplicate: result.result.duplicate === true }))
        return result
      } catch (error) {
        const code = error instanceof McpToolError ? error.code : 'failed'
        options.diagnostic(code === 'failed' ? 'warn' : 'info', 'mcp-tool-call', mcpDiagnosticDetails({
          tool: String(name), clientId, outcome: code === 'failed' ? 'error' : 'refused', errorCode: code, arguments: args, durationMs: Date.now() - started,
          ...(code === 'failed' ? { error } : {})
        }))
        throw error
      }
    },
    log: (event, details, error) => options.diagnostic(error ? 'error' : 'info', event, details, error === undefined ? undefined : redactMcpText(error))
  })

  const status = (): McpStatus => {
    const settings = store.settings()
    const connected = server.connectedClientIds()
    return {
      settings,
      listening: server.listening,
      endpoint,
      clients: store.listClients().map((client) => ({ ...client, connected: connected.has(client.id) })),
      tools: service.descriptors(settings),
      command: options.launch.command,
      args: options.launch.args
    }
  }
  const publish = () => {
    const next = status()
    options.changed(next)
    return next
  }
  const requireUnlocked = () => { if (options.isLocked()) throw new Error('Unlock Aerio before changing external automation') }
  const apply = async () => {
    const settings = store.settings()
    if (settings.enabled && !server.listening) await server.start()
    else if (!settings.enabled && server.listening) await server.stop('disabled')
    server.broadcast('tools-changed')
  }
  const ready = apply().catch(() => undefined)

  options.ipcMain.handle('mcp:status', async () => { await ready; return status() })
  options.ipcMain.handle('mcp:save', async (_event, input: unknown) => {
    requireUnlocked()
    await ready
    const previous = store.settings()
    const settings = store.saveSettings(input)
    try { await apply() } catch (error) {
      store.saveSettings(previous)
      throw new Error(`The automation bridge could not start: ${redactMcpText(error)}`)
    }
    options.diagnostic('info', 'mcp-settings-saved', { enabled: settings.enabled, write: settings.capabilities.write, send: settings.capabilities.send, delete: settings.capabilities.delete, scopedAccounts: settings.accountScope === 'all' ? 'all' : settings.accountScope.length })
    return publish()
  })
  options.ipcMain.handle('mcp:client:create', async (_event, name: unknown): Promise<McpIssuedClient> => {
    requireUnlocked()
    const { client, token } = store.createClient(name)
    options.diagnostic('info', 'mcp-client-issued', { clientId: client.id })
    publish()
    return { client: { ...client, connected: false }, token, config: mcpClientConfig(options.launch, endpoint, token) }
  })
  options.ipcMain.handle('mcp:client:revoke', (_event, id: unknown) => {
    requireUnlocked()
    if (store.revoke(id)) {
      server.disconnectClient(id as string)
      options.diagnostic('info', 'mcp-client-revoked', { clientId: id })
    }
    return publish()
  })

  return {
    service,
    server,
    store,
    status,
    /** Bridges re-read tools/list; calls answer `locked` while the app is locked. */
    lockChanged: () => server.broadcast('tools-changed'),
    async stop() {
      await server.stop('shutdown')
      store.close()
    }
  }
}
