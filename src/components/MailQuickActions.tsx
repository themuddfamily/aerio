import { ArrowDown, ArrowUp, Pencil, Plus, Save, Trash2, X, Zap } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { MailAccountSummary, MailActionKind, MailLabel, MailQuickAction, MailQuickActionInput, MailQuickActionStep } from '../mail-types'
import {
  MAX_QUICK_ACTION_STEPS, QUICK_ACTION_STEP_LABELS, describeQuickActionStep, quickActionDestinations,
  quickActionStepNeedsDestination
} from '../lib/mail-quick-actions'
import { quickActionCommandId } from '../lib/keymap'
import { useKeymap } from '../lib/use-keymap'
import Modal from './Modal'

/** Current key for a Quick Action slot, from the editable keymap (Settings → Keyboard shortcuts). */
function useQuickActionSlotLabel() {
  const { label } = useKeymap()
  return (slot: number) => label(quickActionCommandId(slot))
}

export function useMailQuickActions(onToast: (message: string) => void) {
  const [quickActions, setQuickActions] = useState<MailQuickAction[]>([])

  const load = useCallback(async () => {
    try {
      setQuickActions(await window.aerio.mail.quickActions.list())
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Quick actions could not be loaded')
    }
  }, [onToast])

  useEffect(() => { void load() }, [load])

  const save = useCallback(async (input: MailQuickActionInput) => {
    const saved = await window.aerio.mail.quickActions.save(input)
    setQuickActions((current) => [...current.filter((item) => item.id !== saved.id), saved].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })))
    return saved
  }, [])

  const remove = useCallback(async (quickAction: MailQuickAction) => {
    try {
      await window.aerio.mail.quickActions.delete(quickAction.id)
      setQuickActions((current) => current.filter((item) => item.id !== quickAction.id))
      onToast(`Deleted “${quickAction.name}”`)
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'The quick action could not be deleted')
    }
  }, [onToast])

  return { quickActions, save, remove, reload: load }
}

interface MailQuickActionButtonsProps {
  quickActions: MailQuickAction[]
  disabled?: boolean
  className: string
  onRun(quickAction: MailQuickAction): void
}

/** Toolbar buttons for quick actions the user pinned to the toolbar. */
export function MailQuickActionButtons({ quickActions, disabled, className, onRun }: MailQuickActionButtonsProps) {
  const slotLabel = useQuickActionSlotLabel()
  const pinned = quickActions.filter((item) => item.showInToolbar)
  if (!pinned.length) return null
  return <>{pinned.map((item) => <button key={item.id} className={className} disabled={disabled} title={`Run quick action “${item.name}”${item.shortcut && slotLabel(item.shortcut) ? ` (${slotLabel(item.shortcut)})` : ''}`} onClick={() => onRun(item)}><Zap size={15} /><span>{item.name}</span></button>)}</>
}

interface MailQuickActionsModalProps {
  accounts: MailAccountSummary[]
  labels: MailLabel[]
  quickActions: MailQuickAction[]
  onSave(input: MailQuickActionInput): Promise<unknown>
  onDelete(quickAction: MailQuickAction): Promise<void>
  onClose(): void
}

const newStep = (): MailQuickActionStep => ({ action: 'read' })

export function MailQuickActionsModal({ accounts, labels, quickActions, onSave, onDelete, onClose }: MailQuickActionsModalProps) {
  const writableAccounts = accounts.filter((account) => !account.archived)
  const slotLabel = useQuickActionSlotLabel()
  const [editing, setEditing] = useState<MailQuickActionInput>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const account = accounts.find((item) => item.id === editing?.accountId)

  const edit = (next?: MailQuickActionInput) => { setEditing(next); setError(undefined) }
  const updateStep = (index: number, updates: Partial<MailQuickActionStep>) => setEditing((current) => current && ({ ...current, steps: current.steps.map((step, itemIndex) => itemIndex === index ? { ...step, ...updates } : step) }))
  const moveStep = (index: number, offset: number) => setEditing((current) => {
    if (!current) return current
    const steps = [...current.steps]
    const [step] = steps.splice(index, 1)
    steps.splice(index + offset, 0, step)
    return { ...current, steps }
  })

  const save = async () => {
    if (!editing) return
    setBusy(true)
    setError(undefined)
    try {
      await onSave({ ...editing, name: editing.name.trim(), steps: editing.steps.map((step) => quickActionStepNeedsDestination(step.action) ? step : { action: step.action }) })
      setEditing(undefined)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The quick action could not be saved')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (quickAction: MailQuickAction) => {
    if (!window.confirm(`Delete the quick action “${quickAction.name}”? Mail is not affected.`)) return
    await onDelete(quickAction)
  }

  return <Modal title="Quick actions" subtitle="Run a saved sequence of mail actions from the toolbar, menus, command palette, or a shortcut" width="large" onClose={onClose}>
    {!editing ? <>
      <div className="mail-rules-list">
        {!quickActions.length && <div className="rules-empty"><Zap size={26} /><strong>No quick actions yet</strong><span>Combine steps like mark as read, apply a label, and archive into one action.</span></div>}
        {quickActions.map((item) => <article key={item.id}>
          <span className="rule-copy"><strong>{item.name}</strong><small>{item.accountId ? accounts.find((candidate) => candidate.id === item.accountId)?.email ?? 'Missing account' : 'Any account'}{item.shortcut ? ` · ${slotLabel(item.shortcut) ?? `Shortcut slot ${item.shortcut} (no key assigned)`}` : ''}{item.showInToolbar ? ' · On toolbar' : ''}</small><small>{item.steps.map((step) => describeQuickActionStep(step, labels, item.accountId)).join(' → ')}</small></span>
          <button className="icon-button" title="Edit quick action" aria-label={`Edit ${item.name}`} onClick={() => edit({ ...item })}><Pencil size={15} /></button>
          <button className="icon-button danger" title="Delete quick action" aria-label={`Delete ${item.name}`} onClick={() => void remove(item)}><Trash2 size={15} /></button>
        </article>)}
      </div>
      <footer className="modal-footer"><button className="button ghost" onClick={onClose}>Close</button><span className="spacer" /><button className="button primary" onClick={() => edit({ name: '', steps: [newStep()], showInToolbar: true })}><Plus size={15} /> New quick action</button></footer>
    </> : <>
      <div className="mail-rule-editor">
        <div className="rule-grid">
          <label className="field"><span>Name</span><input autoFocus value={editing.name} maxLength={80} onChange={(event) => setEditing({ ...editing, name: event.target.value })} placeholder="e.g. File receipt" /></label>
          <label className="field"><span>Account</span><select value={editing.accountId ?? ''} onChange={(event) => setEditing({ ...editing, accountId: event.target.value || undefined, steps: editing.steps.map((step) => ({ action: step.action })) })}><option value="">Any account</option>{(account && account.archived ? [account, ...writableAccounts] : writableAccounts).map((item) => <option key={item.id} value={item.id}>{item.email}</option>)}</select></label>
        </div>
        <section><header><span><strong>Steps</strong><small>Run in the order shown. Labels and folders need a specific account.</small></span></header>
          {editing.steps.map((step, index) => {
            const destinations = quickActionDestinations(step.action, account, labels)
            const stale = step.labelId && !destinations.some((label) => label.id === step.labelId)
            return <div className="rule-row action" key={index}>
              <select aria-label={`Step ${index + 1}`} value={step.action} onChange={(event) => updateStep(index, { action: event.target.value as MailActionKind, labelId: undefined })}>{(Object.keys(QUICK_ACTION_STEP_LABELS) as MailActionKind[]).map((kind) => <option key={kind} value={kind}>{QUICK_ACTION_STEP_LABELS[kind]}</option>)}</select>
              {quickActionStepNeedsDestination(step.action) && (account
                ? <select aria-label={`Step ${index + 1} destination`} value={step.labelId ?? ''} onChange={(event) => updateStep(index, { labelId: event.target.value || undefined })}><option value="">{destinations.length ? 'Choose destination…' : 'No destinations available'}</option>{stale && <option value={step.labelId}>Missing: {step.labelId}</option>}{destinations.map((label) => <option key={label.id} value={label.id}>{label.name}</option>)}</select>
                : <small className="mail-search-hint">Choose an account to pick a destination</small>)}
              <span className="spacer" />
              <button className="icon-button" aria-label={`Move step ${index + 1} up`} disabled={index === 0} onClick={() => moveStep(index, -1)}><ArrowUp size={14} /></button>
              <button className="icon-button" aria-label={`Move step ${index + 1} down`} disabled={index === editing.steps.length - 1} onClick={() => moveStep(index, 1)}><ArrowDown size={14} /></button>
              <button className="icon-button" aria-label={`Remove step ${index + 1}`} disabled={editing.steps.length === 1} onClick={() => setEditing({ ...editing, steps: editing.steps.filter((_, itemIndex) => itemIndex !== index) })}><X size={14} /></button>
            </div>
          })}
          <button className="text-button rule-add" disabled={editing.steps.length >= MAX_QUICK_ACTION_STEPS} onClick={() => setEditing({ ...editing, steps: [...editing.steps, newStep()] })}><Plus size={14} /> Add step</button>
        </section>
        <div className="rule-grid">
          <label className="field"><span>Keyboard shortcut</span><select value={editing.shortcut ?? ''} onChange={(event) => setEditing({ ...editing, shortcut: event.target.value ? Number(event.target.value) : undefined })}><option value="">None</option>{[1, 2, 3, 4, 5, 6, 7, 8, 9].map((slot) => {
            const owner = quickActions.find((item) => item.shortcut === slot && item.id !== editing.id)
            return <option key={slot} value={slot} disabled={Boolean(owner)}>{slotLabel(slot) ?? `Slot ${slot} (no key assigned)`}{owner ? ` (used by ${owner.name})` : ''}</option>
          })}</select></label>
          <label className="rule-enabled"><input type="checkbox" checked={editing.showInToolbar} onChange={(event) => setEditing({ ...editing, showInToolbar: event.target.checked })} /> Show on the message and selection toolbars</label>
        </div>
        {error && <p className="mail-search-error" role="alert">{error}</p>}
      </div>
      <footer className="modal-footer"><button className="button ghost" disabled={busy} onClick={() => edit(undefined)}>Cancel</button><span className="spacer" /><button className="button primary" disabled={busy || !editing.name.trim()} onClick={() => void save()}><Save size={15} /> {busy ? 'Saving…' : 'Save quick action'}</button></footer>
    </>}
  </Modal>
}
