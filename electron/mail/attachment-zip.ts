// Minimal, bounded zip reader for Office Open XML attachments. It reads the
// central directory, refuses encrypted or ZIP64 archives, and inflates single
// entries with an output cap so a decompression bomb fails fast instead of
// exhausting memory.
import { inflateRawSync } from 'node:zlib'
import { AttachmentTextError } from './attachment-text-types'

export interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
  encrypted: boolean
}

const END_OF_CENTRAL_DIRECTORY = 0x06054b50
const CENTRAL_DIRECTORY_HEADER = 0x02014b50
const LOCAL_FILE_HEADER = 0x04034b50
// The end record is 22 bytes plus a comment of at most 65,535 bytes.
const MAX_END_RECORD_SEARCH = 22 + 0xffff

const corrupt = () => new AttachmentTextError('failed', 'The archive is damaged')

export function isZip(buffer: Buffer) {
  return buffer.length >= 4 && buffer.readUInt32LE(0) === LOCAL_FILE_HEADER
}

export function readZipEntries(buffer: Buffer, maxEntries: number): ZipEntry[] {
  let end = -1
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - MAX_END_RECORD_SEARCH); index -= 1) {
    if (buffer.readUInt32LE(index) === END_OF_CENTRAL_DIRECTORY) { end = index; break }
  }
  if (end < 0) throw corrupt()
  const count = buffer.readUInt16LE(end + 10)
  const size = buffer.readUInt32LE(end + 12)
  const offset = buffer.readUInt32LE(end + 16)
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) throw new AttachmentTextError('unsupported', 'ZIP64 archives are not supported')
  if (count > maxEntries) throw new AttachmentTextError('too-large', `The archive has more than ${maxEntries.toLocaleString()} entries`)
  if (offset + size > end) throw corrupt()
  const entries: ZipEntry[] = []
  let position = offset
  for (let index = 0; index < count; index += 1) {
    if (position + 46 > end || buffer.readUInt32LE(position) !== CENTRAL_DIRECTORY_HEADER) throw corrupt()
    const flags = buffer.readUInt16LE(position + 8)
    const nameLength = buffer.readUInt16LE(position + 28)
    const extraLength = buffer.readUInt16LE(position + 30)
    const commentLength = buffer.readUInt16LE(position + 32)
    const nameEnd = position + 46 + nameLength
    if (nameEnd > end) throw corrupt()
    entries.push({
      // Bit 11 marks UTF-8 names; Office always writes ASCII part names.
      name: buffer.toString(flags & 0x800 ? 'utf8' : 'latin1', position + 46, nameEnd),
      method: buffer.readUInt16LE(position + 10),
      compressedSize: buffer.readUInt32LE(position + 20),
      uncompressedSize: buffer.readUInt32LE(position + 24),
      localHeaderOffset: buffer.readUInt32LE(position + 42),
      encrypted: Boolean(flags & 0x1)
    })
    position = nameEnd + extraLength + commentLength
  }
  return entries
}

/** Returns the entry's bytes, refusing anything that would inflate past `maxBytes`. */
export function readZipEntry(buffer: Buffer, entry: ZipEntry, maxBytes: number) {
  if (entry.encrypted) throw new AttachmentTextError('encrypted', 'The archive is password-protected')
  const header = entry.localHeaderOffset
  if (header + 30 > buffer.length || buffer.readUInt32LE(header) !== LOCAL_FILE_HEADER) throw corrupt()
  const start = header + 30 + buffer.readUInt16LE(header + 26) + buffer.readUInt16LE(header + 28)
  if (start + entry.compressedSize > buffer.length) throw corrupt()
  if (entry.uncompressedSize > maxBytes) throw new AttachmentTextError('too-large', 'The document expands beyond the indexing limit')
  const data = buffer.subarray(start, start + entry.compressedSize)
  if (entry.method === 0) return data
  if (entry.method !== 8) throw new AttachmentTextError('unsupported', 'The archive uses an unsupported compression method')
  try {
    // The declared size can lie, so the inflater enforces the cap itself.
    return inflateRawSync(data, { maxOutputLength: Math.max(1, maxBytes) })
  } catch (error) {
    if (error instanceof RangeError || (error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new AttachmentTextError('too-large', 'The document expands beyond the indexing limit')
    }
    throw corrupt()
  }
}
