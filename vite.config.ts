import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: '.',
  base: './',
  plugins: [react()],
  build: {
    target: 'chrome150',
    outDir: 'dist',
    rolldownOptions: {
      input: 'index.html'
    }
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.{ts,tsx}', 'electron/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.d.ts'],
      clean: true
    }
  }
})
