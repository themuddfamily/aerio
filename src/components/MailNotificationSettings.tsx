import { useEffect, useState } from 'react'
import type { MailAccountSummary } from '../mail-types'
import type { MailInboxTab } from '../mail-category-types'
import type { MailNotificationAction, MailNotificationPreferences } from '../mail-notification-types'
import { defaultInboxTabs } from '../lib/mail-categories'
import { MAIL_NOTIFICATION_ACTIONS, MAIL_NOTIFICATION_ACTION_LABELS, normalizeMailNotifications } from '../lib/mail-notifications'

export default function MailNotificationSettings({ value, onChange }: { value?: MailNotificationPreferences; onChange(value: MailNotificationPreferences): void }) {
  const preferences = normalizeMailNotifications(value)
  const [accounts, setAccounts] = useState<MailAccountSummary[]>([])
  const [categories, setCategories] = useState<MailInboxTab[]>(() => defaultInboxTabs().tabs)
  useEffect(() => {
    let active = true
    void window.aerio?.mail?.accounts?.list().then((items) => { if (active) setAccounts(items.filter((account) => !account.archived)) }).catch(() => undefined)
    void window.aerio?.mail?.categories?.tabs().then((config) => { if (active) setCategories(config.tabs) }).catch(() => undefined)
    return () => { active = false }
  }, [])
  const update = (changes: Partial<MailNotificationPreferences>) => onChange({ ...preferences, ...changes })
  const replaceAction = (index: number, action: MailNotificationAction) => update({ actions: preferences.actions.map((current, currentIndex) => currentIndex === index ? action : current) })
  return <div aria-label="Mail notification details">
    <label className="field"><span>Mail preview</span><select aria-label="Mail notification preview" value={preferences.preview} onChange={(event) => update({ preview: event.target.value as MailNotificationPreferences['preview'] })}><option value="subject">Sender and subject</option><option value="sender">Sender only</option><option value="hidden">Hide sender and subject</option></select></label>
    <label className="toggle-row"><span>Silent new-mail notifications</span><input type="checkbox" checked={preferences.silent} onChange={(event) => update({ silent: event.target.checked })} /></label>
    <label className="toggle-row"><span>Only notify when Aerio is in the background</span><input type="checkbox" checked={preferences.onlyWhenUnfocused} onChange={(event) => update({ onlyWhenUnfocused: event.target.checked })} /></label>
    <label className="toggle-row"><span>Quiet hours for new mail</span><input type="checkbox" checked={preferences.quietHours.enabled} onChange={(event) => update({ quietHours: { ...preferences.quietHours, enabled: event.target.checked } })} /></label>
    {preferences.quietHours.enabled && <div className="rule-grid"><label className="field"><span>Quiet hours start</span><input type="time" value={preferences.quietHours.start} onChange={(event) => update({ quietHours: { ...preferences.quietHours, start: event.target.value } })} /></label><label className="field"><span>Quiet hours end</span><input type="time" value={preferences.quietHours.end} onChange={(event) => update({ quietHours: { ...preferences.quietHours, end: event.target.value } })} /></label></div>}
    <p>Quiet hours use this computer’s local time. Equal start and end times disable the interval. Locking Aerio always hides message details and prevents mail-changing actions.</p>
    <strong>Notification buttons</strong><p>Up to three buttons, in order, for individual conversations on Windows and macOS. Other platforms keep click-to-open notifications.</p>
    {preferences.actions.map((action, index) => <div className="rule-row action" key={index}>
      <select aria-label={`Notification button ${index + 1}`} value={action} onChange={(event) => replaceAction(index, event.target.value as MailNotificationAction)}>{MAIL_NOTIFICATION_ACTIONS.filter((command) => command === action || !preferences.actions.includes(command)).map((command) => <option value={command} key={command}>{MAIL_NOTIFICATION_ACTION_LABELS[command]}</option>)}</select>
      <button className="button ghost" disabled={index === 0} aria-label={`Move notification button ${index + 1} earlier`} onClick={() => { const actions = [...preferences.actions]; [actions[index - 1], actions[index]] = [actions[index], actions[index - 1]]; update({ actions }) }}>Move earlier</button>
      <button className="button ghost" aria-label={`Remove notification button ${index + 1}`} onClick={() => update({ actions: preferences.actions.filter((_, current) => current !== index) })}>Remove</button>
    </div>)}
    <button className="button ghost" disabled={preferences.actions.length >= 3} onClick={() => { const next = MAIL_NOTIFICATION_ACTIONS.find((action) => !preferences.actions.includes(action)); if (next) update({ actions: [...preferences.actions, next] }) }}>Add notification button</button>
    <strong>Categories</strong>
    <label className="toggle-row"><span>Notify for all inbox categories</span><input type="checkbox" checked={preferences.categories === undefined} onChange={(event) => update({ categories: event.target.checked ? undefined : categories.filter((tab) => tab.enabled).map((tab) => tab.id) })} /></label>
    {preferences.categories !== undefined && categories.map((category) => <label className="toggle-row" key={category.id}><span>{category.name}</span><input type="checkbox" checked={preferences.categories!.includes(category.id)} onChange={(event) => update({ categories: event.target.checked ? [...preferences.categories!, category.id] : preferences.categories!.filter((id) => id !== category.id) })} /></label>)}
    {accounts.length > 0 && <><strong>Accounts</strong><p>These switches can mute an account; its own notification setting must also be enabled.</p>{accounts.map((account) => <label className="toggle-row" key={account.id}><span>{account.email}</span><input type="checkbox" aria-label={`Notify for ${account.email}`} checked={preferences.accounts[account.id] !== false && account.notifications} disabled={!account.notifications} onChange={(event) => update({ accounts: { ...preferences.accounts, [account.id]: event.target.checked } })} /></label>)}</>}
  </div>
}
