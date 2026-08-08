import { spawn } from 'node:child_process'
import { existsSync, statSync, watch } from 'node:fs'
import { resolve } from 'node:path'
import electronPath from 'electron'
import { createServer } from 'vite'

const root = resolve(import.meta.dirname, '..')
const viteCli = resolve(root, 'node_modules', 'vite', 'bin', 'vite.js')
const outputs = [
  resolve(root, 'dist-electron', 'main', 'main.js'),
  resolve(root, 'dist-electron', 'preload', 'preload.cjs')
]
const startedAt = Date.now()
const children = []
let electronProcess
let restarting = false
let restartTimer
let stopping = false

function spawnBuild(config) {
  const child = spawn(process.execPath, [viteCli, 'build', '--config', config, '--mode', 'development', '--watch'], {
    cwd: root,
    env: process.env,
    stdio: 'inherit'
  })
  children.push(child)
  return child
}

function waitForInitialBuild() {
  return new Promise((resolveReady, reject) => {
    const deadline = Date.now() + 60_000
    const check = () => {
      if (outputs.every((file) => existsSync(file) && statSync(file).mtimeMs >= startedAt - 1_000)) return resolveReady()
      if (Date.now() >= deadline) return reject(new Error('Timed out waiting for the Electron main and preload builds'))
      setTimeout(check, 100)
    }
    check()
  })
}

function launchElectron(rendererUrl) {
  electronProcess = spawn(electronPath, ['.', ...process.argv.slice(2)], {
    cwd: root,
    env: { ...process.env, ELECTRON_RENDERER_URL: rendererUrl },
    stdio: 'inherit'
  })
  electronProcess.once('exit', (code) => {
    electronProcess = undefined
    if (restarting) {
      restarting = false
      launchElectron(rendererUrl)
    } else if (!stopping) {
      void stop(code ?? 0)
    }
  })
}

async function stop(code = 0) {
  if (stopping) return
  stopping = true
  clearTimeout(restartTimer)
  watcher?.close()
  electronProcess?.kill()
  for (const child of children) child.kill()
  await server.close()
  process.exitCode = code
}

spawnBuild('vite.main.config.ts')
spawnBuild('vite.preload.config.ts')
const server = await createServer({ configFile: resolve(root, 'vite.config.ts') })
await server.listen()
server.printUrls()
await waitForInitialBuild()
const rendererUrl = server.resolvedUrls?.local[0]
if (!rendererUrl) throw new Error('Vite did not expose a renderer URL')
launchElectron(rendererUrl)

const watcher = watch(resolve(root, 'dist-electron'), { recursive: true }, (_event, filename) => {
  if (!filename || (!filename.endsWith('.js') && !filename.endsWith('.cjs'))) return
  clearTimeout(restartTimer)
  restartTimer = setTimeout(() => {
    if (!electronProcess || restarting || stopping) return
    restarting = true
    electronProcess.kill()
  }, 200)
})

process.once('SIGINT', () => void stop())
process.once('SIGTERM', () => void stop())
