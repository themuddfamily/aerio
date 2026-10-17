import PostalMime from 'postal-mime'
import { describe, expect, it } from 'vitest'
import { importMetadata } from './import-headers'
import { literalLzfu, pstAttachment, pstMessage } from './mail-import.fixtures'
import { isMailMessageClass, PstMessageTooLargeError, pstMessageToMime, rfc5322Date } from './pst-mime'

const LIMIT = 1024 * 1024
const convert = (message = pstMessage()) => pstMessageToMime(message, { maxBytes: LIMIT, seed: '2097188' })
const parse = (raw: Buffer) => PostalMime.parse(raw)

describe('pstMessageToMime', () => {
  it('builds headers from MAPI properties and keeps trace headers from the original', async () => {
    const raw = convert(pstMessage({
      subject: 'Überweisung – März',
      representingName: 'Ada (Finance)',
      representingEmail: '/O=EXAMPLE/OU=EXCHANGE/CN=RECIPIENTS/CN=ADA',
      representingAddrType: 'EX',
      representingSmtp: 'finance@example.test',
      recipients: [
        { type: 1, name: 'Bob', email: 'bob@example.test', addrType: 'SMTP', smtp: '' },
        { type: 1, name: 'Legacy Exchange user', email: '/O=EXAMPLE/CN=LEGACY', addrType: 'EX', smtp: '' },
        { type: 2, name: '"Quoted", Carol', email: '', addrType: 'EX', smtp: 'carol@example.test' },
        { type: 3, name: 'Hidden', email: 'hidden@example.test', addrType: 'SMTP', smtp: '' }
      ],
      inReplyTo: '<parent@example.test>',
      references: '<root@example.test> <parent@example.test>',
      importance: 2,
      transportHeaders: [
        'Received: from mx.example.test by mail.example.test;',
        '\tThu, 16 Oct 2025 09:30:05 +0000',
        'Content-Type: multipart/mixed; boundary="original"',
        'Subject: original subject',
        'X-Mailer: Outlook 16',
        'Reply-To: replies@example.test',
        'not a header line',
        'Status: RO',
        ''
      ].join('\r\n')
    }))
    const text = raw.toString('utf8')
    expect(text).toContain('Date: Thu, 16 Oct 2025 09:30:00 +0000\r\n')
    expect(text).toContain('Sender: Ada Lovelace <ada@example.test>\r\n')
    expect(text).toContain('Received: from mx.example.test by mail.example.test;\r\n\tThu, 16 Oct 2025 09:30:05 +0000\r\n')
    expect(text).not.toMatch(/boundary="original"|original subject|not a header|Status: RO/)
    expect(text).toContain('Importance: high\r\nX-Priority: 1\r\n')

    const parsed = await parse(raw)
    expect(parsed.subject).toBe('Überweisung – März')
    expect(parsed.from).toEqual({ name: 'Ada (Finance)', address: 'finance@example.test' })
    expect(parsed.to).toEqual([{ name: 'Bob', address: 'bob@example.test' }, { name: 'Legacy Exchange user', group: [] }])
    expect(parsed.cc).toEqual([{ name: '"Quoted", Carol', address: 'carol@example.test' }])
    expect(parsed.bcc).toEqual([{ name: 'Hidden', address: 'hidden@example.test' }])
    expect(parsed.messageId).toBe('<report@example.test>')
    expect(parsed.inReplyTo).toBe('<parent@example.test>')
    expect(parsed.references).toBe('<root@example.test> <parent@example.test>')
    expect(parsed.replyTo).toEqual([{ name: '', address: 'replies@example.test' }])
    expect(parsed.text).toBe('Plain body')
    expect(importMetadata(raw)).toMatchObject({ messageId: '<report@example.test>', threadRoot: '<root@example.test>', date: '2025-10-16T09:30:00.000Z' })
  })

  it('is deterministic, so a re-read message hashes the same', () => {
    const message = pstMessage({ html: '<p>Hi</p>' }, [pstAttachment()])
    expect(convert(message).equals(convert(message))).toBe(true)
    expect(pstMessageToMime(message, { maxBytes: LIMIT, seed: 'other' }).equals(convert(message))).toBe(false)
  })

  it('keeps plain and HTML bodies, inline images and attachments', async () => {
    const parsed = await parse(convert(pstMessage({ html: '<p>Logo <img src="cid:logo@example"></p>' }, [
      pstAttachment({ filename: 'logo.png', mimeType: 'image/png', contentId: 'logo@example', content: Buffer.from('PNGDATA') }),
      pstAttachment({ filename: 'Résumé "final".pdf', content: Buffer.from('%PDF') }),
      pstAttachment({ filename: 'unused.png', mimeType: 'image/png', contentId: 'unused', content: Buffer.from('X') }),
      pstAttachment({ filename: '', mimeType: 'not a type', content: Buffer.from('raw') }),
      pstAttachment({ method: 2, filename: 'link.lnk' }),
      pstAttachment({ filename: 'missing.bin', data: () => null })
    ])))
    expect(parsed.text).toBe('Plain body')
    expect(parsed.html).toBe('<p>Logo <img src="cid:logo@example"></p>')
    expect(parsed.attachments.map((attachment) => [attachment.filename, attachment.mimeType, attachment.disposition, attachment.contentId, Buffer.from(attachment.content as ArrayBuffer).toString()])).toEqual([
      ['logo.png', 'image/png', 'inline', '<logo@example>', 'PNGDATA'],
      ['Résumé _final_.pdf', 'application/pdf', 'attachment', undefined, '%PDF'],
      ['unused.png', 'image/png', 'attachment', '<unused>', 'X'],
      ['attachment-4', 'application/octet-stream', 'attachment', undefined, 'raw']
    ])
  })

  it('embeds attached Outlook messages as message/rfc822', async () => {
    const inner = pstMessage({ subject: 'Forwarded original', body: 'Inner body', internetMessageId: '<inner@example.test>' }, [pstAttachment({ filename: 'inner.txt', mimeType: 'text/plain', content: Buffer.from('inner attachment') })])
    const raw = convert(pstMessage({}, [pstAttachment({ method: 5, filename: '', embedded: () => inner })]))
    const parsed = await parse(raw)
    expect(parsed.attachments).toHaveLength(1)
    expect(parsed.attachments[0]).toMatchObject({ filename: 'Forwarded original.eml', mimeType: 'message/rfc822' })
    const nested = await parse(Buffer.from(parsed.attachments[0].content as ArrayBuffer))
    expect(nested).toMatchObject({ subject: 'Forwarded original', text: 'Inner body', messageId: '<inner@example.test>' })
    expect(nested.attachments.map((attachment) => attachment.filename)).toEqual(['inner.txt'])
  })

  it('uses compressed RTF: de-encapsulated HTML, or text when there is no text body', async () => {
    const htmlRtf = literalLzfu('{\\rtf1\\ansi\\fromhtml1 {\\*\\htmltag <p>}From RTF{\\*\\htmltag </p>}}')
    const fromHtml = await parse(convert(pstMessage({ body: 'Text version', rtfCompressed: htmlRtf })))
    expect(fromHtml).toMatchObject({ html: '<p>From RTF</p>', text: 'Text version' })

    const plainRtf = literalLzfu('{\\rtf1\\ansi\\fromtext Only in \\b RTF\\b0\\par second line}')
    expect((await parse(convert(pstMessage({ body: '', rtfCompressed: plainRtf })))).text).toBe('Only in RTF\nsecond line')
    // A text body wins over non-HTML RTF; an unreadable RTF body is ignored.
    expect((await parse(convert(pstMessage({ body: 'Keep me', rtfCompressed: plainRtf })))).text).toBe('Keep me')
    expect((await parse(convert(pstMessage({ body: 'Still here', rtfCompressed: Buffer.from('garbage') })))).text).toBe('Still here')
  })

  it('falls back to display names, creation time and empty bodies', async () => {
    const raw = convert(pstMessage({ recipients: [], displayTo: 'Bob; Carol', submitTime: null, deliveryTime: null, creationTime: new Date('2024-02-29T23:59:59Z'), internetMessageId: '', subject: '', body: '' }))
    const parsed = await parse(raw)
    expect(parsed.to).toEqual([{ name: 'Bob', group: [] }, { name: 'Carol', group: [] }])
    expect(parsed.date).toBe('2024-02-29T23:59:59.000Z')
    expect(parsed.messageId).toBeUndefined()
    expect(parsed.text ?? '').toBe('')
    expect(rfc5322Date(new Date('2026-01-04T05:06:07Z'))).toBe('Sun, 04 Jan 2026 05:06:07 +0000')
  })

  it('refuses messages over the size limit before reading large attachments', () => {
    let read = false
    const big = pstAttachment({ size: 2 * LIMIT, data: () => { read = true; return Buffer.alloc(0) } })
    expect(() => convert(pstMessage({}, [big]))).toThrow(PstMessageTooLargeError)
    expect(read).toBe(false)
    expect(() => convert(pstMessage({ size: 3 * LIMIT }))).toThrow(PstMessageTooLargeError)
    expect(() => convert(pstMessage({ body: 'x'.repeat(LIMIT) }))).toThrow(PstMessageTooLargeError)
  })

  it('recognises mail message classes', () => {
    expect(['IPM.Note', 'IPM.Note.SMIME', 'IPM.Schedule.Meeting.Request', 'REPORT.IPM.Note.NDR', 'IPM.Post', ''].every(isMailMessageClass)).toBe(true)
    expect(['IPM.Contact', 'IPM.Appointment', 'IPM.Task', 'IPM.StickyNote', 'IPM.Activity', 'IPM.DistList'].some(isMailMessageClass)).toBe(false)
  })
})
