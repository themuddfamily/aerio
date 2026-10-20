import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NetworkProxyStore, validateProxySettings, type ProxyStorage } from './network-proxy-store'

const directories: string[] = []
afterEach(() => { directories.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })) })
function fixture(secure = true) {
  const directory = mkdtempSync(join(tmpdir(), 'aerio-proxy-store-'))
  directories.push(directory)
  const storage: ProxyStorage = {
    isEncryptionAvailable: () => secure, getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: vi.fn((value: string) => Buffer.from(Buffer.from(value).map((byte) => byte ^ 0xaa))),
    decryptString: vi.fn((value: Buffer) => Buffer.from(value.map((byte) => byte ^ 0xaa)).toString())
  }
  const path = join(directory, 'network-proxy.json')
  return { path, storage, store: new NetworkProxyStore(path, storage) }
}
const settings = { mode: 'manual' as const, server: 'http://proxy.example.test:8080', bypass: 'INTRANET.test, *.internal.test' }

describe('proxy settings and credential storage', () => {
  it('encrypts both credentials, returns no secrets, persists across restart, and clears on endpoint change', () => {
    const { path, store, storage } = fixture()
    const status = store.configure({ ...settings, username: 'proxy-user', password: 'proxy-secret' })
    expect(status).toMatchObject({ hasCredentials: true, bypass: 'intranet.test,*.internal.test', restartRequired: true })
    expect(status).not.toHaveProperty('username')
    expect(status).not.toHaveProperty('password')
    const saved = readFileSync(path, 'utf8')
    expect(saved).not.toContain('proxy-user')
    expect(saved).not.toContain('proxy-secret')
    expect(storage.encryptString).toHaveBeenCalledOnce()
    const reloaded = new NetworkProxyStore(path, storage)
    expect(reloaded.runtime().credentials).toEqual({ username: 'proxy-user', password: 'proxy-secret' })
    expect(reloaded.status().restartRequired).toBe(false)
    expect(reloaded.configure(settings).hasCredentials).toBe(true)
    expect(reloaded.configure({ ...settings, server: 'https://different.test:444' }).hasCredentials).toBe(false)
  })
  it('refuses insecure storage for credentials, permits unauthenticated proxies, and clears explicitly', () => {
    const insecure = fixture(false)
    expect(() => insecure.store.configure({ ...settings, username: 'u', password: 'p' })).toThrow('OS encryption')
    expect(insecure.store.configure(settings).hasCredentials).toBe(false)
    const { store } = fixture()
    store.configure({ ...settings, username: 'u', password: 'p' })
    expect(store.configure({ ...settings, clearCredentials: true }).hasCredentials).toBe(false)
  })
  it('rejects embedded credentials, unsupported protocols, paths and ambiguous bypass syntax', () => {
    for (const server of ['socks5://proxy.test:1080', 'http://user:pass@proxy.test', 'http://proxy.test/path', 'http://proxy.test/?secret=1', 'not a url']) expect(() => validateProxySettings({ ...settings, server })).toThrow()
    for (const bypass of ['*', 'http://intranet.test', '10.0.0.0/8', 'internal.test;evil.test']) expect(() => validateProxySettings({ ...settings, bypass })).toThrow('Bypass')
  })
  it('fails closed on malformed settings and unavailable saved credentials', () => {
    const { path, storage, store } = fixture()
    store.configure({ ...settings, username: 'u', password: 'p' })
    expect(() => new NetworkProxyStore(path, { ...storage, decryptString: () => { throw new Error('secret storage unavailable') } }).runtime()).toThrow('No direct fallback')
    writeFileSync(path, '{not json')
    expect(() => new NetworkProxyStore(path, storage)).toThrow('no direct fallback')
  })
})
