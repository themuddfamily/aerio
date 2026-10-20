import type { MailServerRuleIssue, MailServerRuleMapping } from '../mail-server-rule-types'
import type { MailLabel, MailProviderId, MailRuleAction, MailRuleCondition, MailRuleConditionField, MailRuleInput } from '../mail-types'
import { mailRuleTrigger } from './mail-rules'
import { GMAIL_CATEGORY_LABELS, isBuiltInCategory } from './mail-categories'

// Translating local rules to provider rules. Local rules can express more
// than either provider, so every condition, exception, and action is checked
// and anything that can't be represented is reported instead of silently
// dropped. "approximate" mappings upload with a visible caveat; any
// "unsupported" issue blocks the upload.

export interface GmailFilterResource {
  id?: string
  criteria?: {
    from?: string
    to?: string
    subject?: string
    query?: string
    negatedQuery?: string
    hasAttachment?: boolean
    excludeChats?: boolean
    size?: number
    sizeComparison?: 'larger' | 'smaller' | 'unspecified'
  }
  action?: { addLabelIds?: string[]; removeLabelIds?: string[]; forward?: string }
}

interface GraphRecipient { emailAddress: { address: string; name?: string } }

export interface MicrosoftRulePredicates {
  senderContains?: string[]
  fromAddresses?: GraphRecipient[]
  recipientContains?: string[]
  sentToAddresses?: GraphRecipient[]
  subjectContains?: string[]
  bodyContains?: string[]
  bodyOrSubjectContains?: string[]
  headerContains?: string[]
  hasAttachments?: boolean
  importance?: 'low' | 'normal' | 'high'
  withinSizeRange?: { minimumSize: number; maximumSize: number }
  [key: string]: unknown
}

export interface MicrosoftRuleActions {
  moveToFolder?: string
  copyToFolder?: string
  markAsRead?: boolean
  markImportance?: 'low' | 'normal' | 'high'
  delete?: boolean
  permanentDelete?: boolean
  assignCategories?: string[]
  forwardTo?: GraphRecipient[]
  redirectTo?: GraphRecipient[]
  forwardAsAttachmentTo?: GraphRecipient[]
  stopProcessingRules?: boolean
  [key: string]: unknown
}

export interface MicrosoftMessageRuleResource {
  id?: string
  displayName: string
  sequence?: number
  isEnabled: boolean
  hasError?: boolean
  isReadOnly?: boolean
  conditions?: MicrosoftRulePredicates
  exceptions?: MicrosoftRulePredicates
  actions?: MicrosoftRuleActions
}

/** Graph well-known folder that the server-rule service resolves to an id before upload. */
export const MICROSOFT_ARCHIVE_FOLDER = 'well-known:archive'
const MAX_GRAPH_SIZE_KB = 2_147_483_647
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/

const issue = (part: MailServerRuleIssue['part'], level: MailServerRuleIssue['level'], message: string, index?: number): MailServerRuleIssue =>
  ({ part, level, message, ...(index === undefined ? {} : { index }) })

const FIELD_NAMES: Record<MailRuleConditionField, string> = {
  from: 'From', to: 'To or Cc', cc: 'Cc', subject: 'Subject', body: 'Message body', header: 'Header',
  'has-attachment': 'Has attachments', size: 'Size', age: 'Age', importance: 'Importance', label: 'Folder or label', category: 'Inbox category'
}

const ACTION_NAMES: Record<MailRuleAction['action'], string> = {
  archive: 'Archive', read: 'Mark as read', star: 'Add star', important: 'Mark important', trash: 'Move to Trash', label: 'Apply label', move: 'Move', 'set-category': 'Set inbox category'
}

// ---------------------------------------------------------------- Gmail

const gmailTerm = (value: string) => {
  const cleaned = value.trim().replaceAll('"', '')
  return /^[\p{L}\p{N}@._+-]+$/u.test(cleaned) ? cleaned : `"${cleaned}"`
}

interface GmailConditionTerm { terms: string[]; issue?: Omit<MailServerRuleIssue, 'part' | 'index'> }

function gmailConditionTerms(condition: MailRuleCondition): GmailConditionTerm {
  const value = condition.value.trim()
  const unsupported = (message: string): GmailConditionTerm => ({ terms: [], issue: { level: 'unsupported', message } })
  const approximate = (terms: string[], message: string): GmailConditionTerm => ({ terms, issue: { level: 'approximate', message } })
  const addressTerms = (operator: string) => {
    const prefixes = condition.field === 'to' ? ['to', 'cc'] : [condition.field]
    if (operator === 'contains') return { terms: prefixes.map((prefix) => `${prefix}:${gmailTerm(value)}`) }
    if (operator === 'equals') {
      const terms = prefixes.map((prefix) => `${prefix}:${gmailTerm(value)}`)
      return EMAIL.test(value) ? { terms } : approximate(terms, `${FIELD_NAMES[condition.field]} “equals” a name becomes a Gmail word match`)
    }
    if (operator === 'ends-with' && value.startsWith('@') && value.length > 1) {
      return approximate(prefixes.map((prefix) => `${prefix}:${gmailTerm(value.slice(1))}`), `${FIELD_NAMES[condition.field]} ending with a domain becomes a Gmail domain match`)
    }
    return unsupported(`Gmail filters can't check whether ${FIELD_NAMES[condition.field]} ${operator === 'starts-with' ? 'starts' : 'ends'} with text`)
  }
  switch (condition.field) {
    case 'from':
    case 'to':
    case 'cc':
      return addressTerms(condition.operator)
    case 'subject':
      return condition.operator === 'contains' ? { terms: [`subject:${gmailTerm(value)}`] } : unsupported('Gmail filters can only check whether the subject contains words')
    case 'body':
      return condition.operator === 'contains'
        ? approximate([gmailTerm(value)], 'Gmail searches the whole message for body words, including the subject')
        : unsupported('Gmail filters can only check whether the message contains words')
    case 'header':
      if (condition.headerName?.trim().toLowerCase() === 'list-id' && condition.operator === 'contains') return { terms: [`list:${gmailTerm(value)}`] }
      return unsupported('Gmail filters can only check the List-Id header')
    case 'has-attachment':
      return { terms: [value === 'no' ? '-has:attachment' : 'has:attachment'] }
    case 'size':
      return { terms: [`${condition.operator === 'greater-than' ? 'larger' : 'smaller'}:${Number(value) * 1024}`] }
    case 'importance':
      return value === 'high'
        ? approximate(['is:important'], 'Gmail decides which messages are important itself')
        : unsupported('Gmail filters can only check for important messages')
    case 'age':
      return unsupported('Server rules run when mail arrives, so they can’t check a message’s age')
    case 'label':
      return unsupported('Gmail filters run before a message has labels, so they can’t check one')
    case 'category':
      // Gmail's own categories can be searched; custom tabs only exist in Aerio.
      return isBuiltInCategory(value)
        ? approximate([`category:${value}`], 'Gmail checks its own category, which can differ from Aerio’s sender rules and reassignments')
        : unsupported('Custom inbox tabs only exist in Aerio')
    default:
      return unsupported('This condition has no Gmail filter equivalent')
  }
}

function gmailGroup(terms: string[][], mode: 'all' | 'any') {
  if (mode === 'all') return terms.map((group) => group.length > 1 ? `{${group.join(' ')}}` : group[0]).join(' ')
  const flat = terms.flat()
  return flat.length > 1 ? `{${flat.join(' ')}}` : flat[0] ?? ''
}

function gmailAction(action: MailRuleAction): { add: string[]; remove: string[] } | string {
  if (action.action === 'set-category') return isBuiltInCategory(action.category) ? { add: [GMAIL_CATEGORY_LABELS[action.category]], remove: [] } : 'Custom inbox tabs only exist in Aerio'
  if (action.action === 'archive') return { add: [], remove: ['INBOX'] }
  if (action.action === 'read') return { add: [], remove: ['UNREAD'] }
  if (action.action === 'star') return { add: ['STARRED'], remove: [] }
  if (action.action === 'important') return { add: ['IMPORTANT'], remove: [] }
  if (action.action === 'trash') return { add: ['TRASH'], remove: [] }
  if (!action.labelId || action.labelId.startsWith('folder:')) return 'Choose a Gmail label for this action'
  return action.action === 'move' ? { add: [action.labelId], remove: ['INBOX'] } : { add: [action.labelId], remove: [] }
}

export function gmailFilterForRule(rule: MailRuleInput): { filter?: GmailFilterResource; mapping: MailServerRuleMapping } {
  const issues: MailServerRuleIssue[] = []
  if (mailRuleTrigger(rule) === 'outgoing') issues.push(issue('rule', 'unsupported', 'Gmail filters only run on received mail; keep outgoing rules local'))
  if (mailRuleTrigger(rule) === 'archive') issues.push(issue('rule', 'unsupported', 'Gmail filters cannot run when you archive mail; keep archive rules local'))
  if (mailRuleTrigger(rule) === 'periodic') issues.push(issue('rule', 'unsupported', 'Gmail filters do not support scheduled evaluation; keep periodic rules local'))
  const collect = (conditions: MailRuleCondition[], part: 'condition' | 'exception') => conditions.map((condition, index) => {
    const mapped = gmailConditionTerms(condition)
    if (mapped.issue) issues.push(issue(part, mapped.issue.level, mapped.issue.message, index))
    return mapped.terms
  }).filter((terms) => terms.length)
  const conditionTerms = collect(rule.conditions, 'condition')
  const exceptionTerms = collect(rule.exceptions ?? [], 'exception')
  if ([...rule.conditions, ...(rule.exceptions ?? [])].some((condition) => ['from', 'to', 'cc', 'subject'].includes(condition.field) && condition.operator === 'contains')) {
    issues.push(issue('rule', 'approximate', 'Gmail matches whole words and addresses rather than any part of the text'))
  }
  const add = new Set<string>()
  const remove = new Set<string>()
  rule.actions.forEach((action, index) => {
    const mapped = gmailAction(action)
    if (typeof mapped === 'string') return issues.push(issue('action', 'unsupported', mapped, index))
    mapped.add.forEach((label) => add.add(label))
    mapped.remove.forEach((label) => remove.add(label))
  })
  const query = gmailGroup(conditionTerms, rule.match)
  if (!query) issues.push(issue('rule', 'unsupported', 'At least one condition must be supported by Gmail'))
  const mapping = { provider: 'gmail' as const, supported: !issues.some((item) => item.level === 'unsupported'), issues }
  if (!mapping.supported) return { mapping }
  const negatedQuery = gmailGroup(exceptionTerms, 'any')
  return {
    mapping,
    filter: {
      criteria: { query, ...(negatedQuery ? { negatedQuery } : {}) },
      action: { ...(add.size ? { addLabelIds: [...add] } : {}), ...(remove.size ? { removeLabelIds: [...remove] } : {}) }
    }
  }
}

// ------------------------------------------------------------ Microsoft

type PredicateValue = { key: keyof MicrosoftRulePredicates; values?: unknown[]; scalar?: unknown; size?: { min?: number; max?: number } }
interface MicrosoftConditionPredicate { predicate?: PredicateValue; issue?: Omit<MailServerRuleIssue, 'part' | 'index'> }

function microsoftPredicate(condition: MailRuleCondition): MicrosoftConditionPredicate {
  const value = condition.value.trim()
  const unsupported = (message: string): MicrosoftConditionPredicate => ({ issue: { level: 'unsupported', message } })
  const approximate = (predicate: PredicateValue, message: string): MicrosoftConditionPredicate => ({ predicate, issue: { level: 'approximate', message } })
  const text = (key: keyof MicrosoftRulePredicates, label: string) => condition.operator === 'contains'
    ? { predicate: { key, values: [value] } }
    : unsupported(`Outlook rules can only check whether ${label} contains text`)
  switch (condition.field) {
    case 'from':
      if (condition.operator === 'contains') return { predicate: { key: 'senderContains', values: [value] } }
      if (condition.operator === 'equals') {
        return EMAIL.test(value)
          ? { predicate: { key: 'fromAddresses', values: [{ emailAddress: { address: value } }] } }
          : approximate({ key: 'senderContains', values: [value] }, 'From “equals” a name becomes “sender contains” in Outlook')
      }
      if (condition.operator === 'ends-with' && value.startsWith('@')) return approximate({ key: 'senderContains', values: [value] }, 'From ending with a domain becomes “sender contains” in Outlook')
      return unsupported('Outlook rules can’t check whether the sender starts or ends with text')
    case 'to':
    case 'cc':
      if (condition.operator === 'starts-with' || (condition.operator === 'ends-with' && !value.startsWith('@'))) return unsupported('Outlook rules can’t check whether recipients start or end with text')
      if (condition.field === 'cc') return approximate({ key: 'recipientContains', values: [value] }, 'Outlook checks To and Cc together, so a Cc condition also matches To')
      return condition.operator === 'contains'
        ? { predicate: { key: 'recipientContains', values: [value] } }
        : approximate({ key: 'recipientContains', values: [value] }, 'Recipient “equals” becomes “recipient contains” in Outlook')
    case 'subject': return text('subjectContains', 'the subject')
    case 'body': return text('bodyContains', 'the body')
    case 'header':
      return condition.operator === 'contains'
        ? approximate({ key: 'headerContains', values: [value] }, `Outlook searches every header for this text, not only ${condition.headerName?.trim() || 'the named header'}`)
        : unsupported('Outlook rules can only check whether headers contain text')
    case 'has-attachment':
      return value === 'yes' ? { predicate: { key: 'hasAttachments', scalar: true } } : unsupported('Outlook rules can only check that a message has attachments')
    case 'size': {
      const kilobytes = Number(value)
      return { predicate: { key: 'withinSizeRange', size: condition.operator === 'greater-than' ? { min: kilobytes + 1 } : { max: Math.max(0, kilobytes - 1) } } }
    }
    case 'importance': return { predicate: { key: 'importance', scalar: value } }
    case 'age': return unsupported('Server rules run when mail arrives, so they can’t check a message’s age')
    case 'label': return unsupported('Outlook rules run on the Inbox, so they can’t check another folder')
    case 'category': return unsupported('Outlook rules can’t check Aerio’s inbox category')
    default: return unsupported('This condition has no Outlook rule equivalent')
  }
}

function microsoftPredicates(conditions: MailRuleCondition[], mode: 'all' | 'any', part: 'condition' | 'exception', issues: MailServerRuleIssue[]) {
  const result: MicrosoftRulePredicates = {}
  const mapped = conditions.map((condition, index) => {
    const value = microsoftPredicate(condition)
    if (value.issue) issues.push(issue(part, value.issue.level, value.issue.message, index))
    return { value: value.predicate, index }
  }).filter((item): item is { value: PredicateValue; index: number } => Boolean(item.value))
  // Outlook joins different predicates with AND and several values of one
  // predicate with OR, so "any" only maps when every condition uses one predicate.
  if (mode === 'any' && new Set(mapped.map((item) => item.value.key)).size > 1) {
    issues.push(issue(part === 'condition' ? 'rule' : part, 'unsupported', part === 'condition'
      ? 'Outlook rules combine different kinds of conditions with “all”; use one kind of condition for “any”'
      : 'Outlook may not treat exceptions of different kinds as “any”; use one kind of exception'))
    return result
  }
  for (const { value, index } of mapped) {
    const existing = result[value.key]
    if (value.key === 'withinSizeRange') {
      const range = (existing as MicrosoftRulePredicates['withinSizeRange']) ?? { minimumSize: 0, maximumSize: MAX_GRAPH_SIZE_KB }
      if (mode === 'any' && existing) issues.push(issue(part, 'unsupported', 'Outlook allows a single size range per rule', index))
      result.withinSizeRange = { minimumSize: value.size?.min ?? range.minimumSize, maximumSize: value.size?.max ?? range.maximumSize }
    } else if (value.values) {
      // In "all" mode a repeated predicate would turn AND into OR; exceptions are OR anyway.
      if (existing && mode === 'all' && part === 'condition') issues.push(issue(part, 'unsupported', `Outlook treats several “${FIELD_NAMES[conditions[index].field]}” conditions as “any”; combine them into one rule per value`, index))
      result[value.key] = [...((existing as unknown[] | undefined) ?? []), ...value.values]
    } else {
      if (existing !== undefined && existing !== value.scalar) issues.push(issue(part, 'unsupported', `Outlook allows one “${FIELD_NAMES[conditions[index].field]}” condition per rule`, index))
      result[value.key] = value.scalar
    }
  }
  return result
}

export function microsoftRuleForRule(rule: MailRuleInput): { messageRule?: MicrosoftMessageRuleResource; mapping: MailServerRuleMapping } {
  const issues: MailServerRuleIssue[] = []
  if (mailRuleTrigger(rule) === 'outgoing') issues.push(issue('rule', 'unsupported', 'Outlook rules only run on received mail; keep outgoing rules local'))
  if (mailRuleTrigger(rule) === 'archive') issues.push(issue('rule', 'unsupported', 'Outlook rules cannot run when you archive mail; keep archive rules local'))
  if (mailRuleTrigger(rule) === 'periodic') issues.push(issue('rule', 'unsupported', 'Outlook rules do not support scheduled evaluation; keep periodic rules local'))
  const conditions = microsoftPredicates(rule.conditions, rule.match, 'condition', issues)
  const exceptions = microsoftPredicates(rule.exceptions ?? [], 'any', 'exception', issues)
  if (!Object.keys(conditions).length) issues.push(issue('rule', 'unsupported', 'At least one condition must be supported by Outlook'))
  const actions: MicrosoftRuleActions = {}
  const setMove = (folder: string, index: number) => {
    if (actions.moveToFolder || actions.delete) issues.push(issue('action', 'unsupported', 'Outlook rules can move a message to only one folder', index))
    actions.moveToFolder = folder
  }
  rule.actions.forEach((action, index) => {
    if (action.action === 'archive') setMove(MICROSOFT_ARCHIVE_FOLDER, index)
    else if (action.action === 'read') actions.markAsRead = true
    else if (action.action === 'important') actions.markImportance = 'high'
    else if (action.action === 'trash') {
      if (actions.moveToFolder) issues.push(issue('action', 'unsupported', 'Outlook rules can move a message to only one folder', index))
      actions.delete = true
    } else if (action.action === 'star') issues.push(issue('action', 'unsupported', 'Outlook rules can’t flag messages', index))
    else if (action.action === 'set-category') issues.push(issue('action', 'unsupported', 'Outlook rules can’t set Aerio’s inbox category', index))
    else if (action.labelId?.startsWith('category:')) actions.assignCategories = [...(actions.assignCategories ?? []), action.labelId.slice(9)]
    else if (action.labelId?.startsWith('folder:')) setMove(action.labelId.slice(7), index)
    else issues.push(issue('action', 'unsupported', 'Choose an Outlook folder or category for this action', index))
  })
  const mapping = { provider: 'microsoft' as const, supported: !issues.some((item) => item.level === 'unsupported'), issues }
  if (!mapping.supported) return { mapping }
  return {
    mapping,
    messageRule: {
      displayName: rule.name.trim().slice(0, 255),
      isEnabled: rule.enabled,
      conditions,
      ...(Object.keys(exceptions).length ? { exceptions } : {}),
      actions: { ...actions, stopProcessingRules: false }
    }
  }
}

/** Checks a local rule against the provider's server-rule model. */
export function mapMailRuleToServer(rule: MailRuleInput, provider: MailProviderId | undefined): MailServerRuleMapping {
  if (provider === 'gmail') return gmailFilterForRule(rule).mapping
  if (provider === 'microsoft') return microsoftRuleForRule(rule).mapping
  return {
    provider: provider ?? 'imap',
    supported: false,
    issues: [issue('rule', 'unsupported', 'This account’s server has no rule API that Aerio can manage; the rule runs on this computer')]
  }
}

// ---------------------------------------------------------- Descriptions

export interface ServerRuleDescription { conditions: string[]; exceptions: string[]; actions: string[] }

const labelName = (labels: MailLabel[], id: string) => labels.find((label) => label.id === id || label.id === `folder:${id}`)?.name ?? id
const SYSTEM_LABEL_ACTIONS: Record<string, [add: string, remove: string]> = {
  INBOX: ['Move to Inbox', 'Archive'],
  UNREAD: ['Mark as unread', 'Mark as read'],
  STARRED: ['Add star', 'Remove star'],
  IMPORTANT: ['Mark important', 'Never mark important'],
  TRASH: ['Move to Trash', 'Remove from Trash'],
  SPAM: ['Mark as spam', 'Never send to spam']
}

export function describeGmailFilter(filter: GmailFilterResource, labels: MailLabel[] = []): ServerRuleDescription {
  const criteria = filter.criteria ?? {}
  const conditions = [
    criteria.from && `From: ${criteria.from}`,
    criteria.to && `To: ${criteria.to}`,
    criteria.subject && `Subject: ${criteria.subject}`,
    criteria.query && `Matches: ${criteria.query}`,
    criteria.hasAttachment && 'Has attachments',
    criteria.size && criteria.sizeComparison && criteria.sizeComparison !== 'unspecified' && `Size ${criteria.sizeComparison} than ${Math.round(criteria.size / 1024).toLocaleString()} KB`
  ].filter((value): value is string => Boolean(value))
  const actions = [
    ...(filter.action?.addLabelIds ?? []).map((id) => SYSTEM_LABEL_ACTIONS[id]?.[0] ?? `Apply label ${labelName(labels, id)}`),
    ...(filter.action?.removeLabelIds ?? []).map((id) => SYSTEM_LABEL_ACTIONS[id]?.[1] ?? `Remove label ${labelName(labels, id)}`),
    ...(filter.action?.forward ? [`Forward to ${filter.action.forward}`] : [])
  ]
  return { conditions, exceptions: criteria.negatedQuery ? [`Doesn’t match: ${criteria.negatedQuery}`] : [], actions }
}

const recipients = (value: unknown) => Array.isArray(value)
  ? value.map((item) => (item as GraphRecipient)?.emailAddress?.address).filter(Boolean).join(', ')
  : ''

function describePredicates(predicates: MicrosoftRulePredicates | undefined) {
  const result: string[] = []
  for (const [key, value] of Object.entries(predicates ?? {})) {
    if (value === undefined || value === null || (Array.isArray(value) && !value.length) || value === false) continue
    if (key === 'senderContains') result.push(`Sender contains ${(value as string[]).join(' or ')}`)
    else if (key === 'fromAddresses') result.push(`From ${recipients(value)}`)
    else if (key === 'recipientContains') result.push(`Recipients contain ${(value as string[]).join(' or ')}`)
    else if (key === 'sentToAddresses') result.push(`Sent to ${recipients(value)}`)
    else if (key === 'subjectContains') result.push(`Subject contains ${(value as string[]).join(' or ')}`)
    else if (key === 'bodyContains') result.push(`Body contains ${(value as string[]).join(' or ')}`)
    else if (key === 'bodyOrSubjectContains') result.push(`Subject or body contains ${(value as string[]).join(' or ')}`)
    else if (key === 'headerContains') result.push(`Headers contain ${(value as string[]).join(' or ')}`)
    else if (key === 'hasAttachments') result.push('Has attachments')
    else if (key === 'importance') result.push(`Importance is ${String(value)}`)
    else if (key === 'withinSizeRange') {
      const range = value as { minimumSize?: number; maximumSize?: number }
      result.push(`Size between ${(range.minimumSize ?? 0).toLocaleString()} and ${(range.maximumSize ?? MAX_GRAPH_SIZE_KB).toLocaleString()} KB`)
    } else result.push(`${key.replace(/([A-Z])/g, ' $1').toLowerCase()}${value === true ? '' : `: ${Array.isArray(value) ? recipients(value) || value.join(', ') : String(value)}`}`)
  }
  return result
}

export function describeMicrosoftRule(rule: MicrosoftMessageRuleResource, labels: MailLabel[] = []): ServerRuleDescription {
  const actions: string[] = []
  for (const [key, value] of Object.entries(rule.actions ?? {})) {
    if (value === undefined || value === null || value === false || (Array.isArray(value) && !value.length)) continue
    if (key === 'moveToFolder') actions.push(`Move to ${labelName(labels, String(value))}`)
    else if (key === 'copyToFolder') actions.push(`Copy to ${labelName(labels, String(value))}`)
    else if (key === 'markAsRead') actions.push('Mark as read')
    else if (key === 'markImportance') actions.push(`Mark importance ${String(value)}`)
    else if (key === 'delete') actions.push('Move to Deleted Items')
    else if (key === 'permanentDelete') actions.push('Delete permanently')
    else if (key === 'assignCategories') actions.push(`Categorize as ${(value as string[]).join(', ')}`)
    else if (key === 'forwardTo' || key === 'redirectTo' || key === 'forwardAsAttachmentTo') actions.push(`${key === 'redirectTo' ? 'Redirect' : 'Forward'} to ${recipients(value)}`)
    else if (key === 'stopProcessingRules') actions.push('Stop processing more rules')
    else actions.push(key)
  }
  return { conditions: describePredicates(rule.conditions), exceptions: describePredicates(rule.exceptions), actions }
}

export const mailRuleActionName = (action: MailRuleAction['action']) => ACTION_NAMES[action]
