import { CalendarClock, Clock3, Moon, Sunrise } from 'lucide-react'
import { useMemo, useState } from 'react'
import Modal from './Modal'

interface MailSnoozeModalProps {
  count: number
  onApply(until: string): Promise<void>
  onClose(): void
}

const atLocalTime = (date: Date, hour: number) => {
  const value = new Date(date)
  value.setHours(hour, 0, 0, 0)
  return value
}

const localInput = (date: Date) => {
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

export default function MailSnoozeModal({ count, onApply, onClose }: MailSnoozeModalProps) {
  const options = useMemo(() => {
    const now = new Date()
    const laterToday = atLocalTime(now, 18)
    if (laterToday.getTime() <= now.getTime()) laterToday.setTime(now.getTime() + 3 * 60 * 60_000)
    const tomorrow = atLocalTime(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1), 8)
    const nextWeek = atLocalTime(new Date(now), 8)
    nextWeek.setDate(nextWeek.getDate() + ((8 - nextWeek.getDay()) % 7 || 7))
    return [
      { label: 'Later today', detail: laterToday.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }), date: laterToday, icon: Moon },
      { label: 'Tomorrow morning', detail: tomorrow.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }), date: tomorrow, icon: Sunrise },
      { label: 'Next week', detail: nextWeek.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }), date: nextWeek, icon: CalendarClock }
    ]
  }, [])
  const [custom, setCustom] = useState(() => localInput(new Date(Date.now() + 24 * 60 * 60_000)))
  const [busy, setBusy] = useState(false)

  const apply = async (date: Date) => {
    if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) return
    setBusy(true)
    try {
      await onApply(date.toISOString())
      onClose()
    } catch {
      // The parent reports the provider/storage error and the picker remains open.
    } finally {
      setBusy(false)
    }
  }

  return <Modal title="Snooze conversations" subtitle={`${count.toLocaleString()} conversation${count === 1 ? '' : 's'} will return to Inbox`} width="small" onClose={onClose}>
    <div className="snooze-options">
      {options.map((option) => <button key={option.label} disabled={busy} onClick={() => void apply(option.date)}><option.icon size={18} /><span><strong>{option.label}</strong><small>{option.detail}</small></span></button>)}
      <div className="snooze-custom"><Clock3 size={18} /><label><strong>Choose a time</strong><input type="datetime-local" min={localInput(new Date(Date.now() + 60_000))} value={custom} onChange={(event) => setCustom(event.target.value)} /></label><button className="button primary small" disabled={busy || new Date(custom).getTime() <= Date.now()} onClick={() => void apply(new Date(custom))}>Snooze</button></div>
    </div>
    <footer className="modal-footer"><span className="spacer" /><button className="button ghost" disabled={busy} onClick={onClose}>Cancel</button></footer>
  </Modal>
}
