import { useState } from 'react'
import type { RecurrenceEditScope } from '../types'
import {
  describeRecurrence, formatRecurrenceRule, newRecurrenceRule, parseRecurrenceRule, untilDate,
  type RecurrenceFrequency, type RecurrenceRule
} from '../lib/recurrence'

type Preset = 'none' | 'daily' | 'weekly' | 'weekdays' | 'monthly' | 'yearly' | 'custom' | 'preserved'

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const ORDINALS: Record<number, string> = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', 5: 'fifth', [-1]: 'last' }
const UNITS: Record<RecurrenceFrequency, string> = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' }
const WORKWEEK = [1, 2, 3, 4, 5]

const onlyFrequency = (rule: RecurrenceRule) => rule.interval === 1 && rule.count === undefined && !rule.until && !rule.byDay.length &&
  !rule.byMonthDay.length && !rule.byMonth.length && !rule.bySetPos.length && Object.keys(rule.parts).every((key) => ['FREQ', 'INTERVAL'].includes(key))

function presetOf(rule: RecurrenceRule | undefined): Preset {
  if (!rule) return 'none'
  if (rule.unsupported.length) return 'preserved'
  if (onlyFrequency(rule)) return rule.freq.toLowerCase() as Preset
  const workweek = rule.freq === 'WEEKLY' && rule.interval === 1 && rule.count === undefined && !rule.until && rule.byDay.length === 5 &&
    WORKWEEK.every((day) => rule.byDay.some((item) => item.weekday === day && item.ordinal === undefined)) && !rule.byMonth.length && !rule.bySetPos.length
  return workweek ? 'weekdays' : 'custom'
}

function dateParts(value: string) {
  const [year, month, day] = value.slice(0, 10).split('-').map(Number)
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return { year, month, day, weekday, ordinal: Math.ceil(day / 7), isLast: day + 7 > lastDay }
}

type MonthlyMode = 'date' | 'weekday' | 'last-weekday' | 'kept'

function monthlyModeOf(rule: RecurrenceRule, start: ReturnType<typeof dateParts>): MonthlyMode {
  if (!rule.byDay.length && !rule.byMonthDay.length && !rule.bySetPos.length) return 'date'
  if (rule.byMonthDay.length === 1 && rule.byMonthDay[0] === start.day && !rule.byDay.length && !rule.bySetPos.length) return 'date'
  if (rule.byDay.length === 1 && !rule.byMonthDay.length && !rule.bySetPos.length && rule.byDay[0].weekday === start.weekday) {
    if (rule.byDay[0].ordinal === start.ordinal) return 'weekday'
    if (rule.byDay[0].ordinal === -1) return 'last-weekday'
  }
  return 'kept'
}

export interface RepeatFieldProps {
  value: string | undefined
  startDate: string
  disabled?: boolean
  // Shown instead of the editor when the provider manages the series rule (synced occurrences).
  managedNote?: string
  onChange(value: string | undefined): void
}

export function RepeatField({ value, startDate, disabled = false, managedNote, onChange }: RepeatFieldProps) {
  const rule = parseRecurrenceRule(value)
  const preset = presetOf(rule)
  const [customOpen, setCustomOpen] = useState(preset === 'custom')
  const start = dateParts(startDate)
  const selected = customOpen && rule && preset !== 'preserved' ? 'custom' : preset
  const update = (next: RecurrenceRule) => onChange(formatRecurrenceRule(next))

  if (managedNote) {
    return <div className="field-label">Repeat<p className="recurrence-note" role="note">{managedNote}</p></div>
  }

  const choose = (next: Preset) => {
    setCustomOpen(next === 'custom')
    if (next === 'none') onChange(undefined)
    else if (next === 'weekdays') onChange('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')
    else if (next === 'custom') { if (!rule || rule.unsupported.length) onChange('FREQ=WEEKLY') }
    else if (next !== 'preserved') onChange(`FREQ=${next.toUpperCase()}`)
  }

  const monthlyMode = rule ? monthlyModeOf(rule, start) : 'date'
  const setMonthlyMode = (mode: MonthlyMode) => {
    if (!rule || mode === 'kept') return
    const byDay = mode === 'weekday' ? [{ weekday: start.weekday, ordinal: start.ordinal }] : mode === 'last-weekday' ? [{ weekday: start.weekday, ordinal: -1 }] : []
    update({ ...rule, byDay, byMonthDay: [], bySetPos: [], byMonth: rule.freq === 'YEARLY' && mode !== 'date' ? [start.month] : rule.byMonth })
  }
  const endMode = rule?.count !== undefined ? 'count' : rule?.until ? 'until' : 'never'

  return (
    <div className="recurrence-field">
      <label className="field-label">Repeat<select value={selected} disabled={disabled} onChange={(event) => choose(event.target.value as Preset)}>
        <option value="none">Doesn’t repeat</option>
        <option value="daily">Daily</option>
        <option value="weekly">Weekly on {WEEKDAY_NAMES[start.weekday]}</option>
        <option value="weekdays">Every weekday (Mon–Fri)</option>
        <option value="monthly">Monthly on day {start.day}</option>
        <option value="yearly">Yearly on {new Date(Date.UTC(start.year, start.month - 1, start.day)).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' })}</option>
        <option value="custom">Custom…</option>
        {preset === 'preserved' && <option value="preserved">Custom rule (kept as is)</option>}
      </select></label>
      {selected === 'preserved' && rule && (
        <p className="recurrence-note" role="note">
          This repeat rule uses options Aerio can’t edit ({rule.unsupported.join(', ')}), so it is kept exactly as it is. Choose another option to replace it.
        </p>
      )}
      {selected === 'custom' && rule && !disabled && (
        <div className="recurrence-custom" role="group" aria-label="Custom repeat">
          <div className="recurrence-row">
            <label className="field-label">Every<input type="number" min={1} max={999} value={rule.interval} onChange={(event) => update({ ...rule, interval: Math.min(999, Math.max(1, Math.floor(Number(event.target.value) || 1))) })} /></label>
            <label className="field-label">Unit<select value={rule.freq} onChange={(event) => update(newRecurrenceRule(event.target.value as RecurrenceFrequency, { interval: rule.interval, count: rule.count, until: rule.until }))}>
              {(Object.keys(UNITS) as RecurrenceFrequency[]).map((freq) => <option key={freq} value={freq}>{UNITS[freq]}{rule.interval === 1 ? '' : 's'}</option>)}
            </select></label>
          </div>
          {rule.freq === 'WEEKLY' && (
            <div className="recurrence-weekdays" role="group" aria-label="Repeat on">
              {WEEKDAY_LABELS.map((label, weekday) => {
                const active = rule.byDay.length ? rule.byDay.some((item) => item.weekday === weekday) : weekday === start.weekday
                return <button type="button" key={label} className={active ? 'active' : ''} aria-pressed={active} aria-label={WEEKDAY_NAMES[weekday]} onClick={() => {
                  const current = rule.byDay.length ? rule.byDay.map((item) => item.weekday) : [start.weekday]
                  const next = active ? current.filter((item) => item !== weekday) : [...current, weekday]
                  update({ ...rule, byDay: (next.length ? next : [start.weekday]).sort((a, b) => a - b).map((item) => ({ weekday: item })) })
                }}>{label.slice(0, 2)}</button>
              })}
            </div>
          )}
          {(rule.freq === 'MONTHLY' || rule.freq === 'YEARLY') && (
            <label className="field-label">On<select value={monthlyMode} onChange={(event) => setMonthlyMode(event.target.value as MonthlyMode)}>
              <option value="date">{rule.freq === 'YEARLY' ? `${start.day} ${new Date(Date.UTC(2000, start.month - 1, 1)).toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' })}` : `Day ${start.day}`}</option>
              {start.ordinal <= 4 && <option value="weekday">The {ORDINALS[start.ordinal]} {WEEKDAY_NAMES[start.weekday]}</option>}
              {start.isLast && <option value="last-weekday">The last {WEEKDAY_NAMES[start.weekday]}</option>}
              {monthlyMode === 'kept' && <option value="kept">As set: {describeRecurrence({ ...rule, count: undefined, until: undefined })}</option>}
            </select></label>
          )}
          <div className="recurrence-row">
            <label className="field-label">Repeat ends<select value={endMode} onChange={(event) => {
              const mode = event.target.value
              if (mode === 'never') update({ ...rule, count: undefined, until: undefined })
              else if (mode === 'count') update({ ...rule, until: undefined, count: rule.count ?? 10 })
              else update({ ...rule, count: undefined, until: rule.until ?? startDate.slice(0, 10).replace(/-/g, '') })
            }}>
              <option value="never">Never</option>
              <option value="until">On date</option>
              <option value="count">After a number of times</option>
            </select></label>
            {endMode === 'until' && <label className="field-label">Last date<input type="date" value={untilDate(rule.until!) ?? ''} onChange={(event) => {
              if (/^\d{4}-\d{2}-\d{2}$/.test(event.target.value)) update({ ...rule, count: undefined, until: event.target.value.replace(/-/g, '') })
            }} /></label>}
            {endMode === 'count' && <label className="field-label">Occurrences<input type="number" min={1} max={999} value={rule.count} onChange={(event) => update({ ...rule, until: undefined, count: Math.min(999, Math.max(1, Math.floor(Number(event.target.value) || 1))) })} /></label>}
          </div>
        </div>
      )}
      {rule && selected !== 'preserved' && <p className="recurrence-summary" aria-live="polite">{describeRecurrence(rule)}</p>}
    </div>
  )
}

export function RecurrenceScopeChooser({ action, allowOccurrence = true, busy = false, onChoose, onCancel }: {
  action: 'save' | 'delete'
  allowOccurrence?: boolean
  busy?: boolean
  onChoose(scope: RecurrenceEditScope): void
  onCancel(): void
}) {
  const verb = action === 'save' ? 'Save' : 'Delete'
  return (
    <div className="recurrence-scope" role="group" aria-label={action === 'save' ? 'Save repeating event' : 'Delete repeating event'}>
      <p>{action === 'save' ? 'This is a repeating event. Apply your changes to:' : 'This is a repeating event. Delete:'}</p>
      <div className="recurrence-scope-actions">
        {allowOccurrence && <button className={`button ${action === 'delete' ? 'danger-subtle' : 'primary'}`} disabled={busy} onClick={() => onChoose('occurrence')}>{verb} this event</button>}
        <button className={`button ${action === 'delete' ? 'danger-subtle' : 'ghost'}`} disabled={busy} onClick={() => onChoose('following')}>{verb} this and following events</button>
        <button className={`button ${action === 'delete' ? 'danger-subtle' : 'ghost'}`} disabled={busy} onClick={() => onChoose('series')}>{verb} all events</button>
        <button className="button ghost" disabled={busy} onClick={onCancel}>Back</button>
      </div>
    </div>
  )
}
