import { app } from 'electron'
import electronUpdater from 'electron-updater'
import type { AppUpdateStatus } from '../src/types'
import { updateSupport } from './update-policy'

const { autoUpdater } = electronUpdater

export class UpdateManager {
  private state: AppUpdateStatus
  private startupTimer?: NodeJS.Timeout

  constructor(
    private readonly broadcast: (status: AppUpdateStatus) => void,
    private readonly log: (event: string, message?: string, details?: Record<string, unknown>) => void
  ) {
    const support = updateSupport({ packaged: app.isPackaged, platform: process.platform, portable: Boolean(process.env.PORTABLE_EXECUTABLE_FILE) })
    this.state = support.supported
      ? { phase: 'idle', currentVersion: app.getVersion(), message: 'Aerio checks GitHub Releases for signed updates.' }
      : { phase: 'unsupported', currentVersion: app.getVersion(), message: support.reason }
    if (!support.supported) return

    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.allowPrerelease = app.getVersion().includes('-')
    autoUpdater.on('checking-for-update', () => this.set({ phase: 'checking', message: 'Checking for updates…' }))
    autoUpdater.on('update-available', (info) => this.set({ phase: 'available', availableVersion: info.version, message: `Aerio ${info.version} is available.` }))
    autoUpdater.on('update-not-available', () => this.set({ phase: 'current', availableVersion: undefined, progress: undefined, checkedAt: new Date().toISOString(), message: 'Aerio is up to date.' }))
    autoUpdater.on('download-progress', (progress) => this.set({ phase: 'downloading', progress: Math.max(0, Math.min(100, progress.percent)), message: `Downloading update… ${Math.round(progress.percent)}%` }))
    autoUpdater.on('update-downloaded', (info) => this.set({ phase: 'ready', availableVersion: info.version, progress: 100, message: `Aerio ${info.version} is ready to install.` }))
    autoUpdater.on('error', (error) => this.set({ phase: 'error', message: this.safeError(error) }))
  }

  start() {
    if (this.state.phase === 'unsupported') return
    this.startupTimer = setTimeout(() => void this.check(false), 15_000)
  }

  stop() {
    if (this.startupTimer) clearTimeout(this.startupTimer)
  }

  status() {
    return { ...this.state }
  }

  async check(manual = true) {
    this.requireSupported()
    try {
      await autoUpdater.checkForUpdates()
    } catch (error) {
      this.set({ phase: 'error', message: this.safeError(error) })
      if (manual) throw new Error(this.state.message)
    }
    return this.status()
  }

  async download() {
    this.requireSupported()
    if (this.state.phase !== 'available') throw new Error('No update is ready to download')
    this.set({ phase: 'downloading', progress: 0, message: 'Starting update download…' })
    try {
      await autoUpdater.downloadUpdate()
    } catch (error) {
      this.set({ phase: 'error', message: this.safeError(error) })
      throw new Error(this.state.message)
    }
    return this.status()
  }

  install() {
    this.requireSupported()
    if (this.state.phase !== 'ready') throw new Error('The update has not finished downloading')
    this.log('update-installing', undefined, { version: this.state.availableVersion })
    autoUpdater.quitAndInstall(false, true)
  }

  private requireSupported() {
    if (this.state.phase === 'unsupported') throw new Error(this.state.message ?? 'Automatic updates are unavailable')
  }

  private set(update: Partial<AppUpdateStatus> & Pick<AppUpdateStatus, 'phase'>) {
    this.state = { ...this.state, ...update, currentVersion: app.getVersion() }
    this.log(`update-${this.state.phase}`, this.state.phase === 'error' ? this.state.message : undefined, {
      currentVersion: this.state.currentVersion,
      availableVersion: this.state.availableVersion,
      progress: this.state.progress
    })
    this.broadcast(this.status())
  }

  private safeError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return `Update check failed: ${message.replace(/https?:\/\/\S+/g, '[update server]').slice(0, 500)}`
  }
}
