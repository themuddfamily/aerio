import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { IpcMain } from 'electron'
import type { MailUnifiedView, MailUnifiedViewsSnapshot } from '../../src/mail-unified-view-types'
import { UNIFIED_MAIL_FOLDERS } from '../../src/lib/mail-unified-views'

export const MAIL_UNIFIED_VIEWS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS mail_unified_views (id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS mail_unified_selection (id INTEGER PRIMARY KEY CHECK(id=1), selected_id TEXT);
`
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 500
const ids = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 200 && value.every(identity) && new Set(value).size === value.length

export class MailUnifiedViewsStore {
  private readonly db: DatabaseSync
  constructor(path: string) { this.db = new DatabaseSync(path); this.db.exec(MAIL_UNIFIED_VIEWS_SCHEMA) }
  snapshot(): MailUnifiedViewsSnapshot {
    const views = (this.db.prepare('SELECT payload_json FROM mail_unified_views ORDER BY rowid').all() as { payload_json: string }[]).map((row) => JSON.parse(row.payload_json) as MailUnifiedView)
    const selected = this.db.prepare('SELECT selected_id FROM mail_unified_selection WHERE id=1').get() as { selected_id: string | null } | undefined
    return { views, ...(selected?.selected_id && views.some((view) => view.id === selected.selected_id) ? { selectedId: selected.selected_id } : {}) }
  }
  save(value: unknown, availableIds: string[]) {
    if (!value || typeof value !== 'object') throw new Error('Invalid unified view')
    const input = value as Partial<MailUnifiedView>
    if ((input.id !== undefined && !identity(input.id)) || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80 || !ids(input.accountIds) || !input.accountIds.length || input.accountIds.some((id) => !availableIds.includes(id))) throw new Error('Choose a name and at least one available account')
    const folderAccountIds: MailUnifiedView['folderAccountIds'] = {}
    if (input.folderAccountIds !== undefined) {
      if (!input.folderAccountIds || typeof input.folderAccountIds !== 'object' || Array.isArray(input.folderAccountIds)) throw new Error('Invalid folder membership')
      for (const [folder, members] of Object.entries(input.folderAccountIds)) {
        if (!UNIFIED_MAIL_FOLDERS.some((item) => item.id === folder) || !ids(members) || members.some((id) => !input.accountIds!.includes(id))) throw new Error('Folder membership must use accounts from this view')
        folderAccountIds[folder as keyof typeof folderAccountIds] = members
      }
    }
    const snapshot = this.snapshot()
    if (input.id && !snapshot.views.some((view) => view.id === input.id)) throw new Error('Unified view not found')
    if (!input.id && snapshot.views.length >= 30) throw new Error('You can save up to 30 unified views')
    if (snapshot.views.some((view) => view.id !== input.id && view.name.toLowerCase() === input.name!.trim().toLowerCase())) throw new Error('A unified view with that name already exists')
    const view: MailUnifiedView = { id: input.id ?? randomUUID(), name: input.name.trim(), accountIds: input.accountIds, ...(Object.keys(folderAccountIds).length ? { folderAccountIds } : {}) }
    this.db.prepare('INSERT INTO mail_unified_views(id,payload_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json').run(view.id, JSON.stringify(view))
    return this.snapshot()
  }
  remove(id: unknown) {
    if (!identity(id)) throw new Error('Invalid unified view identity')
    this.db.prepare('DELETE FROM mail_unified_views WHERE id=?').run(id)
    this.db.prepare('UPDATE mail_unified_selection SET selected_id=NULL WHERE selected_id=?').run(id)
    return this.snapshot()
  }
  select(id: unknown) {
    if (id !== undefined && (!identity(id) || !this.snapshot().views.some((view) => view.id === id))) throw new Error('Unified view not found')
    this.db.prepare('INSERT INTO mail_unified_selection(id,selected_id) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET selected_id=excluded.selected_id').run(id ?? null)
    return this.snapshot()
  }
  close() { this.db.close() }
}

export function registerMailUnifiedViews(options: { ipc: Pick<IpcMain, 'handle'>; store: MailUnifiedViewsStore; accounts(): Promise<{ id: string }[]>; locked(): boolean; changed(snapshot: MailUnifiedViewsSnapshot): void }) {
  const guard = () => { if (options.locked()) throw new Error('Unlock Aerio to use unified views') }
  options.ipc.handle('mail:unified-views:snapshot', () => { guard(); return options.store.snapshot() })
  options.ipc.handle('mail:unified-views:save', async (_event, value: unknown) => {
    guard(); const accounts = await options.accounts(); guard()
    const snapshot = options.store.save(value, accounts.map((account) => account.id)); options.changed(snapshot); return snapshot
  })
  options.ipc.handle('mail:unified-views:remove', (_event, id: unknown) => { guard(); const snapshot = options.store.remove(id); options.changed(snapshot); return snapshot })
  options.ipc.handle('mail:unified-views:select', (_event, id: unknown) => { guard(); const snapshot = options.store.select(id); options.changed(snapshot); return snapshot })
}
