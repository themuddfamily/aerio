import { DatabaseSync } from 'node:sqlite'
import type { IpcMain } from 'electron'
import type { CalendarForecast, CalendarWeatherSettings, WeatherDay, WeatherLocation } from '../../src/calendar-weather-types'

export const CALENDAR_WEATHER_SCHEMA = `CREATE TABLE IF NOT EXISTS calendar_weather (id INTEGER PRIMARY KEY CHECK(id=1), settings_json TEXT NOT NULL, forecast_json TEXT);`
export const WEATHER_CACHE_MS = 30 * 60_000
const STALE_CACHE_MS = 24 * 60 * 60_000
const defaults = (): CalendarWeatherSettings => ({ enabled: false, unit: 'celsius' })
const text = (value: unknown, limit: number) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit
const numberIn = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max

export function validWeatherSettings(value: unknown): value is CalendarWeatherSettings {
  if (!value || typeof value !== 'object') return false
  const settings = value as CalendarWeatherSettings
  const location = settings.location
  return typeof settings.enabled === 'boolean' && ['celsius', 'fahrenheit'].includes(settings.unit) &&
    (location === undefined || (Boolean(location) && typeof location === 'object' && text(location.name, 250) && numberIn(location.latitude, -90, 90) && numberIn(location.longitude, -180, 180)))
}

/** Fixed provider hosts, bounded responses and no renderer-supplied URLs or automatic geolocation. */
export class CalendarWeatherService {
  private readonly db: DatabaseSync
  private pending?: Promise<CalendarForecast>
  private revision = 0
  constructor(path: string, private readonly request: typeof fetch = fetch, private readonly now = Date.now) {
    this.db = new DatabaseSync(path)
    this.db.exec(CALENDAR_WEATHER_SCHEMA)
  }
  settings(): CalendarWeatherSettings {
    const row = this.db.prepare('SELECT settings_json FROM calendar_weather WHERE id=1').get() as { settings_json: string } | undefined
    if (!row) return defaults()
    try { const value = JSON.parse(row.settings_json); return validWeatherSettings(value) ? value : defaults() } catch { return defaults() }
  }
  configure(value: unknown) {
    if (!validWeatherSettings(value)) throw new Error('Invalid calendar weather settings')
    const settings: CalendarWeatherSettings = { enabled: value.enabled, unit: value.unit, ...(value.enabled && value.location ? { location: { name: value.location.name.trim(), latitude: value.location.latitude, longitude: value.location.longitude } } : {}) }
    this.revision++
    this.pending = undefined
    this.db.prepare('INSERT INTO calendar_weather(id,settings_json,forecast_json) VALUES(1,?,NULL) ON CONFLICT(id) DO UPDATE SET settings_json=excluded.settings_json,forecast_json=NULL').run(JSON.stringify(settings))
    return settings
  }
  private enabled() {
    const settings = this.settings()
    if (!settings.enabled) throw new Error('Enable Calendar weather before contacting the weather provider')
    return settings
  }
  private async json(url: URL): Promise<any> {
    try {
      const response = await this.request(url, { signal: AbortSignal.timeout(8_000), redirect: 'error', headers: { Accept: 'application/json' } })
      if (!response.ok) throw new Error(response.status === 429 ? 'Weather provider rate limit reached. Try again later.' : `Weather provider unavailable (HTTP ${response.status}).`)
      if (Number(response.headers.get('content-length') ?? 0) > 256_000) throw new Error('Weather response is too large')
      if (!response.body) throw new Error('Weather provider returned an empty response')
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let size = 0, body = ''
      try {
        while (true) {
          const result = await reader.read()
          if (result.done) break
          size += result.value.byteLength
          if (size > 256_000) throw new Error('Weather response is too large')
          body += decoder.decode(result.value, { stream: true })
        }
      } finally { await reader.cancel().catch(() => {}) }
      return JSON.parse(body + decoder.decode())
    } catch (error) {
      if (error instanceof Error && /Weather/.test(error.message)) throw error
      throw new Error('Weather could not be loaded. Check your connection and try again.')
    }
  }
  async search(value: unknown): Promise<WeatherLocation[]> {
    this.enabled()
    if (!text(value, 100) || (value as string).trim().length < 2) throw new Error('Enter a city or postcode of 2–100 characters')
    const revision = this.revision
    const url = new URL('https://geocoding-api.open-meteo.com/v1/search')
    url.search = new URLSearchParams({ name: (value as string).trim(), count: '5', language: 'en', format: 'json' }).toString()
    const data = await this.json(url)
    if (this.revision !== revision || !this.settings().enabled) throw new Error('Weather settings changed; search again')
    return (Array.isArray(data.results) ? data.results : []).slice(0, 5).flatMap((item: any) => {
      if (!text(item.name, 100) || !numberIn(item.latitude, -90, 90) || !numberIn(item.longitude, -180, 180)) return []
      return [{ name: [item.name, item.admin1, item.country].filter((part) => text(part, 100)).join(', ').slice(0, 250), latitude: item.latitude, longitude: item.longitude }]
    })
  }
  async forecast(): Promise<CalendarForecast> {
    const settings = this.enabled()
    if (!settings.location) throw new Error('Choose a weather location first')
    const row = this.db.prepare('SELECT forecast_json FROM calendar_weather WHERE id=1').get() as { forecast_json: string | null } | undefined
    let cached: CalendarForecast | undefined
    try { cached = row?.forecast_json ? JSON.parse(row.forecast_json) : undefined } catch { /* Refetch a corrupt cache. */ }
    const age = cached ? this.now() - Date.parse(cached.updatedAt) : Infinity
    if (cached && age >= 0 && age < WEATHER_CACHE_MS) return cached
    if (this.pending) return this.pending
    const revision = this.revision
    const location = settings.location
    const fetchForecast = async () => {
      try {
        const url = new URL('https://api.open-meteo.com/v1/forecast')
        url.search = new URLSearchParams({ latitude: String(location.latitude), longitude: String(location.longitude), daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max', temperature_unit: settings.unit, timezone: 'auto', forecast_days: '7' }).toString()
        const data = await this.json(url)
        const daily = data.daily
        if (!daily || !Array.isArray(daily.time) || daily.time.length === 0 || daily.time.length > 7 || !text(data.timezone, 100)) throw new Error('Weather provider returned an invalid forecast')
        const numbers = (name: string, min: number, max: number) => {
          const values = daily[name]
          if (!Array.isArray(values) || values.length !== daily.time.length || !values.every((value: unknown) => value === null || numberIn(value, min, max))) throw new Error('Weather provider returned invalid forecast values')
          return values as (number | null)[]
        }
        const codes = numbers('weather_code', 0, 99), highs = numbers('temperature_2m_max', -200, 200), lows = numbers('temperature_2m_min', -200, 200), rain = numbers('precipitation_probability_max', 0, 100)
        const days: WeatherDay[] = daily.time.map((date: unknown, index: number) => {
          if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error('Weather provider returned invalid forecast dates')
          return { date, code: codes[index], high: highs[index], low: lows[index], precipitation: rain[index] }
        })
        const forecast: CalendarForecast = { location, unit: settings.unit, timeZone: data.timezone, updatedAt: new Date(this.now()).toISOString(), days }
        if (revision !== this.revision || !this.settings().enabled) throw new Error('Weather settings changed; refresh the forecast')
        this.db.prepare('UPDATE calendar_weather SET forecast_json=? WHERE id=1').run(JSON.stringify(forecast))
        return forecast
      } catch (error) {
        if (revision === this.revision && cached && age >= 0 && age < STALE_CACHE_MS) return { ...cached, stale: true, error: error instanceof Error ? error.message : 'Weather update failed' }
        throw error
      }
    }
    const pending = fetchForecast()
    this.pending = pending
    try { return await pending } finally { if (this.pending === pending) this.pending = undefined }
  }
  close() { this.revision++; this.db.close() }
}

export function registerCalendarWeather(options: { ipc: Pick<IpcMain, 'handle'>; service: CalendarWeatherService; locked(): boolean }) {
  const { service } = options
  for (const [channel, action] of [
    ['calendar:weather:settings', () => service.settings()],
    ['calendar:weather:configure', (value: unknown) => service.configure(value)],
    ['calendar:weather:search', (value: unknown) => service.search(value)],
    ['calendar:weather:forecast', () => service.forecast()]
  ] as const) options.ipc.handle(channel, (_event, value) => {
    if (options.locked()) throw new Error('Unlock Aerio to use Calendar weather')
    return action(value)
  })
}
