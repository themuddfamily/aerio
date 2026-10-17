import { createReadStream } from 'node:fs'

export type MboxVariant = 'mboxrd' | 'mboxo'

export interface MboxMessage {
  /** Byte offset of the message's From_ separator line in the file. */
  offset: number
  /** Byte offset where the message content (after the From_ line) starts. */
  contentOffset: number
  /** Byte offset of the next message's From_ line, or the file size at the end. */
  nextOffset: number
  /** The From_ line without its terminator, e.g. `From - Sat Jan 03 01:05:34 1996`. */
  separator: string
  /** Unquoted RFC 5322 message. Empty when the message was over the size limit. */
  raw: Buffer
  /** Size of the message content as stored in the file, before unquoting. */
  storedBytes: number
  oversized: boolean
}

export interface MboxReadOptions {
  /** Resume at this byte offset; it must point at a From_ separator line. */
  start?: number
  variant?: MboxVariant
  maxMessageBytes: number
  /** Read chunk size; small values are used by tests to exercise chunk boundaries. */
  chunkBytes?: number
  signal?: AbortSignal
}

const FROM = Buffer.from('From ')

// A From_ separator starts a line, follows a blank line (or the start of the
// file), and carries an envelope sender plus a date. Requiring a digit keeps
// unquoted body lines such as "From the desk of…" inside their message.
export function isMboxSeparator(line: Buffer) {
  if (line.length < 7 || !line.subarray(0, 5).equals(FROM)) return false
  const text = line.toString('latin1').replace(/\r?\n?$/, '')
  return /^From \S+\s+\S.*\d/.test(text)
}

// mboxrd quotes every ">*From " body line with one more ">"; mboxo only
// quotes "From " itself, so only a single ">" is removed there.
export function unquoteMboxLine(line: Buffer, variant: MboxVariant) {
  let depth = 0
  while (depth < line.length && line[depth] === 0x3e) depth += 1
  if (depth === 0 || line.length < depth + 5 || !line.subarray(depth, depth + 5).equals(FROM)) return line
  if (variant === 'mboxo' && depth !== 1) return line
  return line.subarray(1)
}

// Reverses unquoteMboxLine so exported or re-written mbox data round-trips.
export function quoteMboxBody(raw: Buffer, variant: MboxVariant = 'mboxrd') {
  const lines: Buffer[] = []
  let start = 0
  while (start < raw.length) {
    const end = raw.indexOf(0x0a, start)
    const line = raw.subarray(start, end === -1 ? raw.length : end + 1)
    let depth = 0
    while (depth < line.length && line[depth] === 0x3e) depth += 1
    const quoted = line.length >= depth + 5 && line.subarray(depth, depth + 5).equals(FROM) && (variant === 'mboxrd' || depth === 0)
    lines.push(quoted ? Buffer.concat([Buffer.from('>'), line]) : line)
    start = end === -1 ? raw.length : end + 1
  }
  return Buffer.concat(lines)
}

const isBlank = (line: Buffer) => line.length === 0 || (line.length === 1 && line[0] === 0x0a) || (line.length === 2 && line[0] === 0x0d && line[1] === 0x0a)

// Removes the blank line that separates a message from the next From_ line;
// it belongs to the mbox framing, not to the message.
function trimSeparatorBlank(lines: Buffer[]) {
  const last = lines.at(-1)
  if (last && isBlank(last)) lines.pop()
}

/**
 * Streams an mbox file one message at a time. Only the current message is
 * buffered (and never more than maxMessageBytes of it), so arbitrarily large
 * archives are read in bounded memory. Messages are yielded together with the
 * byte offset of the next separator so an import can resume exactly there.
 */
export async function* readMbox(path: string, options: MboxReadOptions): AsyncGenerator<MboxMessage> {
  const variant = options.variant ?? 'mboxrd'
  const start = options.start ?? 0
  const stream = createReadStream(path, { start, highWaterMark: options.chunkBytes ?? 256 * 1024 })
  let position = start
  let carry: Buffer = Buffer.alloc(0)
  let previousBlank = true
  let current: { offset: number; contentOffset: number; separator: string; lines: Buffer[]; bytes: number; storedBytes: number; oversized: boolean } | undefined

  const finish = (nextOffset: number): MboxMessage | undefined => {
    if (!current) return undefined
    const message = current
    current = undefined
    trimSeparatorBlank(message.lines)
    return {
      offset: message.offset,
      contentOffset: message.contentOffset,
      nextOffset,
      separator: message.separator,
      raw: message.oversized ? Buffer.alloc(0) : Buffer.concat(message.lines),
      storedBytes: message.storedBytes,
      oversized: message.oversized
    }
  }

  const handleLine = (line: Buffer, lineOffset: number): MboxMessage | undefined => {
    let completed: MboxMessage | undefined
    if (previousBlank && isMboxSeparator(line)) {
      completed = finish(lineOffset)
      current = {
        offset: lineOffset,
        contentOffset: lineOffset + line.length,
        separator: line.toString('latin1').replace(/\r?\n$/, ''),
        lines: [],
        bytes: 0,
        storedBytes: 0,
        oversized: false
      }
      previousBlank = false
      return completed
    }
    previousBlank = isBlank(line)
    if (!current) {
      if (!isBlank(line)) throw new MboxFormatError()
      return undefined
    }
    current.storedBytes += line.length
    if (current.oversized) return undefined
    const unquoted = unquoteMboxLine(line, variant)
    current.bytes += unquoted.length
    if (current.bytes > options.maxMessageBytes) {
      current.oversized = true
      current.lines = []
      return undefined
    }
    // Lines are sub-views of the read chunk; copy so the chunk can be released.
    current.lines.push(Buffer.from(unquoted))
    return undefined
  }

  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      if (options.signal?.aborted) return
      const data = carry.length ? Buffer.concat([carry, chunk]) : chunk
      const dataOffset = position - carry.length
      let lineStart = 0
      while (true) {
        const newline = data.indexOf(0x0a, lineStart)
        if (newline === -1) break
        const message = handleLine(data.subarray(lineStart, newline + 1), dataOffset + lineStart)
        lineStart = newline + 1
        if (message) {
          yield message
          if (options.signal?.aborted) return
        }
      }
      carry = Buffer.from(data.subarray(lineStart))
      position += chunk.length
      // A single line longer than the limit still has to stay bounded.
      if (carry.length > options.maxMessageBytes && current) {
        current.storedBytes += carry.length
        current.oversized = true
        current.lines = []
        previousBlank = false
        carry = Buffer.alloc(0)
      }
    }
    if (carry.length) {
      const message = handleLine(carry, position - carry.length)
      if (message) yield message
    }
    const last = finish(position)
    if (last) yield last
  } finally {
    stream.destroy()
  }
}

export class MboxFormatError extends Error {
  constructor() {
    super('This file is not an mbox mailbox: it does not start with a “From ” separator line')
    this.name = 'MboxFormatError'
  }
}

// Reads one stored message back from its byte range (used when a held
// duplicate is imported later) and applies the same unquoting.
export async function readMboxRange(path: string, contentOffset: number, storedBytes: number, variant: MboxVariant) {
  if (storedBytes <= 0) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  for await (const chunk of createReadStream(path, { start: contentOffset, end: contentOffset + storedBytes - 1 }) as AsyncIterable<Buffer>) chunks.push(chunk)
  const data = Buffer.concat(chunks)
  const lines: Buffer[] = []
  let start = 0
  while (start < data.length) {
    const end = data.indexOf(0x0a, start)
    const line = data.subarray(start, end === -1 ? data.length : end + 1)
    lines.push(unquoteMboxLine(line, variant))
    start = end === -1 ? data.length : end + 1
  }
  trimSeparatorBlank(lines)
  return Buffer.concat(lines)
}

/** Parses the date part of a From_ line (asctime format), if present. */
export function mboxSeparatorDate(separator: string) {
  const match = separator.match(/^From \S+\s+(.+)$/)
  if (!match) return undefined
  const value = Date.parse(match[1].trim())
  return Number.isFinite(value) ? new Date(value).toISOString() : undefined
}
