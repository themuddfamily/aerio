import { describe, expect, it, vi } from 'vitest'
import type { ChatGateStatus, ChatSnapshot } from '../../src/chat-types'
import { chatPreferencePatch, registerChatIpc } from './chat-ipc'
import type { ChatService } from './chat-service'

/** Renderer-facing Chat IPC: sender isolation, lock enforcement, gate fallback and argument validation. */
const closedGate: ChatGateStatus = { enabled: false, preview: false, checks: [], sdkVersion: 'test', message: 'Chat stays unavailable until these checks pass: two-device interoperability.' }
const unavailable = (): ChatSnapshot => ({ gate: closedGate, accounts: [], rooms: [], verifications: [] })

function setup(options: { service?: Partial<Record<keyof ChatService, unknown>>; locked?: boolean } = {}) {
  const handlers = new Map<string, (event: { sender: { id: number } }, ...args: unknown[]) => unknown>()
  const state = { locked: options.locked ?? false, service: options.service as ChatService | undefined }
  registerChatIpc({ handle: (channel: string, handler: any) => { handlers.set(channel, handler) } } as never, {
    service: () => state.service,
    unavailable,
    isServiceSender: (id) => id === 99,
    isLocked: () => state.locked
  })
  const invoke = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`Missing ${channel}`)
    return handler({ sender: { id: 1 } }, ...args)
  }
  return { handlers, state, invoke }
}

function fakeService() {
  return {
    snapshot: vi.fn(() => ({ gate: { ...closedGate, enabled: true }, accounts: [], rooms: [], verifications: [] })),
    discover: vi.fn(async () => ({})), login: vi.fn(async () => ({})), removeAccount: vi.fn(), clearHistory: vi.fn(), updatePreferences: vi.fn(),
    timeline: vi.fn(), loadOlder: vi.fn(), search: vi.fn(), send: vi.fn(), edit: vi.fn(), redact: vi.fn(), react: vi.fn(),
    cancelOutgoing: vi.fn(), retryOutgoing: vi.fn(), attach: vi.fn(), saveMedia: vi.fn(), markRead: vi.fn(), roomAction: vi.fn(),
    devices: vi.fn(), verifyOwnDevice: vi.fn(), verificationAction: vi.fn(), restoreFromRecoveryKey: vi.fn(), setupRecovery: vi.fn()
  }
}

describe('chat IPC', () => {
  it('registers every renderer channel the preload bridge uses', () => {
    const { handlers } = setup()
    expect([...handlers.keys()].sort()).toEqual([
      'chat:account:clear-history', 'chat:account:preferences', 'chat:account:remove', 'chat:attach', 'chat:devices', 'chat:discover', 'chat:edit', 'chat:login',
      'chat:media:save', 'chat:outbox:cancel', 'chat:outbox:retry', 'chat:react', 'chat:read', 'chat:recovery:restore', 'chat:recovery:setup', 'chat:redact',
      'chat:room', 'chat:search', 'chat:send', 'chat:snapshot', 'chat:timeline', 'chat:timeline:older', 'chat:verification', 'chat:verify-own'
    ])
  })

  it('answers only the gate diagnostic while Chat is unavailable', () => {
    const { invoke } = setup()
    expect(invoke('chat:snapshot')).toEqual(unavailable())
    expect(() => invoke('chat:timeline', 'a', '!r')).toThrow(closedGate.message)
    expect(() => invoke('chat:login', { homeserver: 'https://matrix.example', user: 'alice', password: 'x' })).toThrow(closedGate.message)
  })

  it('refuses every call from a chat service webContents, including the snapshot', () => {
    const { handlers } = setup({ service: fakeService() })
    for (const [channel, handler] of handlers) expect(() => handler({ sender: { id: 99 } }), channel).toThrow(/not available to the chat service/)
  })

  it('refuses commands while Aerio is locked but still reports the (empty) snapshot', () => {
    const service = fakeService()
    const { invoke, state } = setup({ service, locked: true })
    expect(() => invoke('chat:send', 'a', '!r', 'hello')).toThrow('Unlock Aerio to use Chat')
    expect(() => invoke('chat:recovery:restore', 'a', 'key')).toThrow('Unlock Aerio to use Chat')
    expect(service.send).not.toHaveBeenCalled()
    invoke('chat:snapshot')
    expect(service.snapshot).toHaveBeenCalled()
    state.locked = false
    invoke('chat:send', 'a', '!r', 'hello')
    expect(service.send).toHaveBeenCalledWith('a', '!r', 'hello', undefined)
  })

  it('validates identifiers, actions and text before calling the service', () => {
    const service = fakeService()
    const { invoke } = setup({ service })
    expect(() => invoke('chat:timeline', '', '!r')).toThrow(/Invalid chat identifier/)
    expect(() => invoke('chat:timeline', 'a', 'x'.repeat(513))).toThrow(/Invalid chat identifier/)
    expect(() => invoke('chat:timeline', 'a', { roomId: '!r' })).toThrow(/Invalid chat identifier/)
    expect(() => invoke('chat:room', 'a', '!r', 'ban')).toThrow('Unsupported room action')
    expect(() => invoke('chat:verification', 'a', 'request', 'trust-anyway')).toThrow('Unsupported verification action')
    expect(() => invoke('chat:login', null)).toThrow(/Enter a homeserver/)
    expect(() => invoke('chat:send', 'a', '!r', 'x'.repeat(65_537))).toThrow('This message is too long to send')
    expect(() => invoke('chat:send', 'a', '!r', 'hi', 42)).toThrow(/Invalid chat identifier/)
    invoke('chat:login', { homeserver: 'https://matrix.example', user: '@alice:matrix.example', password: 42 })
    expect(service.login).toHaveBeenCalledWith({ homeserver: 'https://matrix.example', user: '@alice:matrix.example', password: '' })
    invoke('chat:search', 'a', 'q'.repeat(500))
    expect(service.search).toHaveBeenCalledWith('a', 'q'.repeat(200))
    invoke('chat:react', 'a', '!r', '$e', { emoji: true })
    expect(service.react).toHaveBeenCalledWith('a', '!r', '$e', '')
    invoke('chat:room', 'a', '!r', 'mute')
    invoke('chat:verification', 'a', 'request', 'confirm')
    invoke('chat:recovery:setup', 'a')
    invoke('chat:recovery:restore', 'a', 'EsTc 1234')
    expect(service.roomAction).toHaveBeenCalledWith('a', '!r', 'mute')
    expect(service.verificationAction).toHaveBeenCalledWith('a', 'request', 'confirm')
    expect(service.setupRecovery).toHaveBeenCalledWith('a')
    expect(service.restoreFromRecoveryKey).toHaveBeenCalledWith('a', 'EsTc 1234')
  })

  it('copies only known, well-typed preference fields', () => {
    expect(chatPreferencePatch({ notificationPreviews: true, retention: { historyDays: 7, mediaCacheMiB: 64 }, accessToken: 'leak' }))
      .toEqual({ notificationPreviews: true, retention: { historyDays: 7, mediaCacheMiB: 64 } })
    expect(chatPreferencePatch({})).toEqual({})
    expect(() => chatPreferencePatch(null)).toThrow('Invalid chat preferences')
    expect(() => chatPreferencePatch([])).toThrow('Invalid chat preferences')
    expect(() => chatPreferencePatch({ readReceipts: 'yes' })).toThrow('Invalid chat preferences')
    expect(() => chatPreferencePatch({ retention: { historyDays: 'forever', mediaCacheMiB: 1 } })).toThrow('Invalid chat retention')
    expect(() => chatPreferencePatch({ retention: null })).toThrow('Invalid chat retention')
  })
})
