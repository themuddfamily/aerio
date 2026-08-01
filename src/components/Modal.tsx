import { Maximize2, Minimize2, X } from 'lucide-react'
import { useEffect, useRef, useState, type PropsWithChildren, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { registerContextMenuDocument } from './ContextMenu'
import { useDialogFocus } from '../lib/dialog-focus'

type ModalWidth = 'small' | 'medium' | 'large'

export interface ModalShellProps extends PropsWithChildren {
  title: string
  subtitle?: string
  width?: ModalWidth
  className?: string
  backdropClassName?: string
  heading?: ReactNode
  closeEnabled?: boolean
  closeTitle?: string
  popoutSize?: { width: number; height: number }
  onClose(): void
}

const copyStyles = (target: Document) => {
  for (const node of document.head.querySelectorAll<HTMLLinkElement | HTMLStyleElement>('link[rel="stylesheet"], style')) {
    const copy = node.cloneNode(true) as HTMLLinkElement | HTMLStyleElement
    if (copy instanceof HTMLLinkElement) copy.href = node instanceof HTMLLinkElement ? node.href : ''
    target.head.append(copy)
  }
}

const syncRootAppearance = (target: Document) => {
  for (const name of ['data-theme', 'data-density']) {
    const value = document.documentElement.getAttribute(name)
    if (value === null) target.documentElement.removeAttribute(name)
    else target.documentElement.setAttribute(name, value)
  }
}

function preparePopout(target: Window, title: string) {
  target.document.title = `${title} — Aerio`
  target.document.documentElement.lang = document.documentElement.lang || 'en'
  target.document.head.replaceChildren()
  const charset = target.document.createElement('meta')
  charset.setAttribute('charset', 'UTF-8')
  target.document.head.append(charset)
  copyStyles(target.document)
  syncRootAppearance(target.document)
  target.document.body.className = 'modal-popout-host'
}

export function ModalShell({
  title,
  subtitle,
  width = 'medium',
  className = '',
  backdropClassName = '',
  heading,
  closeEnabled = true,
  closeTitle = 'Close',
  popoutSize,
  onClose,
  children
}: ModalShellProps) {
  const [popout, setPopout] = useState<Window | null>(null)
  const popoutRef = useRef<Window | null>(null)
  const dockingRef = useRef(false)
  const closeEnabledRef = useRef(closeEnabled)
  const onCloseRef = useRef(onClose)
  const ownerDocument = popout?.document
  const dialogRef = useDialogFocus<HTMLElement>(onClose, true, closeEnabled, ownerDocument)

  useEffect(() => { closeEnabledRef.current = closeEnabled }, [closeEnabled])
  useEffect(() => { onCloseRef.current = onClose }, [onClose])

  useEffect(() => {
    if (!popout) return
    popout.document.title = `${title} — Aerio`
  }, [popout, title])

  useEffect(() => {
    if (!popout) return
    const unregisterContextMenu = registerContextMenuDocument(popout.document)
    const observer = new MutationObserver(() => syncRootAppearance(popout.document))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-density'] })
    let handled = false
    const handleClosed = () => {
      if (handled) return
      handled = true
      if (popoutRef.current === popout) popoutRef.current = null
      if (dockingRef.current) return
      if (closeEnabledRef.current) onCloseRef.current()
      else setPopout(null)
    }
    popout.addEventListener('beforeunload', handleClosed)
    const closedCheck = window.setInterval(() => { if (popout.closed) handleClosed() }, 250)
    return () => {
      handled = true
      window.clearInterval(closedCheck)
      popout.removeEventListener('beforeunload', handleClosed)
      observer.disconnect()
      unregisterContextMenu()
      if (!popout.closed) popout.close()
    }
  }, [popout])

  const openPopout = () => {
    if (popout && !popout.closed) {
      popout.focus()
      return
    }
    const size = popoutSize ?? {
      width: width === 'small' ? 520 : width === 'large' ? 900 : 720,
      height: width === 'small' ? 620 : 760
    }
    const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - size.width) / 2))
    const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - size.height) / 2))
    const name = `aerio-modal-${crypto.randomUUID()}`
    const child = window.open(
      'about:blank',
      name,
      `popup=yes,width=${size.width},height=${size.height},left=${left},top=${top},resizable=yes,scrollbars=no`
    )
    if (!child) return
    dockingRef.current = false
    preparePopout(child, title)
    popoutRef.current = child
    setPopout(child)
    child.focus()
  }

  const dockPopout = () => {
    if (!popout) return
    dockingRef.current = true
    popoutRef.current = null
    popout.close()
    setPopout(null)
    window.focus()
    window.setTimeout(() => { dockingRef.current = false }, 0)
  }

  const modal = (
    <div
      className={`modal-backdrop ${backdropClassName} ${popout ? 'modal-popout-backdrop' : ''}`.trim()}
      role="presentation"
      onMouseDown={(event) => {
        if (closeEnabled && event.currentTarget === event.target) onClose()
      }}
    >
      <section
        ref={dialogRef}
        className={`modal ${className || `modal-${width}`} ${popout ? 'modal-popped-out' : ''}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <header className="modal-header">
          {heading ?? <div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>}
          <div className="modal-header-actions">
            <button
              className="icon-button"
              aria-label={popout ? `Return ${title} to main window` : `Pop out ${title}`}
              title={popout ? 'Return to main window' : 'Open in new window'}
              onClick={popout ? dockPopout : openPopout}
            >
              {popout ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
            </button>
            <button className="icon-button" aria-label="Close" title={closeTitle} disabled={!closeEnabled} onClick={onClose}>
              <X size={18} />
            </button>
          </div>
        </header>
        {children}
      </section>
    </div>
  )

  return popout ? createPortal(modal, popout.document.body) : modal
}

export default function Modal(props: ModalShellProps) {
  return <ModalShell {...props} />
}
