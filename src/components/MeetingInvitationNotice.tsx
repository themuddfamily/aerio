import { CalendarDays } from 'lucide-react'
import { format, parseISO } from 'date-fns'
import { useEffect, useState } from 'react'
import type { InvitationResponse, MeetingInvitation } from '../invitation-types'
import { attendeeResponseCounts, isResourceAttendee, responseLabel, roleLabel } from '../lib/event-attendees'

interface MeetingInvitationNoticeProps {
  accountId: string
  messageId: string
}

const RESPONSE_BUTTONS: { response: InvitationResponse; label: string }[] = [
  { response: 'accepted', label: 'Accept' },
  { response: 'tentative', label: 'Tentative' },
  { response: 'declined', label: 'Decline' }
]
const CHANNEL_TEXT = { google: 'through Google Calendar', microsoft: 'through Microsoft Outlook', mail: 'by email to the organizer', none: '' } as const

const cleanError = (failure: unknown, fallback: string) =>
  failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '') : fallback

export function invitationWhen(invitation: Pick<MeetingInvitation, 'start' | 'end' | 'allDay'>) {
  if (invitation.allDay) {
    const start = parseISO(invitation.start)
    const last = new Date(parseISO(invitation.end).getTime() - 86_400_000)
    return last > start ? `${format(start, 'EEE d MMM yyyy')} – ${format(last, 'EEE d MMM yyyy')}` : `${format(start, 'EEE d MMM yyyy')}, all day`
  }
  const start = new Date(invitation.start)
  const end = new Date(invitation.end)
  return `${format(start, 'EEE d MMM yyyy, HH:mm')} – ${format(end, start.toDateString() === end.toDateString() ? 'HH:mm' : 'EEE d MMM, HH:mm')}`
}

export function invitationHeadline(invitation: MeetingInvitation) {
  const who = invitation.replyFrom?.name || invitation.replyFrom?.email || 'An attendee'
  if (invitation.method === 'REPLY') {
    const response = invitation.replyFrom?.response
    const verb = response === 'accepted' ? 'accepted' : response === 'tentative' ? 'tentatively accepted' : response === 'declined' ? 'declined' : response === 'delegated' ? 'delegated' : 'replied to'
    return `${who} ${verb} “${invitation.title}”`
  }
  if (invitation.method === 'COUNTER') return `${who} proposed a new time for “${invitation.title}”`
  if (invitation.method === 'CANCEL') return `Cancelled: ${invitation.title}`
  if (invitation.status === 'update') return `Updated invitation: ${invitation.title}`
  return `Invitation: ${invitation.title}`
}

const localInput = (value: string) => format(new Date(value), "yyyy-MM-dd'T'HH:mm")

// Shows a text/calendar part of a message and the actions it supports: RSVP (with an optional comment and
// proposed time), removing a cancelled meeting from the local Invitations calendar, and explanations for
// duplicate and out-of-date messages.
export default function MeetingInvitationNotice({ accountId, messageId }: MeetingInvitationNoticeProps) {
  const [invitation, setInvitation] = useState<MeetingInvitation>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [details, setDetails] = useState(false)
  const [composing, setComposing] = useState(false)
  const [comment, setComment] = useState('')
  const [proposing, setProposing] = useState(false)
  const [proposedStart, setProposedStart] = useState('')
  const [proposedEnd, setProposedEnd] = useState('')

  useEffect(() => {
    let active = true
    setInvitation(undefined)
    setError('')
    void window.aerio?.productivity?.invitations?.inspect(accountId, messageId).then((value) => {
      if (active) setInvitation(value)
    }).catch(() => undefined)
    return () => { active = false }
  }, [accountId, messageId])

  if (!invitation) return null
  const api = window.aerio.productivity.invitations!

  const run = async (work: () => Promise<MeetingInvitation>, fallback: string) => {
    setBusy(true)
    setError('')
    try {
      setInvitation(await work())
      setComposing(false)
      setProposing(false)
    } catch (failure) {
      setError(cleanError(failure, fallback))
    } finally {
      setBusy(false)
    }
  }
  const respond = (response: InvitationResponse) => {
    const proposed = proposing && proposedStart && proposedEnd
      ? { start: new Date(proposedStart).toISOString(), end: new Date(proposedEnd).toISOString() }
      : undefined
    if (proposing && (!proposed || Date.parse(proposed.end) <= Date.parse(proposed.start))) {
      setError('Choose a proposed end after the proposed start')
      return
    }
    void run(() => api.respond({ accountId, messageId, response, ...(comment.trim() ? { comment: comment.trim() } : {}), ...(proposed ? { proposed } : {}) }), 'Your response could not be sent')
  }
  const startProposal = () => {
    setComposing(true)
    setProposing(true)
    if (!proposedStart && !invitation.allDay) {
      setProposedStart(localInput(invitation.start))
      setProposedEnd(localInput(invitation.end))
    }
  }

  const people = invitation.attendees.filter((attendee) => !isResourceAttendee(attendee))
  const resources = invitation.attendees.filter(isResourceAttendee)
  const counts = attendeeResponseCounts(people)
  const tally = [counts.accepted && `${counts.accepted} accepted`, counts.tentative && `${counts.tentative} tentative`, counts.declined && `${counts.declined} declined`].filter(Boolean).join(', ')
  const proposalAllowed = invitation.canProposeTime && !invitation.allDay
  return (
    <div className="mail-receipt-notice meeting-invitation-notice" role="region" aria-label="Meeting invitation">
      <CalendarDays size={15} aria-hidden="true" />
      <div>
        <p><strong>{invitationHeadline(invitation)}</strong></p>
        <p><small>{invitationWhen(invitation.proposed ? { ...invitation.proposed, allDay: false } : invitation)}{invitation.recurrenceRule ? ' · repeats' : ''}{invitation.recurrenceId ? ' · one occurrence of a repeating meeting' : ''}{invitation.location ? ` · ${invitation.location}` : ''}</small></p>
        {invitation.method === 'COUNTER' && <p><small>To accept the proposal, change the meeting’s time in your calendar so the update reaches every guest.</small></p>}
        {invitation.comment && <p><small>“{invitation.comment}”</small></p>}
        {(invitation.organizer || people.length > 0) && <p>
          <small>
            {invitation.organizer && <>Organizer: {invitation.organizer.name || invitation.organizer.email}{invitation.organizerIsSelf ? ' (you)' : ''}</>}
            {invitation.organizer && people.length > 0 && ' · '}
            {people.length > 0 && <>{people.length} guest{people.length === 1 ? '' : 's'}{tally ? ` (${tally})` : ''}</>}
            {resources.length > 0 && ` · ${resources.length} room${resources.length === 1 ? '' : 's'} or resource${resources.length === 1 ? '' : 's'}`}
          </small>
          {invitation.attendees.length > 0 && <span className="mail-receipt-actions"><button type="button" aria-expanded={details} onClick={() => setDetails(!details)}>{details ? 'Hide guests' : 'Show guests'}</button></span>}
        </p>}
        {details && <ul className="meeting-attendee-list">
          {invitation.attendees.map((attendee) => <li key={attendee.email}>
            <span>{attendee.name ? `${attendee.name} <${attendee.email}>` : attendee.email}{attendee.email === invitation.self?.email ? ' (you)' : ''}</span>
            <small>{[isResourceAttendee(attendee) ? (attendee.kind === 'room' ? 'Room' : 'Resource') : roleLabel[attendee.role ?? 'required'], responseLabel[attendee.response ?? 'needs-action']].join(' · ')}</small>
          </li>)}
        </ul>}
        {invitation.explanation && <p><small>{invitation.explanation}</small></p>}
        {invitation.warnings.map((warning) => <p key={warning}><small>{warning}</small></p>)}
        {invitation.response && <p><small>You responded: {responseLabel[invitation.response]}{invitation.respondedAt ? ` (${format(new Date(invitation.respondedAt), 'd MMM, HH:mm')})` : ''}.</small></p>}
        {invitation.method === 'REQUEST' && !invitation.canRespond && invitation.respondBlockedReason && invitation.status !== 'stale' && <p><small>{invitation.respondBlockedReason}</small></p>}
        {invitation.canRespond && <>
          <p className="meeting-invitation-actions" role="group" aria-label="Respond to invitation">
            {RESPONSE_BUTTONS.map(({ response, label }) => <button type="button" className={`button ${invitation.response === response ? 'primary' : 'ghost'}`} key={response} disabled={busy || (proposing && response === 'accepted' && invitation.channel === 'microsoft')} aria-pressed={invitation.response === response} onClick={() => respond(response)}>{label}</button>)}
            {!composing && <span className="mail-receipt-actions"><button type="button" disabled={busy} onClick={() => setComposing(true)}>Add a comment</button>{proposalAllowed && <button type="button" disabled={busy} onClick={startProposal}>Propose new time</button>}</span>}
          </p>
          {composing && <div className="meeting-invitation-compose">
            <label className="field-label">Comment to the organizer<input value={comment} maxLength={2000} onChange={(event) => setComment(event.target.value)} placeholder="Optional" /></label>
            {proposing && <div className="form-grid-2">
              <label className="field-label">Proposed start<input type="datetime-local" value={proposedStart} onChange={(event) => setProposedStart(event.target.value)} /></label>
              <label className="field-label">Proposed end<input type="datetime-local" value={proposedEnd} onChange={(event) => setProposedEnd(event.target.value)} /></label>
            </div>}
            {proposing && invitation.proposeTimeNote && <p><small>{invitation.proposeTimeNote}</small></p>}
            <span className="mail-receipt-actions">
              {proposalAllowed && !proposing && <button type="button" disabled={busy} onClick={startProposal}>Propose new time</button>}
              <button type="button" disabled={busy} onClick={() => { setComposing(false); setProposing(false) }}>Cancel</button>
            </span>
          </div>}
          {!proposalAllowed && invitation.proposeTimeNote && <p><small>{invitation.proposeTimeNote}</small></p>}
          <p><small>Your response is sent {CHANNEL_TEXT[invitation.channel]}.</small></p>
        </>}
        {invitation.status === 'cancelled' && invitation.localCopyId && <p>
          <small>This meeting is still in your Invitations calendar.</small>
          <span className="mail-receipt-actions"><button type="button" disabled={busy} onClick={() => void run(() => api.applyCancellation(accountId, messageId), 'The meeting could not be removed')}>Remove from calendar</button></span>
        </p>}
        {invitation.status === 'cancelled' && !invitation.localCopyId && invitation.calendarEventId && <p><small>Your provider calendar applies the cancellation when it next synchronizes.</small></p>}
        {error && <p><small className="diagnostic-error">{error}</small></p>}
      </div>
    </div>
  )
}
