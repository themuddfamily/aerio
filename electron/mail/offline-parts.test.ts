import { describe, expect, it } from 'vitest'
import { decodeImapBody, decodeQuotedPrintable, decodeText, gmailHeaderBlock, gmailPartialContent, graphHeaderBlock, graphPartialContent, imapStructureParts } from './offline-parts'

const b64url = (value: string, encoding: BufferEncoding = 'utf8') => Buffer.from(value, encoding).toString('base64url')

describe('partial message content (E36)', () => {
  it('reads Gmail format=full bodies and attachment references without downloading attachments', () => {
    const payload = {
      mimeType: 'multipart/mixed',
      headers: [{ name: 'From', value: 'Ada <ada@example.com>' }, { name: 'Subject', value: 'Plans' }],
      parts: [
        { mimeType: 'multipart/alternative', parts: [
          { mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset="iso-8859-1"' }], body: { size: 4, data: b64url('caf\xe9', 'latin1') } },
          { mimeType: 'text/html', body: { size: 11, data: b64url('<p>café</p>') } }
        ] },
        { mimeType: 'application/pdf', filename: 'plan.pdf', headers: [{ name: 'Content-ID', value: '<pdf-1>' }], body: { size: 52_000, attachmentId: 'ANGjdJ' } },
        { mimeType: 'image/png', body: { size: 10, attachmentId: 'img' } }
      ]
    }
    expect(gmailPartialContent(payload)).toEqual({
      headers: 'From: Ada <ada@example.com>\r\nSubject: Plans\r\n\r\n',
      text: 'café',
      html: '<p>café</p>',
      attachments: [
        { filename: 'plan.pdf', mimeType: 'application/pdf', size: 52_000, contentId: 'pdf-1' },
        { filename: 'attachment-2', mimeType: 'image/png', size: 10 }
      ]
    })
    expect(gmailHeaderBlock(undefined)).toBe('\r\n\r\n')
  })

  it('builds a parseable header block from Graph fields', () => {
    const fields = {
      id: 'm1',
      subject: 'Zoë’s update',
      from: { emailAddress: { name: 'Zoë', address: 'zoe@example.com' } },
      toRecipients: [{ emailAddress: { address: 'me@example.com' } }],
      ccRecipients: [{ emailAddress: { name: 'Bob', address: 'bob@example.com' } }],
      receivedDateTime: '2026-10-01T09:00:00Z',
      internetMessageId: '<m1@example.com>',
      internetMessageHeaders: [{ name: 'References', value: '<root@example.com>' }],
      body: { contentType: 'html' as const, content: '<b>Hi</b>' }
    }
    const block = graphHeaderBlock(fields)
    expect(block).toContain(`From: "=?UTF-8?B?${Buffer.from('Zoë').toString('base64')}?=" <zoe@example.com>`)
    expect(block).toContain('To: me@example.com\r\nCc: "Bob" <bob@example.com>')
    expect(block).toContain('Message-ID: <m1@example.com>\r\nReferences: <root@example.com>')
    expect(graphPartialContent(fields, [{ id: 'a', name: 'report.xlsx', size: 900 }])).toMatchObject({ html: '<b>Hi</b>', text: '', attachments: [{ filename: 'report.xlsx', mimeType: 'application/octet-stream', size: 900 }] })
  })

  it('walks an IMAP BODYSTRUCTURE and decodes the fetched text parts', () => {
    const structure = {
      type: 'multipart/mixed',
      childNodes: [
        { type: 'multipart/alternative', childNodes: [
          { part: '1.1', type: 'text/plain', parameters: { charset: 'utf-8' }, encoding: 'quoted-printable', size: 20 },
          { part: '1.2', type: 'text/html', parameters: { charset: 'utf-8' }, encoding: 'base64', size: 40 }
        ] },
        { part: '2', type: 'application/zip', disposition: 'attachment', dispositionParameters: { filename: 'files.zip' }, size: 2048, id: '<z1>' },
        { part: '3', type: 'message/rfc822', size: 300 },
        { part: '4', type: 'text/calendar', size: 30 }
      ]
    }
    const parts = imapStructureParts(structure)
    expect(parts.bodies.map((item) => item.part)).toEqual(['1.1', '1.2'])
    expect(parts.attachments).toEqual([
      { filename: 'files.zip', mimeType: 'application/zip', size: 2048, contentId: 'z1' },
      { filename: 'attachment-2', mimeType: 'message/rfc822', size: 300 }
    ])
    expect(decodeImapBody(Buffer.from('Gr=C3=BC=C3=9Fe=\r\n aus Wien'), parts.bodies[0])).toBe('Grüße aus Wien')
    expect(decodeImapBody(Buffer.from(Buffer.from('<p>Hej</p>').toString('base64')), parts.bodies[1])).toBe('<p>Hej</p>')
    expect(imapStructureParts({ type: 'text/plain' }).bodies).toEqual([{ part: '1', type: 'text/plain', charset: undefined, encoding: undefined }])
    expect(decodeQuotedPrintable('a=3Db').toString()).toBe('a=b')
    expect(decodeText(Buffer.from('ok'), 'x-unknown-charset')).toBe('ok')
  })
})
