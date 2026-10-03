import { afterEach, describe, expect, it, vi } from 'vitest'
import { GoogleProductivityConnector, mapGoogleContact } from './google-connector'
import { MicrosoftProductivityConnector, mapMicrosoftContact } from './microsoft-connector'
import { ProductivityApiError } from './connector'
import { ProductivityStore } from './store'

const person = { resourceName: 'people/ada', names: [{ displayName: 'Ada' }], metadata: { sources: [{ type: 'CONTACT', id: 'ada', etag: 'old' }] } }
const googleContact = mapGoogleContact('google', person, false)!
const microsoftContact = mapMicrosoftContact('microsoft', { id: 'ada', displayName: 'Ada', changeKey: 'old', parentFolderId: 'default' }, false)!
const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => data })
const error = (status: number) => ({ ok: false, status, headers: new Headers(), json: async () => ({ error: { message: 'Provider rejected the request' } }) })

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('provider productivity reliability', () => {
  it('requires the cached Google revision rather than fetching a newer revision for stale content', async () => {
    const fetchMock = vi.fn(async () => ok({ ...person, metadata: { sources: [{ type: 'CONTACT', id: 'ada', etag: 'new' }] } }))
    vi.stubGlobal('fetch', fetchMock)
    const connector = new GoogleProductivityConnector('google', async () => 'token', true, true)
    await expect(connector.updateContact({ ...googleContact, revision: undefined }, { ...googleContact, name: 'Stale edit' })).rejects.toThrow(/synchronize Contacts/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('passes the original Google revision to the server and does not retry a rejected stale edit', async () => {
    const fetchMock = vi.fn(async () => error(400))
    vi.stubGlobal('fetch', fetchMock)
    await expect(new GoogleProductivityConnector('google', async () => 'token', true, true).updateContact(googleContact, { ...googleContact, name: 'Stale edit' }))
      .rejects.toMatchObject({ status: 400, provider: 'gmail' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body)).metadata.sources[0].etag).toBe('old')
    expect(googleContact.name).toBe('Ada')
  })

  it.each(['update', 'delete'] as const)('blocks a Microsoft contact %s when another client changed the revision', async (operation) => {
    const fetchMock = vi.fn(async () => ok({ id: 'ada', changeKey: 'new' }))
    vi.stubGlobal('fetch', fetchMock)
    const connector = new MicrosoftProductivityConnector('microsoft', async () => 'token', true, true)
    await expect(operation === 'update' ? connector.updateContact(microsoftContact, { ...microsoftContact, name: 'Stale edit' }) : connector.deleteContact(microsoftContact))
      .rejects.toThrow(/changed elsewhere/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects read-only contact writes without making provider requests', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
    const google = new GoogleProductivityConnector('google', async () => 'token', true, true)
    const microsoft = new MicrosoftProductivityConnector('microsoft', async () => 'token', true, true)
    for (const [connector, contact] of [[google, googleContact], [microsoft, microsoftContact]] as const) {
      await expect(connector.updateContact({ ...contact, readOnly: true }, contact)).rejects.toThrow(/enable Contacts editing/)
      await expect(connector.deleteContact({ ...contact, readOnly: true })).rejects.toThrow(/enable Contacts editing/)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([400, 410])('replaces stale Google contacts and their checkpoint after expiry (%s)', async (status) => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = String(input); urls.push(url)
      if (url.includes('calendarList')) return ok({ items: [] })
      if (url.includes('syncToken=')) return error(status)
      return ok({ connections: [{ ...person, resourceName: 'people/new', metadata: { sources: [{ type: 'CONTACT', id: 'new', etag: 'new' }] } }], nextSyncToken: 'fresh' })
    }))
    const connector = new GoogleProductivityConnector('google', async () => 'token', true, true)
    const previous = { calendars: [], events: [], contacts: [googleContact] }
    const result = await connector.sync(previous, { contacts: 'expired' })
    expect(result.contacts.map((contact) => contact.remoteId)).toEqual(['people/new'])
    expect(result.checkpoints).toEqual({ contacts: 'fresh' })
    expect(urls.filter((url) => url.includes('/connections?'))).toHaveLength(2)
    expect(previous.contacts).toEqual([googleContact])
  })

  it.each([404, 410])('replaces stale Microsoft contacts and their checkpoint after expiry (%s)', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = String(input)
      if (url.includes('/me/calendars?')) return ok({ value: [] })
      if (url === 'https://graph.microsoft.com/expired') return error(status)
      return ok({ value: [{ id: 'new', displayName: 'New contact', changeKey: 'new', parentFolderId: 'default' }], '@odata.deltaLink': 'https://graph.microsoft.com/fresh' })
    }))
    const connector = new MicrosoftProductivityConnector('microsoft', async () => 'token', true, true)
    const result = await connector.sync({ calendars: [], events: [], contacts: [microsoftContact] }, { contacts: 'https://graph.microsoft.com/expired' })
    expect(result.contacts.map((contact) => contact.remoteId)).toEqual(['new'])
    expect(result.checkpoints.contacts).toBe('https://graph.microsoft.com/fresh')
  })

  it.each([401, 403])('retains the last good cache and checkpoint when a refresh fails (%s)', async (status) => {
    const store = new ProductivityStore(':memory:')
    try {
      store.replaceAccount('google', 'gmail', { calendars: [], events: [], contacts: [googleContact] }, { contacts: 'old-token' })
      const previous = store.accountData('google')
      const checkpoints = store.checkpoints('google')
      vi.stubGlobal('fetch', vi.fn(async (input: string) => String(input).includes('calendarList') ? ok({ items: [] }) : error(status)))
      store.setSyncing('google')
      const refresh = new GoogleProductivityConnector('google', async () => 'token', true, true).sync(previous, checkpoints)
      await expect(refresh).rejects.toBeInstanceOf(ProductivityApiError)
      store.setError('google', 'Reconnect required')
      expect(store.accountData('google')).toEqual(previous)
      expect(store.checkpoints('google')).toEqual(checkpoints)
      expect(store.snapshot().sync.every((state) => state.phase === 'error')).toBe(true)
    } finally { store.close() }
  })
})
