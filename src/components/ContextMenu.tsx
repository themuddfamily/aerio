import {
  Check, ClipboardPaste, Copy, ExternalLink, Image as ImageIcon, MousePointer2, Redo2, Scissors, Trash2, Undo2
} from 'lucide-react'
import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type MouseEvent as ReactMouseEvent, type PropsWithChildren
} from 'react'
import type { LucideIcon } from 'lucide-react'

export interface ContextMenuItem {
  label: string
  icon?: LucideIcon
  shortcut?: string
  disabled?: boolean
  danger?: boolean
  checked?: boolean
  separatorBefore?: boolean
  action(): void | Promise<void>
}

interface OpenMenu {
  x: number
  y: number
  label: string
  items: ContextMenuItem[]
  nonce: number
  trigger?: HTMLElement
}

interface ContextMenuApi {
  showContextMenu(event: ReactMouseEvent, items: ContextMenuItem[], label?: string): void
  closeContextMenu(): void
}

const ContextMenuContext = createContext<ContextMenuApi | null>(null)

const textInputTypes = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number'])

function editableTarget(target: EventTarget | null) {
  if (target instanceof HTMLTextAreaElement) return target
  if (target instanceof HTMLInputElement && textInputTypes.has(target.type)) return target
  if (target instanceof HTMLElement) return target.closest<HTMLElement>('[contenteditable="true"]')
  return null
}

function editableSelection(target: HTMLInputElement | HTMLTextAreaElement | HTMLElement) {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const start = target.selectionStart ?? 0
    const end = target.selectionEnd ?? start
    return target.value.slice(start, end)
  }
  return window.getSelection()?.toString() ?? ''
}

function setInputValue(target: HTMLInputElement | HTMLTextAreaElement, value: string, cursor: number) {
  const prototype = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(target, value)
  try { target.setSelectionRange(cursor, cursor) } catch { /* Some input types do not expose a text selection. */ }
  target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
}

function replaceEditableSelection(target: HTMLInputElement | HTMLTextAreaElement | HTMLElement, value: string) {
  target.focus()
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const start = target.selectionStart ?? target.value.length
    const end = target.selectionEnd ?? start
    setInputValue(target, `${target.value.slice(0, start)}${value}${target.value.slice(end)}`, start + value.length)
  } else {
    document.execCommand('insertText', false, value)
  }
}

async function writeClipboard(value: string) {
  try {
    await navigator.clipboard.writeText(value)
  } catch {
    // The system may deny clipboard access for protected fields. Leave their content unchanged.
  }
}

function editMenuItems(target: HTMLInputElement | HTMLTextAreaElement | HTMLElement): ContextMenuItem[] {
  const selection = editableSelection(target)
  const readOnly = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
    ? target.readOnly || target.disabled
    : !target.isContentEditable
  const canUndo = !readOnly && document.queryCommandEnabled('undo')
  const canRedo = !readOnly && document.queryCommandEnabled('redo')
  return [
    { label: 'Undo', icon: Undo2, shortcut: 'Ctrl+Z', disabled: !canUndo, action: () => { target.focus(); document.execCommand('undo') } },
    { label: 'Redo', icon: Redo2, shortcut: 'Ctrl+Y', disabled: !canRedo, action: () => { target.focus(); document.execCommand('redo') } },
    { label: 'Cut', icon: Scissors, shortcut: 'Ctrl+X', separatorBefore: true, disabled: readOnly || !selection, action: async () => { await writeClipboard(selection); replaceEditableSelection(target, '') } },
    { label: 'Copy', icon: Copy, shortcut: 'Ctrl+C', disabled: !selection, action: () => writeClipboard(selection) },
    { label: 'Paste', icon: ClipboardPaste, shortcut: 'Ctrl+V', disabled: readOnly, action: async () => { try { replaceEditableSelection(target, await navigator.clipboard.readText()) } catch { /* Clipboard permission can be unavailable. */ } } },
    { label: 'Delete', icon: Trash2, separatorBefore: true, disabled: readOnly || !selection, action: () => replaceEditableSelection(target, '') },
    { label: 'Select all', icon: MousePointer2, shortcut: 'Ctrl+A', action: () => {
      target.focus()
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) { try { target.select() } catch { target.focus() } }
      else document.execCommand('selectAll')
    } }
  ]
}

function originalImageSource(image: HTMLImageElement) {
  const source = image.getAttribute('src') ?? image.src
  if (!source.startsWith('aerio-image://fetch/')) return source
  try {
    const encoded = new URL(source).pathname.replace(/^\//, '').replaceAll('-', '+').replaceAll('_', '/')
    const binary = atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '='))
    return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)))
  } catch {
    return source
  }
}

function ContextMenuPopup({ menu, onClose }: { menu: OpenMenu; onClose(restoreFocus?: boolean): void }) {
  const menuRef = useRef<HTMLDivElement>(null)
  const enabled = useMemo(() => menu.items.map((item, index) => item.disabled ? -1 : index).filter((index) => index >= 0), [menu.items])
  const [active, setActive] = useState(enabled[0] ?? -1)
  const [position, setPosition] = useState({ left: menu.x, top: menu.y })

  useLayoutEffect(() => {
    const element = menuRef.current
    if (!element) return
    const bounds = element.getBoundingClientRect()
    setPosition({
      left: Math.max(8, Math.min(menu.x, window.innerWidth - bounds.width - 8)),
      top: Math.max(8, Math.min(menu.y, window.innerHeight - bounds.height - 8))
    })
  }, [menu])

  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>(`button[data-index="${active}"]`)?.focus()
  }, [active])

  useEffect(() => {
    let scrollDismissalArmed = false
    const armScrollDismissal = window.setTimeout(() => { scrollDismissalArmed = true }, 150)
    const dismiss = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return
      if (event.button === 2) { onClose(); return }
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    const close = () => onClose()
    const closeAfterInitialPositioning = () => { if (scrollDismissalArmed) onClose() }
    document.addEventListener('pointerdown', dismiss, true)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', closeAfterInitialPositioning, true)
    return () => {
      window.clearTimeout(armScrollDismissal)
      document.removeEventListener('pointerdown', dismiss, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', closeAfterInitialPositioning, true)
    }
  }, [onClose])

  const select = (item: ContextMenuItem) => {
    if (item.disabled) return
    onClose()
    void item.action()
  }

  const move = (direction: 1 | -1) => {
    if (!enabled.length) return
    const current = enabled.indexOf(active)
    setActive(enabled[(current + direction + enabled.length) % enabled.length])
  }

  return (
    <div
      ref={menuRef}
      className="context-menu"
      role="menu"
      aria-label={menu.label}
      style={position}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'ArrowDown') { event.preventDefault(); move(1) }
        if (event.key === 'ArrowUp') { event.preventDefault(); move(-1) }
        if (event.key === 'Home' && enabled.length) { event.preventDefault(); setActive(enabled[0]) }
        if (event.key === 'End' && enabled.length) { event.preventDefault(); setActive(enabled.at(-1)!) }
        if ((event.key === 'Enter' || event.key === ' ') && active >= 0) { event.preventDefault(); select(menu.items[active]) }
        if (event.key === 'Escape') { event.preventDefault(); onClose(true) }
        if (event.key === 'Tab') { event.preventDefault(); onClose() }
      }}
    >
      {menu.items.map((item, index) => {
        const Icon = item.icon
        return (
          <button
            type="button"
            role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
            aria-checked={item.checked === undefined ? undefined : item.checked}
            className={`${item.danger ? 'danger' : ''} ${item.separatorBefore ? 'separated' : ''}`}
            data-index={index}
            disabled={item.disabled}
            tabIndex={index === active ? 0 : -1}
            key={`${item.label}-${index}`}
            onMouseEnter={() => { if (!item.disabled) setActive(index) }}
            onClick={() => select(item)}
          >
            <span className="context-menu-icon">{item.checked ? <Check size={15} /> : Icon ? <Icon size={15} /> : null}</span>
            <span>{item.label}</span>
            {item.shortcut && <kbd>{item.shortcut}</kbd>}
          </button>
        )
      })}
    </div>
  )
}

export function ContextMenuProvider({ children }: PropsWithChildren) {
  const [menu, setMenu] = useState<OpenMenu | null>(null)
  const closeContextMenu = useCallback((restoreFocus = false) => setMenu((current) => {
    if (restoreFocus && current?.trigger) queueMicrotask(() => current.trigger?.focus())
    return null
  }), [])
  const open = useCallback((event: MouseEvent, items: ContextMenuItem[], label = 'Context menu') => {
    event.preventDefault()
    if (!items.length) return
    const target = event.target instanceof HTMLElement ? event.target : null
    const bounds = target?.getBoundingClientRect()
    setMenu({
      x: event.clientX || bounds?.left || 8,
      y: event.clientY || bounds?.bottom || 8,
      label,
      items,
      nonce: Date.now(),
      trigger: target ?? undefined
    })
  }, [])

  const showContextMenu = useCallback((event: ReactMouseEvent, items: ContextMenuItem[], label?: string) => {
    event.stopPropagation()
    open(event.nativeEvent, items, label)
  }, [open])

  useEffect(() => {
    const handleNativeMenu = (event: MouseEvent) => {
      if (event.defaultPrevented) return
      const editable = editableTarget(event.target)
      if (editable) {
        open(event, editMenuItems(editable), 'Edit')
        return
      }
      const element = event.target instanceof Element ? event.target : null
      const image = element?.closest<HTMLImageElement>('img[src]')
      const anchor = element?.closest<HTMLAnchorElement>('a[href]')
      if (image) {
        const source = originalImageSource(image)
        open(event, [
          { label: 'Open image', icon: ImageIcon, disabled: !/^https?:/i.test(source), action: () => { window.open(source, '_blank', 'noopener') } },
          { label: 'Copy image address', icon: Copy, action: () => writeClipboard(source) },
          ...(image.alt ? [{ label: 'Copy alt text', icon: Copy, separatorBefore: true, action: () => writeClipboard(image.alt) }] : []),
          ...(anchor ? [
            { label: 'Open link', icon: ExternalLink, separatorBefore: true, action: () => anchor.click() },
            { label: 'Copy link', icon: Copy, action: () => writeClipboard(anchor.href) }
          ] : [])
        ], image.alt || 'Image')
        return
      }
      if (anchor) {
        open(event, [
          { label: 'Open link', icon: ExternalLink, action: () => anchor.click() },
          { label: 'Copy link', icon: Copy, action: () => writeClipboard(anchor.href) }
        ], 'Link')
        return
      }
      const selected = window.getSelection()?.toString().trim()
      if (selected) open(event, [{ label: 'Copy', icon: Copy, shortcut: 'Ctrl+C', action: () => writeClipboard(selected) }], 'Selected text')
    }
    document.addEventListener('contextmenu', handleNativeMenu)
    return () => document.removeEventListener('contextmenu', handleNativeMenu)
  }, [open])

  useEffect(() => {
    const handleKeyboardMenu = (event: KeyboardEvent) => {
      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
      const target = document.activeElement
      if (!(target instanceof HTMLElement)) return
      event.preventDefault()
      const bounds = target.getBoundingClientRect()
      target.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: Math.max(8, bounds.left + Math.min(18, bounds.width / 2)),
        clientY: Math.max(8, bounds.bottom)
      }))
    }
    window.addEventListener('keydown', handleKeyboardMenu)
    return () => window.removeEventListener('keydown', handleKeyboardMenu)
  }, [])

  const api = useMemo(() => ({ showContextMenu, closeContextMenu }), [closeContextMenu, showContextMenu])
  return (
    <ContextMenuContext.Provider value={api}>
      {children}
      {menu && <ContextMenuPopup key={menu.nonce} menu={menu} onClose={closeContextMenu} />}
    </ContextMenuContext.Provider>
  )
}

export function useContextMenu() {
  const context = useContext(ContextMenuContext)
  if (!context) throw new Error('useContextMenu must be used inside ContextMenuProvider')
  return context
}

export async function copyText(value: string) {
  await writeClipboard(value)
}
