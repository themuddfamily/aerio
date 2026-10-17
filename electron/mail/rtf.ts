// Compressed RTF (MS-OXRTFCP) and HTML-in-RTF de-encapsulation (MS-OXRTFEX)
// for Outlook message bodies. Both are bounded: the decompressor refuses
// output beyond a size limit and the RTF reader caps nesting and output.

const COMPRESSED = 0x75465a4c // "LZFu"
const UNCOMPRESSED = 0x414c454d // "MELA"
// The dictionary every compressed RTF stream starts with (MS-OXRTFCP 2.1.3.1.1).
const PREBUFFER = Buffer.from('{\\rtf1\\ansi\\mac\\deff0\\deftab720{\\fonttbl;}{\\f0\\fnil \\froman \\fswiss \\fmodern \\fscript \\fdecor MS Sans SerifSymbolArialTimes New RomanCourier{\\colortbl\\red0\\green0\\blue0\r\n\\par \\pard\\plain\\f0\\fs20\\b\\i\\u\\tab\\tx', 'latin1')

export class RtfTooLargeError extends Error {}

/** Decompresses PidTagRtfCompressed; refuses streams that would exceed `maxBytes`. */
export function decompressRtf(data: Buffer, maxBytes: number): Buffer {
  if (data.length < 16) throw new Error('The compressed RTF body is truncated')
  const rawSize = data.readUInt32LE(4)
  const type = data.readUInt32LE(8)
  if (rawSize > maxBytes) throw new RtfTooLargeError('The RTF body is larger than the import limit')
  if (type === UNCOMPRESSED) return Buffer.from(data.subarray(16, 16 + rawSize))
  if (type !== COMPRESSED) throw new Error('The RTF body uses an unknown compression format')
  const dictionary = Buffer.alloc(4096)
  PREBUFFER.copy(dictionary)
  let write = PREBUFFER.length
  const output = Buffer.alloc(rawSize)
  let length = 0
  let position = 16
  while (position < data.length && length < rawSize) {
    const control = data[position++]
    for (let bit = 0; bit < 8 && length < rawSize; bit += 1) {
      if (!(control & (1 << bit))) {
        if (position >= data.length) return output.subarray(0, length)
        const byte = data[position++]
        output[length++] = byte
        dictionary[write] = byte
        write = (write + 1) % 4096
        continue
      }
      if (position + 1 >= data.length) return output.subarray(0, length)
      const reference = data.readUInt16BE(position)
      position += 2
      let offset = reference >> 4
      const count = (reference & 0x0f) + 2
      // A reference to the current write position marks the end of the stream.
      if (offset === write) return output.subarray(0, length)
      for (let index = 0; index < count && length < rawSize; index += 1) {
        const byte = dictionary[offset]
        output[length++] = byte
        dictionary[write] = byte
        write = (write + 1) % 4096
        offset = (offset + 1) % 4096
      }
    }
  }
  return output.subarray(0, length)
}

// \fcharsetN values mapped to Windows code pages for \'hh bytes.
const CHARSET_CODEPAGES: Record<number, number> = {
  77: 10000, 128: 932, 129: 949, 130: 1361, 134: 936, 136: 950, 161: 1253, 162: 1254, 163: 1258,
  177: 1255, 178: 1256, 186: 1257, 204: 1251, 222: 874, 238: 1250, 254: 437
}
const CODEPAGE_LABELS: Record<number, string> = {
  437: 'ibm866', 874: 'windows-874', 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5',
  1250: 'windows-1250', 1251: 'windows-1251', 1252: 'windows-1252', 1253: 'windows-1253', 1254: 'windows-1254',
  1255: 'windows-1255', 1256: 'windows-1256', 1257: 'windows-1257', 1258: 'windows-1258', 10000: 'macintosh',
  20127: 'windows-1252', 28591: 'windows-1252', 65001: 'utf-8'
}
const decoders = new Map<string, TextDecoder>()
export function decodeCodepage(bytes: Uint8Array, codepage: number) {
  const label = CODEPAGE_LABELS[codepage] ?? 'windows-1252'
  let decoder = decoders.get(label)
  if (!decoder) {
    try { decoder = new TextDecoder(label) } catch { decoder = new TextDecoder('windows-1252') }
    decoders.set(label, decoder)
  }
  return decoder.decode(bytes)
}

// Destinations whose text is never part of the message body.
const IGNORED_DESTINATIONS = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'header', 'footer', 'headerl', 'headerr', 'headerf',
  'footerl', 'footerr', 'footerf', 'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'xmlnstbl', 'themedata',
  'colorschememapping', 'latentstyles', 'datastore', 'filetbl', 'revtbl', 'pgdsctbl', 'fldinst', 'bkmkstart', 'bkmkend'
])
const SYMBOLS: Record<string, string> = {
  emdash: '—', endash: '–', bullet: '•', lquote: '‘', rquote: '’', ldblquote: '“',
  rdblquote: '”', emspace: ' ', enspace: ' ', qmspace: ' ', zwj: '‍', zwnj: '‌'
}

interface GroupState {
  /** Text in this group is not output (an ignored destination). */
  skip: boolean
  /** Inside \htmlrtf … \htmlrtf0: RTF-only formatting hidden from the HTML. */
  htmlrtf: boolean
  /** Inside an encapsulated {\*\htmltag …} group. */
  htmltag: boolean
  /** Characters to skip after \uN. */
  uc: number
  codepage: number
  fonttbl: boolean
}

export interface RtfBody {
  kind: 'html' | 'text'
  content: string
}

const MAX_DEPTH = 512

/**
 * Turns an RTF body into HTML when it encapsulates HTML (\fromhtml1, as
 * Outlook stores HTML mail), otherwise into plain text. Output is capped at
 * `maxChars`; malformed input never throws.
 */
export function rtfToBody(rtf: Buffer, maxChars = 16 * 1024 * 1024): RtfBody {
  const head = rtf.subarray(0, 2048).toString('latin1')
  const html = /\\fromhtml1?(?![a-z])/.test(head)
  let output = ''
  let pending: number[] = []
  let documentCodepage = 1252
  const fonts = new Map<number, number>()
  let fontNumber: number | undefined
  let state: GroupState = { skip: false, htmlrtf: false, htmltag: false, uc: 1, codepage: 1252, fonttbl: false }
  const stack: GroupState[] = []
  let skipChars = 0
  // A destination is decided by the first control word after "{" (or "{\*").
  let groupStart = false
  let starred = false

  const visible = () => !state.skip && (!html || !state.htmlrtf || state.htmltag)
  const flush = () => {
    if (!pending.length) return
    output += decodeCodepage(Uint8Array.from(pending), state.codepage)
    pending = []
  }
  const emitByte = (byte: number) => {
    if (skipChars > 0) {
      skipChars -= 1
      return
    }
    if (visible()) pending.push(byte)
  }
  const emit = (text: string) => {
    if (!visible()) return
    flush()
    output += text
  }

  let position = 0
  while (position < rtf.length && output.length + pending.length < maxChars) {
    const byte = rtf[position]
    if (byte === 0x7b) { // {
      flush()
      if (stack.length >= MAX_DEPTH) break
      stack.push(state)
      state = { ...state }
      groupStart = true
      starred = false
      position += 1
      continue
    }
    if (byte === 0x7d) { // }
      flush()
      state = stack.pop() ?? state
      groupStart = false
      position += 1
      continue
    }
    if (byte === 0x0d || byte === 0x0a) {
      position += 1
      continue
    }
    if (byte !== 0x5c) { // plain text
      if (state.fonttbl && byte === 0x3b) fontNumber = undefined
      groupStart = false
      emitByte(byte)
      position += 1
      continue
    }
    // Control symbol or word.
    const next = rtf[position + 1]
    if (next === undefined) break
    if (!isLetter(next)) {
      position += 2
      if (next === 0x27) { // \'hh
        const hex = rtf.subarray(position, position + 2).toString('latin1')
        position += 2
        if (/^[0-9a-f]{2}$/i.test(hex)) emitByte(Number.parseInt(hex, 16))
      } else if (next === 0x2a) { // \*
        starred = true
        continue
      } else if (next === 0x5c || next === 0x7b || next === 0x7d) {
        emitByte(next)
      } else if (next === 0x7e) {
        emit(' ')
      } else if (next === 0x5f) {
        emit('‑')
      } else if (next === 0x0d || next === 0x0a) {
        emit(html ? '\r\n' : '\n')
      }
      groupStart = false
      continue
    }
    let end = position + 1
    while (end < rtf.length && isLetter(rtf[end]) && end - position < 40) end += 1
    const word = rtf.subarray(position + 1, end).toString('latin1')
    let parameterEnd = end
    if (rtf[parameterEnd] === 0x2d) parameterEnd += 1
    while (parameterEnd < rtf.length && rtf[parameterEnd] >= 0x30 && rtf[parameterEnd] <= 0x39 && parameterEnd - end < 11) parameterEnd += 1
    const parameterText = rtf.subarray(end, parameterEnd).toString('latin1')
    const parameter = parameterText && parameterText !== '-' ? Number.parseInt(parameterText, 10) : undefined
    position = rtf[parameterEnd] === 0x20 ? parameterEnd + 1 : parameterEnd

    if (groupStart) {
      groupStart = false
      flush()
      if (word === 'htmltag') {
        state.htmltag = html
        state.skip = state.skip || !html
        continue
      }
      if (word === 'fonttbl') {
        state.fonttbl = true
        state.skip = true
        continue
      }
      // Unknown \* destinations (including \mhtmltag) are skipped.
      if (starred || IGNORED_DESTINATIONS.has(word)) state.skip = true
    }
    if (state.fonttbl) {
      if (word === 'f' && parameter !== undefined) fontNumber = parameter
      else if (word === 'fcharset' && parameter !== undefined && fontNumber !== undefined && CHARSET_CODEPAGES[parameter]) fonts.set(fontNumber, CHARSET_CODEPAGES[parameter])
      continue
    }
    switch (word) {
      case 'ansicpg':
        if (parameter) {
          flush()
          documentCodepage = parameter
          state.codepage = parameter
        }
        break
      case 'f':
        flush()
        state.codepage = (parameter !== undefined ? fonts.get(parameter) : undefined) ?? documentCodepage
        break
      case 'htmlrtf':
        flush()
        state.htmlrtf = parameter !== 0
        break
      case 'uc':
        if (parameter !== undefined && parameter >= 0 && parameter < 10) state.uc = parameter
        break
      case 'u':
        if (parameter !== undefined) {
          emit(String.fromCharCode(parameter < 0 ? parameter + 65536 : parameter))
          skipChars = state.uc
        }
        break
      case 'par': case 'line': case 'row': case 'sect': case 'page':
        emit(html ? '\r\n' : '\n')
        break
      case 'tab': case 'cell':
        emit('\t')
        break
      default:
        if (SYMBOLS[word]) emit(SYMBOLS[word])
        else if (word === 'bin' && parameter && parameter > 0) position += parameter
    }
  }
  flush()
  output = output.slice(0, maxChars)
  if (html) return { kind: 'html', content: output }
  return { kind: 'text', content: output.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() }
}

const isLetter = (byte: number) => (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a)
