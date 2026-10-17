import { afterEach, describe, expect, it } from 'vitest'
import { EwsClient, EwsError, assertSupportedServer, formatServerVersion } from './ews-client'
import { EwsFixtureServer } from './ews-fixture-server'
import { assertSecureEndpoint, chooseAuthMethod, EwsAuthError, EwsTransport, EwsUnsupportedError, offeredSchemes } from './ews-transport'

const servers: EwsFixtureServer[] = []
const clients: EwsClient[] = []
async function fixture(options: ConstructorParameters<typeof EwsFixtureServer>[0] = {}) {
  const server = await new EwsFixtureServer(options).start()
  servers.push(server)
  return server
}
function client(server: EwsFixtureServer, credentials: ConstructorParameters<typeof EwsClient>[0]['credentials']) {
  const value = new EwsClient({ url: server.url, credentials, sleep: async () => undefined })
  clients.push(value)
  return value
}

afterEach(async () => {
  for (const value of clients.splice(0)) value.close()
  for (const server of servers.splice(0)) await server.stop()
})

describe('EWS transport and authentication', () => {
  it('refuses plain HTTP to non-loopback hosts and URLs with embedded credentials', () => {
    expect(() => assertSecureEndpoint('http://mail.contoso.test/EWS/Exchange.asmx')).toThrow(EwsUnsupportedError)
    expect(() => assertSecureEndpoint('http://mail.contoso.test/EWS/Exchange.asmx')).toThrow(/plain HTTP is not supported/)
    expect(() => assertSecureEndpoint('https://ada:secret@mail.contoso.test/EWS/Exchange.asmx')).toThrow(/user name or password/)
    expect(assertSecureEndpoint('http://127.0.0.1:8080/EWS/Exchange.asmx').hostname).toBe('127.0.0.1')
    expect(() => new EwsTransport({ url: 'http://exchange.example.org/EWS/Exchange.asmx', credentials: { auth: 'basic', username: 'a', password: 'b' } })).toThrow(EwsUnsupportedError)
  })

  it('reads offered schemes and reports unsupported combinations explicitly', () => {
    expect(offeredSchemes({ 'www-authenticate': 'Negotiate, NTLM, Basic realm="x", charset="UTF-8"' })).toEqual(['negotiate', 'ntlm', 'basic'])
    expect(chooseAuthMethod(['negotiate', 'ntlm', 'basic'], false, true)).toBe('ntlm')
    expect(chooseAuthMethod(['basic'], false, true)).toBe('basic')
    expect(chooseAuthMethod(['bearer', 'ntlm'], true, true)).toBe('bearer')
    expect(() => chooseAuthMethod(['kerberos'], false, true)).toThrow(/only Kerberos/)
    expect(() => chooseAuthMethod(['bearer'], false, true)).toThrow(/only OAuth/)
  })

  it('authenticates with NTLMv2 once per connection and reuses it', async () => {
    const server = await fixture({ auth: 'ntlm' })
    const ews = client(server, { auth: 'ntlm', username: 'CONTOSO\\ada', password: 'Pa55w0rd!' })
    await ews.probe()
    await ews.getFolders([{ id: 'drafts' }])
    await ews.getFolders([{ id: 'sentitems' }])
    // Three operations, but only one handshake on the kept-alive connection.
    expect(server.log.filter((entry) => /^NTLM /.test(String(entry.headers.authorization)))).toHaveLength(1)
    expect(server.operations()).toEqual(['GetFolder', 'GetFolder', 'GetFolder'])
    expect(ews.serverVersion).toMatchObject({ major: 15, minor: 2, build: 1118 })
    expect(formatServerVersion(ews.serverVersion)).toBe('15.2.1118.7 (Exchange 2019)')
  })

  it('carries NTLM inside Negotiate and picks it automatically', async () => {
    const server = await fixture({ auth: 'negotiate' })
    const ews = client(server, { auth: 'auto', username: 'CONTOSO\\ada', password: 'Pa55w0rd!' })
    await ews.probe()
    expect(ews.authMethod).toBe('ntlm')
    expect(server.log.some((entry) => /^Negotiate /.test(String(entry.headers.authorization)))).toBe(true)
  })

  it('reports Kerberos-only servers as unsupported instead of a wrong password', async () => {
    const server = await fixture({ auth: 'kerberos-only' })
    await expect(client(server, { auth: 'auto', username: 'CONTOSO\\ada', password: 'Pa55w0rd!' }).probe()).rejects.toThrow(/only Kerberos/)
  })

  it('uses Basic over the connection, detects it automatically, and rejects a wrong password', async () => {
    const server = await fixture({ auth: 'basic', username: 'ada@contoso.test' })
    const auto = client(server, { auth: 'auto', username: 'ada@contoso.test', password: 'Pa55w0rd!' })
    await auto.probe()
    expect(auto.authMethod).toBe('basic')
    await expect(client(server, { auth: 'basic', username: 'ada@contoso.test', password: 'wrong' }).probe()).rejects.toBeInstanceOf(EwsAuthError)
  })

  it('explains when Basic is turned off on the server', async () => {
    const server = await fixture({ auth: 'ntlm' })
    await expect(client(server, { auth: 'basic', username: 'CONTOSO\\ada', password: 'Pa55w0rd!' }).probe()).rejects.toThrow(/Basic authentication is turned off/)
  })

  it('sends OAuth bearer tokens for hybrid deployments and asks for a new token on 401', async () => {
    const server = await fixture({ auth: 'bearer', token: 'good-token' })
    await client(server, { auth: 'bearer', bearerToken: 'good-token' }).probe()
    await expect(client(server, { auth: 'bearer', bearerToken: 'expired' }).probe()).rejects.toThrow(/access token.*expired/i)
  })

  it('turns an expired session into an authentication error and recovers after re-authentication', async () => {
    const server = await fixture({ auth: 'ntlm' })
    const ews = client(server, { auth: 'ntlm', username: 'CONTOSO\\ada', password: 'Pa55w0rd!' })
    await ews.probe()
    server.expireSessions()
    await expect(ews.getFolders([{ id: 'inbox' }])).rejects.toBeInstanceOf(EwsAuthError)
    server.expireSessions(false)
    expect(await ews.getFolders([{ id: 'inbox' }])).toHaveLength(1)
  })

  it('refuses servers older than Exchange 2013 SP1', () => {
    expect(() => assertSupportedServer({ major: 14, minor: 3, build: 123, revision: 0 })).toThrow(/Exchange Server 2013 SP1 or later/)
    expect(() => assertSupportedServer({ major: 15, minor: 0, build: 620, revision: 0 })).toThrow(EwsError)
    expect(() => assertSupportedServer({ major: 15, minor: 0, build: 847, revision: 32 })).not.toThrow()
  })
})

describe('EWS operations', () => {
  it('retries ErrorServerBusy with the server back-off and surfaces item errors', async () => {
    const server = await fixture({ auth: 'none' })
    const ews = client(server, { auth: 'basic', username: 'x', password: 'y' })
    server.failNext('GetFolder', 'busy')
    const [inbox] = await ews.getFolders([{ id: 'inbox' }])
    expect(inbox).toMatchObject({ displayName: 'Inbox', distinguished: 'inbox' })
    expect(server.operations()).toEqual(['GetFolder', 'GetFolder'])
    const [missing] = await ews.getItems(['nope'])
    expect(missing).toBeInstanceOf(EwsError)
    expect((missing as EwsError).code).toBe('ErrorItemNotFound')
  })

  it('lists folders with FindFolder paging and SyncFolderHierarchy', async () => {
    const server = await fixture({ auth: 'none' })
    for (let index = 0; index < 3; index++) server.addFolder(`Project ${index}`)
    const ews = client(server, { auth: 'basic', username: 'x', password: 'y' })
    const folders = await ews.findFolders({ id: 'msgfolderroot' })
    expect(folders.map((folder) => folder.displayName)).toEqual(expect.arrayContaining(['Inbox', 'Project 0', 'Project 2', 'Calendar']))
    const first = await ews.syncFolderHierarchy()
    expect(first.changes.length).toBeGreaterThanOrEqual(10)
    server.addFolder('Later')
    const second = await ews.syncFolderHierarchy(first.syncState)
    expect(second.changes).toEqual([expect.objectContaining({ type: 'update', folder: expect.objectContaining({ displayName: 'Later' }) })])
  })

  it('pages SyncFolderItems with MaxChangesReturned and resumes from each checkpoint', async () => {
    const server = await fixture({ auth: 'none' })
    const inbox = server.folder('inbox')
    for (let index = 0; index < 5; index++) server.addMessage(inbox.id, { subject: `Message ${index}` })
    const ews = client(server, { auth: 'basic', username: 'x', password: 'y' })
    const first = await ews.syncFolderItems({ id: inbox.id, distinguished: false }, undefined, { maxChanges: 2 })
    expect(first.changes).toHaveLength(2)
    expect(first.includesLastItemInRange).toBe(false)
    const second = await ews.syncFolderItems({ id: inbox.id, distinguished: false }, first.syncState, { maxChanges: 2 })
    const third = await ews.syncFolderItems({ id: inbox.id, distinguished: false }, second.syncState, { maxChanges: 2 })
    expect([second.changes.length, third.changes.length, third.includesLastItemInRange]).toEqual([2, 1, true])
    server.invalidateSyncStates()
    await expect(ews.syncFolderItems({ id: inbox.id, distinguished: false }, third.syncState)).rejects.toMatchObject({ code: 'ErrorInvalidSyncStateData' })
  })

  it('reads raw MIME, sends with SendAndSaveCopy, and saves drafts as unsent', async () => {
    const server = await fixture({ auth: 'none' })
    const message = server.addMessage(server.folder('inbox').id, { subject: 'Hello' })
    const ews = client(server, { auth: 'basic', username: 'x', password: 'y' })
    const [fetched] = await ews.getMime([message.id])
    expect(fetched).not.toBeInstanceOf(EwsError)
    expect((fetched as { raw: Buffer }).raw.toString()).toContain('Subject: Hello')
    const mime = Buffer.from('From: ada@contoso.test\r\nTo: grace@contoso.test\r\nSubject: Out\r\n\r\nHi\r\n')
    await ews.sendMime(mime, { deliveryReceipt: true })
    expect(server.sent).toEqual([expect.objectContaining({ deliveryReceipt: true, readReceipt: false })])
    expect(server.log.at(-1)?.body).toContain('MessageDisposition="SendAndSaveCopy"')
    const draft = await ews.saveDraftMime(mime)
    expect(server.log.at(-1)?.body).toContain('PropertyTag="3591"')
    expect(await ews.changeKey(draft.id)).toBe(draft.changeKey)
  })
})
