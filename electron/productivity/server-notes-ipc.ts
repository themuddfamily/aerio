import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { NoteTransferRequest, ServerNoteResolution, ServerNotesSnapshot, VNoteImportRequest } from '../../src/server-notes-types'
import type { Note } from '../../src/types'
import { VNOTE_MAX_BYTES } from '../../src/lib/vnote'
import { parseTarget, type ServerNotesService } from './server-notes-service'

// IPC for server-synchronized Notes (docs/server-notes.md), exposed as window.aerio.serverNotes.
// Every channel validates its input and is refused while Aerio is app-locked. Accounts sync every
// 15 minutes, queued writes are retried every minute, and every change is broadcast as a snapshot.

const SYNC_INTERVAL_MS = 15 * 60_000
const FLUSH_INTERVAL_MS = 60_000
const INITIAL_SYNC_DELAY_MS = 35_000
const RESOLUTIONS = new Set<ServerNoteResolution>(['keep-mine', 'keep-server', 'keep-both', 'copy-local'])

const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 500

export interface ServerNotesIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  service(): ServerNotesService
  isLocked(): boolean
  broadcast(snapshot: ServerNotesSnapshot): void
  /** Shows an open dialog for .vnt files; undefined when cancelled. */
  chooseVNoteFile(event: IpcMainInvokeEvent): Promise<string | undefined>
  /** Appends notes to Local Notes (main process), used before an account is removed. */
  appendLocalNotes(notes: Note[]): void
  /** Interval timers are skipped in tests. */
  timers?: boolean
}

export function registerServerNotes(options: ServerNotesIpcOptions) {
  const service = options.service
  let pending: ReturnType<typeof setTimeout> | undefined
  const broadcast = () => {
    clearTimeout(pending)
    pending = undefined
    const snapshot = service().snapshot()
    options.broadcast(snapshot)
    return snapshot
  }
  /** Coalesces bursts of changes (typing, sync pages) into one snapshot. */
  const changed = () => {
    if (pending) return
    pending = setTimeout(() => { pending = undefined; try { broadcast() } catch { /* Storage closed during shutdown. */ } }, 60)
    pending.unref?.()
  }
  const unlocked = () => { if (options.isLocked()) throw new Error('Unlock Aerio to use Notes') }
  const handle = (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) =>
    options.ipcMain.handle(channel, (event, ...args) => { unlocked(); return handler(event, ...args) })

  handle('server-notes:snapshot', () => service().snapshot())
  handle('server-notes:sync', async (_event, accountId) => {
    if (accountId !== undefined && accountId !== null && !validId(accountId)) throw new Error('Choose an account')
    try {
      if (typeof accountId === 'string') await service().sync(accountId)
      else await service().syncAll()
    } finally { broadcast() }
    return service().snapshot()
  })
  handle('server-notes:create', async (_event, folderId, note) => {
    if (!validId(folderId)) throw new Error('Choose a notes folder')
    const created = await service().create(folderId, note as Note)
    changed()
    return created
  })
  handle('server-notes:update', async (_event, note) => {
    const updated = await service().update(note as Note)
    changed()
    return updated
  })
  handle('server-notes:remove', async (_event, noteId) => {
    if (!validId(noteId)) throw new Error('Choose a note')
    await service().remove(noteId)
    return broadcast()
  })
  handle('server-notes:resolve', async (_event, reviewId, resolution) => {
    if (!validId(reviewId)) throw new Error('Choose a change to review')
    if (!RESOLUTIONS.has(resolution as ServerNoteResolution)) throw new Error('Choose how to resolve the change')
    const result = await service().resolve(reviewId, resolution as ServerNoteResolution)
    broadcast()
    return result
  })
  handle('server-notes:transfer', async (_event, request) => {
    const result = await service().transfer(request as NoteTransferRequest)
    broadcast()
    return result
  })
  handle('server-notes:vnote-choose', async (event, target) => {
    const parsed = parseTarget(target)
    const path = await options.chooseVNoteFile(event)
    if (!path) return undefined
    const file = statSync(path)
    if (!file.isFile() || file.size > VNOTE_MAX_BYTES) throw new Error('Choose a vNote (.vnt) file smaller than 20 MB')
    return service().previewVNoteFile(readFileSync(path), basename(path), parsed)
  })
  handle('server-notes:vnote-preview', (_event, token, target) => {
    if (!validId(token)) throw new Error('Choose the vNote file again')
    return service().previewVNote(token, parseTarget(target))
  })
  handle('server-notes:vnote-import', async (_event, request) => {
    const value = request as VNoteImportRequest | null
    if (!value || typeof value !== 'object' || !validId(value.token)) throw new Error('Choose the vNote file again')
    const result = await service().importVNote(value)
    broadcast()
    return result
  })
  handle('server-notes:account-summary', (_event, accountId) => {
    if (!validId(accountId)) throw new Error('Choose an account')
    return service().accountSummary(accountId)
  })
  handle('server-notes:copy-account-local', (_event, accountId) => {
    if (!validId(accountId)) throw new Error('Choose an account')
    const notes = service().copyAccountToLocal(accountId)
    if (notes.length) options.appendLocalNotes(notes)
    return { copied: notes.length }
  })

  let running = false
  const run = async (work: () => Promise<void>) => {
    if (running) return
    running = true
    try { await work(); broadcast() } catch { /* Storage can close during shutdown; the next interval retries. */ } finally { running = false }
  }
  const timers = options.timers === false ? [] : [
    setTimeout(() => void run(() => service().syncAll()), INITIAL_SYNC_DELAY_MS),
    setInterval(() => void run(() => service().syncAll()), SYNC_INTERVAL_MS),
    setInterval(() => void run(() => service().flushAll()), FLUSH_INTERVAL_MS)
  ]
  for (const timer of timers) timer.unref?.()
  return {
    broadcast,
    changed,
    flushNow: () => run(() => service().flushAll()),
    dispose() {
      clearTimeout(pending)
      for (const timer of timers) clearInterval(timer)
    }
  }
}
