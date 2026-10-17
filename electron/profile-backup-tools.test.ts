import { mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  openDialog: vi.fn(async (): Promise<{ canceled: boolean; filePaths: string[] }> => ({ canceled: true, filePaths: [] }))
}))
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showOpenDialog: mocks.openDialog },
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => mocks.handlers.set(channel, handler) }
}))

import { registerProfileBackup } from './profile-backup-tools'
import type { ProfileBackupLayout } from './profile-backup'

const directories: string[] = []
const temporary = (name: string) => { const directory = mkdtempSync(join(tmpdir(), `aerio-profile-tools-${name}-`)); directories.push(directory); return directory }
const layout: ProfileBackupLayout = { databases: [{ file: 'state.sqlite', label: 'State' }], directories: [{ name: 'files', label: 'Files' }] }
const invoke = (channel: string, ...args: unknown[]) => new Promise<unknown>((resolve) => resolve(mocks.handlers.get(channel)!({ sender: {} }, ...args)))

let tools: ReturnType<typeof registerProfileBackup>
let locked = false
const relaunch = vi.fn()
let profile: string
let target: string

beforeEach(() => {
  mocks.handlers.clear()
  locked = false
  relaunch.mockClear()
  profile = temporary('profile')
  target = temporary('target')
  const db = new DatabaseSync(join(profile, 'state.sqlite'))
  db.exec("CREATE TABLE items(name TEXT); INSERT INTO items VALUES('one')")
  db.close()
  mkdirSync(join(profile, 'files'))
  writeFileSync(join(profile, 'files', 'a.txt'), 'a')
  tools = registerProfileBackup({ userData: profile, appVersion: '0.6.0', defaultDirectory: target, layout, isLocked: () => locked, relaunch, log: vi.fn() })
})
afterEach(() => {
  tools.stop()
  vi.useRealTimers()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('profile backup IPC', () => {
  it('backs up on demand, applies retention, and lists backups in status', async () => {
    await invoke('profile-backup:schedule', { enabled: false, intervalHours: 24, keep: 1, directory: target })
    await invoke('profile-backup:backup-now')
    await new Promise((resolve) => setTimeout(resolve, 5))
    await invoke('profile-backup:backup-now')
    const status = await invoke('profile-backup:status') as { backups: unknown[]; lastBackupAt?: string; lastError?: string }
    expect(status.backups).toHaveLength(1)
    expect(status.lastBackupAt).toBeTruthy()
    expect(readdirSync(target)).toHaveLength(1)
  })

  it('refuses schedule folders inside managed data and all actions while locked', async () => {
    await expect(invoke('profile-backup:schedule', { enabled: true, intervalHours: 24, keep: 3, directory: join(profile, 'files', 'b') })).rejects.toThrow('managed data folders')
    locked = true
    await expect(invoke('profile-backup:backup-now')).rejects.toThrow('Unlock Aerio')
    await expect(invoke('profile-backup:restore', target)).rejects.toThrow('Unlock Aerio')
  })

  it('only restores a backup that passed preview, then relaunches', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    await invoke('profile-backup:schedule', { enabled: false, intervalHours: 24, keep: 3, directory: target })
    const summary = await invoke('profile-backup:backup-now') as { path: string }
    await expect(invoke('profile-backup:restore', summary.path)).rejects.toThrow('Preview the profile backup')
    await expect(invoke('profile-backup:preview', join(target, 'unlisted'))).rejects.toThrow('Choose the profile backup folder again')
    const preview = await invoke('profile-backup:preview', summary.path) as { fileCount: number }
    expect(preview.fileCount).toBe(2)
    await expect(invoke('profile-backup:restore', summary.path)).resolves.toEqual({ restarting: true })
    expect(relaunch).not.toHaveBeenCalled()
    vi.advanceTimersByTime(300)
    expect(relaunch).toHaveBeenCalledOnce()
    await expect(invoke('profile-backup:backup-now')).rejects.toThrow('restarting')
  })

  it('runs a scheduled backup when due and records failures for a later retry', async () => {
    await invoke('profile-backup:schedule', { enabled: true, intervalHours: 24, keep: 3, directory: target })
    tools.tick()
    await vi.waitFor(async () => expect(((await invoke('profile-backup:status')) as { backups: { trigger: string }[] }).backups.map((item) => item.trigger)).toEqual(['scheduled']))
    tools.tick()
    expect(((await invoke('profile-backup:status')) as { running: boolean }).running).toBe(false)
    expect(readdirSync(target)).toHaveLength(1)
  })
})
