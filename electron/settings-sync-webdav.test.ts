import { createServer, type Server, type RequestListener } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { settingsSyncUrl, WebDavSettingsRemote } from './settings-sync-webdav'
const servers: Server[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }))) })
async function serve(handler: RequestListener) {
  const server = createServer(handler); servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}
describe('conditional WebDAV settings storage', () => {
  it('uses authentication and conditional creation/update against a real HTTP server', async () => {
    let text: string | undefined, revision = 0
    const observed: string[] = []
    const base = await serve((request, response) => {
      expect(request.headers.authorization).toBe(`Basic ${Buffer.from('user:app-password').toString('base64')}`)
      if (request.method === 'GET') { if (!text) { response.writeHead(404).end(); return } response.writeHead(200, { ETag: `"${revision}"` }).end(text); return }
      observed.push(String(request.headers['if-match'] ?? request.headers['if-none-match']))
      if (text ? request.headers['if-match'] !== `"${revision}"` : request.headers['if-none-match'] !== '*') { response.writeHead(412).end(); return }
      const chunks: Buffer[] = []; request.on('data', (chunk) => chunks.push(chunk)); request.on('end', () => { text = Buffer.concat(chunks).toString(); response.writeHead(201, { ETag: `"${++revision}"` }).end() })
    })
    const remote = new WebDavSettingsRemote(`${base}/settings.json`, 'user', 'app-password')
    expect(await remote.get()).toBeUndefined()
    const first = await remote.put('encrypted-one')
    expect(await remote.get()).toEqual({ text: 'encrypted-one', etag: first })
    await expect(remote.put('blind-overwrite')).rejects.toThrow(/changed/)
    const second = await remote.put('encrypted-two', first)
    await expect(remote.put('stale', first)).rejects.toThrow(/changed/)
    expect((await remote.get())?.etag).toBe(second)
    expect(observed).toEqual(['*', '*', first, first])
  })
  it('rejects redirects, weak ETags, non-local plaintext servers and embedded credentials', async () => {
    let targetCalls = 0
    const target = await serve((_request, response) => { targetCalls++; response.end('unexpected') })
    const redirect = await serve((_request, response) => response.writeHead(302, { Location: target }).end())
    await expect(new WebDavSettingsRemote(redirect, 'user', 'secret').get()).rejects.toThrow()
    expect(targetCalls).toBe(0)
    const weak = await serve((_request, response) => response.writeHead(200, { ETag: 'W/"one"' }).end('{}'))
    await expect(new WebDavSettingsRemote(weak, 'user', 'secret').get()).rejects.toThrow(/strong ETags/)
    expect(() => settingsSyncUrl('http://example.com/file')).toThrow(/https/)
    expect(() => settingsSyncUrl('https://user:secret@example.com/file')).toThrow(/Remove/)
    expect(() => settingsSyncUrl('https://example.com/folder/')).toThrow(/file URL/)
  })
})
