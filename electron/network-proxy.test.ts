import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), events: new Map<string, (...args: any[]) => any>(), directory: '', setProxy: vi.fn().mockResolvedValue(undefined) }))
vi.mock('electron', () => ({
  app: { getPath: () => mocks.directory, on: (event: string, callback: (...args: any[]) => any) => mocks.events.set(event, callback) },
  ipcMain: { handle: (channel: string, callback: (...args: any[]) => any) => mocks.handlers.set(channel, callback) },
  session: { defaultSession: { setProxy: mocks.setProxy } },
  safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret', encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() }
}))
vi.mock('./network-proxy-runtime', () => ({ installNodeProxy: vi.fn(), manualProxyActive: vi.fn(() => false) }))
import { chromiumProxySettings, initializeNetworkProxy, proxyChallengeCredentials } from './network-proxy'
import { installNodeProxy } from './network-proxy-runtime'
const config = { mode: 'manual' as const, server: 'https://proxy.test:8443', bypass: '*.internal.test', credentials: { username: 'user', password: 'secret' } }
beforeEach(() => { mocks.directory = mkdtempSync(join(tmpdir(), 'aerio-proxy-ipc-')); mocks.handlers.clear(); mocks.events.clear(); vi.clearAllMocks() })
afterEach(() => { if (mocks.directory.startsWith(join(tmpdir(), 'aerio-proxy-ipc-'))) rmSync(mocks.directory, { recursive: true, force: true }) })

describe('proxy browser integration and IPC', () => {
  it('authenticates only the exact proxy challenge, never an origin challenge', () => {
    expect(proxyChallengeCredentials(config, { isProxy: true, host: 'proxy.test', port: 8443 })).toEqual(config.credentials)
    for (const challenge of [{ isProxy: false, host: 'proxy.test', port: 8443 }, { isProxy: true, host: 'evil.test', port: 8443 }, { isProxy: true, host: 'proxy.test', port: 80 }]) expect(proxyChallengeCredentials(config, challenge)).toBeUndefined()
    expect(chromiumProxySettings(config)).toEqual({ mode: 'fixed_servers', proxyRules: 'https://proxy.test:8443', proxyBypassRules: 'localhost,127.0.0.1,[::1],127.*,*.internal.test' })
  })
  it('loads at startup, saves without a partial live switch, and configures default and new sessions after restart', async () => {
    let locked = false
    await initializeNetworkProxy(() => locked)
    expect(mocks.setProxy).toHaveBeenCalledWith({ mode: 'system' })
    const save = mocks.handlers.get('network-proxy:configure')!
    expect(save({}, { ...config, username: 'user', password: 'secret' })).toMatchObject({ restartRequired: true, hasCredentials: true })
    expect(mocks.setProxy).toHaveBeenCalledTimes(1)
    locked = true
    expect(() => save({}, config)).toThrow('Unlock')
    await initializeNetworkProxy(() => false)
    expect(installNodeProxy).toHaveBeenLastCalledWith(config)
    expect(mocks.setProxy).toHaveBeenLastCalledWith(chromiumProxySettings(config))
    const created = { setProxy: vi.fn().mockResolvedValue(undefined) }
    mocks.events.get('session-created')!(created)
    expect(created.setProxy).toHaveBeenCalledWith(chromiumProxySettings(config))
    const event = { preventDefault: vi.fn() }; const callback = vi.fn()
    mocks.events.get('login')!(event, {}, {}, { isProxy: true, host: 'proxy.test', port: 8443 }, callback)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledWith('user', 'secret')
    const rejected = vi.fn()
    mocks.events.get('login')!(event, {}, { firstAuthAttempt: false }, { isProxy: true, host: 'proxy.test', port: 8443 }, rejected)
    expect(rejected).toHaveBeenCalledWith()
    expect(mocks.handlers.get('network-proxy:status')!({})).not.toHaveProperty('credentials')
  })
})
