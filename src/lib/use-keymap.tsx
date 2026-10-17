import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import {
  currentKeymapPlatform, matchKeymapCommand, resolveKeymap, shortcutLabel,
  type KeymapContext, type KeymapOverrides, type KeymapPlatform, type ResolvedKeymap
} from './keymap'

interface KeymapValue {
  keymap: ResolvedKeymap
  /** Display label of a command's first binding, or undefined when unbound. */
  label(commandId: string): string | undefined
}

const valueFor = (keymap: ResolvedKeymap): KeymapValue => ({ keymap, label: (id) => shortcutLabel(keymap, id) })
const KeymapReactContext = createContext<KeymapValue>(valueFor(resolveKeymap(undefined)))

/** Supplies the user's resolved keymap (or one resolved by the caller); components outside a provider use the platform defaults. */
export function KeymapProvider({ overrides, platform, keymap, children }: { overrides?: KeymapOverrides; platform?: KeymapPlatform; keymap?: ResolvedKeymap; children: ReactNode }) {
  const resolvedPlatform = platform ?? currentKeymapPlatform()
  const value = useMemo(() => valueFor(keymap ?? resolveKeymap(overrides, resolvedPlatform)), [keymap, overrides, resolvedPlatform])
  return <KeymapReactContext.Provider value={value}>{children}</KeymapReactContext.Provider>
}

export const useKeymap = () => useContext(KeymapReactContext)

export type KeymapHandlers = Partial<Record<string, (event: KeyboardEvent | ReactKeyboardEvent) => void>>

export interface KeymapListenerOptions {
  /** Block even modified chords while a text field is focused (selection-based commands). */
  blockInTextEntry?: boolean
  /** Ignore keys pressed inside dialogs, so commands act on the view rather than an open modal. */
  ignoreDialogs?: boolean
  enabled?: boolean
  /** Use this keymap instead of the provider's (for the component that renders the provider). */
  keymap?: ResolvedKeymap
}

function dispatch(keymap: ResolvedKeymap, context: KeymapContext, handlers: KeymapHandlers, event: KeyboardEvent | ReactKeyboardEvent, options: KeymapListenerOptions) {
  if (event.defaultPrevented || options.enabled === false) return
  const target = event.target as Element | null
  // Duck-typed so targets in popped-out windows (another realm) are recognised.
  if (options.ignoreDialogs && typeof target?.closest === 'function' && target.closest('[role="dialog"], [role="menu"]')) return
  const available = Object.keys(handlers).filter((id) => handlers[id])
  const commandId = matchKeymapCommand(keymap, event, { context, available, blockInTextEntry: options.blockInTextEntry })
  if (!commandId) return
  event.preventDefault()
  handlers[commandId]!(event)
}

/** Runs `handlers` when their bound chords are pressed anywhere in the window. */
export function useKeymapCommands(context: KeymapContext, handlers: KeymapHandlers, options: KeymapListenerOptions = {}) {
  const provided = useKeymap().keymap
  const keymap = options.keymap ?? provided
  const latest = useRef({ handlers, options })
  latest.current = { handlers, options }
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => dispatch(keymap, context, latest.current.handlers, event, latest.current.options)
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [context, keymap])
}

/** A React onKeyDown handler for commands scoped to one element tree (works in popped-out windows too). */
export function useKeymapKeyDown(context: KeymapContext, handlers: KeymapHandlers, options: KeymapListenerOptions = {}) {
  const { keymap } = useKeymap()
  const latest = useRef({ handlers, options })
  latest.current = { handlers, options }
  return useCallback((event: ReactKeyboardEvent) => dispatch(keymap, context, latest.current.handlers, event, latest.current.options), [context, keymap])
}
