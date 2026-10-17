// The rich Notes body format (see docs/rich-notes.md). It is shared by the
// renderer editor and the main process, so it must stay free of DOM APIs.
//
// A rich note keeps `Note.html`: an HTML fragment restricted to the composer's
// rich-text allowlist (mail-rich-text.ts). Inline pictures are never embedded:
// each is `<img data-aerio-note-image="<attachment id>" alt="...">` with no
// `src`, naming an `inline: true` entry of the note's managed attachments.
// `Note.content` is always the plain-text projection of `html` and is what
// search, previews, word counts, and older Aerio versions read.

import { decodeHtmlEntities } from './html-entities'
import { INLINE_IMAGE_MAX_BYTES } from './mail-rich-text'

/** Names the managed attachment an inline note picture shows. */
export const NOTE_IMAGE_ATTRIBUTE = 'data-aerio-note-image'
/** Regular (non-inline) attachments allowed per note; unchanged from plain-text notes. */
export const NOTE_FILE_ATTACHMENT_LIMIT = 50
/** Inline pictures allowed per note, counted separately from file attachments. */
export const NOTE_INLINE_IMAGE_LIMIT = 200
/** Largest picture that can be placed inline in a note. */
export const NOTE_IMAGE_MAX_BYTES = INLINE_IMAGE_MAX_BYTES

const noteImageIdPattern = /^[A-Za-z0-9._:-]{1,300}$/
export const isNoteImageId = (value: unknown): value is string => typeof value === 'string' && noteImageIdPattern.test(value)

const escapeText = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

/**
 * Converts a plain-text note to the rich format losslessly: one `<div>` per
 * line, `<div><br></div>` for an empty line. Spaces and tabs are kept as text;
 * the editor renders with `white-space: pre-wrap`, so they display unchanged and
 * `noteHtmlToText(plainTextToNoteHtml(text)) === text`.
 */
export function plainTextToNoteHtml(text: string) {
  if (!text) return ''
  return text.split('\n').map((line) => line ? `<div>${escapeText(line)}</div>` : '<div><br></div>').join('')
}

const blockTags = new Set([
  'address', 'blockquote', 'caption', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'li', 'ol', 'p', 'pre', 'table', 'tbody', 'tfoot', 'thead', 'tr', 'ul'
])
const cellTags = new Set(['td', 'th'])
// Matches one tag, honoring quoted attribute values that may contain `>`.
const tagPattern = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s"'=<>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g

/**
 * The plain-text projection of a rich body: block boundaries become line
 * breaks, `<br>` a line break, table cells are separated by tabs, and markup,
 * comments, and pictures contribute no text. Whitespace inside text is kept.
 */
export function noteHtmlToText(html: string) {
  let output = ''
  let lastWasBlockEnd = false
  const newline = () => { if (output && !output.endsWith('\n')) output += '\n' }
  const text = (value: string) => {
    if (!value) return
    output += decodeHtmlEntities(value)
    lastWasBlockEnd = false
  }
  const source = html.replace(/<!--[\s\S]*?-->/g, '')
  let index = 0
  for (const match of source.matchAll(tagPattern)) {
    text(source.slice(index, match.index))
    index = match.index + match[0].length
    const closing = match[1] === '/'
    const tag = match[2].toLowerCase()
    if (tag === 'br' && !closing) {
      output += '\n'
      lastWasBlockEnd = false
    } else if (blockTags.has(tag)) {
      newline()
      lastWasBlockEnd = closing
    } else if (cellTags.has(tag) && !closing && output && !output.endsWith('\n')) {
      output += '\t'
      lastWasBlockEnd = false
    }
  }
  text(source.slice(index))
  // The final block's own line break is not part of the text.
  if (lastWasBlockEnd && output.endsWith('\n')) output = output.slice(0, -1)
  return output
}

/** Attachment ids referenced by inline pictures, in document order without repeats. */
export function noteImageIds(html: string | undefined) {
  const ids = new Set<string>()
  if (!html) return []
  for (const match of html.matchAll(new RegExp(`${NOTE_IMAGE_ATTRIBUTE}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`, 'gi'))) {
    const id = decodeHtmlEntities(match[1] ?? match[2] ?? match[3] ?? '')
    if (isNoteImageId(id)) ids.add(id)
  }
  return [...ids]
}

/** The HTML a note shows in the rich editor: its rich body, or its plain text converted losslessly. */
export const noteEditorHtml = (note: { html?: string; content: string }) => note.html ?? plainTextToNoteHtml(note.content)
