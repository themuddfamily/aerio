import { BrowserWindow, dialog, ipcMain } from 'electron'
import { join, resolve } from 'node:path'
import type { ProfileBackupPreview, ProfileBackupStatus, ProfileBackupSummary } from '../src/profile-backup-types'
import {
  assertBackupDirectoryAllowed, createProfileBackup, dismissProfileRestoreOutcome, lastProfileRestoreOutcome, listProfileBackups, nextProfileBackupAt,
  previewProfileBackup, profileBackupDue, pruneProfileBackups, readProfileBackupState, stageProfileRestore, validateProfileBackupSchedule,
  writeProfileBackupState, type ProfileBackupLayout
} from './profile-backup'

const SCHEDULE_CHECK_MS = 15 * 60_000
const FIRST_CHECK_MS = 2 * 60_000

export interface ProfileBackupToolOptions {
  userData: string
  appVersion: string
  defaultDirectory: string
  layout: ProfileBackupLayout
  isLocked(): boolean
  /** Restarts Aerio so the staged restore is swapped in before any store opens. */
  relaunch(): void
  log(event: string, details?: Record<string, unknown>, error?: unknown): void
}

export function registerProfileBackup(options: ProfileBackupToolOptions) {
  const statePath = join(options.userData, 'profile-backup.json')
  const state = () => readProfileBackupState(statePath, options.defaultDirectory)
  // Only folders the user picked or that Aerio listed, and that passed preview, can be restored.
  const previewed = new Set<string>()
  let running: Promise<unknown> | undefined
  let restarting = false

  const exclusive = async <T>(work: () => Promise<T>): Promise<T> => {
    if (running) throw new Error('A profile backup or restore is already in progress')
    if (restarting) throw new Error('Aerio is restarting to finish a restore')
    const task = work()
    running = task
    try { return await task } finally { running = undefined }
  }
  const unlocked = () => { if (options.isLocked()) throw new Error('Unlock Aerio before managing profile backups') }

  const status = (): ProfileBackupStatus => {
    const current = state()
    return {
      schedule: current.schedule, running: Boolean(running), lastBackupAt: current.lastBackupAt, lastBackupPath: current.lastBackupPath, lastError: current.lastError,
      nextBackupAt: nextProfileBackupAt(current)?.toISOString(), backups: listProfileBackups(current.schedule.directory, options.layout),
      lastRestore: lastProfileRestoreOutcome(options.userData)
    }
  }

  const runBackup = (trigger: 'manual' | 'scheduled') => exclusive(async (): Promise<ProfileBackupSummary> => {
    const current = state()
    const attemptedAt = new Date().toISOString()
    try {
      const summary = await createProfileBackup({ userData: options.userData, directory: current.schedule.directory, layout: options.layout, appVersion: options.appVersion, trigger })
      const removed = pruneProfileBackups(current.schedule.directory, current.schedule.keep, options.layout)
      writeProfileBackupState(statePath, { ...state(), lastBackupAt: summary.createdAt, lastBackupPath: summary.path, lastAttemptAt: attemptedAt, lastError: undefined })
      options.log('profile-backup-created', { trigger, files: summary.fileCount, bytes: summary.totalBytes, pruned: removed.length })
      return summary
    } catch (error) {
      writeProfileBackupState(statePath, { ...state(), lastAttemptAt: attemptedAt, lastError: error instanceof Error ? error.message : String(error) })
      options.log('profile-backup-failed', { trigger }, error)
      throw error
    }
  })

  const tick = () => {
    if (running || restarting || !profileBackupDue(state())) return
    void runBackup('scheduled').catch(() => { /* Recorded in state and diagnostics; retried after an hour. */ })
  }
  const first = setTimeout(tick, FIRST_CHECK_MS)
  const interval = setInterval(tick, SCHEDULE_CHECK_MS)
  first.unref()
  interval.unref()

  ipcMain.handle('profile-backup:status', () => status())
  ipcMain.handle('profile-backup:schedule', (_event, value: unknown) => {
    unlocked()
    const schedule = validateProfileBackupSchedule(value)
    assertBackupDirectoryAllowed(schedule.directory, options.userData, options.layout)
    writeProfileBackupState(statePath, { ...state(), schedule })
    return status()
  })
  ipcMain.handle('profile-backup:choose-directory', async (event) => {
    unlocked()
    const owner = BrowserWindow.fromWebContents(event.sender)
    const dialogOptions: Electron.OpenDialogOptions = { title: 'Choose where to keep Aerio profile backups', defaultPath: state().schedule.directory, properties: ['openDirectory', 'createDirectory'] }
    const result = owner ? await dialog.showOpenDialog(owner, dialogOptions) : await dialog.showOpenDialog(dialogOptions)
    const path = result.filePaths[0]
    if (result.canceled || !path) return undefined
    assertBackupDirectoryAllowed(path, options.userData, options.layout)
    return path
  })
  ipcMain.handle('profile-backup:backup-now', () => { unlocked(); return runBackup('manual') })
  ipcMain.handle('profile-backup:preview', async (event, value?: unknown): Promise<ProfileBackupPreview | undefined> => {
    unlocked()
    let path: string | undefined
    if (value === undefined) {
      const owner = BrowserWindow.fromWebContents(event.sender)
      const dialogOptions: Electron.OpenDialogOptions = { title: 'Choose an Aerio profile backup folder', defaultPath: state().schedule.directory, properties: ['openDirectory'] }
      const result = owner ? await dialog.showOpenDialog(owner, dialogOptions) : await dialog.showOpenDialog(dialogOptions)
      path = result.canceled ? undefined : result.filePaths[0]
      if (!path) return undefined
    } else {
      if (typeof value !== 'string') throw new Error('Choose a valid profile backup')
      path = listProfileBackups(state().schedule.directory, options.layout).find((backup) => resolve(backup.path) === resolve(value))?.path
      if (!path && !previewed.has(resolve(value))) throw new Error('Choose the profile backup folder again')
      path ??= value
    }
    const preview = await exclusive(() => previewProfileBackup(path, options.userData, options.layout))
    previewed.add(resolve(path))
    return preview
  })
  ipcMain.handle('profile-backup:restore', async (_event, value: unknown) => {
    unlocked()
    if (typeof value !== 'string' || !previewed.has(resolve(value))) throw new Error('Preview the profile backup before restoring it')
    const report = await exclusive(() => stageProfileRestore({ backupPath: value, userData: options.userData, layout: options.layout }))
    restarting = true
    options.log('profile-restore-staged', { ...report })
    // Reply first so the renderer can show that Aerio is restarting.
    setTimeout(() => options.relaunch(), 300)
    return { restarting: true as const }
  })
  ipcMain.handle('profile-backup:dismiss-restore', () => dismissProfileRestoreOutcome(options.userData))

  return {
    stop() { clearTimeout(first); clearInterval(interval) },
    /** Exposed for tests and diagnostics; runs a due scheduled backup immediately. */
    tick
  }
}
