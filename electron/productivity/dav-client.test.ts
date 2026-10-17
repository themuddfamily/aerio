import { describe, expect, it, vi } from 'vitest'
import { DavClient, DavHttpError, DavNetworkError, httpError, resolveHref, sameDavSite } from './dav-client'
import { collectionFromResponse } from './dav-discovery'
import { parseMultistatus } from './dav-xml'

const reply = (status: number, headers: Record<string, string> = {}, body = '') => new Response(body || null, { status, headers })

describe('DAV HTTP client', () => {
  it('sends Basic credentials, Depth, and an XML body', async () => {
    const fetch = vi.fn(async () => reply(207, {}, '<d:multistatus xmlns:d="DAV:"/>'))
    const client = new DavClient({ username: 'ada@example.com', password: 'pässword' }, { fetch })
    await client.multistatus('PROPFIND', 'https://dav.example.com/cal/', '<x/>', '1')
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('ada@example.com:pässword').toString('base64')}`)
    expect(headers.Depth).toBe('1')
    expect(headers['Content-Type']).toMatch(/application\/xml/)
    expect(init.redirect).toBe('manual')
  })

  it('follows redirects within one provider but never to another site or down to http', async () => {
    const fetch = vi.fn(async (url: string) => url.startsWith('https://caldav.icloud.com')
      ? reply(301, { location: 'https://p52-caldav.icloud.com/123/' })
      : reply(207, {}, '<d:multistatus xmlns:d="DAV:"/>'))
    const result = await new DavClient({ username: 'a', password: 'b' }, { fetch }).multistatus('PROPFIND', 'https://caldav.icloud.com/', '<x/>', '0')
    expect(result.url).toBe('https://p52-caldav.icloud.com/123/')

    const evil = new DavClient({ username: 'a', password: 'b' }, { fetch: async () => reply(302, { location: 'https://attacker.example/' }) })
    await expect(evil.request('PROPFIND', 'https://dav.fastmail.com/')).rejects.toThrow(/different site/)
    const downgrade = new DavClient({ username: 'a', password: 'b' }, { fetch: async () => reply(302, { location: 'http://dav.fastmail.com/' }) })
    await expect(downgrade.request('PROPFIND', 'https://dav.fastmail.com/')).rejects.toThrow(/must use https/)
    const loop = new DavClient({ username: 'a', password: 'b' }, { fetch: async () => reply(302, { location: '/again' }) })
    await expect(loop.request('GET', 'https://dav.fastmail.com/')).rejects.toThrow(/too many/)
    expect(sameDavSite('http://127.0.0.1:8000/', 'http://127.0.0.1:9000/')).toBe(false)
  })

  it('never sends credentials to a site outside the account, even when the server points there', async () => {
    const fetch = vi.fn(async () => reply(207, {}, '<d:multistatus xmlns:d="DAV:"/>'))
    const client = new DavClient({ username: 'a', password: 'b' }, { fetch, allowedRoots: ['https://caldav.icloud.com/', 'https://contacts.icloud.com/'] })
    await client.request('PROPFIND', 'https://p52-caldav.icloud.com/123/')
    await expect(client.request('PROPFIND', 'https://attacker.example/principal/')).rejects.toThrow(/different site/)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('refuses plain http outside loopback before sending anything', async () => {
    const fetch = vi.fn()
    await expect(new DavClient({ username: 'a', password: 'b' }, { fetch }).request('GET', 'http://dav.example.com/')).rejects.toThrow(/https/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('retries reads on 429/503 with Retry-After but never retries writes', async () => {
    const sleep = vi.fn(async () => undefined)
    const read = vi.fn().mockResolvedValueOnce(reply(503, { 'retry-after': '2' })).mockResolvedValueOnce(reply(429)).mockResolvedValue(reply(200, {}, 'ok'))
    expect((await new DavClient({ username: 'a', password: 'b' }, { fetch: read, sleep }).request('GET', 'https://dav.example.com/x')).text).toBe('ok')
    expect(sleep.mock.calls).toEqual([[2_000], [2_000]])
    const write = vi.fn(async () => reply(503))
    expect((await new DavClient({ username: 'a', password: 'b' }, { fetch: write, sleep }).request('PUT', 'https://dav.example.com/x', { body: 'x' })).status).toBe(503)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('maps network failures and statuses to typed errors', async () => {
    await expect(new DavClient({ username: 'a', password: 'b' }, { fetch: async () => { throw new TypeError('getaddrinfo ENOTFOUND') } }).request('GET', 'https://dav.example.com/'))
      .rejects.toBeInstanceOf(DavNetworkError)
    await expect(new DavClient({ username: 'a', password: 'b' }, { fetch: async () => reply(401) }).expect('GET', 'https://dav.example.com/')).rejects.toMatchObject({ status: 401 })
    await expect(new DavClient({ username: 'a', password: 'b' }, { fetch: async () => reply(200, {}, 'x') }).multistatus('REPORT', 'https://dav.example.com/', '<x/>', '0'))
      .rejects.toThrow(/without a multistatus/)
    expect(httpError({ status: 412, text: '' })).toBeInstanceOf(DavHttpError)
    expect(httpError({ status: 507, text: '' }).message).toMatch(/storage/)
    await expect(new DavClient({ username: 'a', password: 'b' }, { fetch: async () => reply(200, { 'content-length': '999' }, 'x'), maxBytes: 10 }).request('GET', 'https://dav.example.com/'))
      .rejects.toThrow(/too large/)
  })

  it('normalizes hrefs so differently encoded paths compare equal', () => {
    expect(resolveHref('/cal/ada%40example.com/a%20b.ics', 'https://dav.example.com/x/')).toBe(resolveHref('https://dav.example.com/cal/ada@example.com/a b.ics', 'https://other/'))
  })
})

describe('DAV collection capabilities', () => {
  const collection = (props: string) => collectionFromResponse(parseMultistatus(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ical="http://apple.com/ns/ical/">
    <d:response><d:href>/calendars/ada/work%20items/</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`).responses[0], 'https://dav.example.com/')

  it('derives read-only, shared, subscribed, components, and sync support', () => {
    expect(collection('<d:resourcetype><d:collection/></d:resourcetype>')).toBeUndefined()
    expect(collection('<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>')).toMatchObject({
      name: 'work items', readOnly: false, shared: false, components: ['VEVENT', 'VTODO', 'VJOURNAL'], supportsSyncCollection: false
    })
    expect(collection(`<d:resourcetype><c:calendar/><cs:shared/></d:resourcetype><d:current-user-privilege-set><d:privilege><d:read/></d:privilege></d:current-user-privilege-set>
      <c:supported-calendar-component-set><c:comp name="vevent"/></c:supported-calendar-component-set><ical:calendar-color>#FF2968FF</ical:calendar-color>
      <d:supported-report-set><d:supported-report><d:report><d:sync-collection/></d:report></d:supported-report></d:supported-report-set>`))
      .toMatchObject({ readOnly: true, shared: true, components: ['VEVENT'], color: '#FF2968', supportsSyncCollection: true })
    expect(collection('<d:resourcetype><c:calendar/><cs:subscribed/></d:resourcetype>')!.readOnly).toBe(true)
    expect(collection('<d:resourcetype><c:calendar/></d:resourcetype><d:current-user-privilege-set><d:privilege><d:all/></d:privilege></d:current-user-privilege-set><ical:calendar-color>red</ical:calendar-color>'))
      .not.toHaveProperty('color')
  })
})
