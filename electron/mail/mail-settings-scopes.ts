import type { MailProviderId } from '../../src/mail-types'

// Mailbox-settings permissions shared by server-side rules (Gmail filters,
// Outlook inbox rules) and automatic replies. Accounts connected before these
// scopes were requested keep working for mail; only the settings features
// report the missing scope and ask for a reconnect.

export const GMAIL_SETTINGS_BASIC_SCOPE = 'https://www.googleapis.com/auth/gmail.settings.basic'
export const MICROSOFT_MAILBOX_SETTINGS_SCOPE = 'MailboxSettings.ReadWrite'

export type MailSettingsFeature = 'server-rules' | 'automatic-replies'

export interface MailSettingsScopeStatus {
  provider: MailProviderId
  /** False for IMAP-style providers with no settings API Aerio manages. */
  supported: boolean
  granted: boolean
  required: string[]
  missing: string[]
  /** User-facing explanation when the feature can't be used yet. */
  message?: string
}

const FEATURE_NAMES: Record<MailSettingsFeature, string> = {
  'server-rules': 'server rules',
  'automatic-replies': 'automatic replies'
}

/** Splits a granted-scope string; Graph scopes are compared without their resource prefix and case. */
export function grantedScopeSet(scope: string | undefined) {
  return new Set((scope ?? '').split(/\s+/).filter(Boolean).map((value) => value.replace(/^https:\/\/graph\.microsoft\.com\//i, '')))
}

export function requiredMailSettingsScopes(provider: MailProviderId | undefined) {
  if (provider === 'gmail') return [GMAIL_SETTINGS_BASIC_SCOPE]
  if (provider === 'microsoft') return [MICROSOFT_MAILBOX_SETTINGS_SCOPE]
  return []
}

export function mailSettingsScopeStatus(provider: MailProviderId, grantedScope: string | undefined, feature: MailSettingsFeature): MailSettingsScopeStatus {
  const required = requiredMailSettingsScopes(provider)
  const name = FEATURE_NAMES[feature]
  if (!required.length) {
    return { provider, supported: false, granted: false, required, missing: [], message: `This account’s server doesn’t offer ${name} that Aerio can manage` }
  }
  const granted = grantedScopeSet(grantedScope)
  const lowerGranted = new Set([...granted].map((value) => value.toLowerCase()))
  const missing = required.filter((scope) => !granted.has(scope) && !lowerGranted.has(scope.toLowerCase()))
  if (!missing.length) return { provider, supported: true, granted: true, required, missing }
  const permission = provider === 'gmail' ? 'manage Gmail settings (gmail.settings.basic)' : 'read and write mailbox settings (MailboxSettings.ReadWrite)'
  return {
    provider,
    supported: true,
    granted: false,
    required,
    missing,
    message: `Aerio doesn’t have permission to ${permission} for this account. Reconnect the account and approve the new permission to use ${name}; mail keeps working meanwhile.`
  }
}

/** Raised when a provider refuses a settings request because the token lacks a settings scope. */
export class MailSettingsPermissionError extends Error {
  constructor(readonly provider: MailProviderId, readonly feature: MailSettingsFeature) {
    super(mailSettingsScopeStatus(provider, '', feature).message ?? 'Reconnect this account to grant the required permission')
    this.name = 'MailSettingsPermissionError'
  }
}

/** Recognizes Gmail's insufficient-scope 403 and Graph's ErrorAccessDenied / 403 responses. */
export function isMailSettingsPermissionFailure(status: number, message = '', reason = '') {
  if (status !== 403 && status !== 401) return false
  // Gmail also answers rate limiting with 403.
  if (/rate ?limit|quota/i.test(`${message} ${reason}`)) return false
  return status === 403 || /insufficient|scope|access ?denied|permission/i.test(`${message} ${reason}`)
}
