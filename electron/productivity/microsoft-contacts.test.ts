import { afterEach, describe, expect, it, vi } from 'vitest'
import { MicrosoftProductivityConnector } from './microsoft-connector'
import { mapMicrosoftRichContact, microsoftContactOverflow, microsoftRichContactBody, type GraphRichContact } from './microsoft-contacts'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const graph: GraphRichContact = {
  id: 'grace', changeKey: 'ck-1', displayName: 'Grace Hopper', givenName: 'Grace', surname: 'Hopper', title: 'Rear Admiral', nickName: 'Amazing Grace',
  emailAddresses: [{ address: 'grace@navy.test', name: 'Grace (Navy)' }, { address: 'grace@home.test', name: 'Grace' }],
  mobilePhone: '+1 555', homePhones: ['+1 111'], businessPhones: ['+1 222', '+1 333'],
  homeAddress: { street: '1 Home St', city: 'Arlington', state: 'VA', postalCode: '22201', countryOrRegion: 'USA' }, businessAddress: {},
  birthday: '1906-12-09T11:59:00Z', businessHomePage: 'https://navy.test', categories: ['COBOL', 'Navy'], companyName: 'US Navy'
}

describe('rich Microsoft contact mapping', () => {
  it('reads every Graph slot into typed values and categories', () => {
    expect(mapMicrosoftRichContact('b', graph)).toMatchObject({
      email: 'grace@navy.test', phone: '+1 555', group: 'COBOL', groups: ['COBOL', 'Navy'], revision: 'ck-1',
      emails: [{ value: 'grace@navy.test' }, { value: 'grace@home.test' }],
      phones: [{ value: '+1 555', type: 'mobile' }, { value: '+1 111', type: 'home' }, { value: '+1 222', type: 'work' }, { value: '+1 333', type: 'work' }],
      addresses: [{ value: '1 Home St, Arlington VA 22201, USA', type: 'home', parts: ['', '', '1 Home St', 'Arlington', 'VA', '22201', 'USA'] }],
      urls: [{ value: 'https://navy.test', type: 'work' }], nickname: 'Amazing Grace', birthday: '1906-12-09',
      nameParts: ['Hopper', 'Grace', '', 'Rear Admiral', '']
    })
  })

  it('writes typed values back to Graph slots, keeping email display names', () => {
    const current = mapMicrosoftRichContact('b', graph)!
    const body = microsoftRichContactBody({
      ...current,
      emails: [{ value: 'GRACE@navy.test' }, { value: 'new@navy.test' }],
      phones: [{ value: '+1 999', type: 'cell' }, { value: '+1 111', type: 'home' }, { value: '+1 444', type: 'mobile' }, { value: '+1 000' }],
      addresses: [{ value: '2 Work Rd', type: 'work' }, ...current.addresses!],
      groups: ['Navy', 'Pioneers'], birthday: '--12-09'
    }, current)
    expect(body).toMatchObject({
      givenName: 'Grace', surname: 'Hopper', title: 'Rear Admiral', nickName: 'Amazing Grace',
      emailAddresses: [{ address: 'GRACE@navy.test', name: 'Grace (Navy)' }, { address: 'new@navy.test', name: 'Grace Hopper' }],
      mobilePhone: '+1 999', homePhones: ['+1 111'], businessPhones: ['+1 444', '+1 000'],
      homeAddress: { street: '1 Home St', city: 'Arlington', state: 'VA', postalCode: '22201', countryOrRegion: 'USA' },
      businessAddress: { street: '2 Work Rd' }, otherAddress: {}, categories: ['Navy', 'Pioneers']
    })
    // A year-less birthday cannot be stored by Graph, so the existing value is left alone.
    expect(body).not.toHaveProperty('birthday')
    expect(microsoftRichContactBody({ ...current, birthday: '1906-12-10' }, current).birthday).toBe('1906-12-10T11:59:00Z')
    expect(microsoftRichContactBody({ ...current, birthday: undefined }, current).birthday).toBeNull()
    expect(microsoftRichContactBody({ ...current, groups: [], group: 'Outlook' }, current).categories).toEqual([])
    expect(microsoftContactOverflow({ ...current, emails: [{ value: 'a@x.test' }, { value: 'b@x.test' }, { value: 'c@x.test' }, { value: 'd@x.test' }] })).toMatchObject({ emails: 1 })
  })

  it('keeps change-key conflict checks on rich updates', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url))
      if (String(url).includes('?$select=id,changeKey')) return { ok: true, status: 200, json: async () => ({ id: 'grace', changeKey: 'ck-2' }) }
      return { ok: true, status: 200, json: async () => graph }
    }))
    const connector = new MicrosoftProductivityConnector('b', async () => 'token', false, true)
    const current = mapMicrosoftRichContact('b', graph)!
    await expect(connector.updateContact(current, { ...current, notes: 'Edited' })).rejects.toThrow('changed elsewhere')
    expect(urls).toHaveLength(1)
  })
})
