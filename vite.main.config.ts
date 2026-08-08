import { readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { resolve } from 'node:path'
import { defineConfig, loadEnv } from 'vite'

const root = import.meta.dirname
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
}
const external = [
  'electron',
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  ...Object.keys(packageJson.dependencies ?? {})
]
const mainEnvironmentNames = [
  'MAIN_VITE_GOOGLE_CLIENT_ID',
  'MAIN_VITE_GOOGLE_CLIENT_SECRET',
  'MAIN_VITE_MICROSOFT_CLIENT_ID'
]

export default defineConfig(({ mode }) => {
  const fileEnvironment = loadEnv(mode, root, 'MAIN_VITE_')
  const define = Object.fromEntries(mainEnvironmentNames.map((name) => [
    `import.meta.env.${name}`,
    JSON.stringify(process.env[name] ?? fileEnvironment[name] ?? '')
  ]))

  return {
    define,
    build: {
      target: 'node24',
      outDir: 'dist-electron/main',
      emptyOutDir: true,
      minify: false,
      lib: {
        entry: {
          main: resolve(root, 'electron/main.ts'),
          'mail-worker': resolve(root, 'electron/mail-worker.ts')
        },
        formats: ['es']
      },
      rolldownOptions: {
        external,
        output: {
          entryFileNames: '[name].js',
          chunkFileNames: '[name]-[hash].js'
        }
      }
    }
  }
})
