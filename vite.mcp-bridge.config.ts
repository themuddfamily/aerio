import { readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

const root = import.meta.dirname
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string }

// The standalone stdio MCP bridge (electron/mcp/bridge.ts). It runs under plain
// Node with no Electron or npm dependencies, so everything except Node
// built-ins is bundled into one file. `Aerio --mcp` runs the same code.
export default defineConfig({
  define: {
    'process.env.AERIO_BRIDGE_VERSION': JSON.stringify(packageJson.version)
  },
  build: {
    target: 'node24',
    outDir: 'dist-electron/mcp',
    emptyOutDir: true,
    minify: false,
    lib: {
      entry: { bridge: resolve(root, 'electron/mcp/bridge.ts') },
      formats: ['es']
    },
    rolldownOptions: {
      external: [...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
      output: { entryFileNames: '[name].js' }
    }
  }
})
