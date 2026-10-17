// Builders for small, real attachment files used by the extraction tests.
import { deflateRawSync, deflateSync } from 'node:zlib'

export interface ZipFixtureEntry {
  name: string
  data: string | Buffer
  store?: boolean
  encrypted?: boolean
}

export function zipFixture(entries: ZipFixtureEntry[]) {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8')
    const data = entry.store ? raw : deflateRawSync(raw)
    const flags = 0x800 | (entry.encrypted ? 1 : 0)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(entry.store ? 0 : 8, 8)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(entry.store ? 0 : 8, 10)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, data)
    centrals.push(central, name)
    offset += local.length + name.length + data.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

const escapeXml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

export function docxFixture(paragraphs: string[], extra: ZipFixtureEntry[] = []) {
  const body = paragraphs.map((text) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`).join('')
  return zipFixture([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'word/document.xml', data: `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${body}</w:body></w:document>` },
    ...extra
  ])
}

export function xlsxFixture(strings: string[], inline: string[] = []) {
  return zipFixture([
    { name: 'xl/sharedStrings.xml', data: `<sst>${strings.map((text) => `<si><t>${escapeXml(text)}</t></si>`).join('')}</sst>` },
    { name: 'xl/worksheets/sheet1.xml', data: `<worksheet><sheetData><row><c t="s"><v>0</v></c>${inline.map((text) => `<c t="inlineStr"><is><t>${escapeXml(text)}</t></is></c>`).join('')}</row></sheetData></worksheet>` }
  ])
}

export function pptxFixture(slides: string[]) {
  return zipFixture(slides.map((text, index) => ({
    name: `ppt/slides/slide${slides.length - index}.xml`,
    data: `<p:sld><p:txBody><a:p><a:r><a:t>${escapeXml(slides[slides.length - index - 1])}</a:t></a:r></a:p></p:txBody></p:sld>`
  })))
}

export interface PdfFixtureObject {
  body: string
  stream?: Buffer | string
  /** Flate-compress the stream and add /Filter /FlateDecode. */
  compress?: boolean
}

/** Assembles numbered objects (1-based) into a PDF with an xref table and trailer. */
export function pdfFixture(objects: PdfFixtureObject[], trailer = '/Root 1 0 R') {
  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')]
  const offsets: number[] = []
  let length = parts[0].length
  objects.forEach((object, index) => {
    offsets.push(length)
    let chunk: Buffer
    if (object.stream !== undefined) {
      const raw = Buffer.isBuffer(object.stream) ? object.stream : Buffer.from(object.stream, 'latin1')
      const data = object.compress ? deflateSync(raw) : raw
      const dict = object.body.replace(/>>\s*$/, `${object.compress ? ' /Filter /FlateDecode' : ''} /Length ${data.length} >>`)
      chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n${dict}\nstream\n`, 'latin1'), data, Buffer.from('\nendstream\nendobj\n', 'latin1')])
    } else {
      chunk = Buffer.from(`${index + 1} 0 obj\n${object.body}\nendobj\n`, 'latin1')
    }
    parts.push(chunk)
    length += chunk.length
  })
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)].join('')
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} ${trailer} >>\nstartxref\n${length}\n%%EOF\n`, 'latin1'))
  return Buffer.concat(parts)
}

/** A one-page PDF whose page shows `content` with a standard Helvetica font named /F1. */
export function simplePdf(content: string, compress = false) {
  return pdfFixture([
    { body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    { body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>' },
    { body: '<< >>', stream: content, compress },
    { body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' }
  ])
}
