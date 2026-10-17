// @vitest-environment jsdom

import { beforeAll, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, Array<(...args: any[]) => void>>()
  return {
    exposed: {} as Record<string, any>,
    listeners,
    contextBridge: { exposeInMainWorld: vi.fn((name: string, value: any) => { mocks.exposed[name] = value }) },
    ipcRenderer: {
      invoke: vi.fn(async (channel: string, ...args: any[]) => ({ channel, args })),
      on: vi.fn((channel: string, listener: (...args: any[]) => void) => { listeners.set(channel, [...(listeners.get(channel) ?? []), listener]) }),
      removeListener: vi.fn()
    }
  }
})

vi.mock('electron', () => ({ contextBridge: mocks.contextBridge, ipcRenderer: mocks.ipcRenderer }))

import './preload'

describe('preload server-synchronized Notes bridge', () => {
  beforeAll(async () => { await Promise.resolve() })

  it('maps every command to its IPC channel and forwards change events', async () => {
    const api = mocks.exposed.aerio.serverNotes
    const note = { id: 'n', title: 'T' }
    const target = { kind: 'server', folderId: 'f' }
    const transfer = { mode: 'move', target, serverNoteIds: ['n'] }
    const importRequest = { token: 't', target, duplicates: 'skip' }
    await api.snapshot()
    await api.sync('dav-1')
    await api.create('f', note)
    await api.update(note)
    await api.remove('n')
    await api.resolve('op', 'keep-both')
    await api.transfer(transfer)
    await api.chooseVNoteFile(target)
    await api.previewVNote('t', target)
    await api.importVNote(importRequest)
    await api.accountSummary('dav-1')
    await api.copyAccountToLocal('dav-1')
    for (const call of [
      ['server-notes:snapshot'], ['server-notes:sync', 'dav-1'], ['server-notes:create', 'f', note], ['server-notes:update', note], ['server-notes:remove', 'n'],
      ['server-notes:resolve', 'op', 'keep-both'], ['server-notes:transfer', transfer], ['server-notes:vnote-choose', target], ['server-notes:vnote-preview', 't', target],
      ['server-notes:vnote-import', importRequest], ['server-notes:account-summary', 'dav-1'], ['server-notes:copy-account-local', 'dav-1']
    ]) expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith(...call)

    const changed = vi.fn()
    const stop = api.onChanged(changed)
    const snapshot = { accounts: [], folders: [], notes: [], review: [] }
    mocks.listeners.get('server-notes:changed')?.[0]({}, snapshot)
    expect(changed).toHaveBeenCalledWith(snapshot)
    stop()
    expect(mocks.ipcRenderer.removeListener).toHaveBeenCalledWith('server-notes:changed', expect.any(Function))
  })
})
