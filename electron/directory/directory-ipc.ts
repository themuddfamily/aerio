import type { IpcMain } from 'electron'
import type { DirectoryAccessLevel, DirectoryEntryKind, DirectorySearchRequest } from '../../src/directory-types'
import type { DirectoryService } from './directory-service'

// IPC for the organization directory (E41), exposed as window.aerio.directory. Every handler is
// refused while the app is locked, and every renderer value is validated here.

export const DIRECTORY_CHECK_INTERVAL_MS = 30 * 60_000
const FIRST_CHECK_DELAY_MS = 2 * 60_000
const KINDS = new Set<DirectoryEntryKind>(['person', 'group', 'room', 'equipment'])

const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 500

export function validateDirectorySearch(input: unknown): DirectorySearchRequest {
  if (!input || typeof input !== 'object') throw new Error('Enter a name or address to look up')
  const value = input as Record<string, unknown>
  if (typeof value.query !== 'string' || value.query.length > 200) throw new Error('Enter a name or address to look up')
  if (value.accountIds !== undefined && (!Array.isArray(value.accountIds) || value.accountIds.length > 50 || !value.accountIds.every(validId))) throw new Error('Choose valid accounts')
  if (value.kinds !== undefined && (!Array.isArray(value.kinds) || !value.kinds.every((kind) => KINDS.has(kind as DirectoryEntryKind)))) throw new Error('Choose valid directory entry types')
  if (value.limit !== undefined && (typeof value.limit !== 'number' || !Number.isFinite(value.limit) || value.limit < 1 || value.limit > 100)) throw new Error('Choose between 1 and 100 results')
  if (value.mode !== undefined && value.mode !== 'auto' && value.mode !== 'online' && value.mode !== 'offline') throw new Error('Choose a lookup mode')
  return {
    query: value.query,
    ...(value.accountIds ? { accountIds: value.accountIds as string[] } : {}),
    ...(value.kinds ? { kinds: value.kinds as DirectoryEntryKind[] } : {}),
    ...(value.limit !== undefined ? { limit: value.limit as number } : {}),
    ...(value.mode ? { mode: value.mode as DirectorySearchRequest['mode'] } : {})
  }
}

export interface DirectoryIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  service(): DirectoryService
  locked(): boolean
  /** Interval timers are skipped in tests. */
  timers?: boolean
}

export function registerDirectory(options: DirectoryIpcOptions) {
  const unlocked = () => { if (options.locked()) throw new Error('Unlock Aerio first') }
  const account = (value: unknown) => {
    if (!validId(value)) throw new Error('Choose an account')
    return value
  }
  options.ipcMain.handle('directory:snapshot', () => { unlocked(); return options.service().snapshot() })
  options.ipcMain.handle('directory:search', (_event, request: unknown) => { unlocked(); return options.service().search(validateDirectorySearch(request)) })
  options.ipcMain.handle('directory:expand-group', (_event, accountId: unknown, groupEmail: unknown) => {
    unlocked()
    if (typeof groupEmail !== 'string' || groupEmail.length > 320) throw new Error('Choose a group address')
    return options.service().expandGroup(account(accountId), groupEmail)
  })
  options.ipcMain.handle('directory:refresh', (_event, accountId: unknown) => { unlocked(); return options.service().refresh(account(accountId)) })
  options.ipcMain.handle('directory:grant', (_event, accountId: unknown, level: unknown) => {
    unlocked()
    if (level !== undefined && level !== 'directory' && level !== 'resources') throw new Error('Choose which directory permission to add')
    return options.service().grantAccess(account(accountId), level as DirectoryAccessLevel | undefined)
  })

  let running = false
  const check = async () => {
    if (running || options.locked()) return
    running = true
    try { await options.service().refreshDue() } catch { /* Storage can close during shutdown; the next check retries. */ } finally { running = false }
  }
  const timers = options.timers === false ? [] : [setTimeout(() => void check(), FIRST_CHECK_DELAY_MS), setInterval(() => void check(), DIRECTORY_CHECK_INTERVAL_MS)]
  for (const timer of timers) timer.unref?.()
  return {
    check,
    dispose() { for (const timer of timers) clearInterval(timer) }
  }
}
