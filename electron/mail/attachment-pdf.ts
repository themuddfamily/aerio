// Bounded PDF text extraction for search indexing. This is deliberately not a
// full PDF renderer: it walks the page tree, inflates Flate-compressed content
// streams within a byte budget, follows ToUnicode CMaps for embedded fonts, and
// reads text-showing operators in page and form content. Layout, rotation,
// glyph-name encodings, and scanned (image-only) pages are out of scope, and
// encrypted PDFs are reported rather than decrypted.
import { constants, inflateSync } from 'node:zlib'
import { AttachmentTextError, TextBudget, type AttachmentTextLimits } from './attachment-text-types'

interface PdfObject {
  /** The object's dictionary or other direct value, as latin1 text. */
  body: string
  /** Raw (still encoded) stream bytes, when the object is a stream. */
  stream?: Buffer
}

interface FontDecoder {
  map?: Map<number, string>
  codeLength: number
  /** Composite fonts without a ToUnicode map show glyph ids that cannot be turned into text. */
  composite: boolean
}

const MAX_TREE_DEPTH = 32
const MAX_FORM_DEPTH = 4
const MAX_CMAP_ENTRIES = 65_536
const MAX_OPERANDS = 4_096
const WHITESPACE = /[\0\t\n\f\r ]/
const DELIMITER = /[\0\t\n\f\r ()<>[\]{}/%]/
const windows1252 = new TextDecoder('windows-1252')

class ExpansionLimit extends Error {}

function skipLiteral(source: string, start: number) {
  let depth = 0
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (char === '\\') index += 1
    else if (char === '(') depth += 1
    else if (char === ')' && --depth === 0) return index + 1
  }
  return source.length
}

function skipBalanced(source: string, start: number, open: string, close: string) {
  let depth = 0
  for (let index = start; index < source.length;) {
    if (source.startsWith(open, index)) { depth += 1; index += open.length; continue }
    if (source.startsWith(close, index)) {
      depth -= 1
      index += close.length
      if (depth === 0) return index
      continue
    }
    const char = source[index]
    if (char === '(') index = skipLiteral(source, index)
    else if (char === '<' && source[index + 1] !== '<' && open === '<<') index = (source.indexOf('>', index) + 1) || source.length
    else index += 1
  }
  return source.length
}

/** Reads one PDF value starting at `start`, returning its raw text. */
function readValue(source: string, start: number) {
  let index = start
  while (index < source.length && WHITESPACE.test(source[index])) index += 1
  if (source.startsWith('<<', index)) return source.slice(index, skipBalanced(source, index, '<<', '>>'))
  if (source[index] === '[') return source.slice(index, skipBalanced(source, index, '[', ']'))
  if (source[index] === '(') return source.slice(index, skipLiteral(source, index))
  const reference = /^(\d+)\s+(\d+)\s+R\b/.exec(source.slice(index, index + 40))
  if (reference) return reference[0]
  let end = index + 1
  while (end < source.length && !DELIMITER.test(source[end])) end += 1
  return source.slice(index, end)
}

/** Looks up a key in a dictionary's top level only, ignoring nested dictionaries and arrays. */
function dictValue(dict: string, key: string): string | undefined {
  let depth = 0
  let arrays = 0
  for (let index = 0; index < dict.length;) {
    const char = dict[index]
    if (dict.startsWith('<<', index)) { depth += 1; index += 2; continue }
    if (dict.startsWith('>>', index)) { depth -= 1; index += 2; continue }
    if (char === '(') { index = skipLiteral(dict, index); continue }
    if (char === '<') { index = (dict.indexOf('>', index) + 1) || dict.length; continue }
    if (char === '[') { arrays += 1; index += 1; continue }
    if (char === ']') { arrays -= 1; index += 1; continue }
    if (char === '/') {
      let end = index + 1
      while (end < dict.length && !DELIMITER.test(dict[end])) end += 1
      if (depth === 1 && arrays === 0 && dict.slice(index + 1, end) === key) return readValue(dict, end)
      index = end
      continue
    }
    index += 1
  }
  return undefined
}

const referenceNumber = (value: string | undefined) => {
  const match = value ? /^(\d+)\s+\d+\s+R$/.exec(value.trim()) : null
  return match ? Number(match[1]) : undefined
}

const references = (value: string | undefined) => Array.from(value?.matchAll(/(\d+)\s+\d+\s+R\b/g) ?? [], (match) => Number(match[1]))

const nameValue = (value: string | undefined) => value?.trim().startsWith('/') ? value.trim().slice(1) : undefined

function parseObjects(source: string, buffer: Buffer) {
  const objects = new Map<number, PdfObject>()
  const pattern = /(\d+)\s+\d+\s+obj\b/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source))) {
    const number = Number(match[1])
    let start = pattern.lastIndex
    while (start < source.length && WHITESPACE.test(source[start])) start += 1
    if (!source.startsWith('<<', start)) {
      const end = source.indexOf('endobj', start)
      if (end < 0) break
      objects.set(number, { body: source.slice(start, end).trim() })
      pattern.lastIndex = end + 6
      continue
    }
    const dictEnd = skipBalanced(source, start, '<<', '>>')
    const body = source.slice(start, dictEnd)
    const keyword = /^\s*stream(\r\n|\n|\r)?/.exec(source.slice(dictEnd, dictEnd + 16))
    if (!keyword) {
      objects.set(number, { body })
      pattern.lastIndex = dictEnd
      continue
    }
    const dataStart = dictEnd + keyword[0].length
    const declared = Number(/^\d+$/.test(dictValue(body, 'Length') ?? '') ? dictValue(body, 'Length') : NaN)
    let dataEnd = Number.isFinite(declared) && /^\s*endstream/.test(source.slice(dataStart + declared, dataStart + declared + 16))
      ? dataStart + declared
      : source.indexOf('endstream', dataStart)
    if (dataEnd < 0) dataEnd = source.length
    objects.set(number, { body, stream: buffer.subarray(dataStart, dataEnd) })
    pattern.lastIndex = dataEnd
  }
  return objects
}

class PdfDocument {
  private expanded = 0
  private decoded = new Map<number, string | undefined>()
  private fonts = new Map<number, FontDecoder>()
  truncated = false

  constructor(readonly objects: Map<number, PdfObject>, private readonly maxExpandedBytes: number) {
    this.expandObjectStreams()
  }

  object(value: string | number | undefined) {
    const number = typeof value === 'number' ? value : referenceNumber(value)
    return number === undefined ? undefined : this.objects.get(number)
  }

  /** Resolves an indirect reference to its dictionary text, or returns a direct value as-is. */
  resolve(value: string | undefined) {
    if (value === undefined) return undefined
    const number = referenceNumber(value)
    return number === undefined ? value : this.objects.get(number)?.body
  }

  /** Decoded stream text, or undefined for unsupported filters. Throws ExpansionLimit past the budget. */
  streamText(number: number) {
    if (this.decoded.has(number)) return this.decoded.get(number)
    const object = this.objects.get(number)
    let result: string | undefined
    if (object?.stream) {
      const filterValue = this.resolve(dictValue(object.body, 'Filter'))
      const filters = Array.from(filterValue?.matchAll(/\/(\w+)/g) ?? [], (match) => match[1])
      if (filters.every((filter) => filter === 'FlateDecode' || filter === 'Fl')) {
        let data = object.stream
        for (let index = 0; index < filters.length; index += 1) data = this.inflate(data)
        if (!filters.length) this.account(data.byteLength)
        result = data.toString('latin1')
      }
    }
    this.decoded.set(number, result)
    return result
  }

  private account(bytes: number) {
    this.expanded += bytes
    if (this.expanded > this.maxExpandedBytes) throw new ExpansionLimit()
  }

  private inflate(data: Buffer) {
    const room = this.maxExpandedBytes - this.expanded
    if (room <= 0) throw new ExpansionLimit()
    let output: Buffer
    try {
      // Sync flush tolerates the truncated streams some PDF writers produce.
      output = inflateSync(data, { maxOutputLength: room, finishFlush: constants.Z_SYNC_FLUSH })
    } catch (error) {
      if (error instanceof RangeError || (error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw new ExpansionLimit()
      return Buffer.alloc(0)
    }
    this.account(output.byteLength)
    return output
  }

  private expandObjectStreams() {
    for (const [number, object] of [...this.objects]) {
      if (!object.stream || nameValue(dictValue(object.body, 'Type')) !== 'ObjStm') continue
      let text: string | undefined
      try { text = this.streamText(number) } catch (error) { if (error instanceof ExpansionLimit) { this.truncated = true; return } throw error }
      this.decoded.delete(number)
      if (!text) continue
      const count = Number(dictValue(object.body, 'N'))
      const first = Number(dictValue(object.body, 'First'))
      if (!Number.isInteger(count) || !Number.isInteger(first) || count < 0 || first < 0) continue
      const header = text.slice(0, first).trim().split(/\s+/).map(Number)
      for (let index = 0; index < count && index * 2 + 1 < header.length; index += 1) {
        const id = header[index * 2]
        const start = first + header[index * 2 + 1]
        const end = index + 1 < count && index * 2 + 3 < header.length ? first + header[index * 2 + 3] : text.length
        // Objects stored directly in the file win: they come from later incremental updates.
        if (Number.isInteger(id) && !this.objects.has(id)) this.objects.set(id, { body: text.slice(start, end).trim() })
      }
    }
  }

  font(reference: number): FontDecoder {
    const cached = this.fonts.get(reference)
    if (cached) return cached
    const dict = this.objects.get(reference)?.body ?? ''
    const composite = nameValue(dictValue(dict, 'Subtype')) === 'Type0'
    const cmapReference = referenceNumber(dictValue(dict, 'ToUnicode'))
    const cmapText = cmapReference === undefined ? undefined : this.streamText(cmapReference)
    const decoder: FontDecoder = cmapText ? { ...parseCMap(cmapText), composite } : { codeLength: composite ? 2 : 1, composite }
    this.fonts.set(reference, decoder)
    return decoder
  }
}

const utf16 = (hex: string) => {
  let value = ''
  for (let index = 0; index + 4 <= hex.length; index += 4) value += String.fromCharCode(Number.parseInt(hex.slice(index, index + 4), 16))
  return value
}

export function parseCMap(text: string): { map: Map<number, string>; codeLength: number } {
  const map = new Map<number, string>()
  const codespace = /begincodespacerange\s*<([0-9a-fA-F]+)>/.exec(text)
  let codeLength = codespace ? Math.max(1, Math.ceil(codespace[1].length / 2)) : 0
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) {
      if (map.size >= MAX_CMAP_ENTRIES) break
      codeLength ||= Math.ceil(pair[1].length / 2)
      map.set(Number.parseInt(pair[1], 16), utf16(pair[2]))
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const range of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
      codeLength ||= Math.ceil(range[1].length / 2)
      const low = Number.parseInt(range[1], 16)
      const high = Math.min(Number.parseInt(range[2], 16), low + MAX_CMAP_ENTRIES)
      if (range[3].startsWith('[')) {
        const targets = Array.from(range[3].matchAll(/<([0-9a-fA-F]*)>/g), (match) => utf16(match[1]))
        for (let code = low; code <= high && map.size < MAX_CMAP_ENTRIES; code += 1) {
          if (targets[code - low] !== undefined) map.set(code, targets[code - low])
        }
        continue
      }
      const base = utf16(range[3].slice(1, -1))
      if (!base) continue
      const prefix = base.slice(0, -1)
      const last = base.charCodeAt(base.length - 1)
      for (let code = low; code <= high && map.size < MAX_CMAP_ENTRIES; code += 1) map.set(code, prefix + String.fromCharCode(last + code - low))
    }
  }
  return { map, codeLength: codeLength || 1 }
}

function decodeString(bytes: string, font: FontDecoder | undefined) {
  if (!font?.map) {
    if (font?.composite) return ''
    return windows1252.decode(Buffer.from(bytes, 'latin1'))
  }
  let value = ''
  for (let index = 0; index + font.codeLength <= bytes.length; index += font.codeLength) {
    let code = 0
    for (let offset = 0; offset < font.codeLength; offset += 1) code = code * 256 + bytes.charCodeAt(index + offset)
    const mapped = font.map.get(code)
    if (mapped !== undefined) value += mapped
    else if (!font.composite && font.codeLength === 1) value += windows1252.decode(Buffer.from([code]))
  }
  return value
}

function literalString(source: string, start: number) {
  let value = ''
  let depth = 0
  let index = start
  for (; index < source.length; index += 1) {
    const char = source[index]
    if (char === '\\') {
      const next = source[++index]
      if (next === undefined) break
      const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }
      if (escapes[next]) value += escapes[next]
      else if (/[0-7]/.test(next)) {
        let digits = next
        while (digits.length < 3 && /[0-7]/.test(source[index + 1] ?? '')) digits += source[++index]
        value += String.fromCharCode(Number.parseInt(digits, 8) & 0xff)
      } else if (next === '\r') { if (source[index + 1] === '\n') index += 1 }
      else if (next !== '\n') value += next
      continue
    }
    if (char === '(') { if (depth++ > 0) value += char; continue }
    if (char === ')') {
      if (--depth === 0) return { value, end: index + 1 }
      value += char
      continue
    }
    value += char
  }
  return { value, end: index }
}

type Operand = { kind: 'string'; value: string } | { kind: 'name'; value: string } | { kind: 'number'; value: number } | { kind: 'array'; items: Operand[] } | { kind: 'other' }

interface ContentContext {
  document: PdfDocument
  fonts: Map<string, number>
  forms: Map<string, number>
  out: TextBudget
  depth: number
  visitedForms: Set<number>
}

function resourceMap(document: PdfDocument, resources: string | undefined, category: string) {
  const map = new Map<string, number>()
  const dict = document.resolve(resources ? dictValue(resources, category) : undefined)
  if (!dict) return map
  for (const match of dict.matchAll(/\/([^\s/<>[\]()%]+)\s+(\d+)\s+\d+\s+R\b/g)) map.set(match[1], Number(match[2]))
  return map
}

function interpret(content: string, context: ContentContext) {
  const { out } = context
  let font: FontDecoder | undefined
  const operands: Operand[] = []
  const arrays: Operand[][] = []
  const push = (operand: Operand) => {
    const target = arrays.at(-1) ?? operands
    if (target.length < MAX_OPERANDS) target.push(operand)
  }
  const show = (operand: Operand | undefined) => {
    if (operand?.kind === 'string') out.push(decodeString(operand.value, font))
    else if (operand?.kind === 'array') {
      for (const item of operand.items) {
        if (item.kind === 'string') out.push(decodeString(item.value, font))
        else if (item.kind === 'number' && item.value < -250) out.push(' ')
      }
    }
  }
  for (let index = 0; index < content.length && !out.truncated;) {
    const char = content[index]
    if (WHITESPACE.test(char)) { index += 1; continue }
    if (char === '%') { const end = content.indexOf('\n', index); index = end < 0 ? content.length : end + 1; continue }
    if (char === '(') {
      const literal = literalString(content, index)
      push({ kind: 'string', value: literal.value })
      index = literal.end
      continue
    }
    if (content.startsWith('<<', index)) { index = skipBalanced(content, index, '<<', '>>'); push({ kind: 'other' }); continue }
    if (char === '<') {
      const end = content.indexOf('>', index)
      const hex = content.slice(index + 1, end < 0 ? content.length : end).replaceAll(/[^0-9a-fA-F]/g, '')
      push({ kind: 'string', value: Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex').toString('latin1') })
      index = end < 0 ? content.length : end + 1
      continue
    }
    if (char === '[') { arrays.push([]); index += 1; continue }
    if (char === ']') {
      const items = arrays.pop()
      if (items) push({ kind: 'array', items })
      index += 1
      continue
    }
    let end = index + 1
    while (end < content.length && !DELIMITER.test(content[end])) end += 1
    const token = content.slice(index, end)
    index = end
    if (char === '/') { push({ kind: 'name', value: token.slice(1) }); continue }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(token)) { push({ kind: 'number', value: Number(token) }); continue }
    if (token === 'true' || token === 'false' || token === 'null') { push({ kind: 'other' }); continue }
    // Anything else is an operator; inline images carry raw bytes that must be skipped whole.
    if (token === 'BI') {
      const data = content.indexOf('ID', index)
      const image = data < 0 ? null : /\sEI(?=[\s]|$)/g
      if (image) image.lastIndex = data + 2
      const match = image?.exec(content)
      index = match ? match.index + match[0].length : content.length
    } else if (token === 'Tf') {
      const name = operands.find((operand) => operand.kind === 'name')
      const reference = name?.kind === 'name' ? context.fonts.get(name.value) : undefined
      font = reference === undefined ? undefined : context.document.font(reference)
    } else if (token === 'Tj') show(operands.at(-1))
    else if (token === 'TJ') show(operands.at(-1))
    else if (token === '\'' || token === '"') { out.push('\n'); show(operands.at(-1)) }
    else if (token === 'T*' || token === 'ET') out.push('\n')
    else if (token === 'Td' || token === 'TD') {
      const y = operands.at(-1)
      out.push(y?.kind === 'number' && y.value !== 0 ? '\n' : ' ')
    } else if (token === 'Tm') out.push(' ')
    else if (token === 'Do' && context.depth < MAX_FORM_DEPTH) {
      const name = operands.at(-1)
      const reference = name?.kind === 'name' ? context.forms.get(name.value) : undefined
      if (reference !== undefined) interpretForm(reference, context)
    }
    operands.length = 0
    arrays.length = 0
  }
}

function interpretForm(reference: number, context: ContentContext) {
  if (context.visitedForms.has(reference)) return
  const object = context.document.object(reference)
  if (!object?.stream || nameValue(dictValue(object.body, 'Subtype')) !== 'Form') return
  context.visitedForms.add(reference)
  const content = context.document.streamText(reference)
  if (!content) return
  const resources = context.document.resolve(dictValue(object.body, 'Resources'))
  interpret(content, {
    ...context,
    fonts: resources ? resourceMap(context.document, resources, 'Font') : context.fonts,
    forms: resources ? resourceMap(context.document, resources, 'XObject') : context.forms,
    depth: context.depth + 1
  })
  context.visitedForms.delete(reference)
}

interface PdfPage {
  contents: number[]
  resources?: string
}

function collectPages(document: PdfDocument, source: string) {
  const roots = Array.from(source.matchAll(/\/Root\s+(\d+)\s+\d+\s+R\b/g), (match) => Number(match[1]))
  let catalog = roots.length ? document.objects.get(roots.at(-1)!)?.body : undefined
  if (!catalog) catalog = [...document.objects.values()].find((object) => nameValue(dictValue(object.body, 'Type')) === 'Catalog')?.body
  const pages: PdfPage[] = []
  const visited = new Set<number>()
  const walk = (number: number | undefined, inherited: string | undefined, depth: number) => {
    if (number === undefined || visited.has(number) || depth > MAX_TREE_DEPTH) return
    visited.add(number)
    const dict = document.objects.get(number)?.body
    if (!dict) return
    const resources = document.resolve(dictValue(dict, 'Resources')) ?? inherited
    const type = nameValue(dictValue(dict, 'Type'))
    const kids = dictValue(dict, 'Kids')
    if (type === 'Pages' || (type === undefined && kids)) {
      for (const kid of references(document.resolve(kids))) walk(kid, resources, depth + 1)
      return
    }
    const contents = dictValue(dict, 'Contents')
    const direct = referenceNumber(contents)
    // /Contents is a stream or an array of streams, possibly held in an indirect array.
    const streams = direct !== undefined && document.objects.get(direct)?.stream ? [direct] : references(document.resolve(contents))
    pages.push({ contents: streams, resources })
  }
  walk(referenceNumber(catalog ? dictValue(catalog, 'Pages') : undefined), undefined, 0)
  return pages
}

export function isPdf(buffer: Buffer) {
  return buffer.subarray(0, 1024).includes('%PDF-')
}

export function extractPdfText(buffer: Buffer, limits: Pick<AttachmentTextLimits, 'maxTextChars' | 'maxExpandedBytes'>) {
  if (!isPdf(buffer)) throw new AttachmentTextError('failed', 'The file is not a valid PDF')
  const source = buffer.toString('latin1')
  if (/\/Encrypt\s*(\d+\s+\d+\s+R\b|<<)/.test(source)) throw new AttachmentTextError('encrypted', 'The PDF is encrypted or password-protected')
  const document = new PdfDocument(parseObjects(source, buffer), limits.maxExpandedBytes)
  const out = new TextBudget(limits.maxTextChars)
  const context = (resources: string | undefined): ContentContext => ({
    document,
    fonts: resourceMap(document, resources, 'Font'),
    forms: resourceMap(document, resources, 'XObject'),
    out,
    depth: 0,
    visitedForms: new Set()
  })
  try {
    const pages = collectPages(document, source)
    if (pages.length) {
      for (const page of pages) {
        const pageContext = context(page.resources)
        // A page's content streams are one logical stream split at token boundaries.
        const content = page.contents.map((number) => document.streamText(number) ?? '').join('\n')
        interpret(content, pageContext)
        out.push('\n')
        if (out.truncated) break
      }
    } else {
      // Without a readable page tree, scan any stream that looks like page content.
      for (const [number, object] of document.objects) {
        if (!object.stream || dictValue(object.body, 'Subtype') || dictValue(object.body, 'Type') || dictValue(object.body, 'Length1')) continue
        const content = document.streamText(number)
        if (content?.includes('BT')) interpret(content, context(undefined))
        if (out.truncated) break
      }
    }
  } catch (error) {
    if (!(error instanceof ExpansionLimit)) throw error
    out.truncated = true
  }
  return { text: out.text(), truncated: out.truncated || document.truncated }
}
