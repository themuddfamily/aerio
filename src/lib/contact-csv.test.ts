import { describe, expect, it } from 'vitest'
import { contactsFromCsv, parseCsv, serializeContactsCsv, suggestCsvMapping, CSV_LIMITS } from './contact-csv'

let counter = 0
const options = { idFactory: () => `contact-${++counter}` }

describe('parseCsv', () => {
  it('handles BOMs, quoted delimiters, escaped quotes, embedded newlines, and delimiter detection', () => {
    expect(parseCsv('﻿Name,Notes\r\n"Lovelace, Ada","She said ""hi""\nthen left"\r\n\r\nBob,\r\n')).toEqual({
      headers: ['Name', 'Notes'], rows: [['Lovelace, Ada', 'She said "hi"\nthen left'], ['Bob', '']]
    })
    expect(parseCsv('Name;Email\nAda;ada@test')).toEqual({ headers: ['Name', 'Email'], rows: [['Ada', 'ada@test']] })
    expect(parseCsv('Name\tEmail\nAda\tada@test').rows).toEqual([['Ada', 'ada@test']])
    expect(parseCsv('Name,,Email\nAda,x,ada@test').headers).toEqual(['Name', 'Column 2', 'Email'])
  })

  it('rejects malformed and oversized files', () => {
    expect(() => parseCsv('Name\n"Ada')).toThrow(/unterminated/)
    expect(() => parseCsv('')).toThrow(/empty/)
    expect(() => parseCsv('a,b,c\n1,2,3', { ...CSV_LIMITS, maxColumns: 2 })).toThrow(/columns/)
    expect(() => parseCsv('a\n1\n2\n3', { ...CSV_LIMITS, maxRows: 2 })).toThrow(/rows/)
    expect(() => parseCsv(`a\n${'x'.repeat(20)}`, { ...CSV_LIMITS, maxCellLength: 10 })).toThrow(/too long/)
  })
})

describe('contact CSV mapping', () => {
  it('suggests mappings for Google and Outlook exports', () => {
    const google = ['Name', 'Given Name', 'Family Name', 'E-mail 1 - Type', 'E-mail 1 - Value', 'E-mail 2 - Value', 'Phone 1 - Type', 'Phone 1 - Value',
      'Organization 1 - Name', 'Organization 1 - Title', 'Address 1 - Formatted', 'Address 1 - Street', 'Group Membership', 'Notes', 'Website 1 - Value', 'Phonetic First Name']
    expect(suggestCsvMapping(google)).toEqual(['name', 'firstName', 'lastName', 'ignore', 'email', 'email', 'ignore', 'phone',
      'company', 'title', 'address', 'ignore', 'group', 'notes', 'url', 'ignore'])
    const outlook = ['Title', 'First Name', 'Middle Name', 'Last Name', 'Company', 'Job Title', 'Business Street', 'Business Phone', 'Mobile Phone',
      'E-mail Address', 'E-mail Type', 'E-mail Display Name', 'E-mail 2 Address', 'Categories', 'Birthday', 'Web Page']
    expect(suggestCsvMapping(outlook)).toEqual(['ignore', 'firstName', 'middleName', 'lastName', 'company', 'title', 'address', 'phone', 'phone',
      'email', 'ignore', 'ignore', 'email', 'group', 'birthday', 'url'])
  })

  it('maps rows to contacts with multiple typed fields and skips rows without identity', () => {
    const table = parseCsv([
      'First Name,Last Name,E-mail Address,E-mail 2 Address,Mobile Phone,Business Phone,Company,Job Title,Categories,Notes,Home Address',
      'Ada,Lovelace,ada@work.test,ada@home.test,+44 1,+44 2,Engines,Countess,Friends;Science,Hello,"1 Lane, London"',
      ',,,,,,,,,,',
      ',,,,555,,,,,just a phone,'
    ].join('\n'))
    const { contacts, skipped } = contactsFromCsv(table, suggestCsvMapping(table.headers), options)
    expect(skipped).toBe(1)
    expect(contacts).toHaveLength(1)
    expect(contacts[0]).toMatchObject({
      name: 'Ada Lovelace', email: 'ada@work.test', phone: '+44 1', company: 'Engines', title: 'Countess', group: 'Friends', notes: 'Hello',
      nameParts: ['Lovelace', 'Ada', '', '', ''],
      emails: [{ value: 'ada@work.test' }, { value: 'ada@home.test' }],
      phones: [{ value: '+44 1', type: 'cell' }, { value: '+44 2', type: 'work' }],
      addresses: [{ value: '1 Lane, London', type: 'home' }]
    })
  })

  it('splits Google multi-value cells and honours a custom mapping', () => {
    const table = parseCsv('Who,Mail,Labels\nAda,a@one.test ::: a@two.test,* myContacts ::: Team\n')
    const { contacts } = contactsFromCsv(table, ['name', 'email', 'group'], options)
    expect(contacts[0]).toMatchObject({ name: 'Ada', email: 'a@one.test', group: 'Team', emails: [{ value: 'a@one.test' }, { value: 'a@two.test' }] })
  })

  it('exports CSV that maps back to the same core fields and neutralizes formulas', () => {
    const text = serializeContactsCsv([{
      id: 'c', name: 'Ada Lovelace', email: 'ada@test', phone: '=1+2', group: 'Friends', notes: 'Line, "quoted"\nnext', favorite: false, color: '#000',
      nameParts: ['Lovelace', 'Ada', '', '', ''], emails: [{ value: 'ada@test' }, { value: 'ada2@test' }], sourceUid: 'uid-1'
    }])
    expect(text.startsWith('﻿')).toBe(true)
    expect(text).toContain("'=1+2")
    const table = parseCsv(text)
    const { contacts } = contactsFromCsv(table, suggestCsvMapping(table.headers), options)
    expect(contacts[0]).toMatchObject({ name: 'Ada Lovelace', email: 'ada@test', group: 'Friends', notes: 'Line, "quoted"\nnext', sourceUid: 'uid-1', emails: [{ value: 'ada@test' }, { value: 'ada2@test' }] })
  })
})
