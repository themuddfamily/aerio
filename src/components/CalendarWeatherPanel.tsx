import { useEffect, useState } from 'react'
import type { CalendarForecast, CalendarWeatherApi, CalendarWeatherSettings, WeatherLocation } from '../calendar-weather-types'
import './CalendarWeatherPanel.css'

export function weatherDescription(code: number | null) {
  if (code === null) return 'Unavailable'
  if (code === 0) return 'Clear'
  if (code <= 3) return 'Cloudy'
  if (code <= 48) return 'Fog'
  if (code <= 57) return 'Drizzle'
  if (code <= 67) return 'Rain'
  if (code <= 77) return 'Snow'
  if (code <= 82) return 'Showers'
  if (code <= 86) return 'Snow showers'
  if (code >= 95) return 'Thunderstorms'
  return 'Unavailable'
}
const errorText = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Weather could not be loaded'

export default function CalendarWeatherPanel({ api = window.aerio?.calendarWeather, selectedDay }: { api?: CalendarWeatherApi; selectedDay: string }) {
  const [settings, setSettings] = useState<CalendarWeatherSettings>({ enabled: false, unit: 'celsius' })
  const [loaded, setLoaded] = useState(false)
  const [forecast, setForecast] = useState<CalendarForecast>()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<WeatherLocation[]>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [forecastBusy, setForecastBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let live = true
    if (api) void api.settings().then((value) => { if (live) { setSettings(value); setLoaded(true) } }).catch((reason) => { if (live) setError(errorText(reason)) })
    return () => { live = false }
  }, [api])
  useEffect(() => {
    if (!api || !loaded || !settings.enabled || !settings.location) return
    let live = true
    setError('')
    setForecastBusy(true)
    void api.forecast().then((value) => { if (live) { setForecast(value); setError(value.error ?? '') } }).catch((reason) => { if (live) setError(errorText(reason)) }).finally(() => { if (live) setForecastBusy(false) })
    const timer = setInterval(() => setRefresh((value) => value + 1), 30 * 60_000)
    return () => { live = false; clearInterval(timer) }
  }, [api, loaded, settings, refresh])
  if (!api) return null
  const configure = async (next: CalendarWeatherSettings) => {
    setBusy(true); setError('')
    try { setSettings(await api.configure(next)); setForecast(undefined); setResults(undefined) }
    catch (reason) { setError(errorText(reason)) }
    finally { setBusy(false) }
  }
  const degrees = (value: number | null) => value === null ? '—' : `${Math.round(value)}°`
  return <section className="sidebar-group calendar-weather" aria-label="Calendar weather">
    <div className="sidebar-label">Weather</div>
    <label className="check-label"><input type="checkbox" checked={settings.enabled} disabled={!loaded || busy} onChange={(event) => void configure({ ...settings, enabled: event.target.checked })} /> Show weather</label>
    {!settings.enabled && <p className="provider-source-note">Optional seven-day forecast. Enable to search for a city; your search and chosen coordinates are sent to Open-Meteo. Device location is never requested.</p>}
    {settings.enabled && <>
      <details open={!settings.location}>
        <summary>{settings.location ? `Location: ${settings.location.name}` : 'Choose a location'}</summary>
        <p className="provider-source-note">Searches and selected coordinates are sent to Open-Meteo.</p>
        <form onSubmit={(event) => {
          event.preventDefault(); setBusy(true); setError('')
          void api.search(query).then(setResults).catch((reason) => setError(errorText(reason))).finally(() => setBusy(false))
        }}>
          <label className="field-label">Weather city or postcode<input value={query} onChange={(event) => setQuery(event.target.value)} maxLength={100} /></label>
          <button type="submit" className="button ghost small" disabled={busy || query.trim().length < 2}>Search locations</button>
        </form>
        {results?.length === 0 && <p role="status">No locations found. Try a nearby city.</p>}
        {results && <ul className="weather-locations">{results.map((location, index) => <li key={index}><button type="button" className="button ghost small" disabled={busy} onClick={() => void configure({ ...settings, location })}>{location.name}</button></li>)}</ul>}
        <label className="field-label">Temperature unit<select value={settings.unit} disabled={busy} onChange={(event) => void configure({ ...settings, unit: event.target.value as CalendarWeatherSettings['unit'] })}><option value="celsius">Celsius (°C)</option><option value="fahrenheit">Fahrenheit (°F)</option></select></label>
      </details>
      {forecast && <>
        <p className="provider-source-note">{forecast.location.name} · {forecast.timeZone.replace(/_/g, ' ')} · °{forecast.unit === 'celsius' ? 'C' : 'F'}</p>
        {forecast.stale && <p role="status">Cached forecast — update unavailable.</p>}
        <table><caption>Seven-day weather forecast</caption><thead><tr><th>Date</th><th>Conditions</th><th>Low / High</th></tr></thead><tbody>{forecast.days.map((day) => <tr key={day.date} aria-current={selectedDay === day.date ? 'date' : undefined}>
          <th scope="row">{new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${day.date}T12:00:00Z`))}</th>
          <td>{weatherDescription(day.code)}{day.precipitation !== null && <small>{day.precipitation}% rain</small>}</td><td>{degrees(day.low)} / {degrees(day.high)}</td>
        </tr>)}</tbody></table>
        {!forecast.days.some((day) => day.date === selectedDay) && <p className="provider-source-note">The selected date is outside this forecast.</p>}
        <small>Updated {new Date(forecast.updatedAt).toLocaleString()}</small>
      </>}
      {forecastBusy && <p role="status">Loading weather…</p>}
      {settings.location && <button type="button" className="button ghost small" disabled={forecastBusy} onClick={() => setRefresh((value) => value + 1)}>Refresh weather</button>}
    </>}
    {error && <p role="alert">{error}</p>}
    <small>Weather by <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a> · <a href="https://open-meteo.com/en/terms" target="_blank" rel="noreferrer">Terms</a></small>
  </section>
}
