import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsSyncService } from './settings-sync'
import { validateSettingsSyncBundle } from './settings-sync-data'
import { portablePreferences } from '../src/lib/settings-sync-preferences'
import { defaultSettings } from '../src/preferences'
import type { SettingsSyncBundle } from '../src/settings-sync-types'
import type { SettingsSyncRemote } from './settings-sync-webdav'
const roots: string[] = [], services: SettingsSyncService[] = []
const secret = 'test shared encryption passphrase'
const storage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret', encryptString: (value: string) => Buffer.from(value.split('').reverse().join('')), decryptString: (value: Buffer) => value.toString().split('').reverse().join('') }
function bundle(theme: 'light' | 'dark' = 'light'): SettingsSyncBundle { return { format: 'aerio-settings-sync', version: 1, preferences: portablePreferences({ ...defaultSettings, theme }), signatures: { definitions: [], accounts: [], assignments: [] }, templates: { format: 'aerio-mail-templates', schemaVersion: 1, exportedAt: new Date().toISOString(), templates: [], attachments: [] } } }
function remote() {
  let file: { text: string; etag: string } | undefined, revision = 0
  const api: SettingsSyncRemote = {
    get: vi.fn(async () => file),
    put: vi.fn(async (text, etag) => { if (file ? etag !== file.etag : etag !== undefined) throw new Error('ETag conflict'); file = { text, etag: `"${++revision}"` }; return file.etag })
  }
  return { api, restore: (saved: typeof file) => { file = saved }, remove: () => { file = undefined }, file: () => file }
}
function device(remote: SettingsSyncRemote, name: string, locked: () => boolean = () => false) {
  const root = mkdtempSync(join(tmpdir(), 'aerio-sync-unit-')); roots.push(root)
  let current = bundle()
  const apply = vi.fn(async (next: SettingsSyncBundle) => { current = structuredClone(next); return structuredClone(current) })
  const service = new SettingsSyncService({ directory: root, storage, locked, remote: () => remote, adapter: { capture: async () => structuredClone(current), validate: validateSettingsSyncBundle, apply } }); services.push(service)
  service.configure({ enabled: true, url: 'https://example.com/settings.enc.json', username: 'user', password: 'app-password-secret', passphrase: secret, deviceName: name, intervalMinutes: 5 })
  return { service, apply, root, get: () => current, change: (next: SettingsSyncBundle) => { current = next } }
}
afterEach(() => { for (const service of services.splice(0)) service.close(); vi.useRealTimers(); for (const root of roots.splice(0)) { expect(relative(tmpdir(), root)).toMatch(/^aerio-sync-unit-[^\\/]+$/); rmSync(root, { recursive: true, force: true }) } })
describe('settings sync across devices', () => {
  it('publishes encrypted data, reviews initial downloads, and synchronizes single-sided changes both ways', async () => {
    const server = remote(), a = device(server.api, 'Desktop'), b = device(server.api, 'Laptop')
    a.change(bundle('dark'))
    expect((await a.service.sync()).phase).toBe('idle')
    expect(server.file()?.text).not.toContain('theme')
    expect((await b.service.sync()).phase).toBe('review')
    expect((await b.service.sync('remote')).phase).toBe('idle')
    expect(b.get().preferences.theme).toBe('dark')
    b.change({ ...b.get(), preferences: { ...b.get().preferences, density: 'compact' } })
    await b.service.sync(); await a.service.sync()
    expect(a.get().preferences.density).toBe('compact')
    expect(JSON.stringify(a.service.status())).not.toContain('app-password-secret')
    expect(readFileSync(join(a.root, 'settings-sync-state.json'), 'utf8')).not.toContain(secret)
  })
  it('requires explicit conflict review and rejects choices after either reviewed version changes', async () => {
    const server = remote(), a = device(server.api, 'Desktop'), b = device(server.api, 'Laptop')
    await a.service.sync(); await b.service.sync()
    a.change(bundle('dark')); await a.service.sync()
    b.change({ ...b.get(), preferences: { ...b.get().preferences, density: 'compact' } })
    expect((await b.service.sync()).phase).toBe('review')
    b.change({ ...b.get(), preferences: { ...b.get().preferences, notifications: false } })
    const stale = await b.service.sync('remote')
    expect(stale.phase).toBe('review'); expect(stale.message).toContain('changed after review')
    await b.service.sync('remote')
    expect(b.get().preferences.theme).toBe('dark'); expect(b.get().preferences.density).toBe('comfortable')
  })
  it('requires review before replaying an older encrypted revision', async () => {
    const server = remote(), a = device(server.api, 'Desktop')
    await a.service.sync(); const old = server.file()
    a.change(bundle('dark')); await a.service.sync()
    server.restore(old)
    expect((await a.service.sync()).phase).toBe('review')
    expect(a.service.status().message).toContain('older revision')
    expect(a.get().preferences.theme).toBe('dark')
  })
  it('does not recreate deleted shared data or lose credentials on disconnect', async () => {
    const server = remote(), a = device(server.api, 'Desktop')
    await a.service.sync(); server.remove()
    expect((await a.service.sync()).phase).toBe('review')
    expect(server.file()).toBeUndefined()
    expect(a.service.disconnect()).toMatchObject({ configured: false, enabled: false, phase: 'disabled' })
    expect(server.file()).toBeUndefined()
  })
  it('does not blindly compensate partial imports over concurrent edits', async () => {
    const server = remote(), a = device(server.api, 'Desktop'), b = device(server.api, 'Laptop')
    a.change(bundle('dark')); await a.service.sync(); await b.service.sync()
    b.apply.mockImplementationOnce(async (next) => { b.change({ ...next, preferences: { ...next.preferences, density: 'compact' } }); throw new Error('template commit failed') })
    await expect(b.service.sync('remote')).rejects.toThrow('template commit failed')
    expect(b.get().preferences).toMatchObject({ theme: 'dark', density: 'compact' })
    expect(b.service.status().phase).toBe('error')
    expect(b.service.status().recoveryPending).toBe(true)
    expect(b.apply).toHaveBeenCalledTimes(1)
  })
  it('reviews fresh local edits made while a remote request is pending instead of replacing them', async () => {
    const server = remote(), a = device(server.api, 'Desktop'), b = device(server.api, 'Laptop')
    a.change(bundle('dark')); await a.service.sync()
    let release!: () => void, started!: () => void
    const waiting = new Promise<void>((resolve) => { release = resolve }), requested = new Promise<void>((resolve) => { started = resolve })
    vi.mocked(server.api.get).mockImplementationOnce(async () => { started(); await waiting; return server.file() })
    const pending = b.service.sync(); await requested
    b.change({ ...b.get(), preferences: { ...b.get().preferences, density: 'compact' } })
    release()
    const result = await pending
    expect(result.phase).toBe('review'); expect(result.message).toContain('changed during synchronization')
    expect(b.get().preferences.density).toBe('compact'); expect(b.apply).not.toHaveBeenCalled()
    expect(server.api.put).toHaveBeenCalledTimes(1)
  })
  it('does not publish a stale captured snapshot after edits during an initial remote request', async () => {
    const server = remote(), a = device(server.api, 'Desktop')
    let release!: () => void, started!: () => void
    const waiting = new Promise<void>((resolve) => { release = resolve }), requested = new Promise<void>((resolve) => { started = resolve })
    vi.mocked(server.api.get).mockImplementationOnce(async () => { started(); await waiting; return undefined })
    const pending = a.service.sync(); await requested
    a.change(bundle('dark')); release()
    expect((await pending).phase).toBe('review')
    expect(server.api.put).not.toHaveBeenCalled()
  })
  it.each(['lock', 'close'] as const)('does not import or upload after %s during a remote request', async (action) => {
    let locked = false
    const server = remote(), a = device(server.api, 'Desktop'), b = device(server.api, 'Laptop', () => locked)
    a.change(bundle('dark')); await a.service.sync()
    let release!: () => void, started!: () => void
    const waiting = new Promise<void>((resolve) => { release = resolve }), requested = new Promise<void>((resolve) => { started = resolve })
    vi.mocked(server.api.get).mockImplementationOnce(async () => { started(); await waiting; return server.file() })
    const pending = b.service.sync(); await requested
    if (action === 'lock') locked = true; else b.service.close()
    release()
    await expect(pending).rejects.toThrow(action === 'lock' ? /Unlock/ : /stopped/)
    expect(b.apply).not.toHaveBeenCalled(); expect(server.api.put).toHaveBeenCalledTimes(1)
  })
  it('reviews interrupted imports and preserves edits until an explicit choice', async () => {
    const server = remote(), a = device(server.api, 'Desktop'), b = device(server.api, 'Laptop')
    a.change(bundle('dark')); await a.service.sync(); await b.service.sync()
    b.apply.mockImplementationOnce(async (next) => { b.change(next); throw new Error('import interrupted') })
    await expect(b.service.sync('remote')).rejects.toThrow('import interrupted')
    expect(b.service.status().recoveryPending).toBe(true)
    b.change({ ...b.get(), preferences: { ...b.get().preferences, density: 'compact' } })
    expect((await b.service.sync()).phase).toBe('review')
    expect(b.service.status().recoveryPending).toBe(true)
    expect(b.get().preferences).toMatchObject({ theme: 'dark', density: 'compact' })
    expect(b.apply).toHaveBeenCalledTimes(1)
    expect((await b.service.sync('local')).phase).toBe('idle')
    expect(b.service.status().recoveryPending).toBe(false)
  })
  it('keeps edits after the exact imported baseline detectable by the next synchronization', async () => {
    const server = remote(), a = device(server.api, 'Desktop'), b = device(server.api, 'Laptop')
    a.change(bundle('dark')); await a.service.sync(); await b.service.sync()
    b.apply.mockImplementationOnce(async (next) => {
      const baseline = structuredClone(next)
      b.change({ ...next, preferences: { ...next.preferences, density: 'compact' } })
      return baseline
    })
    await b.service.sync('remote')
    await b.service.sync()
    await a.service.sync()
    expect(a.get().preferences.density).toBe('compact')
  })
  it('does not access remote settings while the application is locked', async () => {
    let locked = false
    const server = remote(), a = device(server.api, 'Desktop', () => locked)
    locked = true
    await expect(a.service.sync()).rejects.toThrow(/Unlock/)
    expect(server.api.get).not.toHaveBeenCalled()
  })
  it('runs enabled scheduled synchronization and stops after disconnect', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const server = remote(), a = device(server.api, 'Desktop')
    a.service.start(); await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(() => expect(a.service.status().lastSyncedAt).toBeTruthy())
    expect(server.file()).toBeDefined()
    a.service.disconnect(); const calls = vi.mocked(server.api.get).mock.calls.length
    await vi.advanceTimersByTimeAsync(600_000)
    expect(vi.mocked(server.api.get).mock.calls).toHaveLength(calls)
  })
})
