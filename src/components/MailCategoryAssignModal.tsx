import { useState } from 'react'
import type { MailAccountSummary, MailThreadSummary } from '../mail-types'
import type { MailCategoryId, MailCategoryRuleKind, MailInboxTabsConfig } from '../mail-category-types'
import { MAIL_CATEGORY_SOURCE_LABELS, isBuiltInCategory, senderDomain } from '../lib/mail-categories'
import { threadIdsByAccount } from '../lib/mail-pins'
import Modal from './Modal'

interface MailCategoryAssignModalProps {
  items: MailThreadSummary[]
  config: MailInboxTabsConfig
  accounts: MailAccountSummary[]
  onClose(): void
  onDone(message: string): void
  onError(message: string): void
}

const AUTOMATIC = 'automatic'

/**
 * Moves conversations to another inbox tab. "Always do this" also saves a
 * sender or domain rule so future mail from that sender lands in the tab.
 */
export default function MailCategoryAssignModal({ items, config, accounts, onClose, onDone, onError }: MailCategoryAssignModalProps) {
  const first = items[0]
  const current = items.every((item) => item.category === first?.category) ? first?.category : undefined
  const [choice, setChoice] = useState<string>(current ?? 'primary')
  const [remember, setRemember] = useState<'none' | MailCategoryRuleKind>('none')
  const [busy, setBusy] = useState(false)
  const sender = first?.senderEmail?.trim().toLowerCase() ?? ''
  const domain = senderDomain(sender)
  const sameSender = items.every((item) => item.senderEmail?.trim().toLowerCase() === sender) && sender.includes('@')
  const sameDomain = items.every((item) => senderDomain(item.senderEmail ?? '') === domain) && Boolean(domain)
  const providers = new Set(items.map((item) => accounts.find((account) => account.id === item.accountId)?.provider))
  const synced = choice !== AUTOMATIC && isBuiltInCategory(choice) && (providers.has('gmail') || providers.has('microsoft'))

  const apply = async () => {
    const api = window.aerio.mail.categories
    if (!api || !items.length) return
    setBusy(true)
    try {
      const category = choice === AUTOMATIC ? undefined : choice as MailCategoryId
      let rememberNext = remember === 'none' || !category ? undefined : remember
      let providerOperations = 0
      let pattern: string | undefined
      for (const [accountId, threadIds] of threadIdsByAccount(items)) {
        const result = await api.assign({ accountId, threadIds, ...(category ? { category } : {}), ...(rememberNext ? { remember: rememberNext } : {}) })
        providerOperations += result.providerOperations
        pattern ??= result.rule?.pattern
        // The rule is global, so it is created once.
        rememberNext = undefined
      }
      const name = config.tabs.find((tab) => tab.id === category)?.name
      onDone(category
        ? `Moved to ${name ?? 'another tab'}${pattern ? `; future mail from ${remember === 'domain' ? `anyone at ${pattern}` : pattern} goes there too` : ''}${providerOperations ? ' and updated on the server' : ''}`
        : 'Returned to automatic classification')
      onClose()
    } catch (error) {
      onError(error instanceof Error ? error.message : 'The conversation could not be moved')
    } finally {
      setBusy(false)
    }
  }

  return <Modal title="Move to inbox tab" subtitle={`${items.length.toLocaleString()} conversation${items.length === 1 ? '' : 's'}${first?.categorySource && items.length === 1 ? ` · now: ${MAIL_CATEGORY_SOURCE_LABELS[first.categorySource]}` : ''}`} width="small" onClose={onClose}>
    <fieldset className="inbox-category-choices">
      <legend>Tab</legend>
      {config.tabs.map((tab) => <label key={tab.id} className="radio-row">
        <input type="radio" name="inbox-category" value={tab.id} checked={choice === tab.id} onChange={() => setChoice(tab.id)} />
        <span>{tab.name}{!tab.enabled && <small> (tab hidden — shows in Primary)</small>}</span>
      </label>)}
      <label className="radio-row">
        <input type="radio" name="inbox-category" value={AUTOMATIC} checked={choice === AUTOMATIC} onChange={() => { setChoice(AUTOMATIC); setRemember('none') }} />
        <span>Automatic<small> — let rules, the provider, and Aerio decide</small></span>
      </label>
    </fieldset>
    {choice !== AUTOMATIC && (sameSender || sameDomain) && <fieldset className="inbox-category-choices">
      <legend>Always do this</legend>
      <label className="radio-row"><input type="radio" name="inbox-category-remember" checked={remember === 'none'} onChange={() => setRemember('none')} /><span>Only these conversations</span></label>
      {sameSender && <label className="radio-row"><input type="radio" name="inbox-category-remember" checked={remember === 'address'} onChange={() => setRemember('address')} /><span>Always for mail from this sender{items.length === 1 ? ` (${sender})` : ''}</span></label>}
      {sameDomain && <label className="radio-row"><input type="radio" name="inbox-category-remember" checked={remember === 'domain'} onChange={() => setRemember('domain')} /><span>Always for mail from this sender’s domain ({domain})</span></label>}
    </fieldset>}
    {synced && <p className="muted-copy">Gmail and Outlook accounts also update the category on the server (Gmail category labels; Outlook Focused or Other).</p>}
    <footer className="modal-footer"><span className="spacer" /><button className="button ghost" disabled={busy} onClick={onClose}>Cancel</button><button className="button primary" disabled={busy} onClick={() => void apply()}>Move</button></footer>
  </Modal>
}
