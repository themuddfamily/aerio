import { useEffect, useState } from 'react'
import type { MailAccountSummary } from '../mail-types'
import type { AiAssistantStatus } from '../ai-assistant-types'
import type { AiConversationScope, AiConversationState, AiOrganizeAction, AiOrganizeProposal, AiOrganizeReview } from '../ai-conversation-types'
import { aiProviderName, friendlyAiError, useAiRequest } from '../lib/use-ai-assistant'
import Modal from './Modal'
import './AiConversationDialog.css'

const labels: Record<AiOrganizeAction, string> = { read: 'Mark as read', unread: 'Mark as unread', archive: 'Archive', star: 'Add star', unstar: 'Remove star', trash: 'Move to Trash', label: 'Apply label', move: 'Move to folder' }
function Review({ proposal, busy, onApply }: { proposal: AiOrganizeProposal; busy: boolean; onApply(review: AiOrganizeReview): void }) {
  const [action, setAction] = useState(proposal.action)
  const [selected, setSelected] = useState(proposal.targets.map((target) => target.ref))
  const [destination, setDestination] = useState(proposal.destinationRef ?? '')
  const [reviewed, setReviewed] = useState(false)
  const selectedTargets = proposal.targets.filter((target) => selected.includes(target.ref))
  const folders = proposal.folders.filter((folder) => selectedTargets.every((target) => target.accountId === folder.accountId))
  const needsFolder = action === 'move' || action === 'label'
  const unavailable = busy || proposal.consumed || Date.parse(proposal.expiresAt) <= Date.now()
  return <section className="ai-conversation-review" aria-label="Review mail changes">
    <strong>Review proposed mail changes</strong>
    <label className="field"><span>Action</span><select aria-label="Reviewed mail action" disabled={unavailable} value={action} onChange={(event) => { setAction(event.target.value as AiOrganizeAction); setReviewed(false) }}>{Object.entries(labels).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label>
    {proposal.targets.map((target) => <label key={target.ref} className="toggle-row"><span>{target.subject || '(No subject)'}<small>{target.accountName}</small></span><input type="checkbox" aria-label={`Include ${target.subject || '(No subject)'}`} disabled={unavailable} checked={selected.includes(target.ref)} onChange={(event) => { setSelected(event.target.checked ? [...selected, target.ref] : selected.filter((ref) => ref !== target.ref)); setReviewed(false) }} /></label>)}
    {needsFolder && <label className="field"><span>Destination</span><select aria-label="Reviewed destination" disabled={unavailable} value={destination} onChange={(event) => { setDestination(event.target.value); setReviewed(false) }}><option value="">Choose an observed folder…</option>{folders.map((folder) => <option key={folder.ref} value={folder.ref}>{folder.name}</option>)}</select><small>If no folder is available, ask the assistant to list folders. A move or label must stay within one account.</small></label>}
    <p>{labels[action]} · {selected.length} selected conversation(s). {proposal.consumed ? 'This proposal has been used; check the result below.' : 'This proposal expires after ten minutes. No change has been applied.'}</p>
    <label className="toggle-row"><span>I reviewed this action and these conversations</span><input type="checkbox" disabled={unavailable} checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} /></label>
    <button className="button primary" disabled={unavailable || !reviewed || !selected.length || (needsFolder && !folders.some((folder) => folder.ref === destination))} onClick={() => onApply({ proposalId: proposal.id, action, targetRefs: selected, ...(needsFolder ? { destinationRef: destination } : {}) })}>{proposal.consumed ? 'Proposal already used' : 'Apply reviewed changes'}</button>
  </section>
}

export default function AiConversationDialog({ accounts, status, onClose }: { accounts: MailAccountSummary[]; status: AiAssistantStatus; onClose(): void }) {
  const api = window.aerio.ai.conversation
  const [state, setState] = useState<AiConversationState>()
  const [scope, setScope] = useState<AiConversationScope>({ allowMail: false, accountIds: [], allowWeb: false })
  const [message, setMessage] = useState('')
  const [publicSearchQuery, setPublicSearchQuery] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [applying, setApplying] = useState(false)
  const request = useAiRequest()
  const busy = request.busy || applying
  const load = (value: AiConversationState) => { setState(value); setScope(value.scope) }
  useEffect(() => { let active = true; void api.state().then((value) => { if (active) load(value) }).catch((reason) => { if (active) setError(friendlyAiError(reason)) }); return () => { active = false } }, [api, status])
  const send = async () => {
    if (!state || !message.trim() || (scope.allowWeb && (!publicSearchQuery.trim() || publicSearchQuery.trim().split(/\s+/).length > 75))) return
    const text = message.trim()
    setError(''); setNotice(''); setMessage('')
    const history = JSON.stringify(scope) === JSON.stringify(state.scope) ? state.messages : []
    setState({ ...state, messages: [...history, { id: crypto.randomUUID(), role: 'user', text }] })
    const query = scope.allowWeb ? publicSearchQuery.trim() : undefined
    setPublicSearchQuery('')
    const result = await request.start((id) => api.turn(id, { ...scope, conversationId: state.id, message: text, ...(query ? { publicSearchQuery: query } : {}) }))
    if (result) load(result)
    else void api.state().then(load).catch(() => undefined)
  }
  const apply = async (review: AiOrganizeReview) => {
    setApplying(true); setError(''); setNotice('')
    try { const result = await api.apply(review); load(result.state); setNotice(`${result.appliedCount} conversation(s) queued for ${labels[review.action].toLowerCase()}.${result.errors.length ? ` ${result.errors.join(' ')}` : ''}`) }
    catch (reason) { setError(friendlyAiError(reason)) }
    finally { setApplying(false) }
  }
  return <Modal title="AI assistant" subtitle={`Conversation with ${aiProviderName(status)} · your mail changes always need review`} width="large" onClose={onClose}>
    <div className="ai-conversation-body">
      <p>Ask follow-up questions, organize selected mail, or research the public web. History stays in this app session until cleared, locked or closed for a restart. No recipients, attachments, HTML or passwords are shared.</p>
      <fieldset disabled={busy} className="ai-conversation-scope"><legend>Allowed tools and data</legend>
        <label className="toggle-row"><span>Allow mail search and reading</span><input type="checkbox" checked={scope.allowMail} onChange={(event) => setScope({ ...scope, allowMail: event.target.checked })} /></label>
        {scope.allowMail && <><small>Selected accounts only. Each search shares up to 20 subjects/dates; reading shares up to 3 plain-text messages (4,000 characters each). Sender details follow your AI setting.</small>{accounts.filter((account) => !account.archived).map((account) => <label className="toggle-row" key={account.id}><span>{account.email}</span><input type="checkbox" aria-label={`Assistant may read ${account.email}`} checked={scope.accountIds.includes(account.id)} onChange={(event) => setScope({ ...scope, accountIds: event.target.checked ? [...scope.accountIds, account.id].slice(0, 5) : scope.accountIds.filter((id) => id !== account.id) })} /></label>)}</>}
        <label className="toggle-row"><span>Allow public-web research<small>Only the exact public search query you enter below can go to Brave Search. Extracted page content goes to your AI provider.</small></span><input type="checkbox" checked={scope.allowWeb} disabled={!status.hasWebSearchKey || busy} onChange={(event) => setScope({ ...scope, allowWeb: event.target.checked })} /></label>
        {scope.allowWeb && <label className="field"><span>Public search query for this message</span><input aria-label="Public search query for this message" maxLength={600} value={publicSearchQuery} onChange={(event) => setPublicSearchQuery(event.target.value)} /><small>Review before sending: this exact text may be sent to Brave, up to two times. The model cannot add mail text or change it. Enter a new query for every message; up to 600 characters and 75 words. Avoid private terms.</small></label>}
        {!status.hasWebSearchKey && <small>Add a Brave Search token in Settings → AI assistance to enable web research.</small>}
        <small>Changing tool/account scope starts a fresh conversation on your next message. Up to eight tool steps and two web lookups per turn, within two minutes.</small>
      </fieldset>
      <div className="ai-conversation-transcript" aria-label="Assistant conversation" aria-live="polite">
        {!state?.messages.length && <p>Start with a question, or allow selected mail and ask “Find unread invoices and propose filing them.”</p>}
        {state?.messages.map((entry) => <article key={entry.id} className={entry.role}><strong>{entry.role === 'user' ? 'You' : 'Assistant'}</strong><p>{entry.text}</p>
          {!!entry.sources?.length && <ul aria-label="Web sources">{entry.sources.map((source) => <li key={source.id}><a href={source.url} target="_blank" rel="noreferrer">{source.title || source.url}</a></li>)}</ul>}
          {entry.proposal && <Review proposal={entry.proposal} busy={busy} onApply={(review) => void apply(review)} />}
        </article>)}
      </div>
      {(error || request.error) && <p role="alert">{error || request.error}</p>}
      {(notice || request.notice) && <p role="status">{notice || request.notice}</p>}
      {request.busy && <p role="status">Thinking and checking the sources you allowed…</p>}
      <label className="field"><span>Your message</span><textarea aria-label="Message to AI assistant" maxLength={4000} rows={3} disabled={busy || !state} value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void send() } }} /></label>
    </div>
    <footer className="modal-footer"><button className="button ghost" disabled={busy || !state} onClick={() => { setPublicSearchQuery(''); void api.clear().then(load).catch((reason) => setError(friendlyAiError(reason))) }}>Clear conversation</button><span className="spacer" />{request.busy && <button className="button ghost" onClick={request.cancel}>Cancel request</button>}<button className="button primary" disabled={busy || !state || !message.trim() || (scope.allowMail && !scope.accountIds.length) || (scope.allowWeb && (!publicSearchQuery.trim() || publicSearchQuery.trim().split(/\s+/).length > 75))} onClick={() => void send()}>Send message</button></footer>
  </Modal>
}
