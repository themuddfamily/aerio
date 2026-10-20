import * as http from 'node:http'
import type { ProxyEnv } from 'node:http'
import type { ProxyRuntimeConfig } from './network-proxy-store'

let active: ProxyRuntimeConfig = { mode: 'system', server: '', bypass: '' }
export const manualProxyActive = () => active.mode === 'manual'
const loopback = ['localhost', '127.0.0.1', '::1', '[::1]']
export function proxyBypassed(host: string, config = active) {
  const name = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (loopback.includes(name) || /^127\./.test(name)) return true
  return config.bypass.split(',').filter(Boolean).some((pattern) => pattern.startsWith('*.') ? name.endsWith(pattern.slice(1)) : name === pattern)
}
export function proxyUrlForHost(host: string) {
  if (active.mode !== 'manual' || proxyBypassed(host)) return undefined
  const url = new URL(active.server)
  if (active.credentials) { url.username = active.credentials.username; url.password = active.credentials.password }
  return url.toString()
}
export function proxyEnvironment(config = active): ProxyEnv {
  if (config.mode === 'system') return { ...process.env }
  if (config.mode === 'direct') return {}
  const url = new URL(config.server)
  if (config.credentials) { url.username = config.credentials.username; url.password = config.credentials.password }
  return { HTTP_PROXY: url.toString(), HTTPS_PROXY: url.toString(), NO_PROXY: [...loopback, '127.*', ...config.bypass.split(',').filter(Boolean)].join(',') }
}
/** Called before networking in main and worker. Does not modify process.env. */
export function installNodeProxy(config: ProxyRuntimeConfig) {
  if (typeof http.setGlobalProxyFromEnv !== 'function') throw new Error('Network proxy support requires Node 24.14 or newer. No direct fallback was used.')
  const previous = active
  active = config
  let restore: () => void
  try { restore = http.setGlobalProxyFromEnv(proxyEnvironment(config)) } catch { active = previous; throw new Error('The proxy could not be configured. No direct fallback was used.') }
  return () => { restore(); active = previous }
}
