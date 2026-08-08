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

export function useDialogFocus<T extends HTMLElement>(onClose: () => void, active = true, closeEnabled = true, ownerDocument?: Document): RefObject<T | null> {
  const dialogRef = useRef<T>(null)
  const onCloseRef = useRef(onClose)
  const closeEnabledRef = useRef(closeEnabled)

  useEffect(() => { onCloseRef.current = onClose }, [onClose])
  useEffect(() => { closeEnabledRef.current = closeEnabled }, [closeEnabled])

  useEffect(() => {
    if (!active) return
    const targetDocument = ownerDocument ?? document
    const targetWindow = targetDocument.defaultView ?? window
    const previousFocus = targetDocument.activeElement instanceof targetWindow.HTMLElement ? targetDocument.activeElement as HTMLElement : undefined
    let cancelled = false
    const focusDialog = () => {
      if (cancelled) return
      const dialog = dialogRef.current
      if (!dialog || dialog.contains(targetDocument.activeElement)) return
      dialog.querySelector<HTMLElement>('[autofocus]')?.focus()
      if (!dialog.contains(targetDocument.activeElement)) dialog.querySelector<HTMLElement>(focusableSelector)?.focus()
      if (!dialog.contains(targetDocument.activeElement)) dialog.focus()
    }
    queueMicrotask(focusDialog)
    const animationFrame = targetWindow.requestAnimationFrame(focusDialog)

    const onKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current
      if (!dialog) return
      if (event.target instanceof targetWindow.Element && event.target.closest('[role="menu"]')) return
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
      if (event.shiftKey && (targetDocument.activeElement === first || !dialog.contains(targetDocument.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (targetDocument.activeElement === last || !dialog.contains(targetDocument.activeElement))) {
        event.preventDefault()
        first.focus()
      }
    }

    targetDocument.addEventListener('keydown', onKeyDown, true)
    return () => {
      cancelled = true
      targetWindow.cancelAnimationFrame(animationFrame)
      targetDocument.removeEventListener('keydown', onKeyDown, true)
      if (previousFocus?.isConnected) queueMicrotask(() => previousFocus.focus())
    }
  }, [active, ownerDocument])

  return dialogRef
}
