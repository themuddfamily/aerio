import type {
  MailBuiltInCategory,
  MailCategoryId,
  MailCategoryRuleInput,
  MailCategorySource,
  MailInboxTab,
  MailInboxTabsConfig
} from '../mail-category-types'

export const MAIL_BUILT_IN_CATEGORIES: readonly MailBuiltInCategory[] = ['primary', 'social', 'promotions', 'updates', 'forums']
export const MAIL_CATEGORY_NAMES: Record<MailBuiltInCategory, string> = {
  primary: 'Primary', social: 'Social', promotions: 'Promotions', updates: 'Updates', forums: 'Forums'
}
export const MAX_CUSTOM_INBOX_TABS = 10
export const MAX_INBOX_TAB_NAME = 40

export const isBuiltInCategory = (value: unknown): value is MailBuiltInCategory =>
  typeof value === 'string' && (MAIL_BUILT_IN_CATEGORIES as readonly string[]).includes(value)

const CUSTOM_ID = /^custom:[a-z0-9-]{1,64}$/
export const isMailCategoryId = (value: unknown): value is MailCategoryId =>
  isBuiltInCategory(value) || (typeof value === 'string' && CUSTOM_ID.test(value))

/** Gmail's defaults: Primary, Social, Promotions, and Updates on; Forums off until enabled. */
export function defaultInboxTabs(): MailInboxTabsConfig {
  return {
    tabs: MAIL_BUILT_IN_CATEGORIES.map((id) => ({ id, name: MAIL_CATEGORY_NAMES[id], enabled: id !== 'forums', builtIn: true }))
  }
}

/**
 * Validates and repairs a tab configuration: every built-in tab is present
 * exactly once (missing ones are appended disabled), Primary stays enabled,
 * names are trimmed (blank names fall back to the default), and custom tabs
 * are capped. Throws only for input that is not a tab list at all.
 */
export function normalizeInboxTabs(value: unknown): MailInboxTabsConfig {
  const tabs = value && typeof value === 'object' && Array.isArray((value as MailInboxTabsConfig).tabs) ? (value as MailInboxTabsConfig).tabs : undefined
  if (!tabs || tabs.length > MAIL_BUILT_IN_CATEGORIES.length + MAX_CUSTOM_INBOX_TABS * 2) throw new Error('The inbox tabs are invalid')
  const seen = new Set<string>()
  const result: MailInboxTab[] = []
  let custom = 0
  for (const tab of tabs) {
    if (!tab || typeof tab !== 'object' || !isMailCategoryId(tab.id) || seen.has(tab.id)) continue
    const builtIn = isBuiltInCategory(tab.id)
    if (!builtIn && ++custom > MAX_CUSTOM_INBOX_TABS) throw new Error(`Use at most ${MAX_CUSTOM_INBOX_TABS} custom tabs`)
    const name = typeof tab.name === 'string' ? tab.name.trim().slice(0, MAX_INBOX_TAB_NAME) : ''
    if (!builtIn && !name) throw new Error('Give every custom tab a name')
    seen.add(tab.id)
    result.push({
      id: tab.id,
      name: name || MAIL_CATEGORY_NAMES[tab.id as MailBuiltInCategory],
      enabled: tab.id === 'primary' ? true : tab.enabled !== false,
      builtIn
    })
  }
  for (const id of MAIL_BUILT_IN_CATEGORIES) {
    if (!seen.has(id)) result.push({ id, name: MAIL_CATEGORY_NAMES[id], enabled: id === 'primary', builtIn: true })
  }
  return { tabs: result }
}

export const enabledInboxTabs = (config: MailInboxTabsConfig) => config.tabs.filter((tab) => tab.enabled)

/** The tab bar is shown only when at least one tab besides Primary is enabled. */
export const inboxTabsActive = (config: MailInboxTabsConfig | undefined) =>
  Boolean(config?.tabs.some((tab) => tab.enabled && tab.id !== 'primary'))

/** Conversations whose category tab is disabled (or was removed) are shown in Primary. */
export function visibleInboxTab(category: string | undefined, config: MailInboxTabsConfig): MailCategoryId {
  const tab = config.tabs.find((item) => item.id === category)
  return tab?.enabled ? tab.id : 'primary'
}

// ------------------------------------------------------------ Precedence

export interface MailCategoryEvidence {
  /** Manual reassignment or a mail rule's action, stored per conversation. */
  override?: { category: string; source: 'manual' | 'mail-rule' }
  addressRule?: string
  domainRule?: string
  provider?: string
  heuristic?: string
}

/**
 * Precedence: manual reassignment > mail-rule action > sender address rule >
 * sender domain rule > provider category > local heuristic > Primary.
 */
export function resolveMailCategory(evidence: MailCategoryEvidence): { category: MailCategoryId; source: MailCategorySource } {
  const pick = (value: string | undefined) => isMailCategoryId(value) ? value : undefined
  const override = pick(evidence.override?.category)
  if (override) return { category: override, source: evidence.override!.source }
  const rule = pick(evidence.addressRule) ?? pick(evidence.domainRule)
  if (rule) return { category: rule, source: 'sender-rule' }
  const provider = pick(evidence.provider)
  if (provider) return { category: provider, source: 'provider' }
  const heuristic = pick(evidence.heuristic)
  if (heuristic) return { category: heuristic, source: 'heuristic' }
  return { category: 'primary', source: 'default' }
}

// --------------------------------------------------------- Provider maps

export const GMAIL_CATEGORY_LABELS: Record<MailBuiltInCategory, string> = {
  primary: 'CATEGORY_PERSONAL', social: 'CATEGORY_SOCIAL', promotions: 'CATEGORY_PROMOTIONS', updates: 'CATEGORY_UPDATES', forums: 'CATEGORY_FORUMS'
}
/** Synthetic labels Aerio records for Outlook's inferenceClassification on Inbox messages. */
export const MICROSOFT_FOCUSED_LABEL = 'INFERENCE_FOCUSED'
export const MICROSOFT_OTHER_LABEL = 'INFERENCE_OTHER'
export const isMicrosoftInferenceLabel = (label: string) => label === MICROSOFT_FOCUSED_LABEL || label === MICROSOFT_OTHER_LABEL

const GMAIL_ORDER: MailBuiltInCategory[] = ['social', 'promotions', 'updates', 'forums', 'primary']

/**
 * Maps provider metadata to a category. Gmail CATEGORY_* labels map one to one
 * (CATEGORY_PERSONAL is Primary). Outlook Focused maps to Primary; Outlook
 * Other has no finer meaning, so it takes the local heuristic's category when
 * that is not Primary and Updates otherwise.
 */
export function providerMailCategory(labelIds: Iterable<string>, heuristic: MailBuiltInCategory = 'primary'): MailBuiltInCategory | undefined {
  const labels = new Set(labelIds)
  for (const category of GMAIL_ORDER) if (labels.has(GMAIL_CATEGORY_LABELS[category])) return category
  if (labels.has(MICROSOFT_OTHER_LABEL)) return heuristic !== 'primary' ? heuristic : 'updates'
  if (labels.has(MICROSOFT_FOCUSED_LABEL)) return 'primary'
  return undefined
}

/** Labels to add and remove on Gmail so its category matches a reassignment. */
export function gmailCategoryLabelChange(category: MailBuiltInCategory) {
  const add = GMAIL_CATEGORY_LABELS[category]
  return { add, remove: Object.values(GMAIL_CATEGORY_LABELS).filter((label) => label !== add) }
}

/** Outlook only knows Focused (Primary) and Other (everything else). */
export const microsoftInferenceFor = (category: MailBuiltInCategory) => category === 'primary' ? 'focused' : 'other'

// ------------------------------------------------------ Local heuristic

const SOCIAL_DOMAINS = [
  'facebookmail.com', 'facebook.com', 'linkedin.com', 'twitter.com', 'x.com', 'instagram.com', 'pinterest.com', 'tiktok.com',
  'snapchat.com', 'reddit.com', 'redditmail.com', 'nextdoor.com', 'meetup.com', 'discord.com', 'tumblr.com', 'quora.com', 'strava.com', 'mastodon.social'
]
const UPDATE_DOMAINS = [
  'github.com', 'gitlab.com', 'bitbucket.org', 'atlassian.net', 'atlassian.com', 'slack.com', 'notion.so', 'asana.com', 'trello.com', 'zoom.us',
  'accounts.google.com', 'calendar-notification.google.com', 'paypal.com', 'stripe.com', 'ups.com', 'fedex.com', 'dhl.com', 'usps.com'
]
const FORUM_DOMAINS = ['googlegroups.com', 'groups.io', 'discoursemail.com', 'freelists.org', 'lists.sourceforge.net']
const BULK_SENDER_DOMAINS = ['mcsv.net', 'mcdlv.net', 'mailchimpapp.net', 'rsgsv.net', 'sendgrid.net', 'klaviyomail.com', 'hubspotemail.net', 'exacttarget.com', 'cmail19.com', 'cmail20.com', 'sailthru.com']
const NOTIFICATION_LOCAL_PART = /^(no-?reply|do-?not-?reply|notifications?|notify|alerts?|updates?|account(s)?|security|billing|invoices?|receipts?|orders?|shipping|statements?|calendar|mailer-daemon|postmaster)([+._-].*)?$/i
const SOCIAL_LOCAL_PART = /^(friends?|invitations?|messages-noreply)$/i

const domainMatches = (domain: string, list: readonly string[]) => list.some((entry) => domain === entry || domain.endsWith(`.${entry}`))

export const senderDomain = (email: string) => {
  const at = email.lastIndexOf('@')
  return at >= 0 ? email.slice(at + 1).trim().toLowerCase() : ''
}

export interface MailCategoryHeuristicInput {
  fromEmail: string
  /** Lower-case header name to values; missing for messages without parsed headers. */
  headers?: Record<string, string[]>
}

/**
 * Aerio's local classifier for accounts whose provider has no categories
 * (IMAP, Local Folders) and as the fallback for Gmail and Outlook. In order:
 * known social networks; known notification services and automatic
 * notifications (Auto-Submitted, no-reply senders); discussion lists
 * (List-Id with List-Post, or known list hosts); bulk mail (List-Unsubscribe,
 * Precedence: bulk/list, List-Id, or bulk-sending services) as Promotions;
 * everything else Primary.
 */
export function classifyMailHeuristically(input: MailCategoryHeuristicInput): MailBuiltInCategory {
  const email = input.fromEmail.trim().toLowerCase()
  const domain = senderDomain(email)
  const local = email.slice(0, Math.max(0, email.lastIndexOf('@')))
  const header = (name: string) => input.headers?.[name]?.map((value) => value.trim()).filter(Boolean) ?? []
  if (domain && domainMatches(domain, SOCIAL_DOMAINS)) return 'social'
  if (SOCIAL_LOCAL_PART.test(local) && domain) return 'social'
  if (domain && domainMatches(domain, UPDATE_DOMAINS)) return 'updates'
  const autoSubmitted = header('auto-submitted').some((value) => !/^no\b/i.test(value))
  const listId = header('list-id')
  const listPost = header('list-post').some((value) => !/^no\b/i.test(value))
  if (listId.length && listPost) return 'forums'
  if ((domain && domainMatches(domain, FORUM_DOMAINS)) || listId.some((value) => domainMatches(value.replace(/^.*<|>.*$/g, '').toLowerCase(), FORUM_DOMAINS))) return 'forums'
  const precedence = header('precedence').map((value) => value.toLowerCase())
  const bulk = header('list-unsubscribe').length > 0 || precedence.some((value) => value === 'bulk' || value === 'list' || value === 'junk')
    || listId.length > 0 || (Boolean(domain) && domainMatches(domain, BULK_SENDER_DOMAINS))
  if (autoSubmitted || (NOTIFICATION_LOCAL_PART.test(local) && !header('list-unsubscribe').length)) return 'updates'
  if (bulk) return 'promotions'
  return 'primary'
}

/** Header names the heuristic reads; the mail worker passes only these. */
export const MAIL_CATEGORY_HEADERS = ['list-unsubscribe', 'list-id', 'list-post', 'precedence', 'auto-submitted'] as const

// ----------------------------------------------------- Rule validation

const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/
const ADDRESS = /^[^\s@<>"]{1,64}@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/

/** Normalizes a rule pattern: addresses and domains are lower-case, a leading "@" on a domain is dropped. */
export function normalizeCategoryRulePattern(kind: unknown, pattern: unknown) {
  if (typeof pattern !== 'string') return undefined
  const value = pattern.trim().toLowerCase()
  if (kind === 'address') return ADDRESS.test(value) ? value : undefined
  if (kind === 'domain') {
    const domain = value.replace(/^@/, '').replace(/^\*\./, '')
    return DOMAIN.test(domain) ? domain : undefined
  }
  return undefined
}

export function validateCategoryRuleInput(input: unknown): MailCategoryRuleInput {
  const value = input as Partial<MailCategoryRuleInput> | undefined
  if (!value || typeof value !== 'object') throw new Error('The classification rule is invalid')
  if (value.id !== undefined && (typeof value.id !== 'string' || !value.id || value.id.length > 200)) throw new Error('The classification rule id is invalid')
  if (value.kind !== 'address' && value.kind !== 'domain') throw new Error('Choose a sender address or domain rule')
  const pattern = normalizeCategoryRulePattern(value.kind, value.pattern)
  if (!pattern) throw new Error(value.kind === 'address' ? 'Enter a complete sender address' : 'Enter a domain such as example.com')
  if (!isMailCategoryId(value.category)) throw new Error('Choose an inbox tab')
  return { ...(value.id ? { id: value.id } : {}), kind: value.kind, pattern, category: value.category }
}

// --------------------------------------------------- Keyboard helpers

/**
 * Tab-list keys (roving tabindex): Left/Right move with wrap-around, Home and
 * End jump to the ends. Returns the index to focus, or undefined to ignore.
 */
export function inboxTabKeyTarget(key: string, index: number, count: number): number | undefined {
  if (count <= 0) return undefined
  if (key === 'ArrowRight') return (index + 1) % count
  if (key === 'ArrowLeft') return (index - 1 + count) % count
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return undefined
}

/**
 * Global inbox-tab shortcut, outside text fields: Alt+Right / Alt+Left select
 * the next or previous tab, Alt+1 to Alt+9 select a tab by position.
 */
export function inboxTabShortcutTarget(event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'key' | 'code'>, index: number, count: number): number | undefined {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || count <= 0) return undefined
  if (event.key === 'ArrowRight') return (index + 1) % count
  if (event.key === 'ArrowLeft') return (index - 1 + count) % count
  const digit = /^(?:Digit|Numpad)([1-9])$/.exec(event.code)
  if (digit && Number(digit[1]) <= count) return Number(digit[1]) - 1
  return undefined
}

export const MAIL_CATEGORY_SOURCE_LABELS: Record<MailCategorySource, string> = {
  manual: 'Moved by you',
  'mail-rule': 'Set by a mail rule',
  'sender-rule': 'Sender or domain rule',
  provider: 'Provider category',
  heuristic: 'Aerio classification',
  default: 'Default'
}
