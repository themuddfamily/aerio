import type { DatabaseSync } from 'node:sqlite'
import type { MailLabel } from '../../src/mail-types'
import {
  PRIMARY_MAILBOX_OWNER,
  type HeldMailboxOperation,
  type MailboxAccess,
  type MailboxFolderAccess,
  type MailboxFolderKind,
  type MailboxOwnerKind,
  type MailboxOwnerProvider,
  type MailboxOwnerStatus,
  type MailboxOwnerSummary,
  type MailboxSendMode,
  type MailLabelOwner
} from '../../src/mailbox-owner-types'
import type { MailDatabase } from './database'

// Mailbox owners (E40): the account's own mailbox, shared or delegated mailboxes, and the
// Exchange public folder tree. Lives in aerio.sqlite next to the mail cache so owners, their
// folders, and their checkpoints are removed with the account and included in profile backups.
//
// Migration: `owner_id` is added to labels, messages, the sync inventory, and the action queue
// with the default `primary`, so every row that existed before E40 belongs to the account's own
// mailbox. Rows of other owners are written with their owner id, and the account-wide
// maintenance (label replacement, inventory reset and reconciliation, downloads) is scoped to
// `primary` so a sync of the own mailbox never touches another owner's cache.

type Row = Record<string, string | number | bigint | null>

const nowIso = () => new Date().toISOString()
const json = <T>(value: unknown, fallback: T): T => {
  try { return typeof value === 'string' && value ? JSON.parse(value) as T : fallback } catch { return fallback }
}
const OWNER_TABLES = ['gmail_labels', 'gmail_messages', 'gmail_sync_items', 'gmail_operations'] as const

export interface StoredMailboxOwner {
  id: string
  accountId: string
  provider: MailboxOwnerProvider
  kind: MailboxOwnerKind
  address: string
  displayName: string
  status: MailboxOwnerStatus
  error?: string
  sendMode: MailboxSendMode
  identityId?: string
  discoveredBy: 'manual' | 'autodiscover'
  lastSyncAt?: string
  createdAt: string
  updatedAt: string
}

export interface StoredOwnerFolder extends MailboxFolderAccess {
  syncState?: string
}

export interface OwnerInventoryItem { id: string; threadId: string; remoteFolderId?: string; remoteUid?: string }

export const accessFromRights = (rights: { canRead?: boolean; canCreate?: boolean; canModify?: boolean }): MailboxAccess =>
  rights.canRead === false ? 'none' : rights.canCreate && rights.canModify ? 'write' : 'read'

export class MailboxOwnerStore {
  constructor(private readonly db: DatabaseSync, private readonly mail: MailDatabase) {
    this.migrate()
  }

  private migrate() {
    for (const table of OWNER_TABLES) {
      const columns = new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name))
      if (!columns.has('owner_id')) this.db.exec(`ALTER TABLE ${table} ADD COLUMN owner_id TEXT NOT NULL DEFAULT '${PRIMARY_MAILBOX_OWNER}'`)
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS gmail_messages_owner ON gmail_messages(account_id, owner_id);
      CREATE INDEX IF NOT EXISTS gmail_sync_items_owner ON gmail_sync_items(account_id, owner_id, status);
      CREATE TABLE IF NOT EXISTS mail_mailbox_owners (
        account_id TEXT NOT NULL REFERENCES gmail_accounts(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        provider TEXT NOT NULL,
        kind TEXT NOT NULL,
        address TEXT NOT NULL,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        error TEXT,
        send_mode TEXT NOT NULL DEFAULT 'none',
        identity_id TEXT,
        discovered_by TEXT NOT NULL DEFAULT 'manual',
        last_sync_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account_id, id)
      );
      CREATE TABLE IF NOT EXISTS mail_mailbox_owner_folders (
        account_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        folder_id TEXT NOT NULL,
        label_id TEXT,
        parent_folder_id TEXT,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        distinguished TEXT,
        access TEXT NOT NULL,
        can_create INTEGER NOT NULL DEFAULT 0,
        can_modify INTEGER NOT NULL DEFAULT 0,
        can_delete INTEGER NOT NULL DEFAULT 0,
        subscribed INTEGER,
        sync_state TEXT,
        error TEXT,
        PRIMARY KEY (account_id, owner_id, folder_id),
        FOREIGN KEY (account_id, owner_id) REFERENCES mail_mailbox_owners(account_id, id) ON DELETE CASCADE
      );
    `)
    this.db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(40, ?)').run(nowIso())
  }

  private owner(row: Row): StoredMailboxOwner {
    return {
      id: String(row.id),
      accountId: String(row.account_id),
      provider: String(row.provider) as MailboxOwnerProvider,
      kind: String(row.kind) as MailboxOwnerKind,
      address: String(row.address),
      displayName: String(row.display_name),
      status: String(row.status) as MailboxOwnerStatus,
      ...(row.error ? { error: String(row.error) } : {}),
      sendMode: String(row.send_mode) as MailboxSendMode,
      ...(row.identity_id ? { identityId: String(row.identity_id) } : {}),
      discoveredBy: row.discovered_by === 'autodiscover' ? 'autodiscover' : 'manual',
      ...(row.last_sync_at ? { lastSyncAt: String(row.last_sync_at) } : {}),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    }
  }

  private folder(row: Row): StoredOwnerFolder {
    return {
      folderId: String(row.folder_id),
      ...(row.label_id ? { labelId: String(row.label_id) } : {}),
      ...(row.parent_folder_id ? { parentFolderId: String(row.parent_folder_id) } : {}),
      name: String(row.name),
      kind: String(row.kind) as MailboxFolderKind,
      ...(row.distinguished ? { distinguished: String(row.distinguished) } : {}),
      access: String(row.access) as MailboxAccess,
      canCreate: Boolean(row.can_create),
      canModify: Boolean(row.can_modify),
      canDelete: Boolean(row.can_delete),
      ...(row.subscribed !== null && row.subscribed !== undefined ? { subscribed: Boolean(row.subscribed) } : {}),
      ...(row.sync_state ? { syncState: String(row.sync_state) } : {}),
      ...(row.error ? { error: String(row.error) } : {})
    }
  }

  get(accountId: string, ownerId: string) {
    const row = this.db.prepare('SELECT * FROM mail_mailbox_owners WHERE account_id=? AND id=?').get(accountId, ownerId) as Row | undefined
    return row ? this.owner(row) : undefined
  }

  list(accountId?: string) {
    const rows = accountId
      ? this.db.prepare('SELECT * FROM mail_mailbox_owners WHERE account_id=? ORDER BY kind, display_name').all(accountId) as Row[]
      : this.db.prepare('SELECT * FROM mail_mailbox_owners ORDER BY account_id, kind, display_name').all() as Row[]
    return rows.map((row) => this.owner(row))
  }

  save(owner: Omit<StoredMailboxOwner, 'createdAt' | 'updatedAt'> & { createdAt?: string }) {
    const timestamp = nowIso()
    this.db.prepare(`
      INSERT INTO mail_mailbox_owners(account_id,id,provider,kind,address,display_name,status,error,send_mode,identity_id,discovered_by,last_sync_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(account_id,id) DO UPDATE SET provider=excluded.provider,kind=excluded.kind,address=excluded.address,display_name=excluded.display_name,
        status=excluded.status,error=excluded.error,send_mode=excluded.send_mode,identity_id=excluded.identity_id,discovered_by=excluded.discovered_by,
        last_sync_at=excluded.last_sync_at,updated_at=excluded.updated_at
    `).run(owner.accountId, owner.id, owner.provider, owner.kind, owner.address, owner.displayName, owner.status, owner.error ?? null, owner.sendMode,
      owner.identityId ?? null, owner.discoveredBy, owner.lastSyncAt ?? null, owner.createdAt ?? timestamp, timestamp)
    return this.get(owner.accountId, owner.id)!
  }

  setStatus(accountId: string, ownerId: string, status: MailboxOwnerStatus, error?: string, synced = false) {
    this.db.prepare(`UPDATE mail_mailbox_owners SET status=?,error=?,updated_at=?${synced ? ',last_sync_at=?' : ''} WHERE account_id=? AND id=?`)
      .run(...[status, error ?? null, nowIso(), ...(synced ? [nowIso()] : []), accountId, ownerId])
  }

  folders(accountId: string, ownerId: string) {
    return (this.db.prepare('SELECT * FROM mail_mailbox_owner_folders WHERE account_id=? AND owner_id=? ORDER BY name').all(accountId, ownerId) as Row[]).map((row) => this.folder(row))
  }

  folderByLabel(accountId: string, labelId: string) {
    const row = this.db.prepare('SELECT * FROM mail_mailbox_owner_folders WHERE account_id=? AND label_id=?').get(accountId, labelId) as Row | undefined
    return row ? { ownerId: String(row.owner_id), folder: this.folder(row) } : undefined
  }

  /** Replaces the owner's folder list, keeping each surviving folder's checkpoint and subscription. */
  replaceFolders(accountId: string, ownerId: string, folders: MailboxFolderAccess[]) {
    this.mail.transaction(() => {
      const previous = new Map(this.folders(accountId, ownerId).map((folder) => [folder.folderId, folder]))
      this.db.prepare('DELETE FROM mail_mailbox_owner_folders WHERE account_id=? AND owner_id=?').run(accountId, ownerId)
      for (const folder of folders) this.writeFolder(accountId, ownerId, { ...folder, subscribed: folder.subscribed ?? previous.get(folder.folderId)?.subscribed, syncState: previous.get(folder.folderId)?.syncState })
    })
  }

  saveFolder(accountId: string, ownerId: string, folder: StoredOwnerFolder) {
    this.writeFolder(accountId, ownerId, folder)
  }

  private writeFolder(accountId: string, ownerId: string, folder: StoredOwnerFolder) {
    this.db.prepare(`
      INSERT INTO mail_mailbox_owner_folders(account_id,owner_id,folder_id,label_id,parent_folder_id,name,kind,distinguished,access,can_create,can_modify,can_delete,subscribed,sync_state,error)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(account_id,owner_id,folder_id) DO UPDATE SET label_id=excluded.label_id,parent_folder_id=excluded.parent_folder_id,name=excluded.name,kind=excluded.kind,
        distinguished=excluded.distinguished,access=excluded.access,can_create=excluded.can_create,can_modify=excluded.can_modify,can_delete=excluded.can_delete,
        subscribed=excluded.subscribed,sync_state=excluded.sync_state,error=excluded.error
    `).run(accountId, ownerId, folder.folderId, folder.labelId ?? null, folder.parentFolderId ?? null, folder.name, folder.kind, folder.distinguished ?? null, folder.access,
      folder.canCreate ? 1 : 0, folder.canModify ? 1 : 0, folder.canDelete ? 1 : 0, folder.subscribed === undefined ? null : folder.subscribed ? 1 : 0, folder.syncState ?? null, folder.error ?? null)
  }

  setFolderCheckpoint(accountId: string, ownerId: string, folderId: string, syncState: string | undefined) {
    this.db.prepare('UPDATE mail_mailbox_owner_folders SET sync_state=?,error=NULL WHERE account_id=? AND owner_id=? AND folder_id=?').run(syncState ?? null, accountId, ownerId, folderId)
  }

  setFolderAccess(accountId: string, ownerId: string, folderId: string, access: MailboxAccess, error?: string) {
    this.db.prepare(`UPDATE mail_mailbox_owner_folders SET access=?,error=?${access !== 'write' ? ',can_create=0,can_modify=0,can_delete=0' : ''} WHERE account_id=? AND owner_id=? AND folder_id=?`)
      .run(access, error ?? null, accountId, ownerId, folderId)
  }

  summary(owner: StoredMailboxOwner): MailboxOwnerSummary {
    const folders = this.folders(owner.accountId, owner.id).map(({ syncState: _syncState, ...folder }) => folder)
    const mail = folders.filter((folder) => folder.kind === 'mail' && (owner.kind !== 'public-folders' || folder.subscribed))
    const access: MailboxAccess = owner.status === 'access-removed' ? 'none'
      : mail.some((folder) => folder.access === 'write') ? 'write' : mail.some((folder) => folder.access === 'read') ? 'read' : 'none'
    return { ...owner, access, folders, heldOperations: this.heldCount(owner.accountId, owner.id) }
  }

  // --- Owner-scoped cache -------------------------------------------------------------------------

  /** Replaces only this owner's labels; the account's own labels and other owners' stay. */
  replaceLabels(accountId: string, ownerId: string, labels: MailLabel[]) {
    this.mail.transaction(() => {
      this.db.prepare('DELETE FROM gmail_labels WHERE account_id=? AND owner_id=?').run(accountId, ownerId)
      const insert = this.db.prepare('INSERT OR REPLACE INTO gmail_labels(account_id,id,name,type,color,parent_id,owner_id) VALUES(?,?,?,?,?,?,?)')
      for (const label of labels) insert.run(accountId, label.id, label.name, label.type, label.color ?? null, label.parentId ?? null, ownerId)
    })
  }

  addInventory(accountId: string, ownerId: string, items: OwnerInventoryItem[]) {
    this.mail.transaction(() => {
      const insert = this.db.prepare(`INSERT INTO gmail_sync_items(account_id,message_id,thread_id,status,remote_folder_id,remote_uid,owner_id) VALUES(?,?,?,'pending',?,?,?)
        ON CONFLICT(account_id,message_id) DO UPDATE SET remote_folder_id=excluded.remote_folder_id,remote_uid=excluded.remote_uid,owner_id=excluded.owner_id`)
      for (const item of items) insert.run(accountId, item.id, item.threadId, item.remoteFolderId ?? null, item.remoteUid ?? null, ownerId)
    })
  }

  pending(accountId: string, ownerId: string, limit: number): OwnerInventoryItem[] {
    return (this.db.prepare(`SELECT message_id,thread_id,remote_folder_id,remote_uid FROM gmail_sync_items WHERE account_id=? AND owner_id=? AND (status='pending' OR (status='failed' AND attempts<5)) ORDER BY rowid LIMIT ?`)
      .all(accountId, ownerId, limit) as Row[]).map((row) => ({
      id: String(row.message_id), threadId: String(row.thread_id),
      ...(row.remote_folder_id ? { remoteFolderId: String(row.remote_folder_id) } : {}),
      ...(row.remote_uid ? { remoteUid: String(row.remote_uid) } : {})
    }))
  }

  /** Marks a stored message (and its inventory row) as belonging to the owner. */
  tagMessage(accountId: string, ownerId: string, messageId: string) {
    this.db.prepare('UPDATE gmail_messages SET owner_id=? WHERE account_id=? AND id=?').run(ownerId, accountId, messageId)
    this.db.prepare('UPDATE gmail_sync_items SET owner_id=? WHERE account_id=? AND message_id=?').run(ownerId, accountId, messageId)
  }

  messageIds(accountId: string, ownerId: string, remoteFolderId?: string) {
    const rows = remoteFolderId
      ? this.db.prepare('SELECT id FROM gmail_messages WHERE account_id=? AND owner_id=? AND remote_folder_id=?').all(accountId, ownerId, remoteFolderId) as Row[]
      : this.db.prepare('SELECT id FROM gmail_messages WHERE account_id=? AND owner_id=?').all(accountId, ownerId) as Row[]
    return rows.map((row) => String(row.id))
  }

  /** Owners of the messages in these conversations. */
  ownersOfThreads(accountId: string, threadIds: string[]) {
    if (!threadIds.length) return new Set<string>()
    const rows = this.db.prepare(`SELECT DISTINCT owner_id FROM gmail_messages WHERE account_id=? AND thread_id IN (${threadIds.map(() => '?').join(',')})`).all(accountId, ...threadIds) as Row[]
    return new Set(rows.map((row) => String(row.owner_id)))
  }

  /** Removes every cached message, label, inventory row, and queued action of one owner. */
  purge(accountId: string, ownerId: string) {
    for (const id of this.messageIds(accountId, ownerId)) this.mail.deleteMessage(accountId, id)
    this.mail.transaction(() => {
      this.db.prepare('DELETE FROM gmail_sync_items WHERE account_id=? AND owner_id=?').run(accountId, ownerId)
      this.db.prepare('DELETE FROM gmail_labels WHERE account_id=? AND owner_id=?').run(accountId, ownerId)
      this.db.prepare(`DELETE FROM gmail_operations WHERE account_id=? AND owner_id=?`).run(accountId, ownerId)
      this.db.prepare('DELETE FROM mail_mailbox_owners WHERE account_id=? AND id=?').run(accountId, ownerId)
    })
  }

  /** Labels of other owners carry who owns them and the effective access. */
  decorateLabels(labels: MailLabel[]) {
    if (!labels.some((label) => label.id.startsWith('owner:'))) return labels
    const owners = new Map((this.db.prepare('SELECT * FROM mail_mailbox_owners').all() as Row[]).map((row) => {
      const owner = this.owner(row)
      return [`${owner.accountId}\u0000${owner.id}`, owner] as const
    }))
    const folders = new Map((this.db.prepare('SELECT account_id,owner_id,label_id,access FROM mail_mailbox_owner_folders WHERE label_id IS NOT NULL').all() as Row[])
      .map((row) => [`${row.account_id}\u0000${row.label_id}`, { ownerId: String(row.owner_id), access: String(row.access) as MailboxAccess }] as const))
    const rootAccess = new Map<string, MailboxAccess>()
    for (const { ownerId, access } of folders.values()) {
      const current = rootAccess.get(ownerId)
      if (access === 'write' || (access === 'read' && current !== 'write')) rootAccess.set(ownerId, access)
    }
    return labels.map((label) => {
      if (!label.id.startsWith('owner:')) return label
      const folder = folders.get(`${label.accountId}\u0000${label.id}`)
      const ownerId = folder?.ownerId ?? label.id.slice(6).split(':')[0]
      const owner = owners.get(`${label.accountId}\u0000${ownerId}`)
      if (!owner) return label
      const removed = owner.status === 'access-removed'
      const value: MailLabelOwner = {
        id: owner.id, kind: owner.kind, address: owner.address, displayName: owner.displayName, status: owner.status,
        access: removed ? 'none' : folder?.access ?? rootAccess.get(owner.id) ?? 'read',
        ...(folder ? {} : { root: true })
      }
      return { ...label, owner: value }
    })
  }

  // --- Queued actions -----------------------------------------------------------------------------

  tagOperation(operationId: string, ownerId: string) {
    this.db.prepare('UPDATE gmail_operations SET owner_id=? WHERE id=?').run(ownerId, operationId)
  }

  operationOwner(operationId: string) {
    const row = this.db.prepare('SELECT owner_id FROM gmail_operations WHERE id=?').get(operationId) as Row | undefined
    return row ? String(row.owner_id) : undefined
  }

  /** Stops the owner's queued actions and keeps them for review (access removed). */
  holdOperations(accountId: string, ownerId: string, reason: string) {
    const result = this.db.prepare(`UPDATE gmail_operations SET status='held',error=?,updated_at=? WHERE account_id=? AND owner_id=? AND status IN ('queued','running')`).run(reason, nowIso(), accountId, ownerId)
    return Number(result.changes)
  }

  holdOperation(operationId: string, reason: string) {
    this.db.prepare(`UPDATE gmail_operations SET status='held',error=?,updated_at=? WHERE id=?`).run(reason, nowIso(), operationId)
  }

  heldCount(accountId: string, ownerId: string) {
    return Number((this.db.prepare(`SELECT COUNT(*) count FROM gmail_operations WHERE account_id=? AND owner_id=? AND status='held'`).get(accountId, ownerId) as Row).count)
  }

  held(accountId?: string): HeldMailboxOperation[] {
    const rows = (accountId
      ? this.db.prepare(`SELECT o.*,m.display_name owner_name FROM gmail_operations o LEFT JOIN mail_mailbox_owners m ON m.account_id=o.account_id AND m.id=o.owner_id WHERE o.status='held' AND o.account_id=? ORDER BY o.created_at`).all(accountId)
      : this.db.prepare(`SELECT o.*,m.display_name owner_name FROM gmail_operations o LEFT JOIN mail_mailbox_owners m ON m.account_id=o.account_id AND m.id=o.owner_id WHERE o.status='held' ORDER BY o.created_at`).all()) as Row[]
    return rows.map((row) => ({
      id: String(row.id), accountId: String(row.account_id), ownerId: String(row.owner_id), ownerName: String(row.owner_name ?? row.owner_id),
      kind: String(row.kind), threadCount: json<string[]>(row.thread_ids_json, []).length,
      ...(row.error ? { error: String(row.error) } : {}), createdAt: String(row.created_at)
    }))
  }

  heldOperation(operationId: string) {
    return this.held().find((operation) => operation.id === operationId)
  }

  /** Sends a held action again (after access returned). */
  releaseHeld(operationId: string) {
    this.db.prepare(`UPDATE gmail_operations SET status='queued',attempts=0,error=NULL,execute_after=?,updated_at=? WHERE id=? AND status='held'`).run(nowIso(), nowIso(), operationId)
  }
}
