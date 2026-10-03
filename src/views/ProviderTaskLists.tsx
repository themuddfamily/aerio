import { useState } from 'react'
import Modal from '../components/Modal'
import type { TaskDesktopApi, TaskListOperation, TaskResolution, TaskSnapshot } from '../task-provider-types'

const active = (operation: TaskListOperation) => !['succeeded', 'cancelled'].includes(operation.status)
export default function ProviderTaskLists({ snapshot, accountId, onSnapshot, onToast, onClose }: { snapshot: TaskSnapshot; accountId: string; onSnapshot(snapshot: TaskSnapshot): void; onToast(message: string): void; onClose(): void }) {
  const [name, setName] = useState('')
  const [renaming, setRenaming] = useState<string>()
  const [reviewId, setReviewId] = useState<string>()
  const [candidateId, setCandidateId] = useState('')
  const [notApplied, setNotApplied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const account = snapshot.accounts.find((account) => account.accountId === accountId)
  const providerName = account?.provider === 'microsoft' ? 'Microsoft' : 'Google'
  const writable = Boolean(account?.canWrite && !account.archived && account.syncEnabled !== false)
  const lists = snapshot.lists.filter((list) => list.accountId === accountId)
  const operations = (snapshot.listOperations ?? []).filter((operation) => operation.accountId === accountId)
  const reviewing = operations.find((operation) => operation.id === reviewId && active(operation))
  const current = reviewing && lists.find((list) => list.id === reviewing.base?.id)
  const candidates = lists.filter((list) => !reviewing?.knownListIds?.includes(list.id) && list.title === reviewing?.title && !operations.some((operation) => operation.id !== reviewing?.id && operation.kind === 'create' && operation.status === 'succeeded' && operation.result?.id === list.id))
  const candidate = candidates.find((list) => list.id === candidateId)
  const expected = reviewing?.kind === 'create' ? candidate : current
  const run = async (command: (api: TaskDesktopApi) => Promise<TaskSnapshot>, message?: string) => {
    if (busy) return false
    setBusy(true); setError('')
    try { await command(window.aerio.tasks); onSnapshot(await window.aerio.tasks.snapshot()); if (message) onToast(message); return true }
    catch (error) { setError(error instanceof Error ? error.message : 'This list change could not be saved'); return false }
    finally { setBusy(false) }
  }
  const resolve = async (resolution: TaskResolution) => {
    if (reviewing && await run((api) => api.resolveList(reviewing.id, resolution), 'List change resolved')) { setReviewId(undefined); setNotApplied(false); setCandidateId('') }
  }
  return <Modal title={`${providerName} task lists`} onClose={onClose}><div className="form-stack">
    {error && <p role="alert" className="provider-task-error">{error}</p>}
    {!writable && <p className="provider-task-notice">Reconnect an active account with Tasks write access to change its lists.</p>}
    <button className="button ghost" disabled={busy || account?.archived || account?.syncEnabled === false || !account?.canRead} onClick={() => void run((api) => api.sync(accountId))}>Refresh {providerName} lists</button>
    {!reviewing && <>
      <form onSubmit={(event) => { event.preventDefault(); void (async () => { if (await run((api) => renaming ? api.renameList(renaming, name) : api.createList(accountId, name), 'List change saved')) { setName(''); setRenaming(undefined) } })() }}>
        <label className="field-label">{renaming ? 'New list name' : 'List name'}<input value={name} disabled={!writable || busy} maxLength={1024} onChange={(event) => setName(event.target.value)} /></label>
        <div className="provider-task-actions"><button className="button primary" disabled={!writable || busy || !name.trim()} type="submit">{renaming ? 'Save list name' : `Create ${providerName} list`}</button>{renaming && <button className="button ghost" type="button" disabled={busy} onClick={() => { setRenaming(undefined); setName('') }}>Cancel rename</button>}</div>
      </form>
      <p className="provider-task-notice">New lists appear after {providerName} confirms them. Saved changes wait while offline; unsent changes can be cancelled.</p>
      <section className="provider-task-history" aria-label={`${providerName} lists`}>{lists.map((list) => {
        const pending = operations.some((operation) => active(operation) && operation.base?.id === list.id)
        return <div key={list.id}><span>{list.title}{pending && <small>List change pending</small>}{list.manageReadOnly && <small>List managed by {providerName}</small>}</span><div className="provider-task-actions"><button className="button ghost small" disabled={!writable || busy || list.readOnly || list.manageReadOnly || pending} aria-label={`Rename ${providerName} list ${list.title}`} onClick={() => { setRenaming(list.id); setName(list.title) }}>Rename</button><button className="button danger-subtle small" disabled={!writable || busy || list.readOnly || list.manageReadOnly || pending} aria-label={`Delete ${providerName} list ${list.title}`} onClick={() => { if (window.confirm(`Delete ${providerName} list “${list.title}” and all its tasks? This cannot be undone. Pending task changes must be resolved first.`)) void run((api) => api.deleteList(list.id), 'List deletion saved') }}>Delete</button></div></div>
      })}</section>
      {operations.length > 0 && <section className="provider-task-history" aria-label="List changes"><h2>List changes</h2>{operations.filter((operation) => active(operation) || operations.slice(-8).some((recent) => recent.id === operation.id)).slice().reverse().map((operation) => <div key={operation.id}><span>{operation.kind === 'create' ? 'Create' : operation.kind === 'update' ? 'Rename' : 'Delete'} {operation.title ?? operation.base?.title}<small>{operation.status === 'queued' ? 'Pending sync' : operation.status === 'running' ? 'Synchronizing' : operation.status === 'succeeded' ? 'Synchronized' : operation.status === 'cancelled' ? 'Cancelled' : 'Needs review'}</small></span>
        {operation.status === 'queued' && operation.attempts === 0 ? <button className="button ghost small" disabled={busy || !writable} onClick={() => void run((api) => api.resolveList(operation.id, { action: 'discard' }), 'List change cancelled')}>Cancel change</button> : ['review', 'failed', 'conflict'].includes(operation.status) && <button className="button ghost small" disabled={busy} onClick={() => { setReviewId(operation.id); setCandidateId(''); setNotApplied(false); setError('') }}>Review list change</button>}
      </div>)}</section>}
    </>}
    {reviewing && <>
      <h2>Review list change</h2><p>{reviewing.error === 'restored-write' ? 'This list change was restored from backup. Review it before sending.' : reviewing.status === 'conflict' ? 'Another client changed this list.' : reviewing.status === 'review' ? 'The connection ended before Aerio could confirm the list change.' : `${providerName} did not accept the list change.`}</p>
      <dl className="provider-task-review"><dt>Your change</dt><dd>{reviewing.kind === 'delete' ? `Delete ${reviewing.base?.title} and all its tasks` : `${reviewing.kind === 'create' ? 'Create' : 'Rename to'} ${reviewing.title}`}</dd><dt>{providerName} version</dt><dd>{current?.title ?? 'No matching list in the latest cache'}</dd></dl>
      {reviewing.kind === 'create' && <label className="field-label">List created in {providerName}<select aria-label={`List created in ${providerName}`} value={candidateId} disabled={busy} onChange={(event) => setCandidateId(event.target.value)}><option value="">Select the matching list</option>{candidates.map((list) => <option key={list.id} value={list.id}>{list.title}</option>)}</select></label>}
      {reviewing.status === 'review' && <label className="check-label"><input type="checkbox" disabled={busy} checked={notApplied} onChange={(event) => setNotApplied(event.target.checked)} /> I checked {providerName} and this list change was not applied</label>}
      <p className="provider-task-notice">Refresh before reviewing. Confirming an applied change prevents it from being sent again. Retrying uses the {providerName} revision you reviewed.</p>
      <div className="provider-task-actions"><button className="button danger-subtle" disabled={busy || !writable} onClick={() => void resolve({ action: 'discard' })}>Discard list change</button><button className="button ghost" disabled={busy || !writable || (reviewing.kind === 'delete' ? Boolean(current) : !expected?.revision)} onClick={() => void resolve({ action: 'accept', remoteId: expected?.id, expectedRevision: expected?.revision })}>Confirm list change applied</button><button className="button primary" disabled={busy || !writable || (reviewing.status === 'review' && !notApplied) || (reviewing.kind !== 'create' && !current?.revision)} onClick={() => void resolve({ action: 'retry', expectedRevision: current?.revision, confirmedNotApplied: notApplied })}>Retry list change</button><button className="button ghost" disabled={busy} onClick={() => { setReviewId(undefined); setError('') }}>Back to lists</button></div>
    </>}
    <footer className="modal-footer"><button className="button ghost" disabled={busy} onClick={onClose}>Done</button></footer>
  </div></Modal>
}
