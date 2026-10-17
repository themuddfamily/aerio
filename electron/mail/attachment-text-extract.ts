// Turns one attachment into plain text for the search index. Everything here
// is synchronous and bounded by AttachmentTextLimits; it is meant to run inside
// the isolated extraction worker (attachment-extract-worker.ts), never on the
// mail worker or main thread directly.
import { decodeHTML, decodeXML } from 'entities'
import { extractPdfText } from './attachment-pdf'
import { isZip, readZipEntries, readZipEntry, type ZipEntry } from './attachment-zip'
import {
  AttachmentTextError,
  DEFAULT_ATTACHMENT_TEXT_LIMITS,
  TextBudget,
  type AttachmentTextInput,
  type AttachmentTextLimits,
  type AttachmentTextResult
} from './attachment-text-types'

export type AttachmentTextKind = 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'text' | 'html'

const EXTENSIONS: Record<string, AttachmentTextKind> = {
  pdf: 'pdf',
  docx: 'docx', docm: 'docx', dotx: 'docx', dotm: 'docx',
  xlsx: 'xlsx', xlsm: 'xlsx', xltx: 'xlsx', xltm: 'xlsx',
  pptx: 'pptx', pptm: 'pptx', potx: 'pptx', ppsx: 'pptx',
  txt: 'text', text: 'text', csv: 'text', tsv: 'text', md: 'text', markdown: 'text', log: 'text',
  json: 'text', xml: 'text', yaml: 'text', yml: 'text', ini: 'text', ics: 'text', vcf: 'text',
  htm: 'html', html: 'html'
}

const MIME_TYPES: Record<string, AttachmentTextKind> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-word.document.macroenabled.12': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel.sheet.macroenabled.12': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.ms-powerpoint.presentation.macroenabled.12': 'pptx',
  'application/json': 'text',
  'application/xml': 'text',
  'text/html': 'html'
}

// OLE compound files: legacy .doc/.xls/.ppt, and also the container Office uses for password-protected OOXML.
const COMPOUND_FILE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

/** Picks an extractor from the file extension, then the MIME type; undefined means unsupported. */
export function attachmentTextKind(filename: string, mimeType: string): AttachmentTextKind | undefined {
  const extension = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]
  if (extension && EXTENSIONS[extension]) return EXTENSIONS[extension]
  const mime = mimeType.toLowerCase().split(';')[0].trim()
  if (MIME_TYPES[mime]) return MIME_TYPES[mime]
  if (mime.startsWith('text/') && mime !== 'text/rtf') return 'text'
  return undefined
}

function decodeText(content: Buffer) {
  if (content[0] === 0xff && content[1] === 0xfe) return new TextDecoder('utf-16le').decode(content.subarray(2))
  if (content[0] === 0xfe && content[1] === 0xff) return new TextDecoder('utf-16be').decode(content.subarray(2))
  const sample = content.subarray(0, 8_192)
  // Many NUL bytes means a binary file with a text-like name.
  if (sample.length && sample.filter((byte) => byte === 0).length > sample.length / 100) {
    throw new AttachmentTextError('unsupported', 'The file does not contain readable text')
  }
  try {
    // Streaming mode tolerates a multi-byte character cut off by the read limit.
    return new TextDecoder('utf-8', { fatal: true }).decode(content, { stream: true })
  } catch {
    return new TextDecoder('windows-1252').decode(content)
  }
}

function htmlText(html: string) {
  return decodeHTML(html
    .replaceAll(/<(script|style|head|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replaceAll(/<!--[\s\S]*?-->/g, ' ')
    .replaceAll(/<\/(p|div|li|tr|h[1-6]|table|section|article)\s*>|<br\s*\/?>/gi, '\n')
    .replaceAll(/<[^>]*>/g, ' '))
}

// Paragraph, row, and cell ends become separators so words from adjacent runs don't merge.
const XML_BREAK = /<\/(?:[A-Za-z0-9]+:)?(?:p|si|tr|c|txBody)>|<(?:[A-Za-z0-9]+:)?(?:br|cr)\b[^>]*\/>/g
const XML_TAB = /<(?:[A-Za-z0-9]+:)?tab\b[^>]*\/>/g
const XML_TEXT = /<(?:[A-Za-z0-9]+:)?t(?:\s[^>]*)?>([^<]*)<\/(?:[A-Za-z0-9]+:)?t>|(\u0001)|(\u0002)/g

function xmlText(xml: string, out: TextBudget) {
  const marked = xml.replaceAll(XML_BREAK, '\u0001').replaceAll(XML_TAB, '\u0002')
  for (const match of marked.matchAll(XML_TEXT)) {
    if (!out.push(match[1] !== undefined ? decodeXML(match[1]) : match[2] ? '\n' : '\t')) return
  }
  out.push('\n')
}

const partNumber = (name: string) => Number(name.match(/(\d+)\.xml$/)?.[1] ?? 0)

function officeParts(kind: 'docx' | 'xlsx' | 'pptx', entries: ZipEntry[]) {
  const named = (pattern: RegExp) => entries.filter((entry) => pattern.test(entry.name)).sort((a, b) => partNumber(a.name) - partNumber(b.name))
  if (kind === 'docx') {
    return [
      ...named(/^word\/document\.xml$/),
      ...named(/^word\/(header|footer)\d*\.xml$/),
      ...named(/^word\/(footnotes|endnotes|comments)\.xml$/)
    ]
  }
  if (kind === 'xlsx') return [...named(/^xl\/sharedStrings\.xml$/), ...named(/^xl\/worksheets\/sheet\d+\.xml$/)]
  return [...named(/^ppt\/slides\/slide\d+\.xml$/), ...named(/^ppt\/notesSlides\/notesSlide\d+\.xml$/)]
}

function extractOfficeText(content: Buffer, kind: 'docx' | 'xlsx' | 'pptx', limits: AttachmentTextLimits) {
  if (content.subarray(0, 8).equals(COMPOUND_FILE)) throw new AttachmentTextError('encrypted', 'The document is password-protected')
  if (!isZip(content)) throw new AttachmentTextError('failed', 'The document is damaged or not an Office file')
  const entries = readZipEntries(content, limits.maxZipEntries)
  if (entries.some((entry) => entry.encrypted)) throw new AttachmentTextError('encrypted', 'The document is password-protected')
  const parts = officeParts(kind, entries)
  if (!parts.length) throw new AttachmentTextError('failed', 'The document is damaged or not an Office file')
  const out = new TextBudget(limits.maxTextChars)
  let expanded = 0
  for (const part of parts) {
    const room = limits.maxExpandedBytes - expanded
    if (room <= 0) { out.truncated = true; break }
    let data: Buffer
    try {
      data = readZipEntry(content, part, room)
    } catch (error) {
      // Keep what earlier parts produced when a later part alone exceeds the budget.
      if (error instanceof AttachmentTextError && error.status === 'too-large' && out.text()) { out.truncated = true; break }
      throw error
    }
    expanded += data.byteLength
    // Spreadsheet cells only carry text in <t> elements of shared or inline strings.
    xmlText(data.toString('utf8'), out)
    if (out.truncated) break
  }
  return { text: out.text(), truncated: out.truncated }
}

function extractPlainText(content: Buffer, html: boolean, limits: AttachmentTextLimits) {
  const out = new TextBudget(limits.maxTextChars)
  // Markup shrinks a lot once tags are removed, so HTML gets a larger read window.
  const window = limits.maxTextChars * (html ? 16 : 4)
  const decoded = decodeText(content.subarray(0, window))
  out.push(html ? htmlText(decoded) : decoded)
  return { text: out.text(), truncated: out.truncated || content.byteLength > window }
}

export function extractAttachmentText(input: AttachmentTextInput, limits: AttachmentTextLimits = DEFAULT_ATTACHMENT_TEXT_LIMITS): AttachmentTextResult {
  const kind = attachmentTextKind(input.filename, input.mimeType)
  if (!kind) return { status: 'unsupported', text: '', truncated: false, detail: 'This file type is not searchable' }
  if (input.content.byteLength > limits.maxInputBytes) {
    return { status: 'too-large', text: '', truncated: false, detail: 'The attachment is larger than the indexing limit' }
  }
  try {
    const content = input.content
    const extracted = kind === 'pdf'
      ? extractPdfText(content, limits)
      : kind === 'text' || kind === 'html'
        ? extractPlainText(content, kind === 'html', limits)
        : extractOfficeText(content, kind, limits)
    if (!extracted.text && extracted.truncated) return { status: 'too-large', text: '', truncated: false, detail: 'The document expands beyond the indexing limit' }
    if (!extracted.text) return { status: 'empty', text: '', truncated: false, detail: kind === 'pdf' ? 'No text was found; the PDF may contain only scanned images' : 'No text was found' }
    return { status: 'indexed', text: extracted.text, truncated: extracted.truncated }
  } catch (error) {
    if (error instanceof AttachmentTextError) return { status: error.status, text: '', truncated: false, detail: error.message }
    return { status: 'failed', text: '', truncated: false, detail: 'The attachment could not be read' }
  }
}
