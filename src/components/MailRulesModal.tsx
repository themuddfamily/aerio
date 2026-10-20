import { ArrowLeft, Cloud, CloudOff, Filter, Pencil, Play, Plus, RefreshCw, Save, Server, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { MailAccountSummary, MailLabel, MailRule, MailRuleAction, MailRuleCondition, MailRuleInput } from '../mail-types'
import type { MailServerRule, MailServerRuleCapabilities } from '../mail-server-rule-types'
import { MAIL_RULE_FIELDS, defaultMailRuleCondition, mailRuleField } from '../lib/mail-rules'
import { mapMailRuleToServer } from '../lib/mail-server-rules'
import { MAIL_RULE_PRESETS, createMailRuleFromPreset } from '../lib/mail-rule-library'
import { defaultInboxTabs } from '../lib/mail-categories'
import type { MailInboxTab } from '../mail-category-types'
import Modal from './Modal'

interface MailRulesModalProps {
  accounts: MailAccountSummary[]
  labels: MailLabel[]
  onToast(message: string): void
  onClose(): void
  initialRule?: MailRuleInput
}

const newCondition = (): MailRuleCondition => ({ field: 'from', operator: 'contains', value: '' })
const newAction = (): MailRuleAction => ({ action: 'archive' })
const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback

const OPERATOR_LABELS: Record<MailRuleCondition['operator'], string> = {
  contains: 'contains', equals: 'equals', 'starts-with': 'starts with', 'ends-with': 'ends with', is: 'is', 'greater-than': 'more than', 'less-than': 'less than'
}
const AGE_OPERATOR_LABELS: Partial<Record<MailRuleCondition['operator'], string>> = { 'greater-than': 'older than', 'less-than': 'newer than' }
const ruleFolderLabel = (rule: MailRuleInput) => rule.trigger === 'periodic'
  ? ({ inbox: 'Inbox', archive: 'Archive', sent: 'Sent', all: 'All mail' })[rule.schedule?.folder ?? 'inbox']
  : rule.trigger === 'outgoing' ? 'Sent' : rule.trigger === 'archive' ? 'Archive' : 'Inbox'

// Changing the field keeps the comparison and value only when they still make sense.
function changeConditionField(condition: MailRuleCondition, field: MailRuleCondition['field']): MailRuleCondition {
  const next = mailRuleField(field)
  const previous = mailRuleField(condition.field)
  if (!next) return condition
  if (next.value === previous?.value && next.operators.includes(condition.operator)) {
    const { headerName, ...rest } = condition
    return field === 'header' ? { ...rest, field, headerName: headerName ?? '' } : { ...rest, field }
  }
  return defaultMailRuleCondition(field)
}

function ConditionRow({ condition, index, kind, destinations, categories, onChange, onRemove, removable }: {
  condition: MailRuleCondition
  index: number
  kind: 'Condition' | 'Exception'
  destinations: MailLabel[]
  categories: MailInboxTab[]
  onChange(condition: MailRuleCondition): void
  onRemove(): void
  removable: boolean
}) {
  const definition = mailRuleField(condition.field) ?? MAIL_RULE_FIELDS[0]
  const name = `${kind} ${index + 1}`
  const value = (() => {
    const update = (next: string) => onChange({ ...condition, value: next })
    if (definition.value === 'yes-no') return <select aria-label={`${name} value`} value={condition.value} onChange={(event) => update(event.target.value)}><option value="yes">Yes</option><option value="no">No</option></select>
    if (definition.value === 'importance') return <select aria-label={`${name} value`} value={condition.value} onChange={(event) => update(event.target.value)}><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option></select>
    if (definition.value === 'category') return <select aria-label={`${name} value`} value={condition.value} onChange={(event) => update(event.target.value)}>{categories.map((tab) => <option key={tab.id} value={tab.id}>{tab.name}</option>)}</select>
    if (definition.value === 'label') return <select aria-label={`${name} value`} value={condition.value} onChange={(event) => update(event.target.value)}><option value="">Choose folder or label…</option>{destinations.map((label) => <option key={label.id} value={label.id}>{label.name}</option>)}</select>
    if (definition.value === 'kilobytes' || definition.value === 'days') return <input aria-label={`${name} value`} type="number" min="0" step="1" value={condition.value} onChange={(event) => update(event.target.value)} placeholder={definition.value === 'days' ? 'Days' : 'Kilobytes'} />
    return <input aria-label={`${name} value`} value={condition.value} onChange={(event) => update(event.target.value)} placeholder="Text to match" />
  })()
  return <div className="rule-row">
    <select aria-label={`${name} field`} value={condition.field} onChange={(event) => onChange(changeConditionField(condition, event.target.value as MailRuleCondition['field']))}>{MAIL_RULE_FIELDS.map((field) => <option key={field.field} value={field.field}>{field.label}</option>)}</select>
    <select aria-label={`${name} comparison`} value={condition.operator} onChange={(event) => onChange({ ...condition, operator: event.target.value as MailRuleCondition['operator'] })}>{definition.operators.map((operator) => <option key={operator} value={operator}>{(definition.value === 'days' ? AGE_OPERATOR_LABELS[operator] : undefined) ?? OPERATOR_LABELS[operator]}</option>)}</select>
    {condition.field === 'header'
      ? <span className="rule-value"><input aria-label={`${name} header name`} value={condition.headerName ?? ''} onChange={(event) => onChange({ ...condition, headerName: event.target.value })} placeholder="Header, e.g. List-Id" />{value}</span>
      : value}
    <button className="icon-button" aria-label={`Remove ${kind.toLowerCase()} ${index + 1}`} disabled={!removable} onClick={onRemove}><X size={14} /></button>
  </div>
}

export default function MailRulesModal({ accounts, labels, onToast, onClose, initialRule }: MailRulesModalProps) {
  const writableAccounts = accounts.filter((account) => !account.archived)
  const serverApi = window.aerio?.mail?.serverRules
  const [rules, setRules] = useState<MailRule[]>([])
  const [editing, setEditing] = useState<MailRuleInput | undefined>(initialRule)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [presetGuidance, setPresetGuidance] = useState<string>()
  const [capabilities, setCapabilities] = useState<Record<string, MailServerRuleCapabilities>>({})
  const [serverView, setServerView] = useState<{ accountId: string; rules?: MailServerRule[]; error?: string } | undefined>()
  const [categories, setCategories] = useState<MailInboxTab[]>(() => defaultInboxTabs().tabs)

  useEffect(() => {
    let active = true
    void window.aerio?.mail?.categories?.tabs().then((config) => { if (active) setCategories(config.tabs) }).catch(() => undefined)
    return () => { active = false }
  }, [])

  const load = async () => {
    try {
      setRules(await window.aerio.mail.rules.list())
    } catch (error) {
      onToast(errorMessage(error, 'Rules could not be loaded'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  const serverAccounts = writableAccounts.filter((account) => account.provider === 'gmail' || account.provider === 'microsoft')
  const serverAccountKey = serverAccounts.map((account) => account.id).join(',')
  useEffect(() => {
    if (!serverApi) return
    let active = true
    void Promise.all(serverAccounts.map(async (account) => [account.id, await serverApi.capabilities(account.id)] as const))
      .then((entries) => { if (active) setCapabilities(Object.fromEntries(entries)) })
      .catch(() => undefined)
    return () => { active = false }
  }, [serverAccountKey])

  const accountFor = (accountId?: string) => accounts.find((account) => account.id === accountId)
  const destinations = useMemo(() => labels.filter((label) => label.accountId === editing?.accountId && !/draft|sent|outbox/i.test(label.name)), [editing?.accountId, labels])
  const conditionLabels = useMemo(() => labels.filter((label) => label.accountId === editing?.accountId), [editing?.accountId, labels])
  const beginNew = () => {
    setPresetGuidance(undefined)
    setEditing({ accountId: writableAccounts[0]?.id ?? '', name: '', enabled: true, match: 'all', trigger: 'incoming', conditions: [newCondition()], exceptions: [], actions: [newAction()] })
  }
  const updateCondition = (index: number, condition: MailRuleCondition) => setEditing((current) => current && ({ ...current, conditions: current.conditions.map((item, itemIndex) => itemIndex === index ? condition : item) }))
  const updateException = (index: number, condition: MailRuleCondition) => setEditing((current) => current && ({ ...current, exceptions: (current.exceptions ?? []).map((item, itemIndex) => itemIndex === index ? condition : item) }))
  const updateAction = (index: number, updates: Partial<MailRuleAction>) => setEditing((current) => current && ({ ...current, actions: current.actions.map((action, itemIndex) => itemIndex === index ? { ...action, ...updates } : action) }))
  const editingProvider = accountFor(editing?.accountId)?.provider
  const serverMapping = editing && serverApi && capabilities[editing.accountId]?.supported ? mapMailRuleToServer(editing, editingProvider) : undefined

  const replaceRule = (saved: MailRule) => setRules((current) => [...current.filter((rule) => rule.id !== saved.id), saved].sort((left, right) => left.name.localeCompare(right.name)))

  // Offers a reconnect when the provider's settings permission is missing.
  const offerReconnect = async (accountId: string, reason?: string) => {
    if (!window.confirm(`${reason ?? 'Aerio needs permission to manage this account’s server rules.'}\n\nReconnect now?`)) return
    try {
      await window.aerio.mail.accounts.reconnect(accountId)
      const updated = await serverApi?.capabilities(accountId)
      if (updated) setCapabilities((current) => ({ ...current, [accountId]: updated }))
      onToast('Account reconnected')
    } catch (error) {
      onToast(errorMessage(error, 'The account could not be reconnected'))
    }
  }

  const save = async () => {
    if (!editing) return
    setBusy(true)
    try {
      const saved = await window.aerio.mail.rules.save(editing)
      replaceRule(saved)
      setEditing(undefined)
      if (saved.execution === 'server' && serverApi) {
        // The provider runs this rule, so keep its server copy in step.
        try {
          replaceRule((await serverApi.upload(saved.id)).rule)
          onToast('Rule saved and updated on the server')
        } catch (error) {
          onToast(`Rule saved, but the server copy was not updated: ${errorMessage(error, 'unknown error')}`)
        }
      } else onToast('Rule saved')
    } catch (error) {
      onToast(errorMessage(error, 'Rule could not be saved'))
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (rule: MailRule) => {
    try {
      if (rule.execution === 'server' && rule.serverRuleId && serverApi) {
        if (accountFor(rule.accountId)?.provider === 'gmail') {
          onToast('Gmail filters can’t be turned off. Remove the server copy under Server rules instead.')
          return
        }
        await serverApi.setEnabled(rule.accountId, rule.serverRuleId, !rule.enabled)
        await load()
        return
      }
      const saved = await window.aerio.mail.rules.save({ ...rule, enabled: !rule.enabled })
      setRules((current) => current.map((item) => item.id === saved.id ? saved : item))
    } catch (error) {
      onToast(errorMessage(error, 'Rule could not be updated'))
    }
  }

  const remove = async (rule: MailRule) => {
    const serverNote = rule.execution === 'server' ? ' Its server copy keeps running until you remove it under Server rules.' : ''
    if (!window.confirm(`Delete the rule “${rule.name}”?${serverNote}`)) return
    try {
      await window.aerio.mail.rules.delete(rule.id)
      setRules((current) => current.filter((item) => item.id !== rule.id))
      onToast('Rule deleted')
    } catch (error) {
      onToast(errorMessage(error, 'Rule could not be deleted'))
    }
  }

  const run = async (rule: MailRule) => {
    setBusy(true)
    try {
      const result = await window.aerio.mail.rules.run(rule.id)
      await load()
      const folder = ruleFolderLabel(rule)
      onToast(result.matched ? `Rule applied to ${result.matched.toLocaleString()} conversation${result.matched === 1 ? '' : 's'}` : `No existing ${folder} conversations matched`)
    } catch (error) {
      onToast(errorMessage(error, 'Rule could not be run'))
    } finally {
      setBusy(false)
    }
  }

  const upload = async (rule: MailRule) => {
    if (!serverApi) return
    const capability = capabilities[rule.accountId]
    if (capability?.permission === 'missing') return void offerReconnect(rule.accountId, capability.reason)
    const mapping = mapMailRuleToServer(rule, accountFor(rule.accountId)?.provider)
    const blocking = mapping.issues.filter((issue) => issue.level === 'unsupported')
    if (blocking.length) return onToast(`This rule can’t run on the server: ${blocking.map((issue) => issue.message).join('; ')}`)
    const caveats = mapping.issues.map((issue) => `• ${issue.message}`).join('\n')
    const prompt = `Run “${rule.name}” on the server? The provider will apply it even when Aerio is closed, and Aerio will stop running it on this computer.${caveats ? `\n\nDifferences on the server:\n${caveats}` : ''}`
    if (!window.confirm(prompt)) return
    setBusy(true)
    try {
      replaceRule((await serverApi.upload(rule.id)).rule)
      onToast('Rule now runs on the server')
    } catch (error) {
      if (error instanceof Error && /Reconnect/.test(error.message)) void offerReconnect(rule.accountId, error.message)
      else onToast(errorMessage(error, 'Rule could not be uploaded'))
    } finally {
      setBusy(false)
    }
  }

  const openServerRules = async (accountId: string) => {
    if (!serverApi || !accountId) return
    setServerView({ accountId })
    const capability = capabilities[accountId] ?? await serverApi.capabilities(accountId).catch(() => undefined)
    if (capability) setCapabilities((current) => ({ ...current, [accountId]: capability }))
    if (capability && capability.permission !== 'granted') return setServerView({ accountId, error: capability.reason })
    try {
      setServerView({ accountId, rules: await serverApi.list(accountId) })
    } catch (error) {
      setServerView({ accountId, error: errorMessage(error, 'Server rules could not be loaded') })
    }
  }

  const deleteServerRule = async (rule: MailServerRule) => {
    if (!serverApi) return
    const linked = rule.linkedRuleId ? ' The matching Aerio rule is kept, turned off, to run on this computer if you turn it back on.' : ''
    if (!window.confirm(`Remove “${rule.name}” from the server?${linked}`)) return
    try {
      await serverApi.delete(rule.accountId, rule.id)
      await load()
      await openServerRules(rule.accountId)
      onToast('Server rule removed')
    } catch (error) {
      onToast(errorMessage(error, 'Server rule could not be removed'))
    }
  }

  const toggleServerRule = async (rule: MailServerRule) => {
    if (!serverApi) return
    try {
      const updated = await serverApi.setEnabled(rule.accountId, rule.id, !rule.enabled)
      setServerView((current) => current && ({ ...current, rules: current.rules?.map((item) => item.id === updated.id ? { ...item, enabled: updated.enabled } : item) }))
      await load()
    } catch (error) {
      onToast(errorMessage(error, 'Server rule could not be updated'))
    }
  }

  const ruleSummary = (rule: MailRule) => [
    accountFor(rule.accountId)?.email ?? 'Missing account',
    `${rule.conditions.length} condition${rule.conditions.length === 1 ? '' : 's'}`,
    ...(rule.exceptions?.length ? [`${rule.exceptions.length} exception${rule.exceptions.length === 1 ? '' : 's'}`] : []),
    `${rule.actions.length} action${rule.actions.length === 1 ? '' : 's'}`,
    ...(rule.trigger === 'outgoing' ? ['Sent mail'] : []),
    ...(rule.trigger === 'archive' ? ['When archiving'] : []),
    ...(rule.trigger === 'periodic' ? [`Every ${rule.schedule?.intervalMinutes ?? 60} minutes · ${ruleFolderLabel(rule)}`, ...(rule.nextRunAt ? [`Next: ${new Date(rule.nextRunAt).toLocaleString()}`] : [])] : []),
    ...(rule.execution === 'server' ? ['Runs on server'] : [])
  ].join(' · ')

  if (libraryOpen) return <Modal title="Rule library" subtitle="Choose a starter, then edit it before saving" width="large" onClose={onClose}>
    <div className="mail-rules-list">
      <p>Starters open as disabled drafts. Review the conditions and actions, choose any destinations, and enable the rule when ready.</p>
      {MAIL_RULE_PRESETS.map((preset) => <article key={preset.id}>
        <span className="rule-copy"><strong>{preset.name}</strong><small>{preset.description}</small></span>
        <button className="button ghost" disabled={!writableAccounts.length} aria-label={`Use ${preset.name}`} onClick={() => {
          const accountId = writableAccounts[0]?.id
          if (!accountId) return
          setEditing(createMailRuleFromPreset(preset.id, accountId))
          setPresetGuidance(preset.guidance)
          setLibraryOpen(false)
        }}>Use starter</button>
      </article>)}
    </div>
    <footer className="modal-footer"><button className="button ghost" onClick={() => setLibraryOpen(false)}><ArrowLeft size={15} /> Back to rules</button></footer>
  </Modal>

  if (serverView) {
    const capability = capabilities[serverView.accountId]
    return <Modal title="Server rules" subtitle="Rules stored with your provider run even when Aerio is closed" width="large" onClose={onClose}>
      <div className="mail-rules-list">
        <label className="field"><span>Account</span><select aria-label="Server rules account" value={serverView.accountId} onChange={(event) => void openServerRules(event.target.value)}>{serverAccounts.map((account) => <option key={account.id} value={account.id}>{account.email}</option>)}</select></label>
        {serverView.error && <div className="rules-empty"><CloudOff size={26} /><strong>Server rules aren’t available</strong><span>{serverView.error}</span>
          {capability?.permission === 'missing' && <button className="button primary" onClick={() => void offerReconnect(serverView.accountId, capability.reason)}><RefreshCw size={15} /> Reconnect account</button>}</div>}
        {!serverView.error && !serverView.rules && <p className="rules-empty">Loading server rules…</p>}
        {serverView.rules && !serverView.rules.length && <div className="rules-empty"><Server size={26} /><strong>No server rules</strong><span>Use the cloud button on an Aerio rule to run it on the server.</span></div>}
        {serverView.rules?.map((rule) => <article key={rule.id} className={!rule.enabled ? 'disabled' : ''}>
          {capability?.canDisable && <label className="rule-toggle" title={rule.enabled ? 'Turn off on the server' : 'Turn on on the server'}><input type="checkbox" aria-label={`Server rule ${rule.name} on`} checked={rule.enabled} onChange={() => void toggleServerRule(rule)} /><span /></label>}
          <span className="rule-copy"><strong>{rule.name}{rule.linkedRuleId ? ' · from Aerio' : ''}</strong>
            <small>{rule.conditions.join(' · ') || 'All messages'}</small>
            {rule.exceptions.length > 0 && <small>Except: {rule.exceptions.join(' · ')}</small>}
            <small>{rule.actions.join(' · ') || 'No actions'}</small></span>
          <button className="icon-button danger" title="Remove from server" onClick={() => void deleteServerRule(rule)}><Trash2 size={15} /></button>
        </article>)}
      </div>
      <footer className="modal-footer"><button className="button ghost" onClick={() => setServerView(undefined)}><ArrowLeft size={15} /> Back to rules</button><span className="spacer" /><button className="button ghost" onClick={onClose}>Close</button></footer>
    </Modal>
  }

  return <Modal title="Mail rules" subtitle="Automatically organize new messages on this computer or on the server" width="large" onClose={onClose}>
    {!editing ? <>
      <div className="mail-rules-list">
        {loading && <p className="rules-empty">Loading rules…</p>}
        {!loading && !rules.length && <div className="rules-empty"><Filter size={26} /><strong>No rules yet</strong><span>Create a rule using the sender, recipients, subject, or message body.</span></div>}
        {rules.map((rule) => <article key={rule.id} className={!rule.enabled ? 'disabled' : ''}>
          <label className="rule-toggle"><input type="checkbox" checked={rule.enabled} onChange={() => void toggle(rule)} /><span /></label>
          <span className="rule-copy"><strong>{rule.name}</strong><small>{ruleSummary(rule)}</small><small>{rule.matchCount ? `Matched ${rule.matchCount.toLocaleString()} time${rule.matchCount === 1 ? '' : 's'}` : 'Not matched yet'}</small></span>
          <button className="icon-button" title={`Run on existing ${ruleFolderLabel(rule)}${rule.trigger === 'outgoing' ? ' mail' : ''}`} disabled={busy || !rule.enabled} onClick={() => void run(rule)}><Play size={15} /></button>
          {capabilities[rule.accountId]?.supported && <button className="icon-button" title={rule.execution === 'server' ? 'Update the server copy' : 'Run on the server'} disabled={busy} onClick={() => void upload(rule)}><Cloud size={15} /></button>}
          <button className="icon-button" title="Edit rule" onClick={() => { setPresetGuidance(undefined); setEditing({ ...rule }) }}><Pencil size={15} /></button>
          <button className="icon-button danger" title="Delete rule" onClick={() => void remove(rule)}><Trash2 size={15} /></button>
        </article>)}
      </div>
      <footer className="modal-footer"><button className="button ghost" onClick={onClose}>Close</button><span className="spacer" />
        {serverApi && serverAccounts.length > 0 && <button className="button ghost" onClick={() => void openServerRules(serverAccounts[0].id)}><Server size={15} /> Server rules</button>}
        <button className="button ghost" disabled={!writableAccounts.length} onClick={() => setLibraryOpen(true)}>Rule library</button>
        <button className="button primary" disabled={!writableAccounts.length} onClick={beginNew}><Plus size={15} /> New rule</button></footer>
    </> : <>
      <div className="mail-rule-editor">
        {presetGuidance && <p role="note">{presetGuidance}</p>}
        <div className="rule-grid">
          <label className="field"><span>Rule name</span><input autoFocus value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} placeholder="e.g. Project updates" /></label>
          <label className="field"><span>Account</span><select value={editing.accountId} disabled={Boolean(editing.id)} onChange={(event) => setEditing({ ...editing, accountId: event.target.value })}>{writableAccounts.map((account) => <option key={account.id} value={account.id}>{account.email}</option>)}</select></label>
        </div>
        <label className="field"><span>Apply to</span><select aria-label="Apply to" value={editing.trigger ?? 'incoming'} disabled={editing.execution === 'server'} onChange={(event) => setEditing({ ...editing, trigger: event.target.value as MailRuleInput['trigger'], schedule: event.target.value === 'periodic' ? editing.schedule ?? { intervalMinutes: 60, folder: 'inbox' } : undefined })}><option value="incoming">New mail I receive</option><option value="outgoing">Mail I send</option><option value="archive">Mail I archive</option><option value="periodic">Periodically</option></select></label>
        {editing.trigger === 'archive' && <p role="note">Runs when you use Archive in Aerio. Matches the newest message before archiving. Automatic archiving, snoozing, other clients, and rule actions do not trigger it.</p>}
        {editing.trigger === 'periodic' && <section aria-label="Rule schedule">
          <div className="rule-grid">
            <label className="field"><span>Every (minutes)</span><input aria-label="Rule interval in minutes" type="number" min="1" max="10080" step="1" value={editing.schedule?.intervalMinutes ?? 60} onChange={(event) => setEditing({ ...editing, schedule: { folder: editing.schedule?.folder ?? 'inbox', intervalMinutes: Number(event.target.value) } })} /></label>
            <label className="field"><span>Evaluate in</span><select aria-label="Scheduled rule folder" value={editing.schedule?.folder ?? 'inbox'} onChange={(event) => setEditing({ ...editing, schedule: { intervalMinutes: editing.schedule?.intervalMinutes ?? 60, folder: event.target.value as NonNullable<MailRuleInput['schedule']>['folder'] } })}><option value="inbox">Inbox</option><option value="archive">Archive</option><option value="sent">Sent</option><option value="all">All mail except Trash, Spam and Drafts</option></select></label>
          </div>
          <p role="note">Runs while Aerio is open, including offline. The first run is after one interval; missed runs are evaluated once when Aerio reopens. Run on existing mail starts a manual pass immediately.</p>
        </section>}
        <section><header><span><strong>When a message matches</strong><small>Use {editing.match === 'all' ? 'every' : 'at least one'} condition</small></span><select value={editing.match} onChange={(event) => setEditing({ ...editing, match: event.target.value as 'all' | 'any' })}><option value="all">All conditions</option><option value="any">Any condition</option></select></header>
          {editing.conditions.map((condition, index) => <ConditionRow key={index} kind="Condition" index={index} condition={condition} destinations={conditionLabels} categories={categories} removable={editing.conditions.length > 1}
            onChange={(next) => updateCondition(index, next)} onRemove={() => setEditing({ ...editing, conditions: editing.conditions.filter((_, itemIndex) => itemIndex !== index) })} />)}
          <button className="text-button rule-add" disabled={editing.conditions.length >= 10} onClick={() => setEditing({ ...editing, conditions: [...editing.conditions, newCondition()] })}><Plus size={14} /> Add condition</button>
        </section>
        <section><header><span><strong>Except if</strong><small>Skip the rule when any of these match</small></span></header>
          {(editing.exceptions ?? []).map((condition, index) => <ConditionRow key={index} kind="Exception" index={index} condition={condition} destinations={conditionLabels} categories={categories} removable
            onChange={(next) => updateException(index, next)} onRemove={() => setEditing({ ...editing, exceptions: (editing.exceptions ?? []).filter((_, itemIndex) => itemIndex !== index) })} />)}
          <button className="text-button rule-add" disabled={(editing.exceptions ?? []).length >= 10} onClick={() => setEditing({ ...editing, exceptions: [...(editing.exceptions ?? []), newCondition()] })}><Plus size={14} /> Add exception</button>
        </section>
        <section><header><span><strong>Then do this</strong><small>Actions run in the order shown</small></span></header>
          {editing.actions.map((action, index) => <div className="rule-row action" key={index}><select aria-label={`Action ${index + 1}`} value={action.action} onChange={(event) => { const next = event.target.value as MailRuleAction['action']; updateAction(index, { action: next, labelId: undefined, category: next === 'set-category' ? 'primary' : undefined }) }}><option value="archive">Archive</option><option value="read">Mark as read</option><option value="star">Add star</option><option value="important">Mark important</option><option value="trash">Move to Trash</option><option value="label">Apply label</option><option value="move">Move to folder or label</option><option value="set-category">Set inbox category</option></select>{action.action === 'set-category' && <select aria-label={`Action ${index + 1} inbox category`} value={action.category ?? 'primary'} onChange={(event) => updateAction(index, { category: event.target.value })}>{categories.map((tab) => <option key={tab.id} value={tab.id}>{tab.name}</option>)}</select>}{(action.action === 'label' || action.action === 'move') && <select aria-label={`Action ${index + 1} destination`} value={action.labelId ?? ''} onChange={(event) => updateAction(index, { labelId: event.target.value })}><option value="">Choose destination…</option>{destinations.map((label) => <option key={label.id} value={label.id}>{label.name}</option>)}</select>}<span className="spacer" /><button className="icon-button" aria-label={`Remove action ${index + 1}`} disabled={editing.actions.length === 1} onClick={() => setEditing({ ...editing, actions: editing.actions.filter((_, itemIndex) => itemIndex !== index) })}><X size={14} /></button></div>)}
          <button className="text-button rule-add" disabled={editing.actions.length >= 10} onClick={() => setEditing({ ...editing, actions: [...editing.actions, newAction()] })}><Plus size={14} /> Add action</button>
        </section>
        {serverMapping && <section className="rule-server" aria-label="Server compatibility"><header><span><strong>{editing.execution === 'server' ? 'Runs on the server' : 'Server compatibility'}</strong>
          <small>{editing.execution === 'server' ? 'Saving updates the provider’s copy; Aerio doesn’t also run it here' : serverMapping.supported ? 'This rule can also run on the server' : 'This rule can only run on this computer'}</small></span></header>
          {serverMapping.issues.length > 0 && <ul>{serverMapping.issues.map((issue, index) => <li key={index} className={issue.level}>{issue.part === 'rule' ? '' : `${issue.part[0].toUpperCase()}${issue.part.slice(1)} ${(issue.index ?? 0) + 1}: `}{issue.message}</li>)}</ul>}
        </section>}
        <label className="rule-enabled"><input type="checkbox" checked={editing.enabled} onChange={(event) => setEditing({ ...editing, enabled: event.target.checked })} /> Enable this rule for new mail</label>
      </div>
      <footer className="modal-footer"><button className="button ghost" disabled={busy} onClick={() => setEditing(undefined)}>Cancel</button><span className="spacer" /><button className="button primary" disabled={busy} onClick={() => void save()}><Save size={15} /> {busy ? 'Saving…' : 'Save rule'}</button></footer>
    </>}
  </Modal>
}
