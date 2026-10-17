import { describe, expect, it } from 'vitest'
import { literalLzfu, uncompressedRtf } from './mail-import.fixtures'
import { decompressRtf, rtfToBody, RtfTooLargeError } from './rtf'

// Test vectors from MS-OXRTFCP section 3.1 ("Compressing a simple string"
// and "Compressing a string with repetition").
const SIMPLE = Buffer.from('2d0000002b0000004c5a4675f1c5c7a703000a007263706731323542320af32068656c090020627705b06c647d0a800fa0', 'hex')
const REPEATED = Buffer.from('1a0000001c0000004c5a4675e2d44b51410004205758595a0d6e7d010eb0', 'hex')

describe('decompressRtf', () => {
  it('decodes the MS-OXRTFCP examples, including dictionary references', () => {
    expect(decompressRtf(SIMPLE, 1_000).toString('latin1')).toBe('{\\rtf1\\ansi\\ansicpg1252\\pard hello world}\r\n')
    expect(decompressRtf(REPEATED, 1_000).toString('latin1')).toBe('{\\rtf1 WXYZWXYZWXYZWXYZWXYZ}')
  })

  it('accepts uncompressed and literal-only streams', () => {
    expect(decompressRtf(uncompressedRtf('{\\rtf1 plain}'), 1_000).toString('latin1')).toBe('{\\rtf1 plain}')
    expect(decompressRtf(literalLzfu('{\\rtf1 literal text that spans several control bytes}'), 1_000).toString('latin1')).toBe('{\\rtf1 literal text that spans several control bytes}')
  })

  it('refuses oversized, truncated and unknown streams without throwing on short data', () => {
    expect(() => decompressRtf(SIMPLE, 10)).toThrow(RtfTooLargeError)
    expect(() => decompressRtf(Buffer.alloc(8), 100)).toThrow(/truncated/)
    const unknown = Buffer.from(SIMPLE)
    unknown.writeUInt32LE(0x12345678, 8)
    expect(() => decompressRtf(unknown, 100)).toThrow(/unknown compression/)
    // A stream cut short returns what was decoded so far.
    expect(decompressRtf(SIMPLE.subarray(0, 30), 1_000).toString('latin1')).toMatch(/^\{\\rtf1\\ansi/)
  })
})

describe('rtfToBody', () => {
  it('de-encapsulates HTML stored as RTF (MS-OXRTFEX)', () => {
    const rtf = [
      '{\\rtf1\\ansi\\ansicpg1252\\fromhtml1 \\deff0{\\fonttbl{\\f0\\fswiss\\fcharset0 Arial;}{\\f1\\fmodern Courier New;}}',
      '{\\colortbl\\red0\\green0\\blue0;}',
      '{\\*\\htmltag19 <html>}{\\*\\htmltag34 <head>}{\\*\\htmltag161 <title>}Caf\\\'e9{\\*\\htmltag169 </title>}{\\*\\htmltag41 </head>}',
      '{\\*\\htmltag50 <body>}\\htmlrtf {\\htmlrtf0',
      '{\\*\\htmltag64 <p class="x">}\\htmlrtf {\\htmlrtf0 Hello \\{world\\} \\u8364?5\\htmlrtf\\par\\htmlrtf0',
      '{\\*\\htmltag72 </p>}\\htmlrtf }\\htmlrtf0 \\htmlrtf }\\htmlrtf0',
      '{\\*\\htmltag84 <img src="cid:logo">}{\\*\\mhtmltag84 <img src="logo.png">}',
      '{\\*\\htmltag58 </body>}{\\*\\htmltag27 </html>}}'
    ].join('\r\n')
    const body = rtfToBody(Buffer.from(rtf, 'latin1'))
    expect(body.kind).toBe('html')
    expect(body.content).toBe('<html><head><title>Café</title></head><body><p class="x">Hello {world} €5</p><img src="cid:logo"></body></html>')
  })

  it('converts ordinary RTF to text with code pages, Unicode, symbols and field results', () => {
    const rtf = [
      '{\\rtf1\\ansi\\ansicpg1252\\fromtext\\deff0{\\fonttbl{\\f0\\fswiss\\fcharset0 Arial;}{\\f1\\fnil\\fcharset204 Arial Cyr;}}',
      '{\\colortbl;\\red192\\green192\\blue192;}{\\*\\generator Microsoft Exchange Server;}{\\info{\\author Somebody}}',
      '\\pard\\plain\\f0 Na\\\'efve \\ldblquote quote\\rdblquote\\tab end\\par',
      '{\\f1 \\\'cf\\\'f0\\\'e8\\\'e2\\\'e5\\\'f2}\\par',
      '\\uc1\\u26085?\\u26412?\\par',
      '{\\field{\\*\\fldinst HYPERLINK "https://example.test"}{\\fldrslt link text}}\\line',
      '{\\pict\\pngblip 89504e47}\\bin3 {}xafter binary',
      '}'
    ].join('\r\n')
    expect(rtfToBody(Buffer.from(rtf, 'latin1'))).toEqual({ kind: 'text', content: 'Naïve “quote”\tend\nПривет\n日本\nlink text\nafter binary' })
  })

  it('bounds output and nesting on malformed input', () => {
    expect(rtfToBody(Buffer.from('{\\rtf1 ' + 'a'.repeat(100) + '}'), 10).content).toBe('a'.repeat(10))
    const deep = '{'.repeat(5_000) + 'deep' + '}'.repeat(5_000)
    expect(() => rtfToBody(Buffer.from(deep))).not.toThrow()
    expect(rtfToBody(Buffer.from('{\\rtf1 unterminated \\'))).toEqual({ kind: 'text', content: 'unterminated' })
  })
})
