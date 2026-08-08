import { Filter, Pencil, Play, Plus, Save, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { MailAccountSummary, MailLabel, MailRule, MailRuleAction, MailRuleCondition, MailRuleInput } from '../mail-types'
import Modal from './Modal'

interface MailRulesModalProps {
  accounts: MailAccountSummary[]
  labels: MailLabel[]
  onToast(message: string): void
  onClose(): void
}

const newCondition = (): MailRuleCondition => ({ field: 'from', operator: 'contains', value: '' })
const newAction = (): MailRuleAction => ({ action: 'archive' })

export default function MailRulesModal({ accounts, labels, onToast, onClose }: MailRulesModalProps) {
  const writableAccounts = accounts.filter((account) => !account.archived)
  const [rules, setRules] = useState<MailRule[]>([])
  const [editing, setEditing] = useState<MailRuleInput>()
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)

  const load = async () => {
    try {
      setRules(await window.aerio.mail.rules.list())
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Rules could not be loaded')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  const destinations = useMemo(() => labels.filter((label) => label.accountId === editing?.accountId && !/draft|sent|outbox/i.test(label.name)), [editing?.accountId, labels])
  const beginNew = () => setEditing({ accountId: writableAccounts[0]?.id ?? '', name: '', enabled: true, match: 'all', conditions: [newCondition()], actions: [newAction()] })
  const updateCondition = (index: number, updates: Partial<MailRuleCondition>) => setEditing((current) => current && ({ ...current, conditions: current.conditions.map((condition, itemIndex) => itemIndex === index ? { ...condition, ...updates } : condition) }))
  const updateAction = (index: number, updates: Partial<MailRuleAction>) => setEditing((current) => current && ({ ...current, actions: current.actions.map((action, itemIndex) => itemIndex === index ? { ...action, ...updates } : action) }))

  const save = async () => {
    if (!editing) return
    setBusy(true)
    try {
      const saved = await window.aerio.mail.rules.save(editing)
      setRules((current) => [...current.filter((rule) => rule.id !== saved.id), saved].sort((left, right) => left.name.localeCompare(right.name)))
      setEditing(undefined)
      onToast('Rule saved')
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Rule could not be saved')
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (rule: MailRule) => {
    try {
      const saved = await window.aerio.mail.rules.save({ ...rule, enabled: !rule.enabled })
      setRules((current) => current.map((item) => item.id === saved.id ? saved : item))
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Rule could not be updated')
    }
  }

  const remove = async (rule: MailRule) => {
    if (!window.confirm(`Delete the rule “${rule.name}”?`)) return
    try {
      await window.aerio.mail.rules.delete(rule.id)
      setRules((current) => current.filter((item) => item.id !== rule.id))
      onToast('Rule deleted')
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Rule could not be deleted')
    }
  }

  const run = async (rule: MailRule) => {
    setBusy(true)
    try {
      const result = await window.aerio.mail.rules.run(rule.id)
      await load()
      onToast(result.matched ? `Rule applied to ${result.matched.toLocaleString()} conversation${result.matched === 1 ? '' : 's'}` : 'No existing Inbox conversations matched')
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Rule could not be run')
    } finally {
      setBusy(false)
    }
  }

  return <Modal title="Mail rules" subtitle="Automatically organize new messages on this computer" width="large" onClose={onClose}>
    {!editing ? <>
      <div className="mail-rules-list">
        {loading && <p className="rules-empty">Loading rules…</p>}
        {!loading && !rules.length && <div className="rules-empty"><Filter size={26} /><strong>No rules yet</strong><span>Create a rule using the sender, recipients, subject, or message body.</span></div>}
        {rules.map((rule) => <article key={rule.id} className={!rule.enabled ? 'disabled' : ''}>
          <label className="rule-toggle"><input type="checkbox" checked={rule.enabled} onChange={() => void toggle(rule)} /><span /></label>
          <span className="rule-copy"><strong>{rule.name}</strong><small>{accounts.find((account) => account.id === rule.accountId)?.email ?? 'Missing account'} · {rule.conditions.length} condition{rule.conditions.length === 1 ? '' : 's'} · {rule.actions.length} action{rule.actions.length === 1 ? '' : 's'}</small><small>{rule.matchCount ? `Matched ${rule.matchCount.toLocaleString()} time${rule.matchCount === 1 ? '' : 's'}` : 'Not matched yet'}</small></span>
          <button className="icon-button" title="Run on existing Inbox" disabled={busy || !rule.enabled} onClick={() => void run(rule)}><Play size={15} /></button>
          <button className="icon-button" title="Edit rule" onClick={() => setEditing({ ...rule })}><Pencil size={15} /></button>
          <button className="icon-button danger" title="Delete rule" onClick={() => void remove(rule)}><Trash2 size={15} /></button>
        </article>)}
      </div>
      <footer className="modal-footer"><button className="button ghost" onClick={onClose}>Close</button><span className="spacer" /><button className="button primary" disabled={!writableAccounts.length} onClick={beginNew}><Plus size={15} /> New rule</button></footer>
    </> : <>
      <div className="mail-rule-editor">
        <div className="rule-grid">
          <label className="field"><span>Rule name</span><input autoFocus value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} placeholder="e.g. Project updates" /></label>
          <label className="field"><span>Account</span><select value={editing.accountId} disabled={Boolean(editing.id)} onChange={(event) => setEditing({ ...editing, accountId: event.target.value })}>{writableAccounts.map((account) => <option key={account.id} value={account.id}>{account.email}</option>)}</select></label>
        </div>
        <section><header><span><strong>When a message matches</strong><small>Use {editing.match === 'all' ? 'every' : 'at least one'} condition</small></span><select value={editing.match} onChange={(event) => setEditing({ ...editing, match: event.target.value as 'all' | 'any' })}><option value="all">All conditions</option><option value="any">Any condition</option></select></header>
          {editing.conditions.map((condition, index) => <div className="rule-row" key={index}><select aria-label={`Condition ${index + 1} field`} value={condition.field} onChange={(event) => updateCondition(index, { field: event.target.value as MailRuleCondition['field'] })}><option value="from">From</option><option value="to">To or Cc</option><option value="subject">Subject</option><option value="body">Message body</option></select><select aria-label={`Condition ${index + 1} comparison`} value={condition.operator} onChange={(event) => updateCondition(index, { operator: event.target.value as MailRuleCondition['operator'] })}><option value="contains">contains</option><option value="equals">equals</option><option value="starts-with">starts with</option><option value="ends-with">ends with</option></select><input aria-label={`Condition ${index + 1} value`} value={condition.value} onChange={(event) => updateCondition(index, { value: event.target.value })} placeholder="Text to match" /><button className="icon-button" aria-label={`Remove condition ${index + 1}`} disabled={editing.conditions.length === 1} onClick={() => setEditing({ ...editing, conditions: editing.conditions.filter((_, itemIndex) => itemIndex !== index) })}><X size={14} /></button></div>)}
          <button className="text-button rule-add" disabled={editing.conditions.length >= 10} onClick={() => setEditing({ ...editing, conditions: [...editing.conditions, newCondition()] })}><Plus size={14} /> Add condition</button>
        </section>
        <section><header><span><strong>Then do this</strong><small>Actions run in the order shown</small></span></header>
          {editing.actions.map((action, index) => <div className="rule-row action" key={index}><select aria-label={`Action ${index + 1}`} value={action.action} onChange={(event) => updateAction(index, { action: event.target.value as MailRuleAction['action'], labelId: undefined })}><option value="archive">Archive</option><option value="read">Mark as read</option><option value="star">Add star</option><option value="important">Mark important</option><option value="trash">Move to Trash</option><option value="label">Apply label</option><option value="move">Move to folder or label</option></select>{(action.action === 'label' || action.action === 'move') && <select aria-label={`Action ${index + 1} destination`} value={action.labelId ?? ''} onChange={(event) => updateAction(index, { labelId: event.target.value })}><option value="">Choose destination…</option>{destinations.map((label) => <option key={label.id} value={label.id}>{label.name}</option>)}</select>}<span className="spacer" /><button className="icon-button" aria-label={`Remove action ${index + 1}`} disabled={editing.actions.length === 1} onClick={() => setEditing({ ...editing, actions: editing.actions.filter((_, itemIndex) => itemIndex !== index) })}><X size={14} /></button></div>)}
          <button className="text-button rule-add" disabled={editing.actions.length >= 10} onClick={() => setEditing({ ...editing, actions: [...editing.actions, newAction()] })}><Plus size={14} /> Add action</button>
        </section>
        <label className="rule-enabled"><input type="checkbox" checked={editing.enabled} onChange={(event) => setEditing({ ...editing, enabled: event.target.checked })} /> Enable this rule for new mail</label>
      </div>
      <footer className="modal-footer"><button className="button ghost" disabled={busy} onClick={() => setEditing(undefined)}>Cancel</button><span className="spacer" /><button className="button primary" disabled={busy} onClick={() => void save()}><Save size={15} /> {busy ? 'Saving…' : 'Save rule'}</button></footer>
    </>}
  </Modal>
}
