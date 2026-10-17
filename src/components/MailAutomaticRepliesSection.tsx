import { CalendarClock, PowerOff, RefreshCw, Save } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { MailAccountSummary, MailAutomaticRepliesState, MailAutomaticReplySettings } from '../mail-types'
import { audienceLabel, automaticReplyStatusText, isoToLocalInput, localInputToIso, localTimeZoneName, nextWholeHour, providerLabel } from '../lib/automatic-replies'

interface MailAutomaticRepliesSectionProps {
  account: MailAccountSummary
  onToast(message: string): void
}

const emptySettings: MailAutomaticReplySettings = { enabled: false, subject: '', internalMessage: '', externalMessage: '', externalAudience: 'all' }

export default function MailAutomaticRepliesSection({ account, onToast }: MailAutomaticRepliesSectionProps) {
  const [state, setState] = useState<MailAutomaticRepliesState>()
  const [draft, setDraft] = useState<MailAutomaticReplySettings>(emptySettings)
  const [scheduled, setScheduled] = useState(false)
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [loadError, setLoadError] = useState<string>()
  const [busy, setBusy] = useState<'load' | 'save' | 'disable' | 'reconnect' | undefined>('load')

  const apply = useCallback((next: MailAutomaticRepliesState) => {
    setState(next)
    const settings = next.settings ?? emptySettings
    setDraft(settings)
    setScheduled(Boolean(settings.startAt || settings.endAt))
    setStart(isoToLocalInput(settings.startAt))
    setEnd(isoToLocalInput(settings.endAt))
  }, [])

  const load = useCallback(async () => {
    setBusy('load')
    setLoadError(undefined)
    try {
      apply(await window.aerio.mail.automaticReplies.get(account.id))
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Automatic replies could not be loaded')
    } finally {
      setBusy(undefined)
    }
  }, [account.id, apply])

  useEffect(() => { void load() }, [load])

  const update = <K extends keyof MailAutomaticReplySettings>(key: K, value: MailAutomaticReplySettings[K]) => setDraft((current) => ({ ...current, [key]: value }))

  const toggleSchedule = (value: boolean) => {
    setScheduled(value)
    if (value && !start && !end) {
      const from = nextWholeHour()
      setStart(isoToLocalInput(from.toISOString()))
      setEnd(isoToLocalInput(new Date(from.getTime() + 24 * 60 * 60_000).toISOString()))
    }
  }

  const report = (next: MailAutomaticRepliesState, success: string) => {
    apply(next)
    onToast(next.needsReconnect && next.message ? next.message : success)
  }

  const save = async () => {
    const settings: MailAutomaticReplySettings = { ...draft }
    delete settings.startAt
    delete settings.endAt
    if (scheduled) {
      const startAt = start ? localInputToIso(start) : undefined
      const endAt = end ? localInputToIso(end) : undefined
      if ((start && !startAt) || (end && !endAt)) { onToast('Enter a valid start and end time'); return }
      if (startAt) settings.startAt = startAt
      if (endAt) settings.endAt = endAt
    }
    setBusy('save')
    try {
      report(await window.aerio.mail.automaticReplies.update(account.id, settings), `Automatic replies saved to ${providerLabel(account.provider)}`)
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Automatic replies could not be saved')
    } finally {
      setBusy(undefined)
    }
  }

  const disable = async () => {
    setBusy('disable')
    try {
      report(await window.aerio.mail.automaticReplies.disable(account.id), 'Automatic replies turned off')
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Automatic replies could not be turned off')
    } finally {
      setBusy(undefined)
    }
  }

  const reconnect = async () => {
    setBusy('reconnect')
    try {
      await window.aerio.mail.accounts.reconnect(account.id)
      onToast('Account reconnected')
      await load()
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Account could not be reconnected')
    } finally {
      setBusy(undefined)
    }
  }

  const working = Boolean(busy)
  const capabilities = state?.capabilities
  const microsoft = account.provider === 'microsoft'
  const editable = Boolean(state?.canRead && state.canWrite && capabilities)

  return <section aria-labelledby="automatic-replies-heading">
    <h3 id="automatic-replies-heading">Automatic replies</h3>
    {busy === 'load' && !state && <p>Reading automatic replies from the server…</p>}
    {loadError && <p className="account-error">{loadError}</p>}
    {state && !state.supported && <p>{state.message}</p>}
    {state?.supported && <>
      <p>Replies are sent by {providerLabel(account.provider)}, not Aerio. They start, stop at the end time, and can be turned off here whether or not Aerio stays open.</p>
      {state.settings && <p>Server status: <strong>{automaticReplyStatusText(state)}</strong>{state.readAt ? ` · read ${new Date(state.readAt).toLocaleTimeString()}` : ''}</p>}
      {state.needsReconnect && state.message && <div className="automatic-replies-permission">
        <p className="account-error">{state.message}</p>
        <div><button className="button ghost" disabled={working} onClick={() => void reconnect()}><RefreshCw size={15} /> {busy === 'reconnect' ? 'Waiting for sign-in…' : 'Reconnect to grant permission'}</button></div>
      </div>}
      {state.warnings.map((warning) => <p key={warning} className="automatic-replies-warning">{warning}</p>)}
      {state.canRead && capabilities && <fieldset className="automatic-replies-form" disabled={!editable || working}>
        <label className="toggle-row"><span><strong>Send automatic replies</strong><small>{microsoft ? 'Outlook replies once to each sender.' : 'Gmail replies at most once every four days to each sender.'}</small></span><input type="checkbox" checked={draft.enabled} onChange={(event) => update('enabled', event.target.checked)} /></label>
        <label className="toggle-row"><span><strong>Only during a time range</strong><small>{microsoft ? 'Outlook needs both a start and an end.' : 'Leave the end blank to reply until you turn it off.'}</small></span><input type="checkbox" checked={scheduled} onChange={(event) => toggleSchedule(event.target.checked)} /></label>
        {scheduled && <div className="automatic-replies-dates">
          <label className="field"><span>Starts</span><input type="datetime-local" value={start} onChange={(event) => setStart(event.target.value)} /></label>
          <label className="field"><span>Ends</span><input type="datetime-local" value={end} onChange={(event) => setEnd(event.target.value)} /></label>
          <p><CalendarClock size={12} /> Times are in this computer’s time zone ({localTimeZoneName()}){state.serverTimeZone ? `; the mailbox uses ${state.serverTimeZone}` : ''}. Aerio converts them to exact UTC times for {providerLabel(account.provider)}.</p>
        </div>}
        {capabilities.subject && <label className="field"><span>Subject</span><input value={draft.subject} onChange={(event) => update('subject', event.target.value)} placeholder="Out of office" /></label>}
        <label className="field"><span>{microsoft ? 'Reply to people in my organization' : 'Reply message'}</span><textarea value={draft.internalMessage} onChange={(event) => update('internalMessage', event.target.value)} placeholder="I’m away and will reply when I return." /></label>
        <label className="field"><span>{microsoft ? 'Reply outside my organization' : 'Who receives replies'}</span><select value={draft.externalAudience} onChange={(event) => update('externalAudience', event.target.value as MailAutomaticReplySettings['externalAudience'])}>
          {capabilities.audiences.map((audience) => <option key={audience} value={audience}>{audienceLabel(account.provider, audience)}</option>)}
        </select></label>
        {capabilities.separateExternalMessage && draft.externalAudience !== 'none' && <label className="field"><span>Reply to people outside my organization</span><textarea value={draft.externalMessage} onChange={(event) => update('externalMessage', event.target.value)} /></label>}
      </fieldset>}
      <div className="settings-actions">
        {state.canRead && <button className="button ghost" disabled={working || !editable} onClick={() => void save()}><Save size={15} /> {busy === 'save' ? 'Saving…' : 'Save automatic replies'}</button>}
        {state.settings?.enabled && <button className="button ghost" disabled={working || !state.canWrite} onClick={() => void disable()}><PowerOff size={15} /> {busy === 'disable' ? 'Turning off…' : 'Turn off now'}</button>}
        <button className="button ghost" disabled={working} onClick={() => void load()}><RefreshCw size={15} /> {busy === 'load' ? 'Reading…' : 'Reload from server'}</button>
      </div>
    </>}
  </section>
}
