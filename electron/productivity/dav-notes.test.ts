import { afterEach, describe, expect, it } from 'vitest'
import { DavClient } from './dav-client'
import { DavFixtureServer, VJOURNAL } from './dav-fixture-server'
import { listNoteCollections, newJournal, parseJournal, patchJournal } from './dav-notes'
import type { NoteDraft, StoredNoteAttachment } from './server-notes-store'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4f30000000049454e44ae426082', 'hex')
const servers: DavFixtureServer[] = []
afterEach(async () => { for (const server of servers.splice(0)) await server.stop() })

const NOW = new Date('2026-10-17T12:00:00Z')
const attachment = (overrides: Partial<StoredNoteAttachment> = {}): StoredNoteAttachment => ({ id: 'pic-1', name: 'pixel.png', mime: 'image/png', size: PNG.length, inline: true, sha256: 'x', path: '/tmp/pixel.png', ...overrides })
const read = () => PNG

describe('CalDAV VJOURNAL notes', () => {
  it('discovers VJOURNAL-only and mixed collections and ignores calendars without a declared component set', async () => {
    const server = await new DavFixtureServer().start()
    servers.push(server)
    server.addCollection({ slug: 'journal', kind: 'calendar', name: 'Journal', components: ['VJOURNAL'] })
    server.addCollection({ slug: 'mixed', kind: 'calendar', name: 'Everything', components: ['VEVENT', 'VTODO', 'VJOURNAL'], color: '#336699' })
    server.addCollection({ slug: 'shared-notes', kind: 'calendar', name: 'Team notes', components: ['VJOURNAL'], readOnly: true })
    server.addCollection({ slug: 'events', kind: 'calendar', name: 'Events', components: ['VEVENT'] })
    server.addCollection({ slug: 'legacy', kind: 'calendar', name: 'Legacy' })
    const client = new DavClient({ username: 'ada@example.com', password: 'app-password' })
    const folders = await listNoteCollections(client, new URL(server.calendarHome, server.url).toString())
    expect(folders.map((folder) => [folder.name, folder.readOnly, Boolean(folder.mixed), folder.color])).toEqual([
      ['Journal', false, false, undefined], ['Everything', false, true, '#336699'], ['Team notes', true, false, undefined]
    ])
  })

  it('maps SUMMARY, DESCRIPTION, sanitized X-ALT-DESC with cid pictures, CATEGORIES, CLASS, and binary ATTACH', () => {
    const raw = VJOURNAL('n1', 'Plan', 'Hello world', [
      'X-ALT-DESC;FMTTYPE=text/html:<p onclick="x()">Hello <b>world</b></p><img src="cid:pic-1" alt="dot"><script>bad()</script>',
      'CATEGORIES:Work,Ideas', 'CATEGORIES:Work', 'CLASS:CONFIDENTIAL', 'LAST-MODIFIED:20261001T080000Z',
      `ATTACH;VALUE=BINARY;ENCODING=BASE64;FMTTYPE=image/png;X-FILENAME=dot.png;X-AERIO-ATTACHMENT-ID=pic-1:${PNG.toString('base64')}`,
      `ATTACH;VALUE=BINARY;ENCODING=BASE64;FMTTYPE=text/plain;FILENAME=readme.txt:${Buffer.from('read me').toString('base64')}`,
      'ATTACH:https://files.example.com/spec.pdf'
    ].join('\n'))
    const fields = parseJournal(raw)!
    expect(fields).toMatchObject({ title: 'Plan', content: 'Hello world', tags: ['Work', 'Ideas'], classification: 'CONFIDENTIAL', modified: '2026-10-01T08:00:00.000Z', uid: 'n1' })
    expect(fields.html).toBe('<p>Hello <b>world</b></p><img data-aerio-note-image="pic-1" alt="dot" />')
    expect(fields.attachments.map((item) => [item.id, item.name, item.mime, item.inline, item.content?.toString('utf8').slice(0, 7)])).toEqual([
      ['pic-1', 'dot.png', 'image/png', true, PNG.toString('utf8').slice(0, 7)], [expect.stringMatching(/^att-/), 'readme.txt', 'text/plain', false, 'read me']
    ])
  })

  it('prefers the plain DESCRIPTION when another client left a stale HTML alternative', () => {
    const fields = parseJournal(VJOURNAL('n2', 'Stale', 'Edited elsewhere', 'X-ALT-DESC;FMTTYPE=text/html:<p>Original text</p>'))!
    expect(fields).toMatchObject({ content: 'Edited elsewhere' })
    expect(fields.html).toBeUndefined()
    expect(parseJournal(VJOURNAL('n3', '', 'First line\nsecond'))!.title).toBe('First line')
    expect(parseJournal('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:e\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n')).toBeUndefined()
  })

  it('patches only edited properties and keeps unknown properties, URI attachments, alarms, and other components byte for byte', () => {
    const raw = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Other//EN', 'X-WR-CALNAME:Keep me', 'BEGIN:VTIMEZONE', 'TZID:Europe/Paris', 'END:VTIMEZONE',
      'BEGIN:VJOURNAL', 'UID:keep', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Old title', 'DESCRIPTION:Body stays', 'CATEGORIES:A',
      'X-CUSTOM;X-PARAM="a:b":custom value', 'ATTACH:https://files.example.com/spec.pdf', 'COLOR:turquoise',
      ' ', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'SUMMARY:Alarm summary', 'END:VALARM', 'END:VJOURNAL', 'END:VCALENDAR', ''
    ].join('\r\n').replace('\r\n \r\n', '\r\n')
    const base = parseJournal(raw)!
    const { uid: _uid, ...baseFields } = base
    const stored = { ...baseFields, attachments: [] }
    const draft: NoteDraft = { ...stored, title: 'New title' }
    const patched = patchJournal(raw, stored, draft, read, NOW)
    expect(patched).toContain('SUMMARY:New title')
    expect(patched).not.toContain('SUMMARY:Old title')
    for (const kept of ['X-WR-CALNAME:Keep me', 'TZID:Europe/Paris', 'DESCRIPTION:Body stays', 'CATEGORIES:A', 'X-CUSTOM;X-PARAM="a:b":custom value', 'ATTACH:https://files.example.com/spec.pdf', 'COLOR:turquoise', 'SUMMARY:Alarm summary']) {
      expect(patched).toContain(kept)
    }
    expect(patched).toContain('LAST-MODIFIED:20261017T120000Z')
    expect(patched).not.toContain('DTSTAMP:20260101T000000Z')
    // The rewritten lines go inside the VJOURNAL, after its alarm.
    expect(patched.indexOf('SUMMARY:New title')).toBeGreaterThan(patched.indexOf('END:VALARM'))
    expect(patched.indexOf('SUMMARY:New title')).toBeLessThan(patched.indexOf('END:VJOURNAL'))
    expect(parseJournal(patched)).toMatchObject({ title: 'New title', content: 'Body stays', tags: ['A'] })

    const rich = patchJournal(raw, stored, { ...stored, content: 'Rich\nbody', html: '<div>Rich</div><div>body<img data-aerio-note-image="pic-1" alt=""></div>', tags: [], attachments: [attachment()] }, read, NOW)
    expect(rich).not.toContain('CATEGORIES:A')
    expect(rich).toContain('DESCRIPTION:Rich\\nbody')
    expect(rich.replace(/\r\n /g, '')).toContain('X-ALT-DESC;FMTTYPE=text/html:<div>Rich</div><div>body<img src="cid:pic-1" alt=""></div>')
    expect(rich.replace(/\r\n /g, '')).toContain(`ATTACH;VALUE=BINARY;ENCODING=BASE64;FMTTYPE=image/png;X-FILENAME=pixel.png;X-AERIO-ATTACHMENT-ID=pic-1;X-AERIO-INLINE=TRUE:${PNG.toString('base64')}`)
    expect(rich).toContain('ATTACH:https://files.example.com/spec.pdf')
    const reread = parseJournal(rich)!
    expect(reread.html).toBe('<div>Rich</div><div>body<img data-aerio-note-image="pic-1" alt="" /></div>')
    expect(reread.attachments[0]).toMatchObject({ id: 'pic-1', inline: true })
  })

  it('writes new notes as folded VJOURNAL objects with vNote extras', () => {
    const data = newJournal({ title: 'From vNote', content: 'x'.repeat(200), tags: ['a,b'], attachments: [], classification: 'PRIVATE', created: '2024-01-02T03:04:05.000Z', extraLines: ['X-ORGANIZER-COLOR:yellow'] }, read, NOW, 'uid-1')
    expect(data.split('\r\n').every((line) => Buffer.byteLength(line) <= 75)).toBe(true)
    expect(data).toContain('CREATED:20240102T030405Z')
    expect(data).toContain('CATEGORIES:a\\,b')
    expect(parseJournal(data)).toMatchObject({ title: 'From vNote', content: 'x'.repeat(200), tags: ['a,b'], classification: 'PRIVATE', uid: 'uid-1' })
    expect(data).toContain('X-ORGANIZER-COLOR:yellow')
  })
})
