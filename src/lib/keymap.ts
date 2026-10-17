/**
 * Command and keymap registry: the single source for Aerio's keyboard
 * shortcuts. Defaults are written with the portable `Mod` modifier (Cmd on
 * macOS, Ctrl on Windows and Linux); user overrides are stored in Settings as
 * `KeymapOverrides` and resolved per platform. docs/keyboard-shortcuts.md is
 * generated from `keymapReferenceMarkdown()` and checked by keymap-doc.test.ts.
 */

export type KeymapPlatform = 'mac' | 'windows' | 'linux'
/** Where a command listens. Global commands overlap every other context. */
export type KeymapContext = 'global' | 'mail' | 'compose'
export type KeymapCategory = 'general' | 'navigation' | 'mail' | 'editor' | 'quick-actions'

export interface KeymapCommand {
  id: string
  label: string
  category: KeymapCategory
  context: KeymapContext
  /** Default chords using `Mod`; `mac` replaces them on macOS when a default would collide with a system shortcut. */
  defaults: { all: string[]; mac?: string[] }
  description?: string
}

/** Stored user changes. A command with an empty list has been cleared; absent commands use the defaults. */
export interface KeymapOverrides {
  version: 1
  bindings: Record<string, string[]>
}

export const KEYMAP_VERSION = 1
export const MAX_CHORDS_PER_COMMAND = 3

export const KEYMAP_CATEGORY_LABELS: Record<KeymapCategory, string> = {
  general: 'General', navigation: 'Navigation', mail: 'Mail', editor: 'Message editor', 'quick-actions': 'Quick Actions'
}
export const KEYMAP_CONTEXT_LABELS: Record<KeymapContext, string> = { global: 'Everywhere', mail: 'Mail', compose: 'Message editor' }

const moduleCommands: [string, string, string][] = [
  ['mail', 'Mail', '1'], ['calendar', 'Calendar', '2'], ['contacts', 'Contacts', '3'],
  ['tasks', 'Tasks', '4'], ['notes', 'Notes', '5'], ['chat', 'Chat', '6']
]

export const KEYMAP_COMMANDS: readonly KeymapCommand[] = [
  { id: 'app.commandPalette', label: 'Search and run a command', category: 'general', context: 'global', defaults: { all: ['Mod+K'] } },
  { id: 'app.settings', label: 'Open settings', category: 'general', context: 'global', defaults: { all: ['Mod+,'] } },
  { id: 'app.help', label: 'Open help and keyboard shortcuts', category: 'general', context: 'global', defaults: { all: ['F1'] } },
  { id: 'app.lock', label: 'Lock Aerio', category: 'general', context: 'global', defaults: { all: ['Mod+L'] }, description: 'Available while app lock is enabled.' },
  { id: 'mail.compose', label: 'Compose a new message', category: 'general', context: 'global', defaults: { all: ['Mod+N'] } },
  ...moduleCommands.map(([id, label, digit]): KeymapCommand => ({
    id: `module.${id}`, label: `Open ${label}`, category: 'navigation', context: 'global', defaults: { all: [`Mod+${digit}`] },
    ...(id === 'chat' ? { description: 'Available while Chat is enabled.' } : {})
  })),
  { id: 'mail.reply', label: 'Reply', category: 'mail', context: 'mail', defaults: { all: ['Mod+R'] } },
  { id: 'mail.replyAll', label: 'Reply all', category: 'mail', context: 'mail', defaults: { all: ['Mod+Shift+R'] } },
  { id: 'mail.forward', label: 'Forward', category: 'mail', context: 'mail', defaults: { all: ['Mod+Shift+F'] } },
  { id: 'mail.markRead', label: 'Mark as read', category: 'mail', context: 'mail', defaults: { all: ['Mod+Q'], mac: ['Mod+T'] }, description: 'Cmd+Q quits on macOS, so macOS uses Cmd+T.' },
  { id: 'mail.markUnread', label: 'Mark as unread', category: 'mail', context: 'mail', defaults: { all: ['Mod+U'], mac: ['Mod+Shift+T'] } },
  { id: 'mail.toggleStar', label: 'Add or remove star', category: 'mail', context: 'mail', defaults: { all: [] } },
  { id: 'mail.archive', label: 'Archive', category: 'mail', context: 'mail', defaults: { all: ['Mod+Shift+E'] } },
  { id: 'mail.trash', label: 'Move to Trash', category: 'mail', context: 'mail', defaults: { all: ['Delete'] } },
  { id: 'mail.openWindow', label: 'Open conversation in new window', category: 'mail', context: 'mail', defaults: { all: [] } },
  { id: 'mail.refresh', label: 'Check for new mail', category: 'mail', context: 'mail', defaults: { all: ['F5'] } },
  { id: 'compose.send', label: 'Send or schedule the message', category: 'editor', context: 'compose', defaults: { all: ['Mod+Enter'] } },
  { id: 'compose.saveDraft', label: 'Save draft', category: 'editor', context: 'compose', defaults: { all: ['Mod+S'] } },
  { id: 'compose.pastePlain', label: 'Paste as plain text', category: 'editor', context: 'compose', defaults: { all: ['Mod+Shift+V'] } },
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((slot): KeymapCommand => ({
    id: quickActionCommandId(slot), label: `Run Quick Action in slot ${slot}`, category: 'quick-actions', context: 'mail',
    defaults: { all: [`Mod+Shift+${slot}`] }, description: 'Runs the saved Quick Action assigned to this slot.'
  }))
]

const commandById = new Map(KEYMAP_COMMANDS.map((command) => [command.id, command]))

export function quickActionCommandId(slot: number) { return `quickAction.slot${slot}` }
export const keymapCommand = (id: string) => commandById.get(id)

// ---------------------------------------------------------------- chords

const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const
type Modifier = typeof MODIFIERS[number]
const MODIFIER_ALIASES: Record<string, Modifier | 'Mod'> = {
  ctrl: 'Ctrl', control: 'Ctrl', alt: 'Alt', option: 'Alt', opt: 'Alt', shift: 'Shift',
  meta: 'Meta', cmd: 'Meta', command: 'Meta', super: 'Meta', win: 'Meta', mod: 'Mod'
}
const NAMED_KEYS: Record<string, string> = {
  enter: 'Enter', return: 'Enter', escape: 'Escape', esc: 'Escape', tab: 'Tab', space: 'Space', ' ': 'Space',
  delete: 'Delete', del: 'Delete', backspace: 'Backspace', insert: 'Insert', home: 'Home', end: 'End',
  pageup: 'PageUp', pagedown: 'PageDown', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', plus: '+'
}
const PUNCTUATION = new Set([',', '.', '/', ';', "'", '[', ']', '\\', '-', '=', '`', '+'])
const PUNCTUATION_CODES: Record<string, string> = {
  Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`', NumpadAdd: '+', NumpadSubtract: '-', NumpadDivide: '/', NumpadDecimal: '.', NumpadEnter: 'Enter'
}

function normalizeKeyName(raw: string): string | undefined {
  if (!raw) return
  if (/^[a-z0-9]$/i.test(raw)) return raw.toUpperCase()
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(raw)) return raw.toUpperCase()
  const named = NAMED_KEYS[raw.toLowerCase()]
  if (named) return named
  if (PUNCTUATION.has(raw)) return raw
  return undefined
}

/**
 * Parses a chord such as "Mod+Shift+K" or "cmd+,". `Mod` is kept when the
 * platform is omitted so defaults stay portable; otherwise it resolves to
 * Meta on macOS and Ctrl elsewhere. Returns undefined for invalid chords.
 */
export function normalizeChord(input: string, platform?: KeymapPlatform): string | undefined {
  if (typeof input !== 'string') return
  const trimmed = input.trim()
  if (!trimmed || trimmed.length > 40) return
  // "+" as a key is written as a trailing "++" or "Plus".
  const parts = trimmed.endsWith('++') ? [...trimmed.slice(0, -2).split('+'), '+'] : trimmed === '+' ? ['+'] : trimmed.split('+')
  const modifiers = new Set<Modifier | 'Mod'>()
  let key: string | undefined
  for (const [index, part] of parts.entries()) {
    const value = part.trim()
    const modifier = MODIFIER_ALIASES[value.toLowerCase()]
    if (modifier && index < parts.length - 1) {
      if (modifiers.has(modifier)) return
      modifiers.add(modifier)
      continue
    }
    if (index !== parts.length - 1) return
    key = normalizeKeyName(value)
  }
  if (!key) return
  if (modifiers.has('Mod') && platform) {
    modifiers.delete('Mod')
    const resolved: Modifier = platform === 'mac' ? 'Meta' : 'Ctrl'
    if (modifiers.has(resolved)) return
    modifiers.add(resolved)
  }
  const ordered = [...(modifiers.has('Mod') ? ['Mod'] : []), ...MODIFIERS.filter((modifier) => modifiers.has(modifier))]
  return [...ordered, key].join('+')
}

const chordParts = (chord: string) => {
  const parts = chord.endsWith('++') ? [...chord.slice(0, -2).split('+'), '+'] : chord.split('+')
  return { modifiers: new Set(parts.slice(0, -1)), key: parts.at(-1)! }
}

/** True when a chord has no Ctrl/Alt/Meta modifier and is not a function key, so typing would trigger it. */
export function isPlainChord(chord: string) {
  const { modifiers, key } = chordParts(chord)
  if (modifiers.has('Ctrl') || modifiers.has('Alt') || modifiers.has('Meta') || modifiers.has('Mod')) return false
  return !/^F\d+$/.test(key)
}

/** The chord a keyboard event represents, or undefined for a lone modifier/unknown key. */
export function chordFromEvent(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'> & { code?: string }): string | undefined {
  if (!event.key || ['Control', 'Alt', 'Shift', 'Meta', 'OS', 'AltGraph', 'CapsLock', 'Dead', 'Unidentified', 'Process'].includes(event.key)) return
  const code = event.code ?? ''
  let key: string | undefined
  // Physical digits and punctuation keep Shift from changing them (Shift+3 is "#").
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code)
  if (digit) key = digit[1]
  else if (PUNCTUATION_CODES[code]) key = PUNCTUATION_CODES[code]
  else if (/^[a-z]$/i.test(event.key)) key = event.key.toUpperCase()
  else if (/^Key[A-Z]$/.test(code) && (event.ctrlKey || event.altKey || event.metaKey)) key = code.slice(3)
  else key = normalizeKeyName(event.key)
  if (!key) return
  const modifiers = MODIFIERS.filter((modifier) => modifier === 'Ctrl' ? event.ctrlKey : modifier === 'Alt' ? event.altKey : modifier === 'Shift' ? event.shiftKey : event.metaKey)
  return [...modifiers, key].join('+')
}

const KEY_LABELS: Record<string, string> = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Escape: 'Esc', Delete: 'Del' }

/** Human label, e.g. "Ctrl+Shift+3" or "Cmd+Shift+3". */
export function formatChord(chord: string, platform: KeymapPlatform = currentKeymapPlatform()) {
  const normalized = normalizeChord(chord, platform) ?? chord
  const { modifiers, key } = chordParts(normalized)
  const names: Record<Modifier, string> = platform === 'mac'
    ? { Ctrl: 'Ctrl', Alt: 'Option', Shift: 'Shift', Meta: 'Cmd' }
    : { Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Meta: platform === 'windows' ? 'Win' : 'Super' }
  // macOS labels read Cmd+Shift+K; Windows and Linux read Ctrl+Alt+Shift+K.
  const order: readonly Modifier[] = platform === 'mac' ? ['Ctrl', 'Meta', 'Alt', 'Shift'] : MODIFIERS
  return [...order.filter((modifier) => modifiers.has(modifier)).map((modifier) => names[modifier]), KEY_LABELS[key] ?? key].join('+')
}

const ARIA_NAMES: Record<string, string> = { Ctrl: 'Control', Cmd: 'Meta', Win: 'Meta', Super: 'Meta', Option: 'Alt', Del: 'Delete', Esc: 'Escape', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight' }

/** Converts a displayed label such as "Ctrl+Shift+R" to the aria-keyshortcuts form "Control+Shift+R". */
export function ariaKeyShortcuts(label: string) {
  const parts = label.endsWith('++') ? [...label.slice(0, -2).split('+'), 'Plus'] : label.split('+')
  return parts.map((part) => ARIA_NAMES[part] ?? part).join('+')
}

// ---------------------------------------------------------------- platform

export function detectKeymapPlatform(source: { platform?: string; userAgent?: string } | undefined): KeymapPlatform {
  const value = `${source?.platform ?? ''} ${source?.userAgent ?? ''}`
  if (/mac|iphone|ipad/i.test(value)) return 'mac'
  if (/windows|win32|win64/i.test(value)) return 'windows'
  if (/linux|x11|cros/i.test(value)) return 'linux'
  return 'windows'
}

export const currentKeymapPlatform = () => detectKeymapPlatform(typeof navigator === 'undefined' ? undefined : navigator)

// ---------------------------------------------------------------- reservations

/** Chords Aerio never lets a command take: text editing, focus navigation, and OS/window shortcuts. */
export function reservedChordReason(chord: string, platform: KeymapPlatform): string | undefined {
  const normalized = normalizeChord(chord, platform)
  if (!normalized) return 'This is not a valid shortcut'
  const { modifiers, key } = chordParts(normalized)
  const onlyShift = [...modifiers].every((modifier) => modifier === 'Shift')
  if (onlyShift && ['Tab', 'Enter', 'Space', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(key)) {
    return 'Tab, arrow, Enter, Space, and Escape keys stay reserved for keyboard navigation'
  }
  if (normalized === 'Shift+F10') return 'Shift+F10 opens context menus'
  if (onlyShift && key === 'Backspace') return 'Backspace stays reserved for editing'
  const primary = platform === 'mac' ? 'Meta' : 'Ctrl'
  const withPrimary = (...extra: string[]) => modifiers.has(primary) && modifiers.size === 1 + extra.length && extra.every((item) => modifiers.has(item))
  if (['C', 'V', 'X', 'Z', 'A'].includes(key) && withPrimary()) return `${formatChord(normalized, platform)} stays reserved for text editing`
  if ((key === 'Y' && withPrimary()) || (key === 'Z' && withPrimary('Shift'))) return `${formatChord(normalized, platform)} stays reserved for redo`
  if (platform === 'mac' && withPrimary() && ['Q', 'H', 'M', 'W', '0', '=', '-'].includes(key)) return `${formatChord(normalized, platform)} is a macOS system shortcut`
  if (platform === 'mac' && withPrimary('Alt') && key === 'H') return 'Cmd+Option+H is a macOS system shortcut'
  if (platform === 'mac' && normalized === 'Ctrl+Meta+F') return 'Ctrl+Cmd+F toggles full screen on macOS'
  if (platform !== 'mac' && normalized === 'Alt+F4') return 'Alt+F4 closes the window'
  if (modifiers.has('Meta') && platform !== 'mac') return 'The Windows/Super key is reserved by the desktop'
  return undefined
}

// ---------------------------------------------------------------- overrides

export const emptyKeymapOverrides = (): KeymapOverrides => ({ version: KEYMAP_VERSION, bindings: {} })

/** Command ids renamed in later keymap versions; stored overrides follow the rename. */
const LEGACY_COMMAND_IDS: Record<string, string> = {
  'app.palette': 'app.commandPalette',
  'mail.new': 'mail.compose'
}

/**
 * Validates untrusted stored overrides (from preferences or a restored
 * profile). Unknown commands, invalid chords, and duplicate chords are
 * dropped; overrides equal to the portable defaults are removed so later
 * default changes reach users who never customised that command.
 */
export function normalizeKeymapOverrides(value: unknown): KeymapOverrides | undefined {
  if (!value || typeof value !== 'object') return
  const raw = (value as { bindings?: unknown }).bindings
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
  const bindings: Record<string, string[]> = {}
  for (const [storedId, chords] of Object.entries(raw as Record<string, unknown>)) {
    const id = LEGACY_COMMAND_IDS[storedId] ?? storedId
    const command = commandById.get(id)
    if (!command || !Array.isArray(chords) || (bindings[id] && storedId !== id)) continue
    const normalized = [...new Set(chords.flatMap((chord) => {
      const next = typeof chord === 'string' ? normalizeChord(chord) : undefined
      return next ? [next] : []
    }))].slice(0, MAX_CHORDS_PER_COMMAND)
    if (chords.length && !normalized.length) continue
    if (normalized.length === command.defaults.all.length && !command.defaults.mac && normalized.every((chord, index) => chord === normalizeChord(command.defaults.all[index]))) continue
    bindings[id] = normalized
  }
  return Object.keys(bindings).length ? { version: KEYMAP_VERSION, bindings } : undefined
}

export function defaultChords(command: KeymapCommand, platform: KeymapPlatform) {
  const source = platform === 'mac' && command.defaults.mac ? command.defaults.mac : command.defaults.all
  return source.flatMap((chord) => { const value = normalizeChord(chord, platform); return value ? [value] : [] })
}

export interface ResolvedKeymap {
  platform: KeymapPlatform
  /** Command id → concrete chords for this platform. */
  bindings: Map<string, string[]>
  isCustomized(id: string): boolean
}

export function resolveKeymap(overrides: KeymapOverrides | undefined, platform: KeymapPlatform = currentKeymapPlatform()): ResolvedKeymap {
  const bindings = new Map<string, string[]>()
  const custom = new Set<string>()
  for (const command of KEYMAP_COMMANDS) {
    const override = overrides?.bindings[command.id]
    if (override) {
      custom.add(command.id)
      bindings.set(command.id, [...new Set(override.flatMap((chord) => { const value = normalizeChord(chord, platform); return value ? [value] : [] }))])
    } else bindings.set(command.id, defaultChords(command, platform))
  }
  return { platform, bindings, isCustomized: (id) => custom.has(id) }
}

export const defaultKeymap = (platform?: KeymapPlatform) => resolveKeymap(undefined, platform)

/** Primary label for a command, or undefined when it has no shortcut. */
export function shortcutLabel(keymap: ResolvedKeymap, id: string) {
  const chord = keymap.bindings.get(id)?.[0]
  return chord ? formatChord(chord, keymap.platform) : undefined
}

const contextsOverlap = (a: KeymapContext, b: KeymapContext) => a === b || a === 'global' || b === 'global'

export interface KeymapConflict {
  chord: string
  commandIds: string[]
}

/** Chords bound to more than one command in overlapping contexts. */
export function findKeymapConflicts(keymap: ResolvedKeymap): KeymapConflict[] {
  const byChord = new Map<string, string[]>()
  for (const [id, chords] of keymap.bindings) for (const chord of chords) byChord.set(chord, [...(byChord.get(chord) ?? []), id])
  const conflicts: KeymapConflict[] = []
  for (const [chord, ids] of byChord) {
    if (ids.length < 2) continue
    const clashing = ids.filter((id) => ids.some((other) => other !== id && contextsOverlap(commandById.get(id)!.context, commandById.get(other)!.context)))
    if (clashing.length) conflicts.push({ chord, commandIds: clashing })
  }
  return conflicts
}

/** Commands that already use `chord` in a context overlapping `commandId`'s. */
export function conflictingCommands(keymap: ResolvedKeymap, commandId: string, chord: string) {
  const command = commandById.get(commandId)
  const normalized = normalizeChord(chord, keymap.platform)
  if (!command || !normalized) return []
  return KEYMAP_COMMANDS.filter((other) => other.id !== commandId && contextsOverlap(command.context, other.context) && keymap.bindings.get(other.id)?.includes(normalized))
}

/**
 * Rewrites the platform's primary modifier as `Mod` (Ctrl on Windows/Linux,
 * Cmd on macOS) so a recorded override follows a restored profile to another
 * platform.
 */
export function portableChord(chord: string, platform: KeymapPlatform) {
  const normalized = normalizeChord(chord, platform)
  if (!normalized) return
  const { modifiers, key } = chordParts(normalized)
  const primary = platform === 'mac' ? 'Meta' : 'Ctrl'
  if (!modifiers.has(primary)) return normalized
  modifiers.delete(primary)
  return normalizeChord([...modifiers, 'Mod', key].join('+'))
}

/**
 * Returns new overrides with `commandId` set to `chords` (an empty list
 * clears it). Setting a command back to its platform defaults removes the
 * override so future default changes still apply.
 */
export function setCommandBinding(overrides: KeymapOverrides | undefined, commandId: string, chords: string[], platform: KeymapPlatform = currentKeymapPlatform()): KeymapOverrides | undefined {
  const command = commandById.get(commandId)
  if (!command) return overrides
  const portable = [...new Set(chords.flatMap((chord) => { const value = portableChord(chord, platform); return value ? [value] : [] }))]
  const defaults = defaultChords(command, platform)
  const resolved = portable.map((chord) => normalizeChord(chord, platform))
  if (resolved.length === defaults.length && resolved.every((chord, index) => chord === defaults[index])) return resetCommandBinding(overrides, commandId)
  return normalizeKeymapOverrides({ version: KEYMAP_VERSION, bindings: { ...(overrides?.bindings ?? {}), [commandId]: portable } })
}

export function resetCommandBinding(overrides: KeymapOverrides | undefined, commandId: string): KeymapOverrides | undefined {
  if (!overrides?.bindings[commandId]) return overrides
  const { [commandId]: _removed, ...rest } = overrides.bindings
  return normalizeKeymapOverrides({ version: KEYMAP_VERSION, bindings: rest })
}

// ---------------------------------------------------------------- dispatch

/** Text entry where plain keys must type rather than trigger commands. */
export function isTextEntryTarget(target: EventTarget | null | undefined) {
  if (!target || typeof (target as Element).closest !== 'function') return false
  const element = target as HTMLElement
  if (element.isContentEditable) return true
  return Boolean(element.closest('input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="range"]), textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"], [role="combobox"], [role="searchbox"]'))
}

export interface KeymapMatchOptions {
  context: KeymapContext
  /** Commands in this context that currently have handlers. */
  available?: ReadonlySet<string> | readonly string[]
  /** Block every command, including modified ones, while text entry is focused (used by selection-based Mail commands). */
  blockInTextEntry?: boolean
}

/**
 * Finds the command an event triggers in `context`. Plain (unmodified,
 * non-function) keys never fire inside text fields or contenteditable, so
 * typing and Tab/arrow navigation are unaffected.
 */
export function matchKeymapCommand(keymap: ResolvedKeymap, event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey' | 'target'> & { code?: string }, options: KeymapMatchOptions): string | undefined {
  const chord = chordFromEvent(event)
  if (!chord) return
  const textEntry = isTextEntryTarget(event.target)
  if (textEntry && (options.blockInTextEntry || isPlainChord(chord))) return
  const available = options.available ? new Set(options.available) : undefined
  for (const command of KEYMAP_COMMANDS) {
    if (command.context !== options.context || (available && !available.has(command.id))) continue
    if (keymap.bindings.get(command.id)?.includes(chord)) return command.id
  }
  return undefined
}

// ---------------------------------------------------------------- docs

export const KEYMAP_DOC_START = '<!-- keymap:start -->'
export const KEYMAP_DOC_END = '<!-- keymap:end -->'

/** Markdown tables of the default bindings, grouped by category, used for docs/keyboard-shortcuts.md. */
export function keymapReferenceMarkdown() {
  const sections: string[] = []
  const pc = defaultKeymap('windows')
  const mac = defaultKeymap('mac')
  const cell = (keymap: ResolvedKeymap, id: string) => keymap.bindings.get(id)!.map((chord) => `<kbd>${formatChord(chord, keymap.platform).replace(/\|/g, '\\|')}</kbd>`).join(' or ') || 'Not assigned'
  for (const category of Object.keys(KEYMAP_CATEGORY_LABELS) as KeymapCategory[]) {
    const commands = KEYMAP_COMMANDS.filter((command) => command.category === category)
    if (!commands.length) continue
    sections.push([
      `### ${KEYMAP_CATEGORY_LABELS[category]}`, '',
      '| Command | Context | Windows and Linux | macOS | ID |',
      '| --- | --- | --- | --- | --- |',
      ...commands.map((command) => `| ${command.label}${command.description ? ` — ${command.description}` : ''} | ${KEYMAP_CONTEXT_LABELS[command.context]} | ${cell(pc, command.id)} | ${cell(mac, command.id)} | \`${command.id}\` |`)
    ].join('\n'))
  }
  return sections.join('\n\n')
}
