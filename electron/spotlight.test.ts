import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { SpotlightRuntime, spotlightIdFromUrl } from './spotlight'
import { DEFAULT_SPOTLIGHT, SpotlightStore } from './spotlight-store'
import type { MailPage } from '../src/mail-types'
const temporary: string[] = [], opened: SpotlightRuntime[] = []
afterEach(async () => { for (const runtime of opened.splice(0)) await runtime.close(); for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }) })
const thread = (id: string, accountId = 'allowed') => ({ id, accountId, subject: `Subject ${id}`, senderEmail: 'sender@example.org', snippet: 'Private preview', lastDate: '', participants: [], unread: false, starred: false, important: false, trashed: false, draft: false, hasAttachments: false, messageCount: 1, labelIds: [] })
function fixture(inactiveDomains: string[] = []) {
  const directory = mkdtempSync(join(tmpdir(), 'aerio-spotlight-')); temporary.push(directory)
  const store = new SpotlightStore(join(directory, 'index.sqlite'), directory)
  let locked = false
  const native = { available: true, perform: vi.fn(async (_operation: 'delete' | 'index' | 'query', _json: string) => '{}') }, changed = vi.fn(), openMessage = vi.fn(), openMainWindow = vi.fn()
  const request = vi.fn(async (command: any): Promise<any> => command.type === 'accounts:list' ? [{ id: 'allowed', archived: false }, { id: 'omitted', archived: false }] : command.type === 'mail:thread' ? { accountId: command.payload.accountId, id: command.payload.threadId, subject: 'Opened', messages: [{ id: 'm' }] } : { items: [thread('one')], total: 1 })
  const runtime = new SpotlightRuntime({ store, native, inactiveDomains, worker: () => ({ request }), locked: () => locked, changed, openMessage, openMainWindow }); opened.push(runtime)
  return { directory, runtime, store, native, request, openMessage, openMainWindow, setLocked: (value: boolean) => { locked = value } }
}
it('starts disabled with no selected accounts and does not read or donate mail before explicit opt-in', async () => {
  const f = fixture(); expect(f.store.settings()).toEqual(DEFAULT_SPOTLIGHT)
  await f.runtime.refresh(); expect(f.request).not.toHaveBeenCalled(); expect(f.native.perform).toHaveBeenCalledWith('delete', expect.any(String))
})
it('scopes every page, rejects omitted-account rows, excludes drafts/trash and only indexes previews after opt-in', async () => {
  const f = fixture()
  f.request.mockImplementation(async (command) => {
    if (command.type === 'accounts:list') return [{ id: 'allowed', archived: false }, { id: 'omitted', archived: false }]
    return command.payload.cursor ? { items: [thread('two'), thread('foreign', 'omitted')], total: 4 } : { items: [thread('one'), { ...thread('draft'), draft: true }, { ...thread('trash'), trashed: true }], total: 4, nextCursor: 'next' }
  })
  await f.runtime.save({ enabled: true, accountIds: ['allowed'], includePreview: false })
  const queries = f.request.mock.calls.map(([command]) => command).filter((command) => command.type === 'mail:list')
  expect(queries).toHaveLength(2); expect(queries.every((command) => JSON.stringify(command.payload.accountIds) === '["allowed"]')).toBe(true)
  const indexed = f.native.perform.mock.calls.filter(([operation]) => operation === 'index').flatMap(([, json]) => JSON.parse(json).items)
  expect(indexed.map((item) => item.title)).toEqual(['Subject one', 'Subject two']); expect(indexed.every((item) => !('preview' in item))).toBe(true)
  await f.runtime.save({ enabled: true, accountIds: [], includePreview: false }); expect(f.store.count()).toBe(0)
})
it('handles deletion/scope removal by replacing OS records and preserves opaque identities across refresh', async () => {
  const f = fixture(); await f.runtime.save({ enabled: true, accountIds: ['allowed'], includePreview: true })
  const first = JSON.parse(f.native.perform.mock.calls.find(([operation]) => operation === 'index')![1]).items[0]
  expect(first.preview).toBe('Private preview'); expect(first.id).toMatch(/^[\da-f-]{36}$/)
  await f.runtime.refresh()
  const latest = JSON.parse(f.native.perform.mock.calls.filter(([operation]) => operation === 'index').at(-1)![1]).items[0]
  expect(latest.id).toBe(first.id)
  f.request.mockImplementation(async (command) => command.type === 'accounts:list' ? [] : { items: [], total: 0 })
  await f.runtime.refresh(); expect(f.store.resolve(first.id)).toBeUndefined(); expect(f.native.perform.mock.calls.at(-1)?.[0]).toBe('delete')
})
it('purges instead of donating a worker result when the app locks during refresh', async () => {
  const f = fixture(); let finish!: (page: MailPage) => void
  f.request.mockImplementation(async (command) => command.type === 'accounts:list' ? [{ id: 'allowed', archived: false }] : new Promise((resolve) => { finish = resolve }))
  const saving = f.runtime.save({ enabled: true, accountIds: ['allowed'], includePreview: true })
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ type: 'mail:list' })))
  f.setLocked(true); f.runtime.lockChanged(); finish({ items: [thread('late')], total: 1 }); await saving
  expect(f.native.perform.mock.calls.some(([operation]) => operation === 'index')).toBe(false)
})
it('queues result restoration behind unlock and validates current ownership before opening', async () => {
  const f = fixture(); await f.runtime.save({ enabled: true, accountIds: ['allowed'], includePreview: false })
  const id = JSON.parse(f.native.perform.mock.calls.find(([operation]) => operation === 'index')![1]).items[0].id
  f.setLocked(true); await f.runtime.open(id); expect(f.openMainWindow).toHaveBeenCalled(); expect(f.openMessage).not.toHaveBeenCalled()
  f.setLocked(false); f.runtime.lockChanged(); await vi.waitFor(() => expect(f.openMessage).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'allowed', threadId: 'one' })))
  await f.runtime.save({ enabled: false, accountIds: ['allowed'], includePreview: false }); f.openMessage.mockClear(); await f.runtime.open(id); expect(f.openMessage).not.toHaveBeenCalled()
})
it('surfaces native index failures and validates only owned deep-link shapes', async () => {
  const f = fixture(); f.native.perform.mockRejectedValue(new Error('OS failure'))
  expect((await f.runtime.save({ enabled: true, accountIds: ['allowed'], includePreview: false })).error).toContain('may remain')
  const id = '12345678-1234-1234-1234-123456789abc'
  expect(spotlightIdFromUrl(`aerio://spotlight/${id}`)).toBe(id)
  for (const url of [`https://spotlight/${id}`, `aerio://other/${id}`, `aerio://spotlight/${id}?token=secret`, 'aerio://spotlight/../../file']) expect(spotlightIdFromUrl(url)).toBeUndefined()
})
it('purges an in-flight native donation before finishing a lock transition', async () => {
  const f = fixture(); let finish!: (value: string) => void
  f.native.perform.mockImplementation(async (operation) => operation === 'index' ? new Promise((resolve) => { finish = resolve }) : '{}')
  const saving = f.runtime.save({ enabled: true, accountIds: ['allowed'], includePreview: false })
  await vi.waitFor(() => expect(f.native.perform.mock.calls.some(([operation]) => operation === 'index')).toBe(true))
  f.setLocked(true); f.runtime.lockChanged(); finish('{}'); await saving
  expect(f.native.perform.mock.calls.at(-1)?.[0]).toBe('delete')
  expect(f.runtime.status()).toMatchObject({ indexed: 0, settings: { accountIds: [], includePreview: false } })
})
it('validates untrusted settings and never turns an empty scope into all accounts', async () => {
  const f = fixture()
  await expect(f.runtime.save({ enabled: true, accountIds: 'all', includePreview: false } as any)).rejects.toThrow('valid Spotlight')
  await f.runtime.save({ enabled: true, accountIds: [], includePreview: false })
  expect(f.request.mock.calls.some(([command]) => command.type === 'mail:list')).toBe(false)
  expect(f.store.count()).toBe(0)
})
it('removes inactive-profile domains at startup and pauses donations before a profile switch', async () => {
  const inactive = 'com.aerio.spotlight.inactive', f = fixture([inactive])
  f.runtime.start(); await f.runtime.refresh()
  expect(f.native.perform).toHaveBeenCalledWith('delete', JSON.stringify({ domain: inactive }))
  await f.runtime.save({ enabled: true, accountIds: ['allowed'], includePreview: false })
  f.native.perform.mockClear(); await f.runtime.beforeProfileSwitch(); await f.runtime.refresh()
  expect(f.native.perform.mock.calls.every(([operation]) => operation === 'delete')).toBe(true)
  f.runtime.profileSwitchCancelled(); await vi.waitFor(() => expect(f.native.perform.mock.calls.some(([operation]) => operation === 'index')).toBe(true))
})
it('retains failed inactive-profile cleanup until refresh successfully retries it', async () => {
  const inactive = 'com.aerio.spotlight.inactive', f = fixture([inactive])
  f.native.perform.mockImplementation(async (_operation, json) => { if (JSON.parse(json).domain === inactive) throw new Error('OS unavailable'); return '{}' })
  f.runtime.start()
  const failed = await f.runtime.refresh()
  expect(failed).toMatchObject({ syncing: false, error: expect.stringContaining('Inactive profile') })
  expect(f.request).not.toHaveBeenCalled()
  expect(f.native.perform).toHaveBeenCalledWith('delete', JSON.stringify({ domain: f.store.domain }))
  f.native.perform.mockResolvedValue('{}')
  expect(await f.runtime.refresh()).toMatchObject({ syncing: false, error: undefined })
  const attempts = f.native.perform.mock.calls.filter(([, json]) => JSON.parse(json).domain === inactive).length
  await f.runtime.refresh()
  expect(f.native.perform.mock.calls.filter(([, json]) => JSON.parse(json).domain === inactive)).toHaveLength(attempts)
})
it('persists possible native metadata after failed disable cleanup and blocks profile switching without native access', async () => {
  const f = fixture()
  await f.runtime.save({ enabled: true, accountIds: ['allowed'], includePreview: false })
  expect(f.store.cleanupPending()).toBe(true)
  f.native.perform.mockRejectedValue(new Error('Removal failed'))
  expect(await f.runtime.save({ enabled: false, accountIds: [], includePreview: false })).toMatchObject({ syncing: false, error: expect.stringContaining('may remain') })
  expect(f.store.count()).toBe(0)
  f.native.available = false
  await f.runtime.close(); opened.splice(opened.indexOf(f.runtime), 1)
  const store = new SpotlightStore(join(f.directory, 'index.sqlite'), f.directory)
  const restarted = new SpotlightRuntime({ store, native: f.native, worker: () => ({ request: f.request }), locked: () => false, changed: vi.fn(), openMainWindow: vi.fn(), openMessage: vi.fn() }); opened.push(restarted)
  expect(restarted.status().error).toContain('may remain')
  await expect(restarted.beforeProfileSwitch()).rejects.toThrow('cannot be removed')
  f.native.available = true; f.native.perform.mockResolvedValue('{}')
  expect(await restarted.refresh()).toMatchObject({ syncing: false, error: undefined })
  expect(store.cleanupPending()).toBe(false)
  await expect(restarted.beforeProfileSwitch()).resolves.toBeUndefined()
})
it('allows a never-indexed profile to switch when native Spotlight is unavailable', async () => {
  const f = fixture(); f.native.available = false
  await expect(f.runtime.beforeProfileSwitch()).resolves.toBeUndefined()
})
