// vNote 1.1 (IrMC) reader for importing .vnt files into Notes (docs/server-notes.md).
//
// A file holds one or more `BEGIN:VNOTE … END:VNOTE` records. Each record is read on its own, so
// a damaged record becomes an entry with an error instead of failing the whole file. Values may be
// QUOTED-PRINTABLE (with soft line breaks) or BASE64 and carry a CHARSET; the file is first read
// byte-for-byte (latin1) so legacy 8-bit text keeps its bytes until the record's charset is known.
// It stays free of Node APIs so it can be tested and used anywhere.

import { parseContentLine, splitEscaped, type ContentLine } from './content-lines'

export const VNOTE_MAX_BYTES = 20 * 1024 * 1024
export const VNOTE_MAX_RECORDS = 10_000
const MAX_LINE_LENGTH = 4 * 1024 * 1024
const MAX_BODY_LENGTH = 1_000_000

export type VNoteClass = 'PUBLIC' | 'PRIVATE' | 'CONFIDENTIAL'

export interface VNoteExtraProperty {
  name: string
  params: Record<string, string[]>
  value: string
}

export interface ParsedVNote {
  index: number
  title: string
  body: string
  categories: string[]
  created?: string
  modified?: string
  luid?: string
  classification?: VNoteClass
  /** X- properties other than X-IRMC-LUID, decoded to text. */
  extras: VNoteExtraProperty[]
  error?: string
  warning?: string
}

export interface VNoteParseResult {
  notes: ParsedVNote[]
  errors: string[]
}

export class VNoteFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VNoteFormatError'
  }
}

const latin1 = (bytes: Uint8Array) => {
  let text = ''
  for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return text
}

const bytesOf = (text: string) => Uint8Array.from(text, (character) => character.charCodeAt(0) & 0xff)

function decodeQuotedPrintable(value: string) {
  const bytes: number[] = []
  for (let index = 0; index < value.length; index++) {
    const character = value[index]
    if (character === '=') {
      const hex = value.slice(index + 1, index + 3)
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16))
        index += 2
        continue
      }
      // A stray '=' (or a soft break the unfolder left behind) is kept literally.
      if (index === value.length - 1) continue
    }
    bytes.push(character.charCodeAt(0) & 0xff)
  }
  return Uint8Array.from(bytes)
}

function decodeBase64(value: string) {
  const clean = value.replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new VNoteFormatError('A BASE64 value is not valid base64')
  const binary = atob(clean)
  return bytesOf(binary)
}

function decodeCharset(bytes: Uint8Array, charset: string | undefined) {
  const name = charset?.trim().toLowerCase()
  if (name && name !== 'utf-8' && name !== 'utf8') {
    try { return new TextDecoder(name).decode(bytes) }
    catch { throw new VNoteFormatError(`The character set ${charset!.slice(0, 40)} is not supported`) }
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  // Undeclared legacy text that is not UTF-8: Windows exporters write the ANSI code page.
  catch { return new TextDecoder(name ? 'utf-8' : 'windows-1252').decode(bytes) }
}

const unescapeVNote = (value: string) => value.replace(/\\([\\;,nN])/g, (_match, code: string) => code === 'n' || code === 'N' ? '\n' : code)

/** Decodes one property's value to text, honoring ENCODING and CHARSET. */
export function vnoteValue(line: ContentLine) {
  const encoding = (line.params.ENCODING?.[0] ?? line.params.TYPE?.find((type) => /^(QUOTED-PRINTABLE|BASE64|B)$/i.test(type)) ?? '').toUpperCase()
  const charset = line.params.CHARSET?.[0]
  if (encoding === 'QUOTED-PRINTABLE') return decodeCharset(decodeQuotedPrintable(line.value), charset).replace(/\r\n?/g, '\n')
  if (encoding === 'BASE64' || encoding === 'B') return decodeCharset(decodeBase64(line.value), charset).replace(/\r\n?/g, '\n')
  return unescapeVNote(decodeCharset(bytesOf(line.value), charset)).replace(/\r\n?/g, '\n')
}

/** 20230102T030405Z, 20230102T030405 (local), or 20230102 → ISO 8601. */
export function parseVNoteDate(value: string | undefined) {
  const match = /^(\d{4})-?(\d{2})-?(\d{2})(?:T(\d{2}):?(\d{2}):?(\d{2})(Z)?)?$/.exec(value?.trim() ?? '')
  if (!match) return undefined
  const [, year, month, day, hour = '00', minute = '00', second = '00', utc] = match
  const parts = [Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)] as const
  const date = utc ? new Date(Date.UTC(...parts)) : new Date(...parts)
  return Number.isNaN(date.getTime()) || Number(month) > 12 || Number(day) > 31 ? undefined : date.toISOString()
}

const firstLine = (text: string) => text.split('\n').map((line) => line.trim()).find(Boolean) ?? ''

/** A short single-line preview of a note body. */
export const vnoteExcerpt = (body: string, length = 160) => body.replace(/\s+/g, ' ').trim().slice(0, length)

function unfold(text: string) {
  const raw = text.replace(/^﻿/, '').split(/\r\n|\n|\r/)
  const lines: string[] = []
  for (const line of raw) {
    const previous = lines[lines.length - 1]
    const colon = previous?.indexOf(':') ?? -1
    const softBreak = previous !== undefined && previous.endsWith('=') && colon > 0 && /QUOTED-PRINTABLE/i.test(previous.slice(0, colon))
    if (softBreak) lines[lines.length - 1] = previous.slice(0, -1) + line
    else if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length) lines[lines.length - 1] = previous + line.slice(1)
    else lines.push(line)
    if (lines[lines.length - 1].length > MAX_LINE_LENGTH) throw new VNoteFormatError('The file contains a property that is too long to import safely')
  }
  return lines
}

function readRecord(index: number, properties: string[]): ParsedVNote {
  const note: ParsedVNote = { index, title: '', body: '', categories: [], extras: [] }
  const parsed: ContentLine[] = []
  let malformed = 0
  for (const raw of properties) {
    if (!raw.trim()) continue
    const line = parseContentLine(raw)
    if (!line) malformed++
    else parsed.push(line)
  }
  const version = parsed.find((line) => line.name === 'VERSION')?.value.trim()
  try {
    const body = parsed.find((line) => line.name === 'BODY')
    if (!body) return { ...note, error: 'This note has no BODY' }
    note.body = vnoteValue(body)
    if (note.body.length > MAX_BODY_LENGTH) return { ...note, body: '', error: 'This note is larger than 1 MB of text' }
    const summary = parsed.find((line) => line.name === 'SUMMARY')
    note.title = (summary ? vnoteValue(summary).trim() : '') || firstLine(note.body) || 'Untitled note'
    note.title = note.title.slice(0, 200)
    const categories = parsed.find((line) => line.name === 'CATEGORIES')
    if (categories) note.categories = [...new Set(splitEscaped(vnoteValue(categories).replace(/;/g, ','), ',').map((tag) => tag.trim()).filter(Boolean))].slice(0, 50)
    const created = parseVNoteDate(parsed.find((line) => line.name === 'DCREATED')?.value)
    const modified = parseVNoteDate(parsed.find((line) => line.name === 'LAST-MODIFIED')?.value)
    if (created) note.created = created
    if (modified) note.modified = modified
    const luid = parsed.find((line) => line.name === 'X-IRMC-LUID')?.value.trim()
    if (luid) note.luid = luid.slice(0, 200)
    const classification = parsed.find((line) => line.name === 'CLASS')?.value.trim().toUpperCase()
    if (classification === 'PUBLIC' || classification === 'PRIVATE' || classification === 'CONFIDENTIAL') note.classification = classification
    note.extras = parsed.filter((line) => line.name.startsWith('X-') && line.name !== 'X-IRMC-LUID').slice(0, 50)
      .map((line) => ({ name: line.name, params: Object.fromEntries(Object.entries(line.params).filter(([name]) => name !== 'ENCODING' && name !== 'CHARSET')), value: vnoteValue(line).slice(0, 10_000) }))
  } catch (error) {
    return { ...note, error: error instanceof Error ? error.message : 'This note could not be read' }
  }
  if (version && !/^1\.\d+$/.test(version)) return { ...note, error: `vNote version ${version.slice(0, 20)} is not supported` }
  if (malformed) note.warning = `${malformed} malformed line${malformed === 1 ? ' was' : 's were'} skipped`
  return note
}

/** Parses a .vnt file. Throws only when the file is not a vNote file at all. */
export function parseVNotes(bytes: Uint8Array): VNoteParseResult {
  if (bytes.byteLength > VNOTE_MAX_BYTES) throw new VNoteFormatError('Choose a vNote file smaller than 20 MB')
  const lines = unfold(latin1(bytes))
  const notes: ParsedVNote[] = []
  const errors: string[] = []
  let current: string[] | undefined
  let stray = 0
  const close = (properties: string[], error?: string) => {
    const record = readRecord(notes.length + 1, properties)
    notes.push(error ? { ...record, error } : record)
  }
  for (const line of lines) {
    const upper = line.trim().toUpperCase()
    if (upper === 'BEGIN:VNOTE') {
      if (current) close(current, 'This note is missing END:VNOTE')
      if (notes.length >= VNOTE_MAX_RECORDS) throw new VNoteFormatError(`The file contains more than ${VNOTE_MAX_RECORDS.toLocaleString('en-US')} notes`)
      current = []
    } else if (upper === 'END:VNOTE') {
      if (current) close(current)
      else stray++
      current = undefined
    } else if (current) current.push(line)
    else if (line.trim()) stray++
  }
  if (current) close(current, 'The file ended before END:VNOTE')
  if (!notes.length) throw new VNoteFormatError('This is not a vNote (.vnt) file: no BEGIN:VNOTE was found')
  if (stray) errors.push(`${stray} line${stray === 1 ? '' : 's'} outside a note ${stray === 1 ? 'was' : 'were'} ignored`)
  return { notes, errors }
}

/** Normalized text used to recognize the same note imported twice. */
export const vnoteFingerprint = (title: string, body: string) => `${title.trim().replace(/\s+/g, ' ').toLowerCase()}\u0000${body.replace(/\r\n?/g, '\n').trim().replace(/[ \t]+\n/g, '\n')}`
