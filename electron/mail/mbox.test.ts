import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MboxFormatError, isMboxSeparator, mboxSeparatorDate, quoteMboxBody, readMbox, readMboxRange, unquoteMboxLine, type MboxReadOptions } from './mbox'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture(contents: string | Buffer) {
  const directory = mkdtempSync(join(tmpdir(), 'aerio-mbox-test-'))
  directories.push(directory)
  const path = join(directory, 'Inbox.mbox')
  writeFileSync(path, contents)
  return path
}

async function collect(path: string, options: Partial<MboxReadOptions> = {}) {
  const messages = []
  for await (const message of readMbox(path, { maxMessageBytes: 1024 * 1024, ...options })) messages.push(message)
  return messages
}

const message = (subject: string, body: string) => `From: Ada <ada@example.test>\nSubject: ${subject}\nMessage-ID: <${subject.replaceAll(' ', '-')}@example.test>\n\n${body}\n`

describe('mbox separators and quoting', () => {
  it('recognises From_ lines with an envelope sender and date only', () => {
    expect(isMboxSeparator(Buffer.from('From - Sat Jan 03 01:05:34 1996\n'))).toBe(true)
    expect(isMboxSeparator(Buffer.from('From ada@example.test Thu Oct 16 09:00:00 2026\r\n'))).toBe(true)
    expect(isMboxSeparator(Buffer.from('From the desk of the editor\n'))).toBe(false)
    expect(isMboxSeparator(Buffer.from('>From - Sat Jan 03 01:05:34 1996\n'))).toBe(false)
  })

  it('removes one level of quoting for mboxrd and only single quotes for mboxo', () => {
    expect(unquoteMboxLine(Buffer.from('>From here\n'), 'mboxrd').toString()).toBe('From here\n')
    expect(unquoteMboxLine(Buffer.from('>>From here\n'), 'mboxrd').toString()).toBe('>From here\n')
    expect(unquoteMboxLine(Buffer.from('>>From here\n'), 'mboxo').toString()).toBe('>>From here\n')
    expect(unquoteMboxLine(Buffer.from('>From here\n'), 'mboxo').toString()).toBe('From here\n')
    expect(unquoteMboxLine(Buffer.from('> quoted reply\n'), 'mboxrd').toString()).toBe('> quoted reply\n')
  })

  it('round-trips quoting', () => {
    const body = Buffer.from('From me\n>From you\nplain\n')
    expect(quoteMboxBody(body).toString()).toBe('>From me\n>>From you\nplain\n')
    const quoted = quoteMboxBody(body)
    const lines = quoted.toString().split(/(?<=\n)/).map((line) => unquoteMboxLine(Buffer.from(line), 'mboxrd').toString())
    expect(lines.join('')).toBe(body.toString())
  })

  it('reads the asctime date from a separator', () => {
    expect(mboxSeparatorDate('From - Sat Jan 03 01:05:34 1996')).toBe(new Date('Sat Jan 03 01:05:34 1996').toISOString())
    expect(mboxSeparatorDate('From MAILER-DAEMON')).toBeUndefined()
  })
})

describe('readMbox', () => {
  // Each message ends with its own line break; one blank line separates messages.
  const mbox = [
    `From ada@example.test Thu Oct 16 09:00:00 2026\n${message('First', 'Hello')}`,
    `From bob@example.test Fri Oct 17 10:00:00 2026\n${message('Second', 'Line one\n>From quoted body line\nFrom the desk of Bob (not a separator)')}`,
    `From - Sat Oct 18 11:00:00 2026\n${message('Third', 'Bye')}`
  ].join('\n') + '\n'

  it('splits messages, unquotes body lines and keeps unquoted non-separator lines', async () => {
    const messages = await collect(fixture(mbox))
    expect(messages).toHaveLength(3)
    expect(messages[0].raw.toString()).toBe(message('First', 'Hello'))
    expect(messages[1].raw.toString()).toContain('\nFrom quoted body line\n')
    expect(messages[1].raw.toString()).toContain('From the desk of Bob (not a separator)')
    expect(messages[2].separator).toBe('From - Sat Oct 18 11:00:00 2026')
    expect(messages[0].nextOffset).toBe(messages[1].offset)
    expect(messages[2].nextOffset).toBe(Buffer.byteLength(mbox))
  })

  it('gives identical results regardless of read chunk size', async () => {
    const path = fixture(mbox)
    const whole = await collect(path)
    for (const chunkBytes of [1, 3, 7, 64]) {
      const chunked = await collect(path, { chunkBytes })
      expect(chunked.map((item) => [item.offset, item.raw.toString()])).toEqual(whole.map((item) => [item.offset, item.raw.toString()]))
    }
  })

  it('handles CRLF files', async () => {
    const messages = await collect(fixture(mbox.replaceAll('\n', '\r\n')))
    expect(messages).toHaveLength(3)
    expect(messages[0].raw.toString()).toBe(message('First', 'Hello').replaceAll('\n', '\r\n'))
  })

  it('resumes at a saved offset', async () => {
    const path = fixture(mbox)
    const all = await collect(path)
    const resumed = await collect(path, { start: all[1].offset })
    expect(resumed.map((item) => item.raw.toString())).toEqual(all.slice(1).map((item) => item.raw.toString()))
  })

  it('reports oversized messages without buffering them', async () => {
    const big = `From a@example.test Thu Oct 16 09:00:00 2026\n${message('Big', 'x'.repeat(5_000))}\nFrom b@example.test Thu Oct 16 09:00:00 2026\n${message('Small', 'ok')}`
    const messages = await collect(fixture(big), { maxMessageBytes: 1_000, chunkBytes: 256 })
    expect(messages.map((item) => item.oversized)).toEqual([true, false])
    expect(messages[0].raw.length).toBe(0)
    expect(messages[0].storedBytes).toBeGreaterThan(5_000)
    expect(messages[1].raw.toString()).toContain('Subject: Small')
  })

  it('rejects files that are not mbox', async () => {
    await expect(collect(fixture('Subject: not an mbox\n\nbody\n'))).rejects.toBeInstanceOf(MboxFormatError)
  })

  it('re-reads one message from its byte range', async () => {
    const path = fixture(mbox)
    const [, second] = await collect(path)
    const raw = await readMboxRange(path, second.contentOffset, second.storedBytes, 'mboxrd')
    expect(raw.equals(second.raw)).toBe(true)
  })

  it('stops when aborted', async () => {
    const controller = new AbortController()
    const seen = []
    for await (const item of readMbox(fixture(mbox), { maxMessageBytes: 1024, signal: controller.signal })) {
      seen.push(item)
      controller.abort()
    }
    expect(seen).toHaveLength(1)
  })
})
