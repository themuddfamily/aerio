import { BellRing, Eye, EyeOff, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { MailAccountSummary, MailMessageDetail, MailReplyWatch } from '../mail-types'
import Modal from './Modal'

export interface ReplyWatchSetting {
  enabled: boolean
  /** Optional local `datetime-local` value; empty means watch without a deadline. */
  deadline: string
}

const localInput = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
const errorText = (error: unknown, fallback: string) => error instanceof Error
  ? error.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '') || fallback
  : fallback

/** Converts the optional deadline, rejecting past times before anything is sent. */
export function replyWatchDeadline(setting?: ReplyWatchSetting) {
  if (!setting?.enabled || !setting.deadline) return { ok: true as const }
  const date = new Date(setting.deadline)
  if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) return { ok: false as const }
  return { ok: true as const, deadlineAt: date.toISOString() }
}

/** Arms a watch for an outgoing draft after it has been queued or scheduled. */
export async function armReplyWatch(accountId: string, draftId: string, setting: ReplyWatchSetting | undefined, onToast: (message: string) => void) {
  if (!setting?.enabled) return
  try {
    await window.aerio.mail.replyWatches.create({ accountId, draftId, deadlineAt: replyWatchDeadline(setting).deadlineAt })
  } catch (error) {
    onToast(`Message queued, but replies are not being watched: ${errorText(error, 'the watch could not be saved')}`)
  }
}

/** Compact composer control: toggle watching and optionally pick a reply deadline. */
export function ReplyWatchControl({ value, onChange }: { value: ReplyWatchSetting; onChange(value: ReplyWatchSetting): void }) {
  return <span className="reply-watch-control">
    <button type="button" className={`icon-button ${value.enabled ? 'active' : ''}`} aria-pressed={value.enabled} title={value.enabled ? 'Stop watching for replies' : 'Watch for replies'} onClick={() => onChange({ ...value, enabled: !value.enabled })}>{value.enabled ? <Eye size={17} /> : <EyeOff size={17} />}</button>
    {value.enabled && <label className="mail-schedule-field" title="Notify me if there is no reply by"><BellRing size={15} /><input aria-label="Reply deadline" type="datetime-local" min={localInput(new Date(Date.now() + 60_000))} value={value.deadline} onChange={(event) => onChange({ ...value, deadline: event.target.value })} />{value.deadline && <button type="button" aria-label="Clear reply deadline" onClick={() => onChange({ ...value, deadline: '' })}><X size={13} /></button>}</label>}
  </span>
}

export const canWatchMessage = (message: MailMessageDetail, accounts: MailAccountSummary[]) => {
  const account = accounts.find((item) => item.id === message.accountId)
  if (!account || account.archived || !message.messageIdHeader) return false
  return message.labelIds.includes('SENT') || message.fromEmail.trim().toLowerCase() === account.email.trim().toLowerCase()
}

const statusText = (watch: MailReplyWatch) => {
  if (watch.status === 'pending') return 'Waiting for the message to send'
  if (watch.status === 'watching') return watch.deadlineAt ? `Watching until ${new Date(watch.deadlineAt).toLocaleString()}` : 'Watching with no deadline'
  if (watch.status === 'replied') return `Replied${watch.replyFrom ? ` by ${watch.replyFrom}` : ''}${watch.resolvedAt ? ` · ${new Date(watch.resolvedAt).toLocaleString()}` : ''}`
  if (watch.status === 'expired') return `No reply by ${watch.deadlineAt ? new Date(watch.deadlineAt).toLocaleString() : 'the deadline'}`
  return 'Cancelled'
}

/** Lists watches and cancels active ones; with `message` it first offers to watch that sent message. */
export function MailReplyWatchesModal({ accounts, message, onToast, onClose }: {
  accounts: MailAccountSummary[]; message?: MailMessageDetail; onToast(message: string): void; onClose(): void
}) {
  const [watches, setWatches] = useState<MailReplyWatch[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [deadline, setDeadline] = useState('')

  const load = async () => {
    try { setWatches(await window.aerio.mail.replyWatches.list()) } catch (error) { onToast(errorText(error, 'Reply watches could not be loaded')) } finally { setLoading(false) }
  }
  useEffect(() => {
    void load()
    return window.aerio.mail.onEvent((event) => { if (event.type === 'reply-watch') void load() })
  }, [])

  const watchMessage = async () => {
    if (!message) return
    const checked = replyWatchDeadline({ enabled: true, deadline })
    if (!checked.ok) {
      onToast('Choose a reply deadline in the future')
      return
    }
    setBusy(true)
    try {
      const watch = await window.aerio.mail.replyWatches.create({ accountId: message.accountId, messageId: message.id, deadlineAt: checked.deadlineAt })
      onToast(watch.status === 'replied' ? 'This message already has a reply' : 'Watching for replies')
      onClose()
    } catch (error) {
      onToast(errorText(error, 'Replies could not be watched'))
    } finally {
      setBusy(false)
    }
  }

  const cancel = async (watch: MailReplyWatch) => {
    try {
      await window.aerio.mail.replyWatches.cancel(watch.id)
      onToast('Stopped watching for replies')
      await load()
    } catch (error) {
      onToast(errorText(error, 'The watch could not be cancelled'))
    }
  }

  return <Modal title={message ? 'Watch for replies' : 'Reply watches'} subtitle={message ? message.subject : 'Get notified when sent messages are answered'} width={message ? 'small' : 'large'} closeEnabled={!busy} onClose={onClose}>
    {message ? <div className="form-stack message-tool-form">
      <p>Aerio notifies you when a recipient replies to this message on this computer.</p>
      <label className="field-label">Notify me if there is no reply by (optional)<input type="datetime-local" min={localInput(new Date(Date.now() + 60_000))} value={deadline} onChange={(event) => setDeadline(event.target.value)} /></label>
    </div> : <div className="mail-rules-list">
      {loading && <p className="rules-empty">Loading reply watches…</p>}
      {!loading && !watches.length && <div className="rules-empty"><Eye size={26} /><strong>No reply watches</strong><span>Turn on “Watch for replies” when composing, or from a sent message’s menu.</span></div>}
      {watches.map((watch) => <article key={watch.id} className={watch.status === 'pending' || watch.status === 'watching' ? '' : 'disabled'}>
        <span className="rule-copy"><strong>{watch.subject || '(No subject)'}</strong><small>{accounts.find((account) => account.id === watch.accountId)?.email ?? 'Missing account'} · {watch.recipients.join(', ') || 'No recipients'}</small><small>{statusText(watch)}</small></span>
        {(watch.status === 'pending' || watch.status === 'watching') && <button className="icon-button danger" title="Stop watching" aria-label={`Stop watching ${watch.subject || 'message'}`} onClick={() => void cancel(watch)}><X size={15} /></button>}
      </article>)}
    </div>}
    <footer className="modal-footer"><button className="button ghost" disabled={busy} onClick={onClose}>{message ? 'Cancel' : 'Close'}</button><span className="spacer" />
      {message && <button className="button primary" disabled={busy} onClick={() => void watchMessage()}><Eye size={15} /> Watch for replies</button>}
    </footer>
  </Modal>
}
