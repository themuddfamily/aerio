import { useRef, useState } from 'react'
import type { Settings } from '../types'
import { darkPalette, exportTheme, importTheme, lightPalette, normalizeThemeSettings, themeTokens, validateCustomTheme, type CustomTheme } from '../lib/themes'

export default function ThemeEditor({ settings, onChange }: { settings: Settings; onChange(updates: Partial<Settings>): void }) {
  const themes = normalizeThemeSettings(settings).customThemes ?? []
  const [draft, setDraft] = useState<CustomTheme>()
  const [message, setMessage] = useState('')
  const file = useRef<HTMLInputElement>(null)
  const save = () => {
    if (!draft) return
    try {
      const theme = validateCustomTheme(draft)
      if (themes.length >= 50 && !themes.some((item) => item.id === theme.id)) throw new Error('You can save up to 50 themes. Delete one first.')
      onChange({ customThemes: [...themes.filter((item) => item.id !== theme.id), theme], customThemeId: theme.id })
      setDraft(undefined); setMessage(`Saved and applied ${theme.name}.`)
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Theme could not be saved.') }
  }
  const download = (theme: CustomTheme) => {
    const url = URL.createObjectURL(new Blob([exportTheme(theme)], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url; link.download = `${theme.name.replace(/[^a-z0-9-]/gi, '_')}.aerio-theme.json`
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <div className="custom-theme-editor">
    <h4>Custom themes</h4>
    <p>Create a palette, or import an Aerio theme file. Saved palettes stay with your profile.</p>
    {themes.map((theme) => <div className="custom-theme-row" key={theme.id}>
      <button className="button ghost" aria-pressed={settings.customThemeId === theme.id} onClick={() => onChange({ customThemeId: theme.id })}>{settings.customThemeId === theme.id ? '✓ ' : ''}{theme.name}</button>
      <button className="button ghost" aria-label={`Edit ${theme.name}`} onClick={() => { setDraft({ ...theme, colors: { ...theme.colors } }); setMessage('') }}>Edit</button>
      <button className="button ghost" aria-label={`Export ${theme.name}`} onClick={() => download(theme)}>Export</button>
      <button className="button ghost" aria-label={`Delete ${theme.name}`} onClick={() => { onChange({ customThemes: themes.filter((item) => item.id !== theme.id), ...(settings.customThemeId === theme.id ? { customThemeId: undefined } : {}) }); if (draft?.id === theme.id) setDraft(undefined) }}>Delete</button>
    </div>)}
    <div className="settings-actions">
      <button className="button ghost" disabled={themes.length >= 50} onClick={() => { const base = settings.theme === 'dark' ? 'dark' : 'light'; setDraft({ id: crypto.randomUUID(), name: 'My theme', base, colors: { ...(base === 'dark' ? darkPalette : lightPalette) } }); setMessage('') }}>Create theme</button>
      <button className="button ghost" onClick={() => file.current?.click()}>Import theme</button>
      <input ref={file} hidden type="file" accept=".json,application/json" aria-label="Import theme file" onChange={(event) => {
        const selected = event.target.files?.[0]; event.target.value = ''; if (!selected) return
        if (selected.size > 64 * 1024) { setMessage('Theme file must be smaller than 64 KB.'); return }
        void selected.text().then((text) => { const theme = importTheme(text); setDraft({ ...theme, id: crypto.randomUUID() }); setMessage('Review the imported palette, then save it to apply.') }).catch((error: unknown) => setMessage(error instanceof Error ? error.message : 'Theme import failed.'))
      }} />
    </div>
    {draft && <fieldset className="theme-palette-fields">
      <legend>Edit palette</legend>
      <label className="field-label">Theme name<input maxLength={80} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
      <label className="field-label">Base appearance<select value={draft.base} onChange={(event) => setDraft({ ...draft, base: event.target.value as 'light' | 'dark' })}><option value="light">Light</option><option value="dark">Dark</option></select></label>
      <div className="settings-actions"><button className="button ghost" onClick={() => setDraft({ ...draft, colors: { ...(draft.base === 'dark' ? darkPalette : lightPalette) } })}>Reset colors to base</button></div>
      <div className="theme-color-grid">{themeTokens.map((token) => <label key={token} className="theme-color-field">{token}<input type="color" aria-label={`${token} color`} value={draft.colors[token]} onChange={(event) => setDraft({ ...draft, colors: { ...draft.colors, [token]: event.target.value } })} /></label>)}</div>
      <div className="theme-preview" style={{ background: draft.colors.surface, color: draft.colors.text, borderColor: draft.colors.line }}><strong>Palette preview</strong><span style={{ color: draft.colors['text-soft'] }}>Your messages and workspace</span><span style={{ color: draft.colors['accent-text'], background: draft.colors['accent-soft'] }}>Selected conversation</span><button type="button" style={{ background: draft.colors.accent, color: draft.colors.surface }} onClick={() => setMessage('Save and apply to use this palette across Aerio.')}>Action preview</button></div>
      <div className="settings-actions"><button className="button primary" onClick={save}>Save and apply theme</button><button className="button ghost" onClick={() => setDraft(undefined)}>Cancel palette edit</button></div>
    </fieldset>}
    {message && <small role="status">{message}</small>}
  </div>
}
