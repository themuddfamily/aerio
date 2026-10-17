import { closeSync, openSync, readSync } from 'node:fs'

// Cheap Outlook data file checks that read only the 514-byte header, so the
// main process can explain an unreadable file as soon as it is chosen
// without loading the PST reader.

const PST_TYPE_ANSI = [14, 15]
const PST_TYPE_UNICODE = [23, 36]

export const PST_HIGH_ENCRYPTION_REASON = 'This Outlook data file uses high encryption, which Aerio can’t read. In Outlook, export the folders to a new .pst file, then import that file.'
export const PST_INVALID_REASON = 'This file isn’t an Outlook data file Aerio can read. It may be damaged or from an unsupported Outlook version.'

function readHeader(path: string, length: number) {
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, 'r')
    const header = Buffer.alloc(length)
    return header.subarray(0, readSync(descriptor, header, 0, length, 0))
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

/** Returns why an Outlook data file can't be imported, or undefined when it can be read. */
export function pstHeaderProblem(path: string): string | undefined {
  let header: Buffer
  try {
    header = readHeader(path, 514)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') throw error
    return PST_INVALID_REASON
  }
  if (header.length < 514 || header.toString('latin1', 0, 4) !== '!BDN') return PST_INVALID_REASON
  const version = header[10]
  // bCryptMethod: 0 none, 1 compressible (permutation), 2 high (cyclic).
  if (PST_TYPE_ANSI.includes(version)) return header[461] === 2 ? PST_HIGH_ENCRYPTION_REASON : undefined
  if (PST_TYPE_UNICODE.includes(version)) return header[513] === 2 ? PST_HIGH_ENCRYPTION_REASON : undefined
  return PST_INVALID_REASON
}

/** Starts with the PST magic, whatever the file is called. */
export function looksLikePst(path: string) {
  try {
    return readHeader(path, 4).toString('latin1') === '!BDN'
  } catch {
    return false
  }
}
