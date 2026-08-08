import { describe, expect, it } from 'vitest'
import { parseMessageSource } from './message-source'

describe('message source', () => {
  it('returns the complete source and isolates folded headers', () => {
    const raw = Buffer.from('From: sender@example.com\r\nSubject: A long\r\n subject\r\n\r\nHello')
    expect(parseMessageSource(raw)).toEqual({
      headers: 'From: sender@example.com\r\nSubject: A long\r\n subject',
      source: raw.toString('utf8')
    })
  })

  it('treats a source without a body separator as headers', () => {
    expect(parseMessageSource(Buffer.from('Subject: Header only')).headers).toBe('Subject: Header only')
  })

  it('recognizes LF-only header and body separators', () => {
    const result = parseMessageSource(Buffer.from('From: sender@example.com\nSubject: Hello\n\nBody\nMore'))
    expect(result.headers).toBe('From: sender@example.com\nSubject: Hello')
    expect(result.source).toContain('\n\nBody\nMore')
  })

  it('splits only at the first blank line', () => {
    const result = parseMessageSource(Buffer.from('Subject: First\r\n\r\nBody paragraph\r\n\r\nSecond paragraph'))
    expect(result.headers).toBe('Subject: First')
    expect(result.source).toBe('Subject: First\r\n\r\nBody paragraph\r\n\r\nSecond paragraph')
  })
})
