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
      entry: resolve(root, 'electron/preload.ts'),
      formats: ['cjs']
    },
    rolldownOptions: {
      external: ['electron'],
      output: {
        entryFileNames: 'preload.cjs'
      }
    }
  }
})
