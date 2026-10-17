import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SyncedContactGroup } from '../../src/productivity-types'
import { GoogleProductivityConnector } from './google-connector'
import { attachGooglePhotos, googleRichContactBody, mapGoogleContactGroup, mapGoogleRichContact, type GoogleRichPerson } from './google-contacts'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const person: GoogleRichPerson = {
  resourceName: 'people/ada',
  metadata: { sources: [{ type: 'CONTACT', id: 'ada', etag: 'etag-1' }] },
  names: [{ displayName: 'Ada Lovelace', givenName: 'Ada', familyName: 'Lovelace', phoneticGivenName: 'AY-da' }],
  nicknames: [{ value: 'Enchantress' }],
  emailAddresses: [
    { value: 'ada@home.test', type: 'home', formattedType: 'Home', displayName: 'Ada', metadata: { primary: false } },
    { value: 'ada@work.test', type: 'work', metadata: { primary: true } }
  ],
  phoneNumbers: [{ value: '+44 1', type: 'mobile', canonicalForm: '+441' }, { value: '+44 2', type: 'workFax' }],
  addresses: [{ formattedValue: '12 St James Sq\nLondon', type: 'home', streetAddress: '12 St James Sq', city: 'London', country: 'UK', countryCode: 'GB' }],
  birthdays: [{ date: { year: 1815, month: 12, day: 10 }, metadata: { primary: true } }],
  urls: [{ value: 'https://ada.example.test', type: 'blog' }],
  photos: [{ url: 'https://lh3.googleusercontent.com/default', default: true }, { url: 'https://lh3.googleusercontent.com/ada=s100' }],
  organizations: [{ name: 'Analytical', title: 'Programmer', department: 'Engines' }, { name: 'Royal Society' }],
  biographies: [{ value: 'First programmer', contentType: 'TEXT_PLAIN' }],
  memberships: [
    { contactGroupMembership: { contactGroupResourceName: 'contactGroups/myContacts' } },
    { contactGroupMembership: { contactGroupResourceName: 'contactGroups/abc' } },
    { contactGroupMembership: { contactGroupResourceName: 'contactGroups/starred' } }
  ]
}

const groupNames = new Map([['contactGroups/abc', 'Mathematicians']])

describe('rich Google contact mapping', () => {
  it('reads every typed value, memberships, birthday, and keeps raw provider entries', () => {
    const contact = mapGoogleRichContact('a', person, false, groupNames)!
    expect(contact).toMatchObject({
      email: 'ada@work.test', phone: '+44 1', group: 'Mathematicians', groups: ['Mathematicians'], favorite: true,
      groupIds: ['contactGroups/myContacts', 'contactGroups/abc', 'contactGroups/starred'],
      emails: [{ value: 'ada@home.test', type: 'home' }, { value: 'ada@work.test', type: 'work', preferred: true }],
      phones: [{ value: '+44 1', type: 'mobile' }, { value: '+44 2', type: 'workfax' }],
      addresses: [{ value: '12 St James Sq, London', type: 'home', parts: ['', '', '12 St James Sq', 'London', '', '', 'UK'] }],
      urls: [{ value: 'https://ada.example.test', type: 'blog' }],
      nameParts: ['Lovelace', 'Ada', '', '', ''], nickname: 'Enchantress', birthday: '1815-12-10', revision: 'etag-1'
    })
    expect(contact.providerData).toMatchObject({ photoUrl: 'https://lh3.googleusercontent.com/ada=s100', organizations: person.organizations })
    expect(mapGoogleRichContact('a', { resourceName: 'people/x', names: [{ displayName: 'X' }], birthdays: [{ date: { month: 2, day: 3 } }] })).toMatchObject({ birthday: '--02-03', group: 'Google' })
    expect(mapGoogleRichContact('a', { resourceName: 'people/y' })).toBeUndefined()
  })

  it('merges edits into the raw entries so unmodelled provider details survive', () => {
    const current = mapGoogleRichContact('a', person, false, groupNames)!
    const body = googleRichContactBody({
      ...current,
      emails: [{ value: 'ada@work.test', type: 'work' }, { value: 'ada@new.test', type: 'other' }],
      phones: [{ value: '+44 1', type: 'mobile' }],
      addresses: [...current.addresses!, { value: '1 New Road', type: 'work' }],
      birthday: '--12-10', company: 'Analytical Engines', notes: 'Edited'
    }, current)
    expect(body.metadata).toEqual({ sources: [{ type: 'CONTACT', id: 'ada', etag: 'etag-1' }] })
    // An unchanged name is sent back as stored, including phonetic fields Aerio does not edit.
    expect(body.names).toEqual([{ givenName: 'Ada', familyName: 'Lovelace', phoneticGivenName: 'AY-da' }])
    expect(body.emailAddresses).toEqual([{ value: 'ada@work.test', type: 'work' }, { value: 'ada@new.test', type: 'other' }])
    expect(body.phoneNumbers).toEqual([{ value: '+44 1', type: 'mobile' }])
    expect(body.addresses[0]).toMatchObject({ streetAddress: '12 St James Sq', city: 'London', country: 'UK', countryCode: 'GB', type: 'home' })
    expect(body.addresses[1]).toEqual({ formattedValue: '1 New Road', type: 'work' })
    expect(body.birthdays).toEqual([{ date: { month: 12, day: 10 } }])
    expect(body.organizations).toEqual([{ name: 'Analytical Engines', title: 'Programmer', department: 'Engines' }, { name: 'Royal Society' }])
    expect(body.biographies).toEqual([{ contentType: 'TEXT_PLAIN', value: 'Edited' }])
    expect(body.nicknames).toEqual([{ value: 'Enchantress' }])
    const renamed = googleRichContactBody({ ...current, name: 'Augusta Ada King', birthday: '1815-12-10' }, current)
    expect(renamed.names).toEqual([{ givenName: 'Augusta Ada', familyName: 'King' }])
    expect(renamed.birthdays).toEqual([{ date: { year: 1815, month: 12, day: 10 } }])
    expect(googleRichContactBody({ ...current, birthday: 'Christmas' }).birthdays).toEqual([{ text: 'Christmas' }])
  })

  it('maps contact groups, hiding bookkeeping system groups', () => {
    expect(mapGoogleContactGroup('a', { resourceName: 'contactGroups/abc', name: 'Maths', formattedName: 'Maths', groupType: 'USER_CONTACT_GROUP', etag: 'g1', memberCount: 2 }, true))
      .toEqual({ id: 'a:google-group:contactGroups/abc', remoteId: 'contactGroups/abc', accountId: 'a', provider: 'gmail', name: 'Maths', system: false, readOnly: false, revision: 'g1', memberCount: 2 })
    expect(mapGoogleContactGroup('a', { resourceName: 'contactGroups/family', formattedName: 'Family', groupType: 'SYSTEM_CONTACT_GROUP' }, false)).toMatchObject({ system: true, readOnly: true })
    expect(mapGoogleContactGroup('a', { resourceName: 'contactGroups/myContacts', formattedName: 'My Contacts', groupType: 'SYSTEM_CONTACT_GROUP' }, true)).toBeUndefined()
    expect(mapGoogleContactGroup('a', { resourceName: 'contactGroups/x', name: 'Gone', metadata: { deleted: true } }, true)).toBeUndefined()
  })

  it('caches Google photo thumbnails as bounded data URLs', async () => {
    const contact = mapGoogleRichContact('a', person, false, groupNames)!
    const fetcher = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } }))
    const [withPhoto] = await attachGooglePhotos([{ ...contact }], [], fetcher as unknown as typeof fetch)
    expect(fetcher).toHaveBeenCalledWith('https://lh3.googleusercontent.com/ada=s128')
    expect(withPhoto.photo).toBe('data:image/jpeg;base64,AQID')
    const [cached] = await attachGooglePhotos([{ ...contact }], [withPhoto], fetcher as unknown as typeof fetch)
    expect(cached.photo).toBe(withPhoto.photo)
    expect(fetcher).toHaveBeenCalledTimes(1)
    const rejected = vi.fn(async () => new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }))
    expect((await attachGooglePhotos([{ ...contact }], [], rejected as unknown as typeof fetch))[0].photo).toBeUndefined()
    const foreign = { ...contact, providerData: { photoUrl: 'https://attacker.test/x.png' } }
    expect((await attachGooglePhotos([foreign], [], fetcher as unknown as typeof fetch))[0].photo).toBeUndefined()
  })
})

describe('Google contact groups and conflicts', () => {
  const json = (body: unknown, status = 200) => ({ ok: status < 400, status, headers: new Headers(), json: async () => body })

  it('creates, renames, deletes groups and modifies members, re-reading members afterwards', async () => {
    const calls: [string, string | undefined, unknown][] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push([String(url).split('?')[0], init.method, init.body ? JSON.parse(String(init.body)) : undefined])
      if (String(url).includes('members:modify')) return json({ notFoundResourceNames: ['people/missing'] })
      if (String(url).includes('people:batchGet')) return json({ responses: [{ person: { ...person, metadata: { sources: [{ type: 'CONTACT', id: 'ada', etag: 'etag-2' }] } } }] })
      if (init.method === 'DELETE') return { ok: true, status: 204, headers: new Headers(), json: async () => undefined }
      return json({ resourceName: 'contactGroups/abc', etag: 'g2', name: init.method === 'PUT' ? 'Analysts' : 'Mathematicians', groupType: 'USER_CONTACT_GROUP' })
    }))
    const connector = new GoogleProductivityConnector('a', async () => 'token', false, true)
    const created = await connector.createContactGroup(' Mathematicians ')
    expect(created).toMatchObject({ name: 'Mathematicians', revision: 'g2', readOnly: false })
    const renamed = await connector.renameContactGroup(created, 'Analysts')
    expect(renamed.name).toBe('Analysts')
    const ada = mapGoogleRichContact('a', person, false)!
    const result = await connector.modifyContactGroupMembers(renamed, [ada], [])
    expect(result.skipped).toBe(1)
    expect(result.contacts[0]).toMatchObject({ revision: 'etag-2', groups: ['Analysts'] })
    await connector.deleteContactGroup(renamed)
    // The refreshed member has a photo, which is fetched as a thumbnail.
    expect(calls.filter(([url]) => url.includes('people.googleapis')).map(([url, method]) => [url, method])).toEqual([
      ['https://people.googleapis.com/v1/contactGroups', 'POST'],
      ['https://people.googleapis.com/v1/contactGroups/abc', 'PUT'],
      ['https://people.googleapis.com/v1/contactGroups/abc/members:modify', 'POST'],
      ['https://people.googleapis.com/v1/people:batchGet', undefined],
      ['https://people.googleapis.com/v1/contactGroups/abc', 'DELETE']
    ])
    expect(calls[1][2]).toMatchObject({ contactGroup: { name: 'Analysts', etag: 'g2' }, updateGroupFields: 'name' })
    expect(calls[2][2]).toEqual({ resourceNamesToAdd: ['people/ada'], resourceNamesToRemove: [] })
  })

  it('refuses protected or read-only groups and reports stale etags as edit conflicts', async () => {
    const system: SyncedContactGroup = { id: 'a:g', remoteId: 'contactGroups/family', accountId: 'a', provider: 'gmail', name: 'Family', system: true, readOnly: false }
    const connector = new GoogleProductivityConnector('a', async () => 'token', false, true)
    await expect(connector.renameContactGroup(system, 'Kin')).rejects.toThrow('system groups cannot be renamed')
    await expect(connector.deleteContactGroup(system)).rejects.toThrow('system groups')
    await expect(new GoogleProductivityConnector('a', async () => 'token').modifyContactGroupMembers({ ...system, readOnly: true }, [], [])).rejects.toThrow('Reconnect')
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { message: 'Request person.etag is different than the current person.etag. Clear local cache and get the latest person.' } }, 400)))
    const current = mapGoogleRichContact('a', person, false)!
    await expect(connector.updateContact(current, { ...current, notes: 'Edited' })).rejects.toThrow('This Google contact changed elsewhere')
  })

  it('synchronizes group names onto contacts and photos onto the cached snapshot', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('calendarList')) return json({ items: [] })
      if (String(url).includes('/contactGroups')) return json({ contactGroups: [{ resourceName: 'contactGroups/abc', name: 'Mathematicians', groupType: 'USER_CONTACT_GROUP' }] })
      if (String(url).includes('googleusercontent')) return new Response(new Uint8Array([9]), { headers: { 'content-type': 'image/png' } })
      return json({ connections: [person], nextSyncToken: 'sync' })
    }))
    const data = await new GoogleProductivityConnector('a', async () => 'token', false, true).sync()
    expect(data.contactGroups).toEqual([expect.objectContaining({ name: 'Mathematicians' })])
    expect(data.contacts[0]).toMatchObject({ groups: ['Mathematicians'], photo: 'data:image/png;base64,CQ==', readOnly: false })
  })
})
