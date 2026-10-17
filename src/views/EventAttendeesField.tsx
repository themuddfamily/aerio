import { DoorOpen, Users } from 'lucide-react'
import { useState } from 'react'
import type { CalendarEvent, EventAttendee } from '../types'
import type { InvitationResponse } from '../invitation-types'
import { attendeeKey, eventAttendees, isResourceAttendee, responseLabel, roleLabel } from '../lib/event-attendees'

// The editor's attendee inputs: required guests, optional guests, and rooms or resources, each a comma list.
export interface AttendeeFieldValues {
  required: string
  optional: string
  resources: string
}

const join = (attendees: EventAttendee[]) => attendees.map((attendee) => attendee.email).join(', ')
const split = (value: string) => value.split(/[,;]/).map((item) => item.trim()).filter(Boolean)

export function attendeeFieldValues(event?: CalendarEvent): AttendeeFieldValues {
  const attendees = event ? eventAttendees(event) : []
  return {
    required: join(attendees.filter((attendee) => !isResourceAttendee(attendee) && attendee.role !== 'optional' && attendee.role !== 'non-participant')),
    optional: join(attendees.filter((attendee) => !isResourceAttendee(attendee) && (attendee.role === 'optional' || attendee.role === 'non-participant'))),
    resources: join(attendees.filter(isResourceAttendee))
  }
}

// Rebuilds structured attendees from the fields, keeping what the editor does not show (names, responses,
// chair and non-participant roles, room versus resource) for addresses that stay in the same field.
export function attendeesFromFields(values: AttendeeFieldValues, original?: CalendarEvent): EventAttendee[] {
  const previous = new Map((original ? eventAttendees(original) : []).map((attendee) => [attendeeKey(attendee.email), attendee]))
  const build = (email: string, group: keyof AttendeeFieldValues): EventAttendee => {
    const known = previous.get(attendeeKey(email))
    if (group === 'resources') return { ...known, email, kind: known && isResourceAttendee(known) ? known.kind : 'resource', role: known?.role ?? 'non-participant' }
    const kind = known && !isResourceAttendee(known) ? known.kind : undefined
    const role = group === 'optional'
      ? (known?.role === 'non-participant' ? 'non-participant' : 'optional')
      : (known?.role === 'chair' ? 'chair' : 'required')
    return { ...known, email, role, ...(kind ? { kind } : { kind: undefined }) }
  }
  const strip = (attendee: EventAttendee): EventAttendee =>
    Object.fromEntries(Object.entries(attendee).filter(([, value]) => value !== undefined)) as unknown as EventAttendee
  return [
    ...split(values.required).map((email) => build(email, 'required')),
    ...split(values.optional).map((email) => build(email, 'optional')),
    ...split(values.resources).map((email) => build(email, 'resources'))
  ].map(strip)
}

interface EventAttendeesFieldProps {
  value: AttendeeFieldValues
  event?: CalendarEvent
  disabled: boolean
  onChange(value: AttendeeFieldValues): void
}

const RSVP: { response: InvitationResponse; label: string }[] = [{ response: 'accepted', label: 'Accept' }, { response: 'tentative', label: 'Tentative' }, { response: 'declined', label: 'Decline' }]

export default function EventAttendeesField({ value, event, disabled, onChange }: EventAttendeesFieldProps) {
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const known = event ? eventAttendees(event) : []
  const responses = known.filter((attendee) => attendee.response)
  const self = known.find((attendee) => attendee.self)
  const respondToEvent = window.aerio?.productivity?.respondToEvent
  // Synced meetings organized by someone else can be answered from here; the main process checks the guest list.
  const canRsvp = Boolean(event && 'remoteId' in event && event.organizer && !event.organizer.self && known.length && respondToEvent)
  const rsvp = async (response: InvitationResponse) => {
    if (!event || !respondToEvent) return
    setBusy(true)
    setStatus('')
    try {
      await respondToEvent(event.id, { response })
      setStatus(`Response sent: ${responseLabel[response]}.`)
    } catch (failure) {
      setStatus(failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '') : 'Your response could not be sent')
    } finally {
      setBusy(false)
    }
  }
  return <>
    <div className="form-grid-2">
      <label className="field-label"><Users size={14} /> Attendees<input value={value.required} disabled={disabled} onChange={(e) => onChange({ ...value, required: e.target.value })} placeholder="Separate email addresses with commas" /></label>
      <label className="field-label">Optional attendees<input value={value.optional} disabled={disabled} onChange={(e) => onChange({ ...value, optional: e.target.value })} placeholder="Optional" /></label>
    </div>
    <label className="field-label"><DoorOpen size={14} /> Rooms and resources<input value={value.resources} disabled={disabled} onChange={(e) => onChange({ ...value, resources: e.target.value })} placeholder="Room or equipment addresses" /></label>
    {(event?.organizer || responses.length > 0) && <ul className="event-attendee-responses" aria-label="Guest responses">
      {event?.organizer && <li><span>{event.organizer.name || event.organizer.email}{event.organizer.self ? ' (you)' : ''}</span><small>Organizer</small></li>}
      {responses.map((attendee) => <li key={attendee.email}>
        <span>{attendee.name || attendee.email}{attendee.self ? ' (you)' : ''}</span>
        <small>{isResourceAttendee(attendee) ? (attendee.kind === 'room' ? 'Room' : 'Resource') : roleLabel[attendee.role ?? 'required']} · {responseLabel[attendee.response!]}</small>
      </li>)}
    </ul>}
    {canRsvp && <div className="event-rsvp" role="group" aria-label="Your response">
      <span>{self?.response && self.response !== 'needs-action' ? `You: ${responseLabel[self.response]}` : 'Going?'}</span>
      {RSVP.map(({ response, label }) => <button type="button" key={response} className={`button ${self?.response === response ? 'primary' : 'ghost'}`} aria-pressed={self?.response === response} disabled={busy} onClick={() => void rsvp(response)}>{label}</button>)}
      {status && <small role="status">{status}</small>}
    </div>}
  </>
}
