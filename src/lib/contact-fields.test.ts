import { describe, expect, it } from 'vitest'
import type { Contact } from '../types'
import { contactEditConflict, contactEmailAddresses, contactGroupNames, editableFields, isContactBirthday, isContactPhoto, withContactFields, CONTACT_PHOTO_MAX_CHARS } from './contact-fields'
import { validContactInterchangeFields, validContactList, validContactLists } from './interchange-validation'

const base: Contact = { id: 'c', name: 'Ada Lovelace', email: 'ada@example.test', group: 'Personal', favorite: false, color: '#000', source: 'local' }

describe('contact fields', () => {
  it('derives primary values and groups from edited multi-value lists', () => {
    const next = withContactFields(base, {
      emails: [{ value: ' ada@home.test ', type: 'home' }, { value: 'ADA@home.test' }, { value: 'ada@work.test', type: 'work', preferred: true }, { value: '' }],
      phones: [{ value: '+44 1', type: 'mobile', preferred: true }, { value: '+44 (1)', type: 'home', preferred: true }],
      addresses: [{ value: '1 Lane, London', type: 'home', parts: ['', '', '1 Lane', 'London', '', '', ''] }],
      groups: ['Friends', ' friends ', 'Chess club', '']
    }, 'Personal')
    expect(next).toMatchObject({
      email: 'ada@work.test', phone: '+44 1', group: 'Friends', groups: ['Friends', 'Chess club'],
      emails: [{ value: 'ada@home.test', type: 'home' }, { value: 'ada@work.test', type: 'work', preferred: true }],
      phones: [{ value: '+44 1', type: 'mobile', preferred: true }],
      addresses: [{ value: '1 Lane, London', type: 'home' }]
    })
    const cleared = withContactFields({ ...next }, { emails: [], phones: [], addresses: [], groups: [] }, 'Personal')
    expect(cleared).toMatchObject({ email: '', group: 'Personal' })
    expect(cleared).not.toHaveProperty('phone')
    expect(cleared).not.toHaveProperty('emails')
    expect(cleared).not.toHaveProperty('groups')
  })

  it('starts the editor from stored lists or the legacy single values', () => {
    expect(editableFields(undefined)).toEqual({ emails: [], phones: [], addresses: [], groups: [] })
    expect(editableFields({ ...base, phone: '+1' })).toMatchObject({ emails: [{ value: 'ada@example.test' }], phones: [{ value: '+1' }], groups: ['Personal'] })
    expect(editableFields({ ...base, emails: [{ value: 'a@b.test', type: 'work' }], groups: ['A', 'B'] })).toMatchObject({ emails: [{ value: 'a@b.test', type: 'work' }], groups: ['A', 'B'] })
    expect(contactGroupNames({ group: 'Solo' })).toEqual(['Solo'])
    expect(contactEmailAddresses({ email: 'A@b.test', emails: [{ value: 'a@b.test' }, { value: 'c@d.test' }] })).toEqual(['A@b.test', 'c@d.test'])
  })

  it('bounds photos and birthdays', () => {
    expect(isContactPhoto('data:image/png;base64,iVBORw0KGgo=')).toBe(true)
    expect(isContactPhoto('https://example.test/photo.png')).toBe(false)
    expect(isContactPhoto('data:image/svg+xml;base64,PHN2Zz4=')).toBe(false)
    expect(isContactPhoto(`data:image/jpeg;base64,${'A'.repeat(CONTACT_PHOTO_MAX_CHARS)}`)).toBe(false)
    expect(['1815-12-10', '18151210', '--12-10', '--1210'].every(isContactBirthday)).toBe(true)
    expect(['1815-13-10', 'next week', '--00-10', 7].some(isContactBirthday)).toBe(false)
  })

  it('reports an edit made against an older revision', () => {
    expect(contactEditConflict({ revision: 'r2' }, { revision: 'r1' })).toMatch(/changed since you opened it/)
    expect(contactEditConflict({ revision: 'r2' }, { revision: 'r2' })).toBeUndefined()
    expect(contactEditConflict({ revision: 'r2' }, {})).toBeUndefined()
    expect(contactEditConflict({}, { revision: 'r1' })).toBeUndefined()
  })

  it('validates new contact fields and local distribution lists at the IPC boundary', () => {
    expect(validContactInterchangeFields({ groups: ['A'], photo: 'data:image/png;base64,AAAA' })).toBe(true)
    expect(validContactInterchangeFields({ groups: [''] })).toBe(false)
    expect(validContactInterchangeFields({ groups: Array.from({ length: 101 }, (_, index) => `g${index}`) })).toBe(false)
    expect(validContactInterchangeFields({ photo: 'javascript:alert(1)' })).toBe(false)
    const list = { id: 'list-1', name: 'Team', source: 'local', members: [{ email: 'a@b.test' }, { contactId: 'c', email: 'Ada <ada@example.test>', name: 'Ada' }] }
    expect(validContactList(list)).toBe(true)
    expect(validContactList({ ...list, members: [{ email: 'not an address' }] })).toBe(false)
    expect(validContactList({ ...list, source: 'gmail' })).toBe(false)
    expect(validContactList({ ...list, name: ' ' })).toBe(false)
    expect(validContactList({ ...list, members: Array.from({ length: 5_001 }, () => ({ email: 'a@b.test' })) })).toBe(false)
    expect(validContactLists([list, list])).toBe(false)
    expect(validContactLists([list])).toBe(true)
  })
})
