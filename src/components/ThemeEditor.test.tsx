// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import ThemeEditor from './ThemeEditor'
import { defaultSettings } from '../preferences'
import { exportTheme, lightPalette } from '../lib/themes'

describe('theme editor', () => {
  it('edits a named palette, saves it and applies its selection', () => {
    const change = vi.fn()
    render(<ThemeEditor settings={defaultSettings} onChange={change} />)
    fireEvent.click(screen.getByRole('button', { name: 'Create theme' }))
    fireEvent.change(screen.getByLabelText('Theme name'), { target: { value: 'Ocean' } })
    fireEvent.change(screen.getByLabelText('accent color'), { target: { value: '#00aacc' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save and apply theme' }))
    expect(change).toHaveBeenCalledWith({ customThemeId: expect.any(String), customThemes: [expect.objectContaining({ name: 'Ocean', colors: { ...lightPalette, accent: '#00aacc' } })] })
  })
  it('imports into a fresh draft without replacing a saved theme until reviewed', async () => {
    const change = vi.fn()
    const saved = { id: 'ocean', name: 'Ocean', base: 'light' as const, colors: lightPalette }
    render(<ThemeEditor settings={{ ...defaultSettings, customThemes: [saved] }} onChange={change} />)
    fireEvent.change(screen.getByLabelText('Import theme file'), { target: { files: [{ size: 500, text: () => Promise.resolve(exportTheme(saved)) }] } })
    await waitFor(() => expect(screen.getByLabelText('Theme name')).toHaveValue('Ocean'))
    expect(change).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Save and apply theme' }))
    const update = change.mock.calls[0][0]
    expect(update.customThemes).toHaveLength(2)
    expect(update.customThemes[0]).toEqual(saved)
    expect(update.customThemeId).not.toBe('ocean')
  })
  it('deletes an active palette and clears the selection', () => {
    const change = vi.fn()
    render(<ThemeEditor settings={{ ...defaultSettings, customThemeId: 'ocean', customThemes: [{ id: 'ocean', name: 'Ocean', base: 'light', colors: lightPalette }] }} onChange={change} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete Ocean' }))
    expect(change).toHaveBeenCalledWith({ customThemes: [], customThemeId: undefined })
  })
})
