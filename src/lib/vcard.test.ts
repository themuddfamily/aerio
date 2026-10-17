import { describe, expect, it } from 'vitest'
import type { Contact } from '../types'
import { InterchangeFormatError } from './content-lines'
import { parseVCards, serializeVCards, VCARD_LIMITS } from './vcard'

let counter = 0
const options = { idFactory: () => `contact-${++counter}` }

describe('parseVCards', () => {
  it('reads vCard 3.0 with multiple typed fields, groups, structured names, and escaped values', () => {
    const { contacts, warnings } = parseVCards([
      'BEGIN:VCARD', 'VERSION:3.0', 'UID:urn:uuid:1234',
      'N:Lovelace;Ada;King;Countess;', 'FN:Ada Lovelace',
      'ORG:Analytical Engines\\, Ltd;Research', 'TITLE:Mathematician',
      'item1.EMAIL;TYPE=INTERNET,WORK:ada@work.test', 'EMAIL;TYPE=INTERNET,HOME,PREF:ada@home.test',
      'TEL;TYPE=CELL:+44 20 1234', 'TEL;TYPE=WORK,VOICE:+44 20 9999',
      'ADR;TYPE=HOME:;;12 St James\\, Square;London;;SW1;UK',
      'URL:https://ada.test', 'BDAY:1815-12-10', 'NICKNAME:Enchantress',
      'CATEGORIES:Friends,Science', 'NOTE:First line\\nSecond\\; line', 'PHOTO;ENCODING=b;TYPE=JPEG:AAAA',
      'END:VCARD', ''
    ].join('\r\n'), options)
    expect(warnings).toEqual([])
    expect(contacts).toHaveLength(1)
    expect(contacts[0]).toMatchObject({
      name: 'Ada Lovelace', email: 'ada@home.test', phone: '+44 20 1234', company: 'Analytical Engines, Ltd', title: 'Mathematician',
      group: 'Friends', notes: 'First line\nSecond; line', nickname: 'Enchantress', birthday: '1815-12-10', sourceUid: 'urn:uuid:1234',
      nameParts: ['Lovelace', 'Ada', 'King', 'Countess', ''],
      emails: [{ value: 'ada@work.test', type: 'work' }, { value: 'ada@home.test', type: 'home', preferred: true }],
      phones: [{ value: '+44 20 1234', type: 'cell' }, { value: '+44 20 9999', type: 'work' }],
      addresses: [{ value: '12 St James, Square, London SW1, UK', type: 'home', parts: ['', '', '12 St James, Square', 'London', '', 'SW1', 'UK'] }],
      urls: [{ value: 'https://ada.test' }],
      groups: ['Friends', 'Science'], photo: 'data:image/jpeg;base64,AAAA'
    })
  })

  it('round-trips every group and embedded photos, skipping linked or unsupported images', () => {
    const contact: Contact = { id: 'c', name: 'Ada', email: 'a@x.test', group: 'Friends', groups: ['Friends', 'Chess, club'], favorite: false, color: '#000', photo: 'data:image/png;base64,iVBORw0KGgo=' }
    for (const version of ['3.0', '4.0'] as const) {
      const text = serializeVCards([contact], version)
      expect(text).toContain('CATEGORIES:Friends,Chess\\, club')
      expect(text).toContain(version === '4.0' ? 'PHOTO:data:image/png;base64,iVBORw0KGgo=' : 'PHOTO;ENCODING=b;TYPE=PNG:iVBORw0KGgo=')
      expect(parseVCards(text, options).contacts[0]).toMatchObject({ groups: ['Friends', 'Chess, club'], photo: contact.photo })
    }
    const { contacts } = parseVCards(['BEGIN:VCARD', 'VERSION:4.0', 'FN:Linked', 'PHOTO:https://example.test/a.jpg', 'END:VCARD',
      'BEGIN:VCARD', 'VERSION:3.0', 'FN:Tiff', 'PHOTO;ENCODING=b;TYPE=TIFF:AAAA', 'END:VCARD', ''].join('\r\n'), options)
    expect(contacts.map((item) => item.photo)).toEqual([undefined, undefined])
  })

  it('reads vCard 4.0 PREF parameters and vCard 2.1 bare types with quoted-printable values', () => {
    const { contacts } = parseVCards([
      'BEGIN:VCARD', 'VERSION:4.0', 'FN:Grace Hopper', 'EMAIL;TYPE=work:grace@navy.test', 'EMAIL;PREF=1:grace@home.test', 'TEL;VALUE=uri;TYPE=cell:tel:+1-555-0100', 'END:VCARD',
      'BEGIN:VCARD', 'VERSION:2.1', 'N:Müller;Jürgen', 'TEL;WORK;VOICE:555', 'NOTE;ENCODING=QUOTED-PRINTABLE;CHARSET=UTF-8:Gr=C3=BC=C3=9Fe aus=', ' Berlin', 'END:VCARD',
      'BEGIN:VCARD', 'VERSION:2.1', 'NOTE;ENCODING=QUOTED-PRINTABLE:soft=', 'break', 'FN:Soft Break', 'END:VCARD', ''
    ].join('\r\n'), options)
    expect(contacts[0]).toMatchObject({ name: 'Grace Hopper', email: 'grace@home.test', phone: '+1-555-0100' })
    expect(contacts[1]).toMatchObject({ name: 'Jürgen Müller', phone: '555', phones: [{ value: '555', type: 'work' }], notes: 'Grüße aus Berlin' })
    expect(contacts[2]).toMatchObject({ name: 'Soft Break', notes: 'softbreak' })
  })

  it('skips nameless cards, warns about unknown versions, and rejects files that are not vCards', () => {
    const { contacts, warnings } = parseVCards('BEGIN:VCARD\r\nVERSION:9.9\r\nFN:Future\r\nEND:VCARD\r\nBEGIN:VCARD\r\nVERSION:3.0\r\nNOTE:only notes\r\nEND:VCARD\r\n', options)
    expect(contacts.map((contact) => contact.name)).toEqual(['Future'])
    expect(warnings.join(' ')).toMatch(/without a name/)
    expect(warnings.join(' ')).toMatch(/unrecognized vCard version/)
    expect(() => parseVCards('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', options)).toThrow(InterchangeFormatError)
    expect(() => parseVCards('Name,Email\r\nAda,ada@test\r\n', options)).toThrow(/not a vCard/)
    expect(() => parseVCards('BEGIN:VCARD\r\nFN:x\r\nEND:VCALENDAR\r\n', options)).toThrow(/unexpected END/)
    expect(() => parseVCards('BEGIN:VCARD\r\nFN:a\r\nEND:VCARD\r\nBEGIN:VCARD\r\nFN:b\r\nEND:VCARD\r\n', options, VCARD_LIMITS, 1)).toThrow(/more than 1 contacts/)
  })
})

describe('serializeVCards round trips', () => {
  const contact: Contact = {
    id: 'c1', name: 'Ada Lovelace', email: 'ada@home.test', phone: '+44 20 1234', company: 'Engines; Ltd', title: 'Countess, mathematician',
    group: 'Friends', notes: 'Line one\nLine two', favorite: true, color: '#000', source: 'local', sourceUid: 'urn:uuid:ada',
    nameParts: ['Lovelace', 'Ada', '', '', ''], nickname: 'Ada', birthday: '1815-12-10',
    emails: [{ value: 'ada@work.test', type: 'work' }, { value: 'ada@home.test', type: 'home', preferred: true }],
    phones: [{ value: '+44 20 1234', type: 'cell', preferred: true }, { value: '+44 20 5555', type: 'fax' }],
    addresses: [{ value: '1 Lane, London', type: 'home', parts: ['', '', '1 Lane', 'London', '', '', 'UK'] }],
    urls: [{ value: 'https://ada.test', type: 'work' }]
  }

  for (const version of ['3.0', '4.0'] as const) {
    it(`preserves multiple fields and identity through vCard ${version}`, () => {
      const text = serializeVCards([contact, { id: 'c2', name: 'Plain Person', email: 'plain@test', group: 'Personal', favorite: false, color: '#fff' }], version)
      expect(text).toContain(`VERSION:${version}`)
      expect(text.split('\r\n').every((line) => new TextEncoder().encode(line).length <= 75)).toBe(true)
      const { contacts } = parseVCards(text, { idFactory: () => 'new-id' })
      expect(contacts[0]).toMatchObject({
        name: contact.name, email: 'ada@home.test', phone: '+44 20 1234', company: contact.company, title: contact.title, group: 'Friends',
        notes: contact.notes, sourceUid: 'urn:uuid:ada', nameParts: contact.nameParts, nickname: 'Ada', birthday: '1815-12-10',
        emails: [{ value: 'ada@work.test', type: 'work' }, { value: 'ada@home.test', type: 'home', preferred: true }],
        phones: [{ value: '+44 20 1234', type: 'cell', preferred: true }, { value: '+44 20 5555', type: 'fax' }],
        addresses: [{ type: 'home', parts: ['', '', '1 Lane', 'London', '', '', 'UK'] }], urls: [{ value: 'https://ada.test', type: 'work' }]
      })
      expect(contacts[1]).toMatchObject({ name: 'Plain Person', email: 'plain@test', nameParts: ['Person', 'Plain', '', '', ''] })
    })
  }
})
