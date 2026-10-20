import { useEffect, useState } from 'react'
import { ExternalLink, Undo2, Video, X } from 'lucide-react'
import type { EventConference } from '../types'
import type { HostedMeetingOptions } from '../meeting-host-types'
import { checkJoinLink, conferenceLabel, isHostedConferenceProvider, requestConference, type ConferenceCapability } from '../lib/online-meetings'

// Opens a join link through the main window's external-link handler (window.open is denied in-app and passed
// to the system browser for https). Links outside the meeting-host allowlist ask first.
export function openJoinLink(url: string) {
  window.open(url, '_blank', 'noopener')
}

// Zoom and Webex meetings Aerio created (E47) are cancelled when their event is deleted in Aerio, unless this
// is turned off. The choice is stored with the meeting, so it applies to every way of deleting the event.
function HostedMeetingDeleteOption({ requestId, label }: { requestId: string; label: string }) {
  const api = window.aerio?.meetingHosts
  const [options, setOptions] = useState<HostedMeetingOptions | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!api) return
    let active = true
    void api.meetingOptions(requestId).then((next) => { if (active) setOptions(next) }).catch(() => undefined)
    return () => { active = false }
  }, [api, requestId])
  if (!api || !options) return null
  if (options.provider === 'meetn') return <p className="recurrence-note">Deleting this event removes its invitation; your shared Meetn room remains available.</p>
  const change = async (cancelOnDelete: boolean) => {
    setError('')
    try { setOptions(await api.setCancelOnDelete(requestId, cancelOnDelete)) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'The choice could not be saved') }
  }
  return (
    <>
      <label className="event-conference-keep">
        <input type="checkbox" checked={options.cancelOnDelete} onChange={(event) => void change(event.target.checked)} />
        Cancel the {label} meeting if this event is deleted
      </label>
      {error && <p className="recurrence-note">{error}</p>}
    </>
  )
}

/**
 * Online meeting row for the event editor (E25): shows and joins an existing meeting, or requests a new
 * provider meeting that is created when the event is saved. `value` undefined means "no change".
 */
export function EventConferenceField({ value, original, capabilities, canRemove, disabled = false, onChange }: {
  value?: EventConference
  // The event's conference as stored, restored by Undo after Remove.
  original?: EventConference
  capabilities: ConferenceCapability[]
  canRemove: boolean
  disabled?: boolean
  onChange(conference: EventConference | undefined): void
}) {
  const [confirmHost, setConfirmHost] = useState<{ url: string; host: string }>()

  const join = (joinUrl?: string) => {
    const link = checkJoinLink(joinUrl)
    if (link.kind === 'trusted') openJoinLink(link.url)
    else if (link.kind === 'untrusted') setConfirmHost({ url: link.url, host: link.host })
  }

  if (value?.status === 'removed') {
    return (
      <div className="event-conference" aria-label="Online meeting">
        <Video size={14} /> <span>{conferenceLabel(value)} will be removed when you save.</span>
        <button type="button" className="text-button" disabled={disabled} onClick={() => onChange(original)}><Undo2 size={13} /> Undo</button>
      </div>
    )
  }

  if (value) {
    const link = checkJoinLink(value.joinUrl)
    const requested = value.status === 'pending' && !value.joinUrl && Boolean(value.requestId) && !original?.joinUrl
    const native = capabilities.find((item) => item.provider === value.provider)
    return (
      <div className="event-conference" aria-label="Online meeting">
        <div className="event-conference-row">
          <Video size={14} />
          <strong>{conferenceLabel(value)}</strong>
          {value.joinUrl && link.kind !== 'invalid' && <span className="event-conference-host">{new URL(link.url).host}</span>}
          <span className="spacer" />
          {value.joinUrl && <button type="button" className="button small" disabled={link.kind === 'invalid'} title={link.kind === 'invalid' ? 'This meeting link is not a secure https link' : undefined} onClick={() => join(value.joinUrl)}><ExternalLink size={13} /> Join</button>}
          {requested && !disabled && <button type="button" className="text-button" onClick={() => onChange(undefined)}><X size={13} /> Don’t add</button>}
          {!requested && canRemove && !disabled && <button type="button" className="text-button" onClick={() => onChange({ ...value, status: 'removed' })}><X size={13} /> Remove</button>}
        </div>
        {requested && <p className="recurrence-note">A {conferenceLabel(value)} link is created when you save.</p>}
        {value.status === 'pending' && !requested && !value.joinUrl && <p className="recurrence-note">The provider is still creating this meeting; synchronize to see the link.</p>}
        {value.status === 'failed' && (
          <p className="recurrence-note">
            The provider could not create this meeting.{' '}
            {native?.available && !disabled && <button type="button" className="text-button" onClick={() => onChange(requestConference(value.provider))}>Try again</button>}
          </p>
        )}
        {value.phone && <p className="recurrence-note">Dial-in {value.phone}{value.pin ? ` · PIN ${value.pin}` : ''}</p>}
        {isHostedConferenceProvider(value.provider) && value.joinUrl && value.requestId && !disabled && <HostedMeetingDeleteOption requestId={value.requestId} label={conferenceLabel(value)} />}
        {confirmHost && (
          <div className="event-conference-confirm" role="alertdialog" aria-label="Open meeting link">
            <span>This link opens {confirmHost.host}, which is not a known meeting service.</span>
            <button type="button" className="button small" onClick={() => { openJoinLink(confirmHost.url); setConfirmHost(undefined) }}>Open anyway</button>
            <button type="button" className="text-button" onClick={() => setConfirmHost(undefined)}>Cancel</button>
          </div>
        )}
      </div>
    )
  }

  if (disabled) return null
  const available = capabilities.filter((item) => item.available)
  const primaryReason = capabilities[0] && !capabilities[0].available ? capabilities[0].reason : undefined
  return (
    <div className="event-conference" aria-label="Online meeting">
      <div className="event-conference-row">
        <Video size={14} />
        {available.length
          ? available.map((item) => <button type="button" key={item.provider} className="button small ghost" onClick={() => onChange(requestConference(item.provider, original))}>Add {item.label}</button>)
          : <span className="recurrence-note">{primaryReason ?? 'Online meetings are not available for this calendar'}</span>}
      </div>
    </div>
  )
}
