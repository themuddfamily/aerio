import { AlertTriangle, CalendarClock, ChevronLeft, ChevronRight, RefreshCw, Sparkles, UserPlus, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Modal from './Modal'
import type { AttendeeAvailability, AvailabilityRequest, AvailabilityResult, WorkingHours } from '../scheduling-types'
import {
  addZonedDays, attendeeAddress, formatZoneDay, formatZoneTime, loadSecondaryZone, loadWorkingHours, msToWallInput,
  parseAttendeeText, saveSecondaryZone, saveWorkingHours, startOfZonedDay, statusDuring, suggestSlots, wallInputToMs,
  withinWorkingHours, type CellStatus, type Participant, type ParticipantRole
} from '../lib/scheduling'
import { localTimeZone, timeZoneOffsetLabel as zoneLabel, timeZoneOptions } from '../lib/time-zones'

export interface SchedulingAssistantApi {
  availability?(request: AvailabilityRequest): Promise<AvailabilityResult>
  reconnect?(accountId: string): Promise<void>
}

export interface SchedulingSelection {
  start: string
  end: string
  attendees: string[]
}

interface SchedulingAssistantProps {
  calendarId: string
  /** Email of the organizer's account; shown as the first row when it is a real address. */
  organizerEmail?: string
  /** Editor values: `datetime-local` strings in `inputTimeZone` and the attendee text. */
  start: string
  end: string
  attendees: string
  /** Zone of the editor's start/end fields (the event's time zone); defaults to the display zone. */
  inputTimeZone?: string
  api?: SchedulingAssistantApi
  /** Display zone; defaults to the computer's zone. */
  timeZone?: string
  now?: () => number
  onApply(selection: SchedulingSelection): void
  onClose(): void
}

const STEP_MINUTES = 30
const LOOKAHEAD_DAYS = 7
const DURATIONS = [15, 30, 45, 60, 90, 120]
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const STATUS_LABELS: Record<CellStatus, string> = {
  free: 'Free', busy: 'Busy', tentative: 'Tentative', oof: 'Out of office', workingElsewhere: 'Working elsewhere', unknown: 'Unknown'
}
const ROLE_LABELS: Record<ParticipantRole, string> = { required: 'Required', optional: 'Optional', resource: 'Resource' }

const defaultApi = (): SchedulingAssistantApi => {
  const aerio = typeof window === 'undefined' ? undefined : window.aerio
  return {
    availability: aerio?.productivity?.availability?.bind(aerio.productivity),
    reconnect: aerio?.mail?.accounts?.reconnect?.bind(aerio.mail.accounts)
  }
}

const isEmail = (value: string) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(attendeeAddress(value))

export default function SchedulingAssistant({
  calendarId, organizerEmail, start, end, attendees, inputTimeZone, api: providedApi, timeZone: providedZone, now = Date.now, onApply, onClose
}: SchedulingAssistantProps) {
  const api = useMemo(() => providedApi ?? defaultApi(), [providedApi])
  const timeZone = providedZone ?? localTimeZone()
  const editorZone = inputTimeZone ?? timeZone
  const organizer = organizerEmail && isEmail(organizerEmail) ? attendeeAddress(organizerEmail) : undefined
  const parsedStart = wallInputToMs(start, editorZone)
  const parsedEnd = wallInputToMs(end, editorZone)
  const initialStart = Number.isFinite(parsedStart) ? parsedStart : now()
  const initialEnd = Number.isFinite(parsedEnd) && parsedEnd > initialStart ? parsedEnd : initialStart + 3_600_000
  const [participants, setParticipants] = useState<Participant[]>(() => parseAttendeeText(attendees)
    .filter((value) => attendeeAddress(value) !== organizer)
    .map((email) => ({ email, role: 'required' as const })))
  const [proposed, setProposed] = useState({ start: initialStart, end: initialEnd })
  const [day, setDay] = useState(() => startOfZonedDay(initialStart, timeZone))
  const [draft, setDraft] = useState('')
  const [draftRole, setDraftRole] = useState<ParticipantRole>('required')
  const [workingHours, setWorkingHours] = useState<WorkingHours>(() => loadWorkingHours(timeZone))
  const [secondaryZone, setSecondaryZone] = useState(loadSecondaryZone)
  const [result, setResult] = useState<AvailabilityResult>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const request = useRef(0)
  const durationMinutes = Math.max(5, Math.round((proposed.end - proposed.start) / 60_000))
  const rangeEnd = addZonedDays(day, LOOKAHEAD_DAYS, timeZone)
  const lookupEmails = useMemo(() => [...(organizer ? [organizer] : []), ...participants.map((item) => item.email)], [organizer, participants])
  const lookupKey = `${calendarId}\n${day}\n${lookupEmails.join('\n')}`

  const load = useCallback(async () => {
    const id = ++request.current
    if (!api.availability) {
      setResult(undefined)
      setError('Free/busy lookup isn’t available in this window')
      return
    }
    setLoading(true)
    setError(undefined)
    try {
      const value = await api.availability({ calendarId, attendees: lookupEmails, start: new Date(day).toISOString(), end: new Date(rangeEnd).toISOString() })
      if (id === request.current) setResult(value)
    } catch (failure) {
      if (id === request.current) setError(failure instanceof Error ? failure.message : 'Availability could not be loaded')
    } finally {
      if (id === request.current) setLoading(false)
    }
    // lookupKey captures every input of the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, lookupKey])

  useEffect(() => { void load() }, [load])

  const availabilityFor = (email: string): AttendeeAvailability | undefined =>
    result?.attendees.find((item) => attendeeAddress(item.email) === attendeeAddress(email))

  const rows = [
    ...(organizer ? [{ email: organizer, role: 'required' as const, organizer: true }] : []),
    ...participants.map((item) => ({ ...item, organizer: false }))
  ]
  const cells = Array.from({ length: 24 * 60 / STEP_MINUTES }, (_, index) => day + index * STEP_MINUTES * 60_000)
    // A DST day has 23 or 25 hours; keep the cells inside the zone's calendar day.
    .filter((cell) => cell < addZonedDays(day, 1, timeZone))

  const suggestions = useMemo(() => result ? suggestSlots({
    participants: rows.map(({ email, role }) => ({ email, role })),
    availability: result.attendees,
    durationMinutes,
    from: Math.max(day, now()),
    to: rangeEnd,
    workingHours,
    stepMinutes: STEP_MINUTES,
    limit: 5
  }) : [],
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [result, durationMinutes, workingHours, participants, organizer, day, rangeEnd])

  const unknownRequired = rows.filter((row) => row.role !== 'optional' && result && !availabilityFor(row.email)?.known)

  const addParticipant = () => {
    const values = parseAttendeeText(draft)
    if (!values.length) return
    setParticipants((current) => {
      const seen = new Set([...(organizer ? [organizer] : []), ...current.map((item) => attendeeAddress(item.email))])
      const additions = values.filter((value) => {
        const key = attendeeAddress(value)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      }).map((email) => ({ email, role: draftRole }))
      return [...current, ...additions]
    })
    setDraft('')
  }

  const updateHours = (next: WorkingHours) => {
    setWorkingHours(next)
    saveWorkingHours(next)
  }

  const moveTo = (startMs: number) => {
    setProposed({ start: startMs, end: startMs + durationMinutes * 60_000 })
    setDay(startOfZonedDay(startMs, timeZone))
  }

  const reconnect = async () => {
    if (!result?.accountId || !api.reconnect) return
    try {
      await api.reconnect(result.accountId)
      await load()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The account could not be reconnected')
    }
  }

  const cellClass = (status: CellStatus, outside: boolean, proposedCell: boolean) =>
    `scheduling-cell status-${status}${outside ? ' outside-hours' : ''}${proposedCell ? ' proposed' : ''}`

  const rowHours = (email: string, isOrganizer: boolean) => isOrganizer ? workingHours : availabilityFor(email)?.workingHours

  return (
    <Modal title="Scheduling assistant" subtitle={`Times shown in ${timeZone} (${zoneLabel(day, timeZone)})`} width="large" onClose={onClose}>
      <div className="scheduling-assistant">
        <div className="scheduling-toolbar">
          <button className="icon-button" aria-label="Previous day" title="Previous day" onClick={() => setDay((current) => addZonedDays(current, -1, timeZone))}><ChevronLeft size={16} /></button>
          <strong className="scheduling-day">{formatZoneDay(day, timeZone)}</strong>
          <button className="icon-button" aria-label="Next day" title="Next day" onClick={() => setDay((current) => addZonedDays(current, 1, timeZone))}><ChevronRight size={16} /></button>
          <label className="field-label inline">Duration<select value={DURATIONS.includes(durationMinutes) ? durationMinutes : ''} onChange={(event) => setProposed((current) => ({ start: current.start, end: current.start + Number(event.target.value) * 60_000 }))}>
            {!DURATIONS.includes(durationMinutes) && <option value="">{durationMinutes} min</option>}
            {DURATIONS.map((minutes) => <option key={minutes} value={minutes}>{minutes < 60 ? `${minutes} min` : `${minutes / 60} h`}</option>)}
          </select></label>
          <label className="field-label inline">Second time zone<select value={secondaryZone} onChange={(event) => { setSecondaryZone(event.target.value); saveSecondaryZone(event.target.value) }}>
            <option value="">None</option>
            {timeZoneOptions(secondaryZone || undefined).filter((zone) => zone !== timeZone).map((zone) => <option key={zone} value={zone}>{zone}</option>)}
          </select></label>
          <span className="spacer" />
          <button className="button ghost small" disabled={loading} onClick={() => void load()}><RefreshCw size={14} className={loading ? 'spin' : undefined} /> {loading ? 'Checking…' : 'Refresh'}</button>
        </div>

        {result?.needsReconnect && (
          <div className="scheduling-notice" role="alert">
            <AlertTriangle size={15} />
            <p>{result.message}</p>
            {api.reconnect && result.accountId && <button className="button small" onClick={() => void reconnect()}>Reconnect account</button>}
          </div>
        )}
        {!result?.needsReconnect && result?.message && <div className="scheduling-notice" role="status"><AlertTriangle size={15} /><p>{result.message}</p></div>}
        {error && <div className="scheduling-notice" role="alert"><AlertTriangle size={15} /><p>{error}</p></div>}

        <div className="scheduling-timeline-wrap">
          <table className="scheduling-timeline" aria-label="Attendee availability">
            <thead>
              <tr>
                <th scope="col" className="scheduling-person">{zoneLabel(day, timeZone)}</th>
                {cells.map((cell, index) => <th key={cell} scope="col" className="scheduling-hour">{index % 2 === 0 ? formatZoneTime(cell, timeZone) : ''}</th>)}
              </tr>
              {secondaryZone && (
                <tr className="scheduling-secondary">
                  <th scope="row" className="scheduling-person">{zoneLabel(day, secondaryZone)}</th>
                  {cells.map((cell, index) => <th key={cell} className="scheduling-hour">{index % 2 === 0 ? formatZoneTime(cell, secondaryZone) : ''}</th>)}
                </tr>
              )}
            </thead>
            <tbody>
              {rows.map((row) => {
                const availability = availabilityFor(row.email)
                const hours = rowHours(row.email, row.organizer)
                return (
                  <tr key={row.email} data-testid={`availability-${attendeeAddress(row.email)}`}>
                    <th scope="row" className="scheduling-person">
                      <span className="scheduling-name" title={row.email}>{row.organizer ? `${row.email} (you)` : row.email}</span>
                      {!row.organizer && <select aria-label={`Role for ${row.email}`} value={row.role} onChange={(event) => setParticipants((current) => current.map((item) => item.email === row.email ? { ...item, role: event.target.value as ParticipantRole } : item))}>
                        {(Object.keys(ROLE_LABELS) as ParticipantRole[]).map((role) => <option key={role} value={role}>{ROLE_LABELS[role]}</option>)}
                      </select>}
                      {!row.organizer && <button className="icon-button" aria-label={`Remove ${row.email}`} title="Remove" onClick={() => setParticipants((current) => current.filter((item) => item.email !== row.email))}><X size={13} /></button>}
                      {result && availability && !availability.known && <small className="scheduling-unknown-reason">{availability.message ?? 'Availability unknown'}</small>}
                    </th>
                    {cells.map((cell) => {
                      const cellEnd = cell + STEP_MINUTES * 60_000
                      const status = result ? statusDuring(availability, cell, cellEnd) : 'unknown'
                      const outside = !withinWorkingHours(cell, cellEnd, hours)
                      const proposedCell = cell < proposed.end && cellEnd > proposed.start
                      return <td key={cell} className={cellClass(status, outside, proposedCell)} title={`${formatZoneTime(cell, timeZone)} · ${STATUS_LABELS[status]}${outside ? ' · outside working hours' : ''}`} onClick={() => moveTo(cell)} />
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <ul className="scheduling-legend" aria-label="Legend">
          {(['busy', 'tentative', 'oof', 'workingElsewhere', 'unknown'] as CellStatus[]).map((status) => <li key={status}><span className={`scheduling-cell status-${status}`} />{STATUS_LABELS[status]}</li>)}
          <li><span className="scheduling-cell outside-hours" />Outside working hours</li>
          <li><span className="scheduling-cell proposed" />Proposed time</li>
        </ul>

        <div className="scheduling-add">
          <label className="field-label grow"><UserPlus size={14} /> Add attendee or resource<input value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addParticipant() } }} placeholder="name@example.com or room@example.com" /></label>
          <label className="field-label inline">As<select value={draftRole} onChange={(event) => setDraftRole(event.target.value as ParticipantRole)}>
            {(Object.keys(ROLE_LABELS) as ParticipantRole[]).map((role) => <option key={role} value={role}>{ROLE_LABELS[role]}</option>)}
          </select></label>
          <button className="button small" disabled={!draft.trim()} onClick={addParticipant}>Add</button>
        </div>

        <section className="scheduling-suggestions" aria-label="Suggested times">
          <h3><Sparkles size={14} /> Suggested times</h3>
          {unknownRequired.length > 0 && <p className="scheduling-caveat">Not checked for {unknownRequired.map((row) => row.email).join(', ')} — their availability is unknown.</p>}
          {result && !suggestions.length && <p className="scheduling-caveat">No time in the next {LOOKAHEAD_DAYS} days fits everyone’s working hours. Try a shorter meeting or another day.</p>}
          <div className="scheduling-suggestion-list">
            {suggestions.map((slot) => (
              <button key={slot.start} className={`scheduling-suggestion${slot.start === proposed.start ? ' active' : ''}`} onClick={() => moveTo(slot.start)}>
                <strong>{formatZoneDay(slot.start, timeZone)}, {formatZoneTime(slot.start, timeZone)}–{formatZoneTime(slot.end, timeZone)}</strong>
                {secondaryZone && <small>{formatZoneTime(slot.start, secondaryZone)}–{formatZoneTime(slot.end, secondaryZone)} {zoneLabel(slot.start, secondaryZone)}</small>}
                <small>{slot.optionalConflicts.length ? `${slot.optionalConflicts.length} optional unavailable` : 'All attendees free'}</small>
              </button>
            ))}
          </div>
        </section>

        <details className="scheduling-hours">
          <summary>My working hours: {workingHours.days.map((value) => WEEKDAY_LABELS[value]).join(', ') || 'none'} · {workingHours.start}–{workingHours.end}</summary>
          <div className="scheduling-hours-fields">
            <label className="field-label inline">From<input type="time" value={workingHours.start} onChange={(event) => event.target.value && updateHours({ ...workingHours, start: event.target.value })} /></label>
            <label className="field-label inline">To<input type="time" value={workingHours.end} onChange={(event) => event.target.value && updateHours({ ...workingHours, end: event.target.value })} /></label>
            {WEEKDAY_LABELS.map((label, value) => (
              <label key={label} className="checkbox-row"><input type="checkbox" checked={workingHours.days.includes(value)} onChange={(event) => updateHours({
                ...workingHours,
                days: event.target.checked ? [...workingHours.days, value].sort() : workingHours.days.filter((item) => item !== value)
              })} />{label}</label>
            ))}
          </div>
          <p className="scheduling-caveat">Microsoft attendees’ own working hours come from Outlook; Google doesn’t share them, so only yours apply.</p>
        </details>

        <footer className="modal-footer">
          <span className="scheduling-proposed">Proposed: {formatZoneDay(proposed.start, timeZone)}, {formatZoneTime(proposed.start, timeZone)}–{formatZoneTime(proposed.end, timeZone)}</span>
          <span className="spacer" />
          <button className="button ghost" onClick={onClose}>Cancel</button>
          <button className="button primary" onClick={() => onApply({
            start: msToWallInput(proposed.start, editorZone),
            end: msToWallInput(proposed.end, editorZone),
            attendees: participants.map((item) => item.email)
          })}><CalendarClock size={16} /> Use this time</button>
        </footer>
      </div>
    </Modal>
  )
}

/** Compact entry point for the event editor: a button that opens the assistant. */
export function SchedulingAssistantButton(props: Omit<SchedulingAssistantProps, 'onClose'> & { disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const { disabled, onApply, ...rest } = props
  return (
    <>
      <button type="button" className="button ghost small scheduling-open" disabled={disabled} onClick={() => setOpen(true)}><CalendarClock size={14} /> Scheduling assistant</button>
      {open && <SchedulingAssistant {...rest} onClose={() => setOpen(false)} onApply={(selection) => { onApply(selection); setOpen(false) }} />}
    </>
  )
}
