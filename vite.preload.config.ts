import { resolve } from 'node:path'
import { defineConfig } from 'vite'

const root = import.meta.dirname

export default defineConfig({
  build: {
    target: 'node24',
    outDir: 'dist-electron/preload',
    emptyOutDir: true,
    minify: false,
    lib: {
      entry: {
        preload: resolve(root, 'electron/preload.ts'),
        // Sandboxed preload for the hidden chat service webContents (electron/chat/service-host.ts).
        'chat-service-preload': resolve(root, 'electron/chat/service-preload.ts')
      },
      formats: ['cjs']
    },
    rolldownOptions: {
      external: ['electron'],
      output: {
        entryFileNames: '[name].cjs'
      }
    }
  }
})
