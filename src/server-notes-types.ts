import type { Note } from './types'

// Server-synchronized Notes (docs/server-notes.md). A note belongs to exactly one owner: Local
// (the existing local Notes, saved with the local module snapshot) or a provider folder: a CalDAV
// collection that holds VJOURNAL entries, or an Exchange Notes (IPF.StickyNote) folder. Provider
// notes are cached in server-notes.sqlite with a durable write queue and conflict review; they never
// enter the local snapshot, and copying or moving between owners is always explicit.

export type ServerNotesProvider = 'dav' | 'exchange'
export type ServerNotesAccountStatus = 'ready' | 'syncing' | 'needs-auth' | 'error'

export interface ServerNotesAccount {
  id: string
  provider: ServerNotesProvider
  name: string
  status: ServerNotesAccountStatus
  error?: string
  lastSyncedAt?: string
  /** Queued changes not yet accepted by the server. */
  pendingWrites: number
}

export interface ServerNoteFolder {
  id: string
  accountId: string
  provider: ServerNotesProvider
  name: string
  color?: string
  /** No write privilege (DAV current-user-privilege-set, EWS EffectiveRights). */
  readOnly: boolean
  /** A CalDAV collection that also holds events or tasks; only its VJOURNAL entries appear in Notes. */
  mixed?: boolean
  lastSyncedAt?: string
  error?: string
}

export type ServerNoteSyncState = 'synced' | 'pending' | 'review'

export interface ServerNoteOwner {
  provider: ServerNotesProvider
  accountId: string
  folderId: string
}

/**
 * A provider note as the renderer shows it. `folder` holds the folder's display name. Color,
 * pinning, and archive are kept on this computer only; every other field is synchronized.
 */
export interface ServerNote extends Note {
  owner: ServerNoteOwner
  readOnly: boolean
  sync: ServerNoteSyncState
}

export type ServerNoteReviewStatus = 'conflict' | 'failed' | 'held'

/** A local change the server did not accept. Nothing is overwritten until the user chooses. */
export interface ServerNoteReviewItem {
  id: string
  noteId: string
  accountId: string
  folderId: string
  action: 'create' | 'update' | 'delete'
  status: ServerNoteReviewStatus
  title: string
  serverTitle?: string
  serverExcerpt?: string
  mineExcerpt?: string
  error: string
  serverDeleted: boolean
  /** Whether the server still has a version that "keep both" can keep beside a copy of yours. */
  canKeepBoth: boolean
  updatedAt: string
}

/**
 * keep-mine sends your version again against the server's current revision; keep-server discards
 * your change; keep-both keeps the server version and saves yours as a separate note in the same
 * folder; copy-local discards the change on the server side and saves your version as a Local note.
 */
export type ServerNoteResolution = 'keep-mine' | 'keep-server' | 'keep-both' | 'copy-local'

export interface ServerNotesSnapshot {
  accounts: ServerNotesAccount[]
  folders: ServerNoteFolder[]
  notes: ServerNote[]
  review: ServerNoteReviewItem[]
}

/** Where a note goes: a Local folder (by name) or a provider folder (by id). */
export type NoteOwnerTarget = { kind: 'local'; folder: string } | { kind: 'server'; folderId: string }

export interface NoteTransferRequest {
  mode: 'copy' | 'move'
  target: NoteOwnerTarget
  /** Provider notes, by id. */
  serverNoteIds?: string[]
  /** Local notes as the renderer currently holds them. */
  localNotes?: Note[]
}

export interface NoteTransferResult {
  /** New Local notes to add (their files are already copied into the note-attachment store). */
  localNotes: Note[]
  /** Local source notes to delete now that their move finished. */
  removeLocalIds: string[]
  /** Notes copied to the target. */
  copied: number
  /** Moves whose source was kept because the server has not confirmed the new copy yet. */
  pendingMoves: number
  errors: string[]
}

export interface VNotePreviewEntry {
  index: number
  title: string
  excerpt: string
  created?: string
  modified?: string
  luid?: string
  error?: string
  /** An existing note in the chosen folder that this entry duplicates. */
  duplicate?: { noteId: string; title: string; reason: 'luid' | 'content' }
}

export interface VNotePreview {
  token: string
  fileName: string
  count: number
  valid: number
  duplicates: number
  errors: string[]
  entries: VNotePreviewEntry[]
}

export type VNoteDuplicateMode = 'skip' | 'replace' | 'copy'

export interface VNoteImportRequest {
  token: string
  target: NoteOwnerTarget
  duplicates: VNoteDuplicateMode
}

export interface VNoteImportResult {
  /** New Local notes to add. */
  localNotes: Note[]
  /** Local notes whose body was replaced by an imported duplicate (same ids). */
  replacedLocal: Note[]
  imported: number
  replaced: number
  skipped: number
  failed: number
  errors: string[]
}

export interface ServerNotesAccountSummary {
  accountId: string
  notes: number
  pendingWrites: number
  review: number
}

export interface ServerNotesDesktopApi {
  snapshot(): Promise<ServerNotesSnapshot>
  onChanged(callback: (snapshot: ServerNotesSnapshot) => void): () => void
  /** Synchronizes one account, or every account when no id is given. */
  sync(accountId?: string): Promise<ServerNotesSnapshot>
  create(folderId: string, note: Note): Promise<ServerNote>
  update(note: Note): Promise<ServerNote>
  remove(noteId: string): Promise<ServerNotesSnapshot>
  resolve(reviewId: string, resolution: ServerNoteResolution): Promise<{ localNotes: Note[] }>
  transfer(request: NoteTransferRequest): Promise<NoteTransferResult>
  /** Opens a .vnt file and previews it against the chosen folder; undefined when cancelled. */
  chooseVNoteFile(target: NoteOwnerTarget): Promise<VNotePreview | undefined>
  /** Recomputes duplicates for a previewed file and another folder. */
  previewVNote(token: string, target: NoteOwnerTarget): Promise<VNotePreview>
  importVNote(request: VNoteImportRequest): Promise<VNoteImportResult>
  accountSummary(accountId: string): Promise<ServerNotesAccountSummary>
  /** Copies every note of an account (including unsent changes) into Local Notes before removal. */
  copyAccountToLocal(accountId: string): Promise<{ copied: number }>
}
