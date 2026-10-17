import { DatabaseSync } from 'node:sqlite'
import type { ServerNoteReviewStatus, ServerNotesAccountStatus, ServerNotesProvider } from '../../src/server-notes-types'

// Server-synchronized Notes cache (server-notes.sqlite, docs/server-notes.md): provider folders with
// their sync state, the last server copy of every note (raw VJOURNAL text for CalDAV, so properties
// Aerio does not model survive edits), local-only display state, a durable queue of local writes,
// the managed files those notes use, and vNote import identities. Credentials are never stored here.

export interface ServerNotesAccountRecord {
  id: string
  provider: ServerNotesProvider
  name: string
  status: ServerNotesAccountStatus
  error?: string
  lastSyncedAt?: string
}

export interface ServerNoteFolderRecord {
  id: string
  accountId: string
  provider: ServerNotesProvider
  /** DAV collection URL or EWS FolderId. */
  remoteId: string
  name: string
  color?: string
  readOnly: boolean
  mixed?: boolean
  /** Provider sync checkpoint: JSON { syncToken, ctag, supportsSyncCollection } for DAV, the SyncState for EWS. */
  syncState?: string
  lastSyncedAt?: string
  error?: string
}

/** A managed file referenced by a provider note. `remoteId` is the EWS AttachmentId. */
export interface StoredNoteAttachment {
  id: string
  name: string
  mime: string
  size: number
  inline: boolean
  sha256: string
  path: string
  remoteId?: string
}

/** The synchronized fields of a note. `html` uses data-aerio-note-image ids (docs/rich-notes.md). */
export interface StoredNoteFields {
  title: string
  content: string
  html?: string
  tags: string[]
  attachments: StoredNoteAttachment[]
  created?: string
  modified?: string
  classification?: 'PUBLIC' | 'PRIVATE' | 'CONFIDENTIAL'
  /** EWS item element name (Message, PostItem, Item) for UpdateItem. */
  itemType?: string
}

/** One server copy of a note: its address, revision (ETag or ChangeKey), and raw body when kept. */
export interface ServerNoteCopy {
  remoteId: string
  revision?: string
  raw?: string
  fields: StoredNoteFields
}

export interface ServerNoteRecord extends ServerNoteCopy {
  id: string
  folderId: string
  accountId: string
  updatedAt: string
}

export interface ServerNoteMeta {
  color?: string
  pinned: boolean
  archived: boolean
}

/** What a queued write sends. `extraLines` are extra VJOURNAL properties (vNote X- properties) for a create. */
export interface NoteDraft extends StoredNoteFields {
  extraLines?: string[]
}

export type ServerNoteOperationStatus = 'queued' | ServerNoteReviewStatus

export interface ServerNoteOperationRecord {
  id: string
  accountId: string
  folderId: string
  noteId: string
  action: 'create' | 'update' | 'delete'
  /** The note as the user left it (create/update). */
  draft?: NoteDraft
  /** The server copy the change was made against (update/delete). */
  base?: ServerNoteCopy
  /** CalDAV: the member URL chosen for a create, so a retry never creates a second copy. */
  plannedRemoteId?: string
  status: ServerNoteOperationStatus
  error?: string
  attempts: number
  nextAttemptAt?: string
  /** What the server held when the write was refused. */
  server?: ServerNoteCopy
  serverDeleted?: boolean
  /** Copy-then-move: the provider note to delete once this create is accepted. */
  moveSourceNoteId?: string
  createdAt: string
  updatedAt: string
}

interface PayloadRow { payload_json: string }

export const SERVER_NOTES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS server_note_accounts (
    id TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS server_note_folders (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_server_note_folders_account ON server_note_folders(account_id);
  CREATE TABLE IF NOT EXISTS server_notes (
    id TEXT PRIMARY KEY,
    folder_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    remote_id TEXT NOT NULL,
    revision TEXT,
    ignored INTEGER NOT NULL DEFAULT 0,
    payload_json TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_server_notes_remote ON server_notes(folder_id, remote_id);
  CREATE INDEX IF NOT EXISTS idx_server_notes_account ON server_notes(account_id);
  CREATE TABLE IF NOT EXISTS server_note_meta (
    note_id TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS server_note_operations (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    folder_id TEXT NOT NULL,
    note_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('queued','conflict','failed','held')),
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_server_note_operations_note ON server_note_operations(note_id);
  CREATE INDEX IF NOT EXISTS idx_server_note_operations_account ON server_note_operations(account_id, status);
  CREATE TABLE IF NOT EXISTS server_note_files (
    path TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_server_note_files_sha ON server_note_files(sha256);
  CREATE TABLE IF NOT EXISTS vnote_imports (
    owner TEXT NOT NULL,
    luid TEXT NOT NULL,
    note_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(owner, luid)
  );
`

interface NoteRow { id: string; folder_id: string; account_id: string; remote_id: string; revision: string | null; ignored: number; payload_json: string | null; updated_at: string }

const noteFromRow = (row: NoteRow): ServerNoteRecord & { ignored: boolean } => {
  const payload = row.payload_json ? JSON.parse(row.payload_json) as { raw?: string; fields: StoredNoteFields } : undefined
  return {
    id: row.id, folderId: row.folder_id, accountId: row.account_id, remoteId: row.remote_id,
    ...(row.revision !== null ? { revision: row.revision } : {}),
    ...(payload?.raw !== undefined ? { raw: payload.raw } : {}),
    fields: payload?.fields ?? { title: '', content: '', tags: [], attachments: [] },
    ignored: Boolean(row.ignored), updatedAt: row.updated_at
  }
}

export class ServerNotesStore {
  private readonly db: DatabaseSync
  private depth = 0

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; ${SERVER_NOTES_SCHEMA}`)
  }

  close() { this.db.close() }

  // --- Accounts and folders ---------------------------------------------------------------------

  accounts(): ServerNotesAccountRecord[] {
    return (this.db.prepare('SELECT payload_json FROM server_note_accounts ORDER BY rowid').all() as unknown as PayloadRow[]).map((row) => JSON.parse(row.payload_json) as ServerNotesAccountRecord)
  }

  account(id: string) {
    const row = this.db.prepare('SELECT payload_json FROM server_note_accounts WHERE id=?').get(id) as unknown as PayloadRow | undefined
    return row ? JSON.parse(row.payload_json) as ServerNotesAccountRecord : undefined
  }

  saveAccount(account: ServerNotesAccountRecord) {
    this.db.prepare(`INSERT INTO server_note_accounts(id,payload_json,updated_at) VALUES(?,?,?)
      ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at`).run(account.id, JSON.stringify(account), new Date().toISOString())
  }

  /** Removes everything cached for an account; returns the managed file paths that may now be unused. */
  removeAccount(id: string) {
    this.transaction(() => {
      for (const note of this.notes({ accountId: id })) this.db.prepare('DELETE FROM server_note_meta WHERE note_id=?').run(note.id)
      for (const operation of this.operations({ accountId: id })) this.db.prepare('DELETE FROM server_note_meta WHERE note_id=?').run(operation.noteId)
      this.db.prepare('DELETE FROM server_notes WHERE account_id=?').run(id)
      this.db.prepare('DELETE FROM server_note_operations WHERE account_id=?').run(id)
      for (const folder of this.folders(id)) this.db.prepare('DELETE FROM vnote_imports WHERE owner=?').run(folder.id)
      this.db.prepare('DELETE FROM server_note_folders WHERE account_id=?').run(id)
      this.db.prepare('DELETE FROM server_note_accounts WHERE id=?').run(id)
    })
  }

  folders(accountId?: string): ServerNoteFolderRecord[] {
    const rows = accountId
      ? this.db.prepare('SELECT payload_json FROM server_note_folders WHERE account_id=? ORDER BY rowid').all(accountId)
      : this.db.prepare('SELECT payload_json FROM server_note_folders ORDER BY rowid').all()
    return (rows as unknown as PayloadRow[]).map((row) => JSON.parse(row.payload_json) as ServerNoteFolderRecord)
  }

  folder(id: string) {
    const row = this.db.prepare('SELECT payload_json FROM server_note_folders WHERE id=?').get(id) as unknown as PayloadRow | undefined
    return row ? JSON.parse(row.payload_json) as ServerNoteFolderRecord : undefined
  }

  saveFolder(folder: ServerNoteFolderRecord) {
    this.db.prepare(`INSERT INTO server_note_folders(id,account_id,payload_json,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at`).run(folder.id, folder.accountId, JSON.stringify(folder), new Date().toISOString())
  }

  removeFolder(id: string) {
    this.transaction(() => {
      for (const note of this.notes({ folderId: id })) this.db.prepare('DELETE FROM server_note_meta WHERE note_id=?').run(note.id)
      this.db.prepare('DELETE FROM server_notes WHERE folder_id=?').run(id)
      this.db.prepare('DELETE FROM vnote_imports WHERE owner=?').run(id)
      this.db.prepare('DELETE FROM server_note_folders WHERE id=?').run(id)
    })
  }

  // --- Notes --------------------------------------------------------------------------------------

  notes(filter: { accountId?: string; folderId?: string; includeIgnored?: boolean } = {}): (ServerNoteRecord & { ignored: boolean })[] {
    const clauses: string[] = []
    const values: string[] = []
    if (filter.accountId) { clauses.push('account_id=?'); values.push(filter.accountId) }
    if (filter.folderId) { clauses.push('folder_id=?'); values.push(filter.folderId) }
    if (!filter.includeIgnored) clauses.push('ignored=0')
    const sql = `SELECT * FROM server_notes ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY rowid`
    return (this.db.prepare(sql).all(...values) as unknown as NoteRow[]).map(noteFromRow)
  }

  note(id: string) {
    const row = this.db.prepare('SELECT * FROM server_notes WHERE id=?').get(id) as unknown as NoteRow | undefined
    return row && !row.ignored ? noteFromRow(row) : undefined
  }

  noteByRemote(folderId: string, remoteId: string) {
    const row = this.db.prepare('SELECT * FROM server_notes WHERE folder_id=? AND remote_id=?').get(folderId, remoteId) as unknown as NoteRow | undefined
    return row ? noteFromRow(row) : undefined
  }

  /** Last-seen revisions for a folder, including entries Notes ignores (events in a mixed collection). */
  revisions(folderId: string) {
    const rows = this.db.prepare('SELECT remote_id,revision FROM server_notes WHERE folder_id=?').all(folderId) as unknown as { remote_id: string; revision: string | null }[]
    return new Map(rows.map((row) => [row.remote_id, row.revision ?? undefined]))
  }

  saveNote(note: ServerNoteRecord) {
    this.db.prepare(`INSERT INTO server_notes(id,folder_id,account_id,remote_id,revision,ignored,payload_json,updated_at) VALUES(?,?,?,?,?,0,?,?)
      ON CONFLICT(id) DO UPDATE SET folder_id=excluded.folder_id,remote_id=excluded.remote_id,revision=excluded.revision,ignored=0,payload_json=excluded.payload_json,updated_at=excluded.updated_at`)
      .run(note.id, note.folderId, note.accountId, note.remoteId, note.revision ?? null, JSON.stringify({ ...(note.raw !== undefined ? { raw: note.raw } : {}), fields: note.fields }), note.updatedAt)
  }

  /** Records a member Notes does not show (a VEVENT/VTODO in a mixed collection) so it is not fetched again. */
  saveIgnored(id: string, folderId: string, accountId: string, remoteId: string, revision: string | undefined) {
    this.db.prepare(`INSERT INTO server_notes(id,folder_id,account_id,remote_id,revision,ignored,payload_json,updated_at) VALUES(?,?,?,?,?,1,NULL,?)
      ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,ignored=1,payload_json=NULL,updated_at=excluded.updated_at`).run(id, folderId, accountId, remoteId, revision ?? null, new Date().toISOString())
  }

  removeNote(id: string) {
    this.db.prepare('DELETE FROM server_notes WHERE id=?').run(id)
  }

  removeNoteByRemote(folderId: string, remoteId: string) {
    const row = this.db.prepare('SELECT id FROM server_notes WHERE folder_id=? AND remote_id=?').get(folderId, remoteId) as unknown as { id: string } | undefined
    if (row) this.removeNote(row.id)
    return row?.id
  }

  meta(noteId: string): ServerNoteMeta {
    const row = this.db.prepare('SELECT payload_json FROM server_note_meta WHERE note_id=?').get(noteId) as unknown as PayloadRow | undefined
    return row ? JSON.parse(row.payload_json) as ServerNoteMeta : { pinned: false, archived: false }
  }

  saveMeta(noteId: string, meta: ServerNoteMeta) {
    this.db.prepare(`INSERT INTO server_note_meta(note_id,payload_json) VALUES(?,?) ON CONFLICT(note_id) DO UPDATE SET payload_json=excluded.payload_json`).run(noteId, JSON.stringify(meta))
  }

  removeMeta(noteId: string) {
    this.db.prepare('DELETE FROM server_note_meta WHERE note_id=?').run(noteId)
  }

  // --- Durable write queue ------------------------------------------------------------------------

  operations(filter: { accountId?: string; folderId?: string; status?: ServerNoteOperationStatus[] } = {}): ServerNoteOperationRecord[] {
    const clauses: string[] = []
    const values: string[] = []
    if (filter.accountId) { clauses.push('account_id=?'); values.push(filter.accountId) }
    if (filter.folderId) { clauses.push('folder_id=?'); values.push(filter.folderId) }
    if (filter.status?.length) { clauses.push(`status IN (${filter.status.map(() => '?').join(',')})`); values.push(...filter.status) }
    const sql = `SELECT payload_json FROM server_note_operations ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at, rowid`
    return (this.db.prepare(sql).all(...values) as unknown as PayloadRow[]).map((row) => JSON.parse(row.payload_json) as ServerNoteOperationRecord)
  }

  operation(id: string) {
    const row = this.db.prepare('SELECT payload_json FROM server_note_operations WHERE id=?').get(id) as unknown as PayloadRow | undefined
    return row ? JSON.parse(row.payload_json) as ServerNoteOperationRecord : undefined
  }

  operationFor(noteId: string) {
    const row = this.db.prepare('SELECT payload_json FROM server_note_operations WHERE note_id=?').get(noteId) as unknown as PayloadRow | undefined
    return row ? JSON.parse(row.payload_json) as ServerNoteOperationRecord : undefined
  }

  saveOperation(operation: ServerNoteOperationRecord) {
    this.db.prepare(`INSERT INTO server_note_operations(id,account_id,folder_id,note_id,status,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET folder_id=excluded.folder_id,status=excluded.status,payload_json=excluded.payload_json,updated_at=excluded.updated_at`)
      .run(operation.id, operation.accountId, operation.folderId, operation.noteId, operation.status, JSON.stringify(operation), operation.createdAt, operation.updatedAt)
  }

  deleteOperation(id: string) {
    this.db.prepare('DELETE FROM server_note_operations WHERE id=?').run(id)
  }

  // --- Managed files ------------------------------------------------------------------------------

  fileBySha(sha256: string) {
    const row = this.db.prepare('SELECT path FROM server_note_files WHERE sha256=? ORDER BY created_at LIMIT 1').get(sha256) as unknown as { path: string } | undefined
    return row?.path
  }

  hasFile(path: string) {
    return Boolean(this.db.prepare('SELECT 1 FROM server_note_files WHERE path=?').get(path))
  }

  registerFile(path: string, sha256: string, size: number) {
    this.db.prepare('INSERT INTO server_note_files(path,sha256,size,created_at) VALUES(?,?,?,?) ON CONFLICT(path) DO UPDATE SET sha256=excluded.sha256,size=excluded.size').run(path, sha256, size, new Date().toISOString())
  }

  files() {
    return (this.db.prepare('SELECT path FROM server_note_files').all() as unknown as { path: string }[]).map((row) => row.path)
  }

  forgetFile(path: string) {
    this.db.prepare('DELETE FROM server_note_files WHERE path=?').run(path)
  }

  // --- vNote import identities ------------------------------------------------------------------

  importedNote(owner: string, luid: string) {
    const row = this.db.prepare('SELECT note_id FROM vnote_imports WHERE owner=? AND luid=?').get(owner, luid) as unknown as { note_id: string } | undefined
    return row?.note_id
  }

  saveImport(owner: string, luid: string, noteId: string) {
    this.db.prepare('INSERT INTO vnote_imports(owner,luid,note_id,created_at) VALUES(?,?,?,?) ON CONFLICT(owner,luid) DO UPDATE SET note_id=excluded.note_id').run(owner, luid, noteId, new Date().toISOString())
  }

  // Re-entrant: nested calls join the outer transaction so composite updates stay atomic.
  transaction(work: () => void) {
    if (this.depth > 0) {
      this.depth++
      try { work() } finally { this.depth-- }
      return
    }
    this.db.exec('BEGIN IMMEDIATE')
    this.depth = 1
    try {
      work()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    } finally {
      this.depth = 0
    }
  }
}

export const RESTORED_SERVER_NOTES_MESSAGE = 'Restored from a profile backup. Sign in to the account again to resume synchronizing its notes.'
export const RESTORED_SERVER_NOTES_WRITE_MESSAGE = 'Held after restoring a profile backup. Send it again if the change is still needed.'

/** Profile-restore preparation: accounts wait for sign-in, and restored writes wait for review. */
export function prepareRestoredServerNotesDatabase(db: DatabaseSync) {
  db.exec(SERVER_NOTES_SCHEMA)
  const timestamp = new Date().toISOString()
  for (const row of db.prepare('SELECT id,payload_json FROM server_note_accounts').all() as unknown as { id: string; payload_json: string }[]) {
    const account = JSON.parse(row.payload_json) as ServerNotesAccountRecord
    db.prepare('UPDATE server_note_accounts SET payload_json=?,updated_at=? WHERE id=?').run(JSON.stringify({ ...account, status: 'needs-auth', error: RESTORED_SERVER_NOTES_MESSAGE }), timestamp, row.id)
  }
  let held = 0
  for (const row of db.prepare(`SELECT id,payload_json FROM server_note_operations WHERE status='queued'`).all() as unknown as { id: string; payload_json: string }[]) {
    const operation = JSON.parse(row.payload_json) as ServerNoteOperationRecord
    db.prepare(`UPDATE server_note_operations SET status='held',payload_json=?,updated_at=? WHERE id=?`).run(JSON.stringify({ ...operation, status: 'held', error: RESTORED_SERVER_NOTES_WRITE_MESSAGE, updatedAt: timestamp }), timestamp, row.id)
    held++
  }
  return { held }
}
