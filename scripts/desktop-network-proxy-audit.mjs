import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

if (!process.versions.electron) {
  const { default: binary } = await import('electron')
  const directory = mkdtempSync(join(tmpdir(), 'aerio-proxy-native-'))
  const env = { ...process.env, AERIO_PROXY_AUDIT_DIRECTORY: directory }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(binary, [fileURLToPath(import.meta.url)], { windowsHide: true, env, stdio: 'inherit' })
  const timeout = setTimeout(() => child.kill(), 30_000)
  child.once('exit', (code) => { clearTimeout(timeout); process.exitCode = code ?? 1; try { rmSync(directory, { recursive: true, force: true }) } catch { /* Windows may briefly retain session files. */ } })
} else {
  const { app, BrowserWindow } = await import('electron')
  const { tsImport } = await import('tsx/esm/api')
  const directory = process.env.AERIO_PROXY_AUDIT_DIRECTORY
  if (!directory) throw new Error('Run this audit with Node so it can create an isolated profile')
  mkdirSync(join(directory, 'sessions'))
  app.setPath('userData', directory)
  app.setPath('sessionData', join(directory, 'sessions'))
  let proxy
  let window
  void app.whenReady().then(async () => { try {
    const { NetworkProxyStore } = await tsImport('../electron/network-proxy-store.ts', import.meta.url)
    const { fetchWithNetworkProxy, initializeNetworkProxy } = await tsImport('../electron/network-proxy.ts', import.meta.url)
    const { safeStorage } = await import('electron')
    let authorizedRequests = 0
    proxy = createServer((request, response) => {
      if (request.headers['proxy-authorization'] !== `Basic ${Buffer.from('fixture-user:fixture-password').toString('base64')}`) {
        response.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="Aerio proxy audit"' }); response.end(); return
      }
      authorizedRequests += 1
      response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><title>Proxy audit</title><p>Authenticated proxy reached</p>')
    })
    proxy.on('connect', (request, socket) => {
      if (request.headers['proxy-authorization'] !== `Basic ${Buffer.from('fixture-user:fixture-password').toString('base64')}`) { socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return }
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      socket.once('data', () => {
        authorizedRequests += 1
        const body = '<!doctype html><title>Proxy audit</title><p>Authenticated proxy reached</p>'
        socket.end(`HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`)
      })
    })
    await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    const port = proxy.address().port
    const store = new NetworkProxyStore(join(directory, 'network-proxy.json'), safeStorage)
    store.configure({ mode: 'manual', server: `http://127.0.0.1:${port}`, bypass: '', username: 'fixture-user', password: 'fixture-password' })
    await initializeNetworkProxy(() => false)
    console.log('Proxy audit: main transport')
    const response = await fetchWithNetworkProxy('http://proxy-fixture.invalid/net-fetch', { signal: AbortSignal.timeout(5000) })
    assert.equal(response.status, 200)
    assert.match(await response.text(), /Authenticated proxy reached/)
    console.log('Proxy audit: browser session')
    window = new BrowserWindow({ show: false, webPreferences: { partition: 'proxy-audit-new-session', contextIsolation: true, nodeIntegration: false } })
    await window.loadURL('http://proxy-fixture.invalid/browser')
    assert.equal(await window.webContents.executeJavaScript('document.title'), 'Proxy audit')
    assert.ok(authorizedRequests >= 2)
    console.log(JSON.stringify({ audit: 'network-proxy', passed: true, authenticatedRequests: authorizedRequests, node: process.versions.node }))
    app.exit(0)
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Proxy audit failed')
    app.exit(1)
  } finally {
    window?.destroy()
    proxy?.closeAllConnections(); proxy?.close()
    // The OS releases session files on exit; cleanup is performed by the launcher below.
  } })
}
