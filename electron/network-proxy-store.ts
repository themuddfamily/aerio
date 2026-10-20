import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { NetworkProxyInput, NetworkProxySettings, NetworkProxyStatus } from '../src/network-proxy-types'
import { assertSecureCredentialStorage } from './mail/secure-storage'

export interface ProxyStorage {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend(): string
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}
/** Internal configuration, sent only from main to its trusted mail worker. */
export interface ProxyRuntimeConfig extends NetworkProxySettings { credentials?: { username: string; password: string } }
const defaults = (): NetworkProxySettings => ({ mode: 'system', server: '', bypass: '' })

export function validateProxySettings(input: NetworkProxySettings): NetworkProxySettings {
  if (!input || !['system', 'direct', 'manual'].includes(input.mode)) throw new Error('Choose system, direct, or a manual HTTP(S) proxy')
  if (typeof input.server !== 'string' || input.server.length > 2000 || typeof input.bypass !== 'string' || input.bypass.length > 2000) throw new Error('Enter a valid proxy server and bypass list')
  let server = ''
  if (input.mode === 'manual') {
    let url: URL
    try { url = new URL(input.server.trim()) } catch { throw new Error('Enter the proxy as http://host:port or https://host:port') }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Use an HTTP(S) proxy origin; enter credentials in the separate fields')
    server = url.origin
  }
  const hosts = input.bypass.split(',').map((host) => host.trim().toLowerCase()).filter(Boolean)
  if (hosts.length > 100 || hosts.some((host) => !/^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(host))) throw new Error('Bypass entries must be comma-separated hostnames, IPv4 addresses, or *.domain patterns')
  return { mode: input.mode, server, bypass: [...new Set(hosts)].join(',') }
}

export class NetworkProxyStore {
  private settings: NetworkProxySettings = defaults()
  private encryptedCredentials?: string
  private readonly initial: string
  constructor(private readonly path: string, private readonly storage: ProxyStorage) {
    if (existsSync(path)) {
      try {
        const value = JSON.parse(readFileSync(path, 'utf8'))
        this.settings = validateProxySettings(value.settings)
        if (value.encryptedCredentials !== undefined && (typeof value.encryptedCredentials !== 'string' || value.encryptedCredentials.length > 32_000 || !/^[A-Za-z0-9+/]+=*$/.test(value.encryptedCredentials))) throw new Error('Invalid encrypted proxy credentials')
        this.encryptedCredentials = value.encryptedCredentials
      } catch { throw new Error('Proxy settings could not be read. Repair or remove network-proxy.json before starting Aerio; no direct fallback was used.') }
    }
    this.initial = this.fingerprint()
  }
  private fingerprint() { return JSON.stringify({ settings: this.settings, credentials: this.encryptedCredentials }) }
  private secure() { try { assertSecureCredentialStorage(this.storage); return true } catch { return false } }
  status(): NetworkProxyStatus { return { ...this.settings, hasCredentials: Boolean(this.encryptedCredentials), secureStorage: this.secure(), restartRequired: this.initial !== this.fingerprint() } }
  runtime(): ProxyRuntimeConfig {
    if (!this.encryptedCredentials || this.settings.mode !== 'manual') return { ...this.settings }
    try {
      assertSecureCredentialStorage(this.storage)
      const credentials = JSON.parse(this.storage.decryptString(Buffer.from(this.encryptedCredentials, 'base64')))
      if (typeof credentials.username !== 'string' || !credentials.username || typeof credentials.password !== 'string') throw new Error('Invalid credentials')
      return { ...this.settings, credentials: { username: credentials.username, password: credentials.password } }
    } catch { throw new Error('Saved proxy credentials cannot be decrypted with this operating-system account. No direct fallback was used.') }
  }
  configure(input: NetworkProxyInput) {
    const settings = validateProxySettings(input)
    let encrypted = settings.mode === 'manual' && settings.server === this.settings.server && !input.clearCredentials ? this.encryptedCredentials : undefined
    const username = input.username ?? ''
    const password = input.password ?? ''
    if (typeof username !== 'string' || typeof password !== 'string' || username.length > 1000 || password.length > 4000 || /[\r\n\0]/.test(username + password)) throw new Error('Enter valid proxy credentials')
    if (input.clearCredentials && (username || password)) throw new Error('Choose either new credentials or removing the saved credentials')
    if (username || password) {
      if (settings.mode !== 'manual' || !username) throw new Error('Enter a username for the manual proxy credentials')
      assertSecureCredentialStorage(this.storage)
      encrypted = this.storage.encryptString(JSON.stringify({ username, password })).toString('base64')
    }
    const temporary = `${this.path}.partial`
    writeFileSync(temporary, JSON.stringify({ settings, ...(encrypted ? { encryptedCredentials: encrypted } : {}) }), { mode: 0o600 })
    renameSync(temporary, this.path)
    this.settings = settings
    this.encryptedCredentials = encrypted
    return this.status()
  }
}
