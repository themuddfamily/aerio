import { app, ipcMain, net, safeStorage, session } from 'electron'
import { join } from 'node:path'
import { NetworkProxyStore, type ProxyRuntimeConfig } from './network-proxy-store'
import { installNodeProxy, manualProxyActive } from './network-proxy-runtime'
import type { NetworkProxyInput } from '../src/network-proxy-types'

// Chromium net.fetch has no login callback. Its manual-proxy requests use
// the configured Node transport; BrowserWindow requests use app's login event.
export const fetchWithNetworkProxy: typeof fetch = (input, init) => manualProxyActive() ? globalThis.fetch(input, init) : net.fetch(input instanceof URL ? input.toString() : input, init)

export function chromiumProxySettings(config: ProxyRuntimeConfig): Electron.ProxyConfig {
  if (config.mode !== 'manual') return { mode: config.mode === 'system' ? 'system' : 'direct' }
  return { mode: 'fixed_servers', proxyRules: config.server, proxyBypassRules: ['localhost', '127.0.0.1', '[::1]', '127.*', ...config.bypass.split(',').filter(Boolean)].join(',') }
}
export function proxyChallengeCredentials(config: ProxyRuntimeConfig, challenge: { isProxy: boolean; host: string; port: number }) {
  if (config.mode !== 'manual' || !config.credentials || !challenge.isProxy) return undefined
  const proxy = new URL(config.server)
  const host = (value: string) => value.toLowerCase().replace(/^\[|\]$/g, '')
  return host(proxy.hostname) === host(challenge.host) && Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80)) === challenge.port ? config.credentials : undefined
}

/** Each profile loads before its windows, providers or mail worker start networking. */
export async function initializeNetworkProxy(locked: () => boolean) {
  const store = new NetworkProxyStore(join(app.getPath('userData'), 'network-proxy.json'), safeStorage)
  const runtime = store.runtime()
  installNodeProxy(runtime)
  const browserSettings = chromiumProxySettings(runtime)
  app.on('login', (event, _webContents, details, challenge, callback) => {
    const credentials = proxyChallengeCredentials(runtime, challenge)
    if (!credentials) return
    event.preventDefault()
    if (details.firstAuthAttempt === false) return callback()
    callback(credentials.username, credentials.password)
  })
  app.on('session-created', (created) => {
    void created.setProxy(browserSettings).catch(() => {
      // A session that cannot honor the configured route must not fall back direct.
      created.webRequest.onBeforeRequest((_details, callback) => callback({ cancel: true }))
    })
  })
  await session.defaultSession.setProxy(browserSettings)
  ipcMain.handle('network-proxy:status', () => store.status())
  ipcMain.handle('network-proxy:configure', (_event, input: NetworkProxyInput) => {
    if (locked()) throw new Error('Unlock Aerio before changing proxy settings')
    return store.configure(input)
  })
  return runtime
}
