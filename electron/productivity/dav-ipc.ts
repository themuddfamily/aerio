import { BrowserWindow, ipcMain } from 'electron'
import type { DavSnapshot } from '../../src/dav-types'
import type { DavService } from './dav-service'

const SYNC_INTERVAL_MS = 15 * 60_000
const FLUSH_INTERVAL_MS = 60_000
const INITIAL_SYNC_DELAY_MS = 25_000

const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 500

export interface DavIpcOptions {
  service(): DavService
  // Called after any change so Calendar and Contacts re-read the productivity snapshot.
  productivityChanged(): void
}

export function registerDavAccounts(options: DavIpcOptions) {
  const service = options.service
  const broadcast = (): DavSnapshot => {
    const snapshot = service().snapshot()
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('dav:changed', snapshot)
    options.productivityChanged()
    return snapshot
  }

  ipcMain.handle('dav:snapshot', () => service().snapshot())
  ipcMain.handle('dav:account-add', async (_event, input: unknown) => {
    await service().addAccount(input as Parameters<DavService['addAccount']>[0])
    return broadcast()
  })
  ipcMain.handle('dav:account-password', async (_event, accountId: unknown, password: unknown) => {
    if (!validId(accountId)) throw new Error('Choose an account')
    await service().updatePassword(accountId, password)
    return broadcast()
  })
  ipcMain.handle('dav:account-remove', (_event, accountId: unknown) => {
    if (!validId(accountId) || !service().hasAccount(accountId)) throw new Error('That account is no longer connected')
    service().removeAccount(accountId)
    return broadcast()
  })
  ipcMain.handle('dav:sync', async (_event, accountId: unknown) => {
    if (!validId(accountId)) throw new Error('Choose an account')
    try { await service().sync(accountId) } finally { broadcast() }
    return service().snapshot()
  })
  ipcMain.handle('dav:sync-all', async () => {
    await service().syncAll()
    return broadcast()
  })
  ipcMain.handle('dav:collection-enabled', (_event, collectionId: unknown, enabled: unknown) => {
    if (!validId(collectionId) || typeof enabled !== 'boolean') throw new Error('Choose a calendar or address book')
    service().setCollectionEnabled(collectionId, enabled)
    return broadcast()
  })
  ipcMain.handle('dav:resolve', async (_event, reviewId: unknown, resolution: unknown) => {
    if (!validId(reviewId)) throw new Error('Choose a change to review')
    await service().resolve(reviewId, resolution as 'keep-server' | 'keep-local')
    return broadcast()
  })

  // Queued writes are retried every minute (each on its own backoff); collections sync every 15 minutes.
  let running = false
  const run = async (work: () => Promise<void>) => {
    if (running) return
    running = true
    try { await work(); broadcast() }
    catch { /* Storage can close during shutdown; the next interval retries. */ }
    finally { running = false }
  }
  const initial = setTimeout(() => void run(() => service().syncAll()), INITIAL_SYNC_DELAY_MS)
  const sync = setInterval(() => void run(() => service().syncAll()), SYNC_INTERVAL_MS)
  const flush = setInterval(() => void run(() => service().flushAll()), FLUSH_INTERVAL_MS)
  initial.unref?.()
  sync.unref?.()
  flush.unref?.()
  return {
    broadcast,
    flushNow: () => run(() => service().flushAll()),
    dispose() {
      clearTimeout(initial)
      clearInterval(sync)
      clearInterval(flush)
    }
  }
}
