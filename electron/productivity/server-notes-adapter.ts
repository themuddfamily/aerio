import { createHash } from 'node:crypto'
import { NOTE_IMAGE_ATTRIBUTE, isNoteImageId, noteHtmlToText } from '../../src/lib/note-rich-text'
import { sanitizeStoredNoteHtml, sniffNoteImageType } from './note-rich-body'
import type { NoteDraft, ServerNoteCopy, ServerNoteFolderRecord, StoredNoteAttachment, StoredNoteFields } from './server-notes-store'

// The provider boundary for server-synchronized Notes. Each provider (CalDAV VJOURNAL in
// dav-notes.ts, Exchange IPF.StickyNote in exchange/exchange-notes.ts) discovers folders, pulls
// changes, and performs conditional writes; the service (server-notes-service.ts) owns the cache,
// queue, conflicts, files, and transfers. Providers report failures with the typed errors below.

/** An attachment as a provider reports it. `content` is present when the provider sent the bytes. */
export interface RemoteNoteAttachment {
  id: string
  name: string
  mime: string
  inline: boolean
  size?: number
  content?: Buffer
  /** EWS AttachmentId. */
  remoteId?: string
}

export interface RemoteNoteFields extends Omit<StoredNoteFields, 'attachments'> {
  attachments: RemoteNoteAttachment[]
}

export interface RemoteNote {
  remoteId: string
  revision?: string
  raw?: string
  fields: RemoteNoteFields
}

export interface DiscoveredNoteFolder {
  remoteId: string
  name: string
  color?: string
  readOnly: boolean
  mixed?: boolean
}

export interface NotePullResult {
  changed: RemoteNote[]
  removed: string[]
  /** Members that are not notes (events or tasks in a mixed collection) with their revisions. */
  ignored: { remoteId: string; revision?: string }[]
  /** The listing was complete: anything known locally but not listed is gone. */
  complete: boolean
  syncState?: string
}

/** Reads a queued attachment's managed file. */
export type AttachmentReader = (attachment: StoredNoteAttachment) => Buffer

export interface NotesAdapter {
  listFolders(): Promise<DiscoveredNoteFolder[]>
  /** `previous` returns the cached fields of a known note so unchanged attachments are not downloaded again. */
  pull(folder: ServerNoteFolderRecord, known: Map<string, string | undefined>, previous: (remoteId: string) => StoredNoteFields | undefined): Promise<NotePullResult>
  /** A stable address for a new note, decided before the first attempt (CalDAV member URL). */
  planRemoteId?(folder: ServerNoteFolderRecord): string
  create(folder: ServerNoteFolderRecord, draft: NoteDraft, read: AttachmentReader, plannedRemoteId?: string): Promise<RemoteNote>
  update(folder: ServerNoteFolderRecord, base: ServerNoteCopy, draft: NoteDraft, read: AttachmentReader): Promise<RemoteNote>
  remove(folder: ServerNoteFolderRecord, base: ServerNoteCopy): Promise<void>
  /** The server's current copy, or undefined when it no longer exists. */
  fetch(folder: ServerNoteFolderRecord, remoteId: string, previous?: StoredNoteFields): Promise<RemoteNote | undefined>
  close?(): void
}

/** The server holds a newer revision than the one the change was made against. */
export class NoteConflictError extends Error {
  constructor(message = 'Changed on the server since you edited it') { super(message); this.name = 'NoteConflictError' }
}
/** The note no longer exists on the server. */
export class NoteMissingError extends Error {
  constructor(message = 'Deleted on the server since you edited it') { super(message); this.name = 'NoteMissingError' }
}
/** Credentials are missing or were rejected. */
export class NoteAuthError extends Error {
  constructor(message = 'The server rejected the saved credentials') { super(message); this.name = 'NoteAuthError' }
}
/** Offline, timed out, or the server asked to retry later; queued writes stay queued. */
export class NoteTransientError extends Error {
  constructor(message = 'The server could not be reached') { super(message); this.name = 'NoteTransientError' }
}
/** The server refused the change permanently (read-only folder, invalid item, too large). */
export class NoteRejectedError extends Error {
  constructor(message: string) { super(message); this.name = 'NoteRejectedError' }
}

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
export const shortHash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16)

/** Server HTML references pictures as cid: URLs; Aerio stores them by attachment id. */
export function noteHtmlForServer(html: string) {
  return html.replace(new RegExp(`${NOTE_IMAGE_ATTRIBUTE}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'gi'), (_match, double?: string, single?: string) => `src="cid:${(double ?? single ?? '').replace(/"/g, '')}"`)
}

/** Turns `src="cid:<id>"` into Aerio's picture reference for the known inline attachment ids. */
export function noteHtmlFromServer(html: string, inlineIds: ReadonlySet<string>) {
  return html.replace(/\ssrc\s*=\s*(?:"cid:([^"]*)"|'cid:([^']*)')/gi, (match, double?: string, single?: string) => {
    const id = (double ?? single ?? '').trim().replace(/^<|>$/g, '')
    return inlineIds.has(id) ? ` ${NOTE_IMAGE_ATTRIBUTE}="${id}"` : match
  })
}

const loose = (value: string) => value.replace(/\s+/g, ' ').trim()

/**
 * Normalizes a provider body into Aerio's note body: a sanitized rich body and its plain-text
 * projection, or plain text. When a client edited only the plain text and left a stale HTML
 * alternative behind, the plain text wins.
 */
export function normalizeServerBody(input: { html?: string; text?: string; inlineIds: ReadonlySet<string> }): { content: string; html?: string } {
  const text = (input.text ?? '').replace(/\r\n?/g, '\n')
  if (input.html === undefined || !input.html.trim()) return { content: text }
  const html = sanitizeStoredNoteHtml(noteHtmlFromServer(input.html, input.inlineIds), input.inlineIds).trim()
  const projection = noteHtmlToText(html)
  if (input.text !== undefined && loose(input.text) && loose(projection) !== loose(text)) return { content: text }
  return html ? { content: projection, html } : { content: text }
}

/** A stable local id for a provider attachment that has no Aerio id of its own. */
export const attachmentIdFor = (preferred: string | undefined, fallbackSeed: string) => {
  const clean = preferred?.trim().replace(/^<|>$/g, '')
  return clean && isNoteImageId(clean) ? clean : `att-${shortHash(fallbackSeed)}`
}

/** An inline picture must be one of the rich-notes image types; anything else is listed as a file. */
export const inlinePicture = (attachment: { inline: boolean; content?: Buffer; mime: string }) =>
  attachment.inline && (attachment.content ? Boolean(sniffNoteImageType(attachment.content)) : /^image\/(png|jpeg|gif|webp|bmp)$/.test(attachment.mime))

/** Field-level differences between two note versions, for patching only what was edited. */
export function changedFields(base: StoredNoteFields, draft: StoredNoteFields) {
  const attachmentKey = (fields: StoredNoteFields) => fields.attachments.map((attachment) => `${attachment.id}\u0000${attachment.name}\u0000${attachment.sha256}\u0000${attachment.inline}`).sort().join('\u0001')
  return {
    title: base.title !== draft.title,
    body: base.content !== draft.content || (base.html ?? '') !== (draft.html ?? ''),
    tags: base.tags.join('\u0000') !== draft.tags.join('\u0000'),
    attachments: attachmentKey(base) !== attachmentKey(draft)
  }
}

export const titleFromBody = (content: string) => content.split('\n').map((line) => line.trim()).find(Boolean)?.slice(0, 200) ?? 'Untitled note'
