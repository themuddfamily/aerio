import { resolve } from 'node:path'
import { defineConfig } from 'vite'

const root = import.meta.dirname

// The isolated Matrix chat service (electron/chat/service). It runs in a hidden,
// sandboxed webContents served from the aerio-chat-service:// scheme, so it is
// built as its own page with the SDK and its Rust crypto WASM bundled locally.
export default defineConfig({
  root: resolve(root, 'electron/chat/service'),
  base: './',
  publicDir: false,
  build: {
    target: 'chrome150',
    outDir: resolve(root, 'dist-electron/chat-service'),
    emptyOutDir: true,
    assetsInlineLimit: 0,
    rolldownOptions: {
      input: resolve(root, 'electron/chat/service/index.html')
    }
  }
})
