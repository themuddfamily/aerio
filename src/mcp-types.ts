/**
 * External automation through the Model Context Protocol (E48).
 *
 * A local stdio bridge (`electron/mcp/bridge.ts`) speaks MCP to an external
 * client and forwards tool calls to the running Aerio main process over an
 * authenticated local channel. Everything here is the renderer-facing contract.
 */

/** Read access is implied once the bridge is enabled; the rest are separate opt-ins. */
export type McpCapability = 'read' | 'write' | 'send' | 'delete'

export interface McpCapabilitySettings {
  write: boolean
  send: boolean
  delete: boolean
}

export interface McpSettings {
  enabled: boolean
  capabilities: McpCapabilitySettings
  /** `all` exposes every connected account; otherwise only the listed account ids. */
  accountScope: 'all' | string[]
}

export interface McpToolDescriptor {
  name: string
  title: string
  capability: McpCapability
  /** Plain-language effect shown in Settings before a capability is enabled. */
  effect: string
  /** True when the current settings let a client call this tool. */
  enabled: boolean
}

export interface McpClientSummary {
  id: string
  name: string
  createdAt: string
  lastUsedAt?: string
  /** A bridge authenticated with this client's token is connected now. */
  connected: boolean
}

export interface McpClientConfig {
  /** Command and arguments that start the stdio bridge on this device. */
  command: string
  args: string[]
  /** `claude_desktop_config.json` style `mcpServers` JSON, including this client's token. */
  claudeDesktop: string
  /** Generic `mcpServers` JSON for other MCP clients. */
  generic: string
}

export interface McpStatus {
  settings: McpSettings
  /** The local channel is listening (the bridge is enabled and Aerio is running). */
  listening: boolean
  endpoint: string
  clients: McpClientSummary[]
  tools: McpToolDescriptor[]
  /** The bridge launch command, without any token. */
  command: string
  args: string[]
}

export interface McpIssuedClient {
  client: McpClientSummary
  /** Shown once. Aerio keeps only a hash, so a lost token is replaced by issuing a new client. */
  token: string
  config: McpClientConfig
}

export interface McpAutomationApi {
  status(): Promise<McpStatus>
  save(settings: McpSettings): Promise<McpStatus>
  createClient(name: string): Promise<McpIssuedClient>
  revokeClient(id: string): Promise<McpStatus>
  onChanged(callback: (status: McpStatus) => void): () => void
}
