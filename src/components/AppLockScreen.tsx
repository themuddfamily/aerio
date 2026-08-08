import { FormEvent, useRef, useState } from 'react'
import { LockKeyhole } from 'lucide-react'
import type { AppLockStatus } from '../types'
import TitleBar from './TitleBar'

export default function AppLockScreen({ onUnlocked }: { onUnlocked(status: AppLockStatus): void }) {
  const [passphrase, setPassphrase] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const unlock = async (event: FormEvent) => {
    event.preventDefault()
    if (!passphrase || busy) return
    setBusy(true)
    setError('')
    try {
      const status = await window.aerio.appLock.unlock(passphrase)
      setPassphrase('')
      onUnlocked(status)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Aerio could not be unlocked')
      setPassphrase('')
      queueMicrotask(() => inputRef.current?.focus())
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="app app-locked">
      <TitleBar title="Aerio locked" />
      <main className="lock-screen">
        <form className="lock-card" onSubmit={(event) => void unlock(event)}>
          <span className="lock-mark"><LockKeyhole size={25} /></span>
          <h1>Unlock Aerio</h1>
          <p>Enter your local app-lock passphrase to return to your workspace.</p>
          <label className="field-label">Passphrase
            <input ref={inputRef} autoFocus type="password" autoComplete="current-password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} />
          </label>
          {error && <small className="diagnostic-error" role="alert">{error}</small>}
          <button className="button primary" type="submit" disabled={!passphrase || busy}>{busy ? 'Unlocking…' : 'Unlock Aerio'}</button>
          <small>This privacy lock hides the workspace; it does not encrypt Aerio’s local files.</small>
        </form>
      </main>
    </div>
  )
}
