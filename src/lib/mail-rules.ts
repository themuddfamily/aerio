import { isMailCategoryId } from './mail-categories'
import type { MailRuleCondition, MailRuleConditionField, MailRuleConditionOperator, MailRuleInput, MailRuleTrigger } from '../mail-types'

export const MAIL_RULE_TEXT_OPERATORS: MailRuleConditionOperator[] = ['contains', 'equals', 'starts-with', 'ends-with']
export const MAIL_RULE_RANGE_OPERATORS: MailRuleConditionOperator[] = ['greater-than', 'less-than']

export interface MailRuleFieldDefinition {
  field: MailRuleConditionField
  label: string
  operators: MailRuleConditionOperator[]
  value: 'text' | 'yes-no' | 'importance' | 'label' | 'kilobytes' | 'days' | 'category'
}

export const MAIL_RULE_FIELDS: MailRuleFieldDefinition[] = [
  { field: 'from', label: 'From', operators: MAIL_RULE_TEXT_OPERATORS, value: 'text' },
  { field: 'to', label: 'To or Cc', operators: MAIL_RULE_TEXT_OPERATORS, value: 'text' },
  { field: 'cc', label: 'Cc', operators: MAIL_RULE_TEXT_OPERATORS, value: 'text' },
  { field: 'subject', label: 'Subject', operators: MAIL_RULE_TEXT_OPERATORS, value: 'text' },
  { field: 'body', label: 'Message body', operators: MAIL_RULE_TEXT_OPERATORS, value: 'text' },
  { field: 'header', label: 'Header', operators: MAIL_RULE_TEXT_OPERATORS, value: 'text' },
  { field: 'has-attachment', label: 'Has attachments', operators: ['is'], value: 'yes-no' },
  { field: 'size', label: 'Size (KB)', operators: MAIL_RULE_RANGE_OPERATORS, value: 'kilobytes' },
  { field: 'age', label: 'Age (days)', operators: MAIL_RULE_RANGE_OPERATORS, value: 'days' },
  { field: 'importance', label: 'Importance', operators: ['is'], value: 'importance' },
  { field: 'label', label: 'Folder or label', operators: ['is'], value: 'label' },
  { field: 'category', label: 'Inbox category', operators: ['is'], value: 'category' }
]

export const mailRuleField = (field: MailRuleConditionField) => MAIL_RULE_FIELDS.find((item) => item.field === field)

/** A fresh condition of the given field with that field's first operator and a usable default value. */
export function defaultMailRuleCondition(field: MailRuleConditionField = 'from'): MailRuleCondition {
  const definition = mailRuleField(field) ?? MAIL_RULE_FIELDS[0]
  const value = definition.value === 'yes-no' ? 'yes' : definition.value === 'importance' ? 'high' : definition.value === 'category' ? 'primary' : ''
  return { field: definition.field, operator: definition.operators[0], value, ...(field === 'header' ? { headerName: '' } : {}) }
}

const HEADER_NAME = /^[!-9;-~]{1,100}$/

/** Returns the reason a condition is incomplete or invalid, or undefined when it can be saved. */
export function mailRuleConditionError(condition: MailRuleCondition | undefined): string | undefined {
  const definition = condition && typeof condition === 'object' ? mailRuleField(condition.field) : undefined
  if (!condition || !definition || !definition.operators.includes(condition.operator)) return 'Finish every rule condition'
  if (typeof condition.value !== 'string' || !condition.value.trim() || condition.value.length > 500) return 'Finish every rule condition'
  if (condition.field === 'header' && (typeof condition.headerName !== 'string' || !HEADER_NAME.test(condition.headerName.trim()))) return 'Enter the header name to check'
  const value = condition.value.trim()
  if (definition.value === 'yes-no' && value !== 'yes' && value !== 'no') return 'Choose yes or no for the attachment condition'
  if (definition.value === 'importance' && !['high', 'normal', 'low'].includes(value)) return 'Choose an importance level'
  if (definition.value === 'category' && !isMailCategoryId(value)) return 'Choose an inbox category'
  if ((definition.value === 'kilobytes' || definition.value === 'days') && (!/^\d{1,9}$/.test(value) || (definition.value === 'days' && Number(value) > 36_500))) {
    return definition.value === 'days' ? 'Enter the age as a whole number of days' : 'Enter the size as a whole number of kilobytes'
  }
  return undefined
}

/** The message fields a rule can read. Optional fields default to "unknown", which never matches. */
export interface MailRuleMessage {
  accountId: string
  fromName: string
  fromEmail: string
  to: string[]
  cc: string[]
  subject: string
  text: string
  labelIds?: string[]
  sizeEstimate?: number
  internalDate?: string
  attachmentCount?: number
  attachments?: unknown[]
  /** Lower-case header name to every value of that header. */
  headers?: Record<string, string[]>
  /** Inbox tab the conversation is in (E33). */
  category?: string
}

const addressParts = (value: string) => {
  const match = value.trim().match(/^(.*?)\s*<([^<>]+)>$/)
  return { name: match?.[1]?.trim().replace(/^"|"$/g, '') ?? '', email: (match?.[2] ?? value).trim() }
}

const textMatches = (operator: MailRuleConditionOperator, haystack: string, needle: string) => {
  const value = haystack.trim().toLocaleLowerCase()
  if (operator === 'equals') return value === needle
  if (operator === 'starts-with') return value.startsWith(needle)
  if (operator === 'ends-with') return value.endsWith(needle)
  return value.includes(needle)
}

const DAY_MS = 24 * 60 * 60 * 1_000

/** Exchange/Outlook Importance and X-Priority headers, falling back to Gmail/Graph's IMPORTANT label. */
export function mailRuleImportance(message: Pick<MailRuleMessage, 'labelIds' | 'headers'>): 'high' | 'normal' | 'low' {
  const header = (name: string) => message.headers?.[name]?.[0]?.trim().toLowerCase() ?? ''
  const importance = header('importance') || header('priority')
  const priority = Number.parseInt(header('x-priority'), 10)
  if (importance === 'high' || importance === 'urgent' || priority === 1 || priority === 2) return 'high'
  if (importance === 'low' || importance === 'non-urgent' || priority === 4 || priority === 5) return 'low'
  return message.labelIds?.includes('IMPORTANT') ? 'high' : 'normal'
}

export function mailRuleConditionMatches(condition: MailRuleCondition, message: MailRuleMessage, now = Date.now()): boolean {
  const needle = condition.value.trim().toLocaleLowerCase()
  if (!needle) return false
  switch (condition.field) {
    case 'from':
      if (condition.operator === 'equals') return [message.fromEmail, message.fromName, `${message.fromName} ${message.fromEmail}`].some((value) => value.trim().toLocaleLowerCase() === needle)
      return textMatches(condition.operator, `${message.fromName} ${message.fromEmail}`, needle)
    case 'to':
    case 'cc': {
      const recipients = condition.field === 'to' ? [...message.to, ...message.cc] : message.cc
      if (condition.operator === 'equals') {
        return textMatches('equals', recipients.join(' '), needle) || recipients.some((recipient) => {
          const parts = addressParts(recipient)
          return [recipient, parts.email, parts.name].some((value) => value.trim().toLocaleLowerCase() === needle)
        })
      }
      return textMatches(condition.operator, recipients.join(' '), needle)
    }
    case 'subject': return textMatches(condition.operator, message.subject, needle)
    case 'body': return textMatches(condition.operator, message.text, needle)
    case 'header': {
      const values = message.headers?.[condition.headerName?.trim().toLowerCase() ?? '']
      return Boolean(values?.some((value) => textMatches(condition.operator, value, needle)))
    }
    case 'has-attachment': {
      const count = message.attachmentCount ?? message.attachments?.length
      if (count === undefined) return false
      return needle === 'yes' ? count > 0 : count === 0
    }
    case 'size': {
      if (message.sizeEstimate === undefined) return false
      const limit = Number(needle) * 1024
      return condition.operator === 'greater-than' ? message.sizeEstimate > limit : message.sizeEstimate < limit
    }
    case 'age': {
      const date = message.internalDate ? Date.parse(message.internalDate) : Number.NaN
      if (!Number.isFinite(date)) return false
      const days = (now - date) / DAY_MS
      return condition.operator === 'greater-than' ? days > Number(needle) : days < Number(needle)
    }
    case 'importance': return mailRuleImportance(message) === needle
    case 'label': return Boolean(message.labelIds?.includes(condition.value.trim()))
    case 'category': return message.category !== undefined && message.category === condition.value.trim()
    default: return false
  }
}

export function mailRuleMatches(rule: Pick<MailRuleInput, 'match' | 'conditions' | 'exceptions'> & Partial<MailRuleInput>, message: MailRuleMessage, now = Date.now()) {
  const matches = rule.conditions.map((condition) => mailRuleConditionMatches(condition, message, now))
  if (!matches.length || !(rule.match === 'all' ? matches.every(Boolean) : matches.some(Boolean))) return false
  return !(rule.exceptions ?? []).some((exception) => mailRuleConditionMatches(exception, message, now))
}

/** True when the rule reads headers, so callers only parse raw headers when needed. */
export const mailRuleNeedsHeaders = (rule: Pick<MailRuleInput, 'conditions' | 'exceptions'>) =>
  [...rule.conditions, ...(rule.exceptions ?? [])].some((condition) => condition.field === 'header' || condition.field === 'importance')

/** True when the rule reads the inbox category, so callers only resolve it when needed. */
export const mailRuleNeedsCategory = (rule: Pick<MailRuleInput, 'conditions' | 'exceptions'>) =>
  [...rule.conditions, ...(rule.exceptions ?? [])].some((condition) => condition.field === 'category')

export const mailRuleTrigger = (rule: Pick<MailRuleInput, 'trigger'>): MailRuleTrigger => rule.trigger === 'outgoing' || rule.trigger === 'archive' ? rule.trigger : 'incoming'

/**
 * Which rule triggers a newly synced message belongs to. Drafts belong to
 * none; Sent copies are outgoing; anything in the Inbox (including a Gmail
 * message sent to yourself) or not in Sent is incoming.
 */
export function mailRuleTriggersForLabels(labelIds: string[]): MailRuleTrigger[] {
  const labels = new Set(labelIds.map((label) => label.toUpperCase()))
  if (labels.has('DRAFT')) return []
  const triggers: MailRuleTrigger[] = []
  if (!labels.has('SENT') || labels.has('INBOX')) triggers.push('incoming')
  if (labels.has('SENT')) triggers.push('outgoing')
  return triggers
}
