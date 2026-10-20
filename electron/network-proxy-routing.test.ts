import { createServer, get as httpGet, type Server as HttpServer } from 'node:http'
import { createServer as createHttpsServer, get as httpsGet, Agent as HttpsAgent } from 'node:https'
import { connect, type AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { getCACertificates, setDefaultCACertificates } from 'node:tls'
import { createRequire } from 'node:module'
import { generate } from 'selfsigned'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { installNodeProxy, proxyBypassed, proxyEnvironment } from './network-proxy-runtime'
import { openProxyTunnel } from './network-proxy-tunnel'
import { ImapSmtpClient } from './mail/imap-client'
import { Pop3Session } from './mail/pop3-client'
import { FakePop3Server } from './mail/pop3-test-server'

const require = createRequire(import.meta.url)
const hoodiecrow = require('hoodiecrow-imap')
const { SMTPServer } = require('smtp-server')
const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
let certificate: { key: string; cert: string }
beforeAll(async () => {
  const generated = await generate([{ name: 'commonName', value: 'target.test' }], { keySize: 2048, algorithm: 'sha256', extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'target.test' }] }] })
  certificate = { key: generated.private, cert: generated.cert }
})
async function listen(server: HttpServer) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }))
  return (server.address() as AddressInfo).port
}
async function proxy() {
  const seen: { method: string; url: string; authorization?: string }[] = []
  const sockets = new Set<Duplex>()
  const authorized = (headers: Record<string, unknown>) => headers['proxy-authorization'] === `Basic ${Buffer.from('user:p@ss:word').toString('base64')}`
  const server = createServer((request, response) => {
    seen.push({ method: request.method!, url: request.url!, authorization: request.headers['proxy-authorization'] })
    if (!authorized(request.headers)) { response.writeHead(407); response.end(); return }
    response.end('proxied over HTTP')
  })
  server.on('connect', (request, socket, head) => {
    seen.push({ method: 'CONNECT', url: request.url!, authorization: request.headers['proxy-authorization'] })
    sockets.add(socket)
    if (!authorized(request.headers)) { socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return }
    const port = Number(request.url!.split(':').at(-1))
    const upstream = connect(port, '127.0.0.1', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket) })
    sockets.add(upstream)
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })
  const port = await listen(server)
  cleanup.push(() => { for (const socket of sockets) socket.destroy() })
  return { seen, server: `http://127.0.0.1:${port}` }
}
const getBody = (url: string, agent?: HttpsAgent) => new Promise<string>((resolve, reject) => {
  const request = (url.startsWith('https:') ? httpsGet : httpGet)(url, agent ? { agent } : {}, (response) => {
    const chunks: Buffer[] = []; response.on('data', (chunk) => chunks.push(chunk)); response.on('end', () => resolve(Buffer.concat(chunks).toString()))
  }); request.on('error', reject)
})

describe('real authenticated proxy routing', () => {
  it('routes Node fetch and default HTTP requests with auth without changing environment variables', async () => {
    const fixture = await proxy()
    const envBefore = { HTTP_PROXY: process.env.HTTP_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY }
    cleanup.push(installNodeProxy({ mode: 'manual', server: fixture.server, bypass: '', credentials: { username: 'user', password: 'p@ss:word' } }))
    expect(await (await fetch('http://target.test/fetch')).text()).toBe('proxied over HTTP')
    expect(await getBody('http://target.test/http')).toBe('proxied over HTTP')
    expect(fixture.seen.map((entry) => entry.url)).toEqual(['http://target.test/fetch', 'http://target.test/http'])
    expect({ HTTP_PROXY: process.env.HTTP_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY }).toEqual(envBefore)
  })

  it('uses verified HTTPS CONNECT for fetch and custom agents, and keeps proxy auth away from origins', async () => {
    const cas = getCACertificates('default')
    setDefaultCACertificates([...cas, certificate.cert])
    cleanup.push(() => setDefaultCACertificates(cas))
    const originHeaders: unknown[] = []
    const origin = createHttpsServer(certificate, (request, response) => { originHeaders.push(request.headers['proxy-authorization']); response.end('secure origin') })
    const port = await listen(origin)
    const fixture = await proxy()
    cleanup.push(installNodeProxy({ mode: 'manual', server: fixture.server, bypass: '', credentials: { username: 'user', password: 'p@ss:word' } }))
    expect(await (await fetch(`https://target.test:${port}/fetch`)).text()).toBe('secure origin')
    const custom = new HttpsAgent({ proxyEnv: proxyEnvironment(), ca: certificate.cert })
    cleanup.push(() => custom.destroy())
    expect(await getBody(`https://target.test:${port}/custom-agent`, custom)).toBe('secure origin')
    expect(fixture.seen.every((entry) => entry.method === 'CONNECT')).toBe(true)
    expect(originHeaders).toEqual([undefined, undefined])
  })

  it('routes real IMAP and SMTP verification through authenticated CONNECT', async () => {
    const cas = getCACertificates('default')
    setDefaultCACertificates([...cas, certificate.cert])
    cleanup.push(() => setDefaultCACertificates(cas))
    const imap = hoodiecrow({ plugins: ['STARTTLS', 'LOGINDISABLED', 'ID', 'NAMESPACE'], credentials: certificate, users: { user: { password: 'mail-pass' } }, storage: { INBOX: { messages: [] } } })
    await new Promise<void>((resolve) => imap.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>((resolve) => imap.close(resolve)))
    const smtp = new SMTPServer({ ...certificate, authOptional: false, logger: false, onAuth: (_auth: unknown, _session: unknown, callback: (error: null, user: { user: string }) => void) => callback(null, { user: 'user' }) })
    await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>((resolve) => smtp.close(resolve)))
    const fixture = await proxy()
    cleanup.push(installNodeProxy({ mode: 'manual', server: fixture.server, bypass: '', credentials: { username: 'user', password: 'p@ss:word' } }))
    const client = new ImapSmtpClient({ provider: 'imap', email: 'me@test', username: 'user', password: 'mail-pass', imapHost: 'target.test', imapPort: imap.server.address().port, imapSecurity: 'starttls', smtpHost: 'target.test', smtpPort: smtp.server.address().port, smtpSecurity: 'starttls' })
    await client.verify()
    expect(fixture.seen.filter((entry) => entry.method === 'CONNECT')).toHaveLength(2)
  }, 15_000)

  it('routes POP3 through CONNECT, fails on rejected auth, and bypasses only specified hosts', async () => {
    const pop = new FakePop3Server({ mode: 'plain', stls: false, users: { user: 'mail-pass' }, messages: [] })
    await pop.start()
    cleanup.push(() => pop.close())
    const fixture = await proxy()
    const restore = installNodeProxy({ mode: 'manual', server: fixture.server, bypass: '*.internal.test', credentials: { username: 'user', password: 'p@ss:word' } })
    cleanup.push(restore)
    const session = await Pop3Session.open({ host: 'target.test', port: pop.port, security: 'none', allowPlaintext: true, username: 'user', password: 'mail-pass', timeoutMs: 2000 })
    await session.quit()
    expect(proxyBypassed('server.internal.test')).toBe(true)
    expect(proxyBypassed('evilinternal.test')).toBe(false)
    expect(proxyBypassed('127.0.0.2')).toBe(true)
    expect(await openProxyTunnel('localhost', pop.port, 1000)).toBeUndefined()
    const wrong = installNodeProxy({ mode: 'manual', server: fixture.server, bypass: '', credentials: { username: 'wrong', password: 'wrong' } })
    try { await expect(openProxyTunnel('target.test', pop.port, 2000)).rejects.toThrow('407') } finally { wrong() }
  }, 10_000)
})
