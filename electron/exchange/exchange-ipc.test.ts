import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MailAccountSummary } from '../../src/mail-types'
import type { ExchangeSnapshot } from '../../src/exchange-types'
import { ProductivityStore } from '../productivity/store'
import { EwsFixtureServer } from './ews-fixture-server'
import { ewsClientFor, type ExchangeAccountConfig } from './exchange-config'
import { registerExchangeAccounts } from './exchange-ipc'
import { ExchangeProductivityService } from './exchange-productivity'
import { ExchangeStore } from './exchange-store'

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step() })

async function setup(auth: 'ntlm' | 'basic' = 'ntlm') {
  const directory = mkdtempSync(join(tmpdir(), 'aerio-ews-ipc-'))
  const server = await new EwsFixtureServer({ auth, ...(auth === 'basic' ? { username: 'ada@contoso.test' } : {}) }).start()
  const productivity = new ProductivityStore(join(directory, 'productivity.sqlite'))
  const store = new ExchangeStore(join(directory, 'exchange.sqlite'))
  const vault = new Map<string, ExchangeAccountConfig>()
  const service = new ExchangeProductivityService({ store, productivity: () => productivity, client: (id) => ewsClientFor(vault.get(id)!) })
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const requests: { type: string }[] = []
  const providers = new Map<string, string>()
  const broadcasts: ExchangeSnapshot[] = []
  const discover = vi.fn(async () => ({ status: 'not-found' as const, email: 'ada@contoso.test', attempts: [] }))
  registerExchangeAccounts({
    ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => { handlers.set(channel, handler) } } as never,
    service: () => service,
    vault: () => ({
      storeExchange: (id, config) => { vault.set(id, config) },
      exchangeCredential: (id) => { const value = vault.get(id); if (!value) throw new Error('missing'); return value },
      remove: async (id) => { vault.delete(id) }
    }),
    worker: () => ({ request: async (command) => { requests.push(command as { type: string }) } }),
    accountColor: () => '#0f6cbd',
    accountAdded: (account) => providers.set(account.id, account.provider),
    accountRemoved: (id) => providers.delete(id),
    broadcast: (snapshot) => broadcasts.push(snapshot),
    productivityChanged: () => undefined,
    discover,
    timers: false
  })
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }), () => server.stop(), () => productivity.close(), () => store.close())
  const invoke = (channel: string, ...args: unknown[]) => Promise.resolve(handlers.get(channel)!({}, ...args))
  return { server, service, vault, requests, providers, broadcasts, discover, invoke, handlers }
}

describe('Exchange IPC', () => {
  it('registers the Exchange channels', async () => {
    const { handlers } = await setup()
    expect([...handlers.keys()].sort()).toEqual(['exchange:connect', 'exchange:discover', 'exchange:resolve', 'exchange:snapshot', 'exchange:sync', 'exchange:update-credentials'])
  })

  it('validates discovery input and passes trusted hosts through', async () => {
    const { invoke, discover } = await setup()
    await expect(invoke('exchange:discover', { email: 42 })).rejects.toThrow(/valid email/)
    await invoke('exchange:discover', { email: 'ada@contoso.test', password: 'x', trustedHosts: ['mail.hoster.example', 7] })
    expect(discover).toHaveBeenCalledWith({ email: 'ada@contoso.test', password: 'x', trustedHosts: ['mail.hoster.example'] })
  })

  it('verifies the server before saving, resolves automatic authentication, and starts mail and calendar sync', async () => {
    const { server, invoke, vault, requests, providers, service } = await setup('ntlm')
    const account = await invoke('exchange:connect', { email: 'Ada@Contoso.test', username: 'CONTOSO\\ada', password: 'Pa55w0rd!', ewsUrl: server.url, auth: 'auto', displayName: 'Ada' }) as MailAccountSummary
    expect(account).toMatchObject({ provider: 'exchange', email: 'ada@contoso.test', displayName: 'Ada', status: 'connecting' })
    expect(vault.get(account.id)).toMatchObject({ auth: 'ntlm', username: 'CONTOSO\\ada', serverVersion: '15.2.1118.7 (Exchange 2019)' })
    expect(requests.map((request) => request.type)).toEqual(['accounts:upsert', 'sync:start'])
    expect(providers.get(account.id)).toBe('exchange')
    expect(service.hasAccount(account.id)).toBe(true)
    const snapshot = await invoke('exchange:snapshot') as ExchangeSnapshot
    expect(snapshot.accounts[0]).toMatchObject({ accountId: account.id, auth: 'ntlm', ewsUrl: server.url, capabilities: { mail: { read: true, write: true }, folderManagement: true } })
  })

  it('reports wrong passwords, unsupported servers, and plain HTTP clearly and keeps nothing', async () => {
    const { server, invoke, vault } = await setup('ntlm')
    await expect(invoke('exchange:connect', { email: 'ada@contoso.test', username: 'CONTOSO\\ada', password: 'wrong', ewsUrl: server.url, auth: 'ntlm' })).rejects.toThrow(/rejected the user name or password/)
    await expect(invoke('exchange:connect', { email: 'ada@contoso.test', password: 'x', ewsUrl: 'http://mail.contoso.test/EWS/Exchange.asmx', auth: 'basic' })).rejects.toThrow(/plain HTTP is not supported/)
    await expect(invoke('exchange:connect', { email: 'ada@contoso.test', ewsUrl: server.url, auth: 'bearer' })).rejects.toThrow(/access token/)
    server.options.version = { major: 14, minor: 3, build: 468, revision: 0 }
    await expect(invoke('exchange:connect', { email: 'ada@contoso.test', username: 'CONTOSO\\ada', password: 'Pa55w0rd!', ewsUrl: server.url, auth: 'ntlm' })).rejects.toThrow(/2013 SP1 or later/)
    expect(vault.size).toBe(0)
  })

  it('re-authenticates after a 401: verifies the new password, saves it, and restarts sync', async () => {
    const { server, invoke, vault, requests } = await setup('ntlm')
    const account = await invoke('exchange:connect', { email: 'ada@contoso.test', username: 'CONTOSO\\ada', password: 'Pa55w0rd!', ewsUrl: server.url, auth: 'ntlm' }) as MailAccountSummary
    server.options.password = 'N3wPassw0rd!'
    await expect(invoke('exchange:update-credentials', account.id, { password: 'still-wrong' })).rejects.toThrow(/rejected/)
    expect(vault.get(account.id)?.password).toBe('Pa55w0rd!')
    requests.length = 0
    await invoke('exchange:update-credentials', account.id, { password: 'N3wPassw0rd!' })
    expect(vault.get(account.id)?.password).toBe('N3wPassw0rd!')
    expect(requests.map((request) => request.type)).toEqual(['accounts:verify', 'sync:start'])
  })

  it('validates review resolutions', async () => {
    const { invoke } = await setup()
    await expect(invoke('exchange:resolve', 'op', 'overwrite')).rejects.toThrow(/Choose how/)
    await expect(invoke('exchange:sync', 'missing')).rejects.toThrow(/no longer connected/)
  })
})
