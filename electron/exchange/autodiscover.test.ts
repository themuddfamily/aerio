import { afterEach, describe, expect, it } from 'vitest'
import { request as httpRequest } from 'node:http'
import { autodiscover, decodeServerVersion, isTrustedHost, parsePoxResponse, type AutodiscoverHttp, type SrvRecord } from './autodiscover'
import { EwsFixtureServer } from './ews-fixture-server'
import { EwsTransport, type HttpResult } from './ews-transport'

const servers: EwsFixtureServer[] = []
afterEach(async () => { for (const server of servers.splice(0)) await server.stop() })

// Routes every virtual https/http host to the loopback fixture, telling it which host was asked.
function http(server: EwsFixtureServer, srv: SrvRecord[] = []): AutodiscoverHttp & { posted: string[]; got: string[] } {
  const posted: string[] = []
  const got: string[] = []
  const local = (url: string) => { const parsed = new URL(url); return { host: parsed.hostname, url: `${server.origin}${parsed.pathname}` } }
  return {
    posted, got,
    async post(url, xml) {
      posted.push(url)
      const target = local(url)
      const transport = new EwsTransport({ url: target.url, credentials: { auth: 'auto', username: 'CONTOSO\\ada', password: 'Pa55w0rd!' }, returnRedirects: true })
      try { return await transport.post(xml, { 'X-Fixture-Host': target.host }) } finally { transport.close() }
    },
    get(url) {
      got.push(url)
      const target = local(url)
      return new Promise<HttpResult>((resolve, reject) => {
        const request = httpRequest(target.url, { method: 'GET', headers: { 'X-Fixture-Host': target.host } }, (response) => {
          response.resume()
          response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.alloc(0) }))
        })
        request.on('error', reject)
        request.end()
      })
    },
    resolveSrv: async () => srv
  }
}

async function fixture() {
  const server = await new EwsFixtureServer({ auth: 'ntlm' }).start()
  servers.push(server)
  return server
}

describe('POX Autodiscover', () => {
  it('parses settings, prefers the EXCH endpoint, and decodes the server version', () => {
    const result = parsePoxResponse(`<?xml version="1.0"?><Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006"><Response xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a"><User><DisplayName>Ada</DisplayName></User><Account><Action>settings</Action><Protocol><Type>EXPR</Type><EwsUrl>https://ext.contoso.test/EWS/Exchange.asmx</EwsUrl></Protocol><Protocol><Type>EXCH</Type><ServerVersion>738180DA</ServerVersion><EwsUrl>https://int.contoso.test/EWS/Exchange.asmx</EwsUrl></Protocol></Account></Response></Autodiscover>`)
    expect(result).toEqual({ action: 'settings', ewsUrl: 'https://int.contoso.test/EWS/Exchange.asmx', serverVersion: '14.1.218', displayName: 'Ada' })
    expect(decodeServerVersion('nothex')).toBeUndefined()
    expect(isTrustedHost('mail.contoso.test', 'contoso.test', [])).toBe(true)
    expect(isTrustedHost('contoso.test.evil.example', 'contoso.test', [])).toBe(false)
    expect(isTrustedHost('mail.hoster.example', 'contoso.test', ['MAIL.HOSTER.EXAMPLE'])).toBe(true)
  })

  it('finds EWS at https://<domain>/autodiscover with NTLM credentials', async () => {
    const server = await fixture()
    server.autodiscover.set('contoso.test', { ewsUrl: 'https://mail.contoso.test/EWS/Exchange.asmx' })
    const transport = http(server)
    const result = await autodiscover({ email: 'Ada@Contoso.test', password: 'Pa55w0rd!' }, { http: transport })
    expect(result).toMatchObject({ status: 'found', source: 'domain', ewsUrl: 'https://mail.contoso.test/EWS/Exchange.asmx', email: 'ada@contoso.test', displayName: 'Ada Lovelace' })
    expect(transport.posted).toEqual(['https://contoso.test/autodiscover/autodiscover.xml'])
  })

  it('falls back to autodiscover.<domain> and records what failed', async () => {
    const server = await fixture()
    server.autodiscover.set('autodiscover.contoso.test', { serverVersion: '73C28880' })
    const result = await autodiscover({ email: 'ada@contoso.test', password: 'Pa55w0rd!' }, { http: http(server) })
    expect(result).toMatchObject({ status: 'found', source: 'autodiscover-host', ewsUrl: server.url, serverVersion: '15.2.2176' })
    expect(result.attempts).toEqual([{ url: 'https://contoso.test/autodiscover/autodiscover.xml', error: 'HTTP 404' }])
  })

  it('asks before following an HTTP redirect to another domain, then continues once trusted', async () => {
    const server = await fixture()
    server.autodiscover.set('autodiscover.contoso.test', { location: 'https://autodiscover.hoster.example/autodiscover/autodiscover.xml' })
    server.autodiscover.set('autodiscover.hoster.example', { ewsUrl: 'https://ews.hoster.example/EWS/Exchange.asmx' })
    const transport = http(server)
    const first = await autodiscover({ email: 'ada@contoso.test', password: 'Pa55w0rd!' }, { http: transport })
    expect(first).toMatchObject({ status: 'confirm-redirect', reason: 'http-redirect', host: 'autodiscover.hoster.example' })
    // No credentials were sent to the other domain before consent.
    expect(transport.posted.some((url) => url.includes('hoster.example'))).toBe(false)
    expect(transport.got).toEqual(['http://autodiscover.contoso.test/autodiscover/autodiscover.xml'])
    const second = await autodiscover({ email: 'ada@contoso.test', password: 'Pa55w0rd!', trustedHosts: ['autodiscover.hoster.example'] }, { http: transport })
    expect(second).toMatchObject({ status: 'found', source: 'http-redirect', ewsUrl: 'https://ews.hoster.example/EWS/Exchange.asmx' })
  })

  it('uses the _autodiscover._tcp SRV record and asks before trusting a foreign target', async () => {
    const server = await fixture()
    server.autodiscover.set('exch.hoster.example', { ewsUrl: 'https://exch.hoster.example/EWS/Exchange.asmx' })
    const srv = [{ name: 'exch.hoster.example.', port: 443, priority: 10, weight: 5 }]
    expect(await autodiscover({ email: 'ada@contoso.test', password: 'Pa55w0rd!' }, { http: http(server, srv) })).toMatchObject({ status: 'confirm-redirect', reason: 'srv', host: 'exch.hoster.example' })
    expect(await autodiscover({ email: 'ada@contoso.test', password: 'Pa55w0rd!', trustedHosts: ['exch.hoster.example'] }, { http: http(server, srv) })).toMatchObject({ status: 'found', source: 'srv' })
  })

  it('follows redirectAddr within the domain and confirms a redirectUrl to another site', async () => {
    const server = await fixture()
    server.autodiscover.set('contoso.test', { redirectAddr: 'ada.lovelace@contoso.test' })
    const result = await autodiscover({ email: 'ada@contoso.test', password: 'Pa55w0rd!' }, { http: http(server) })
    // The fixture keeps redirecting the new address too, so discovery ends there and moves on.
    expect(result.status).toBe('not-found')
    server.autodiscover.set('contoso.test', { redirectUrl: 'https://other.example/autodiscover/autodiscover.xml' })
    expect(await autodiscover({ email: 'ada@contoso.test', password: 'Pa55w0rd!' }, { http: http(server) })).toMatchObject({ status: 'confirm-redirect', reason: 'redirect-url', host: 'other.example' })
  })

  it('reports not-found with every attempt so the user can enter the EWS URL', async () => {
    const server = await fixture()
    const result = await autodiscover({ email: 'ada@contoso.test', password: 'Pa55w0rd!' }, { http: http(server) })
    expect(result.status).toBe('not-found')
    expect(result.attempts.map((attempt) => attempt.url)).toEqual([
      'https://contoso.test/autodiscover/autodiscover.xml',
      'https://autodiscover.contoso.test/autodiscover/autodiscover.xml',
      'http://autodiscover.contoso.test/autodiscover/autodiscover.xml',
      '_autodiscover._tcp.contoso.test'
    ])
  })
})
