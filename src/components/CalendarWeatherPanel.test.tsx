// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { CalendarForecast, CalendarWeatherApi, CalendarWeatherSettings } from '../calendar-weather-types'
import CalendarWeatherPanel from './CalendarWeatherPanel'

const location = { name: 'London, England', latitude: 51.5, longitude: -0.12 }
const forecast: CalendarForecast = { location, unit: 'celsius', timeZone: 'Europe/London', updatedAt: '2026-10-20T08:00:00Z', days: [{ date: '2026-10-20', code: 61, low: 8, high: 15, precipitation: 80 }] }
function api(initial: CalendarWeatherSettings = { enabled: false, unit: 'celsius' }) {
  return {
    settings: vi.fn(async () => initial),
    configure: vi.fn(async (settings) => ({ ...settings, ...(!settings.enabled ? { location: undefined } : {}) })),
    search: vi.fn(async () => [location]), forecast: vi.fn(async () => forecast)
  } satisfies CalendarWeatherApi
}

describe('Calendar weather opt-in panel', () => {
  it('does no provider work before opt-in, searches manually, renders forecast and disables it', async () => {
    const bridge = api()
    render(<CalendarWeatherPanel api={bridge} selectedDay="2026-10-20" />)
    await waitFor(() => expect(screen.getByLabelText('Show weather')).toBeEnabled())
    expect(bridge.forecast).not.toHaveBeenCalled(); expect(bridge.search).not.toHaveBeenCalled()
    expect(screen.getByText(/Device location is never requested/)).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Show weather'))
    await screen.findByLabelText('Weather city or postcode')
    fireEvent.change(screen.getByLabelText('Weather city or postcode'), { target: { value: 'London' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search locations' }))
    fireEvent.click(await screen.findByRole('button', { name: location.name }))
    const table = await screen.findByRole('table')
    expect(within(table).getByText('Rain')).toBeInTheDocument()
    expect(within(table).getByText('8° / 15°')).toBeInTheDocument()
    expect(within(table).getByText('80% rain')).toBeInTheDocument()
    expect(table.querySelector('tr[aria-current=date]')).toBeTruthy()
    expect(bridge.search).toHaveBeenCalledWith('London')
    fireEvent.click(screen.getByLabelText('Show weather'))
    await waitFor(() => expect(screen.queryByRole('table')).not.toBeInTheDocument())
    expect(bridge.configure).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }))
  })

  it('shows provider errors with a retry and identifies stale data and out-of-range dates', async () => {
    const bridge = api({ enabled: true, unit: 'celsius', location })
    bridge.forecast.mockRejectedValueOnce(new Error('Weather provider rate limit reached. Try again later.'))
    render(<CalendarWeatherPanel api={bridge} selectedDay="2026-11-20" />)
    expect(await screen.findByRole('alert')).toHaveTextContent('rate limit')
    bridge.forecast.mockResolvedValueOnce({ ...forecast, stale: true, error: 'Weather update failed' })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh weather' }))
    expect(await screen.findByText('Cached forecast — update unavailable.')).toBeInTheDocument()
    expect(screen.getByText('The selected date is outside this forecast.')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Weather update failed')
  })

  it('shows empty location results and saves unit changes', async () => {
    const bridge = api({ enabled: true, unit: 'celsius' })
    bridge.search.mockResolvedValueOnce([])
    render(<CalendarWeatherPanel api={bridge} selectedDay="2026-10-20" />)
    await screen.findByLabelText('Weather city or postcode')
    fireEvent.change(screen.getByLabelText('Weather city or postcode'), { target: { value: 'Unknown' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search locations' }))
    expect(await screen.findByRole('status')).toHaveTextContent('No locations found')
    fireEvent.change(screen.getByLabelText('Temperature unit'), { target: { value: 'fahrenheit' } })
    await waitFor(() => expect(bridge.configure).toHaveBeenCalledWith({ enabled: true, unit: 'fahrenheit' }))
    expect(bridge.forecast).not.toHaveBeenCalled()
  })
})
