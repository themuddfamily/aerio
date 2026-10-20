import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CalendarWeatherService, registerCalendarWeather, WEATHER_CACHE_MS } from './calendar-weather'

const location = { name: 'London, England, United Kingdom', latitude: 51.5, longitude: -0.12 }
const settings = { enabled: true, unit: 'celsius' as const, location }
const forecast = () => new Response(JSON.stringify({ timezone: 'Europe/London', daily: { time: ['2026-10-20', '2026-10-21'], weather_code: [3, 61], temperature_2m_max: [15, 13], temperature_2m_min: [8, 6], precipitation_probability_max: [0, 80] } }))
const instances: CalendarWeatherService[] = [], directories: string[] = []
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'aerio-weather-')); directories.push(directory)
  const request = vi.fn<typeof fetch>().mockImplementation(async () => forecast())
  let now = Date.parse('2026-10-20T08:00:00Z')
  const service = new CalendarWeatherService(join(directory, 'weather.sqlite'), request, () => now); instances.push(service)
  return { service, request, path: join(directory, 'weather.sqlite'), advance: (ms: number) => { now += ms } }
}
afterEach(() => { for (const service of instances.splice(0)) service.close(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('Calendar weather provider service', () => {
  it('starts disabled, performs no network request, and requires explicit opt-in and a location', async () => {
    const { service, request } = setup()
    expect(service.settings()).toEqual({ enabled: false, unit: 'celsius' })
    await expect(service.search('London')).rejects.toThrow(/Enable/)
    await expect(service.forecast()).rejects.toThrow(/Enable/)
    service.configure({ enabled: true, unit: 'celsius' })
    await expect(service.forecast()).rejects.toThrow(/Choose/)
    expect(request).not.toHaveBeenCalled()
  })

  it('validates IPC settings and keeps requests on fixed hosts with encoded queries', async () => {
    const { service, request } = setup()
    for (const value of [null, {}, { ...settings, unit: 'kelvin' }, { ...settings, location: { ...location, latitude: 91 } }, { ...settings, location: { ...location, longitude: Infinity } }]) expect(() => service.configure(value)).toThrow(/Invalid/)
    service.configure(settings)
    await expect(service.search('x')).rejects.toThrow(/2–100/)
    request.mockResolvedValueOnce(new Response(JSON.stringify({ results: [{ name: 'London', admin1: 'England', country: 'United Kingdom', latitude: 51.5, longitude: -0.12 }, { name: 'Invalid', latitude: 200, longitude: 0 }] })))
    expect(await service.search('London&count=100')).toEqual([location])
    const [url, options] = request.mock.calls[0]
    expect((url as URL).hostname).toBe('geocoding-api.open-meteo.com')
    expect((url as URL).searchParams.get('name')).toBe('London&count=100')
    expect((url as URL).searchParams.get('count')).toBe('5')
    expect(options?.redirect).toBe('error')
  })

  it('maps a seven-day forecast request, shares in-flight requests, and uses a persistent timed cache', async () => {
    const { service, request, advance, path } = setup()
    service.configure(settings)
    const [first, concurrent] = await Promise.all([service.forecast(), service.forecast()])
    expect(concurrent).toEqual(first)
    expect(first).toMatchObject({ location, unit: 'celsius', timeZone: 'Europe/London', days: [{ date: '2026-10-20', code: 3, low: 8, high: 15, precipitation: 0 }, { date: '2026-10-21', code: 61, low: 6, high: 13, precipitation: 80 }] })
    expect(request).toHaveBeenCalledTimes(1)
    const url = request.mock.calls[0][0] as URL
    expect(url.hostname).toBe('api.open-meteo.com'); expect(url.searchParams.get('timezone')).toBe('auto'); expect(url.searchParams.get('forecast_days')).toBe('7')
    await service.forecast(); expect(request).toHaveBeenCalledTimes(1)
    const reopened = new CalendarWeatherService(path, request, () => Date.parse(first.updatedAt)); instances.push(reopened)
    expect(reopened.settings()).toEqual(settings)
    expect(await reopened.forecast()).toEqual(first)
    expect(request).toHaveBeenCalledTimes(1)
    advance(WEATHER_CACHE_MS + 1); await service.forecast()
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('returns a visibly stale cache for temporary errors, but expires it after a day', async () => {
    const { service, request, advance } = setup()
    service.configure(settings); await service.forecast()
    advance(WEATHER_CACHE_MS + 1)
    request.mockImplementation(async () => new Response('busy', { status: 429 }))
    expect(await service.forecast()).toMatchObject({ stale: true, error: expect.stringMatching(/rate limit/) })
    advance(24 * 60 * 60_000)
    await expect(service.forecast()).rejects.toThrow(/rate limit/)
  })

  it('clears coordinates and cache on disable, and invalidates cache for location/unit changes', async () => {
    const { service, request } = setup()
    service.configure(settings); await service.forecast()
    service.configure({ ...settings, unit: 'fahrenheit' }); await service.forecast()
    expect((request.mock.calls[1][0] as URL).searchParams.get('temperature_unit')).toBe('fahrenheit')
    expect(service.configure({ ...settings, enabled: false })).toEqual({ enabled: false, unit: 'celsius' })
    await expect(service.forecast()).rejects.toThrow(/Enable/)
    service.configure({ enabled: true, unit: 'celsius' }); await expect(service.forecast()).rejects.toThrow(/Choose/)
  })

  it('rejects malformed/oversized responses and network failures with useful errors', async () => {
    const { service, request } = setup(); service.configure(settings)
    request.mockResolvedValueOnce(new Response(JSON.stringify({ daily: { time: ['bad'] } })))
    await expect(service.forecast()).rejects.toThrow(/invalid forecast/)
    request.mockResolvedValueOnce(new Response('x'.repeat(256_001)))
    await expect(service.forecast()).rejects.toThrow(/too large/)
    request.mockRejectedValueOnce(new Error('socket failed'))
    await expect(service.forecast()).rejects.toThrow(/Check your connection/)
  })

  it('never persists or exposes an in-flight forecast after disabling weather', async () => {
    const { service, request } = setup(); service.configure(settings)
    let resolve!: (response: Response) => void
    request.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    const pending = service.forecast()
    service.configure({ enabled: false, unit: 'celsius' }); resolve(forecast())
    await expect(pending).rejects.toThrow(/settings changed/)
    service.configure(settings); await service.forecast()
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('protects every weather IPC channel while the app is locked', async () => {
    const { service, request } = setup()
    const handlers = new Map<string, (...args: any[]) => any>()
    let locked = true
    registerCalendarWeather({ ipc: { handle: (channel, handler) => { handlers.set(channel, handler) } }, service, locked: () => locked })
    expect([...handlers.keys()]).toHaveLength(4)
    for (const handler of handlers.values()) expect(() => handler({}, settings)).toThrow(/Unlock/)
    expect(request).not.toHaveBeenCalled()
    locked = false
    expect(handlers.get('calendar:weather:configure')!({}, settings)).toEqual(settings)
    expect(handlers.get('calendar:weather:settings')!({})).toEqual(settings)
  })
})
