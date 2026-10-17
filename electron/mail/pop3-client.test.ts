import { generate } from 'selfsigned'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Pop3Error, Pop3Session, validUidl, type Pop3ClientOptions } from './pop3-client'
import { FakePop3Server, type FakePop3Options } from './pop3-test-server'

let certificate: { key: string; cert: string }
const servers: FakePop3Server[] = []

beforeAll(async () => {
  const pems = await generate([{ name: 'commonName', value: 'localhost' }], { keySize: 2048, algorithm: 'sha256', extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }] }] })
  certificate = { key: pems.private, cert: pems.cert }
}, 60_000)

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

const message = (id: string, body = `Body of ${id}`) => `From: Ada <ada@example.test>\r\nTo: bob@example.test\r\nSubject: ${id}\r\nMessage-ID: <${id}@example.test>\r\nDate: Wed, 15 Oct 2025 12:00:00 +0000\r\n\r\n${body}\r\n`

async function start(options: Partial<FakePop3Options> = {}) {
  const server = new FakePop3Server({ mode: 'tls', certificate, messages: [{ uidl: 'uid-1', raw: message('one') }, { uidl: 'uid-2', raw: message('two') }], ...options })
  servers.push(server)
  await server.start()
  return server
}

const options = (server: FakePop3Server, extra: Partial<Pop3ClientOptions> = {}): Pop3ClientOptions => ({
  host: '127.0.0.1', port: server.port, security: 'tls', username: 'ada', password: 'secret', tls: { ca: certificate.cert }, timeoutMs: 3_000, ...extra
})

const rejection = async (promise: Promise<unknown>) => {
  try { await promise } catch (error) { return error as Pop3Error }
  throw new Error('Expected the promise to reject')
}

describe('POP3 client', () => {
  it('connects with implicit TLS, prefers AUTH PLAIN and lists, retrieves and deletes messages', async () => {
    const server = await start()
    const session = await Pop3Session.open(options(server))
    expect(session.encrypted).toBe(true)
    expect(session.authMethod).toBe('plain')
    expect(session.capabilities).toContain('UIDL')
    expect(await session.stat()).toEqual({ count: 2, bytes: server.maildrop.reduce((sum, item) => sum + item.raw.length, 0) })
    expect([...(await session.uidl()).entries()]).toEqual([[1, 'uid-1'], [2, 'uid-2']])
    expect((await session.list()).get(2)).toBe(server.maildrop[1].raw.length)
    expect((await session.retr(1)).equals(server.maildrop[0].raw)).toBe(true)
    await session.dele(2)
    expect(await session.quit()).toBe(true)
    expect(server.uidls()).toEqual(['uid-1'])
    expect(server.commands).toContain('AUTH PLAIN <credentials>')
    expect(server.commands.join('\n')).not.toContain('secret')
  })

  it('upgrades with STLS before sending credentials, and re-reads capabilities over TLS', async () => {
    const server = await start({ mode: 'plain', sasl: [] })
    const session = await Pop3Session.open(options(server, { security: 'starttls' }))
    expect(session.encrypted).toBe(true)
    expect(session.authMethod).toBe('user')
    expect(session.capabilities).not.toContain('STLS')
    await session.quit()
    expect(server.commands.slice(0, 3)).toEqual(['CAPA', 'STLS', 'CAPA'])
    expect(server.commands.indexOf('PASS <redacted>')).toBeGreaterThan(server.commands.indexOf('STLS'))
  })

  it('refuses STARTTLS accounts when the server does not offer STLS, without sending the password', async () => {
    const server = await start({ mode: 'plain', stls: false })
    const error = await rejection(Pop3Session.open(options(server, { security: 'starttls' })))
    expect(error).toMatchObject({ kind: 'tls', message: expect.stringMatching(/does not offer STARTTLS/) })
    expect(server.commands.some((command) => command.startsWith('USER') || command.startsWith('PASS') || command.startsWith('AUTH'))).toBe(false)
  })

  it('rejects an untrusted certificate for implicit TLS and STARTTLS', async () => {
    const tls = await start()
    expect(await rejection(Pop3Session.open(options(tls, { tls: {} })))).toMatchObject({ kind: 'tls', message: expect.stringMatching(/not trusted/) })
    const starttls = await start({ mode: 'plain' })
    expect(await rejection(Pop3Session.open(options(starttls, { security: 'starttls', tls: {} })))).toMatchObject({ kind: 'tls' })
    expect(starttls.commands).not.toContain('PASS <redacted>')
  })

  it('reports TLS negotiation failure when TLS is used against a plaintext port', async () => {
    const server = await start({ mode: 'plain' })
    expect(await rejection(Pop3Session.open(options(server)))).toMatchObject({ kind: expect.stringMatching(/tls|timeout|connection/) })
  })

  it('never connects without encryption unless plaintext is explicitly allowed, and then prefers APOP', async () => {
    const server = await start({ mode: 'plain' })
    expect(await rejection(Pop3Session.open(options(server, { security: 'none' })))).toMatchObject({ kind: 'tls', message: expect.stringMatching(/Unencrypted POP3 is turned off/) })
    expect(server.sessions).toBe(0)
    const session = await Pop3Session.open(options(server, { security: 'none', allowPlaintext: true }))
    expect(session.encrypted).toBe(false)
    expect(session.authMethod).toBe('apop')
    await session.quit()
    expect(server.commands).toContain('APOP ada <digest>')
  })

  it('supports explicit USER/PASS, APOP and AUTH PLAIN, and explains unsupported choices', async () => {
    const server = await start({ sasl: [] })
    for (const auth of ['user', 'apop'] as const) {
      const session = await Pop3Session.open(options(server, { auth }))
      expect(session.authMethod).toBe(auth)
      await session.quit()
    }
    expect(await rejection(Pop3Session.open(options(server, { auth: 'plain' })))).toMatchObject({ kind: 'unsupported' })
    const noApop = await start({ apop: false })
    expect(await rejection(Pop3Session.open(options(noApop, { auth: 'apop' })))).toMatchObject({ kind: 'unsupported' })
  })

  it('reports wrong credentials as an authentication failure for every method', async () => {
    const server = await start()
    for (const auth of ['user', 'apop', 'plain'] as const) {
      const error = await rejection(Pop3Session.open(options(server, { auth, password: 'wrong' })))
      expect(error).toMatchObject({ kind: 'auth', message: expect.stringMatching(/^Authentication failed: Invalid credentials/) })
    }
  })

  it('distinguishes a locked mailbox from bad credentials', async () => {
    const server = await start()
    server.failures.inUse = true
    expect(await rejection(Pop3Session.open(options(server)))).toMatchObject({ kind: 'in-use' })
  })

  it('works with servers that predate CAPA', async () => {
    const server = await start({ capa: false })
    const session = await Pop3Session.open(options(server))
    expect(session.capabilities).toEqual([])
    expect(session.authMethod).toBe('user')
    await session.quit()
  })

  it('removes dot-stuffing and keeps message bytes exactly', async () => {
    const body = '.leading dot\r\n..two dots\r\n.\r\nnot the end\r\nümlaut line'
    const server = await start({ messages: [{ uidl: 'dots', raw: message('dots', body) }] })
    const session = await Pop3Session.open(options(server))
    const raw = await session.retr(1)
    expect(raw.toString('latin1')).toContain('\r\n.leading dot\r\n..two dots\r\n.\r\nnot the end\r\n')
    expect(raw.equals(server.maildrop[0].raw)).toBe(true)
    await session.quit()
  })

  it('rolls back DELE when the session ends without QUIT', async () => {
    const server = await start()
    const session = await Pop3Session.open(options(server))
    await session.dele(1)
    session.close()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(server.uidls()).toEqual(['uid-1', 'uid-2'])
  })

  it('fails a retrieval that is cut off mid-message', async () => {
    const server = await start()
    server.failures.dropDuringRetr = 'uid-2'
    const session = await Pop3Session.open(options(server))
    expect((await session.retr(1)).length).toBeGreaterThan(0)
    expect(await rejection(session.retr(2))).toMatchObject({ kind: 'connection' })
  })

  it('times out when the server stops responding', async () => {
    const server = await start()
    server.failures.silentAfter = 'UIDL'
    const session = await Pop3Session.open(options(server, { timeoutMs: 300 }))
    expect(await rejection(session.uidl())).toMatchObject({ kind: 'timeout' })
  })

  it('times out connecting to a server that never greets', async () => {
    const silent = (await import('node:net')).createServer(() => undefined)
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
    try {
      const port = (silent.address() as { port: number }).port
      expect(await rejection(Pop3Session.open({ host: '127.0.0.1', port, security: 'none', allowPlaintext: true, username: 'a', password: 'b', timeoutMs: 300 }))).toMatchObject({ kind: 'timeout' })
    } finally {
      await new Promise((resolve) => silent.close(resolve))
    }
  })

  it('reads a large message within the limit and rejects one over it while keeping the session usable', async () => {
    const big = message('big', 'x'.repeat(70) + '\r\n' + Array.from({ length: 4000 }, (_, index) => `line ${index} ${'y'.repeat(60)}`).join('\r\n'))
    const server = await start({ messages: [{ uidl: 'big', raw: big }, { uidl: 'small', raw: message('small') }] })
    const session = await Pop3Session.open(options(server))
    expect((await session.retr(1)).equals(server.maildrop[0].raw)).toBe(true)
    expect(await rejection(session.retr(1, 1024))).toMatchObject({ kind: 'too-large' })
    expect((await session.retr(2)).toString()).toContain('Subject: small')
    await session.quit()
  })

  it('requires UIDL support', async () => {
    const server = await start({ uidl: false })
    const session = await Pop3Session.open(options(server))
    expect(await rejection(session.uidl())).toMatchObject({ kind: 'unsupported' })
    await session.quit()
  })

  it('validates unique ids', () => {
    expect(validUidl('AbC-123')).toBe(true)
    expect(validUidl('')).toBe(false)
    expect(validUidl('with space')).toBe(false)
    expect(validUidl('x'.repeat(71))).toBe(false)
  })
})
