import { describe, expect, it, vi } from 'vitest'
import { fetchRemoteImage, type RemoteImageFetchDependencies } from './remote-image-fetch'

const image = () => new Response(Uint8Array.from([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } })
const redirect = (location?: string, status = 302) => new Response(null, { status, headers: location ? { location } : {} })

function dependencies(responses: Response[], privateHosts: string[] = []) {
  const fetch = vi.fn<RemoteImageFetchDependencies['fetch']>(async () => responses.shift() ?? image())
  const lookup = vi.fn<RemoteImageFetchDependencies['lookup']>(async (hostname) => [{ address: privateHosts.includes(hostname) ? '10.0.0.1' : '93.184.216.34' }])
  return { fetch, lookup, isPrivateAddress: (address: string) => address.startsWith('10.') }
}

describe('fetchRemoteImage', () => {
  it('fetches an approved image without cookies and with manual redirects', async () => {
    const deps = dependencies([image()])
    const response = await fetchRemoteImage('https://images.example/hero.png', deps)
    expect(response.status).toBe(200)
    expect(deps.fetch).toHaveBeenCalledWith('https://images.example/hero.png', expect.objectContaining({ credentials: 'omit', redirect: 'manual' }))
  })

  it('follows safe redirects, resolving relative locations and re-validating each hop', async () => {
    const deps = dependencies([redirect('/cdn/hero.png', 301), redirect('https://cdn.example/hero.png', 307), image()])
    const response = await fetchRemoteImage('https://images.example/hero.png', deps)
    expect(response.status).toBe(200)
    expect(deps.fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://images.example/hero.png',
      'https://images.example/cdn/hero.png',
      'https://cdn.example/hero.png'
    ])
    expect(deps.lookup).toHaveBeenCalledWith('cdn.example')
  })

  it('refuses redirects to private networks, trackers, and other schemes before connecting', async () => {
    for (const [location, privateHosts] of [
      ['https://intranet.example/hero.png', ['intranet.example']],
      ['http://localhost/hero.png', []],
      ['https://u1.ct.sendgrid.net/wf/open?upn=x', []],
      ['https://news.example/email/open.gif', []],
      ['file:///etc/passwd', []],
      ['https://user:pass@cdn.example/hero.png', []]
    ] as const) {
      const deps = dependencies([redirect(location)], [...privateHosts])
      expect((await fetchRemoteImage('https://images.example/hero.png', deps)).status).toBe(403)
      expect(deps.fetch).toHaveBeenCalledTimes(1)
    }
  })

  it('blocks opaque, location-less, and excessive redirects', async () => {
    const opaque = redirect('https://cdn.example/a.png')
    Object.defineProperty(opaque, 'type', { value: 'opaqueredirect' })
    expect((await fetchRemoteImage('https://images.example/a.png', dependencies([opaque]))).status).toBe(403)
    expect((await fetchRemoteImage('https://images.example/a.png', dependencies([redirect()]))).status).toBe(403)
    const loop = dependencies(Array.from({ length: 10 }, (_, index) => redirect(`https://cdn.example/${index}.png`)))
    expect((await fetchRemoteImage('https://images.example/a.png', loop)).status).toBe(403)
    expect(loop.fetch).toHaveBeenCalledTimes(6)
  })

  it('passes through errors and not-modified responses unchanged', async () => {
    expect((await fetchRemoteImage('https://images.example/a.png', dependencies([new Response('', { status: 404 })]))).status).toBe(404)
    expect((await fetchRemoteImage('https://images.example/a.png', dependencies([new Response(null, { status: 304 })]))).status).toBe(304)
  })

  it('refuses hosts with no DNS answers', async () => {
    const deps = dependencies([])
    deps.lookup.mockResolvedValueOnce([])
    expect((await fetchRemoteImage('https://images.example/a.png', deps)).status).toBe(403)
    expect(deps.fetch).not.toHaveBeenCalled()
  })
})
