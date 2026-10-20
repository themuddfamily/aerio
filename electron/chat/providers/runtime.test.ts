import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ChatVault } from '../chat-vault'
import { ProviderChatError, type ProviderChatAdapter } from './adapter'
import { ProviderChatRuntime } from './runtime'
import type { ProviderChatRoom } from '../../../src/provider-chat-types'

const directories: string[] = [], runtimes: ProviderChatRuntime[] = []
afterEach(() => { runtimes.forEach((runtime) => { try { runtime.close() } catch {} }); runtimes.length = 0; directories.forEach((directory) => rmSync(directory, { recursive: true, force: true })); directories.length = 0 })
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'aerio-provider-')); directories.push(directory)
  const vault = new ChatVault(join(directory, 'vault'), { assertSecure() {}, encrypt: (value) => Buffer.from(value), decrypt: (value) => value.toString() })
  let locked = false, online = true
  const room = (id: string): ProviderChatRoom => ({ accountId: id, id: 'room', name: 'Secret room name', kind: 'direct', unread: 1, lastActivity: '2026-01-01T00:00:00Z', canSend: true, canReadReceipt: true, threaded: false, resource: {} })
  const message = { id: 'm', senderId: 'user', sender: 'User', timestamp: '2026-01-01T00:00:00Z', body: 'Sensitive message', own: true }
  const adapter: ProviderChatAdapter = { descriptor: () => ({ id: 'teams', name: 'Teams', available: true, detail: '', fields: [] }), connect: vi.fn(async () => ({ remoteUserId: 'tenant:user', name: 'Secret account', secret: { token: 'secret-token' } })), rooms: vi.fn(async (session) => [room(session.account.id)]), messages: vi.fn(async () => ({ items: [message] })), send: vi.fn(async () => message), markRead: vi.fn(async () => {}) }
  const notify = vi.fn(), changed = vi.fn(), path = join(directory, 'chat.sqlite')
  const open = () => { const runtime = new ProviderChatRuntime({ path, vault, adapters: [adapter], assertSecure() {}, locked: () => locked, online: () => online, notificationsEnabled: () => true, changed, notify }); runtimes.push(runtime); return runtime }
  return { open, adapter, message, path, notify, changed, setLocked: (value: boolean) => { locked = value }, setOnline: (value: boolean) => { online = value } }
}
it('encrypts cached payloads, redacts on lock, and permits cached history offline', async () => {
  const f = fixture(), runtime = f.open(), account = await runtime.connect('teams', {})
  await runtime.messages(account.id, 'room')
  f.setOnline(false)
  expect(await runtime.messages(account.id, 'room')).toMatchObject({ stale: true, items: [{ body: 'Sensitive message' }] })
  await expect(runtime.send(account.id, 'room', 'draft')).rejects.toThrow('Offline')
  f.setLocked(true)
  expect(runtime.snapshot()).toMatchObject({ accounts: [], rooms: [] })
  await expect(runtime.messages(account.id, 'room')).rejects.toThrow('Unlock')
  runtime.close()
  expect(readFileSync(f.path).toString()).not.toMatch(/Sensitive message|Secret room name|Secret account|secret-token/)
})
it('persists account cooldown and blocks polling, message loads and sends without API calls', async () => {
  const f = fixture(), runtime = f.open(), account = await runtime.connect('teams', {})
  vi.mocked(f.adapter.rooms).mockRejectedValue(new ProviderChatError('Slow down', 'rate-limit', 600))
  await expect(runtime.refresh(account.id)).rejects.toThrow('Slow down')
  const count = vi.mocked(f.adapter.rooms).mock.calls.length
  await runtime.refreshAll()
  await expect(runtime.messages(account.id, 'room')).rejects.toThrow('pause')
  await expect(runtime.send(account.id, 'room', 'hello')).rejects.toThrow('pause')
  expect(f.adapter.rooms).toHaveBeenCalledTimes(count); expect(f.adapter.send).not.toHaveBeenCalled(); expect(f.adapter.messages).not.toHaveBeenCalled()
  runtime.close()
  const reopened = f.open(); expect(reopened.snapshot().accounts[0].retryAt).toBeDefined()
  await reopened.refreshAll(); expect(f.adapter.rooms).toHaveBeenCalledTimes(count)
})
it('records uncertain sends durably and never automatically replays after restart', async () => {
  const f = fixture(), runtime = f.open(), account = await runtime.connect('teams', {})
  vi.mocked(f.adapter.send).mockRejectedValue(new ProviderChatError('Unknown delivery', 'uncertain'))
  await expect(runtime.send(account.id, 'room', 'Check before resending')).rejects.toThrow('Unknown')
  expect(vi.mocked(f.adapter.send).mock.calls[0][4]).toMatch(/^[a-f0-9-]{36}$/)
  runtime.close()
  const reopened = f.open(); await reopened.refreshAll()
  const page = await reopened.messages(account.id, 'room')
  expect(page.items).toContainEqual(expect.objectContaining({ body: 'Check before resending', delivery: 'review' }))
  expect(f.adapter.send).toHaveBeenCalledTimes(1)
})
it('converts process-interrupted sending records to review on startup without replay', async () => {
  const f = fixture(), runtime = f.open(), account = await runtime.connect('teams', {})
  runtime.store.saveSend(account.id, 'room', { ...f.message, id: 'interrupted', body: 'Interrupted send', delivery: 'sending', timestamp: new Date().toISOString() })
  runtime.close()
  const reopened = f.open(), page = await reopened.messages(account.id, 'room')
  expect(page.items).toContainEqual(expect.objectContaining({ id: 'interrupted', delivery: 'review' }))
  expect(f.adapter.send).not.toHaveBeenCalled()
})
it('does not resurrect a removed account when refresh or send completes late', async () => {
  const f = fixture(), runtime = f.open(), account = await runtime.connect('teams', {})
  let finish!: (value: ProviderChatRoom[]) => void
  vi.mocked(f.adapter.rooms).mockImplementation(() => new Promise((resolve) => { finish = resolve }))
  const refreshing = runtime.refresh(account.id)
  let sent!: (value: typeof f.message) => void
  vi.mocked(f.adapter.send).mockImplementation(() => new Promise((resolve) => { sent = resolve }))
  const sending = runtime.send(account.id, 'room', 'late')
  await runtime.remove(account.id)
  finish([]); sent(f.message)
  await expect(refreshing).rejects.toThrow('changed'); await expect(sending).rejects.toThrow('changed')
  expect(runtime.snapshot().accounts).toEqual([]); expect(f.notify).not.toHaveBeenCalled()
})
it('rejects lock-raced plaintext results and suppresses notifications', async () => {
  const f = fixture(), runtime = f.open(), account = await runtime.connect('teams', {})
  let finish!: (value: { items: typeof f.message[] }) => void
  vi.mocked(f.adapter.messages).mockImplementation(() => new Promise((resolve) => { finish = resolve }))
  const pending = runtime.messages(account.id, 'room')
  f.setLocked(true); finish({ items: [f.message] })
  await expect(pending).rejects.toThrow('Unlock'); expect(f.notify).not.toHaveBeenCalled()
})
it('deduplicates scoped identities and rejects reconnecting as another user', async () => {
  const f = fixture(), runtime = f.open(), first = await runtime.connect('teams', {})
  expect((await runtime.connect('teams', {})).id).toBe(first.id)
  vi.mocked(f.adapter.connect).mockResolvedValue({ remoteUserId: 'other:user', name: 'Other', secret: {} })
  await expect(runtime.connect('teams', {}, first.id)).rejects.toThrow('same Chat identity')
  expect(runtime.snapshot().accounts).toHaveLength(1)
})
