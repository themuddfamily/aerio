import { describe, expect, it, vi } from 'vitest'
import { registerMailFolderPreferenceHandlers, validateFavoriteAlias, validateFavoriteOrder, validateFolderAppearance } from './folder-preference-ipc'

function setup() {
  const handlers = new Map<string, (...args: any[]) => any>()
  const request = vi.fn(async (_command: unknown) => ({ favorites: [], appearance: [] }))
  registerMailFolderPreferenceHandlers({ handle: (channel: string, handler: any) => handlers.set(channel, handler) } as any, request)
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args)
  return { handlers, invoke, request }
}

describe('folder preference IPC', () => {
  it('maps every channel to a validated worker command', async () => {
    const { handlers, invoke, request } = setup()
    expect([...handlers.keys()].sort()).toEqual([
      'mail:folder-preferences:add-favorite', 'mail:folder-preferences:get', 'mail:folder-preferences:remove-favorite',
      'mail:folder-preferences:reorder', 'mail:folder-preferences:set-alias', 'mail:folder-preferences:set-appearance'
    ])
    await invoke('mail:folder-preferences:get')
    await invoke('mail:folder-preferences:add-favorite', 'imap', 'folder:Projects')
    await invoke('mail:folder-preferences:remove-favorite', 'imap', 'folder:Projects')
    await invoke('mail:folder-preferences:reorder', [{ accountId: 'gmail', labelId: 'Label_1' }, { accountId: 'imap', labelId: 'folder:Projects' }])
    await invoke('mail:folder-preferences:set-alias', 'imap', 'folder:Projects', '  Client work  ')
    await invoke('mail:folder-preferences:set-alias', 'imap', 'folder:Projects', '   ')
    await invoke('mail:folder-preferences:set-appearance', { accountId: 'imap', labelId: 'folder:Projects', icon: 'briefcase', color: '#1A73E8', hidden: false })
    expect(request.mock.calls.map(([command]) => command)).toEqual([
      { type: 'folder-preferences:get' },
      { type: 'folder-preferences:add-favorite', payload: { accountId: 'imap', labelId: 'folder:Projects' } },
      { type: 'folder-preferences:remove-favorite', payload: { accountId: 'imap', labelId: 'folder:Projects' } },
      { type: 'folder-preferences:reorder', payload: { order: [{ accountId: 'gmail', labelId: 'Label_1' }, { accountId: 'imap', labelId: 'folder:Projects' }] } },
      { type: 'folder-preferences:set-alias', payload: { accountId: 'imap', labelId: 'folder:Projects', alias: 'Client work' } },
      { type: 'folder-preferences:set-alias', payload: { accountId: 'imap', labelId: 'folder:Projects', alias: null } },
      { type: 'folder-preferences:set-appearance', payload: { accountId: 'imap', labelId: 'folder:Projects', icon: 'briefcase', color: '#1a73e8', hidden: false } }
    ])
  })

  it('rejects malformed input before it reaches the worker', () => {
    const { invoke, request } = setup()
    expect(() => invoke('mail:folder-preferences:add-favorite', '', 'folder:Projects')).toThrow(/account is invalid/)
    expect(() => invoke('mail:folder-preferences:add-favorite', 'imap', 42)).toThrow(/folder is invalid/)
    expect(() => validateFavoriteOrder('nope')).toThrow(/order is invalid/)
    expect(() => validateFavoriteOrder([{ accountId: 'a', labelId: 'x' }, { accountId: 'a', labelId: 'x' }])).toThrow(/listed twice/)
    expect(() => validateFavoriteOrder([null])).toThrow(/order is invalid/)
    expect(() => validateFavoriteAlias('a'.repeat(121))).toThrow(/120 characters/)
    expect(() => validateFavoriteAlias('bad\u0007name')).toThrow(/control characters/)
    expect(() => validateFavoriteAlias(7)).toThrow(/invalid/)
    expect(() => validateFolderAppearance({ accountId: 'a', labelId: 'x', icon: 'rocket' })).toThrow(/folder icons/)
    expect(() => validateFolderAppearance({ accountId: 'a', labelId: 'x', color: 'red' })).toThrow(/valid color/)
    expect(() => validateFolderAppearance({ accountId: 'a', labelId: 'x', hidden: 'yes' })).toThrow(/visibility/)
    expect(() => validateFolderAppearance({ accountId: 'a', labelId: 'x', name: 'Renamed' })).toThrow(/appearance is invalid/)
    expect(validateFolderAppearance({ accountId: 'a', labelId: 'x', icon: null, color: null })).toEqual({ accountId: 'a', labelId: 'x', icon: null, color: null })
    expect(request).not.toHaveBeenCalled()
  })
})
