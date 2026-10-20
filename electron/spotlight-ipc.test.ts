import { expect, it, vi } from 'vitest'
import { registerSpotlightIpc } from './spotlight-ipc'
import type { SpotlightRuntime } from './spotlight'
it('reports platform unavailability and denies isolated services and mutations without a macOS runtime', () => {
  const handlers = new Map<string, any>()
  registerSpotlightIpc({ ipc: { handle: (channel, handler) => { handlers.set(channel, handler) } }, runtime: () => null, isServiceSender: (id) => id === 9, locked: () => false })
  expect(handlers.get('spotlight:status')({ sender: { id: 1 } })).toMatchObject({ platformSupported: false, available: false })
  expect(() => handlers.get('spotlight:status')({ sender: { id: 9 } })).toThrow('isolated')
  expect(() => handlers.get('spotlight:save')({ sender: { id: 1 } }, {})).toThrow('macOS')
})
it('redacts account selections while locked and delegates validated settings/refresh to runtime', () => {
  const handlers = new Map<string, any>(), save = vi.fn(), refresh = vi.fn()
  const runtime = { status: () => ({ available: true, settings: { enabled: true, accountIds: ['private'], includePreview: true }, indexed: 7 }), save, refresh } as unknown as SpotlightRuntime
  registerSpotlightIpc({ ipc: { handle: (channel, handler) => { handlers.set(channel, handler) } }, runtime: () => runtime, isServiceSender: () => false, locked: () => true })
  expect(handlers.get('spotlight:status')({ sender: { id: 1 } })).toMatchObject({ settings: { accountIds: [], includePreview: false }, indexed: 0 })
})
