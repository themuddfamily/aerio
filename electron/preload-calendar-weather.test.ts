// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ exposed: {} as Record<string, any>, invoke: vi.fn(async () => undefined) }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: (name: string, value: unknown) => { mocks.exposed[name] = value } }, ipcRenderer: { invoke: mocks.invoke, on: vi.fn(), removeListener: vi.fn() } }))
import './preload'
describe('calendar weather preload bridge', () => {
  it('forwards only structured weather actions to their IPC channels', async () => {
    mocks.invoke.mockClear()
    const api = mocks.exposed.aerio.calendarWeather
    const settings = { enabled: true, unit: 'celsius', location: { name: 'London', latitude: 51.5, longitude: -0.12 } }
    await api.settings(); await api.configure(settings); await api.search('London'); await api.forecast()
    expect(mocks.invoke.mock.calls).toEqual([['calendar:weather:settings'], ['calendar:weather:configure', settings], ['calendar:weather:search', 'London'], ['calendar:weather:forecast']])
  })
})
