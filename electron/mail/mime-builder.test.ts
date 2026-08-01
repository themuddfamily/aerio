import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import PostalMime from 'postal-mime'
import { afterEach, describe, expect, it } from 'vitest'
import { createMimeBuffer } from './mime-builder'

const directories: string[] = []
const input = (attachmentPaths: string[] = []) => ({
  id: 'draft-1', accountId: 'account-1', to: ['reader@example.com'], cc: [], bcc: ['hidden@example.com'], subject: 'Hello\r\nInjected: no',
  text: 'Plain body', html: '<p><strong>Rich body</strong><script>alert(1)</script></p>', attachmentPaths
})

afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })))

describe('outgoing MIME builder', () => {
  it('creates text and sanitized HTML alternatives without header injection', async () => {
    const raw = createMimeBuffer(input(), 'Aerio Person <sender@example.com>')
    const parsed = await PostalMime.parse(raw)
    expect(parsed.subject).toBe('Hello Injected: no')
    expect(parsed.text).toContain('Plain body')
    expect(parsed.html).toContain('<strong>Rich body</strong>')
    expect(parsed.html).not.toContain('<script>')
  })

  it('hides Bcc for SMTP and restores original staged attachment names', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aerio-mime-test-'))
    directories.push(directory)
    const path = join(directory, '0-1234567890-résumé-📎.txt')
    writeFileSync(path, 'attachment body')
    const raw = createMimeBuffer(input([path]), 'sender@example.com', true)
    expect(raw.toString()).not.toMatch(/^Bcc:/m)
    const parsed = await PostalMime.parse(raw)
    expect(parsed.attachments[0].filename).toBe('résumé-📎.txt')
    const content = parsed.attachments[0].content
    const bytes = content instanceof ArrayBuffer ? new Uint8Array(content) : content
    expect(Buffer.from(bytes).toString()).toBe('attachment body')
  })
})
