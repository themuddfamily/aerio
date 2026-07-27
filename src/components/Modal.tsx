import type { PropsWithChildren } from 'react'
import { X } from 'lucide-react'

interface ModalProps extends PropsWithChildren {
  title: string
  subtitle?: string
  width?: 'small' | 'medium' | 'large'
  onClose(): void
}

export default function Modal({ title, subtitle, width = 'medium', onClose, children }: ModalProps) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose()
    }}>
      <section className={`modal modal-${width}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-header">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-button" aria-label="Close" onClick={onClose}><X size={18} /></button>
        </header>
        {children}
      </section>
    </div>
  )
}
