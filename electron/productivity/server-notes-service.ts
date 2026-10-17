import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import type { LocalModuleSnapshot } from '../../src/productivity-types'
import type {
  NoteOwnerTarget, NoteTransferRequest, NoteTransferResult, ServerNote, ServerNoteFolder, ServerNoteResolution, ServerNoteReviewItem,
  ServerNotesAccountSummary, ServerNotesProvider, ServerNotesSnapshot, VNoteDuplicateMode, VNoteImportResult, VNotePreview, VNotePreviewEntry
} from '../../src/server-notes-types'
import type { Attachment, Note } from '../../src/types'
import { NOTE_FILE_ATTACHMENT_LIMIT, NOTE_INLINE_IMAGE_LIMIT, noteHtmlToText } from '../../src/lib/note-rich-text'
import { escapeText, formatParam } from '../../src/lib/content-lines'
import { parseVNotes, vnoteExcerpt, vnoteFingerprint, type ParsedVNote } from '../../src/lib/vnote'
import { NOTE_HTML_MAX_LENGTH, sanitizeStoredNoteHtml } from './note-rich-body'
import {
  changedFields, NoteAuthError, NoteConflictError, NoteMissingError, NoteTransientError, sha256, shortHash, type NotesAdapter, type RemoteNote
} from './server-notes-adapter'
import type {
  NoteDraft, ServerNoteCopy, ServerNoteFolderRecord, ServerNoteMeta, ServerNoteOperationRecord, ServerNoteRecord, ServerNotesStore,
  StoredNoteAttachment, StoredNoteFields
} from './server-notes-store'

// Server-synchronized Notes (docs/server-notes.md). Provider folders (CalDAV VJOURNAL collections
// and Exchange Notes folders) are cached in server-notes.sqlite. Every local change is saved in a
// durable queue and shown at once, then sent conditionally (If-Match / ChangeKey with
// NeverOverwrite). A refused write waits in review with the server's current copy; nothing is
// overwritten until the user chooses keep mine, keep server, keep both, or copy to Local.
// Copying and moving between owners always copy files; a move deletes its source only after the
// new copy exists (accepted by the server, or saved in Local Notes).

const RETRY_BASE_MS = 30_000
const RETRY_MAX_MS = 30 * 60_000
const PREVIEW_TTL_MS = 30 * 60_000
const MAX_FILE_BYTES = 25 * 1024 * 1024

export interface ServerNotesProviderAccount {
  id: string
  provider: ServerNotesProvider
  name: string
  /** The provider already knows the credentials are missing or rejected. */
  needsAuth?: boolean
}

export interface ServerNotesServiceOptions {
  store: ServerNotesStore
  /** Accounts that can hold notes (CalDAV accounts and Exchange accounts). */
  accounts(): ServerNotesProviderAccount[]
  /** A provider client for the account; throws NoteAuthError when its credentials are missing. */
  adapter(account: ServerNotesProviderAccount): NotesAdapter
  /** The managed note-attachment directory shared with Local notes (docs/rich-notes.md). */
  attachmentsDirectory: string
  /** The saved Local notes, used to keep their files separate and to find vNote duplicates. */
  localSnapshot(): LocalModuleSnapshot
  online?(): boolean
  now?(): Date
  changed?(): void
  /** Delay before queued edits are sent; negative disables automatic sending (tests). */
  flushDelayMs?: number
  diagnostic?(record: { level: 'info' | 'warn' | 'error'; event: string; accountId?: string; message?: string; details?: Record<string, unknown> }): void
}

export class ServerNoteWriteBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ServerNoteWriteBlockedError'
  }
}

const message = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback).slice(0, 500)
const folderKey = (accountId: string, remoteId: string) => `${accountId}:notes:${shortHash(remoteId.replace(/\/+$/, ''))}`
const remoteNoteId = (folderId: string, remoteId: string) => `srvnote-${shortHash(`${folderId}\u0000${remoteId}`)}`
const newNoteId = () => `srvnote-${randomUUID()}`
const text = (value: unknown, max: number) => typeof value === 'string' && value.length <= max

/** Validates a note from the renderer before it is queued for a server. */
export function parseNoteInput(value: unknown): Note {
  const note = value as Note | null
  if (!note || typeof note !== 'object' || !text(note.id, 300) || !note.id || !text(note.title, 10_000) || !text(note.content, 10_000_000) ||
    !Array.isArray(note.tags) || note.tags.length > 200 || !note.tags.every((tag) => text(tag, 500)) || (note.html !== undefined && !text(note.html, NOTE_HTML_MAX_LENGTH)) ||
    (note.color !== undefined && !text(note.color, 100)) || (note.pinned !== undefined && typeof note.pinned !== 'boolean') || (note.archived !== undefined && typeof note.archived !== 'boolean') ||
    (note.folder !== undefined && !text(note.folder, 300)) || (note.updatedAt !== undefined && !text(note.updatedAt, 100)) ||
    (note.attachments !== undefined && (!Array.isArray(note.attachments) || note.attachments.length > NOTE_FILE_ATTACHMENT_LIMIT + NOTE_INLINE_IMAGE_LIMIT ||
      !note.attachments.every((attachment) => attachment && text(attachment.id, 300) && attachment.id && text(attachment.name, 1_000) && Number.isFinite(attachment.size) &&
        (attachment.path === undefined || text(attachment.path, 32_767)) && (attachment.mime === undefined || text(attachment.mime, 200)) && (attachment.inline === undefined || typeof attachment.inline === 'boolean'))))) {
    throw new Error('The note is invalid')
  }
  return note
}

export class ServerNotesService {
  private readonly locks = new Map<string, Promise<unknown>>()
  private readonly flushTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly previews = new Map<string, { fileName: string; notes: ParsedVNote[]; errors: string[]; createdAt: number }>()

  constructor(private readonly options: ServerNotesServiceOptions) {}

  private get store() { return this.options.store }
  private now() { return this.options.now?.() ?? new Date() }
  private changed() { this.options.changed?.() }

  dispose() {
    for (const timer of this.flushTimers.values()) clearTimeout(timer)
    this.flushTimers.clear()
  }

  private exclusive<T>(accountId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(accountId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(work)
    this.locks.set(accountId, next)
    void next.finally(() => { if (this.locks.get(accountId) === next) this.locks.delete(accountId) }).catch(() => undefined)
    return next
  }

  private providerAccount(accountId: string) {
    return this.options.accounts().find((account) => account.id === accountId)
  }

  // --- Snapshot -----------------------------------------------------------------------------------

  private presentFields(id: string, folder: ServerNoteFolderRecord, fields: StoredNoteFields, updatedAt: string, sync: ServerNote['sync']): ServerNote {
    const meta = this.store.meta(id)
    return {
      id, folder: folder.name, title: fields.title, content: fields.content, ...(fields.html !== undefined ? { html: fields.html } : {}),
      tags: fields.tags, pinned: meta.pinned, archived: meta.archived, ...(meta.color ? { color: meta.color } : {}), updatedAt,
      ...(fields.attachments.length ? { attachments: fields.attachments.map((attachment): Attachment => ({ id: attachment.id, name: attachment.name, size: attachment.size, path: attachment.path, mime: attachment.mime, ...(attachment.inline ? { inline: true } : {}) })) } : {}),
      owner: { provider: folder.provider, accountId: folder.accountId, folderId: folder.id }, readOnly: folder.readOnly, sync
    }
  }

  /** Server copies with pending local writes applied, for one folder. */
  private folderNotes(folder: ServerNoteFolderRecord): ServerNote[] {
    const notes = new Map<string, ServerNote>()
    for (const record of this.store.notes({ folderId: folder.id })) notes.set(record.id, this.presentFields(record.id, folder, record.fields, record.fields.modified ?? record.updatedAt, 'synced'))
    for (const operation of this.store.operations({ folderId: folder.id })) {
      const sync = operation.status === 'queued' ? 'pending' : 'review'
      if (operation.action === 'delete') {
        if (operation.status === 'queued') notes.delete(operation.noteId)
        else if (notes.has(operation.noteId)) notes.set(operation.noteId, { ...notes.get(operation.noteId)!, sync })
      } else if (operation.draft) notes.set(operation.noteId, this.presentFields(operation.noteId, folder, operation.draft, operation.updatedAt, sync))
    }
    return [...notes.values()]
  }

  private effective(noteId: string) {
    const operation = this.store.operationFor(noteId)
    const record = this.store.note(noteId)
    const folder = this.store.folder(operation?.folderId ?? record?.folderId ?? '')
    if (!folder || (!record && !operation?.draft) || (operation?.action === 'delete' && operation.status === 'queued')) return undefined
    const fields = operation?.draft ?? record!.fields
    return { folder, record, operation, fields }
  }

  private presentNote(noteId: string) {
    const current = this.effective(noteId)
    if (!current) throw new Error('That note is no longer available')
    return this.presentFields(noteId, current.folder, current.fields, current.operation?.updatedAt ?? current.fields.modified ?? current.record!.updatedAt, current.operation ? (current.operation.status === 'queued' ? 'pending' : 'review') : 'synced')
  }

  snapshot(): ServerNotesSnapshot {
    const operations = this.store.operations()
    const provider = this.options.accounts()
    const names = new Map(provider.map((account) => [account.id, account]))
    const folders = this.store.folders().filter((folder) => names.has(folder.accountId))
    const review: ServerNoteReviewItem[] = operations.filter((operation) => operation.status !== 'queued').map((operation) => {
      const mine = operation.draft ?? operation.base?.fields
      return {
        id: operation.id, noteId: operation.noteId, accountId: operation.accountId, folderId: operation.folderId, action: operation.action,
        status: operation.status as ServerNoteReviewItem['status'], title: mine?.title || 'Untitled note',
        ...(operation.server ? { serverTitle: operation.server.fields.title, serverExcerpt: operation.server.fields.content.replace(/\s+/g, ' ').trim().slice(0, 160) } : {}),
        ...(mine ? { mineExcerpt: mine.content.replace(/\s+/g, ' ').trim().slice(0, 160) } : {}),
        error: operation.error ?? 'This change needs review', serverDeleted: Boolean(operation.serverDeleted),
        canKeepBoth: operation.action !== 'delete' && Boolean(operation.draft) && Boolean(operation.server) && Boolean(this.store.folder(operation.folderId)),
        updatedAt: operation.updatedAt
      }
    })
    return {
      accounts: provider.map((account) => {
        const stored = this.store.account(account.id)
        return {
          id: account.id, provider: account.provider, name: account.name,
          status: account.needsAuth ? 'needs-auth' : stored?.status ?? 'ready',
          ...(account.needsAuth ? { error: stored?.error ?? 'Sign in to this account again to synchronize its notes' } : stored?.error ? { error: stored.error } : {}),
          ...(stored?.lastSyncedAt ? { lastSyncedAt: stored.lastSyncedAt } : {}),
          pendingWrites: operations.filter((operation) => operation.accountId === account.id && operation.status === 'queued').length
        }
      }),
      folders: folders.map((folder): ServerNoteFolder => ({
        id: folder.id, accountId: folder.accountId, provider: folder.provider, name: folder.name, readOnly: folder.readOnly,
        ...(folder.color ? { color: folder.color } : {}), ...(folder.mixed ? { mixed: true } : {}),
        ...(folder.lastSyncedAt ? { lastSyncedAt: folder.lastSyncedAt } : {}), ...(folder.error ? { error: folder.error } : {})
      })),
      notes: folders.flatMap((folder) => this.folderNotes(folder)),
      review
    }
  }

  accountSummary(accountId: string): ServerNotesAccountSummary {
    const operations = this.store.operations({ accountId })
    return {
      accountId,
      notes: this.store.folders(accountId).reduce((total, folder) => total + this.folderNotes(folder).length, 0),
      pendingWrites: operations.filter((operation) => operation.status === 'queued').length,
      review: operations.filter((operation) => operation.status !== 'queued').length
    }
  }

  // --- Managed files ------------------------------------------------------------------------------

  private managedPath(path: string) {
    const root = resolve(this.options.attachmentsDirectory)
    const nested = relative(root, resolve(path))
    return Boolean(nested) && !nested.startsWith('..') && !isAbsolute(nested)
  }

  private newPath(name: string) {
    mkdirSync(this.options.attachmentsDirectory, { recursive: true })
    const extension = extname(name).replace(/[^.A-Za-z0-9]/g, '')
    return join(this.options.attachmentsDirectory, `${randomUUID()}${extension.length <= 12 ? extension : ''}`)
  }

  /** Writes provider bytes once per content hash and registers the file as owned by server notes. */
  private storeBytes(bytes: Buffer, name: string) {
    const hash = sha256(bytes)
    const existing = this.store.fileBySha(hash)
    if (existing && existsSync(existing)) return { path: existing, sha256: hash, size: bytes.byteLength }
    const path = this.newPath(name)
    writeFileSync(path, bytes, { mode: 0o600 })
    this.store.registerFile(path, hash, bytes.byteLength)
    return { path, sha256: hash, size: bytes.byteLength }
  }

  private localPaths(snapshot = this.options.localSnapshot()) {
    return new Set(snapshot.notes.flatMap((note) => note.attachments ?? []).flatMap((attachment) => attachment.path ? [resolve(attachment.path)] : []))
  }

  /** Copies a managed file to a new path that the caller owns (a Local note or a new server note). */
  private copyFile(path: string, name: string) {
    if (!this.managedPath(path) || !existsSync(path)) throw new Error(`The attachment “${name}” is no longer available`)
    const target = this.newPath(name)
    copyFileSync(path, target)
    return target
  }

  /**
   * Turns renderer attachments into stored ones. Files the server notes already own are reused;
   * files of Local notes (or of a note being copied) are duplicated so each owner keeps its own.
   */
  private adoptAttachments(attachments: Attachment[] | undefined, previous: StoredNoteAttachment[], forceCopy: boolean) {
    const known = new Map(previous.map((attachment) => [attachment.id, attachment]))
    let localPaths: Set<string> | undefined
    const files = (attachments ?? []).filter((attachment) => !attachment.inline)
    const inline = (attachments ?? []).filter((attachment) => attachment.inline)
    if (files.length > NOTE_FILE_ATTACHMENT_LIMIT) throw new Error(`A note can contain up to ${NOTE_FILE_ATTACHMENT_LIMIT} attachments`)
    if (inline.length > NOTE_INLINE_IMAGE_LIMIT) throw new Error(`A note can contain up to ${NOTE_INLINE_IMAGE_LIMIT} pictures`)
    return (attachments ?? []).map((attachment): StoredNoteAttachment => {
      const prior = known.get(attachment.id)
      if (!forceCopy && prior && attachment.path && resolve(prior.path) === resolve(attachment.path)) return { ...prior, name: attachment.name.slice(0, 255) || prior.name, inline: Boolean(attachment.inline) }
      if (!attachment.path || !this.managedPath(attachment.path) || !existsSync(attachment.path)) throw new Error(`The attachment “${attachment.name}” is no longer available`)
      const stat = statSync(attachment.path)
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error(`“${attachment.name}” must be a file no larger than 25 MB`)
      localPaths ??= this.localPaths()
      const owned = this.store.hasFile(attachment.path)
      const path = forceCopy || (!owned && localPaths.has(resolve(attachment.path))) ? this.copyFile(attachment.path, attachment.name) : attachment.path
      const bytes = readFileSync(path)
      const hash = sha256(bytes)
      this.store.registerFile(path, hash, bytes.byteLength)
      return { id: attachment.id, name: attachment.name.slice(0, 255) || 'Attachment', mime: attachment.mime || 'application/octet-stream', size: bytes.byteLength, inline: Boolean(attachment.inline), sha256: hash, path, ...(prior?.remoteId && prior.sha256 === hash ? { remoteId: prior.remoteId } : {}) }
    })
  }

  /** Stores the attachments of a provider copy; unchanged ones keep their files. */
  private materialize(remote: RemoteNote, previous?: StoredNoteFields): ServerNoteCopy {
    const prior = previous?.attachments ?? []
    const attachments: StoredNoteAttachment[] = []
    for (const attachment of remote.fields.attachments) {
      if (attachment.content) {
        const stored = this.storeBytes(attachment.content, attachment.name)
        attachments.push({ id: attachment.id, name: attachment.name, mime: attachment.mime, inline: attachment.inline, ...stored, ...(attachment.remoteId ? { remoteId: attachment.remoteId } : {}) })
        continue
      }
      const reused = prior.find((item) => (attachment.remoteId && item.remoteId === attachment.remoteId) || item.id === attachment.id)
      if (reused && existsSync(reused.path)) attachments.push({ ...reused, id: attachment.id, name: attachment.name, mime: attachment.mime, inline: attachment.inline, ...(attachment.remoteId ? { remoteId: attachment.remoteId } : {}) })
    }
    // A picture whose file could not be stored is removed from the body rather than left dangling.
    const inlineIds = new Set(attachments.filter((attachment) => attachment.inline).map((attachment) => attachment.id))
    const html = remote.fields.html !== undefined ? sanitizeStoredNoteHtml(remote.fields.html, inlineIds) : undefined
    return {
      remoteId: remote.remoteId, ...(remote.revision ? { revision: remote.revision } : {}), ...(remote.raw !== undefined ? { raw: remote.raw } : {}),
      fields: { ...remote.fields, ...(html !== undefined ? { html, content: noteHtmlToText(html) } : {}), attachments }
    }
  }

  private readAttachment = (attachment: StoredNoteAttachment) => {
    if (!this.managedPath(attachment.path) || !existsSync(attachment.path)) throw new Error(`The attachment “${attachment.name}” is no longer available`)
    return readFileSync(attachment.path)
  }

  /** Deletes managed files that no provider note, queued change, or Local note references any more. */
  cleanupFiles() {
    const referenced = new Set<string>()
    const add = (fields: StoredNoteFields | undefined) => { for (const attachment of fields?.attachments ?? []) referenced.add(resolve(attachment.path)) }
    for (const note of this.store.notes()) add(note.fields)
    for (const operation of this.store.operations()) { add(operation.draft); add(operation.base?.fields); add(operation.server?.fields) }
    let local: Set<string>
    try { local = this.localPaths() } catch { return }
    for (const path of this.store.files()) {
      const resolved = resolve(path)
      if (referenced.has(resolved)) continue
      this.store.forgetFile(path)
      if (local.has(resolved) || !this.managedPath(path)) continue
      try { if (existsSync(path)) unlinkSync(path) } catch { /* The next cleanup can retry a file in use. */ }
    }
  }

  // --- Synchronization ----------------------------------------------------------------------------

  sync(accountId: string) {
    return this.exclusive(accountId, () => this.syncNow(accountId))
  }

  async syncAll() {
    for (const account of this.options.accounts()) {
      if (account.needsAuth) continue
      await this.sync(account.id).catch(() => undefined)
    }
  }

  /** Sends queued writes for one account now. */
  flushAccount(accountId: string) {
    return this.exclusive(accountId, async () => {
      const account = this.providerAccount(accountId)
      if (!account || account.needsAuth || (this.options.online && !this.options.online())) return
      if (!this.store.operations({ accountId, status: ['queued'] }).length) return
      let adapter: NotesAdapter | undefined
      try {
        adapter = this.options.adapter(account)
        await this.flush(accountId, adapter)
      } catch (error) {
        if (error instanceof NoteAuthError) this.saveStatus(account, { status: 'needs-auth', error: error.message })
      } finally {
        adapter?.close?.()
        this.cleanupFiles()
        this.changed()
      }
    })
  }

  async flushAll() {
    for (const account of this.options.accounts()) await this.flushAccount(account.id).catch(() => undefined)
  }

  private scheduleFlush(accountId: string) {
    const delay = this.options.flushDelayMs ?? 2_000
    if (delay < 0) return
    clearTimeout(this.flushTimers.get(accountId))
    const timer = setTimeout(() => {
      this.flushTimers.delete(accountId)
      void this.flushAccount(accountId).catch(() => undefined)
    }, delay)
    timer.unref?.()
    this.flushTimers.set(accountId, timer)
  }

  private saveStatus(account: ServerNotesProviderAccount, patch: Partial<{ status: 'ready' | 'syncing' | 'needs-auth' | 'error'; error: string | undefined; lastSyncedAt: string }>) {
    const current = this.store.account(account.id) ?? { id: account.id, provider: account.provider, name: account.name, status: 'ready' as const }
    this.store.saveAccount({ ...current, name: account.name, provider: account.provider, ...patch })
  }

  private async syncNow(accountId: string) {
    const account = this.providerAccount(accountId)
    if (!account) throw new Error('That account is no longer connected')
    if (this.options.online && !this.options.online()) throw new NoteTransientError('Aerio is offline; note changes will be sent when the connection returns')
    this.saveStatus(account, { status: 'syncing' })
    this.changed()
    let adapter: NotesAdapter | undefined
    try {
      adapter = this.options.adapter(account)
      await this.flush(accountId, adapter)
      await this.refreshFolders(account, adapter)
      let pulled = 0
      for (const folder of this.store.folders(accountId)) {
        try { pulled += await this.pullFolder(adapter, folder) } catch (error) {
          if (error instanceof NoteAuthError || error instanceof NoteTransientError) throw error
          this.store.saveFolder({ ...(this.store.folder(folder.id) ?? folder), error: message(error, 'This notes folder could not be synchronized') })
          this.options.diagnostic?.({ level: 'warn', event: 'server-notes-folder-sync-failed', accountId, message: message(error, '') })
        }
      }
      this.saveStatus(account, { status: 'ready', error: undefined, lastSyncedAt: this.now().toISOString() })
      this.options.diagnostic?.({ level: 'info', event: 'server-notes-sync-complete', accountId, details: { provider: account.provider, changes: pulled } })
    } catch (error) {
      const auth = error instanceof NoteAuthError
      this.saveStatus(account, { status: auth ? 'needs-auth' : 'error', error: message(error, 'Notes could not be synchronized') })
      this.options.diagnostic?.({ level: 'error', event: 'server-notes-sync-failed', accountId, message: message(error, '') })
      throw error
    } finally {
      adapter?.close?.()
      this.cleanupFiles()
      this.changed()
    }
  }

  private async refreshFolders(account: ServerNotesProviderAccount, adapter: NotesAdapter) {
    const discovered = await adapter.listFolders()
    const existing = new Map(this.store.folders(account.id).map((folder) => [folder.remoteId.replace(/\/+$/, ''), folder]))
    const seen = new Set<string>()
    for (const found of discovered) {
      const key = found.remoteId.replace(/\/+$/, '')
      seen.add(key)
      const previous = existing.get(key)
      this.store.saveFolder({
        id: previous?.id ?? folderKey(account.id, found.remoteId), accountId: account.id, provider: account.provider, remoteId: found.remoteId,
        name: found.name.slice(0, 200) || 'Notes', ...(found.color ? { color: found.color } : {}), readOnly: found.readOnly, ...(found.mixed ? { mixed: true } : {}),
        ...(previous?.syncState ? { syncState: previous.syncState } : {}), ...(previous?.lastSyncedAt ? { lastSyncedAt: previous.lastSyncedAt } : {}), ...(previous?.error ? { error: previous.error } : {})
      })
    }
    for (const [key, folder] of existing) {
      if (seen.has(key)) continue
      // Unsent changes for a folder that disappeared stay in review rather than vanishing.
      for (const operation of this.store.operations({ folderId: folder.id })) {
        this.store.saveOperation({ ...operation, status: 'failed', error: 'This notes folder was removed on the server. Copy your version to Local Notes or discard it.', updatedAt: this.now().toISOString() })
      }
      this.store.removeFolder(folder.id)
    }
  }

  private async pullFolder(adapter: NotesAdapter, initial: ServerNoteFolderRecord) {
    const result = await adapter.pull(initial, this.store.revisions(initial.id), (remoteId) => this.store.noteByRemote(initial.id, remoteId)?.fields)
    const timestamp = this.now().toISOString()
    this.store.transaction(() => {
      for (const remote of result.changed) {
        const existing = this.store.noteByRemote(initial.id, remote.remoteId)
        const id = existing && !existing.ignored ? existing.id : existing?.id ?? remoteNoteId(initial.id, remote.remoteId)
        const copy = this.materialize(remote, existing?.fields)
        this.store.saveNote({ ...copy, id, folderId: initial.id, accountId: initial.accountId, updatedAt: timestamp })
      }
      for (const remoteId of result.removed) {
        const id = this.store.removeNoteByRemote(initial.id, remoteId)
        const operation = id ? this.store.operationFor(id) : undefined
        // A queued delete of a note that is already gone is complete.
        if (operation?.action === 'delete' && operation.status === 'queued') { this.store.deleteOperation(operation.id); this.store.removeMeta(operation.noteId) }
        else if (id && !operation) this.store.removeMeta(id)
      }
      for (const item of result.ignored) this.store.saveIgnored(remoteNoteId(initial.id, item.remoteId), initial.id, initial.accountId, item.remoteId, item.revision)
      this.store.saveFolder({ ...(this.store.folder(initial.id) ?? initial), ...(result.syncState !== undefined ? { syncState: result.syncState } : {}), lastSyncedAt: timestamp, error: undefined })
    })
    return result.changed.length + result.removed.length
  }

  // --- Durable write queue ------------------------------------------------------------------------

  private async flush(accountId: string, adapter: NotesAdapter) {
    if (this.options.online && !this.options.online()) return
    const now = this.now()
    for (const initial of this.store.operations({ accountId, status: ['queued'] })) {
      const operation = this.store.operation(initial.id)
      if (!operation || operation.status !== 'queued') continue
      if (operation.nextAttemptAt && Date.parse(operation.nextAttemptAt) > now.getTime()) continue
      try {
        await this.send(adapter, operation)
      } catch (error) {
        if (error instanceof NoteAuthError) throw error
        const transient = error instanceof NoteTransientError
        const attempts = operation.attempts + 1
        this.store.saveOperation({
          ...operation, attempts, updatedAt: now.toISOString(), error: message(error, 'The change could not be sent'),
          ...(transient ? { nextAttemptAt: new Date(now.getTime() + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 10))).toISOString() } : { status: 'failed' as const })
        })
        this.options.diagnostic?.({ level: 'warn', event: 'server-notes-write-failed', accountId, message: message(error, ''), details: { action: operation.action, transient } })
        // Offline or busy: keep every later write queued in order.
        if (transient) return
      }
    }
  }

  private async send(adapter: NotesAdapter, operation: ServerNoteOperationRecord) {
    const folder = this.store.folder(operation.folderId)
    if (!folder) throw new Error('This notes folder no longer exists on the server')
    const timestamp = this.now().toISOString()
    try {
      if (operation.action === 'delete') {
        await adapter.remove(folder, operation.base!)
        this.store.transaction(() => {
          this.store.removeNote(operation.noteId)
          this.store.removeMeta(operation.noteId)
          this.store.deleteOperation(operation.id)
        })
        return
      }
      const remote = operation.action === 'create'
        ? await adapter.create(folder, operation.draft!, this.readAttachment, operation.plannedRemoteId)
        : await adapter.update(folder, operation.base!, operation.draft!, this.readAttachment)
      const copy = this.materialize(remote, operation.draft)
      let source: string | undefined
      this.store.transaction(() => {
        this.store.saveNote({ ...copy, id: operation.noteId, folderId: folder.id, accountId: folder.accountId, updatedAt: timestamp })
        this.store.deleteOperation(operation.id)
        source = operation.moveSourceNoteId
      })
      // Copy-then-move: the source is deleted only now that the server accepted the copy.
      if (source) {
        try { this.queueDelete(source) } catch (error) {
          this.options.diagnostic?.({ level: 'warn', event: 'server-notes-move-source-kept', accountId: folder.accountId, message: message(error, '') })
        }
      }
    } catch (error) {
      if (error instanceof NoteConflictError || error instanceof NoteMissingError) return this.conflict(adapter, folder, operation, error)
      throw error
    }
  }

  // Refused or vanished: record what the server holds now and wait for the user's decision.
  private async conflict(adapter: NotesAdapter, folder: ServerNoteFolderRecord, operation: ServerNoteOperationRecord, error: Error) {
    const remoteId = operation.base?.remoteId ?? operation.plannedRemoteId
    const current = remoteId ? await adapter.fetch(folder, remoteId, operation.base?.fields) : undefined
    const server = current ? this.materialize(current, operation.base?.fields) : undefined
    const deleted = !server && operation.action !== 'create'
    if (deleted && operation.action === 'delete') {
      // Deleting a note someone else already deleted needs no review.
      this.store.transaction(() => {
        this.store.removeNote(operation.noteId)
        this.store.removeMeta(operation.noteId)
        this.store.deleteOperation(operation.id)
      })
      return
    }
    this.store.saveOperation({
      ...operation, status: 'conflict', error: deleted ? 'Deleted on the server since you edited it' : error.message,
      ...(server ? { server } : {}), serverDeleted: deleted, nextAttemptAt: undefined, updatedAt: this.now().toISOString()
    })
    this.options.diagnostic?.({ level: 'warn', event: 'server-notes-conflict', accountId: folder.accountId, details: { action: operation.action, serverDeleted: deleted } })
  }

  // --- Local edits --------------------------------------------------------------------------------

  private draftFrom(note: Note, previous: StoredNoteFields | undefined, forceCopy = false): NoteDraft {
    const attachments = this.adoptAttachments(note.attachments, previous?.attachments ?? [], forceCopy)
    const inlineIds = new Set(attachments.filter((attachment) => attachment.inline).map((attachment) => attachment.id))
    const html = note.html !== undefined ? sanitizeStoredNoteHtml(note.html, inlineIds) : undefined
    const tags = [...new Set(note.tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 100)
    return {
      title: note.title.slice(0, 10_000), content: html !== undefined ? noteHtmlToText(html) : note.content, ...(html !== undefined ? { html } : {}),
      tags, attachments,
      ...(previous?.created ? { created: previous.created } : {}), ...(previous?.classification ? { classification: previous.classification } : {}),
      ...(previous?.itemType ? { itemType: previous.itemType } : {})
    }
  }

  private writableFolder(folderId: string) {
    const folder = this.store.folder(folderId)
    if (!folder || !this.providerAccount(folder.accountId)) throw new Error('That notes folder is no longer available')
    if (folder.readOnly) throw new ServerNoteWriteBlockedError('This notes folder is read-only')
    return folder
  }

  private saveMetaFrom(noteId: string, note: Partial<Note>) {
    const meta: ServerNoteMeta = { pinned: Boolean(note.pinned), archived: Boolean(note.archived), ...(note.color ? { color: note.color } : {}) }
    this.store.saveMeta(noteId, meta)
  }

  /** CalDAV member URLs are chosen before the first attempt so a retry can never create a second copy. */
  private plannedRemoteId(folder: ServerNoteFolderRecord) {
    return folder.provider === 'dav' ? new URL(encodeURIComponent(`${randomUUID()}.ics`), folder.remoteId.endsWith('/') ? folder.remoteId : `${folder.remoteId}/`).toString() : undefined
  }

  private enqueueCreate(folder: ServerNoteFolderRecord, noteId: string, draft: NoteDraft, extras: Partial<ServerNoteOperationRecord> = {}) {
    const timestamp = this.now().toISOString()
    const planned = this.plannedRemoteId(folder)
    this.store.saveOperation({
      id: `note-op-${randomUUID()}`, accountId: folder.accountId, folderId: folder.id, noteId, action: 'create', draft,
      ...(planned ? { plannedRemoteId: planned } : {}),
      status: 'queued', attempts: 0, createdAt: timestamp, updatedAt: timestamp, ...extras
    })
  }

  /** Creates a note in a provider folder; it is queued and sent shortly after. */
  async create(folderId: string, input: Note, extras: { extraLines?: string[]; classification?: NoteDraft['classification']; created?: string } = {}) {
    const note = parseNoteInput(input)
    const folder = this.writableFolder(folderId)
    const noteId = newNoteId()
    const draft: NoteDraft = { ...this.draftFrom(note, undefined), ...(extras.extraLines?.length && folder.provider === 'dav' ? { extraLines: extras.extraLines } : {}), ...(extras.classification ? { classification: extras.classification } : {}), ...(extras.created ? { created: extras.created } : {}) }
    this.store.transaction(() => {
      this.enqueueCreate(folder, noteId, draft)
      this.saveMetaFrom(noteId, note)
    })
    this.scheduleFlush(folder.accountId)
    this.changed()
    return this.presentNote(noteId)
  }

  /** Saves an edit. Color, pinning, and archive stay on this computer; other changes are queued. */
  async update(input: Note) {
    const note = parseNoteInput(input)
    const current = this.effective(note.id)
    if (!current) throw new Error('That note is no longer available')
    const { folder, record, operation } = current
    this.saveMetaFrom(note.id, note)
    const draft = this.draftFrom(note, current.fields)
    const edits = changedFields(current.fields, draft)
    if (edits.title || edits.body || edits.tags || edits.attachments) {
      if (folder.readOnly) throw new ServerNoteWriteBlockedError('This notes folder is read-only')
      if (operation && operation.status !== 'queued') throw new ServerNoteWriteBlockedError('This note has a synchronization conflict. Resolve it in Notes › Review first.')
      const timestamp = this.now().toISOString()
      if (operation) this.store.saveOperation({ ...operation, draft: { ...draft, ...(operation.draft?.extraLines ? { extraLines: operation.draft.extraLines } : {}) }, attempts: 0, nextAttemptAt: undefined, error: undefined, updatedAt: timestamp })
      else {
        this.store.saveOperation({
          id: `note-op-${randomUUID()}`, accountId: folder.accountId, folderId: folder.id, noteId: note.id, action: 'update', draft,
          base: { remoteId: record!.remoteId, ...(record!.revision ? { revision: record!.revision } : {}), ...(record!.raw !== undefined ? { raw: record!.raw } : {}), fields: record!.fields },
          status: 'queued', attempts: 0, createdAt: timestamp, updatedAt: timestamp
        })
      }
      this.scheduleFlush(folder.accountId)
      if (edits.attachments) this.cleanupFiles()
    }
    this.changed()
    return this.presentNote(note.id)
  }

  private queueDelete(noteId: string) {
    const current = this.effective(noteId)
    if (!current) return
    const { folder, record, operation } = current
    if (folder.readOnly) throw new ServerNoteWriteBlockedError('This notes folder is read-only')
    if (operation && operation.status !== 'queued') throw new ServerNoteWriteBlockedError('This note has a synchronization conflict. Resolve it in Notes › Review first.')
    const timestamp = this.now().toISOString()
    if (operation?.action === 'create') {
      // A never-sent note simply disappears.
      this.store.transaction(() => { this.store.deleteOperation(operation.id); this.store.removeMeta(noteId) })
    } else if (operation) {
      this.store.saveOperation({ ...operation, action: 'delete', draft: undefined, attempts: 0, nextAttemptAt: undefined, error: undefined, updatedAt: timestamp })
    } else if (record) {
      this.store.saveOperation({
        id: `note-op-${randomUUID()}`, accountId: folder.accountId, folderId: folder.id, noteId, action: 'delete',
        base: { remoteId: record.remoteId, ...(record.revision ? { revision: record.revision } : {}), ...(record.raw !== undefined ? { raw: record.raw } : {}), fields: record.fields },
        status: 'queued', attempts: 0, createdAt: timestamp, updatedAt: timestamp
      })
    }
    this.scheduleFlush(folder.accountId)
  }

  async remove(noteId: string) {
    if (typeof noteId !== 'string' || !noteId) throw new Error('Choose a note')
    if (!this.effective(noteId)) throw new Error('That note is no longer available')
    this.queueDelete(noteId)
    this.cleanupFiles()
    this.changed()
  }

  // --- Conflict review ----------------------------------------------------------------------------

  /** A Local note from a provider version; its files are copied so Local owns them. */
  private localCopy(fields: StoredNoteFields, folder: string, meta?: ServerNoteMeta, title = fields.title): Note {
    const attachments = fields.attachments.flatMap((attachment): Attachment[] => {
      try { return [{ id: attachment.id, name: attachment.name, size: attachment.size, mime: attachment.mime, path: this.copyFile(attachment.path, attachment.name), ...(attachment.inline ? { inline: true } : {}) }] }
      catch { return [] }
    })
    const inlineIds = new Set(attachments.filter((attachment) => attachment.inline).map((attachment) => attachment.id))
    const html = fields.html !== undefined ? sanitizeStoredNoteHtml(fields.html, inlineIds) : undefined
    return {
      id: `note-${randomUUID()}`, folder: folder.slice(0, 300) || 'Personal', title: title.slice(0, 10_000), content: html !== undefined ? noteHtmlToText(html) : fields.content,
      ...(html !== undefined ? { html } : {}), tags: fields.tags, pinned: Boolean(meta?.pinned), archived: Boolean(meta?.archived), ...(meta?.color ? { color: meta.color } : {}),
      updatedAt: this.now().toISOString(), ...(attachments.length ? { attachments } : {})
    }
  }

  resolve(reviewId: string, resolution: ServerNoteResolution): Promise<{ localNotes: Note[] }> {
    const initial = this.store.operation(reviewId)
    if (!initial || initial.status === 'queued') throw new Error('That change no longer needs review')
    if (!['keep-mine', 'keep-server', 'keep-both', 'copy-local'].includes(resolution)) throw new Error('Choose how to resolve the change')
    return this.exclusive(initial.accountId, async () => {
      const operation = this.store.operation(reviewId)
      if (!operation || operation.status === 'queued') return { localNotes: [] }
      const folder = this.store.folder(operation.folderId)
      const timestamp = this.now().toISOString()
      const localNotes: Note[] = []
      const acceptServer = () => {
        if (operation.serverDeleted) { this.store.removeNote(operation.noteId); this.store.removeMeta(operation.noteId) }
        else if (operation.server && folder) this.store.saveNote({ ...operation.server, id: operation.noteId, folderId: folder.id, accountId: folder.accountId, updatedAt: timestamp })
        else if (operation.action === 'create') this.store.removeMeta(operation.noteId)
        this.store.deleteOperation(operation.id)
      }
      if (resolution === 'keep-server') {
        this.store.transaction(acceptServer)
      } else if (resolution === 'copy-local') {
        const fields = operation.draft ?? operation.base?.fields
        if (fields) localNotes.push(this.localCopy(fields, folder?.name ?? 'Personal', this.store.meta(operation.noteId)))
        this.store.transaction(acceptServer)
      } else if (resolution === 'keep-both') {
        if (!folder || !operation.draft || !operation.server) throw new Error('Keep both needs your version and the server version')
        if (folder.readOnly) throw new ServerNoteWriteBlockedError('This notes folder is read-only')
        const draft = { ...operation.draft, title: `${operation.draft.title} (my copy)`.slice(0, 10_000) }
        const copyId = newNoteId()
        const meta = this.store.meta(operation.noteId)
        this.store.transaction(() => {
          acceptServer()
          this.enqueueCreate(folder, copyId, { ...draft, attachments: draft.attachments })
          this.store.saveMeta(copyId, meta)
        })
      } else {
        if (!folder) throw new Error('This notes folder no longer exists on the server. Copy your version to Local Notes instead.')
        if (folder.readOnly) throw new ServerNoteWriteBlockedError('This notes folder is read-only. Copy your version to Local Notes instead.')
        if (operation.serverDeleted && operation.action === 'delete') this.store.transaction(acceptServer)
        else {
          // Send again against the server's current revision, still conditionally: a newer change
          // made meanwhile produces another conflict instead of being overwritten.
          // A create that collided with another item, or an edit of a note deleted on the server,
          // is created again at a new address; nothing at the old address is overwritten.
          const recreate = operation.action === 'create' || Boolean(operation.serverDeleted)
          const base = operation.server ?? operation.base
          this.store.transaction(() => {
            if (recreate) this.store.removeNote(operation.noteId)
            else if (operation.server) this.store.saveNote({ ...operation.server, id: operation.noteId, folderId: folder.id, accountId: folder.accountId, updatedAt: timestamp })
            this.store.saveOperation({
              ...operation, status: 'queued', action: recreate ? 'create' : operation.action,
              ...(recreate ? { base: undefined, plannedRemoteId: this.plannedRemoteId(folder) } : { base }),
              error: undefined, attempts: 0, nextAttemptAt: undefined, server: undefined, serverDeleted: false, updatedAt: timestamp
            })
          })
        }
      }
      this.options.diagnostic?.({ level: 'info', event: 'server-notes-review-resolved', accountId: operation.accountId, details: { resolution, action: operation.action } })
      const account = this.providerAccount(operation.accountId)
      if (account && !account.needsAuth && resolution !== 'keep-server' && resolution !== 'copy-local') {
        try { const adapter = this.options.adapter(account); try { await this.flush(operation.accountId, adapter) } finally { adapter.close?.() } } catch { /* Stays queued. */ }
      }
      this.cleanupFiles()
      this.changed()
      return { localNotes }
    })
  }

  // --- Copy and move between owners ---------------------------------------------------------------

  /** Copies notes between Local and provider folders; a move removes its source only after the copy exists. */
  async transfer(request: NoteTransferRequest): Promise<NoteTransferResult> {
    if (!request || typeof request !== 'object' || (request.mode !== 'copy' && request.mode !== 'move')) throw new Error('Choose copy or move')
    const target = parseTarget(request.target)
    const result: NoteTransferResult = { localNotes: [], removeLocalIds: [], copied: 0, pendingMoves: 0, errors: [] }
    const serverIds = Array.isArray(request.serverNoteIds) ? request.serverNoteIds.filter((id): id is string => typeof id === 'string').slice(0, 1_000) : []
    const localNotes = Array.isArray(request.localNotes) ? request.localNotes.slice(0, 1_000).map(parseNoteInput) : []
    const targetFolder = target.kind === 'server' ? this.writableFolder(target.folderId) : undefined
    const created: { noteId: string; localSource?: string }[] = []
    for (const note of localNotes) {
      if (!targetFolder) { result.errors.push(`“${note.title}” is already a Local note`); continue }
      try {
        const noteId = newNoteId()
        const draft = this.draftFrom(note, undefined, true)
        this.store.transaction(() => { this.enqueueCreate(targetFolder, noteId, draft); this.saveMetaFrom(noteId, note) })
        created.push({ noteId, ...(request.mode === 'move' ? { localSource: note.id } : {}) })
        result.copied++
      } catch (error) { result.errors.push(`“${note.title}”: ${message(error, 'could not be copied')}`) }
    }
    for (const id of serverIds) {
      const current = this.effective(id)
      if (!current) { result.errors.push('A note is no longer available'); continue }
      if (request.mode === 'move' && current.operation && current.operation.status !== 'queued') { result.errors.push(`“${current.fields.title}” has a synchronization conflict; resolve it first`); continue }
      if (request.mode === 'move' && current.folder.readOnly) { result.errors.push(`“${current.fields.title}” is in a read-only folder; copy it instead`); continue }
      if (targetFolder?.id === current.folder.id) { result.errors.push(`“${current.fields.title}” is already in ${targetFolder.name}`); continue }
      try {
        if (!targetFolder) {
          result.localNotes.push(this.localCopy(current.fields, target.kind === 'local' ? target.folder : current.folder.name, this.store.meta(id)))
          result.copied++
          if (request.mode === 'move') this.pendingLocalMoves.set(result.localNotes[result.localNotes.length - 1].id, id)
          continue
        }
        const noteId = newNoteId()
        const presented = this.presentNote(id)
        const draft = { ...this.draftFrom(presented, undefined, true), ...(current.fields.created ? { created: current.fields.created } : {}), ...(current.fields.classification ? { classification: current.fields.classification } : {}) }
        this.store.transaction(() => {
          this.enqueueCreate(targetFolder, noteId, draft, request.mode === 'move' ? { moveSourceNoteId: id } : {})
          this.store.saveMeta(noteId, this.store.meta(id))
        })
        created.push({ noteId })
        result.copied++
      } catch (error) { result.errors.push(`“${current.fields.title}”: ${message(error, 'could not be copied')}`) }
    }
    if (targetFolder && created.length) {
      // Try to send at once so a move can finish while the user watches.
      await this.flushAccount(targetFolder.accountId).catch(() => undefined)
      for (const item of created) {
        const pending = this.store.operationFor(item.noteId)
        if (request.mode !== 'move') continue
        if (!pending) { if (item.localSource) result.removeLocalIds.push(item.localSource) }
        else result.pendingMoves++
      }
      for (const account of new Set(serverIds.map((id) => this.store.note(id)?.accountId ?? this.store.operationFor(id)?.accountId).filter((value): value is string => Boolean(value)))) this.scheduleFlush(account)
    }
    this.cleanupFiles()
    this.changed()
    return result
  }

  // Server → Local moves: the source is deleted once the Local copy is saved (see localSaved).
  private readonly pendingLocalMoves = new Map<string, string>()

  /** Called after the Local notes are saved; finishes moves whose Local copy now exists. */
  localSaved(snapshot: LocalModuleSnapshot) {
    if (!this.pendingLocalMoves.size) return
    const saved = new Set(snapshot.notes.map((note) => note.id))
    let changed = false
    for (const [localId, sourceId] of [...this.pendingLocalMoves]) {
      if (!saved.has(localId)) continue
      this.pendingLocalMoves.delete(localId)
      try { this.queueDelete(sourceId); changed = true } catch (error) {
        this.options.diagnostic?.({ level: 'warn', event: 'server-notes-move-source-kept', message: message(error, '') })
      }
    }
    if (changed) this.changed()
  }

  /** Every note of an account (with unsent changes) as Local notes, before the account is removed. */
  copyAccountToLocal(accountId: string) {
    const notes: Note[] = []
    const account = this.providerAccount(accountId)
    for (const folder of this.store.folders(accountId)) {
      for (const note of this.folderNotes(folder)) {
        const current = this.effective(note.id)
        if (!current) continue
        notes.push(this.localCopy(current.fields, account ? `${folder.name} (${account.name})` : folder.name, this.store.meta(note.id)))
      }
    }
    // Unsent creates in a folder that disappeared are kept too.
    for (const operation of this.store.operations({ accountId }).filter((item) => !this.store.folder(item.folderId) && item.draft)) {
      notes.push(this.localCopy(operation.draft!, account?.name ?? 'Recovered notes', this.store.meta(operation.noteId)))
    }
    return notes
  }

  removeAccount(accountId: string) {
    clearTimeout(this.flushTimers.get(accountId))
    this.flushTimers.delete(accountId)
    this.store.removeAccount(accountId)
    this.cleanupFiles()
    this.options.diagnostic?.({ level: 'info', event: 'server-notes-account-removed', accountId })
    this.changed()
  }

  // --- vNote import -------------------------------------------------------------------------------

  /** Parses a .vnt file and previews it against a folder. */
  previewVNoteFile(bytes: Uint8Array, fileName: string, target: NoteOwnerTarget): VNotePreview {
    const parsed = parseVNotes(bytes)
    const token = randomUUID()
    const nowMs = Date.now()
    for (const [key, value] of this.previews) if (nowMs - value.createdAt > PREVIEW_TTL_MS) this.previews.delete(key)
    this.previews.set(token, { fileName: fileName.slice(0, 255), notes: parsed.notes, errors: parsed.errors, createdAt: nowMs })
    return this.previewVNote(token, target)
  }

  private ownerKey(target: NoteOwnerTarget) { return target.kind === 'local' ? 'local' : target.folderId }

  private candidates(target: NoteOwnerTarget) {
    // Local folders are labels on one Local owner, so duplicates are found across all Local notes.
    if (target.kind === 'local') return this.options.localSnapshot().notes
    const folder = this.store.folder(target.folderId)
    if (!folder) throw new Error('That notes folder is no longer available')
    return this.folderNotes(folder)
  }

  private duplicateOf(entry: ParsedVNote, target: NoteOwnerTarget, candidates: Note[]) {
    if (entry.error) return undefined
    const byId = new Map(candidates.map((note) => [note.id, note]))
    const linked = entry.luid ? this.store.importedNote(this.ownerKey(target), entry.luid) : undefined
    if (linked && byId.has(linked)) return { noteId: linked, title: byId.get(linked)!.title, reason: 'luid' as const }
    const fingerprint = vnoteFingerprint(entry.title, entry.body)
    const match = candidates.find((note) => vnoteFingerprint(note.title, note.content) === fingerprint)
    return match ? { noteId: match.id, title: match.title, reason: 'content' as const } : undefined
  }

  previewVNote(token: string, input: NoteOwnerTarget): VNotePreview {
    const preview = this.previews.get(token)
    if (!preview) throw new Error('Choose the vNote file again')
    const target = parseTarget(input)
    const candidates = this.candidates(target)
    const entries = preview.notes.map((entry): VNotePreviewEntry => {
      const duplicate = this.duplicateOf(entry, target, candidates)
      return {
        index: entry.index, title: entry.title || 'Untitled note', excerpt: vnoteExcerpt(entry.body),
        ...(entry.created ? { created: entry.created } : {}), ...(entry.modified ? { modified: entry.modified } : {}), ...(entry.luid ? { luid: entry.luid } : {}),
        ...(entry.error ? { error: entry.error } : {}), ...(duplicate ? { duplicate } : {})
      }
    })
    return {
      token, fileName: preview.fileName, count: entries.length, valid: entries.filter((entry) => !entry.error).length,
      duplicates: entries.filter((entry) => entry.duplicate).length,
      errors: [...preview.errors, ...preview.notes.filter((entry) => entry.warning).map((entry) => `Note ${entry.index}: ${entry.warning}`)], entries
    }
  }

  private vnoteExtraLines(entry: ParsedVNote) {
    return entry.extras.map((extra) => `${extra.name}${Object.entries(extra.params).map(([name, values]) => formatParam(name, values)).join('')}:${escapeText(extra.value)}`)
  }

  async importVNote(request: { token: string; target: NoteOwnerTarget; duplicates: VNoteDuplicateMode }): Promise<VNoteImportResult> {
    const preview = this.previews.get(request?.token)
    if (!preview) throw new Error('Choose the vNote file again')
    if (!['skip', 'replace', 'copy'].includes(request.duplicates)) throw new Error('Choose how to handle duplicates')
    const target = parseTarget(request.target)
    const owner = this.ownerKey(target)
    const candidates = this.candidates(target)
    const result: VNoteImportResult = { localNotes: [], replacedLocal: [], imported: 0, replaced: 0, skipped: 0, failed: 0, errors: [] }
    const timestamp = this.now().toISOString()
    for (const entry of preview.notes) {
      if (entry.error) { result.failed++; result.errors.push(`Note ${entry.index}: ${entry.error}`); continue }
      const duplicate = this.duplicateOf(entry, target, candidates)
      if (duplicate && request.duplicates === 'skip') { result.skipped++; continue }
      try {
        if (duplicate && request.duplicates === 'replace') {
          const existing = candidates.find((note) => note.id === duplicate.noteId)!
          const replacement: Note = { ...existing, title: entry.title, content: entry.body, html: undefined, tags: entry.categories.length ? entry.categories : existing.tags, updatedAt: entry.modified ?? timestamp }
          if (target.kind === 'local') result.replacedLocal.push(replacement)
          else await this.update(replacement)
          if (entry.luid) this.store.saveImport(owner, entry.luid, existing.id)
          result.replaced++
          continue
        }
        const base: Note = { id: `note-${randomUUID()}`, folder: target.kind === 'local' ? target.folder : '', title: entry.title, content: entry.body, tags: entry.categories, pinned: false, archived: false, updatedAt: entry.modified ?? entry.created ?? timestamp }
        let id = base.id
        if (target.kind === 'local') result.localNotes.push(base)
        else id = (await this.create(target.folderId, base, { extraLines: this.vnoteExtraLines(entry), ...(entry.classification ? { classification: entry.classification } : {}), ...(entry.created ? { created: entry.created } : {}) })).id
        if (entry.luid) this.store.saveImport(owner, entry.luid, id)
        result.imported++
      } catch (error) {
        result.failed++
        result.errors.push(`Note ${entry.index}: ${message(error, 'could not be imported')}`)
      }
    }
    this.previews.delete(request.token)
    this.options.diagnostic?.({ level: 'info', event: 'vnote-import', details: { imported: result.imported, replaced: result.replaced, skipped: result.skipped, failed: result.failed, target: target.kind } })
    this.changed()
    return result
  }
}

export function parseTarget(value: unknown): NoteOwnerTarget {
  const target = value as NoteOwnerTarget | null
  if (target && typeof target === 'object' && target.kind === 'local' && typeof target.folder === 'string' && target.folder.trim() && target.folder.length <= 300) return { kind: 'local', folder: target.folder.trim() }
  if (target && typeof target === 'object' && target.kind === 'server' && typeof target.folderId === 'string' && target.folderId && target.folderId.length <= 500) return { kind: 'server', folderId: target.folderId }
  throw new Error('Choose a notes folder')
}
