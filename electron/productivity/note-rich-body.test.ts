import { describe, expect, it } from 'vitest'
import type { LocalModuleSnapshot } from '../../src/productivity-types'
import type { Note } from '../../src/types'
import { normalizeRichNotes, noteImageDataUrl, parseNoteImageUpload, sanitizeStoredNoteHtml, sniffNoteImageType, validNoteRichFields } from './note-rich-body'

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const note = (overrides: Partial<Note> = {}): Note => ({ id: 'note', folder: 'Personal', title: 'Note', content: '', tags: ['tag'], pinned: true, archived: false, updatedAt: '2026-10-01T09:00:00Z', color: '#fff0aa', ...overrides })

describe('rich note bodies in the main process', () => {
  it('sanitizes stored bodies and keeps only references to the note’s inline pictures', () => {
    const html = '<h1 onclick="x()">Plan</h1><img data-aerio-note-image="pic" src="https://tracker.test/a.png" alt="Pic" onerror="x()">' +
      '<img data-aerio-note-image="other"><img src="data:image/png;base64,AAAA"><a href="javascript:x()">bad</a><a href="mailto:a@example.test">mail</a>' +
      '<table style="background: url(https://x.test)"><tbody><tr><td style="color: red; position: fixed">Cell</td></tr></tbody></table><script>x()</script><style>p{}</style>'
    expect(sanitizeStoredNoteHtml(html, new Set(['pic']))).toBe(
      '<h1>Plan</h1><img data-aerio-note-image="pic" alt="Pic" /><a>bad</a><a href="mailto:a@example.test">mail</a><table><tbody><tr><td style="color: red">Cell</td></tr></tbody></table>'
    )
  })

  it('recomputes the plain-text projection and leaves plain notes and their fields untouched', () => {
    const plain = note({ id: 'plain', content: 'Plain\n  text' })
    const rich = note({ id: 'rich', content: 'stale', html: '<h2>Heading</h2><ul><li>Item &amp; more</li></ul><img data-aerio-note-image="pic">', attachments: [{ id: 'pic', name: 'Pic.png', size: 12, mime: 'image/png', path: 'C:/p.png', inline: true }] })
    const snapshot: LocalModuleSnapshot = { tasks: [], notes: [plain] }
    expect(normalizeRichNotes(snapshot)).toBe(snapshot)
    const normalized = normalizeRichNotes({ tasks: [], notes: [plain, rich] })
    expect(normalized.notes[0]).toBe(plain)
    expect(normalized.notes[1]).toEqual({ ...rich, content: 'Heading\nItem & more', html: '<h2>Heading</h2><ul><li>Item &amp; more</li></ul><img data-aerio-note-image="pic" />' })
  })

  it('validates rich fields and counts inline pictures separately from files', () => {
    const files = Array.from({ length: 50 }, (_, index) => ({ id: `f${index}`, name: 'f.txt', size: 1, path: 'C:/f' }))
    const pictures = Array.from({ length: 200 }, (_, index) => ({ id: `p${index}`, name: 'p.png', size: 1, path: 'C:/p', inline: true }))
    expect(validNoteRichFields(note({ html: '<b>x</b>', attachments: [...files, ...pictures] }))).toBe(true)
    expect(validNoteRichFields(note({ attachments: [...files, { id: 'extra', name: 'x', size: 1 }] }))).toBe(false)
    expect(validNoteRichFields(note({ attachments: [...pictures, { id: 'extra', name: 'x', size: 1, inline: true }] }))).toBe(false)
    expect(validNoteRichFields(note({ html: 3 as never }))).toBe(false)
    expect(validNoteRichFields(note({ attachments: [{ id: 'a', name: 'a', size: 1, inline: 'yes' as never }] }))).toBe(false)
    expect(validNoteRichFields(note({ attachments: 'bad' as never }))).toBe(false)
  })

  it('accepts only real raster pictures within the size limit', () => {
    const upload = parseNoteImageUpload({ name: 'Screen:shot?.png', dataUrl: `data:image/png;base64,${png.toString('base64')}` })
    expect(upload).toMatchObject({ mimeType: 'image/png', extension: 'png', name: 'Screen shot.png' })
    expect(upload.bytes.equals(png)).toBe(true)
    // The declared type is not trusted: a PNG labelled as JPEG is stored as PNG.
    expect(parseNoteImageUpload({ name: '', dataUrl: `data:image/jpeg;base64,${png.toString('base64')}` })).toMatchObject({ mimeType: 'image/png', name: 'Picture.png' })
    expect(() => parseNoteImageUpload({ name: 'x', dataUrl: `data:image/png;base64,${Buffer.from('<svg onload=x()>').toString('base64')}` })).toThrow(/not a readable/)
    expect(() => parseNoteImageUpload({ name: 'x', dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' })).toThrow(/PNG, JPEG/)
    expect(() => parseNoteImageUpload({ name: 'x', dataUrl: 'https://remote.test/a.png' })).toThrow(/PNG, JPEG/)
    expect(() => parseNoteImageUpload({ name: 'x', dataUrl: `data:image/png;base64,${Buffer.alloc(5 * 1024 * 1024 + 1, 1).toString('base64')}` })).toThrow()
    expect(() => parseNoteImageUpload(null)).toThrow()
  })

  it('identifies stored pictures by content for display', () => {
    expect(sniffNoteImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffNoteImageType(Buffer.from('GIF89a'))).toBe('image/gif')
    expect(sniffNoteImageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
    expect(sniffNoteImageType(Buffer.from('BM'))).toBe('image/bmp')
    expect(noteImageDataUrl(png)).toBe(`data:image/png;base64,${png.toString('base64')}`)
    expect(() => noteImageDataUrl(Buffer.from('plain text'))).toThrow(/not a supported image/)
  })
})
