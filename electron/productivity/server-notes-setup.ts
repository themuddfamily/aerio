import { join } from 'node:path'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { LocalModuleSnapshot } from '../../src/productivity-types'
import type { ServerNotesSnapshot } from '../../src/server-notes-types'
import type { Note } from '../../src/types'
import { ExchangeNotesAdapter } from '../exchange/exchange-notes'
import type { ExchangeStore } from '../exchange/exchange-store'
import type { EwsClient } from '../exchange/ews-client'
import { DavClient } from './dav-client'
import type { DavCredentialVault } from './dav-credentials'
import { DavNotesAdapter } from './dav-notes'
import type { DavStore } from './dav-store'
import { NoteAuthError } from './server-notes-adapter'
import { registerServerNotes } from './server-notes-ipc'
import { ServerNotesService, type ServerNotesProviderAccount } from './server-notes-service'
import { ServerNotesStore } from './server-notes-store'

// Wires server-synchronized Notes to the CalDAV and Exchange account stores (main process only),
// so main.ts needs one call. Provider credentials stay in their existing vaults.

export interface ServerNotesSetupOptions {
  userData: string
  ipcMain: Pick<IpcMain, 'handle'>
  davStore(): DavStore | null
  davCredentials: DavCredentialVault
  exchangeStore(): ExchangeStore | null
  /** The Exchange account's address, or undefined when its credentials are missing. */
  exchangeEmail(accountId: string): string | undefined
  ewsClient(accountId: string): EwsClient
  localSnapshot(): LocalModuleSnapshot
  saveLocal(snapshot: LocalModuleSnapshot): void
  online(): boolean
  isLocked(): boolean
  broadcast(snapshot: ServerNotesSnapshot): void
  chooseVNoteFile(event: IpcMainInvokeEvent): Promise<string | undefined>
  diagnostic?(record: { level: 'info' | 'warn' | 'error'; event: string; accountId?: string; message?: string; details?: Record<string, unknown> }): void
}

export function setupServerNotes(options: ServerNotesSetupOptions) {
  const store = new ServerNotesStore(join(options.userData, 'server-notes.sqlite'))
  let ipc: ReturnType<typeof registerServerNotes> | undefined
  const accounts = (): ServerNotesProviderAccount[] => [
    ...(options.davStore()?.accounts() ?? []).map((account) => ({ id: account.id, provider: 'dav' as const, name: account.name, needsAuth: account.status === 'needs-auth' })),
    ...(options.exchangeStore()?.accounts() ?? []).map((account) => {
      const email = options.exchangeEmail(account.accountId)
      return { id: account.accountId, provider: 'exchange' as const, name: email ?? 'Exchange', needsAuth: account.status === 'needs-auth' || !email }
    })
  ]
  const service = new ServerNotesService({
    store,
    accounts,
    adapter: (account) => {
      if (account.provider === 'dav') {
        const record = options.davStore()?.account(account.id)
        const password = record ? options.davCredentials.password(account.id) : undefined
        if (!record || !password) throw new NoteAuthError('Enter the app password for this account again in Settings › Calendar and contacts accounts')
        return new DavNotesAdapter(new DavClient({ username: record.username, password }, { allowedRoots: [...record.calendarRoots, ...record.contactsRoots] }), record)
      }
      let client: EwsClient
      try { client = options.ewsClient(account.id) } catch { throw new NoteAuthError('Sign in to this Exchange account again') }
      return new ExchangeNotesAdapter(client)
    },
    attachmentsDirectory: join(options.userData, 'note-attachments'),
    localSnapshot: options.localSnapshot,
    online: options.online,
    changed: () => ipc?.changed(),
    diagnostic: options.diagnostic
  })
  ipc = registerServerNotes({
    ipcMain: options.ipcMain,
    service: () => service,
    isLocked: options.isLocked,
    broadcast: options.broadcast,
    chooseVNoteFile: options.chooseVNoteFile,
    appendLocalNotes: (notes: Note[]) => {
      const current = options.localSnapshot()
      options.saveLocal({ ...current, notes: [...notes, ...current.notes] })
    }
  })
  return {
    service,
    ipc,
    removeAccount(accountId: string) {
      service.removeAccount(accountId)
      ipc?.broadcast()
    },
    close() {
      ipc?.dispose()
      service.dispose()
      store.close()
    }
  }
}
