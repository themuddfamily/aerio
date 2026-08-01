import { useEffect, useRef, type RefObject } from 'react'

const focusableSelector = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[href]',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

export function useDialogFocus<T extends HTMLElement>(onClose: () => void, active = true, closeEnabled = true): RefObject<T | null> {
  const dialogRef = useRef<T>(null)
  const onCloseRef = useRef(onClose)
  const closeEnabledRef = useRef(closeEnabled)

  useEffect(() => { onCloseRef.current = onClose }, [onClose])
  useEffect(() => { closeEnabledRef.current = closeEnabled }, [closeEnabled])

  useEffect(() => {
    if (!active) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const animationFrame = requestAnimationFrame(() => {
      const dialog = dialogRef.current
      if (!dialog || dialog.contains(document.activeElement)) return
      dialog.querySelector<HTMLElement>('[autofocus]')?.focus()
      if (!dialog.contains(document.activeElement)) dialog.querySelector<HTMLElement>(focusableSelector)?.focus()
      if (!dialog.contains(document.activeElement)) dialog.focus()
    })

    const onKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current
      if (!dialog) return
      if (event.target instanceof Element && event.target.closest('[role="menu"]')) return
      if (event.key === 'Escape' && closeEnabledRef.current) {
        event.preventDefault()
        event.stopPropagation()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector))
        .filter((element) => element.getClientRects().length > 0 && element.getAttribute('aria-hidden') !== 'true')
      if (!focusable.length) {
        event.preventDefault()
        dialog.focus()
        return
      }
      const first = focusable[0]
      const last = focusable.at(-1)!
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      cancelAnimationFrame(animationFrame)
      document.removeEventListener('keydown', onKeyDown, true)
      if (previousFocus?.isConnected) queueMicrotask(() => previousFocus.focus())
    }
  }, [active])

  return dialogRef
}
