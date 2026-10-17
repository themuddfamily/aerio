import { randomUUID } from 'node:crypto'
import { escapeText, foldLine, formatParam, parseContentLine, splitEscaped, unescapeText, type ContentLine } from '../../src/lib/content-lines'
import { DavClient, DavHttpError, DavNetworkError, resolveHref, sameCollection } from './dav-client'
import { collectionFromResponse, COLLECTION_PROPS } from './dav-discovery'
import { pullCollection } from './dav-sync'
import { CALDAV_NS, prop, propfindBody } from './dav-xml'
import type { DavAccountRecord } from './dav-store'
import {
  attachmentIdFor, changedFields, inlinePicture, normalizeServerBody, NoteAuthError, NoteConflictError, noteHtmlForServer, NoteMissingError,
  NoteRejectedError, NoteTransientError, sha256, titleFromBody, type AttachmentReader, type DiscoveredNoteFolder, type NotePullResult,
  type NotesAdapter, type RemoteNote, type RemoteNoteAttachment
} from './server-notes-adapter'
import type { NoteDraft, ServerNoteCopy, ServerNoteFolderRecord, StoredNoteFields } from './server-notes-store'

// CalDAV VJOURNAL notes (RFC 5545 §3.6.3) through the existing DAV engine: collections are found by
// their supported-calendar-component-set, pulled with sync-collection or ctag/ETag comparison
// (dav-sync.ts), and written with If-Match / If-None-Match. Only VJOURNAL entries become notes; the
// events and tasks of a mixed collection are tracked by ETag and left to Calendar and Tasks.
//
// Edits patch the server's raw text: only the properties the user changed (SUMMARY, DESCRIPTION
// with X-ALT-DESC, CATEGORIES, binary ATTACH) plus LAST-MODIFIED/DTSTAMP are rewritten, and every
// other line, including unknown X- properties, URI attachments, and other components, is kept as is.

/** Notes with attachments are uploaded inline (base64), so the total is limited per note. */
export const DAV_NOTE_ATTACHMENT_LIMIT = 15 * 1024 * 1024
const ATTACHMENT_FILENAME_PARAMS = ['X-FILENAME', 'FILENAME', 'X-APPLE-FILENAME', 'X-ORACLE-FILENAME', 'X-EVOLUTION-CALDAV-ATTACHMENT-NAME']

// --- Discovery ------------------------------------------------------------------------------------

/**
 * Lists the collections in a calendar home that explicitly declare VJOURNAL support. Collections
 * without a supported-calendar-component-set are treated as calendars only, so ordinary calendars
 * never appear in Notes.
 */
export async function listNoteCollections(client: DavClient, homeUrl: string): Promise<DiscoveredNoteFolder[]> {
  const listing = await client.multistatus('PROPFIND', homeUrl, propfindBody(COLLECTION_PROPS), '1')
  const folders: DiscoveredNoteFolder[] = []
  for (const response of listing.responses) {
    if (sameCollection(resolveHref(response.href, listing.url), resolveHref(homeUrl, listing.url))) continue
    if (!prop(response, CALDAV_NS, 'supported-calendar-component-set')) continue
    const collection = collectionFromResponse(response, listing.url)
    if (!collection || collection.kind !== 'calendar' || !collection.components.includes('VJOURNAL')) continue
    folders.push({
      remoteId: collection.url, name: collection.name, readOnly: collection.readOnly,
      ...(collection.color ? { color: collection.color } : {}),
      ...(collection.components.some((component) => component === 'VEVENT' || component === 'VTODO') ? { mixed: true } : {})
    })
  }
  return folders
}

// --- Raw iCalendar text ---------------------------------------------------------------------------

interface LogicalLine { text: string; physical: string[] }

function logicalLines(raw: string): LogicalLine[] {
  const lines: LogicalLine[] = []
  for (const physical of raw.replace(/^﻿/, '').split(/\r\n|\n|\r/)) {
    if ((physical.startsWith(' ') || physical.startsWith('\t')) && lines.length) {
      const last = lines[lines.length - 1]
      last.text += physical.slice(1)
      last.physical.push(physical)
    } else if (physical.length) lines.push({ text: physical, physical: [physical] })
  }
  return lines
}

interface JournalRange { begin: number; end: number; properties: number[] }

/** The first VJOURNAL in a calendar object and the indexes of its own (not nested) property lines. */
function journalRange(lines: LogicalLine[]): JournalRange | undefined {
  const stack: string[] = []
  let range: JournalRange | undefined
  for (const [index, line] of lines.entries()) {
    const upper = line.text.toUpperCase()
    if (upper.startsWith('BEGIN:')) {
      const name = upper.slice(6).trim()
      stack.push(name)
      if (name === 'VJOURNAL' && !range && stack.length === 2) range = { begin: index, end: -1, properties: [] }
    } else if (upper.startsWith('END:')) {
      const name = stack.pop()
      if (range && range.end < 0 && name === 'VJOURNAL' && stack.length === 1) return { ...range, end: index }
    } else if (range && range.end < 0 && stack.length === 2 && stack[1] === 'VJOURNAL') range.properties.push(index)
  }
  return undefined
}

export const containsJournal = (raw: string) => Boolean(journalRange(logicalLines(raw)))

const utcStamp = (date: Date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
const parseStamp = (value: string | undefined) => {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value?.trim() ?? '')
  if (!match) return undefined
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4] ?? 0), Number(match[5] ?? 0), Number(match[6] ?? 0)))
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}
const param = (line: ContentLine, name: string) => line.params[name]?.[0]
const isBinaryAttach = (line: ContentLine) => line.name === 'ATTACH' && (param(line, 'VALUE')?.toUpperCase() === 'BINARY' || param(line, 'ENCODING')?.toUpperCase() === 'BASE64')
const isHtmlAltDesc = (line: ContentLine) => line.name === 'X-ALT-DESC' && (param(line, 'FMTTYPE') ?? '').toLowerCase() === 'text/html'

/** Reads the VJOURNAL of a calendar object into note fields. Returns undefined for objects without one. */
export function parseJournal(raw: string): (RemoteNote['fields'] & { uid?: string }) | undefined {
  const lines = logicalLines(raw)
  const range = journalRange(lines)
  if (!range) return undefined
  const properties = range.properties.map((index) => parseContentLine(lines[index].text)).filter((line): line is ContentLine => Boolean(line))
  const descriptions = properties.filter((line) => line.name === 'DESCRIPTION').map((line) => unescapeText(line.value))
  const htmlLine = properties.find(isHtmlAltDesc)
  const attachments: RemoteNoteAttachment[] = []
  const html = htmlLine ? unescapeText(htmlLine.value) : undefined
  for (const line of properties.filter(isBinaryAttach)) {
    let content: Buffer
    try { content = Buffer.from(line.value.replace(/\s+/g, ''), 'base64') } catch { continue }
    if (!content.byteLength) continue
    const id = attachmentIdFor(param(line, 'X-AERIO-ATTACHMENT-ID'), sha256(content))
    const name = ATTACHMENT_FILENAME_PARAMS.map((key) => param(line, key)).find(Boolean)?.slice(0, 255) || 'Attachment'
    const mime = (param(line, 'FMTTYPE') ?? 'application/octet-stream').toLowerCase().slice(0, 200)
    const referenced = Boolean(html && new RegExp(`cid:${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`, 'i').test(html))
    const inline = inlinePicture({ inline: (param(line, 'X-AERIO-INLINE') ?? '').toUpperCase() === 'TRUE' || referenced, content, mime })
    attachments.push({ id, name, mime, inline, size: content.byteLength, content })
  }
  const inlineIds = new Set(attachments.filter((attachment) => attachment.inline).map((attachment) => attachment.id))
  const text = descriptions.length ? descriptions.join('\n\n') : undefined
  const body = normalizeServerBody({ html, text, inlineIds })
  // Pictures the sanitized body no longer shows are listed as files rather than lost.
  const shown = new Set(body.html ? [...body.html.matchAll(/data-aerio-note-image="([^"]+)"/g)].map((match) => match[1]) : [])
  for (const attachment of attachments) if (attachment.inline && !shown.has(attachment.id)) attachment.inline = false
  const summary = properties.find((line) => line.name === 'SUMMARY')
  const tags = [...new Set(properties.filter((line) => line.name === 'CATEGORIES').flatMap((line) => splitEscaped(line.value, ',')).map((tag) => tag.trim()).filter(Boolean))].slice(0, 100)
  const classification = properties.find((line) => line.name === 'CLASS')?.value.trim().toUpperCase()
  const created = parseStamp(properties.find((line) => line.name === 'CREATED')?.value)
  const modified = parseStamp(properties.find((line) => line.name === 'LAST-MODIFIED')?.value ?? properties.find((line) => line.name === 'DTSTAMP')?.value)
  const uid = properties.find((line) => line.name === 'UID')?.value.trim()
  return {
    title: (summary ? unescapeText(summary.value).trim() : '').slice(0, 10_000) || titleFromBody(body.content),
    content: body.content,
    ...(body.html ? { html: body.html } : {}),
    tags,
    attachments,
    ...(created ? { created } : {}),
    ...(modified ? { modified } : {}),
    ...(classification === 'PUBLIC' || classification === 'PRIVATE' || classification === 'CONFIDENTIAL' ? { classification } : {}),
    ...(uid ? { uid } : {})
  }
}

function attachLine(attachment: NoteDraft['attachments'][number], bytes: Buffer) {
  return `ATTACH;VALUE=BINARY;ENCODING=BASE64${formatParam('FMTTYPE', [attachment.mime || 'application/octet-stream'])}${formatParam('X-FILENAME', [attachment.name])}${formatParam('X-AERIO-ATTACHMENT-ID', [attachment.id])}${attachment.inline ? ';X-AERIO-INLINE=TRUE' : ''}:${bytes.toString('base64')}`
}

const categoriesLine = (tags: string[]) => `CATEGORIES:${tags.map((tag) => escapeText(tag)).join(',')}`

function attachmentLines(draft: NoteDraft, read: AttachmentReader) {
  let total = 0
  return draft.attachments.map((attachment) => {
    const bytes = read(attachment)
    total += bytes.byteLength
    if (total > DAV_NOTE_ATTACHMENT_LIMIT) throw new NoteRejectedError('This note has more than 15 MB of attachments, which is more than Aerio uploads to a CalDAV server')
    return attachLine(attachment, bytes)
  })
}

const bodyLines = (draft: NoteDraft) => [
  `DESCRIPTION:${escapeText(draft.content)}`,
  ...(draft.html ? [`X-ALT-DESC;FMTTYPE=text/html:${escapeText(noteHtmlForServer(draft.html))}`] : [])
]

/** A new calendar object with one VJOURNAL for a note. */
export function newJournal(draft: NoteDraft, read: AttachmentReader, now: Date, uid: string = randomUUID()) {
  const stamp = utcStamp(now)
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Aerio//Notes//EN', 'BEGIN:VJOURNAL',
    `UID:${uid}`, `DTSTAMP:${stamp}`, `CREATED:${draft.created ? utcStamp(new Date(draft.created)) : stamp}`, `LAST-MODIFIED:${stamp}`,
    `SUMMARY:${escapeText(draft.title)}`, ...bodyLines(draft),
    ...(draft.tags.length ? [categoriesLine(draft.tags)] : []),
    ...(draft.classification ? [`CLASS:${draft.classification}`] : []),
    ...(draft.extraLines ?? []),
    ...attachmentLines(draft, read),
    'END:VJOURNAL', 'END:VCALENDAR'
  ]
  return `${lines.map(foldLine).join('\r\n')}\r\n`
}

/**
 * Rewrites only the edited properties of the server's VJOURNAL. Lines Aerio does not model,
 * including other components (VTIMEZONE, overrides) and URI attachments, are kept byte for byte.
 */
export function patchJournal(raw: string, base: StoredNoteFields, draft: NoteDraft, read: AttachmentReader, now: Date) {
  const lines = logicalLines(raw)
  const range = journalRange(lines)
  if (!range) throw new NoteRejectedError('The server copy of this note is not a VJOURNAL')
  const changed = changedFields(base, draft)
  const replaced = new Set<number>()
  const added: string[] = []
  const replace = (predicate: (line: ContentLine) => boolean, next: string[]) => {
    for (const index of range.properties) {
      const parsed = parseContentLine(lines[index].text)
      if (parsed && predicate(parsed)) replaced.add(index)
    }
    added.push(...next)
  }
  if (changed.title) replace((line) => line.name === 'SUMMARY', [`SUMMARY:${escapeText(draft.title)}`])
  if (changed.body) replace((line) => line.name === 'DESCRIPTION' || isHtmlAltDesc(line), bodyLines(draft))
  if (changed.tags) replace((line) => line.name === 'CATEGORIES', draft.tags.length ? [categoriesLine(draft.tags)] : [])
  if (changed.attachments) replace(isBinaryAttach, attachmentLines(draft, read))
  const stamp = utcStamp(now)
  replace((line) => line.name === 'LAST-MODIFIED' || line.name === 'DTSTAMP', [`DTSTAMP:${stamp}`, `LAST-MODIFIED:${stamp}`])
  const output: string[] = []
  for (const [index, line] of lines.entries()) {
    if (index === range.end) output.push(...added.map(foldLine))
    if (!replaced.has(index)) output.push(...line.physical)
  }
  return `${output.join('\r\n')}\r\n`
}

// --- Adapter --------------------------------------------------------------------------------------

interface DavSyncState { syncToken?: string; ctag?: string; supportsSyncCollection?: boolean }

const mapError = (error: unknown): Error => {
  if (error instanceof DavNetworkError) return new NoteTransientError(error.message)
  if (error instanceof DavHttpError) {
    if (error.status === 401) return new NoteAuthError('The server rejected the app password. Enter it again in Settings › Calendar and contacts accounts.')
    if (error.status >= 500 || error.status === 429 || error.status === 408) return new NoteTransientError(error.message)
    if (error.status === 403) return new NoteRejectedError('The server refused this change; the notes folder may be read-only')
    return new NoteRejectedError(error.message)
  }
  return error instanceof Error ? error : new Error('The server request failed')
}

const memberUrl = (collectionUrl: string, name: string) => new URL(encodeURIComponent(name), collectionUrl.endsWith('/') ? collectionUrl : `${collectionUrl}/`).toString()

export class DavNotesAdapter implements NotesAdapter {
  constructor(private readonly client: DavClient, private readonly account: Pick<DavAccountRecord, 'calendarHomeUrl'>, private readonly now: () => Date = () => new Date()) {}

  private async guard<T>(work: () => Promise<T>) {
    try { return await work() } catch (error) {
      if (error instanceof NoteConflictError || error instanceof NoteMissingError || error instanceof NoteRejectedError || error instanceof NoteAuthError || error instanceof NoteTransientError) throw error
      throw mapError(error)
    }
  }

  listFolders() {
    return this.guard(async () => this.account.calendarHomeUrl ? listNoteCollections(this.client, this.account.calendarHomeUrl) : [])
  }

  private remote(href: string, etag: string | undefined, data: string): RemoteNote {
    const fields = parseJournal(data)
    if (!fields) throw new NoteRejectedError('The server stored this note without a VJOURNAL')
    const { uid: _uid, ...rest } = fields
    return { remoteId: href, ...(etag ? { revision: etag } : {}), raw: data, fields: rest }
  }

  pull(folder: ServerNoteFolderRecord, known: Map<string, string | undefined>): Promise<NotePullResult> {
    return this.guard(async () => {
      let state: DavSyncState = {}
      try { state = folder.syncState ? JSON.parse(folder.syncState) as DavSyncState : {} } catch { state = {} }
      const changes = await pullCollection(this.client, {
        url: folder.remoteId, kind: 'calendar', ...(state.ctag ? { ctag: state.ctag } : {}), ...(state.syncToken ? { syncToken: state.syncToken } : {}),
        supportsSyncCollection: state.supportsSyncCollection ?? true
      }, known)
      const changed: RemoteNote[] = []
      const ignored: NotePullResult['ignored'] = []
      for (const resource of changes.changed) {
        if (!containsJournal(resource.data)) { ignored.push({ remoteId: resource.href, ...(resource.etag ? { revision: resource.etag } : {}) }); continue }
        try { changed.push(this.remote(resource.href, resource.etag, resource.data)) }
        catch { ignored.push({ remoteId: resource.href, ...(resource.etag ? { revision: resource.etag } : {}) }) }
      }
      const next: DavSyncState = {
        ...(changes.syncToken ?? state.syncToken ? { syncToken: changes.syncToken ?? state.syncToken } : {}),
        ...(changes.ctag ?? state.ctag ? { ctag: changes.ctag ?? state.ctag } : {}),
        supportsSyncCollection: changes.mode === 'sync-collection'
      }
      return { changed, removed: changes.removed, ignored, complete: changes.complete, syncState: JSON.stringify(next) }
    })
  }

  planRemoteId(folder: ServerNoteFolderRecord) {
    return memberUrl(folder.remoteId, `${randomUUID()}.ics`)
  }

  private async stored(href: string, sent: string, etagHeader: string | null) {
    let etag = etagHeader?.trim() || undefined
    let data = sent
    // Without an ETag the server may have rewritten the object; read back its stored copy.
    if (!etag) {
      const stored = await this.client.request('GET', href, { headers: { Accept: 'text/calendar' } })
      if (stored.status >= 200 && stored.status < 300) {
        data = stored.text
        etag = stored.headers.get('etag')?.trim() || undefined
      }
    }
    return this.remote(href, etag, data)
  }

  create(folder: ServerNoteFolderRecord, draft: NoteDraft, read: AttachmentReader, plannedRemoteId?: string) {
    return this.guard(async () => {
      const href = plannedRemoteId ?? this.planRemoteId(folder)
      const uid = decodeURIComponent(new URL(href).pathname.split('/').pop() ?? '').replace(/\.ics$/i, '') || randomUUID()
      const data = newJournal(draft, read, this.now(), uid)
      const response = await this.client.request('PUT', href, { headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'If-None-Match': '*' }, body: data })
      if (response.status === 412) {
        // A retry after an unconfirmed first attempt: the note already exists at the planned address.
        const existing = await this.fetch(folder, href)
        if (existing && parseJournal(existing.raw ?? '')?.uid === uid) return existing
        throw new NoteConflictError('A note with this address already exists on the server')
      }
      if (response.status < 200 || response.status >= 300) throw mapError(new DavHttpError(`The server responded with ${response.status}`, response.status, response.text.slice(0, 2_000)))
      return this.stored(href, data, response.headers.get('etag'))
    })
  }

  update(folder: ServerNoteFolderRecord, base: ServerNoteCopy, draft: NoteDraft, read: AttachmentReader) {
    return this.guard(async () => {
      if (!base.revision) throw new NoteConflictError('The server did not report a revision for this note, so Aerio cannot update it safely')
      if (base.raw === undefined) throw new NoteRejectedError('The server copy of this note is missing; synchronize and try again')
      const data = patchJournal(base.raw, base.fields, draft, read, this.now())
      const response = await this.client.request('PUT', base.remoteId, { headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'If-Match': base.revision }, body: data })
      if (response.status === 412) throw new NoteConflictError()
      if (response.status === 404 || response.status === 410) throw new NoteMissingError()
      if (response.status < 200 || response.status >= 300) throw mapError(new DavHttpError(`The server responded with ${response.status}`, response.status, response.text.slice(0, 2_000)))
      return this.stored(base.remoteId, data, response.headers.get('etag'))
    })
  }

  remove(_folder: ServerNoteFolderRecord, base: ServerNoteCopy) {
    return this.guard(async () => {
      if (!base.revision) throw new NoteConflictError('The server did not report a revision for this note, so Aerio cannot delete it safely')
      const response = await this.client.request('DELETE', base.remoteId, { headers: { 'If-Match': base.revision } })
      if (response.status === 412) throw new NoteConflictError('Changed on the server since you deleted it')
      if ((response.status >= 200 && response.status < 300) || response.status === 404 || response.status === 410) return
      throw mapError(new DavHttpError(`The server responded with ${response.status}`, response.status, response.text.slice(0, 2_000)))
    })
  }

  fetch(_folder: ServerNoteFolderRecord, remoteId: string) {
    return this.guard(async () => {
      const response = await this.client.request('GET', remoteId, { headers: { Accept: 'text/calendar' } })
      if (response.status === 404 || response.status === 410) return undefined
      if (response.status < 200 || response.status >= 300) throw mapError(new DavHttpError(`The server responded with ${response.status}`, response.status))
      if (!containsJournal(response.text)) return undefined
      return this.remote(remoteId, response.headers.get('etag')?.trim() || undefined, response.text)
    })
  }
}
