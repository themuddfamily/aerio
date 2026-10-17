import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import PostalMime from 'postal-mime'
import { afterEach, describe, expect, it } from 'vitest'
import { createMime, createMimeBuffer } from './mime-builder'

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
    expect(parsed.messageId).toMatch(/^<[0-9a-f-]+@aerio\.local>$/)
    expect(Number.isFinite(Date.parse(parsed.date!))).toBe(true)
    expect((await PostalMime.parse(createMimeBuffer(input()))).messageId).not.toBe(parsed.messageId)
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

  it('provides the base64url representation used by provider APIs', () => {
    const encoded = createMime({ ...input(), html: undefined }, 'sender@example.com')
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(Buffer.from(encoded, 'base64url').toString()).toContain('Plain body')
  })

  it('emits optional recipient and reply headers only when supplied', () => {
    const raw = createMimeBuffer({
      ...input(), cc: ['copy@example.com'], inReplyTo: '<parent@example.com>', references: ['<one@example.com>', '<two@example.com>']
    }).toString()
    expect(raw).not.toMatch(/^From:/m)
    expect(raw).toContain('Cc: copy@example.com')
    expect(raw).toContain('Bcc: hidden@example.com')
    expect(raw).toContain('In-Reply-To: <parent@example.com>')
    expect(raw).toContain('References: <one@example.com> <two@example.com>')
    expect(raw).not.toMatch(/^Reply-To:/m)
    expect(createMimeBuffer({ ...input(), replyTo: ['Desk <desk@example.com>', 'b@example.com\r\nBcc: x@example.com'] }).toString())
      .toContain('Reply-To: Desk <desk@example.com>, b@example.com Bcc: x@example.com\r\n')
  })

  it('writes outgoing importance and receipt request headers addressed to the sender', async () => {
    const raw = createMimeBuffer({ ...input(), sendOptions: { importance: 'high', requestReadReceipt: true, requestDeliveryReceipt: true } }, 'Aerio Person <sender@example.com>').toString()
    const headers = raw.slice(0, raw.indexOf('\r\n\r\n'))
    expect(headers).toContain('Importance: High\r\nX-Priority: 1 (Highest)')
    expect(headers).toContain('Disposition-Notification-To: Aerio Person <sender@example.com>')
    expect(headers).toContain('Return-Receipt-To: Aerio Person <sender@example.com>')
    const low = createMimeBuffer({ ...input(), sendOptions: { importance: 'low' } }, 'sender@example.com').toString()
    expect(low).toContain('Importance: Low\r\nX-Priority: 5 (Lowest)')
    const plain = createMimeBuffer({ ...input(), sendOptions: { importance: 'normal', requestReadReceipt: false } }, 'sender@example.com').toString()
    expect(plain).not.toMatch(/Importance:|X-Priority:|Disposition-Notification-To:|Return-Receipt-To:/)
    // Without a known sender there is nowhere safe to return a receipt.
    expect(createMimeBuffer({ ...input(), sendOptions: { requestReadReceipt: true } }).toString()).not.toContain('Disposition-Notification-To')
  })
  it('sends inline images as multipart/related Content-ID parts beside a plain-text alternative and regular attachments', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aerio-mime-test-'))
    directories.push(directory)
    const path = join(directory, '0-1234567890-notes.txt')
    writeFileSync(path, 'attached')
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const raw = createMimeBuffer({
      ...input([path]), text: 'Plain body\n-- \nAda',
      html: `<p style="color: #c0392b">Rich</p><img src="data:image/png;base64,${png}" alt="Chart" data-aerio-cid="chart-1@aerio.local">` +
        '<table style="border-collapse: collapse"><tbody><tr><td style="border: 1px solid #ccc">Cell</td></tr></tbody></table><div data-aerio-signature="sig">-- <br><b>Ada</b></div>'
    }, 'sender@example.com', true)
    const source = raw.toString()
    expect(source).toMatch(/Content-Type: multipart\/alternative[\s\S]*Content-Type: text\/plain[\s\S]*Content-Type: multipart\/related; type="text\/html"[\s\S]*Content-Type: text\/html[\s\S]*Content-ID: <chart-1@aerio\.local>\r\nContent-Disposition: inline; filename="image-1.png"/)
    const parsed = await PostalMime.parse(raw)
    expect(parsed.text).toContain('Plain body')
    expect(parsed.html).toContain('<img src="cid:chart-1@aerio.local" alt="Chart" />')
    expect(parsed.html).toContain('<td style="border: 1px solid #ccc">Cell</td>')
    expect(parsed.html).toContain('<p style="color: #c0392b">Rich</p>')
    expect(parsed.html).toContain('<div data-aerio-signature="sig">-- <br /><b>Ada</b></div>')
    const inline = parsed.attachments.find((item) => item.contentId === '<chart-1@aerio.local>')
    expect(inline).toMatchObject({ mimeType: 'image/png', disposition: 'inline', related: true })
    const bytes = inline!.content instanceof ArrayBuffer ? new Uint8Array(inline!.content) : inline!.content
    expect(Buffer.from(bytes).toString('base64')).toBe(png)
    expect(parsed.attachments.find((item) => item.filename === 'notes.txt')?.disposition).toBe('attachment')
  })
})
