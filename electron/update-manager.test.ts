import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, Array<(value?: any) => void>>()
  const autoUpdater = {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    allowPrerelease: false,
    on: vi.fn((event: string, handler: (value?: any) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
      return autoUpdater
    }),
    checkForUpdates: vi.fn().mockResolvedValue(undefined),
    downloadUpdate: vi.fn().mockResolvedValue(undefined),
    quitAndInstall: vi.fn(),
    emit(event: string, value?: any) {
      for (const handler of handlers.get(event) ?? []) handler(value)
    }
  }
  return {
    app: { isPackaged: true, getVersion: vi.fn(() => '0.4.0-beta.1') },
    autoUpdater,
    handlers,
    updateSupport: vi.fn(() => ({ supported: true } as { supported: boolean; reason?: string }))
  }
})

vi.mock('electron', () => ({ app: mocks.app }))
vi.mock('electron-updater', () => ({ default: { autoUpdater: mocks.autoUpdater } }))
vi.mock('./update-policy', () => ({ updateSupport: mocks.updateSupport }))

import { UpdateManager } from './update-manager'

describe('UpdateManager', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    mocks.app.isPackaged = true
    mocks.app.getVersion.mockReturnValue('0.4.0-beta.1')
    mocks.updateSupport.mockReturnValue({ supported: true })
    mocks.autoUpdater.on.mockClear()
    mocks.autoUpdater.checkForUpdates.mockReset().mockResolvedValue(undefined)
    mocks.autoUpdater.downloadUpdate.mockReset().mockResolvedValue(undefined)
    mocks.autoUpdater.quitAndInstall.mockReset()
    mocks.autoUpdater.autoDownload = true
    mocks.autoUpdater.autoInstallOnAppQuit = false
    mocks.autoUpdater.allowPrerelease = false
  })

  afterEach(() => {
    vi.useRealTimers()
    delete process.env.PORTABLE_EXECUTABLE_FILE
  })

  function create() {
    const broadcast = vi.fn()
    const log = vi.fn()
    return { subject: new UpdateManager(broadcast, log), broadcast, log }
  }

  it('configures the updater and exposes an isolated initial status', () => {
    const { subject } = create()
    expect(mocks.updateSupport).toHaveBeenCalledWith({ packaged: true, platform: process.platform, portable: false })
    expect(mocks.autoUpdater.autoDownload).toBe(false)
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(true)
    expect(mocks.autoUpdater.allowPrerelease).toBe(true)
    expect(mocks.autoUpdater.on).toHaveBeenCalledTimes(6)
    const status = subject.status()
    expect(status).toEqual({ phase: 'idle', currentVersion: '0.4.0-beta.1', message: expect.stringContaining('GitHub Releases') })
    status.phase = 'error'
    expect(subject.status().phase).toBe('idle')
  })

  it('reports every updater lifecycle event with bounded progress', () => {
    const { subject, broadcast, log } = create()
    mocks.autoUpdater.emit('checking-for-update')
    expect(subject.status()).toMatchObject({ phase: 'checking' })

    mocks.autoUpdater.emit('update-available', { version: '0.5.0' })
    expect(subject.status()).toMatchObject({ phase: 'available', availableVersion: '0.5.0' })

    mocks.autoUpdater.emit('download-progress', { percent: 120.4 })
    expect(subject.status()).toMatchObject({ phase: 'downloading', progress: 100, message: 'Downloading update… 120%' })
    mocks.autoUpdater.emit('download-progress', { percent: -5 })
    expect(subject.status().progress).toBe(0)

    mocks.autoUpdater.emit('update-downloaded', { version: '0.5.0' })
    expect(subject.status()).toMatchObject({ phase: 'ready', availableVersion: '0.5.0', progress: 100 })

    mocks.autoUpdater.emit('update-not-available')
    expect(subject.status()).toMatchObject({ phase: 'current', availableVersion: undefined, progress: undefined, checkedAt: expect.any(String) })
    expect(broadcast).toHaveBeenCalledTimes(6)
    expect(log).toHaveBeenLastCalledWith('update-current', undefined, expect.objectContaining({ currentVersion: '0.4.0-beta.1' }))
  })

  it('sanitizes updater errors before logging and broadcasting them', () => {
    const { subject, broadcast, log } = create()
    mocks.autoUpdater.emit('error', new Error('GET https://updates.example.test/private-token failed'))
    expect(subject.status()).toMatchObject({ phase: 'error', message: 'Update check failed: GET [update server] failed' })
    expect(log).toHaveBeenCalledWith('update-error', 'Update check failed: GET [update server] failed', expect.any(Object))
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ phase: 'error' }))
  })

  it('checks manually and rethrows a safe failure', async () => {
    const { subject } = create()
    mocks.autoUpdater.checkForUpdates.mockRejectedValueOnce('offline')
    await expect(subject.check()).rejects.toThrow('Update check failed: offline')
    expect(subject.status()).toMatchObject({ phase: 'error', message: 'Update check failed: offline' })
  })

  it('keeps automatic check failures contained and returns status', async () => {
    const { subject } = create()
    mocks.autoUpdater.checkForUpdates.mockRejectedValueOnce(new Error('temporary'))
    await expect(subject.check(false)).resolves.toMatchObject({ phase: 'error', message: 'Update check failed: temporary' })
  })

  it('starts a delayed automatic check and can cancel it', async () => {
    vi.useFakeTimers()
    const first = create().subject
    first.start()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledOnce()

    mocks.autoUpdater.checkForUpdates.mockClear()
    const second = create().subject
    second.start()
    second.stop()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled()

    // Stopping before start is also safe.
    create().subject.stop()
  })

  it('downloads only an available update and reports failures', async () => {
    const { subject } = create()
    await expect(subject.download()).rejects.toThrow('No update is ready to download')
    mocks.autoUpdater.emit('update-available', { version: '0.5.0' })
    await expect(subject.download()).resolves.toMatchObject({ phase: 'downloading', progress: 0 })
    expect(mocks.autoUpdater.downloadUpdate).toHaveBeenCalledOnce()

    mocks.autoUpdater.emit('update-available', { version: '0.6.0' })
    mocks.autoUpdater.downloadUpdate.mockRejectedValueOnce(new Error('https://downloads.example.test failed'))
    await expect(subject.download()).rejects.toThrow('Update check failed: [update server] failed')
    expect(subject.status().phase).toBe('error')
  })

  it('installs only after a completed download', () => {
    const { subject, log } = create()
    expect(() => subject.install()).toThrow('has not finished downloading')
    mocks.autoUpdater.emit('update-downloaded', { version: '0.5.0' })
    subject.install()
    expect(log).toHaveBeenCalledWith('update-installing', undefined, { version: '0.5.0' })
    expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it('remains inert and rejects operations when updates are unsupported', async () => {
    mocks.updateSupport.mockReturnValue({ supported: false, reason: 'Portable builds cannot update.' })
    const { subject } = create()
    expect(subject.status()).toEqual({ phase: 'unsupported', currentVersion: '0.4.0-beta.1', message: 'Portable builds cannot update.' })
    expect(mocks.autoUpdater.on).not.toHaveBeenCalled()
    subject.start()
    await expect(subject.check()).rejects.toThrow('Portable builds cannot update.')
    await expect(subject.download()).rejects.toThrow('Portable builds cannot update.')
    expect(() => subject.install()).toThrow('Portable builds cannot update.')
  })

  it('uses a generic unsupported message when policy supplies no reason', async () => {
    mocks.updateSupport.mockReturnValue({ supported: false })
    await expect(create().subject.check()).rejects.toThrow('Automatic updates are unavailable')
  })
})
