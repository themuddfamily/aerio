import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { MailLabel, MailProviderId } from '../../src/mail-types'
import type {
  MailFolderAppearance,
  MailFolderAppearanceInput,
  MailFolderFavorite,
  MailFolderIcon,
  MailFolderPreferences,
  MailFolderReference
} from '../../src/mail-folder-preference-types'
import { mailFolderLeafName } from '../../src/lib/mail-folders'

/**
 * Display-only folder preferences (E35): Favorites (order and alias), local
 * icons and name colors, and sidebar visibility. Rows are keyed by
 * (account_id, provider folder id), never by name, so two accounts' “Projects”
 * folders stay distinct. Nothing here is sent to a provider; removing a
 * favorite or hiding a folder never changes the folder. The tables live in the
 * mail database, so profile backups include them, and they are deleted with
 * the account's local data.
 */

interface DatabaseRow {
  [key: string]: string | number | bigint | null
}

export type MailFolderPreferenceCommand =
  | { type: 'folder-preferences:get' }
  | { type: 'folder-preferences:add-favorite'; payload: MailFolderReference }
  | { type: 'folder-preferences:remove-favorite'; payload: MailFolderReference }
  | { type: 'folder-preferences:reorder'; payload: { order: MailFolderReference[] } }
  | { type: 'folder-preferences:set-alias'; payload: MailFolderReference & { alias: string | null } }
  | { type: 'folder-preferences:set-appearance'; payload: MailFolderAppearanceInput }

/** IMAP-style providers use the mailbox path as the folder id, so a rename changes the id. */
export function usesPathFolderIds(provider: MailProviderId | undefined) {
  return Boolean(provider) && provider !== 'gmail' && provider !== 'microsoft' && provider !== 'local'
}

/**
 * Infers a folder rename/move made outside Aerio from two folder lists of a
 * path-id account. It is deliberately conservative: exactly one folder subtree
 * must have disappeared and exactly one must have appeared, and the new root
 * must keep either the old parent (a rename) or the old leaf name (a move).
 * Subfolders are matched by their path below the root. Anything else is left
 * alone and the favorite shows as unavailable instead of pointing at the
 * wrong folder.
 */
export function inferFolderPathRenames(before: MailLabel[], after: MailLabel[]): Record<string, string> {
  const beforeIds = new Set(before.map((label) => label.id))
  const afterIds = new Set(after.map((label) => label.id))
  const gone = before.filter((label) => label.id.startsWith('folder:') && !afterIds.has(label.id))
  const added = after.filter((label) => label.id.startsWith('folder:') && !beforeIds.has(label.id))
  const goneIds = new Set(gone.map((label) => label.id))
  const addedIds = new Set(added.map((label) => label.id))
  const goneRoots = gone.filter((label) => !label.parentId || !goneIds.has(label.parentId))
  const addedRoots = added.filter((label) => !label.parentId || !addedIds.has(label.parentId))
  if (goneRoots.length !== 1 || addedRoots.length !== 1) return {}
  const [from] = goneRoots
  const [to] = addedRoots
  const sameParent = (from.parentId ?? '') === (to.parentId ?? '')
  const sameLeaf = mailFolderLeafName(from, before) === mailFolderLeafName(to, after)
  if (!sameParent && !sameLeaf) return {}
  const renamed: Record<string, string> = { [from.id]: to.id }
  for (const label of gone) {
    if (label.id === from.id || !label.id.startsWith(from.id)) continue
    const target = to.id + label.id.slice(from.id.length)
    if (addedIds.has(target)) renamed[label.id] = target
  }
  return renamed
}

export class MailFolderPreferenceStore {
  private statements = new Map<string, StatementSync>()

  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mail_folder_favorites (
        account_id TEXT NOT NULL REFERENCES gmail_accounts(id) ON DELETE CASCADE,
        label_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        alias TEXT,
        last_known_name TEXT NOT NULL,
        added_at TEXT NOT NULL,
        PRIMARY KEY (account_id, label_id)
      );
      CREATE TABLE IF NOT EXISTS mail_folder_appearance (
        account_id TEXT NOT NULL REFERENCES gmail_accounts(id) ON DELETE CASCADE,
        label_id TEXT NOT NULL,
        icon TEXT,
        color TEXT,
        hidden INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account_id, label_id)
      );
    `)
  }

  private stmt(sql: string) {
    let statement = this.statements.get(sql)
    if (!statement) {
      statement = this.db.prepare(sql)
      this.statements.set(sql, statement)
    }
    return statement
  }

  // A savepoint nests inside the mail database's own transactions (for
  // example when folder references are renamed) and works on its own too.
  private transaction<T>(run: () => T): T {
    this.db.exec('SAVEPOINT mail_folder_preferences')
    try {
      const result = run()
      this.db.exec('RELEASE mail_folder_preferences')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK TO mail_folder_preferences; RELEASE mail_folder_preferences')
      throw error
    }
  }

  list(): MailFolderPreferences {
    const favorites = (this.stmt('SELECT * FROM mail_folder_favorites ORDER BY position,added_at,account_id,label_id').all() as DatabaseRow[]).map((row): MailFolderFavorite => ({
      accountId: String(row.account_id),
      labelId: String(row.label_id),
      position: Number(row.position),
      ...(row.alias ? { alias: String(row.alias) } : {}),
      lastKnownName: String(row.last_known_name),
      addedAt: String(row.added_at)
    }))
    const appearance = (this.stmt('SELECT * FROM mail_folder_appearance ORDER BY account_id,label_id').all() as DatabaseRow[]).map((row): MailFolderAppearance => ({
      accountId: String(row.account_id),
      labelId: String(row.label_id),
      ...(row.icon ? { icon: String(row.icon) as MailFolderIcon } : {}),
      ...(row.color ? { color: String(row.color) } : {}),
      hidden: Boolean(row.hidden)
    }))
    return { favorites, appearance }
  }

  private favorite(accountId: string, labelId: string) {
    return this.stmt('SELECT * FROM mail_folder_favorites WHERE account_id=? AND label_id=?').get(accountId, labelId) as DatabaseRow | undefined
  }

  /** Appends a favorite at the end; adding an existing favorite keeps its place and alias. */
  addFavorite(accountId: string, labelId: string, name: string, at = new Date().toISOString()) {
    this.transaction(() => {
      if (this.favorite(accountId, labelId)) {
        this.stmt('UPDATE mail_folder_favorites SET last_known_name=? WHERE account_id=? AND label_id=?').run(name, accountId, labelId)
        return
      }
      const next = Number((this.stmt('SELECT COALESCE(MAX(position),-1)+1 next FROM mail_folder_favorites').get() as DatabaseRow).next)
      this.stmt('INSERT INTO mail_folder_favorites(account_id,label_id,position,alias,last_known_name,added_at) VALUES(?,?,?,NULL,?,?)').run(accountId, labelId, next, name, at)
    })
    return this.list()
  }

  removeFavorite(accountId: string, labelId: string) {
    this.transaction(() => {
      this.stmt('DELETE FROM mail_folder_favorites WHERE account_id=? AND label_id=?').run(accountId, labelId)
      this.normalizePositions()
    })
    return this.list()
  }

  reorderFavorites(order: MailFolderReference[]) {
    this.transaction(() => {
      const current = this.list().favorites
      const key = (item: MailFolderReference) => `${item.accountId}\u0000${item.labelId}`
      const known = new Map(current.map((item) => [key(item), item]))
      const listed = order.filter((item, index) => known.has(key(item)) && order.findIndex((other) => key(other) === key(item)) === index)
      const listedKeys = new Set(listed.map(key))
      const rest = current.filter((item) => !listedKeys.has(key(item)))
      const update = this.stmt('UPDATE mail_folder_favorites SET position=? WHERE account_id=? AND label_id=?')
      ;[...listed, ...rest].forEach((item, index) => update.run(index, item.accountId, item.labelId))
    })
    return this.list()
  }

  setAlias(accountId: string, labelId: string, alias: string | null) {
    if (!this.favorite(accountId, labelId)) throw new Error('This folder is not in Favorites')
    this.stmt('UPDATE mail_folder_favorites SET alias=? WHERE account_id=? AND label_id=?').run(alias, accountId, labelId)
    return this.list()
  }

  setAppearance(input: MailFolderAppearanceInput, at = new Date().toISOString()) {
    this.transaction(() => {
      const row = this.stmt('SELECT * FROM mail_folder_appearance WHERE account_id=? AND label_id=?').get(input.accountId, input.labelId) as DatabaseRow | undefined
      const icon = input.icon === undefined ? row?.icon ?? null : input.icon
      const color = input.color === undefined ? row?.color ?? null : input.color
      const hidden = input.hidden === undefined ? Boolean(row?.hidden) : input.hidden
      // A row with nothing set is the default look; drop it instead of storing it.
      if (!icon && !color && !hidden) {
        this.stmt('DELETE FROM mail_folder_appearance WHERE account_id=? AND label_id=?').run(input.accountId, input.labelId)
        return
      }
      this.stmt(`INSERT INTO mail_folder_appearance(account_id,label_id,icon,color,hidden,updated_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(account_id,label_id) DO UPDATE SET icon=excluded.icon,color=excluded.color,hidden=excluded.hidden,updated_at=excluded.updated_at`)
        .run(input.accountId, input.labelId, icon, color, hidden ? 1 : 0, at)
    })
    return this.list()
  }

  /**
   * Follows provider folder id changes (an IMAP rename or move changes the
   * path id; a Microsoft move may return a new id). When the new id already
   * has its own preferences, those win and the old row is dropped.
   */
  rename(accountId: string, renamed: Record<string, string>) {
    const entries = Object.entries(renamed).filter(([from, to]) => from && to && from !== to)
    if (!entries.length) return
    this.transaction(() => {
      for (const table of ['mail_folder_favorites', 'mail_folder_appearance']) {
        // Move to temporary ids first so chained or swapped renames cannot collide.
        const moved: [string, string][] = []
        for (const [from, to] of entries) {
          if (!this.stmt(`SELECT 1 FROM ${table} WHERE account_id=? AND label_id=?`).get(accountId, from)) continue
          const temporary = `\u0000rename:${from}`
          this.stmt(`UPDATE ${table} SET label_id=? WHERE account_id=? AND label_id=?`).run(temporary, accountId, from)
          moved.push([temporary, to])
        }
        for (const [temporary, to] of moved) {
          if (this.stmt(`SELECT 1 FROM ${table} WHERE account_id=? AND label_id=?`).get(accountId, to)) this.stmt(`DELETE FROM ${table} WHERE account_id=? AND label_id=?`).run(accountId, temporary)
          else this.stmt(`UPDATE ${table} SET label_id=? WHERE account_id=? AND label_id=?`).run(to, accountId, temporary)
        }
      }
      this.normalizePositions()
    })
  }

  /** Drops preferences of folders deleted through Aerio. */
  forget(accountId: string, labelIds: string[]) {
    if (!labelIds.length) return
    this.transaction(() => {
      for (const labelId of labelIds) {
        this.stmt('DELETE FROM mail_folder_favorites WHERE account_id=? AND label_id=?').run(accountId, labelId)
        this.stmt('DELETE FROM mail_folder_appearance WHERE account_id=? AND label_id=?').run(accountId, labelId)
      }
      this.normalizePositions()
    })
  }

  /**
   * Runs after a folder list was refreshed from the provider: follows renames
   * of path-id folders made in another client and remembers current names for
   * favorites. Favorites whose folder disappeared are kept (shown as
   * unavailable) so a folder that comes back, or one that was briefly missing
   * from a server listing, keeps its place.
   */
  reconcile(accountId: string, provider: MailProviderId | undefined, before: MailLabel[], after: MailLabel[]) {
    if (usesPathFolderIds(provider)) {
      const inferred = inferFolderPathRenames(before, after)
      const tracked = new Set([
        ...(this.stmt('SELECT label_id FROM mail_folder_favorites WHERE account_id=?').all(accountId) as DatabaseRow[]),
        ...(this.stmt('SELECT label_id FROM mail_folder_appearance WHERE account_id=?').all(accountId) as DatabaseRow[])
      ].map((row) => String(row.label_id)))
      this.rename(accountId, Object.fromEntries(Object.entries(inferred).filter(([from]) => tracked.has(from))))
    }
    const names = new Map(after.map((label) => [label.id, label.name]))
    for (const row of this.stmt('SELECT label_id,last_known_name FROM mail_folder_favorites WHERE account_id=?').all(accountId) as DatabaseRow[]) {
      const name = names.get(String(row.label_id))
      if (name && name !== row.last_known_name) this.stmt('UPDATE mail_folder_favorites SET last_known_name=? WHERE account_id=? AND label_id=?').run(name, accountId, String(row.label_id))
    }
  }

  private normalizePositions() {
    const rows = this.stmt('SELECT account_id,label_id FROM mail_folder_favorites ORDER BY position,added_at,account_id,label_id').all() as DatabaseRow[]
    const update = this.stmt('UPDATE mail_folder_favorites SET position=? WHERE account_id=? AND label_id=?')
    rows.forEach((row, index) => update.run(index, String(row.account_id), String(row.label_id)))
  }

  count(table: 'favorites' | 'appearance') {
    return Number((this.stmt(`SELECT COUNT(*) count FROM ${table === 'favorites' ? 'mail_folder_favorites' : 'mail_folder_appearance'}`).get() as DatabaseRow).count)
  }
}

interface FolderPreferenceDatabase {
  folderPreferences: MailFolderPreferenceStore
  getAccount(accountId: string): { provider: MailProviderId } | undefined
  listLabels(accountIds?: string[]): MailLabel[]
}

/** Worker-side handling with checks that need the mail database (account, folder, and provider). */
export function handleMailFolderPreferenceCommand(database: FolderPreferenceDatabase, command: MailFolderPreferenceCommand): MailFolderPreferences {
  const store = database.folderPreferences
  if (command.type === 'folder-preferences:get') return store.list()
  if (command.type === 'folder-preferences:reorder') return store.reorderFavorites(command.payload.order)
  const { accountId, labelId } = command.payload
  if (command.type === 'folder-preferences:remove-favorite') return store.removeFavorite(accountId, labelId)
  if (command.type === 'folder-preferences:set-alias') return store.setAlias(accountId, labelId, command.payload.alias)
  const account = database.getAccount(accountId)
  if (!account) throw new Error('Account not found')
  const label = database.listLabels([accountId]).find((item) => item.id === labelId)
  if (command.type === 'folder-preferences:add-favorite') {
    if (!label) throw new Error('This folder no longer exists. Refresh the folder list and try again.')
    return store.addFavorite(accountId, labelId, label.name)
  }
  // Clearing preferences of a folder that has gone away is always allowed.
  const clearing = !command.payload.icon && !command.payload.color && !command.payload.hidden
  if (!label && !clearing) throw new Error('This folder no longer exists. Refresh the folder list and try again.')
  if (command.payload.color && account.provider === 'gmail') throw new Error('Gmail label colors are synchronized with Gmail. Change them in Manage labels.')
  return store.setAppearance(command.payload)
}
