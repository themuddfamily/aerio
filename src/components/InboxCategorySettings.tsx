import { ArrowDown, ArrowUp, Inbox, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { MailCategoryId, MailCategoryRule, MailCategoryRuleKind, MailInboxTab, MailInboxTabsConfig } from '../mail-category-types'
import { MAX_CUSTOM_INBOX_TABS, MAX_INBOX_TAB_NAME, normalizeCategoryRulePattern } from '../lib/mail-categories'

const errorText = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback

/**
 * Settings → Inbox tabs: enable, rename, reorder, add, and remove tabs, and
 * edit the sender/domain classification rules. Saved in the mail database.
 */
export default function InboxCategorySettings() {
  const api = window.aerio.mail?.categories
  const [config, setConfig] = useState<MailInboxTabsConfig>()
  const [saved, setSaved] = useState<string>('')
  const [rules, setRules] = useState<MailCategoryRule[]>([])
  const [message, setMessage] = useState('')
  const [draft, setDraft] = useState<{ kind: MailCategoryRuleKind; pattern: string; category: MailCategoryId }>({ kind: 'domain', pattern: '', category: 'promotions' })

  const load = useCallback(async () => {
    if (!api) return
    try {
      const [tabs, list] = await Promise.all([api.tabs(), api.rules()])
      setConfig(tabs)
      setSaved(JSON.stringify(tabs))
      setRules(list)
    } catch (error) {
      setMessage(errorText(error, 'Inbox tab settings could not be loaded'))
    }
  }, [api])

  useEffect(() => { void load() }, [load])

  if (!api) return null

  const updateTab = (id: string, updates: Partial<MailInboxTab>) => setConfig((current) => current && { tabs: current.tabs.map((tab) => tab.id === id ? { ...tab, ...updates } : tab) })
  const move = (index: number, offset: number) => setConfig((current) => {
    if (!current) return current
    const tabs = [...current.tabs]
    const target = index + offset
    if (target < 0 || target >= tabs.length) return current
    ;[tabs[index], tabs[target]] = [tabs[target], tabs[index]]
    return { tabs }
  })
  const customCount = config?.tabs.filter((tab) => !tab.builtIn).length ?? 0
  const addTab = () => setConfig((current) => current && { tabs: [...current.tabs, { id: `custom:${crypto.randomUUID().slice(0, 8)}` as MailCategoryId, name: 'New tab', enabled: true, builtIn: false }] })
  const removeTab = (id: string) => setConfig((current) => current && { tabs: current.tabs.filter((tab) => tab.id !== id) })

  const saveTabs = async () => {
    if (!config) return
    try {
      const next = await api.saveTabs(config)
      setConfig(next)
      setSaved(JSON.stringify(next))
      setMessage('Inbox tabs saved')
    } catch (error) {
      setMessage(errorText(error, 'Inbox tabs could not be saved'))
    }
  }

  const saveRule = async (input: { id?: string; kind: MailCategoryRuleKind; pattern: string; category: MailCategoryId }) => {
    try {
      const rule = await api.saveRule(input)
      setRules((current) => [...current.filter((item) => item.id !== rule.id && !(item.kind === rule.kind && item.pattern === rule.pattern)), rule].sort((left, right) => left.kind.localeCompare(right.kind) || left.pattern.localeCompare(right.pattern)))
      setMessage(`Mail from ${rule.kind === 'domain' ? `anyone at ${rule.pattern}` : rule.pattern} goes to ${config?.tabs.find((tab) => tab.id === rule.category)?.name ?? 'that tab'}`)
      return true
    } catch (error) {
      setMessage(errorText(error, 'The classification rule could not be saved'))
      return false
    }
  }

  const deleteRule = async (rule: MailCategoryRule) => {
    try {
      await api.deleteRule(rule.id)
      setRules((current) => current.filter((item) => item.id !== rule.id))
      setMessage('Classification rule removed')
    } catch (error) {
      setMessage(errorText(error, 'The classification rule could not be removed'))
    }
  }

  const tabOptions = config?.tabs ?? []
  const draftValid = Boolean(normalizeCategoryRulePattern(draft.kind, draft.pattern))

  return <section className="settings-section inbox-category-settings">
    <div className="settings-icon"><Inbox size={18} /></div>
    <div className="settings-content">
      <h3>Inbox tabs</h3>
      <p>Split the Inbox into Primary, Social, Promotions, Updates, Forums, and your own tabs. Mail in a turned-off tab shows in Primary. Gmail and Outlook categories are used where available; other accounts are classified on this computer.</p>
      {!config ? <small>{message || 'Reading inbox tabs…'}</small> : <>
        <ol className="inbox-tab-editor" aria-label="Inbox tabs">
          {config.tabs.map((tab, index) => <li key={tab.id}>
            <input type="checkbox" aria-label={`Show ${tab.name}`} checked={tab.enabled} disabled={tab.id === 'primary'} onChange={(event) => updateTab(tab.id, { enabled: event.target.checked })} />
            <input aria-label={`Name of ${tab.builtIn ? tab.id : 'custom'} tab`} value={tab.name} maxLength={MAX_INBOX_TAB_NAME} onChange={(event) => updateTab(tab.id, { name: event.target.value })} />
            <button className="icon-button" aria-label={`Move ${tab.name} earlier`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={14} /></button>
            <button className="icon-button" aria-label={`Move ${tab.name} later`} disabled={index === config.tabs.length - 1} onClick={() => move(index, 1)}><ArrowDown size={14} /></button>
            {!tab.builtIn && <button className="icon-button" aria-label={`Remove ${tab.name}`} onClick={() => removeTab(tab.id)}><Trash2 size={14} /></button>}
          </li>)}
        </ol>
        <div className="settings-actions">
          <button className="button ghost small" disabled={customCount >= MAX_CUSTOM_INBOX_TABS} onClick={addTab}><Plus size={14} /> Add tab</button>
          <button className="button primary small" disabled={JSON.stringify(config) === saved} onClick={() => void saveTabs()}>Save tabs</button>
        </div>
        <h4>Sender and domain rules</h4>
        <p>Rules beat Gmail and Outlook categories and Aerio’s own classification; moving a single conversation by hand beats rules.</p>
        {rules.length === 0 ? <small>No rules yet. Use “Move to tab” on a conversation and choose “Always”, or add one here.</small> : <ul className="inbox-rule-list" aria-label="Classification rules">
          {rules.map((rule) => <li key={rule.id}>
            <span>{rule.kind === 'domain' ? `Anyone at ${rule.pattern}` : rule.pattern}</span>
            <select aria-label={`Tab for ${rule.pattern}`} value={rule.category} onChange={(event) => void saveRule({ id: rule.id, kind: rule.kind, pattern: rule.pattern, category: event.target.value as MailCategoryId })}>
              {!tabOptions.some((tab) => tab.id === rule.category) && <option value={rule.category}>Removed tab</option>}
              {tabOptions.map((tab) => <option key={tab.id} value={tab.id}>{tab.name}</option>)}
            </select>
            <button className="icon-button" aria-label={`Remove rule for ${rule.pattern}`} onClick={() => void deleteRule(rule)}><Trash2 size={14} /></button>
          </li>)}
        </ul>}
        <div className="inbox-rule-add">
          <select aria-label="Rule type" value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as MailCategoryRuleKind })}><option value="domain">Domain</option><option value="address">Sender address</option></select>
          <input aria-label="Sender address or domain" value={draft.pattern} placeholder={draft.kind === 'domain' ? 'example.com' : 'news@example.com'} onChange={(event) => setDraft({ ...draft, pattern: event.target.value })} />
          <select aria-label="Tab for new rule" value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value as MailCategoryId })}>{tabOptions.map((tab) => <option key={tab.id} value={tab.id}>{tab.name}</option>)}</select>
          <button className="button ghost small" disabled={!draftValid} onClick={() => void saveRule(draft).then((ok) => { if (ok) setDraft({ ...draft, pattern: '' }) })}><Plus size={14} /> Add rule</button>
        </div>
        {message && <small role="status">{message}</small>}
      </>}
    </div>
  </section>
}
