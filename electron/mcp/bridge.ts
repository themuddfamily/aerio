/**
 * Standalone stdio MCP bridge for Aerio (E48), built to dist-electron/mcp/bridge.js
 * by vite.mcp-bridge.config.ts. Run it with Node 24+, or start the Aerio
 * executable with `--mcp`, which runs the same bridge.
 *
 *   AERIO_MCP_TOKEN=<token from Settings> AERIO_MCP_ENDPOINT=<endpoint> node bridge.js
 *
 * `--endpoint=<path>` overrides AERIO_MCP_ENDPOINT. The token is read only from
 * the environment so it never appears in process listings.
 */
import { bridgeEndpoint } from './bridge-mode'
import { runMcpBridge } from './bridge-runtime'

const endpoint = bridgeEndpoint(process.argv.slice(2), process.env)
if (!endpoint) {
  process.stderr.write('[aerio-mcp] Set AERIO_MCP_ENDPOINT (shown in Aerio Settings › External automation (MCP)) or pass --endpoint=<path>.\n')
  process.exitCode = 2
} else {
  void runMcpBridge({
    input: process.stdin,
    output: process.stdout,
    log: (line) => process.stderr.write(`${line}\n`),
    endpoint,
    token: process.env.AERIO_MCP_TOKEN ?? '',
    version: process.env.AERIO_BRIDGE_VERSION ?? '0.0.0'
  }).then(() => process.exit(0))
}
