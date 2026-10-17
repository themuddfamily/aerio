import type { MailServerRule, MailServerRuleCapabilities, MailServerRuleMapping } from '../../src/mail-server-rule-types'
import type { MailLabel, MailProviderId, MailRule } from '../../src/mail-types'
import {
  MICROSOFT_ARCHIVE_FOLDER,
  describeGmailFilter,
  describeMicrosoftRule,
  gmailFilterForRule,
  microsoftRuleForRule,
  type GmailFilterResource,
  type MicrosoftMessageRuleResource
} from '../../src/lib/mail-server-rules'
import { MailSettingsPermissionError, isMailSettingsPermissionFailure, type MailSettingsScopeStatus } from './mail-settings-scopes'

const GMAIL_FILTERS = 'https://gmail.googleapis.com/gmail/v1/users/me/settings/filters'
const GRAPH_RULES = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messageRules'

export interface MailServerRuleDeps {
  provider(accountId: string): MailProviderId | undefined
  accessToken(accountId: string): Promise<string>
  access(accountId: string, provider: MailProviderId): MailSettingsScopeStatus
  labels(accountId: string): Promise<MailLabel[]>
  fetch?: typeof fetch
}

export class MailServerRuleError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'MailServerRuleError'
  }
}

export interface ServerRuleUpload {
  serverRuleId: string
  serverRule: MailServerRule
  mapping: MailServerRuleMapping
}

// Provider-side rule management: Gmail users.settings.filters and Graph
// mailFolders/inbox/messageRules. Only the server executes these rules; the
// caller marks an uploaded local rule as server-executed so Aerio never
// applies it a second time on this computer.
export class MailServerRuleService {
  constructor(private readonly deps: MailServerRuleDeps) {}

  capabilities(accountId: string): MailServerRuleCapabilities {
    const provider = this.deps.provider(accountId)
    if (!provider) throw new Error('Account not found')
    const access = this.deps.access(accountId, provider)
    const base = { accountId, provider, missingScopes: access.missing, outgoing: false as const, exceptions: false, matchModes: [], conditions: [], actions: [], updateInPlace: false, canDisable: false }
    if (provider === 'gmail') {
      return {
        ...base, supported: true, api: 'gmail-filters', permission: access.granted ? 'granted' : 'missing', reason: access.message,
        conditions: ['from', 'to', 'cc', 'subject', 'body', 'header', 'has-attachment', 'size', 'importance'],
        actions: ['archive', 'read', 'star', 'important', 'trash', 'label', 'move'], matchModes: ['all', 'any'], exceptions: true
      }
    }
    if (provider === 'microsoft') {
      return {
        ...base, supported: true, api: 'microsoft-message-rules', permission: access.granted ? 'granted' : 'missing', reason: access.message,
        conditions: ['from', 'to', 'cc', 'subject', 'body', 'header', 'has-attachment', 'size', 'importance'],
        actions: ['archive', 'read', 'important', 'trash', 'label', 'move'], matchModes: ['all', 'any'], exceptions: true, updateInPlace: true, canDisable: true
      }
    }
    return { ...base, supported: false, permission: 'unsupported', reason: access.message }
  }

  private requireAccess(accountId: string) {
    const capabilities = this.capabilities(accountId)
    if (!capabilities.supported) throw new Error(capabilities.reason ?? 'This account has no server rules')
    if (capabilities.permission !== 'granted') throw new MailSettingsPermissionError(capabilities.provider, 'server-rules')
    return capabilities.provider as 'gmail' | 'microsoft'
  }

  private async request<T>(accountId: string, provider: MailProviderId, url: string, init: RequestInit = {}): Promise<T> {
    const response = await (this.deps.fetch ?? fetch)(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${await this.deps.accessToken(accountId)}`,
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers
      }
    })
    if (response.ok) {
      if (response.status === 204) return undefined as T
      const text = await response.text()
      return (text ? JSON.parse(text) : undefined) as T
    }
    const details = await response.json().catch(() => ({})) as { error?: { message?: string; code?: string; errors?: { reason?: string }[] } }
    const message = details.error?.message ?? `${response.status} ${response.statusText}`
    if (isMailSettingsPermissionFailure(response.status, message, details.error?.errors?.[0]?.reason ?? details.error?.code)) {
      throw new MailSettingsPermissionError(provider, 'server-rules')
    }
    throw new MailServerRuleError(message, response.status)
  }

  private gmailRule(accountId: string, filter: GmailFilterResource, labels: MailLabel[], linked?: MailRule): MailServerRule {
    return { id: filter.id ?? '', accountId, provider: 'gmail', name: linked?.name ?? 'Gmail filter', enabled: true, ...describeGmailFilter(filter, labels), ...(linked ? { linkedRuleId: linked.id } : {}) }
  }

  private microsoftRule(accountId: string, rule: MicrosoftMessageRuleResource, labels: MailLabel[], linked?: MailRule): MailServerRule {
    return { id: rule.id ?? '', accountId, provider: 'microsoft', name: rule.displayName || 'Outlook rule', enabled: rule.isEnabled, ...describeMicrosoftRule(rule, labels), ...(linked ? { linkedRuleId: linked.id } : {}) }
  }

  private async microsoftRules(accountId: string) {
    const rules: MicrosoftMessageRuleResource[] = []
    let next: string | undefined = GRAPH_RULES
    while (next) {
      const page: { value?: MicrosoftMessageRuleResource[]; '@odata.nextLink'?: string } = await this.request(accountId, 'microsoft', next)
      rules.push(...(page.value ?? []))
      next = page['@odata.nextLink']
    }
    return rules
  }

  async list(accountId: string, localRules: MailRule[] = []): Promise<MailServerRule[]> {
    const provider = this.requireAccess(accountId)
    const labels = await this.deps.labels(accountId).catch(() => [])
    const linked = (id?: string) => localRules.find((rule) => rule.accountId === accountId && rule.serverRuleId && rule.serverRuleId === id)
    if (provider === 'gmail') {
      const result = await this.request<{ filter?: GmailFilterResource[] }>(accountId, provider, GMAIL_FILTERS)
      return (result?.filter ?? []).map((filter) => this.gmailRule(accountId, filter, labels, linked(filter.id)))
    }
    return (await this.microsoftRules(accountId))
      .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0))
      .map((rule) => this.microsoftRule(accountId, rule, labels, linked(rule.id)))
  }

  /** Creates the provider rule for a local rule, replacing its earlier upload when it has one. */
  async upload(rule: MailRule): Promise<ServerRuleUpload> {
    const provider = this.requireAccess(rule.accountId)
    const labels = await this.deps.labels(rule.accountId).catch(() => [])
    if (provider === 'gmail') {
      const { filter, mapping } = gmailFilterForRule(rule)
      if (!filter) throw new MailServerRuleMappingError(mapping)
      // Filters are immutable: create the replacement first so mail is never
      // left unfiltered, then remove the earlier upload.
      const created = await this.request<GmailFilterResource>(rule.accountId, provider, GMAIL_FILTERS, { method: 'POST', body: JSON.stringify(filter) })
      if (!created?.id) throw new MailServerRuleError('Gmail did not return the new filter', 502)
      if (rule.serverRuleId && rule.serverRuleId !== created.id) {
        try {
          await this.request(rule.accountId, provider, `${GMAIL_FILTERS}/${encodeURIComponent(rule.serverRuleId)}`, { method: 'DELETE' })
        } catch (error) {
          if (!(error instanceof MailServerRuleError && error.status === 404)) {
            // Two copies would run on every message; undo the new filter.
            await this.request(rule.accountId, provider, `${GMAIL_FILTERS}/${encodeURIComponent(created.id)}`, { method: 'DELETE' }).catch(() => undefined)
            throw error
          }
        }
      }
      return { serverRuleId: created.id, serverRule: this.gmailRule(rule.accountId, created, labels, rule), mapping }
    }
    const { messageRule, mapping } = microsoftRuleForRule(rule)
    if (!messageRule) throw new MailServerRuleMappingError(mapping)
    if (messageRule.actions?.moveToFolder === MICROSOFT_ARCHIVE_FOLDER) {
      const archive = await this.request<{ id?: string }>(rule.accountId, provider, 'https://graph.microsoft.com/v1.0/me/mailFolders/archive?$select=id')
      if (!archive?.id) throw new MailServerRuleError('This mailbox has no Archive folder for the rule', 404)
      messageRule.actions.moveToFolder = archive.id
    }
    if (rule.serverRuleId) {
      try {
        const updated = await this.request<MicrosoftMessageRuleResource>(rule.accountId, provider, `${GRAPH_RULES}/${encodeURIComponent(rule.serverRuleId)}`, { method: 'PATCH', body: JSON.stringify(messageRule) })
        const value = { ...messageRule, ...updated, id: updated?.id ?? rule.serverRuleId }
        return { serverRuleId: value.id, serverRule: this.microsoftRule(rule.accountId, value, labels, rule), mapping }
      } catch (error) {
        // The rule was removed in Outlook; recreate it below.
        if (!(error instanceof MailServerRuleError && error.status === 404)) throw error
      }
    }
    const existing = await this.microsoftRules(rule.accountId)
    const sequence = existing.reduce((highest, item) => Math.max(highest, item.sequence ?? 0), 0) + 1
    const created = await this.request<MicrosoftMessageRuleResource>(rule.accountId, provider, GRAPH_RULES, { method: 'POST', body: JSON.stringify({ ...messageRule, sequence }) })
    if (!created?.id) throw new MailServerRuleError('Microsoft did not return the new rule', 502)
    return { serverRuleId: created.id, serverRule: this.microsoftRule(rule.accountId, { ...messageRule, ...created }, labels, rule), mapping }
  }

  async delete(accountId: string, serverRuleId: string) {
    const provider = this.requireAccess(accountId)
    const url = provider === 'gmail' ? `${GMAIL_FILTERS}/${encodeURIComponent(serverRuleId)}` : `${GRAPH_RULES}/${encodeURIComponent(serverRuleId)}`
    try {
      await this.request(accountId, provider, url, { method: 'DELETE' })
    } catch (error) {
      if (!(error instanceof MailServerRuleError && error.status === 404)) throw error
    }
  }

  async setEnabled(accountId: string, serverRuleId: string, enabled: boolean, localRules: MailRule[] = []) {
    const provider = this.requireAccess(accountId)
    if (provider === 'gmail') throw new Error('Gmail filters can’t be turned off; delete the filter instead')
    const updated = await this.request<MicrosoftMessageRuleResource>(accountId, provider, `${GRAPH_RULES}/${encodeURIComponent(serverRuleId)}`, { method: 'PATCH', body: JSON.stringify({ isEnabled: enabled }) })
    const labels = await this.deps.labels(accountId).catch(() => [])
    return this.microsoftRule(accountId, { ...updated, displayName: updated?.displayName ?? '', id: updated?.id ?? serverRuleId, isEnabled: updated?.isEnabled ?? enabled }, labels, localRules.find((rule) => rule.serverRuleId === serverRuleId))
  }
}

export class MailServerRuleMappingError extends Error {
  constructor(readonly mapping: MailServerRuleMapping) {
    const blocking = mapping.issues.filter((issue) => issue.level === 'unsupported').map((issue) => issue.message)
    super(`This rule can’t run on the server: ${blocking.join('; ')}`)
    this.name = 'MailServerRuleMappingError'
  }
}
