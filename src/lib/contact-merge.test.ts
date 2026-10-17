import { describe, expect, it } from 'vitest'
import type { Contact, ContactList } from '../types'
import type { SyncedContact } from '../productivity-types'
import { buildMergedContact, mergeFieldPreviews, mergeWarnings, relinkListMembers, restoreListMembers, sameContact } from './contact-merge'

const survivor: Contact = {
  id: 'ada', name: 'Ada Lovelace', email: 'ada@home.test', phone: '+44 1', company: 'Analytical', group: 'Friends', favorite: false, color: '#000', source: 'local',
  emails: [{ value: 'ada@home.test', type: 'home', preferred: true }], phones: [{ value: '+44 1', type: 'mobile' }],
  addresses: [{ value: '1 Lane, London', type: 'home', parts: ['', '', '1 Lane', 'London', '', '', ''] }],
  urls: [{ value: 'https://ada.test' }], groups: ['Friends'], notes: 'Met at the society', nameParts: ['Lovelace', 'Ada', '', '', ''], sourceUid: 'uid-ada'
}
const other: Contact = {
  id: 'ada-2', name: 'Augusta Ada King', email: 'ada@work.test', company: 'Babbage & Co', title: 'Programmer', group: 'Work', favorite: true, color: '#111', source: 'local',
  emails: [{ value: 'ada@work.test', type: 'work', preferred: true }, { value: 'ADA@home.test', type: 'other' }], phones: [{ value: '+44 2', type: 'work' }],
  addresses: [{ value: '2 Street, London', type: 'work' }], urls: [{ value: 'HTTPS://ada.test' }, { value: 'https://engine.test' }], groups: ['Work', 'friends'],
  notes: 'Prefers letters', birthday: '1815-12-10', photo: 'data:image/png;base64,AA==', nameParts: ['King', 'Augusta', 'Ada', '', '']
}

describe('mergeFieldPreviews', () => {
  it('asks only about conflicting single values and defaults to the kept record', () => {
    const previews = mergeFieldPreviews(survivor, other)
    expect(previews.map((preview) => [preview.field, preview.conflict, preview.choice])).toEqual([
      ['name', true, 'survivor'], ['company', true, 'survivor'], ['title', false, 'other'], ['birthday', false, 'other'], ['photo', false, 'other'], ['notes', true, 'both']
    ])
  })
})

describe('buildMergedContact', () => {
  it('keeps every multi-value field, the survivor identity, and its primary values', () => {
    const merged = buildMergedContact(survivor, other)
    expect(merged).toMatchObject({ id: 'ada', name: 'Ada Lovelace', email: 'ada@home.test', phone: '+44 1', company: 'Analytical', title: 'Programmer', birthday: '1815-12-10', photo: other.photo, favorite: true, sourceUid: 'uid-ada', color: '#000', source: 'local' })
    expect(merged.emails).toEqual([{ value: 'ada@home.test', type: 'home', preferred: true }, { value: 'ada@work.test', type: 'work' }])
    expect(merged.phones?.map((field) => field.value)).toEqual(['+44 1', '+44 2'])
    expect(merged.addresses).toEqual([survivor.addresses![0], { value: '2 Street, London', type: 'work' }])
    expect(merged.urls?.map((field) => field.value)).toEqual(['https://ada.test', 'https://engine.test'])
    expect(merged.groups).toEqual(['Friends', 'Work'])
    expect(merged.notes).toBe('Met at the society\n\nPrefers letters')
    expect(merged.nameParts).toEqual(survivor.nameParts)
  })

  it('applies the field choices from the preview, including the matching name parts', () => {
    const merged = buildMergedContact(survivor, other, { name: 'other', company: 'other', notes: 'survivor' })
    expect(merged).toMatchObject({ name: 'Augusta Ada King', company: 'Babbage & Co', notes: 'Met at the society', nameParts: other.nameParts })
  })

  it('keeps provider identity, revision, and raw provider data on the survivor', () => {
    const synced: SyncedContact = { ...survivor, source: undefined, remoteId: 'people/1', accountId: 'g', provider: 'gmail', readOnly: false, revision: 'etag-1', groupIds: ['contactGroups/friends'], providerData: { emailAddresses: [{ value: 'ada@home.test', metadata: { primary: true } }] } }
    const merged = buildMergedContact(synced, { ...other, source: undefined }) as SyncedContact
    expect(merged).toMatchObject({ remoteId: 'people/1', accountId: 'g', provider: 'gmail', revision: 'etag-1', groupIds: ['contactGroups/friends'], providerData: synced.providerData })
    // Favourites are local-only, so a provider survivor does not pick one up.
    expect(merged.favorite).toBe(false)
  })
})

describe('mergeWarnings', () => {
  it('explains provider limits before anything is written', () => {
    const outlook: SyncedContact = { ...survivor, source: undefined, remoteId: 'm1', accountId: 'm', provider: 'microsoft', readOnly: false }
    const extra = { ...other, emails: [{ value: 'a@x.test' }, { value: 'b@x.test' }, { value: 'c@x.test' }], phones: [{ value: '+1 555 0000', type: 'mobile' }] }
    const warnings = mergeWarnings(outlook, { ...extra, remoteId: 'm2', accountId: 'm', provider: 'microsoft', readOnly: false } as SyncedContact, buildMergedContact(outlook, extra))
    expect(warnings.join(' ')).toMatch(/three email addresses.*one mobile number.*photos are not synchronized.*Undo recreates/)
    expect(mergeWarnings(survivor, other, buildMergedContact(survivor, other))).toEqual([])
  })
})

describe('list relinking', () => {
  it('moves list members to the survivor and restores exactly those members', () => {
    const lists: ContactList[] = [
      { id: 'l1', name: 'Club', source: 'local', members: [{ contactId: 'ada-2', email: 'ada@work.test' }, { contactId: 'ada', email: 'ada@home.test' }] },
      { id: 'l2', name: 'Other', source: 'local', members: [{ email: 'x@y.test' }] }
    ]
    const relinked = relinkListMembers(lists, 'ada-2', 'ada')
    expect(relinked.relinked).toEqual([{ listId: 'l1', email: 'ada@work.test' }])
    expect(relinked.lists[0].members.map((member) => member.contactId)).toEqual(['ada', 'ada'])
    expect(relinked.lists[1]).toBe(lists[1])
    const restored = restoreListMembers(relinked.lists, relinked.relinked, 'ada', 'ada-2')
    expect(restored[0].members).toEqual(lists[0].members)
  })

  it('compares contacts independent of key order and undefined fields', () => {
    expect(sameContact({ ...survivor, title: undefined }, JSON.parse(JSON.stringify(survivor)))).toBe(true)
    expect(sameContact(survivor, { ...survivor, name: 'Ada King' })).toBe(false)
  })
})
