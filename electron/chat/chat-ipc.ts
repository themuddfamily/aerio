import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { ChatAccountPreferences, ChatPasswordLoginInput, ChatSnapshot } from '../../src/chat-types'
import type { ChatService } from './chat-service'

/**
 * Renderer-facing Chat IPC. Every handler rejects calls from a chat service
 * webContents, validates argument shapes, and returns only display data.
 * When Chat is unavailable (gate closed or not initialized) only `chat:snapshot`
 * answers, with the gate diagnostic. While Aerio is locked every command is
 * refused here as well as in the service, and the snapshot carries no rooms.
 */
export interface ChatIpcOptions {
  service: () => ChatService | undefined
  unavailable: () => ChatSnapshot
  isServiceSender: (senderId: number) => boolean
  isLocked?: () => boolean
}

const id = (value: unknown, label = 'identifier'): string => {
  if (typeof value !== 'string' || !value || value.length > 512) throw new Error(`Invalid chat ${label}`)
  return value
}

const PREFERENCE_FLAGS = ['notificationPreviews', 'sendWhileLocked', 'typingNotifications', 'readReceipts'] as const

/** Copies only known preference fields with the expected primitive types. */
export function chatPreferencePatch(value: unknown): Partial<ChatAccountPreferences> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid chat preferences')
  const input = value as Record<string, unknown>
  const patch: Partial<ChatAccountPreferences> = {}
  for (const key of PREFERENCE_FLAGS) {
    if (input[key] === undefined) continue
    if (typeof input[key] !== 'boolean') throw new Error('Invalid chat preferences')
    patch[key] = input[key]
  }
  if (input.retention !== undefined) {
    const retention = input.retention as Record<string, unknown> | null
    if (!retention || typeof retention !== 'object' || !Number.isFinite(retention.historyDays) || !Number.isFinite(retention.mediaCacheMiB)) throw new Error('Invalid chat retention')
    patch.retention = { historyDays: Number(retention.historyDays), mediaCacheMiB: Number(retention.mediaCacheMiB) }
  }
  return patch
}

const text = (value: unknown, limit: number) => typeof value === 'string' ? value.slice(0, limit) : ''
// Message bodies are refused rather than silently truncated.
const messageBody = (value: unknown) => {
  if (typeof value !== 'string') return ''
  if (value.length > 65_536) throw new Error('This message is too long to send')
  return value
}

const ROOM_ACTIONS = new Set(['accept', 'decline', 'leave', 'mute', 'unmute', 'allow-previews', 'block-previews', 'release-hold'])
const VERIFICATION_ACTIONS = new Set(['accept', 'start-sas', 'confirm', 'mismatch', 'cancel'])

export function registerChatIpc(ipc: Pick<IpcMain, 'handle'>, options: ChatIpcOptions) {
  const handle = (channel: string, handler: (service: ChatService, ...args: any[]) => unknown) => {
    ipc.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (options.isServiceSender(event.sender.id)) throw new Error('Chat commands are not available to the chat service')
      if (options.isLocked?.()) throw new Error('Unlock Aerio to use Chat')
      const service = options.service()
      if (!service) throw new Error(options.unavailable().gate.message)
      return handler(service, ...args)
    })
  }
  ipc.handle('chat:snapshot', (event) => {
    if (options.isServiceSender(event.sender.id)) throw new Error('Chat commands are not available to the chat service')
    return options.service()?.snapshot() ?? options.unavailable()
  })
  handle('chat:discover', (service, input: unknown) => service.discover(id(input, 'homeserver')))
  handle('chat:login', (service, input: ChatPasswordLoginInput) => {
    if (!input || typeof input !== 'object') throw new Error('Enter a homeserver, user name and password')
    // The password is passed through once to the validated homeserver and never stored.
    return service.login({ homeserver: id(input.homeserver, 'homeserver'), user: id(input.user, 'user name'), password: text(input.password, 1024) })
  })
  handle('chat:account:remove', (service, accountId) => service.removeAccount(id(accountId)))
  handle('chat:account:clear-history', (service, accountId) => service.clearHistory(id(accountId)))
  handle('chat:account:preferences', (service, accountId, preferences: unknown) => service.updatePreferences(id(accountId), chatPreferencePatch(preferences)))
  handle('chat:timeline', (service, accountId, roomId) => service.timeline(id(accountId), id(roomId)))
  handle('chat:timeline:older', (service, accountId, roomId) => service.loadOlder(id(accountId), id(roomId)))
  handle('chat:search', (service, accountId, query) => service.search(id(accountId), text(query, 200)))
  handle('chat:send', (service, accountId, roomId, body, replyTo) => service.send(id(accountId), id(roomId), messageBody(body), replyTo === undefined ? undefined : id(replyTo)))
  handle('chat:edit', (service, accountId, roomId, targetId, body) => service.edit(id(accountId), id(roomId), id(targetId), messageBody(body)))
  handle('chat:redact', (service, accountId, roomId, targetId) => service.redact(id(accountId), id(roomId), id(targetId)))
  handle('chat:react', (service, accountId, roomId, targetId, key) => service.react(id(accountId), id(roomId), id(targetId), text(key, 64)))
  handle('chat:outbox:cancel', (service, outboxId) => service.cancelOutgoing(id(outboxId)))
  handle('chat:outbox:retry', (service, outboxId) => service.retryOutgoing(id(outboxId)))
  handle('chat:attach', (service, accountId, roomId) => service.attach(id(accountId), id(roomId)))
  handle('chat:media:save', (service, accountId, mediaId) => service.saveMedia(id(accountId), id(mediaId)))
  handle('chat:read', (service, accountId, roomId) => service.markRead(id(accountId), id(roomId)))
  handle('chat:room', (service, accountId, roomId, action) => {
    if (!ROOM_ACTIONS.has(action)) throw new Error('Unsupported room action')
    return service.roomAction(id(accountId), id(roomId), action)
  })
  handle('chat:devices', (service, accountId) => service.devices(id(accountId)))
  handle('chat:verify-own', (service, accountId) => service.verifyOwnDevice(id(accountId)))
  handle('chat:verification', (service, accountId, requestId, action) => {
    if (!VERIFICATION_ACTIONS.has(action)) throw new Error('Unsupported verification action')
    return service.verificationAction(id(accountId), id(requestId), action)
  })
  handle('chat:recovery:restore', (service, accountId, key) => service.restoreFromRecoveryKey(id(accountId), text(key, 256)))
  handle('chat:recovery:setup', (service, accountId) => service.setupRecovery(id(accountId)))
}
