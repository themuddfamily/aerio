import type { Settings } from '../types'

export const lightPalette = {
  bg: '#eceef3', surface: '#ffffff', 'surface-2': '#f7f7fa', 'surface-3': '#f0f1f5', 'surface-hover': '#f1f1f7',
  text: '#242531', 'text-soft': '#555967', muted: '#676b78', line: '#e3e4ea', 'line-strong': '#d7d9e1',
  accent: '#6558e8', 'accent-strong': '#5145d6', 'accent-soft': '#efedff', 'accent-text': '#5548d1',
  danger: '#b52f43', 'danger-soft': '#fff0f1', success: '#217451'
}
export const darkPalette: ThemePalette = {
  bg: '#17181e', surface: '#202126', 'surface-2': '#25262d', 'surface-3': '#2a2b33', 'surface-hover': '#2c2d36',
  text: '#ffffff', 'text-soft': '#e3e4ea', muted: '#c9cbd3', line: '#34353e', 'line-strong': '#41434d',
  accent: '#8e82ff', 'accent-strong': '#9d93ff', 'accent-soft': '#353047', 'accent-text': '#b6afff',
  danger: '#ff7b86', 'danger-soft': '#44282d', success: '#66c79d'
}
export type ThemePalette = Record<keyof typeof lightPalette, string>
export interface CustomTheme { id: string; name: string; base: 'light' | 'dark'; colors: ThemePalette }
export const themeTokens = Object.keys(lightPalette) as (keyof ThemePalette)[]

export function validateCustomTheme(value: unknown): CustomTheme {
  if (!value || typeof value !== 'object') throw new Error('Invalid theme.')
  const theme = value as Partial<CustomTheme>
  if (typeof theme.id !== 'string' || !/^[\w-]{1,80}$/.test(theme.id)) throw new Error('Invalid theme ID.')
  if (typeof theme.name !== 'string' || !theme.name.trim() || theme.name.length > 80) throw new Error('Theme name must contain 1–80 characters.')
  if (theme.base !== 'light' && theme.base !== 'dark') throw new Error('Theme base must be light or dark.')
  const colors = {} as ThemePalette
  for (const token of themeTokens) {
    const color = theme.colors?.[token]
    if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) throw new Error(`Invalid ${token} color. Use #RRGGBB.`)
    colors[token] = color.toLowerCase()
  }
  return { id: theme.id, name: theme.name.trim(), base: theme.base, colors }
}

export function normalizeThemeSettings(settings: Pick<Settings, 'customThemes' | 'customThemeId'>): Pick<Settings, 'customThemes' | 'customThemeId'> {
  const themes: CustomTheme[] = []
  for (const value of Array.isArray(settings.customThemes) ? settings.customThemes.slice(0, 50) : []) {
    try { const theme = validateCustomTheme(value); if (!themes.some((item) => item.id === theme.id)) themes.push(theme) } catch { /* Ignore malformed saved themes. */ }
  }
  return { customThemes: themes, customThemeId: themes.some((theme) => theme.id === settings.customThemeId) ? settings.customThemeId : undefined }
}

export function exportTheme(theme: CustomTheme): string {
  return JSON.stringify({ format: 'aerio-theme', version: 1, theme: validateCustomTheme(theme) }, null, 2)
}
export function importTheme(json: string): CustomTheme {
  if (json.length > 64 * 1024) throw new Error('Theme file must be smaller than 64 KB.')
  const document = JSON.parse(json) as { format?: string; version?: number; theme?: unknown }
  if (!document || document.format !== 'aerio-theme' || document.version !== 1) throw new Error('Choose an Aerio theme file (version 1).')
  return validateCustomTheme(document.theme)
}

/** Clear previous overrides before applying, so built-in themes restore every token. */
export function applyTheme(settings: Settings, root: HTMLElement, systemDark: boolean): void {
  for (const token of themeTokens) root.style.removeProperty(`--${token}`)
  const normalized = normalizeThemeSettings(settings)
  const custom = normalized.customThemes?.find((theme) => theme.id === normalized.customThemeId)
  root.dataset.theme = custom?.base ?? (settings.theme === 'system' ? systemDark ? 'dark' : 'light' : settings.theme)
  if (custom) for (const token of themeTokens) root.style.setProperty(`--${token}`, custom.colors[token])
}
