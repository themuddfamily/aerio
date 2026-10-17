// Inbox category tabs (E33). A conversation's inbox category is Aerio's own
// classification metadata. It is stored apart from message-local tags and from
// Outlook categories (which stay visible labels), and it only splits the Inbox.

/** Built-in tabs; custom tabs use `custom:<id>`. */
export type MailBuiltInCategory = 'primary' | 'social' | 'promotions' | 'updates' | 'forums'
export type MailCategoryId = MailBuiltInCategory | `custom:${string}`

/**
 * Where a conversation's category came from, highest precedence first:
 * a manual reassignment, a mail rule's "Set inbox category" action, a
 * sender/domain classification rule, the provider (Gmail category labels or
 * Outlook Focused/Other), Aerio's local heuristic, or the Primary default.
 */
export type MailCategorySource = 'manual' | 'mail-rule' | 'sender-rule' | 'provider' | 'heuristic' | 'default'

export interface MailInboxTab {
  id: MailCategoryId
  name: string
  enabled: boolean
  builtIn: boolean
}

/** Ordered tab list. Primary is always enabled; mail in a disabled tab shows in Primary. */
export interface MailInboxTabsConfig {
  tabs: MailInboxTab[]
}

export type MailCategoryRuleKind = 'address' | 'domain'

/** A persistent classification rule: an exact sender address, or a domain (and its subdomains), to a category. */
export interface MailCategoryRule {
  id: string
  kind: MailCategoryRuleKind
  /** Lower-case address or domain. */
  pattern: string
  category: MailCategoryId
  createdAt: string
  updatedAt: string
}

export interface MailCategoryRuleInput {
  id?: string
  kind: MailCategoryRuleKind
  pattern: string
  category: MailCategoryId
}

/** Inbox conversations per visible tab (disabled categories are counted in Primary). */
export type MailCategoryCounts = Record<string, { unread: number; total: number }>

export interface MailCategoryAssignInput {
  accountId: string
  threadIds: string[]
  /** Omit to clear the manual reassignment and return to automatic classification. */
  category?: MailCategoryId
  /** Also create a sender or domain rule from the first conversation's sender. */
  remember?: MailCategoryRuleKind
}

export interface MailCategoryAssignResult {
  updated: number
  rule?: MailCategoryRule
  /** Provider changes queued (Gmail category labels or Outlook Focused/Other). */
  providerOperations: number
}

export interface MailCategoriesApi {
  tabs(): Promise<MailInboxTabsConfig>
  saveTabs(config: MailInboxTabsConfig): Promise<MailInboxTabsConfig>
  counts(accountIds?: string[]): Promise<MailCategoryCounts>
  assign(input: MailCategoryAssignInput): Promise<MailCategoryAssignResult>
  rules(): Promise<MailCategoryRule[]>
  saveRule(input: MailCategoryRuleInput): Promise<MailCategoryRule>
  deleteRule(id: string): Promise<void>
}
