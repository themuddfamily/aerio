import { Minus, Square, X } from 'lucide-react'
import { useEffect, useState } from 'react'

export default function TitleBar() {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    void window.aerio.window.isMaximized().then(setMaximized)
    return window.aerio.onWindowState(setMaximized)
  }, [])

  return (
    <div className="titlebar">
      <div className="titlebar-drag">
        <div className="brand-lockup">
          <span className="brand-mark">A</span>
          <span>Aerio</span>
        </div>
      </div>
      <div className="window-actions" aria-label="Window controls">
        <button className="window-button" aria-label="Minimize" onClick={() => void window.aerio.window.minimize()}>
          <Minus size={15} />
        </button>
        <button className="window-button" aria-label={maximized ? 'Restore' : 'Maximize'} onClick={() => void window.aerio.window.maximize()}>
          <Square size={12} />
        </button>
        <button className="window-button window-close" aria-label="Close" onClick={() => void window.aerio.window.close()}>
          <X size={16} />
        </button>
      </div>
    </div>
  )
}
