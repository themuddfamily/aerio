import { ChatServiceError, ChatServiceRuntime, type ChatServiceCommand, type ChatServiceEvent } from './runtime'
import type { SerializedServiceError } from './event-mapping'

/** Bridge exposed by electron/chat/service-preload.ts; the only channel out of the service. */
interface ChatServiceBridge {
  onCommand(callback: (message: { id: number; command: ChatServiceCommand }) => void): void
  reply(id: number, result: { ok: true; value: unknown } | { ok: false; error: SerializedServiceError }): void
  emit(event: ChatServiceEvent | { type: 'ready' }): void
}

const bridge = (window as unknown as { aerioChatService: ChatServiceBridge }).aerioChatService
const runtime = new ChatServiceRuntime((event) => bridge.emit(event))

bridge.onCommand(({ id, command }) => {
  void runtime.handle(command).then(
    (value) => bridge.reply(id, { ok: true, value }),
    (error) => bridge.reply(id, { ok: false, error: error instanceof ChatServiceError ? error.detail : { kind: 'other', message: 'The chat service failed' } })
  )
})
window.addEventListener('beforeunload', () => runtime.stop())
bridge.emit({ type: 'ready' })
