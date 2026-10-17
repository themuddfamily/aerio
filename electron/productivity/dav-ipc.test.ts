import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  sent: [] as [string, unknown][]
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => mocks.handlers.set(channel, handler) },
  BrowserWindow: { getAllWindows: () => [{ webContents: { send: (channel: string, value: unknown) => mocks.sent.push([channel, value]) } }] }
}))

import { registerDavAccounts } from './dav-ipc'
import { createDavHarness, type DavHarness } from './dav-test-harness'
import { ICS } from './dav-fixture-server'

let harness: DavHarness | undefined
let registration: ReturnType<typeof registerDavAccounts> | undefined
afterEach(async () => {
  registration?.dispose()
  await harness?.close()
  harness = undefined
  mocks.handlers.clear()
  mocks.sent.length = 0
})

const invoke = (channel: string, ...args: unknown[]) => mocks.handlers.get(channel)!({}, ...args)

describe('DAV account IPC', () => {
  it('adds, synchronizes, toggles, and removes accounts, broadcasting each change', async () => {
    harness = await createDavHarness()
    harness.server.write(harness.work, 'a.ics', ICS('a', 'Alpha'))
    const productivityChanged = vi.fn()
    const accountRemoved = vi.fn()
    registration = registerDavAccounts({ service: () => harness!.service, productivityChanged, accountRemoved })
    const added = await invoke('dav:account-add', { preset: 'generic', serverUrl: harness.server.url, username: 'ada@example.com', password: 'app-password' }) as { accounts: { id: string }[]; collections: { id: string; name: string }[] }
    expect(added.accounts).toHaveLength(1)
    expect(mocks.sent.at(-1)![0]).toBe('dav:changed')
    expect(productivityChanged).toHaveBeenCalled()
    expect(JSON.stringify(mocks.sent)).not.toContain('app-password')
    const id = added.accounts[0].id
    await invoke('dav:sync', id)
    await invoke('dav:sync-all')
    const work = added.collections.find((collection) => collection.name === 'Work')!
    expect((await invoke('dav:collection-enabled', work.id, false) as { collections: { id: string; enabled: boolean }[] }).collections.find((item) => item.id === work.id)!.enabled).toBe(false)
    expect(harness.productivity.snapshot().events).toEqual([])
    await registration.flushNow()
    expect((await invoke('dav:account-remove', id) as { accounts: unknown[] }).accounts).toEqual([])
    // Server-synchronized notes of the account are removed with it.
    expect(accountRemoved).toHaveBeenCalledWith(id)
  })

  it('validates arguments before calling the service', async () => {
    harness = await createDavHarness()
    registration = registerDavAccounts({ service: () => harness!.service, productivityChanged: () => undefined })
    expect(() => invoke('dav:account-remove', 'missing')).toThrow(/no longer connected/)
    expect(() => invoke('dav:collection-enabled', 'x', 'yes')).toThrow(/Choose a calendar/)
    await expect(invoke('dav:sync', '')).rejects.toThrow(/Choose an account/)
    await expect(invoke('dav:account-password', 42, 'x')).rejects.toThrow(/Choose an account/)
    await expect(invoke('dav:resolve', '', 'keep-server')).rejects.toThrow(/Choose a change/)
    await expect(invoke('dav:account-add', { preset: 'nope' })).rejects.toThrow(/Choose a calendar and contacts service/)
    await expect(invoke('dav:account-add', { preset: 'icloud', username: '', password: 'x' })).rejects.toThrow(/user name/)
    expect(invoke('dav:snapshot')).toEqual({ accounts: [], collections: [], review: [] })
  })
})
