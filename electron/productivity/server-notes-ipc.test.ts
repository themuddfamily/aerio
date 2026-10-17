import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Note } from '../../src/types'
import type { ServerNotesSnapshot } from '../../src/server-notes-types'
import { registerServerNotes } from './server-notes-ipc'
import { ServerNotesService } from './server-notes-service'
import { ServerNotesStore } from './server-notes-store'

const cleanup: (() => void)[] = []
afterEach(() => { for (const step of cleanup.splice(0).reverse()) step() })

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'aerio-server-notes-ipc-'))
  const store = new ServerNotesStore(join(directory, 'server-notes.sqlite'))
  store.saveFolder({ id: 'folder-1', accountId: 'dav-1', provider: 'dav', remoteId: 'https://dav.example.com/journal/', name: 'Journal', readOnly: false })
  const service = new ServerNotesService({
    store, accounts: () => [{ id: 'dav-1', provider: 'dav', name: 'Fastmail' }], adapter: () => { throw new Error('offline in tests') },
    attachmentsDirectory: join(directory, 'note-attachments'), localSnapshot: () => ({ tasks: [], notes: [], contacts: [] }), flushDelayMs: -1
  })
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const broadcasts: ServerNotesSnapshot[] = []
  const appended: Note[][] = []
  const state = { locked: false, file: undefined as string | undefined }
  registerServerNotes({
    ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => { handlers.set(channel, handler) } } as never,
    service: () => service, isLocked: () => state.locked, broadcast: (snapshot) => broadcasts.push(snapshot),
    chooseVNoteFile: async () => state.file, appendLocalNotes: (notes) => appended.push(notes), timers: false
  })
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }), () => { service.dispose(); store.close() })
  const invoke = (channel: string, ...args: unknown[]) => new Promise((resolve) => resolve(handlers.get(channel)!({ sender: {} }, ...args)))
  return { directory, handlers, broadcasts, appended, state, invoke, service }
}

const note: Note = { id: 'x', folder: 'Journal', title: 'Hello', content: 'World', tags: ['a'], pinned: false, archived: false, updatedAt: '2026-10-17T00:00:00Z' }

describe('server-synchronized Notes IPC', () => {
  it('registers every channel', () => {
    const { handlers } = setup()
    expect([...handlers.keys()].sort()).toEqual([
      'server-notes:account-summary', 'server-notes:copy-account-local', 'server-notes:create', 'server-notes:remove', 'server-notes:resolve', 'server-notes:snapshot',
      'server-notes:sync', 'server-notes:transfer', 'server-notes:update', 'server-notes:vnote-choose', 'server-notes:vnote-import', 'server-notes:vnote-preview'
    ])
  })

  it('refuses every channel while Aerio is locked', async () => {
    const { handlers, invoke, state } = setup()
    state.locked = true
    for (const channel of handlers.keys()) await expect(invoke(channel, 'id')).rejects.toThrow(/Unlock Aerio/)
  })

  it('validates input before it reaches the service', async () => {
    const { invoke } = setup()
    await expect(invoke('server-notes:create', '', note)).rejects.toThrow(/notes folder/)
    await expect(invoke('server-notes:create', 'folder-1', { ...note, tags: 'nope' })).rejects.toThrow(/invalid/)
    await expect(invoke('server-notes:create', 'folder-1', { ...note, attachments: [{ id: 'a', name: 'x', size: 1, path: 'C:/Windows/win.ini' }] })).rejects.toThrow(/no longer available/)
    await expect(invoke('server-notes:resolve', 'op', 'overwrite-everything')).rejects.toThrow(/how to resolve/)
    await expect(invoke('server-notes:sync', 42)).rejects.toThrow(/account/)
    await expect(invoke('server-notes:transfer', { mode: 'teleport', target: { kind: 'local', folder: 'A' } })).rejects.toThrow(/copy or move/)
    await expect(invoke('server-notes:transfer', { mode: 'copy', target: { kind: 'server' } })).rejects.toThrow(/notes folder/)
    await expect(invoke('server-notes:vnote-preview', 'token', { kind: 'local', folder: '' })).rejects.toThrow(/notes folder/)
    await expect(invoke('server-notes:vnote-import', { token: 42 })).rejects.toThrow(/again/)
  })

  it('creates queued notes, previews and imports vNote files, and copies an account to Local', async () => {
    const { invoke, state, directory, appended, broadcasts } = setup()
    const created = await invoke('server-notes:create', 'folder-1', note) as { id: string; sync: string }
    expect(created).toMatchObject({ title: 'Hello', sync: 'pending' })
    expect(await invoke('server-notes:vnote-choose', { kind: 'local', folder: 'Notes' })).toBeUndefined()
    state.file = join(directory, 'notes.vnt')
    writeFileSync(state.file, 'BEGIN:VNOTE\r\nVERSION:1.1\r\nBODY:Imported\r\nEND:VNOTE\r\n')
    const preview = await invoke('server-notes:vnote-choose', { kind: 'server', folderId: 'folder-1' }) as { token: string; count: number; fileName: string }
    expect(preview).toMatchObject({ count: 1, fileName: 'notes.vnt' })
    const result = await invoke('server-notes:vnote-import', { token: preview.token, target: { kind: 'server', folderId: 'folder-1' }, duplicates: 'skip' })
    expect(result).toMatchObject({ imported: 1 })
    expect(broadcasts.at(-1)!.notes.map((item) => item.title).sort()).toEqual(['Hello', 'Imported'])
    expect(await invoke('server-notes:account-summary', 'dav-1')).toEqual({ accountId: 'dav-1', notes: 2, pendingWrites: 2, review: 0 })
    expect(await invoke('server-notes:copy-account-local', 'dav-1')).toEqual({ copied: 2 })
    expect(appended[0].map((item) => item.folder)).toEqual(['Journal (Fastmail)', 'Journal (Fastmail)'])
  })

  it('reports sync failures after broadcasting the latest state', async () => {
    const { invoke, broadcasts } = setup()
    const errors = vi.fn()
    await invoke('server-notes:sync', 'dav-1').catch(errors)
    expect(errors).toHaveBeenCalled()
    expect(broadcasts.at(-1)!.accounts[0]).toMatchObject({ status: 'error', error: 'offline in tests' })
  })
})
