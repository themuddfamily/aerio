import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'

type ResizablePane = 'sidebar' | 'list'

interface MailPaneWidths {
  sidebar: number
  list: number
}

interface MailPaneSeparatorProps {
  pane: ResizablePane
  value: number
  onPointerDown(pane: ResizablePane, event: PointerEvent<HTMLDivElement>): void
  onKeyDown(pane: ResizablePane, event: KeyboardEvent<HTMLDivElement>): void
  onReset(): void
}

const STORAGE_KEY = 'aerio:mail-pane-widths:v1'
const DEFAULT_WIDTHS: MailPaneWidths = { sidebar: 220, list: 380 }
const SIDEBAR_MIN = 160
const SIDEBAR_MAX = 420
const LIST_MIN = 280
const LIST_MAX = 720
const READER_MIN = 360
const SEPARATOR_SPACE = 12
const KEYBOARD_STEP = 16

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(value, maximum))
}

function loadWidths(): MailPaneWidths {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '') as Partial<MailPaneWidths>
    if (Number.isFinite(saved.sidebar) && Number.isFinite(saved.list)) {
      return { sidebar: Number(saved.sidebar), list: Number(saved.list) }
    }
  } catch {
    // A missing or stale preference should simply restore the default layout.
  }
  return DEFAULT_WIDTHS
}

function fitWidths(widths: MailPaneWidths, containerWidth: number) {
  const roomForResizablePanes = Math.max(SIDEBAR_MIN + LIST_MIN, containerWidth - READER_MIN - SEPARATOR_SPACE)
  const sidebar = clamp(widths.sidebar, SIDEBAR_MIN, Math.min(SIDEBAR_MAX, roomForResizablePanes - LIST_MIN))
  const list = clamp(widths.list, LIST_MIN, Math.min(LIST_MAX, roomForResizablePanes - sidebar))
  return { sidebar, list }
}

export function MailPaneSeparator({ pane, value, onPointerDown, onKeyDown, onReset }: MailPaneSeparatorProps) {
  const isSidebar = pane === 'sidebar'
  return (
    <div
      className="mail-pane-resizer"
      role="separator"
      aria-label={isSidebar ? 'Resize mail folders' : 'Resize message list'}
      aria-orientation="vertical"
      aria-valuemin={isSidebar ? SIDEBAR_MIN : LIST_MIN}
      aria-valuemax={isSidebar ? SIDEBAR_MAX : LIST_MAX}
      aria-valuenow={Math.round(value)}
      tabIndex={0}
      title="Drag to resize · Double-click to reset"
      onPointerDown={(event) => onPointerDown(pane, event)}
      onKeyDown={(event) => onKeyDown(pane, event)}
      onDoubleClick={onReset}
    />
  )
}

export function useResizableMailPanes() {
  const containerRef = useRef<HTMLDivElement>(null)
  const activeResizeCleanup = useRef<(() => void) | undefined>(undefined)
  const [widths, setWidths] = useState<MailPaneWidths>(loadWidths)

  const availableWidth = useCallback(() => containerRef.current?.clientWidth ?? window.innerWidth, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const fitToContainer = () => setWidths((current) => {
      const next = fitWidths(current, container.clientWidth)
      return next.sidebar === current.sidebar && next.list === current.list ? current : next
    })
    fitToContainer()
    const observer = new ResizeObserver(fitToContainer)
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(widths))
  }, [widths])

  useEffect(() => () => activeResizeCleanup.current?.(), [])

  const changeWidth = useCallback((pane: ResizablePane, desired: number) => {
    setWidths((current) => {
      const containerWidth = availableWidth()
      const maximum = pane === 'sidebar'
        ? Math.min(SIDEBAR_MAX, containerWidth - current.list - READER_MIN - SEPARATOR_SPACE)
        : Math.min(LIST_MAX, containerWidth - current.sidebar - READER_MIN - SEPARATOR_SPACE)
      const minimum = pane === 'sidebar' ? SIDEBAR_MIN : LIST_MIN
      return { ...current, [pane]: clamp(desired, minimum, Math.max(minimum, maximum)) }
    })
  }, [availableWidth])

  const startResize = useCallback((pane: ResizablePane, event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    activeResizeCleanup.current?.()
    const startX = event.clientX
    const startWidth = widths[pane]
    const move = (moveEvent: globalThis.PointerEvent) => changeWidth(pane, startWidth + moveEvent.clientX - startX)
    const finish = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      document.body.classList.remove('resizing-mail-panes')
      activeResizeCleanup.current = undefined
    }
    activeResizeCleanup.current = finish
    document.body.classList.add('resizing-mail-panes')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }, [changeWidth, widths])

  const resizeWithKeyboard = useCallback((pane: ResizablePane, event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    changeWidth(pane, widths[pane] + (event.key === 'ArrowRight' ? KEYBOARD_STEP : -KEYBOARD_STEP))
  }, [changeWidth, widths])

  const resetWidths = useCallback(() => setWidths(fitWidths(DEFAULT_WIDTHS, availableWidth())), [availableWidth])
  const style = {
    '--mail-sidebar-width': `${widths.sidebar}px`,
    '--mail-list-width': `${widths.list}px`
  } as CSSProperties

  return { containerRef, style, widths, startResize, resizeWithKeyboard, resetWidths }
}
