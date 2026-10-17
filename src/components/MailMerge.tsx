import { AlertTriangle, ChevronLeft, ChevronRight, Pause, Play, RotateCcw, Search, Send, SkipForward, Trash2, Upload, Users, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { MailAccountSummary } from '../mail-types'
import type { Contact } from '../types'
import type { MailMergeJob, MailMergeJobSummary, MailMergeMessageInput, MailMergeRecipient, MailMergeRecipientInput, MailMergeRecipientStatus, MailMergeResolution } from '../mail-merge-types'
import {
  clampMailMergeLimits,
  MAIL_MERGE_MAX_PER_MINUTE,
  MAIL_MERGE_MAX_RECIPIENTS,
  mailMergeDuration,
  mailMergeProviderLimits,
  mergePlaceholders,
  mergeRecipientAddress,
  mergeRecipientsFromContacts,
  mergeVariables,
  mergeKey,
  normalizeMergeRecipients,
  parseMergeRecipientList,
  renderMergeMessage
} from '../lib/mail-merge'
import Modal from './Modal'
import MessageHtml from './MessageHtml'

const friendlyError = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '') || fallback : fallback
const plural = (count: number, word: string) => `${count.toLocaleString()} ${word}${count === 1 ? '' : word.endsWith('s') ? 'es' : 's'}`

export const MAIL_MERGE_STATUS_LABELS: Record<MailMergeRecipientStatus, string> = {
  pending: 'Waiting', sending: 'Sending', sent: 'Sent', failed: 'Failed', ambiguous: 'Needs review', skipped: 'Skipped', cancelled: 'Cancelled'
}
const JOB_STATUS_LABELS: Record<MailMergeJobSummary['status'], string> = {
  running: 'Sending', paused: 'Paused', 'needs-review': 'Needs review', completed: 'Finished', cancelled: 'Cancelled'
}

interface MailMergeModalProps {
  accounts: MailAccountSummary[]
  /** The composed message; `{{variables}}` are filled per recipient. */
  message: MailMergeMessageInput
  /** Addresses already typed into To, offered as the starting list. */
  initialList?: string
  /** Cc/Bcc entries in the composer, which a merge never uses. */
  ignoredCopies?: number
  onClose(): void
  onToast(message: string): void
}

type Step = 'recipients' | 'preview' | 'confirm'

/** Recipients → preview → confirm → progress for one personalized mass mailing. */
export default function MailMergeModal({ accounts, message, initialList = '', ignoredCopies = 0, onClose, onToast }: MailMergeModalProps) {
  const account = accounts.find((item) => item.id === message.accountId)
  const [step, setStep] = useState<Step>('recipients')
  const [source, setSource] = useState<'list' | 'contacts'>(initialList.trim() ? 'list' : 'contacts')
  const [listText, setListText] = useState(initialList)
  const [contacts, setContacts] = useState<Contact[]>([])
  const [contactQuery, setContactQuery] = useState('')
  const [selectedContacts, setSelectedContacts] = useState<Set<string>>(new Set())
  const [index, setIndex] = useState(0)
  const provider = mailMergeProviderLimits(account?.provider, account?.email)
  const [limits, setLimits] = useState(() => clampMailMergeLimits(undefined, account?.provider, account?.email))
  const [busy, setBusy] = useState(false)
  const [jobId, setJobId] = useState<string>()

  useEffect(() => {
    let active = true
    void Promise.all([
      window.aerio.productivity.snapshot().catch(() => ({ contacts: [] as Contact[] })),
      window.aerio.productivity.localSnapshot().catch(() => ({ contacts: [] as Contact[] }))
    ]).then(([synced, local]) => {
      if (!active) return
      const all = [...(local.contacts ?? []), ...synced.contacts].filter((contact) => contact.email)
      setContacts(all.sort((a, b) => a.name.localeCompare(b.name)))
    })
    return () => { active = false }
  }, [])

  const parsed = useMemo(() => {
    if (source === 'contacts') return { ...normalizeMergeRecipients(mergeRecipientsFromContacts(contacts.filter((contact) => selectedContacts.has(contact.id)))), columns: [] as string[], error: undefined }
    try {
      return { ...parseMergeRecipientList(listText), error: undefined }
    } catch (error) {
      return { recipients: [] as MailMergeRecipientInput[], invalid: [], duplicates: 0, columns: [] as string[], error: friendlyError(error, 'The list could not be read') }
    }
  }, [contacts, listText, selectedContacts, source])
  const recipients = parsed.recipients
  const placeholders = useMemo(() => mergePlaceholders(message.subject, message.text, message.html), [message.html, message.subject, message.text])
  // Variables some recipients have no value for; without a fallback they render empty.
  const gaps = useMemo(() => placeholders.map((placeholder) => ({
    ...placeholder,
    missing: recipients.filter((recipient) => !mergeVariables(recipient).has(mergeKey(placeholder.name))).length
  })).filter((gap) => gap.missing > 0), [placeholders, recipients])
  const visibleContacts = useMemo(() => {
    const query = contactQuery.trim().toLowerCase()
    return query ? contacts.filter((contact) => `${contact.name} ${contact.email} ${contact.company ?? ''} ${contact.group}`.toLowerCase().includes(query)) : contacts
  }, [contactQuery, contacts])
  const current = recipients[Math.min(index, Math.max(0, recipients.length - 1))]
  const preview = current ? renderMergeMessage(message, current) : undefined
  const duration = mailMergeDuration(recipients.length, limits)
  const tooMany = recipients.length > MAIL_MERGE_MAX_RECIPIENTS

  const loadFile = async (file: File | undefined) => {
    if (!file) return
    if (file.size > 20 * 1024 * 1024) { onToast('Choose a CSV file smaller than 20 MB'); return }
    setSource('list')
    setListText(await file.text())
  }

  const start = async () => {
    if (!window.aerio.mail.merge) return
    setBusy(true)
    try {
      const job = await window.aerio.mail.merge.create({ ...message, recipients, limits })
      setJobId(job.id)
      onToast(`Mail merge started for ${plural(job.total, 'recipient')}`)
    } catch (error) {
      onToast(friendlyError(error, 'The mail merge could not start'))
    } finally {
      setBusy(false)
    }
  }

  if (jobId) return <Modal title="Mail merge" subtitle={message.subject || '(No subject)'} width="large" onClose={onClose}>
    <MailMergeProgress jobId={jobId} onToast={onToast} />
    <footer className="modal-footer"><span className="mail-merge-note">Sending continues in the background, and after Aerio restarts.</span><span className="spacer" /><button className="button primary" onClick={onClose}>Close</button></footer>
  </Modal>

  return <Modal title="Mail merge" subtitle={`${step === 'recipients' ? 'Step 1 of 3 · Recipients' : step === 'preview' ? 'Step 2 of 3 · Preview' : 'Step 3 of 3 · Confirm'}`} width="large" onClose={onClose}>
    {step === 'recipients' && <div className="mail-merge-body">
      <div className="mail-merge-tabs" role="tablist">
        <button role="tab" aria-selected={source === 'contacts'} className={source === 'contacts' ? 'active' : ''} onClick={() => setSource('contacts')}><Users size={14} /> Contacts</button>
        <button role="tab" aria-selected={source === 'list'} className={source === 'list' ? 'active' : ''} onClick={() => setSource('list')}><Upload size={14} /> Paste or CSV</button>
      </div>
      {source === 'contacts' ? <>
        <div className="mail-merge-search"><Search size={14} /><input aria-label="Search contacts" placeholder="Search contacts" value={contactQuery} onChange={(event) => setContactQuery(event.target.value)} />
          <button className="text-button" onClick={() => setSelectedContacts((selected) => new Set([...selected, ...visibleContacts.map((contact) => contact.id)]))}>Select shown</button>
          <button className="text-button" onClick={() => setSelectedContacts(new Set())}>Clear</button></div>
        <div className="mail-merge-contacts">
          {!contacts.length && <p className="rules-empty">No contacts with an email address.</p>}
          {visibleContacts.map((contact) => <label key={contact.id}><input type="checkbox" checked={selectedContacts.has(contact.id)} onChange={(event) => setSelectedContacts((selected) => {
            const next = new Set(selected)
            if (event.target.checked) next.add(contact.id)
            else next.delete(contact.id)
            return next
          })} /><span className="rule-copy"><strong>{contact.name || contact.email}</strong><small>{contact.email}{contact.company ? ` · ${contact.company}` : ''}</small></span></label>)}
        </div>
      </> : <>
        <label className="field-label">Addresses, or CSV with a header row (email, first name, last name, company, and any custom columns)
          <textarea aria-label="Recipient list" rows={8} value={listText} placeholder={'email,first name,company\nada@example.com,Ada,Analytical Engines'} onChange={(event) => setListText(event.target.value)} />
        </label>
        <label className="button ghost small mail-merge-file"><Upload size={14} /> Load CSV file<input type="file" accept=".csv,text/csv,text/plain" onChange={(event) => void loadFile(event.target.files?.[0])} /></label>
      </>}
      <p className="mail-merge-summary" aria-live="polite">
        <strong>{plural(recipients.length, 'recipient')}</strong>
        {parsed.invalid.length > 0 && <span> · {plural(parsed.invalid.length, 'invalid address')} left out</span>}
        {parsed.duplicates > 0 && <span> · {plural(parsed.duplicates, 'duplicate')} removed</span>}
        {parsed.columns.length > 0 && <span> · columns: {parsed.columns.map((column) => `{{${column}}}`).join(', ')}</span>}
      </p>
      {parsed.error && <p role="alert" className="mail-merge-warning"><AlertTriangle size={14} /> {parsed.error}</p>}
      {tooMany && <p role="alert" className="mail-merge-warning"><AlertTriangle size={14} /> A mail merge can have at most {MAIL_MERGE_MAX_RECIPIENTS.toLocaleString()} recipients.</p>}
      <p className="mail-merge-note">Variables: {'{{firstName}}'}, {'{{lastName}}'}, {'{{name}}'}, {'{{email}}'}, {'{{company}}'}, and CSV columns. Add a fallback with {'{{firstName|there}}'}.{placeholders.length ? ` This message uses ${placeholders.map((placeholder) => `{{${placeholder.name}}}`).join(', ')}.` : ' This message has no variables yet.'}</p>
    </div>}

    {step === 'preview' && current && preview && <div className="mail-merge-body">
      <div className="mail-merge-stepper">
        <button className="icon-button" aria-label="Previous recipient" disabled={index === 0} onClick={() => setIndex((value) => Math.max(0, value - 1))}><ChevronLeft size={16} /></button>
        <span>Recipient {(index + 1).toLocaleString()} of {recipients.length.toLocaleString()}</span>
        <button className="icon-button" aria-label="Next recipient" disabled={index >= recipients.length - 1} onClick={() => setIndex((value) => Math.min(recipients.length - 1, value + 1))}><ChevronRight size={16} /></button>
      </div>
      <dl className="mail-merge-preview-headers">
        <div><dt>To</dt><dd>{mergeRecipientAddress(current)}</dd></div>
        <div><dt>Subject</dt><dd>{preview.subject || '(No subject)'}</dd></div>
      </dl>
      {preview.html ? <MessageHtml className="mail-merge-preview-body" html={preview.html} /> : <div className="mail-merge-preview-body mail-merge-preview-text">{preview.text}</div>}
      {preview.missing.length > 0 && <p className="mail-merge-warning"><AlertTriangle size={14} /> No value for {preview.missing.map((name) => `{{${name}}}`).join(', ')} — it will be left blank for this recipient.</p>}
    </div>}

    {step === 'confirm' && <div className="mail-merge-body">
      <ul className="mail-merge-checklist">
        <li><strong>{plural(recipients.length, 'separate message')}</strong> from {account?.email ?? 'this account'}.</li>
        <li>Each message has exactly one recipient in To. Nobody sees anyone else’s address; Cc and Bcc are not used{ignoredCopies > 0 ? ` (the ${plural(ignoredCopies, 'Cc/Bcc address')} in the composer will not be sent)` : ''}.</li>
        {message.attachmentPaths.length > 0 && <li>Every message includes {plural(message.attachmentPaths.length, 'attachment')}.</li>}
        {gaps.map((gap) => <li key={gap.name} className="mail-merge-warning"><AlertTriangle size={14} /> {plural(gap.missing, 'recipient')} {gap.missing === 1 ? 'has' : 'have'} no {`{{${gap.name}}}`}{gap.fallback ? '; the fallback is used.' : ' and no fallback is set; it will be blank.'}</li>)}
        <li>If a send is interrupted and Aerio cannot tell whether it went out, that recipient is held for your review and is never resent automatically.</li>
      </ul>
      <div className="mail-merge-limits">
        <label className="field-label">Messages per minute<input type="number" min={1} max={MAIL_MERGE_MAX_PER_MINUTE} value={limits.perMinute} onChange={(event) => setLimits(clampMailMergeLimits({ ...limits, perMinute: Number(event.target.value) }, account?.provider, account?.email))} /></label>
        <label className="field-label">Daily limit for this account<input type="number" min={1} max={provider.maxDailyCap} value={limits.dailyCap} onChange={(event) => setLimits(clampMailMergeLimits({ ...limits, dailyCap: Number(event.target.value) }, account?.provider, account?.email))} /></label>
      </div>
      <p className="mail-merge-note">{provider.label}. Aerio defaults below that, counts every merge sent from this account in the last 24 hours, and slows down automatically when the provider asks. Estimated time: {duration.days ? `${plural(duration.days, 'extra day')} plus ` : ''}about {plural(duration.minutes, 'minute')}.</p>
    </div>}

    <footer className="modal-footer">
      <button className="button ghost" disabled={busy} onClick={step === 'recipients' ? onClose : () => setStep(step === 'confirm' ? 'preview' : 'recipients')}>{step === 'recipients' ? 'Cancel' : 'Back'}</button>
      <span className="spacer" />
      {step === 'recipients' && <button className="button primary" disabled={!recipients.length || tooMany} onClick={() => { setIndex(0); setStep('preview') }}>Preview <ChevronRight size={15} /></button>}
      {step === 'preview' && <button className="button primary" onClick={() => setStep('confirm')}>Continue <ChevronRight size={15} /></button>}
      {step === 'confirm' && <button className="button primary" disabled={busy || !recipients.length || !window.aerio.mail.merge} onClick={() => void start()}><Send size={15} /> {busy ? 'Starting…' : `Send ${plural(recipients.length, 'message')}`}</button>}
    </footer>
  </Modal>
}

/** Live per-recipient progress for one job, with pause/cancel and ambiguous-send review. */
export function MailMergeProgress({ jobId, onToast, onDeleted }: { jobId: string; onToast(message: string): void; onDeleted?(): void }) {
  const [job, setJob] = useState<MailMergeJob>()
  const [busy, setBusy] = useState(false)
  const api = window.aerio.mail.merge
  const load = useCallback(() => api?.get(jobId).then(setJob).catch(() => undefined), [api, jobId])

  useEffect(() => { void load() }, [load])
  useEffect(() => window.aerio.mail.onEvent((event) => {
    if (event.type === 'mail-merge' && event.payload.id === jobId) void load()
  }), [jobId, load])

  const run = async (action: () => Promise<unknown>, failure: string) => {
    setBusy(true)
    try {
      await action()
      await load()
    } catch (error) {
      onToast(friendlyError(error, failure))
    } finally {
      setBusy(false)
    }
  }
  const resolve = (positions: number[], resolution: MailMergeResolution) => run(() => api!.resolve(jobId, positions, resolution), 'The review choice could not be saved')

  if (!api) return <p className="rules-empty">Mail merge is not available.</p>
  if (!job) return <p className="rules-empty">Loading mail merge…</p>
  const done = job.counts.sent + job.counts.failed + job.counts.skipped + job.counts.cancelled
  const ambiguous = job.recipients.filter((recipient) => recipient.status === 'ambiguous')
  const failed = job.recipients.filter((recipient) => recipient.status === 'failed')
  const active = job.status === 'running' || job.status === 'paused' || job.status === 'needs-review'

  return <div className="mail-merge-body">
    <div className="mail-merge-progress-head">
      <strong>{JOB_STATUS_LABELS[job.status]}</strong>
      <span>{job.counts.sent.toLocaleString()} of {job.total.toLocaleString()} sent{job.counts.failed ? ` · ${job.counts.failed.toLocaleString()} failed` : ''}{job.counts.skipped ? ` · ${job.counts.skipped.toLocaleString()} skipped` : ''}{job.counts.cancelled ? ` · ${job.counts.cancelled.toLocaleString()} cancelled` : ''}</span>
      <span className="spacer" />
      {job.status === 'running' && <button className="button ghost small" disabled={busy} onClick={() => void run(() => api.pause(jobId), 'The mail merge could not be paused')}><Pause size={14} /> Pause</button>}
      {job.status === 'paused' && <button className="button ghost small" disabled={busy} onClick={() => void run(() => api.resume(jobId), 'The mail merge could not resume')}><Play size={14} /> Resume</button>}
      {active && <button className="button ghost small danger-subtle" disabled={busy} onClick={() => void run(() => api.cancel(jobId), 'The mail merge could not be cancelled')}><X size={14} /> Cancel remaining</button>}
      {!active && onDeleted && <button className="button ghost small danger-subtle" disabled={busy} onClick={() => void run(async () => { await api.delete(jobId); onDeleted() }, 'The mail merge could not be removed')}><Trash2 size={14} /> Remove</button>}
    </div>
    <progress className="mail-merge-progress" max={Math.max(1, job.total)} value={done} aria-label="Mail merge progress" />
    {job.lastError && <p className="mail-merge-warning"><AlertTriangle size={14} /> {job.lastError}</p>}
    {job.status === 'running' && job.nextAttemptAt && Date.parse(job.nextAttemptAt) > Date.now() + 60_000 && <p className="mail-merge-note">Next message at {new Date(job.nextAttemptAt).toLocaleString()}.</p>}
    {ambiguous.length > 0 && <section className="mail-merge-review" aria-label="Sends that need review">
      <p><AlertTriangle size={14} /> <strong>{plural(ambiguous.length, 'message')} may or may not have been sent.</strong> Check your Sent folder, then choose for each one. Nothing else is sent until you decide.</p>
      <div className="mail-merge-review-actions">
        <button className="button ghost small" disabled={busy} onClick={() => void resolve(ambiguous.map((item) => item.position), 'skip')}><SkipForward size={14} /> Skip all (treat as sent)</button>
        <button className="button ghost small" disabled={busy || job.status === 'cancelled'} onClick={() => void resolve(ambiguous.map((item) => item.position), 'resend')}><RotateCcw size={14} /> Resend all</button>
      </div>
    </section>}
    <div className="mail-merge-recipients" role="list">
      {job.recipients.map((recipient) => <RecipientRow key={recipient.position} recipient={recipient} busy={busy} cancelled={job.status === 'cancelled'} onResolve={(resolution) => void resolve([recipient.position], resolution)} />)}
    </div>
    {failed.length > 0 && active && <p className="mail-merge-note">{plural(failed.length, 'recipient')} failed; use Resend on a row to try again.</p>}
  </div>
}

function RecipientRow({ recipient, busy, cancelled, onResolve }: { recipient: MailMergeRecipient; busy: boolean; cancelled: boolean; onResolve(resolution: MailMergeResolution): void }) {
  const canResend = (recipient.status === 'ambiguous' || recipient.status === 'failed') && !cancelled
  const canSkip = recipient.status === 'ambiguous' || recipient.status === 'failed' || (recipient.status === 'pending' && !cancelled)
  return <div role="listitem" className={`mail-merge-recipient status-${recipient.status}`}>
    <span className="rule-copy"><strong>{recipient.name || recipient.email}</strong><small>{recipient.email}{recipient.error ? ` · ${recipient.error}` : ''}</small></span>
    <span className="mail-merge-status">{MAIL_MERGE_STATUS_LABELS[recipient.status]}</span>
    {canResend && <button className="icon-button" title="Resend to this recipient" aria-label={`Resend to ${recipient.email}`} disabled={busy} onClick={() => onResolve('resend')}><RotateCcw size={14} /></button>}
    {canSkip && <button className="icon-button" title="Skip this recipient" aria-label={`Skip ${recipient.email}`} disabled={busy} onClick={() => onResolve('skip')}><SkipForward size={14} /></button>}
  </div>
}

/** Every mail merge on this device, newest first. */
export function MailMergeJobsModal({ accounts, onClose, onToast }: { accounts: MailAccountSummary[]; onClose(): void; onToast(message: string): void }) {
  const [jobs, setJobs] = useState<MailMergeJobSummary[]>()
  const [openId, setOpenId] = useState<string>()
  const api = window.aerio.mail.merge
  const load = useCallback(() => api?.list().then(setJobs).catch(() => setJobs([])), [api])
  useEffect(() => { void load() }, [load])
  useEffect(() => window.aerio.mail.onEvent((event) => { if (event.type === 'mail-merge') void load() }), [load])

  if (openId) return <Modal title="Mail merge" subtitle={jobs?.find((job) => job.id === openId)?.name} width="large" onClose={onClose}>
    <MailMergeProgress jobId={openId} onToast={onToast} onDeleted={() => { setOpenId(undefined); void load() }} />
    <footer className="modal-footer"><button className="button ghost" onClick={() => setOpenId(undefined)}><ChevronLeft size={15} /> All mail merges</button><span className="spacer" /><button className="button primary" onClick={onClose}>Close</button></footer>
  </Modal>

  return <Modal title="Mail merges" subtitle="Personalized messages sent one recipient at a time" width="medium" onClose={onClose}>
    <div className="mail-rules-list">
      {!jobs && <p className="rules-empty">Loading mail merges…</p>}
      {jobs && !jobs.length && <div className="rules-empty"><Users size={26} /><strong>No mail merges</strong><span>Write a message with {'{{firstName}}'} or other variables, then choose Mail merge in the composer.</span></div>}
      {jobs?.map((job) => <article key={job.id} className={job.status === 'completed' || job.status === 'cancelled' ? 'disabled' : ''}>
        <span className="rule-copy"><strong>{job.name}</strong><small>{accounts.find((account) => account.id === job.accountId)?.email ?? 'Missing account'} · {job.counts.sent.toLocaleString()} of {job.total.toLocaleString()} sent</small><small>{JOB_STATUS_LABELS[job.status]}{job.counts.ambiguous ? ` · ${plural(job.counts.ambiguous, 'send')} to review` : ''}</small></span>
        <button className="button ghost small" onClick={() => setOpenId(job.id)}>Open</button>
      </article>)}
    </div>
    <footer className="modal-footer"><span className="spacer" /><button className="button primary" onClick={onClose}>Close</button></footer>
  </Modal>
}
