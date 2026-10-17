import { createRequire } from 'node:module'
import { generate } from 'selfsigned'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pop3AccountInput, Pop3ConnectionConfig } from '../../src/pop3-types'
import { FakePop3Server } from './pop3-test-server'

const mocks = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>() }))
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn((channel: string, handler: (...args: any[]) => any) => mocks.handlers.set(channel, handler)) } }))

import { pop3AccountId, registerPop3Ipc, testPop3Connection } from './pop3-ipc'

const invoke = (channel: string, ...args: unknown[]) => mocks.handlers.get(channel)!({}, ...args)

const input: Pop3AccountInput = {
  email: ' Me@Example.test ', displayName: 'Me', username: 'me', password: 'secret',
  pop3Host: 'pop.example.test', pop3Port: 995, pop3Security: 'tls', auth: 'auto',
  smtpHost: 'smtp.example.test', smtpPort: 465, smtpSecurity: 'tls',
  retention: { leaveOnServer: true, deleteAfterDays: 30, removeWhenDeleted: true },
  destination: { kind: 'account' }
}
const accountId = pop3AccountId({ email: 'me@example.test', username: 'me', pop3Host: 'pop.example.test' })

let accounts: any[]
let vaultConfig: Pop3ConnectionConfig | undefined
let locked = false
let stored: any
const calls: string[] = []
const worker = {
  request: vi.fn(async (command: any) => {
    calls.push(command.type === 'pop3' ? `pop3:${command.payload.action}` : command.type)
    if (command.type === 'accounts:list') return accounts
    if (command.type === 'accounts:upsert') { accounts.push(command.payload); return command.payload }
    if (command.type === 'pop3' && command.payload.action === 'settings:save') { stored = command.payload.settings; return stored }
    if (command.type === 'pop3' && command.payload.action === 'settings:get') return stored
    if (command.type === 'pop3' && command.payload.action === 'status') return { accountId: command.payload.accountId, downloaded: 4 }
    return undefined
  })
}
const vault = {
  storePop3: vi.fn((_id: string, config: Pop3ConnectionConfig) => { vaultConfig = config }),
  pop3Config: vi.fn(() => vaultConfig),
  remove: vi.fn(async () => { vaultConfig = undefined })
}
const test = vi.fn(async () => ({ capabilities: [], authMethod: 'user' as const, encrypted: true, messages: 3, bytes: 300, smtpVerified: true }))
const setProvider = vi.fn()

beforeEach(() => {
  mocks.handlers.clear()
  accounts = []
  vaultConfig = undefined
  stored = undefined
  locked = false
  calls.length = 0
  vi.clearAllMocks()
  registerPop3Ipc({ worker: () => worker as any, vault: () => vault, accountColor: () => '#123456', setProvider, locked: () => locked, test })
})

describe('POP3 IPC', () => {
  it('tests a connection without saving anything', async () => {
    await expect(invoke('mail:pop3:test', input)).resolves.toMatchObject({ messages: 3 })
    expect(test).toHaveBeenCalledWith(expect.objectContaining({ email: 'me@example.test', pop3Host: 'pop.example.test', password: 'secret' }))
    expect(vault.storePop3).not.toHaveBeenCalled()
    expect(worker.request).not.toHaveBeenCalled()
  })

  it('connects only after the servers work, storing the password in the vault and the policy in the mail store', async () => {
    const account = await invoke('mail:pop3:connect', input)
    expect(account).toMatchObject({ id: accountId, provider: 'pop3', email: 'me@example.test', displayName: 'Me' })
    expect(calls).toEqual(['accounts:list', 'accounts:upsert', 'pop3:settings:save', 'sync:start'])
    expect(test.mock.invocationCallOrder[0]).toBeLessThan(worker.request.mock.invocationCallOrder[0])
    expect(vaultConfig).toMatchObject({ password: 'secret', pop3Host: 'pop.example.test' })
    expect(stored).toEqual({
      server: expect.not.objectContaining({ password: expect.anything() }),
      retention: { leaveOnServer: true, deleteAfterDays: 30, removeWhenDeleted: true },
      destination: { kind: 'account' }
    })
    expect(setProvider).toHaveBeenCalledWith(accountId, 'pop3')
  })

  it('refuses a duplicate address and cleans up when setup fails part-way', async () => {
    accounts = [{ id: 'imap-1', provider: 'imap', email: 'me@example.test' }]
    await expect(invoke('mail:pop3:connect', input)).rejects.toThrow(/already connected/)
    accounts = []
    worker.request.mockImplementationOnce(async () => []).mockImplementationOnce(async () => undefined).mockImplementationOnce(async () => { throw new Error('The Local Folders folder chosen for downloaded mail no longer exists') })
    await expect(invoke('mail:pop3:connect', { ...input, destination: { kind: 'local-folder', labelId: 'folder:local-x' } })).rejects.toThrow(/no longer exists/)
    expect(vault.remove).toHaveBeenCalledWith(accountId)
    expect(worker.request).toHaveBeenLastCalledWith({ type: 'accounts:disconnect', payload: { accountId, mode: 'delete' } })
    expect(setProvider).toHaveBeenLastCalledWith(accountId, undefined)
  })

  it('does not connect when the connection test fails', async () => {
    test.mockRejectedValueOnce(new Error('Authentication failed: Invalid credentials'))
    await expect(invoke('mail:pop3:connect', input)).rejects.toThrow(/Authentication failed/)
    expect(worker.request).not.toHaveBeenCalled()
    expect(vault.storePop3).not.toHaveBeenCalled()
  })

  it('validates renderer input and refuses changes while Aerio is locked', async () => {
    expect(() => invoke('mail:pop3:test', { ...input, pop3Security: 'none' })).toThrow(/unencrypted/)
    expect(() => invoke('mail:pop3:test', { ...input, pop3Host: 'pop3://example.test' })).toThrow(/hostnames/)
    expect(() => invoke('mail:pop3:test', { ...input, retention: { leaveOnServer: true, deleteAfterDays: 0, removeWhenDeleted: false } })).toThrow(/between 1 and/)
    expect(() => invoke('mail:pop3:test', { ...input, destination: { kind: 'elsewhere' } })).toThrow(/where downloaded mail/)
    await expect(invoke('mail:pop3:settings', '../x')).rejects.toThrow(/valid POP3 account/)
    locked = true
    await expect(invoke('mail:pop3:connect', input)).rejects.toThrow(/Unlock Aerio/)
    await expect(invoke('mail:pop3:update', accountId, {})).rejects.toThrow(/Unlock Aerio/)
    expect(test).not.toHaveBeenCalled()
  })

  it('reads settings without the password, also after a restore removed the vault entry', async () => {
    await invoke('mail:pop3:connect', input)
    await expect(invoke('mail:pop3:settings', accountId)).resolves.toMatchObject({ pop3Host: 'pop.example.test', passwordConfigured: true, retention: { removeWhenDeleted: true } })
    expect(JSON.stringify(await invoke('mail:pop3:settings', accountId))).not.toContain('secret')
    vaultConfig = undefined
    await expect(invoke('mail:pop3:settings', accountId)).resolves.toMatchObject({ pop3Host: 'pop.example.test', passwordConfigured: false })
    await expect(invoke('mail:pop3:status', accountId)).resolves.toMatchObject({ downloaded: 4 })
    await expect(invoke('mail:pop3:settings', 'not-an-account')).rejects.toThrow(/not found/)
  })

  it('saves a retention change without reconnecting, but tests new server settings and passwords first', async () => {
    await invoke('mail:pop3:connect', input)
    test.mockClear()
    calls.length = 0
    const { password: _password, email: _email, displayName: _name, ...update } = input
    await invoke('mail:pop3:update', accountId, { ...update, retention: { leaveOnServer: false, removeWhenDeleted: false } })
    expect(test).not.toHaveBeenCalled()
    expect(stored.retention).toEqual({ leaveOnServer: false, removeWhenDeleted: false })
    expect(calls).not.toContain('sync:start')

    test.mockRejectedValueOnce(new Error('Authentication failed'))
    await expect(invoke('mail:pop3:update', accountId, { ...update, password: 'new-secret' })).rejects.toThrow(/Authentication failed/)
    expect(vaultConfig?.password).toBe('secret')

    await invoke('mail:pop3:update', accountId, { ...update, password: 'new-secret', pop3Port: 1995 })
    expect(vaultConfig).toMatchObject({ password: 'new-secret', pop3Port: 1995 })
    expect(calls.at(-1)).toBe('pop3:settings:get')
    expect(calls).toContain('sync:start')
  })

  it('needs the password again after a restore', async () => {
    await invoke('mail:pop3:connect', input)
    vaultConfig = undefined
    const { password: _password, email: _email, displayName: _name, ...update } = input
    await expect(invoke('mail:pop3:update', accountId, update)).rejects.toThrow(/Enter the password/)
    await invoke('mail:pop3:update', accountId, { ...update, password: 'restored' })
    expect(vaultConfig).toMatchObject({ email: 'me@example.test', password: 'restored' })
  })
})

describe('POP3 connection test against disposable servers', () => {
  let certificate: { key: string; cert: string }
  let pop3: FakePop3Server
  let smtp: any
  let smtpPort = 0
  const authentications: { user: string; secure: boolean }[] = []

  beforeAll(async () => {
    const pems = await generate([{ name: 'commonName', value: 'localhost' }], { keySize: 2048, algorithm: 'sha256', extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }] })
    certificate = { key: pems.private, cert: pems.cert }
    pop3 = new FakePop3Server({ mode: 'tls', certificate, messages: [{ uidl: 'a', raw: 'Subject: a\r\n\r\nA\r\n' }] })
    await pop3.start()
    const { SMTPServer } = createRequire(import.meta.url)('smtp-server')
    smtp = new SMTPServer({
      secure: false, key: certificate.key, cert: certificate.cert, logger: false, closeTimeout: 500,
      onAuth(auth: { username: string; password: string }, session: { secure: boolean }, callback: (error: Error | null, result?: { user: string }) => void) {
        authentications.push({ user: auth.username, secure: session.secure })
        callback(auth.username === 'ada' && auth.password === 'secret' ? null : new Error('Fixture authentication failed'), { user: auth.username })
      }
    })
    smtp.on('error', () => undefined)
    await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', resolve))
    smtpPort = smtp.server.address().port
  }, 60_000)

  afterAll(async () => {
    await pop3?.close()
    await new Promise((resolve) => smtp ? smtp.close(resolve) : resolve(undefined))
  })

  const config = (extra: Partial<Pop3ConnectionConfig> = {}): Pop3ConnectionConfig => ({
    email: 'ada@example.test', username: 'ada', password: 'secret', pop3Host: '127.0.0.1', pop3Port: pop3.port, pop3Security: 'tls', auth: 'auto',
    smtpHost: '127.0.0.1', smtpPort, smtpSecurity: 'starttls', ...extra
  })

  it('signs in to POP3 over TLS, checks UIDL, and verifies SMTP over STARTTLS', async () => {
    await expect(testPop3Connection(config(), { ca: certificate.cert })).resolves.toMatchObject({ encrypted: true, authMethod: 'plain', messages: 1, smtpVerified: true })
    expect(authentications.at(-1)).toEqual({ user: 'ada', secure: true })
    expect(pop3.uidls()).toEqual(['a'])
  })

  it('reports SMTP authentication and certificate failures', async () => {
    await expect(testPop3Connection(config({ password: 'wrong' }), { ca: certificate.cert })).rejects.toThrow(/Authentication failed/)
    const pop3Only = new FakePop3Server({ mode: 'tls', certificate, users: { ada: 'secret', other: 'pass' } })
    await pop3Only.start()
    try {
      await expect(testPop3Connection(config({ username: 'other', password: 'pass', pop3Port: pop3Only.port }), { ca: certificate.cert })).rejects.toThrow(/Fixture authentication failed|Invalid login|535/)
    } finally {
      await pop3Only.close()
    }
    await expect(testPop3Connection(config())).rejects.toMatchObject({ kind: 'tls' })
  })
})
