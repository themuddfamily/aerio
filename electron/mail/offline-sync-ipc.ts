import type { IpcMain } from 'electron'
import type { MailFolder } from '../../src/mail-types'
import type {
  MailOfflineAvailability,
  MailOfflineExtendInput,
  MailOfflineReclaimResult,
  MailOfflineSettings,
  MailSearchCoverage,
  MailServerSearchInput,
  MailServerSearchResult
} from '../../src/offline-sync-types'
import { normalizeOverride, normalizePolicy } from '../../src/lib/offline-sync'
import type { MailWorkerCommand, MailWorkerResult } from '../mail-protocol'

interface OfflineWorker {
  request<T extends MailWorkerResult = void>(command: MailWorkerCommand): Promise<T>
}

export interface OfflineSyncIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  worker(): OfflineWorker
  /** Policy changes and server searches wait until Aerio is unlocked. */
  isLocked(): boolean
}

const FOLDERS: MailFolder[] = ['inbox', 'starred', 'important', 'sent', 'drafts', 'scheduled', 'snoozed', 'archive', 'spam', 'trash', 'all']

const text = (value: unknown, label: string, max = 500) => {
  if (typeof value !== 'string' || !value || value.length > max) throw new Error(`Invalid ${label}`)
  return value
}

const accountIdList = (value: unknown, required: boolean) => {
  if (value === undefined && !required) return undefined
  if (!Array.isArray(value) || (required && !value.length) || value.length > 100) throw new Error('Choose up to 100 accounts')
  return value.map((item) => text(item, 'account id', 200))
}

export function validateExtend(input: unknown): MailOfflineExtendInput {
  const value = input as Partial<MailOfflineExtendInput> | undefined
  if (!value || typeof value !== 'object') throw new Error('Choose a folder to load more mail for')
  if (!FOLDERS.includes(value.folder as MailFolder)) throw new Error('Choose a valid mailbox')
  if (value.mode !== 'more' && value.mode !== 'all') throw new Error('Choose Load more or Load all')
  return {
    accountIds: accountIdList(value.accountIds, true)!,
    folder: value.folder as MailFolder,
    ...(value.labelId !== undefined ? { labelId: text(value.labelId, 'folder') } : {}),
    mode: value.mode
  }
}

export function validateServerSearch(input: unknown): MailServerSearchInput {
  const value = input as Partial<MailServerSearchInput> | undefined
  if (!value || typeof value !== 'object') throw new Error('Enter something to search for')
  const query = typeof value.query === 'string' ? value.query.trim() : ''
  if (!query) throw new Error('Enter something to search for')
  if (query.length > 500) throw new Error('The search is too long')
  return {
    accountIds: accountIdList(value.accountIds, true)!,
    query,
    ...(value.labelId !== undefined ? { labelId: text(value.labelId, 'folder') } : {})
  }
}

/** IPC for offline download and synchronization scope (E36). */
export function registerOfflineSync(options: OfflineSyncIpcOptions) {
  const { ipcMain } = options
  const unlocked = () => {
    if (options.isLocked()) throw new Error('Unlock Aerio to change offline settings')
  }
  ipcMain.handle('mail:offline:settings', (_event, accountId: unknown) =>
    options.worker().request<MailOfflineSettings>({ type: 'offline:settings', payload: { accountId: text(accountId, 'account id', 200) } }))
  ipcMain.handle('mail:offline:set-account-policy', (_event, accountId: unknown, policy: unknown) => {
    unlocked()
    return options.worker().request<MailOfflineSettings>({ type: 'offline:set-account-policy', payload: { accountId: text(accountId, 'account id', 200), policy: normalizePolicy(policy) } })
  })
  ipcMain.handle('mail:offline:set-folder-override', (_event, accountId: unknown, labelId: unknown, override: unknown) => {
    unlocked()
    return options.worker().request<MailOfflineSettings>({ type: 'offline:set-folder-override', payload: {
      accountId: text(accountId, 'account id', 200),
      labelId: text(labelId, 'folder'),
      override: override === null ? null : normalizeOverride(override)
    } })
  })
  ipcMain.handle('mail:offline:extend', (_event, input: unknown) => {
    unlocked()
    return options.worker().request<MailOfflineSettings[]>({ type: 'offline:extend', payload: validateExtend(input) })
  })
  ipcMain.handle('mail:offline:availability', (_event, accountId: unknown, labelId?: unknown) =>
    options.worker().request<MailOfflineAvailability>({ type: 'offline:availability', payload: { accountId: text(accountId, 'account id', 200), ...(labelId !== undefined && labelId !== null ? { labelId: text(labelId, 'folder') } : {}) } }))
  ipcMain.handle('mail:offline:search-coverage', (_event, accountIds?: unknown) =>
    options.worker().request<MailSearchCoverage[]>({ type: 'offline:search-coverage', payload: { accountIds: accountIdList(accountIds ?? undefined, false) } }))
  ipcMain.handle('mail:offline:server-search', (_event, input: unknown) => {
    unlocked()
    return options.worker().request<MailServerSearchResult>({ type: 'offline:server-search', payload: validateServerSearch(input) })
  })
  ipcMain.handle('mail:offline:reclaim', (_event, accountId: unknown) => {
    unlocked()
    return options.worker().request<MailOfflineReclaimResult>({ type: 'offline:reclaim', payload: { accountId: text(accountId, 'account id', 200) } })
  })
}
