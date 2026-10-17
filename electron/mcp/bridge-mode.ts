import { join } from 'node:path'
import { runMcpBridge, type McpBridgeOptions } from './bridge-runtime'
import { mcpEndpoint } from './channel'

/** `Aerio --mcp` runs the stdio bridge instead of the app. */
export function isMcpBridgeLaunch(argv: string[]) {
  return argv.includes('--mcp')
}

/** `--endpoint=<path>` wins over AERIO_MCP_ENDPOINT; empty when neither is set. */
export function bridgeEndpoint(argv: string[], env: NodeJS.ProcessEnv) {
  const flag = argv.find((arg) => arg.startsWith('--endpoint='))
  return flag ? flag.slice('--endpoint='.length) : env.AERIO_MCP_ENDPOINT ?? ''
}

interface BridgeApp {
  getPath(name: 'userData'): string
  getVersion(): string
  isPackaged: boolean
  getAppPath(): string
  exit(code?: number): void
  dock?: { hide(): void }
}

type BridgeIo = Pick<McpBridgeOptions, 'input' | 'output' | 'log'>
const processIo = (): BridgeIo => ({ input: process.stdin, output: process.stdout, log: (line) => process.stderr.write(`${line}\n`) })

/**
 * Runs the bridge inside the Aerio executable. It never takes the
 * single-instance lock, opens a window, or touches profile databases: it only
 * connects to the running Aerio over the local channel.
 */
export function startMcpBridgeMode(app: BridgeApp, argv = process.argv, env = process.env, io: BridgeIo = processIo()) {
  app.dock?.hide()
  return runMcpBridge({
    ...io,
    endpoint: bridgeEndpoint(argv, env) || mcpEndpoint(app.getPath('userData')),
    token: env.AERIO_MCP_TOKEN ?? '',
    version: app.getVersion()
  }).then(() => app.exit(0))
}

/** How an MCP client starts the bridge for this installation. */
export function mcpLaunchCommand(app: Pick<BridgeApp, 'isPackaged' | 'getAppPath'>, execPath = process.execPath) {
  return app.isPackaged
    ? { command: execPath, args: ['--mcp'] }
    : { command: 'node', args: [join(app.getAppPath(), 'dist-electron', 'mcp', 'bridge.js')] }
}
