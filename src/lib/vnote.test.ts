import { describe, expect, it } from 'vitest'
import { parseVNoteDate, parseVNotes, VNoteFormatError, vnoteFingerprint } from './vnote'

const file = (text: string) => new TextEncoder().encode(text)
const latin1File = (text: string) => Uint8Array.from(text, (character) => character.charCodeAt(0))

describe('vNote import parsing', () => {
  it('reads several notes with quoted-printable bodies, soft line breaks, charsets, dates, class, and X- properties', () => {
    const result = parseVNotes(file([
      'BEGIN:VNOTE', 'VERSION:1.1',
      'BODY;ENCODING=QUOTED-PRINTABLE;CHARSET=UTF-8:Groceries=0D=0AMilk =E2=80=93 2 l=0D=0A=',
      'Bread',
      'DCREATED:20240102T030405Z', 'LAST-MODIFIED:20240103T101112Z', 'CLASS:PRIVATE', 'CATEGORIES:Home;Errands',
      'X-IRMC-LUID:000001', 'X-ORGANIZER-COLOR:yellow', 'END:VNOTE',
      'BEGIN:VNOTE', 'VERSION:1.1', 'SUMMARY:Ideas', 'BODY:Line one\\nLine two', 'END:VNOTE', ''
    ].join('\r\n')))
    expect(result.errors).toEqual([])
    expect(result.notes).toHaveLength(2)
    const [groceries, ideas] = result.notes
    expect(groceries).toMatchObject({
      index: 1, title: 'Groceries', body: 'Groceries\nMilk – 2 l\nBread', created: '2024-01-02T03:04:05.000Z', modified: '2024-01-03T10:11:12.000Z',
      classification: 'PRIVATE', luid: '000001', categories: ['Home', 'Errands']
    })
    expect(groceries.extras).toEqual([{ name: 'X-ORGANIZER-COLOR', params: {}, value: 'yellow' }])
    expect(ideas).toMatchObject({ title: 'Ideas', body: 'Line one\nLine two' })
  })

  it('decodes legacy 8-bit text in its declared charset and falls back to Windows-1252 when undeclared', () => {
    const declared = parseVNotes(latin1File('BEGIN:VNOTE\r\nBODY;CHARSET=ISO-8859-1:Caf\xe9 cr\xe8me\r\nEND:VNOTE\r\n'))
    expect(declared.notes[0].body).toBe('Café crème')
    const undeclared = parseVNotes(latin1File('BEGIN:VNOTE\r\nBODY:Smart \x93quotes\x94\r\nEND:VNOTE\r\n'))
    expect(undeclared.notes[0].body).toBe('Smart “quotes”')
    const qp = parseVNotes(latin1File('BEGIN:VNOTE\r\nBODY;QUOTED-PRINTABLE;CHARSET=ISO-8859-1:Gr=FC=DFe\r\nEND:VNOTE\r\n'))
    expect(qp.notes[0].body).toBe('Grüße')
    const base64 = parseVNotes(file(`BEGIN:VNOTE\r\nBODY;ENCODING=BASE64;CHARSET=UTF-8:${Buffer.from('Ünïcode body').toString('base64')}\r\nEND:VNOTE\r\n`))
    expect(base64.notes[0].body).toBe('Ünïcode body')
  })

  it('reports malformed entries individually and keeps the readable ones', () => {
    const result = parseVNotes(file([
      'stray line', 'BEGIN:VNOTE', 'VERSION:1.1', 'DCREATED:20240102T030405Z', 'END:VNOTE',
      'BEGIN:VNOTE', 'BODY;CHARSET=X-KLINGON:abc', 'END:VNOTE',
      'BEGIN:VNOTE', 'VERSION:3.0', 'BODY:future', 'END:VNOTE',
      'BEGIN:VNOTE', 'BODY:fine', 'not a property', 'END:VNOTE',
      'BEGIN:VNOTE', 'BODY:cut off'
    ].join('\n')))
    expect(result.notes.map((note) => note.error)).toEqual([
      'This note has no BODY', 'The character set X-KLINGON is not supported', 'vNote version 3.0 is not supported', undefined, 'The file ended before END:VNOTE'
    ])
    expect(result.notes[3]).toMatchObject({ body: 'fine', warning: '1 malformed line was skipped' })
    expect(result.errors).toEqual(['1 line outside a note was ignored'])
  })

  it('refuses files without any vNote and oversized files', () => {
    expect(() => parseVNotes(file('BEGIN:VCARD\r\nFN:Ada\r\nEND:VCARD\r\n'))).toThrow(VNoteFormatError)
    expect(() => parseVNotes(new Uint8Array(21 * 1024 * 1024))).toThrow(/smaller than 20 MB/)
  })

  it('parses dates and fingerprints notes for duplicate detection', () => {
    expect(parseVNoteDate('20240229')).toBe(new Date(2024, 1, 29).toISOString())
    expect(parseVNoteDate('2024-13-01')).toBeUndefined()
    expect(vnoteFingerprint(' Title ', 'Body\r\nline  \n')).toBe(vnoteFingerprint('title', 'Body\nline'))
    expect(vnoteFingerprint('Title', 'Body')).not.toBe(vnoteFingerprint('Title', 'Other'))
  })
})
