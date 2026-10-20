import type { IpcMain } from 'electron'
import type { SpotlightRuntime } from './spotlight'
import { DEFAULT_SPOTLIGHT } from './spotlight-store'
export function registerSpotlightIpc(options: { ipc: Pick<IpcMain, 'handle'>; runtime(): SpotlightRuntime | null; isServiceSender(id: number): boolean; locked(): boolean }) {
  const status = () => options.runtime()?.status() ?? { platformSupported: false, available: false, settings: structuredClone(DEFAULT_SPOTLIGHT), indexed: 0, limit: 10_000, syncing: false }
  const handle = (name: string, action: (...args: any[]) => unknown) => options.ipc.handle(`spotlight:${name}`, (event, ...args) => {
    if (options.isServiceSender(event.sender.id)) throw new Error('Spotlight settings are unavailable to isolated services')
    return action(...args)
  })
  handle('status', () => { const value = status(); return options.locked() ? { ...value, settings: { ...value.settings, accountIds: [], includePreview: false }, indexed: 0, error: 'Unlock Aerio to manage Spotlight' } : value })
  handle('save', (settings) => { if (!options.runtime()) throw new Error('Spotlight integration requires macOS'); return options.runtime()!.save(settings) })
  handle('refresh', () => { if (!options.runtime()) throw new Error('Spotlight integration requires macOS'); return options.runtime()!.refresh() })
}
