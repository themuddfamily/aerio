// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  KEYMAP_COMMANDS, ariaKeyShortcuts, chordFromEvent, conflictingCommands, defaultKeymap, detectKeymapPlatform, findKeymapConflicts,
  formatChord, isPlainChord, isTextEntryTarget, matchKeymapCommand, normalizeChord, normalizeKeymapOverrides, portableChord,
  quickActionCommandId, reservedChordReason, resetCommandBinding, resolveKeymap, setCommandBinding, shortcutLabel, type KeymapPlatform
} from './keymap'

const platforms: KeymapPlatform[] = ['windows', 'mac', 'linux']
const keyEvent = (key: string, extra: Partial<KeyboardEvent> & { code?: string; target?: EventTarget | null } = {}) => ({
  key, code: '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, target: document.body, ...extra
})

describe('keymap chords', () => {
  it('normalizes chords, modifier aliases, and the portable Mod key', () => {
    expect(normalizeChord('shift+ctrl+k')).toBe('Ctrl+Shift+K')
    expect(normalizeChord('cmd+option+,')).toBe('Alt+Meta+,')
    expect(normalizeChord('Mod+Shift+3')).toBe('Mod+Shift+3')
    expect(normalizeChord('Mod+K', 'mac')).toBe('Meta+K')
    expect(normalizeChord('Mod+K', 'windows')).toBe('Ctrl+K')
    expect(normalizeChord('Mod+K', 'linux')).toBe('Ctrl+K')
    expect(normalizeChord('Ctrl++')).toBe('Ctrl++')
    expect(normalizeChord('esc')).toBe('Escape')
    expect(normalizeChord('f5')).toBe('F5')
    for (const invalid of ['', 'Ctrl', 'Ctrl+Ctrl+K', 'Ctrl+K+L', 'Hyper+K', 'Ctrl+é', 'Mod+Ctrl+K']) {
      expect(normalizeChord(invalid, 'windows')).toBeUndefined()
    }
  })

  it('formats Windows, macOS, and Linux modifiers', () => {
    expect(formatChord('Mod+Shift+R', 'windows')).toBe('Ctrl+Shift+R')
    expect(formatChord('Mod+Shift+R', 'mac')).toBe('Cmd+Shift+R')
    expect(formatChord('Mod+Shift+R', 'linux')).toBe('Ctrl+Shift+R')
    expect(formatChord('Alt+Meta+K', 'mac')).toBe('Cmd+Option+K')
    expect(formatChord('Meta+K', 'windows')).toBe('Win+K')
    expect(formatChord('Meta+K', 'linux')).toBe('Super+K')
    expect(formatChord('Delete', 'windows')).toBe('Del')
    expect(ariaKeyShortcuts('Cmd+Option+Del')).toBe('Meta+Alt+Delete')
    expect(ariaKeyShortcuts('Ctrl+Shift+R')).toBe('Control+Shift+R')
  })

  it('detects the platform from navigator details', () => {
    expect(detectKeymapPlatform({ platform: 'MacIntel' })).toBe('mac')
    expect(detectKeymapPlatform({ platform: 'Win32' })).toBe('windows')
    expect(detectKeymapPlatform({ platform: 'Linux x86_64' })).toBe('linux')
    expect(detectKeymapPlatform({ platform: '', userAgent: 'Mozilla/5.0 (darwin) jsdom' })).toBe('windows')
    expect(detectKeymapPlatform(undefined)).toBe('windows')
  })

  it('reads chords from key events using physical digits and layout-independent letters', () => {
    expect(chordFromEvent(keyEvent('#', { code: 'Digit3', ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+3')
    expect(chordFromEvent(keyEvent('K', { code: 'KeyK', ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+K')
    expect(chordFromEvent(keyEvent('л', { code: 'KeyK', ctrlKey: true }))).toBe('Ctrl+K')
    expect(chordFromEvent(keyEvent('˚', { code: 'KeyK', altKey: true }))).toBe('Alt+K')
    expect(chordFromEvent(keyEvent('<', { code: 'Comma', metaKey: true, shiftKey: true }))).toBe('Shift+Meta+,')
    expect(chordFromEvent(keyEvent('Delete'))).toBe('Delete')
    expect(chordFromEvent(keyEvent('6', { ctrlKey: true }))).toBe('Ctrl+6')
    expect(chordFromEvent(keyEvent('Control', { ctrlKey: true }))).toBeUndefined()
    expect(chordFromEvent(keyEvent('Shift', { shiftKey: true }))).toBeUndefined()
    expect(isPlainChord('Delete')).toBe(true)
    expect(isPlainChord('Shift+A')).toBe(true)
    expect(isPlainChord('F5')).toBe(false)
    expect(isPlainChord('Mod+K')).toBe(false)
  })
})

describe('keymap registry defaults', () => {
  it('uses unique command ids and has no default collisions or reserved chords on any platform', () => {
    expect(new Set(KEYMAP_COMMANDS.map((command) => command.id)).size).toBe(KEYMAP_COMMANDS.length)
    for (const platform of platforms) {
      const keymap = defaultKeymap(platform)
      expect(findKeymapConflicts(keymap)).toEqual([])
      for (const [id, chords] of keymap.bindings) for (const chord of chords) expect([id, reservedChordReason(chord, platform)]).toEqual([id, undefined])
    }
  })

  it('applies platform defaults: Cmd on macOS and Ctrl elsewhere, with macOS replacements', () => {
    expect(shortcutLabel(defaultKeymap('windows'), 'app.commandPalette')).toBe('Ctrl+K')
    expect(shortcutLabel(defaultKeymap('mac'), 'app.commandPalette')).toBe('Cmd+K')
    expect(shortcutLabel(defaultKeymap('linux'), 'module.calendar')).toBe('Ctrl+2')
    expect(shortcutLabel(defaultKeymap('windows'), 'mail.markRead')).toBe('Ctrl+Q')
    expect(shortcutLabel(defaultKeymap('mac'), 'mail.markRead')).toBe('Cmd+T')
    expect(shortcutLabel(defaultKeymap('windows'), quickActionCommandId(7))).toBe('Ctrl+Shift+7')
    expect(shortcutLabel(defaultKeymap('windows'), 'mail.toggleStar')).toBeUndefined()
  })

  it('reserves editing, navigation, and system shortcuts', () => {
    for (const chord of ['Tab', 'Shift+Tab', 'ArrowDown', 'Enter', 'Space', 'Escape', 'Shift+F10', 'Ctrl+C', 'Ctrl+V', 'Ctrl+Z', 'Ctrl+Y', 'Ctrl+Shift+Z', 'Alt+F4', 'Meta+K']) {
      expect(reservedChordReason(chord, 'windows')).toBeTruthy()
    }
    for (const chord of ['Meta+Q', 'Meta+W', 'Meta+H', 'Alt+Meta+H', 'Meta+C', 'Ctrl+Meta+F']) expect(reservedChordReason(chord, 'mac')).toBeTruthy()
    expect(reservedChordReason('Meta+Q', 'windows')).toBeTruthy()
    expect(reservedChordReason('Ctrl+Q', 'windows')).toBeUndefined()
    expect(reservedChordReason('Ctrl+Q', 'mac')).toBeUndefined()
    expect(reservedChordReason('Ctrl+Enter', 'windows')).toBeUndefined()
    expect(reservedChordReason('E', 'linux')).toBeUndefined()
  })
})

describe('keymap overrides', () => {
  it('detects collisions only within overlapping contexts', () => {
    const keymap = defaultKeymap('windows')
    expect(conflictingCommands(keymap, 'mail.archive', 'Ctrl+R').map((command) => command.id)).toEqual(['mail.reply'])
    expect(conflictingCommands(keymap, 'mail.archive', 'Ctrl+K').map((command) => command.id)).toEqual(['app.commandPalette'])
    // Mail and the message editor never listen at the same time.
    expect(conflictingCommands(keymap, 'compose.saveDraft', 'Ctrl+R')).toEqual([])
    const overlapping = resolveKeymap(normalizeKeymapOverrides({ version: 1, bindings: { 'compose.saveDraft': ['Mod+R'], 'mail.archive': ['Mod+K'] } }), 'windows')
    expect(findKeymapConflicts(overlapping)).toEqual([{ chord: 'Ctrl+K', commandIds: ['app.commandPalette', 'mail.archive'] }])
  })

  it('saves portable overrides, clears and resets commands, and drops overrides equal to defaults', () => {
    let overrides = setCommandBinding(undefined, 'mail.archive', ['Ctrl+E'], 'windows')
    expect(overrides).toEqual({ version: 1, bindings: { 'mail.archive': ['Mod+E'] } })
    // The same override follows a restored profile to macOS as Cmd+E.
    expect(shortcutLabel(resolveKeymap(overrides, 'mac'), 'mail.archive')).toBe('Cmd+E')
    expect(portableChord('Meta+Shift+E', 'mac')).toBe('Mod+Shift+E')
    expect(portableChord('Ctrl+E', 'mac')).toBe('Ctrl+E')
    overrides = setCommandBinding(overrides, 'mail.trash', [], 'windows')
    expect(resolveKeymap(overrides, 'windows').bindings.get('mail.trash')).toEqual([])
    expect(resolveKeymap(overrides, 'windows').isCustomized('mail.trash')).toBe(true)
    overrides = resetCommandBinding(overrides, 'mail.trash')
    expect(resolveKeymap(overrides, 'windows').bindings.get('mail.trash')).toEqual(['Delete'])
    overrides = setCommandBinding(overrides, 'mail.archive', ['Ctrl+Shift+E'], 'windows')
    expect(overrides).toBeUndefined()
    // Recording the macOS default on macOS also counts as the default.
    expect(setCommandBinding(undefined, 'mail.markRead', ['Meta+T'], 'mac')).toBeUndefined()
    expect(setCommandBinding(undefined, 'unknown.command', ['Ctrl+E'], 'windows')).toBeUndefined()
  })

  it('migrates stored overrides: renamed commands, invalid data, and unchanged defaults', () => {
    expect(normalizeKeymapOverrides(undefined)).toBeUndefined()
    expect(normalizeKeymapOverrides('Ctrl+K')).toBeUndefined()
    expect(normalizeKeymapOverrides({ bindings: [] })).toBeUndefined()
    expect(normalizeKeymapOverrides({
      bindings: {
        'app.palette': ['mod+j'], // legacy id
        'mail.reply': ['Mod+R'], // equal to the default, so defaults keep applying
        'mail.trash': [],
        'mail.archive': ['Ctrl+E', 'ctrl+e', 'Alt+1', 'Alt+2', 'Alt+3'],
        'mail.forward': ['Hyper+Q'],
        'mail.refresh': 'F5',
        'retired.command': ['Ctrl+P']
      }
    })).toEqual({
      version: 1,
      bindings: { 'app.commandPalette': ['Mod+J'], 'mail.trash': [], 'mail.archive': ['Ctrl+E', 'Alt+1', 'Alt+2'] }
    })
    // A current id wins over its legacy alias.
    expect(normalizeKeymapOverrides({ version: 1, bindings: { 'app.commandPalette': ['Mod+P'], 'app.palette': ['Mod+J'] } })?.bindings['app.commandPalette']).toEqual(['Mod+P'])
  })
})

describe('keymap focus contexts', () => {
  const keymap = defaultKeymap('windows')
  const field = (html: string) => { document.body.innerHTML = html; return document.body.firstElementChild as HTMLElement }

  it('recognises text entry targets without treating checkboxes or buttons as typing', () => {
    expect(isTextEntryTarget(field('<input type="text">'))).toBe(true)
    expect(isTextEntryTarget(field('<textarea></textarea>'))).toBe(true)
    expect(isTextEntryTarget(field('<div contenteditable="true"><p>Body</p></div>').firstElementChild)).toBe(true)
    expect(isTextEntryTarget(field('<div role="textbox"></div>'))).toBe(true)
    expect(isTextEntryTarget(field('<input type="checkbox">'))).toBe(false)
    expect(isTextEntryTarget(field('<button>Row</button>'))).toBe(false)
    expect(isTextEntryTarget(null)).toBe(false)
  })

  it('never fires plain keys while typing, but allows modified shortcuts unless the context blocks them', () => {
    const input = field('<input type="search">')
    expect(matchKeymapCommand(keymap, keyEvent('Delete'), { context: 'mail' })).toBe('mail.trash')
    expect(matchKeymapCommand(keymap, keyEvent('Delete', { target: input }), { context: 'mail' })).toBeUndefined()
    expect(matchKeymapCommand(keymap, keyEvent('k', { ctrlKey: true, target: input }), { context: 'global' })).toBe('app.commandPalette')
    expect(matchKeymapCommand(keymap, keyEvent('F1', { target: input }), { context: 'global' })).toBe('app.help')
    expect(matchKeymapCommand(keymap, keyEvent('r', { ctrlKey: true, target: input }), { context: 'mail', blockInTextEntry: true })).toBeUndefined()
    const custom = resolveKeymap(setCommandBinding(undefined, 'mail.archive', ['E'], 'windows'), 'windows')
    expect(matchKeymapCommand(custom, keyEvent('e'), { context: 'mail' })).toBe('mail.archive')
    expect(matchKeymapCommand(custom, keyEvent('e', { target: field('<div contenteditable="true"></div>') }), { context: 'mail' })).toBeUndefined()
  })

  it('leaves Tab and arrow navigation alone and honours available handlers and contexts', () => {
    expect(matchKeymapCommand(keymap, keyEvent('Tab'), { context: 'global' })).toBeUndefined()
    expect(matchKeymapCommand(keymap, keyEvent('ArrowDown'), { context: 'mail' })).toBeUndefined()
    expect(matchKeymapCommand(keymap, keyEvent('r', { ctrlKey: true }), { context: 'global' })).toBeUndefined()
    expect(matchKeymapCommand(keymap, keyEvent('6', { ctrlKey: true }), { context: 'global', available: ['module.mail'] })).toBeUndefined()
    expect(matchKeymapCommand(keymap, keyEvent('Enter', { ctrlKey: true }), { context: 'compose' })).toBe('compose.send')
    expect(matchKeymapCommand(defaultKeymap('mac'), keyEvent('k', { ctrlKey: true }), { context: 'global' })).toBeUndefined()
    expect(matchKeymapCommand(defaultKeymap('mac'), keyEvent('k', { metaKey: true }), { context: 'global' })).toBe('app.commandPalette')
  })
})
