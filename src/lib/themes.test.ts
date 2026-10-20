// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { applyTheme, darkPalette, exportTheme, importTheme, lightPalette, normalizeThemeSettings, validateCustomTheme, type CustomTheme } from './themes'
import { defaultSettings } from '../preferences'

const theme: CustomTheme = { id: 'ocean', name: 'Ocean', base: 'dark', colors: { ...darkPalette, accent: '#00aacc' } }
describe('custom themes', () => {
  it('round trips palettes without exporting unrelated preferences', () => {
    expect(importTheme(exportTheme(theme))).toEqual(theme)
    expect(JSON.parse(exportTheme(theme))).toEqual({ format: 'aerio-theme', version: 1, theme })
  })
  it('rejects unsafe colors, missing tokens, unsupported versions and oversized files', () => {
    expect(() => validateCustomTheme({ ...theme, colors: { ...theme.colors, accent: 'url(https://example.com)' } })).toThrow(/accent/)
    expect(() => validateCustomTheme({ ...theme, colors: {} })).toThrow(/bg/)
    expect(() => importTheme('{"format":"aerio-theme","version":2}')).toThrow(/version 1/)
    expect(() => importTheme(' '.repeat(65537))).toThrow(/64 KB/)
    expect(() => importTheme('null')).toThrow(/version 1/)
  })
  it('normalizes persistence, removing corrupt themes, duplicates and stale selection', () => {
    expect(normalizeThemeSettings({ customThemes: [theme, { ...theme, id: 'invalid id' }, theme], customThemeId: 'missing' })).toEqual({ customThemes: [theme], customThemeId: undefined })
    expect(normalizeThemeSettings({ customThemes: [theme], customThemeId: theme.id }).customThemeId).toBe('ocean')
  })
  it('applies custom colors and removes every override when returning to built-in/system themes', () => {
    const root = document.createElement('div')
    applyTheme({ ...defaultSettings, theme: 'light', customThemes: [theme], customThemeId: theme.id }, root, false)
    expect(root.dataset.theme).toBe('dark')
    expect(root.style.getPropertyValue('--accent')).toBe('#00aacc')
    expect(root.style.getPropertyValue('--text')).toBe(theme.colors.text)
    applyTheme(defaultSettings, root, false)
    expect(root.dataset.theme).toBe('light')
    for (const key of Object.keys(lightPalette)) expect(root.style.getPropertyValue(`--${key}`)).toBe('')
    applyTheme(defaultSettings, root, true)
    expect(root.dataset.theme).toBe('dark')
  })
})
