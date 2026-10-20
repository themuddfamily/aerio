import type { IpcMain } from 'electron'
import type { ProviderChatId } from '../../../src/provider-chat-types'
import type { ProviderChatRuntime } from './runtime'

const id = (value: unknown) => { if (typeof value !== 'string' || !value || value.length > 12_000) throw new Error('Invalid Chat identity'); return value }
export function registerProviderChatIpc(options: { ipc: Pick<IpcMain, 'handle'>; runtime: ProviderChatRuntime; locked(): boolean; isServiceSender(id: number): boolean }) {
  const handle = (name: string, action: (...args: any[]) => unknown) => options.ipc.handle(`provider-chat:${name}`, (event, ...args) => {
    if (options.isServiceSender(event.sender.id)) throw new Error('Provider Chat is not available to isolated services')
    if (name !== 'snapshot' && options.locked()) throw new Error('Unlock Aerio to use Chat')
    return action(...args)
  })
  handle('snapshot', () => options.runtime.snapshot())
  handle('connect', (provider: unknown, value: unknown, accountId: unknown) => {
    if (typeof provider !== 'string' || !options.runtime.snapshot().providers.some((item) => item.id === provider)) throw new Error('Unsupported Chat provider')
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 20 || !Object.entries(value).every(([key, item]) => key.length < 80 && (typeof item === 'boolean' || (typeof item === 'string' && item.length <= 16_000)))) throw new Error('Invalid Chat connection fields')
    return options.runtime.connect(provider as ProviderChatId, value as Record<string, string | boolean>, accountId === undefined ? undefined : id(accountId))
  })
  handle('remove', (accountId) => options.runtime.remove(id(accountId)))
  handle('refresh', (accountId) => options.runtime.refresh(id(accountId)))
  handle('messages', (accountId, roomId, value) => {
    if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) throw new Error('Invalid Chat page options')
    return options.runtime.messages(id(accountId), id(roomId), { ...(value?.cursor === undefined ? {} : { cursor: id(value.cursor) }), ...(value?.threadId === undefined ? {} : { threadId: id(value.threadId) }) })
  })
  handle('send', (accountId, roomId, body, threadId) => {
    if (typeof body !== 'string' || !body.trim() || body.length > 28_000) throw new Error('Enter a message of at most 28,000 characters')
    return options.runtime.send(id(accountId), id(roomId), body, threadId === undefined ? undefined : id(threadId))
  })
  handle('read', (accountId, roomId) => options.runtime.markRead(id(accountId), id(roomId)))
  handle('preferences', (accountId, previews) => { if (typeof previews !== 'boolean') throw new Error('Invalid notification preference'); return options.runtime.preferences(id(accountId), previews) })
}
