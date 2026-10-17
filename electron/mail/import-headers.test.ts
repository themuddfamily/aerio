import { describe, expect, it } from 'vitest'
import { importFlags, importMetadata, importThreadId, readHeaderBlock, sha256 } from './import-headers'

describe('import headers', () => {
  it('reads folded headers up to the first blank line only', () => {
    const headers = readHeaderBlock(Buffer.from('Subject: Long\r\n  folded subject\r\nX-Test: one\r\nX-Test: two\r\n\r\nStatus: RO\r\n'))
    expect(headers.get('subject')).toEqual(['Long folded subject'])
    expect(headers.get('x-test')).toEqual(['one', 'two'])
    expect(headers.has('status')).toBe(false)
  })

  it('maps Status, X-Status and X-Mozilla-Status flags', () => {
    const flags = (text: string) => importFlags(readHeaderBlock(Buffer.from(`${text}\n\nbody`)))
    expect(flags('Subject: none')).toEqual({})
    expect(flags('Status: RO')).toEqual({ read: true })
    expect(flags('Status: O')).toEqual({ read: false })
    expect(flags('Status: RO\nX-Status: AFD')).toEqual({ read: true, flagged: true, answered: true, deleted: true })
    expect(flags('X-Mozilla-Status: 0007')).toEqual({ read: true, answered: true, flagged: true, deleted: false })
    expect(flags('X-Mozilla-Status: 0008')).toEqual({ read: false, answered: false, flagged: false, deleted: true })
    // Status wins for read state when both are present; malformed values are ignored.
    expect(flags('X-Mozilla-Status: 0001\nStatus: O')).toMatchObject({ read: false })
    expect(flags('X-Mozilla-Status: zz')).toEqual({})
  })

  it('extracts thread roots, dates and decoded display fields', () => {
    const metadata = importMetadata(Buffer.from([
      'From: =?utf-8?B?w4lsb2RpZQ==?= <elodie@example.test>',
      'Subject: =?utf-8?Q?Caf=C3=A9_plans?=',
      'Date: Tue, 14 Oct 2025 18:45:00 +0200',
      'Message-ID: <Reply@Example.test>',
      'In-Reply-To: <parent@example.test>',
      'References: <root@example.test> <parent@example.test>',
      '',
      'Body'
    ].join('\r\n')))
    expect(metadata).toMatchObject({
      messageId: '<reply@example.test>',
      threadRoot: '<root@example.test>',
      date: '2025-10-14T16:45:00.000Z',
      subject: 'Café plans',
      from: 'Élodie <elodie@example.test>'
    })
    expect(importMetadata(Buffer.from('Message-ID: <solo@example.test>\n\nx')).threadRoot).toBe('<solo@example.test>')
    expect(importMetadata(Buffer.from('In-Reply-To: <p@example.test>\n\nx')).threadRoot).toBe('<p@example.test>')
    expect(importMetadata(Buffer.from('Date: not a date\n\nx'))).toMatchObject({ date: undefined, subject: '', from: '', messageId: undefined })
  })

  it('hashes content and derives stable thread ids', () => {
    expect(sha256(Buffer.from('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(importThreadId('<root@example.test>')).toBe(importThreadId('<root@example.test>'))
    expect(importThreadId('<root@example.test>')).toHaveLength(32)
  })
})
