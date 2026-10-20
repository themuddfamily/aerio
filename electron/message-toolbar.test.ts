import { describe, expect, it, vi } from 'vitest'
import { registerMessageToolbar } from './message-toolbar'
import { createDefaultPreferences } from '../src/preferences'

describe('message toolbar persistence', () => {
  it('patches current preferences, persists ordering and broadcasts only after successful save', () => {
    const handlers = new Map<string, (event: unknown, input?: unknown) => unknown>()
    let preferences = { ...createDefaultPreferences(), settings: { ...createDefaultPreferences().settings, theme: 'dark' as const, profile: { displayName: 'Current user' } } }
    const broadcast = vi.fn()
    registerMessageToolbar({ ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler) } }, load: () => preferences, save: (next) => { preferences = next as typeof preferences }, broadcast })
    expect(handlers.get('message-toolbar:set')!(null, ['trash', 'reply'])).toEqual(['trash', 'reply'])
    expect(preferences.settings.theme).toBe('dark')
    expect(preferences.settings.profile.displayName).toBe('Current user')
    expect(handlers.get('message-toolbar:get')!(null)).toEqual(['trash', 'reply'])
    expect(broadcast).toHaveBeenCalledWith(['trash', 'reply'])
    expect(() => handlers.get('message-toolbar:set')!(null, ['unsupported'])).toThrow(/Invalid/)
    expect(broadcast).toHaveBeenCalledTimes(1)
  })
  it('does not broadcast failed saves and permits hiding all commands', () => {
    const handlers = new Map<string, (event: unknown, input?: unknown) => unknown>(), broadcast = vi.fn()
    registerMessageToolbar({ ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler) } }, load: createDefaultPreferences, save: () => { throw new Error('disk full') }, broadcast })
    expect(() => handlers.get('message-toolbar:set')!(null, [])).toThrow('disk full')
    expect(broadcast).not.toHaveBeenCalled()
  })
})
