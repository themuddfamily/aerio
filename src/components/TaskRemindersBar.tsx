import { Bell, BellOff, Clock } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { TaskReminder } from '../task-fields-types'

const snoozeOptions: [string, (now: Date) => Date][] = [
  ['5 minutes', (now) => new Date(now.getTime() + 5 * 60_000)],
  ['1 hour', (now) => new Date(now.getTime() + 60 * 60_000)],
  ['Tomorrow morning', (now) => { const next = new Date(now); next.setDate(next.getDate() + 1); next.setHours(9, 0, 0, 0); return next }]
]

/**
 * Fired task reminders with dismiss and snooze (E44). Delivery state lives in the main process, so
 * dismissing here also stops the reminder after restart.
 */
export default function TaskRemindersBar({ onOpen, onToast }: { onOpen(reminder: TaskReminder): void; onToast(message: string): void }) {
  const [reminders, setReminders] = useState<TaskReminder[]>([])
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const api = window.aerio?.tasks?.reminders
    if (!api) return
    let active = true
    void api.list().then((items) => { if (active) setReminders(items) }).catch(() => {})
    const unsubscribe = api.onChanged((items) => { if (active) setReminders(items) })
    return () => { active = false; unsubscribe() }
  }, [])
  const visible = reminders.filter((reminder) => reminder.status === 'fired')
  if (!visible.length) return null
  const act = async (command: () => Promise<TaskReminder[]>, message: string) => {
    if (busy) return
    setBusy(true)
    try { setReminders(await command()); onToast(message) }
    catch (error) { onToast(error instanceof Error ? error.message : 'The reminder could not be updated') }
    finally { setBusy(false) }
  }
  const api = window.aerio.tasks.reminders!
  return <section className="task-reminders-bar" aria-label="Task reminders">
    <header><Bell size={15} /><strong>{visible.length === 1 ? 'Reminder' : `${visible.length} reminders`}</strong></header>
    {visible.map((reminder) => <div className="task-reminder" key={reminder.key}>
      <button className="task-reminder-title" onClick={() => onOpen(reminder)}><strong>{reminder.title}</strong>
        <small>{reminder.missed ? 'Missed · ' : ''}{new Date(reminder.reminderAt).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</small></button>
      <label className="task-reminder-snooze"><Clock size={13} /><select aria-label={`Snooze ${reminder.title}`} value="" disabled={busy} onChange={(event) => {
        const option = snoozeOptions.find(([label]) => label === event.target.value)
        if (option) void act(() => api.snooze(reminder.key, option[1](new Date()).toISOString()), option[0] === 'Tomorrow morning' ? 'Reminder snoozed until tomorrow morning' : `Reminder snoozed for ${option[0]}`)
      }}><option value="">Snooze…</option>{snoozeOptions.map(([label]) => <option key={label} value={label}>{label}</option>)}</select></label>
      <button className="button ghost small" disabled={busy} aria-label={`Dismiss ${reminder.title}`} onClick={() => void act(() => api.dismiss(reminder.key), 'Reminder dismissed')}><BellOff size={13} /> Dismiss</button>
    </div>)}
  </section>
}
