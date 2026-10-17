import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DavCredentialVault, type DavSecretStorage } from './dav-credentials'
import { startStandardFixture, type DavFixtureOptions } from './dav-fixture-server'
import { DavService } from './dav-service'
import { DavStore } from './dav-store'
import type { DavFetch } from './dav-client'
import { ProductivityStore } from './store'

// Test-only wiring: a loopback fixture server, in-memory stores, and a reversible fake of OS
// secure storage, so service tests exercise real HTTP, XML, and SQLite end to end.

export const fakeSecureStorage = (): DavSecretStorage => ({
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString: (value) => Buffer.from(`sealed:${Buffer.from(value, 'utf8').toString('hex')}`),
  decryptString: (value) => Buffer.from(value.toString().slice(7), 'hex').toString('utf8')
})

export async function createDavHarness(options: DavFixtureOptions = {}) {
  const fixture = await startStandardFixture(options)
  const directory = mkdtempSync(join(tmpdir(), 'aerio-dav-'))
  const productivity = new ProductivityStore(':memory:')
  const store = new DavStore(':memory:')
  const credentials = new DavCredentialVault(join(directory, 'dav-credentials.dat'), fakeSecureStorage())
  const state: { online: boolean; fetch?: DavFetch; changes: number } = { online: true, changes: 0 }
  const service = new DavService({
    store, productivity: () => productivity, credentials,
    online: () => state.online,
    sleep: async () => undefined,
    fetch: (url, init) => state.fetch ? state.fetch(url, init) : fetch(url, init),
    changed: () => { state.changes++ }
  })
  const add = (overrides: Record<string, unknown> = {}) => service.addAccount({
    preset: 'generic', serverUrl: fixture.server.url, username: 'ada@example.com', password: 'app-password', ...overrides
  })
  const close = async () => {
    productivity.close()
    store.close()
    await fixture.server.stop()
    rmSync(directory, { recursive: true, force: true })
  }
  const requests = (method?: string) => fixture.server.requests.filter((request) => !method || request.method === method)
  return { ...fixture, directory, productivity, store, credentials, service, state, add, close, requests }
}

export type DavHarness = Awaited<ReturnType<typeof createDavHarness>>
