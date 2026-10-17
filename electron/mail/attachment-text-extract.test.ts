import { describe, expect, it } from 'vitest'
import { attachmentTextKind, extractAttachmentText } from './attachment-text-extract'
import { parseCMap } from './attachment-pdf'
import { DEFAULT_ATTACHMENT_TEXT_LIMITS, type AttachmentTextLimits } from './attachment-text-types'
import { docxFixture, pdfFixture, pptxFixture, simplePdf, xlsxFixture, zipFixture } from './attachment-test-fixtures'

const extract = (filename: string, content: Buffer | string, limits: Partial<AttachmentTextLimits> = {}, mimeType = 'application/octet-stream') =>
  extractAttachmentText({ filename, mimeType, content: Buffer.isBuffer(content) ? content : Buffer.from(content) }, { ...DEFAULT_ATTACHMENT_TEXT_LIMITS, ...limits })

describe('attachment text classification', () => {
  it('prefers the extension and falls back to the MIME type', () => {
    expect(attachmentTextKind('Report.PDF', 'application/octet-stream')).toBe('pdf')
    expect(attachmentTextKind('notes.docx', '')).toBe('docx')
    expect(attachmentTextKind('budget.xlsm', '')).toBe('xlsx')
    expect(attachmentTextKind('deck.pptx', '')).toBe('pptx')
    expect(attachmentTextKind('data.csv', '')).toBe('text')
    expect(attachmentTextKind('page.htm', '')).toBe('html')
    expect(attachmentTextKind('download', 'application/pdf')).toBe('pdf')
    expect(attachmentTextKind('download', 'text/plain; charset=utf-8')).toBe('text')
    expect(attachmentTextKind('memo.rtf', 'text/rtf')).toBeUndefined()
    expect(attachmentTextKind('legacy.doc', 'application/msword')).toBeUndefined()
    expect(attachmentTextKind('photo.png', 'image/png')).toBeUndefined()
  })

  it('reports unsupported and oversized attachments without parsing them', () => {
    expect(extract('photo.png', 'not text', {}, 'image/png')).toMatchObject({ status: 'unsupported', text: '' })
    expect(extract('big.txt', 'x'.repeat(20), { maxInputBytes: 10 })).toMatchObject({ status: 'too-large' })
  })
})

describe('plain text and HTML attachments', () => {
  it('decodes UTF-8, UTF-16, and Windows-1252 text', () => {
    expect(extract('a.txt', 'Café quarterly  report\r\n\r\nline two')).toEqual({ status: 'indexed', text: 'Café quarterly report\nline two', truncated: false })
    expect(extract('a.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Grüße', 'utf16le')])).text).toBe('Grüße')
    expect(extract('a.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x93, 0x71, 0x94])).text).toBe('café “q”')
  })

  it('treats binary content with a text name as unsupported and empty text as empty', () => {
    expect(extract('a.txt', Buffer.alloc(200))).toMatchObject({ status: 'unsupported' })
    expect(extract('a.txt', '   \n ')).toMatchObject({ status: 'empty' })
  })

  it('strips markup, scripts, and styles from HTML', () => {
    const html = '<html><head><title>x</title><style>.a{}</style></head><body><p>Hello&nbsp;<b>world</b></p><script>alert(1)</script><div>Next &amp; last</div></body></html>'
    expect(extract('page.html', html).text).toBe('Hello world\nNext & last')
  })

  it('truncates text at the character limit', () => {
    const result = extract('a.txt', 'abcdefghij'.repeat(10), { maxTextChars: 25 })
    expect(result).toMatchObject({ status: 'indexed', truncated: true })
    expect(result.text).toHaveLength(25)
  })
})

describe('Office Open XML attachments', () => {
  it('extracts Word paragraphs, headers, and entities', () => {
    const docx = docxFixture(['Quarterly revenue', 'Tom & Jerry'], [
      { name: 'word/header1.xml', data: '<w:hdr><w:p><w:r><w:t>Confidential</w:t><w:tab/><w:t>draft</w:t></w:r></w:p></w:hdr>' }
    ])
    expect(extract('memo.docx', docx)).toEqual({ status: 'indexed', text: 'Quarterly revenue\nTom & Jerry\nConfidential draft', truncated: false })
  })

  it('extracts spreadsheet shared and inline strings, and slides in numeric order', () => {
    expect(extract('budget.xlsx', xlsxFixture(['Marketing'], ['Travel'])).text).toBe('Marketing\nTravel')
    const slides = Array.from({ length: 11 }, (_, index) => `Slide ${index + 1}`)
    expect(extract('deck.pptx', pptxFixture(slides)).text.split('\n')).toEqual(slides)
  })

  it('reads stored (uncompressed) entries', () => {
    const docx = zipFixture([{ name: 'word/document.xml', data: '<w:p><w:t>stored text</w:t></w:p>', store: true }])
    expect(extract('a.docx', docx).text).toBe('stored text')
  })

  it('reports password-protected documents as encrypted', () => {
    const compound = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(512)])
    expect(extract('secret.docx', compound)).toMatchObject({ status: 'encrypted', detail: 'The document is password-protected' })
    const flagged = zipFixture([{ name: 'word/document.xml', data: '<w:t>x</w:t>', encrypted: true }])
    expect(extract('secret.docx', flagged)).toMatchObject({ status: 'encrypted' })
  })

  it('stops decompression bombs and oversized archives', () => {
    const bomb = zipFixture([{ name: 'word/document.xml', data: Buffer.alloc(4 * 1024 * 1024, 0x20) }])
    expect(bomb.length).toBeLessThan(64 * 1024)
    expect(extract('bomb.docx', bomb, { maxExpandedBytes: 1024 * 1024 })).toMatchObject({ status: 'too-large' })
    const many = zipFixture(Array.from({ length: 12 }, (_, index) => ({ name: `word/header${index}.xml`, data: '<w:t>x</w:t>' })))
    expect(extract('many.docx', many, { maxZipEntries: 10 })).toMatchObject({ status: 'too-large' })
  })

  it('keeps earlier parts when a later part exceeds the expansion budget', () => {
    const docx = docxFixture(['Main body'], [{ name: 'word/footer1.xml', data: `<w:t>${'y'.repeat(4096)}</w:t>` }])
    expect(extract('a.docx', docx, { maxExpandedBytes: 300 })).toMatchObject({ status: 'indexed', text: 'Main body', truncated: true })
  })

  it('reports damaged files as failed', () => {
    expect(extract('broken.docx', Buffer.from('PK\u0003\u0004 not really a zip'))).toMatchObject({ status: 'failed' })
    expect(extract('plain.docx', 'hello')).toMatchObject({ status: 'failed' })
    expect(extract('empty.docx', zipFixture([{ name: 'other.xml', data: '<x/>' }]))).toMatchObject({ status: 'failed' })
  })
})

describe('PDF attachments', () => {
  it('extracts text from uncompressed and Flate-compressed pages', () => {
    const content = 'BT /F1 12 Tf 72 720 Td (Quarterly \\(draft\\) report) Tj 0 -14 Td [(In)-20(voice) -400 (total)] TJ T* (caf\\351) Tj ET'
    expect(extract('a.pdf', simplePdf(content))).toEqual({ status: 'indexed', text: 'Quarterly (draft) report\nInvoice total\ncafé', truncated: false })
    expect(extract('a.pdf', simplePdf(content, true)).text).toBe('Quarterly (draft) report\nInvoice total\ncafé')
  })

  it('maps composite font glyphs through ToUnicode CMaps', () => {
    const cmap = '/CIDInit /ProcSet findresource begin begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange 3 beginbfchar <0001> <0048> <0002> <0069> <0003> <0020> endbfchar 1 beginbfrange <0010> <0012> <0041> endbfrange endcmap'
    const pdf = pdfFixture([
      { body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
      { body: '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F2 5 0 R >> >> /Contents 4 0 R >>' },
      { body: '<< >>', stream: 'BT /F2 11 Tf <000100020003> Tj <001000110012> Tj ET', compress: true },
      { body: '<< /Type /Font /Subtype /Type0 /BaseFont /Calibri /ToUnicode 6 0 R >>' },
      { body: '<< >>', stream: cmap, compress: true }
    ])
    expect(extract('a.pdf', pdf).text).toBe('Hi ABC')
  })

  it('drops undecodable composite glyphs instead of indexing garbage', () => {
    const pdf = pdfFixture([
      { body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
      { body: '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>' },
      { body: '<< >>', stream: 'BT /F1 11 Tf <00230045> Tj ET' },
      { body: '<< /Type /Font /Subtype /Type0 /BaseFont /Noto >>' }
    ])
    expect(extract('a.pdf', pdf)).toMatchObject({ status: 'empty' })
  })

  it('follows inherited resources, content arrays, form XObjects, and object streams', () => {
    const objects = '6 0 7 52 '
    const objectStream = `${objects}<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> << /Type /Font /Subtype /Type1 /BaseFont /Times >>`
    const pdf = pdfFixture([
      { body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { body: '<< /Type /Pages /Kids [3 0 R] /Count 1 /Resources << /Font << /F1 6 0 R >> /XObject << /Fm1 8 0 R >> >> >>' },
      { body: '<< /Type /Page /Parent 2 0 R /Contents [4 0 R 5 0 R] >>' },
      { body: '<< >>', stream: 'BT /F1 12 Tf (First stream)' },
      { body: '<< >>', stream: 'Tj ET /Fm1 Do' },
      { body: '<< >>', stream: '' },
      { body: '<< >>', stream: '' },
      { body: '<< /Type /XObject /Subtype /Form /Resources << /Font << /F9 7 0 R >> >> >>', stream: 'BT /F9 9 Tf (Form footer) Tj ET' },
      { body: `<< /Type /ObjStm /N 2 /First ${objects.length} >>`, stream: objectStream, compress: true }
    ])
    // Objects 6 and 7 are placeholders replaced by the object stream when the file has no direct copy.
    const text = extract('a.pdf', Buffer.from(pdf.toString('latin1').replace(/6 0 obj[\s\S]*?endobj\n7 0 obj[\s\S]*?endobj\n/, ''), 'latin1'))
    expect(text).toMatchObject({ status: 'indexed', text: 'First stream\nForm footer' })
  })

  it('falls back to scanning content streams without a page tree', () => {
    const pdf = pdfFixture([{ body: '<< >>', stream: 'BT (Loose text) Tj ET', compress: true }], '')
    expect(extract('a.pdf', pdf).text).toBe('Loose text')
  })

  it('skips inline image data', () => {
    const content = 'BT /F1 12 Tf (Before) Tj ET BI /W 2 /H 2 /BPC 8 /CS /G ID \u0000(Tj)ÿ EI BT (After) Tj ET'
    expect(extract('a.pdf', simplePdf(content)).text).toBe('Before\nAfter')
  })

  it('reports encrypted PDFs and image-only PDFs', () => {
    const encrypted = pdfFixture([{ body: '<< /Type /Catalog /Pages 2 0 R >>' }, { body: '<< /Filter /Standard /V 2 >>' }], '/Root 1 0 R /Encrypt 2 0 R')
    expect(extract('a.pdf', encrypted)).toMatchObject({ status: 'encrypted', detail: 'The PDF is encrypted or password-protected' })
    expect(extract('scan.pdf', simplePdf('q 612 0 0 792 0 0 cm /Im1 Do Q'))).toMatchObject({ status: 'empty', detail: expect.stringContaining('scanned') })
    expect(extract('fake.pdf', 'hello')).toMatchObject({ status: 'failed' })
  })

  it('bounds text and stream expansion', () => {
    const long = `BT /F1 12 Tf ${Array.from({ length: 200 }, (_, index) => `(word${index}) Tj`).join(' ')} ET`
    const limited = extract('a.pdf', simplePdf(long), { maxTextChars: 30 })
    expect(limited).toMatchObject({ status: 'indexed', truncated: true })
    expect(limited.text.length).toBeLessThanOrEqual(30)
    const bomb = simplePdf(`BT /F1 12 Tf (Start) Tj ET ${' '.repeat(3 * 1024 * 1024)}`, true)
    expect(bomb.length).toBeLessThan(64 * 1024)
    expect(extract('bomb.pdf', bomb, { maxExpandedBytes: 1024 * 1024 })).toMatchObject({ status: 'too-large' })
  })

  it('parses bfchar and bfrange CMap forms with array targets', () => {
    const { map, codeLength } = parseCMap('begincodespacerange <00> <FF> endcodespacerange beginbfrange <20> <21> [<0058> <00590059>] endbfrange beginbfchar <41> <D83DDE00> endbfchar')
    expect(codeLength).toBe(1)
    expect(map.get(0x20)).toBe('X')
    expect(map.get(0x21)).toBe('YY')
    expect(map.get(0x41)).toBe('😀')
  })
})
