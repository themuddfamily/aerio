import { MAX_EVENT_REMINDERS, MAX_EVENT_REMINDER_MINUTES } from '../lib/event-reminders'

export function EventRemindersField({ value, onChange, disabled, limit = MAX_EVENT_REMINDERS }: {
  value: number[]; onChange(value: number[]): void; disabled?: boolean; limit?: number
}) {
  return <fieldset className="form-stack" disabled={disabled}>
    <legend>Reminders</legend>
    {value.length === 0 && <p>No reminders</p>}
    {value.map((minutes, index) => <div className="form-grid-2" key={index}>
      <label className="field-label">Reminder {index + 1} (minutes before start)
        <input type="number" min={0} max={MAX_EVENT_REMINDER_MINUTES} step={1} value={minutes}
          onChange={(event) => onChange(value.map((item, position) => position === index ? Number(event.target.value) : item))} />
      </label>
      <button type="button" className="button" onClick={() => onChange(value.filter((_, position) => position !== index))}>Remove reminder {index + 1}</button>
    </div>)}
    <p className="recurrence-note">0 means at event time. {limit === 1 ? 'This provider supports one reminder per event.' : `Add up to ${limit} reminders.`}</p>
    <button type="button" className="button" disabled={value.length >= limit} onClick={() => {
      const next = [15, 30, 60, 1440, 0].find((minutes) => !value.includes(minutes)) ?? 5
      onChange([...value, next])
    }}>Add reminder</button>
  </fieldset>
}
