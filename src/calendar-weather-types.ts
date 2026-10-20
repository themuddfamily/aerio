export interface WeatherLocation { name: string; latitude: number; longitude: number }
export interface CalendarWeatherSettings { enabled: boolean; unit: 'celsius' | 'fahrenheit'; location?: WeatherLocation }
export interface WeatherDay { date: string; code: number | null; high: number | null; low: number | null; precipitation: number | null }
export interface CalendarForecast { location: WeatherLocation; unit: CalendarWeatherSettings['unit']; timeZone: string; updatedAt: string; days: WeatherDay[]; stale?: boolean; error?: string }
export interface CalendarWeatherApi {
  settings(): Promise<CalendarWeatherSettings>
  configure(settings: CalendarWeatherSettings): Promise<CalendarWeatherSettings>
  search(query: string): Promise<WeatherLocation[]>
  forecast(): Promise<CalendarForecast>
}
