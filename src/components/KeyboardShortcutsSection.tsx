import { useMemo, useState, type KeyboardEvent } from 'react'
import { Keyboard, RotateCcw, Search, X } from 'lucide-react'
import {
  KEYMAP_CATEGORY_LABELS, KEYMAP_COMMANDS, KEYMAP_CONTEXT_LABELS, chordFromEvent, conflictingCommands, findKeymapConflicts,
  formatChord, isPlainChord, keymapCommand, normalizeChord, reservedChordReason, resetCommandBinding, resolveKeymap, setCommandBinding,
  type KeymapCategory, type KeymapOverrides, type KeymapPlatform
} from '../lib/keymap'
import { useKeymap } from '../lib/use-keymap'

interface KeyboardShortcutsSectionProps {
  overrides?: KeymapOverrides
  onChange(next: KeymapOverrides | undefined): void
  /** Defaults to the running platform. */
  platform?: KeymapPlatform
}

interface PendingConflict { commandId: string; chord: string; owners: string[] }

const LONE_MODIFIERS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'OS', 'AltGraph'])

/** Settings section for searching, recording, clearing, and resetting keyboard shortcuts. */
export default function KeyboardShortcutsSection({ overrides, onChange, platform: platformProp }: KeyboardShortcutsSectionProps) {
  const contextPlatform = useKeymap().keymap.platform
  const platform = platformProp ?? contextPlatform
  const keymap = useMemo(() => resolveKeymap(overrides, platform), [overrides, platform])
  const conflicts = useMemo(() => findKeymapConflicts(keymap), [keymap])
  const [query, setQuery] = useState('')
  const [recording, setRecording] = useState<string>()
  const [pending, setPending] = useState<PendingConflict>()
  const [message, setMessage] = useState({ text: '', error: false })

  const label = (id: string) => keymapCommand(id)?.label ?? id
  const chordsOf = (id: string) => keymap.bindings.get(id) ?? []
  const needle = query.trim().toLowerCase()
  const visible = KEYMAP_COMMANDS.filter((command) => !needle || [command.label, command.id, KEYMAP_CATEGORY_LABELS[command.category], KEYMAP_CONTEXT_LABELS[command.context], ...chordsOf(command.id).map((chord) => formatChord(chord, platform))]
    .some((text) => text.toLowerCase().includes(needle)))
  const categories = (Object.keys(KEYMAP_CATEGORY_LABELS) as KeymapCategory[]).filter((category) => visible.some((command) => command.category === category))

  const assign = (commandId: string, chord: string, replaceOwners: string[] = []) => {
    let next = overrides
    for (const owner of replaceOwners) next = setCommandBinding(next, owner, chordsOf(owner).filter((item) => item !== chord), platform)
    next = setCommandBinding(next, commandId, [chord], platform)
    onChange(next)
    setPending(undefined)
    setRecording(undefined)
    const plainNote = isPlainChord(chord) ? ' It works only while focus is outside text fields.' : ''
    const moved = replaceOwners.length ? ` Removed it from ${replaceOwners.map(label).join(', ')}.` : ''
    setMessage({ text: `${label(commandId)} now uses ${formatChord(chord, platform)}.${moved}${plainNote}`, error: false })
  }

  const capture = (commandId: string, event: KeyboardEvent<HTMLButtonElement>) => {
    // Tab still moves focus, so recording never traps keyboard users.
    if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) { setRecording(undefined); return }
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape' && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
      setRecording(undefined)
      setMessage({ text: 'Recording cancelled.', error: false })
      return
    }
    if (LONE_MODIFIERS.has(event.key)) return
    const raw = chordFromEvent(event)
    const chord = raw ? normalizeChord(raw, platform) : undefined
    if (!chord) { setMessage({ text: 'That key cannot be used as a shortcut. Try another combination.', error: true }); return }
    const reason = reservedChordReason(chord, platform)
    if (reason) { setMessage({ text: `${reason}. Try another combination.`, error: true }); return }
    const owners = conflictingCommands(keymap, commandId, chord).map((command) => command.id)
    if (owners.length) {
      setRecording(undefined)
      setPending({ commandId, chord, owners })
      setMessage({ text: `${formatChord(chord, platform)} is already used by ${owners.map(label).join(', ')}.`, error: true })
      return
    }
    assign(commandId, chord)
  }

  const clear = (commandId: string) => {
    onChange(setCommandBinding(overrides, commandId, [], platform))
    setMessage({ text: `${label(commandId)} no longer has a shortcut.`, error: false })
  }
  const reset = (commandId: string) => {
    onChange(resetCommandBinding(overrides, commandId))
    setMessage({ text: `${label(commandId)} uses its default shortcut again.`, error: false })
  }
  const resetAll = () => {
    if (!window.confirm('Reset every keyboard shortcut to Aerio’s defaults?')) return
    onChange(undefined)
    setPending(undefined)
    setRecording(undefined)
    setMessage({ text: 'All keyboard shortcuts were reset to their defaults.', error: false })
  }

  return (
    <section className="settings-section" aria-labelledby="keyboard-shortcuts-heading">
      <div className="settings-icon"><Keyboard size={18} /></div>
      <div className="settings-content keymap-editor">
        <h3 id="keyboard-shortcuts-heading">Keyboard shortcuts</h3>
        <p>Search commands, record a new shortcut, or clear one you never use. Shortcuts without Ctrl, Alt, or {platform === 'mac' ? 'Cmd' : 'the Windows key'} never run while you are typing in a text field.</p>
        <div className="keymap-toolbar">
          <label className="keymap-search"><Search size={14} /><input type="search" aria-label="Search keyboard shortcuts" placeholder="Search commands or keys" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
          <button className="button ghost small" disabled={!overrides} onClick={resetAll}><RotateCcw size={14} /> Reset all</button>
        </div>
        {conflicts.length > 0 && <div className="keymap-conflicts" role="alert">
          <strong>Conflicting shortcuts</strong>
          <ul>{conflicts.map((conflict) => <li key={conflict.chord}><kbd>{formatChord(conflict.chord, platform)}</kbd> {conflict.commandIds.map(label).join(' · ')}</li>)}</ul>
        </div>}
        {pending && <div className="keymap-pending" role="group" aria-label="Resolve shortcut conflict">
          <span>Use <kbd>{formatChord(pending.chord, platform)}</kbd> for {label(pending.commandId)} and remove it from {pending.owners.map(label).join(', ')}?</span>
          <button className="button primary small" onClick={() => assign(pending.commandId, pending.chord, pending.owners)}>Reassign</button>
          <button className="button ghost small" onClick={() => { setPending(undefined); setMessage({ text: '', error: false }) }}>Cancel</button>
        </div>}
        {message.text && <small className={message.error ? 'diagnostic-error' : 'diagnostic-result'} role="status">{message.text}</small>}
        {!visible.length && <small>No commands match “{query.trim()}”.</small>}
        {categories.map((category) => (
          <div className="keymap-group" key={category}>
            <span className="keymap-group-label">{KEYMAP_CATEGORY_LABELS[category]}</span>
            <ul className="keymap-list">
              {visible.filter((command) => command.category === category).map((command) => {
                const chords = chordsOf(command.id)
                const isRecording = recording === command.id
                const customized = keymap.isCustomized(command.id)
                const conflicted = conflicts.some((conflict) => conflict.commandIds.includes(command.id))
                return (
                  <li key={command.id} className={conflicted ? 'conflicted' : undefined}>
                    <span className="keymap-command">
                      <strong>{command.label}</strong>
                      <small>{KEYMAP_CONTEXT_LABELS[command.context]}{customized ? ' · Customized' : ''}{command.description ? ` · ${command.description}` : ''}</small>
                    </span>
                    <button
                      className={`keymap-binding ${isRecording ? 'recording' : ''}`}
                      aria-label={isRecording ? `Press the new shortcut for ${command.label}, or Escape to cancel` : `Record a shortcut for ${command.label}${chords.length ? `, currently ${chords.map((chord) => formatChord(chord, platform)).join(' or ')}` : ', currently none'}`}
                      onClick={() => { setPending(undefined); setRecording(isRecording ? undefined : command.id); setMessage({ text: isRecording ? '' : `Press the new shortcut for ${command.label}.`, error: false }) }}
                      onKeyDown={isRecording ? (event) => capture(command.id, event) : undefined}
                      onBlur={() => { if (isRecording) setRecording(undefined) }}
                    >
                      {isRecording ? <em>Press keys…</em> : chords.length ? chords.map((chord) => <kbd key={chord}>{formatChord(chord, platform)}</kbd>) : <em>None</em>}
                    </button>
                    <button className="icon-button" title="Clear shortcut" aria-label={`Clear the shortcut for ${command.label}`} disabled={!chords.length} onClick={() => clear(command.id)}><X size={14} /></button>
                    <button className="icon-button" title="Reset to default" aria-label={`Reset ${command.label} to its default shortcut`} disabled={!customized} onClick={() => reset(command.id)}><RotateCcw size={14} /></button>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </div>
    </section>
  )
}
