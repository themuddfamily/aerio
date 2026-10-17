import { describe, expect, it } from 'vitest'
import type { Contact, ContactList } from '../types'
import type { SyncedContact, SyncedContactGroup } from '../productivity-types'
import { buildRecipientLists, categoryMembershipEdits, describeExpansion, expandRecipientLists, listContactIds, recipientListPreview, splitRecipients, suggestRecipientLists } from './distribution-lists'

const local = (id: string, name: string, email: string, extra: Partial<Contact> = {}): Contact => ({ id, name, email, group: 'Personal', favorite: false, color: '#000', source: 'local', ...extra })
const synced = (id: string, provider: 'gmail' | 'microsoft', name: string, email: string, extra: Partial<SyncedContact> = {}): SyncedContact => ({
  id, remoteId: `people/${id}`, accountId: provider === 'gmail' ? 'g' : 'm', provider, readOnly: false, name, email, group: 'Google', favorite: false, color: '#000', ...extra
})

const contacts: Contact[] = [
  local('ada', 'Ada Lovelace', 'ada@new.test'),
  local('grace', 'Grace Hopper', ''),
  synced('alan', 'gmail', 'Alan Turing', 'alan@example.test', { groupIds: ['contactGroups/team', 'contactGroups/friends'] }),
  synced('kat', 'gmail', 'Katherine Johnson', '', { groupIds: ['contactGroups/team'] }),
  synced('linus', 'microsoft', 'Linus', 'linus@example.test', { groups: ['Board', 'Kernel'], readOnly: true }),
  synced('margaret', 'microsoft', 'Margaret Hamilton', 'mh@example.test', { groups: ['board'] })
]
const lists: ContactList[] = [{ id: 'list-1', name: 'Book club', source: 'local', members: [
  { contactId: 'ada', email: 'ada@old.test', name: 'Ada' }, { email: 'guest@example.test' }, { contactId: 'deleted', email: 'gone@example.test', name: 'Gone' }, { email: 'GUEST@example.test' }
] }]
const groups: SyncedContactGroup[] = [
  { id: 'g:team', remoteId: 'contactGroups/team', accountId: 'g', provider: 'gmail', name: 'Team', system: false, readOnly: false },
  { id: 'g:friends', remoteId: 'contactGroups/friends', accountId: 'g', provider: 'gmail', name: 'Friends', system: true, readOnly: false }
]

describe('distribution lists', () => {
  const built = buildRecipientLists({ contacts, lists, groups })
  const byName = (name: string) => built.find((list) => list.name === name)!

  it('resolves local lists, Google groups, and Outlook categories to member addresses', () => {
    expect(built.map((list) => [list.name, list.kind])).toEqual([['Board', 'category'], ['Book club', 'list'], ['Friends', 'group'], ['Kernel', 'category'], ['Team', 'group']])
    expect(byName('Book club').members).toEqual([
      { email: 'ada@new.test', name: 'Ada Lovelace', contactId: 'ada' },
      { email: 'guest@example.test' },
      { email: 'gone@example.test', name: 'Gone', contactId: 'deleted' }
    ])
    expect(byName('Team')).toMatchObject({ members: [{ email: 'alan@example.test' }], unreachable: 1, manageable: true, readOnly: false })
    expect(byName('Friends')).toMatchObject({ manageable: false, readOnly: false })
    expect(byName('Board')).toMatchObject({ members: [{ email: 'linus@example.test' }, { email: 'mh@example.test' }], readOnly: false, manageable: false })
    expect(byName('Kernel').readOnly).toBe(true)
    expect([...listContactIds(byName('Book club'), contacts)]).toEqual(['ada'])
    expect(recipientListPreview(byName('Book club'), 2)).toBe('Ada Lovelace, guest@example.test +1 more')
  })

  it('suggests lists by name and expands a picked list in place of the typed fragment', () => {
    expect(suggestRecipientLists('bo', built).map((list) => list.name)).toEqual(['Board', 'Book club'])
    expect(suggestRecipientLists('', built)).toEqual([])
    const picked = expandRecipientLists('alan@example.test, Boo', built, byName('Book club'))
    expect(picked.value).toBe('alan@example.test, Ada Lovelace <ada@new.test>, guest@example.test, Gone <gone@example.test>, ')
    expect(describeExpansion(picked)).toBe('Book club: 3 recipients added')
  })

  it('expands typed list names, skipping addresses already in the field', () => {
    const typed = expandRecipientLists('"Team"; alan@example.test, Board', built)
    expect(typed.value).toBe('Alan Turing <alan@example.test>, Linus <linus@example.test>, Margaret Hamilton <mh@example.test>, ')
    expect(describeExpansion(typed)).toBe('Team: 1 recipient added (1 without email); Board: 2 recipients added')
    expect(expandRecipientLists('team@example.test, Someone', built)).toEqual({ value: 'team@example.test, Someone', expanded: [] })
    expect(splitRecipients('"Doe, Jane" <jane@x.test>; b@x.test,')).toEqual(['"Doe, Jane" <jane@x.test>', 'b@x.test'])
  })

  it('plans Outlook category membership as contact category edits', () => {
    const outlook = contacts.filter((contact) => 'provider' in contact && contact.provider === 'microsoft')
    expect(categoryMembershipEdits(outlook, 'Board', { remove: ['linus'] })).toEqual([expect.objectContaining({ id: 'linus', groups: ['Kernel'], group: 'Kernel' })])
    expect(categoryMembershipEdits(outlook, 'Board', { rename: 'Directors' }).map((contact) => contact.groups)).toEqual([['Directors', 'Kernel'], ['Directors']])
    expect(categoryMembershipEdits([synced('new', 'microsoft', 'New', 'n@x.test', { group: 'Outlook' })], 'Board', { add: ['new'] })).toEqual([expect.objectContaining({ groups: ['Board'], group: 'Board' })])
    expect(categoryMembershipEdits(outlook, 'Board', { add: ['linus'] })).toEqual([])
  })
})
