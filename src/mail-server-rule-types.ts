import type { MailProviderId, MailRule, MailRuleAction, MailRuleConditionField } from './mail-types'

export type MailServerRuleProvider = 'gmail' | 'microsoft'

/** Why a local condition, exception, or action can't be expressed by the provider. */
export interface MailServerRuleIssue {
  part: 'rule' | 'condition' | 'exception' | 'action'
  /** Index into conditions, exceptions, or actions; absent for whole-rule issues. */
  index?: number
  /** unsupported blocks the upload; approximate uploads with a visible caveat. */
  level: 'unsupported' | 'approximate'
  message: string
}

export interface MailServerRuleMapping {
  provider: MailProviderId
  supported: boolean
  issues: MailServerRuleIssue[]
}

export interface MailServerRuleCapabilities {
  accountId: string
  provider: MailProviderId
  /** Whether the provider has a server-rule API that Aerio manages. */
  supported: boolean
  /** granted: required scopes present; missing: reconnect to grant them. */
  permission: 'granted' | 'missing' | 'unsupported'
  missingScopes: string[]
  /** Explanation shown when server rules are unavailable. */
  reason?: string
  api?: 'gmail-filters' | 'microsoft-message-rules'
  conditions: MailRuleConditionField[]
  actions: MailRuleAction['action'][]
  matchModes: MailRule['match'][]
  exceptions: boolean
  /** Provider rules run on received mail only. */
  outgoing: false
  /** Gmail filters are immutable, so an update is delete + create. */
  updateInPlace: boolean
  /** Gmail filters can't be disabled, only deleted. */
  canDisable: boolean
}

export interface MailServerRule {
  id: string
  accountId: string
  provider: MailServerRuleProvider
  name: string
  enabled: boolean
  /** Human-readable conditions and actions as the provider stores them. */
  conditions: string[]
  actions: string[]
  exceptions: string[]
  /** Local rule uploaded as this server rule, when Aerio created it. */
  linkedRuleId?: string
}

export interface MailServerRuleUploadResult {
  rule: MailRule
  serverRule: MailServerRule
  mapping: MailServerRuleMapping
}

export interface MailServerRulesApi {
  capabilities(accountId: string): Promise<MailServerRuleCapabilities>
  list(accountId: string): Promise<MailServerRule[]>
  /** Creates or replaces the provider rule for a saved local rule and marks it server-executed. */
  upload(ruleId: string): Promise<MailServerRuleUploadResult>
  /** Deletes a provider rule; a linked local rule returns to local execution, disabled. */
  delete(accountId: string, serverRuleId: string): Promise<void>
  setEnabled(accountId: string, serverRuleId: string, enabled: boolean): Promise<MailServerRule>
}
