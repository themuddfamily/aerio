import sanitizeHtml from 'sanitize-html'
import type { LocalModuleSnapshot } from '../../src/productivity-types'
import type { Attachment, Note } from '../../src/types'
import { INLINE_IMAGE_TYPES, RICH_TEXT_ATTRIBUTES, RICH_TEXT_TAGS, inlineImageExtension, isAllowedLink, parseDataImage, sanitizeStyle } from '../../src/lib/mail-rich-text'
import {
  NOTE_FILE_ATTACHMENT_LIMIT, NOTE_IMAGE_ATTRIBUTE, NOTE_IMAGE_MAX_BYTES, NOTE_INLINE_IMAGE_LIMIT, isNoteImageId, noteHtmlToText
} from '../../src/lib/note-rich-text'

/** Rich bodies share the plain-text size limit. */
export const NOTE_HTML_MAX_LENGTH = 10_000_000

/**
 * Sanitizes a stored rich note body with the composer's allowlist. Pictures
 * keep only a managed-image reference: any `src` (remote, file, or data URL)
 * is dropped, and a reference to an id that is not one of the note's inline
 * attachments removes the picture.
 */
export function sanitizeStoredNoteHtml(html: string, inlineImageIds: ReadonlySet<string>) {
  return sanitizeHtml(html, {
    allowedTags: RICH_TEXT_TAGS,
    allowedAttributes: {
      ...RICH_TEXT_ATTRIBUTES,
      img: ['alt', 'width', 'height', NOTE_IMAGE_ATTRIBUTE],
      '*': ['style', 'dir']
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: [] },
    allowProtocolRelative: false,
    ...({ allowedEmptyAttributes: ['alt'] } as sanitizeHtml.IOptions),
    disallowedTagsMode: 'discard',
    nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'title', 'head', 'xml'],
    parseStyleAttributes: false,
    transformTags: {
      '*': (tagName, attribs) => {
        const next: sanitizeHtml.Attributes = { ...attribs }
        if (next.style !== undefined) {
          const style = sanitizeStyle(next.style)
          if (style) next.style = style
          else delete next.style
        }
        if (tagName === 'a' && next.href !== undefined && !isAllowedLink(next.href)) delete next.href
        if (tagName === 'img') {
          delete next.src
          if (!isNoteImageId(next[NOTE_IMAGE_ATTRIBUTE]) || !inlineImageIds.has(next[NOTE_IMAGE_ATTRIBUTE])) delete next[NOTE_IMAGE_ATTRIBUTE]
        }
        return { tagName, attribs: next }
      }
    },
    exclusiveFilter: (frame) => frame.tag === 'img' && !frame.attribs[NOTE_IMAGE_ATTRIBUTE]
  })
}

/** Checks the rich-note fields a saved or restored note may carry. */
export function validNoteRichFields(note: Partial<Note>) {
  if (note.html !== undefined && (typeof note.html !== 'string' || note.html.length > NOTE_HTML_MAX_LENGTH)) return false
  if (note.attachments !== undefined && !Array.isArray(note.attachments)) return false
  const attachments = note.attachments ?? []
  if (!attachments.every((attachment) => attachment && (attachment.inline === undefined || typeof attachment.inline === 'boolean'))) return false
  const inline = attachments.filter((attachment) => attachment.inline).length
  return inline <= NOTE_INLINE_IMAGE_LIMIT && attachments.length - inline <= NOTE_FILE_ATTACHMENT_LIMIT
}

/** Total attachments (files plus inline pictures) a note may reference. */
export const NOTE_ATTACHMENT_LIMIT = NOTE_FILE_ATTACHMENT_LIMIT + NOTE_INLINE_IMAGE_LIMIT

/**
 * Re-sanitizes every rich body and recomputes its plain-text projection, so
 * search and older readers always see the text the rich body shows. Plain
 * notes (no `html`) are returned unchanged.
 */
export function normalizeRichNotes(snapshot: LocalModuleSnapshot): LocalModuleSnapshot {
  if (!snapshot.notes.some((note) => note.html !== undefined)) return snapshot
  return {
    ...snapshot,
    notes: snapshot.notes.map((note) => {
      if (note.html === undefined) return note
      const ids = new Set((note.attachments ?? []).filter((attachment) => attachment.inline).map((attachment) => attachment.id))
      const html = sanitizeStoredNoteHtml(note.html, ids)
      return { ...note, html, content: noteHtmlToText(html) }
    })
  }
}

/** Identifies an allowed raster image from its leading bytes; the file name and declared type are not trusted. */
export function sniffNoteImageType(bytes: Uint8Array) {
  const starts = (...signature: number[]) => signature.every((value, index) => bytes[index] === value)
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif'
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  if (starts(0x42, 0x4d)) return 'image/bmp'
  return undefined
}

export interface NoteImageUpload {
  bytes: Buffer
  mimeType: string
  name: string
  extension: string
}

/** Validates a renderer request to store an inline picture (`{ name, dataUrl }`). */
export function parseNoteImageUpload(input: unknown): NoteImageUpload {
  const value = input as { name?: unknown; dataUrl?: unknown } | null
  if (!value || typeof value !== 'object' || typeof value.dataUrl !== 'string' || value.dataUrl.length > Math.ceil(NOTE_IMAGE_MAX_BYTES / 3) * 4 + 100) {
    throw new Error('Choose a PNG, JPEG, GIF, WebP, or BMP picture up to 5 MB')
  }
  const image = parseDataImage(value.dataUrl)
  if (!image || !INLINE_IMAGE_TYPES.includes(image.mimeType)) throw new Error('Choose a PNG, JPEG, GIF, WebP, or BMP picture up to 5 MB')
  const bytes = Buffer.from(image.base64, 'base64')
  if (!bytes.byteLength || bytes.byteLength > NOTE_IMAGE_MAX_BYTES) throw new Error('Pictures placed in a note must be 5 MB or smaller')
  const mimeType = sniffNoteImageType(bytes)
  if (!mimeType) throw new Error('That picture is not a readable PNG, JPEG, GIF, WebP, or BMP image')
  const extension = inlineImageExtension(mimeType)
  const base = typeof value.name === 'string' ? value.name.replace(/\.(?:png|jpe?g|gif|webp|bmp)$/i, '').replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ').trim().slice(0, 200) : ''
  return { bytes, mimeType, extension, name: `${base || 'Picture'}.${extension}` }
}

/** The inline attachment record for a stored picture. */
export const noteImageAttachment = (id: string, upload: NoteImageUpload, path: string): Attachment => ({
  id, name: upload.name, size: upload.bytes.byteLength, mime: upload.mimeType, path, inline: true
})

/** A data URL the editor displays for a stored picture; refuses files that are not allowed images. */
export function noteImageDataUrl(bytes: Uint8Array) {
  const mimeType = sniffNoteImageType(bytes)
  if (!mimeType) throw new Error('That note picture is not a supported image')
  return `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`
}
