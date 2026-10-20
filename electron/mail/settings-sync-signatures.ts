import { syncDigest } from '../settings-sync-crypto'
import type { PortableSignatures } from '../../src/settings-sync-types'
import type { MailDatabase } from './database'
import { sanitizeTemplateHtml } from './template-store'
import { isCompleteMailAddress } from '../../src/lib/mail-address'
const string = (value: unknown, max: number, required = false): value is string => typeof value === 'string' && value.length <= max && (!required || !!value.trim())
export function validatePortableSignatures(value: unknown): PortableSignatures {
  if (!value || typeof value !== 'object') throw new Error('Invalid synchronized signatures.')
  const data = value as PortableSignatures
  if (!Array.isArray(data.definitions) || data.definitions.length > 500 || !Array.isArray(data.accounts) || data.accounts.length > 500 || !Array.isArray(data.assignments) || data.assignments.length > 5000) throw new Error('Invalid synchronized signatures.')
  const definitions = data.definitions.map((entry) => {
    if (!entry || !string(entry.id, 300, true) || !string(entry.name, 200, true) || !string(entry.html, 1_000_000)) throw new Error('Invalid synchronized signature.')
    return { id: entry.id, name: entry.name.trim(), html: sanitizeTemplateHtml(entry.html) }
  }).sort((a, b) => a.id.localeCompare(b.id))
  const ids = new Set(definitions.map((item) => item.id))
  if (ids.size !== definitions.length || new Set(definitions.map((item) => item.name.toLowerCase())).size !== definitions.length) throw new Error('Duplicate synchronized signature.')
  const address = (value: unknown): value is string => string(value, 320, true) && isCompleteMailAddress(value)
  const provider = (value: unknown): value is string => typeof value === 'string' && ['gmail', 'microsoft', 'imap', 'outlook', 'exchange', 'pop3'].includes(value)
  const accounts = data.accounts.map((entry) => {
    if (!entry || !provider(entry.provider) || !address(entry.email) || !string(entry.html, 20_000)) throw new Error('Invalid account signature mapping.')
    return { provider: entry.provider, email: entry.email.toLowerCase(), html: entry.html }
  }).sort((a, b) => `${a.provider}:${a.email}`.localeCompare(`${b.provider}:${b.email}`))
  const assignments = data.assignments.map((entry) => {
    if (!entry || !provider(entry.provider) || !address(entry.accountEmail) || !address(entry.identityEmail) || entry.newSignatureId !== undefined && !ids.has(entry.newSignatureId) || entry.replySignatureId !== undefined && !ids.has(entry.replySignatureId)) throw new Error('Invalid signature assignment.')
    return { provider: entry.provider, accountEmail: entry.accountEmail.toLowerCase(), identityEmail: entry.identityEmail.toLowerCase(), ...(entry.newSignatureId ? { newSignatureId: entry.newSignatureId } : {}), ...(entry.replySignatureId ? { replySignatureId: entry.replySignatureId } : {}) }
  }).sort((a, b) => `${a.provider}:${a.accountEmail}:${a.identityEmail}`.localeCompare(`${b.provider}:${b.accountEmail}:${b.identityEmail}`))
  return { definitions, accounts, assignments }
}
export function capturePortableSignatures(database: MailDatabase): PortableSignatures {
  const accounts = database.listAccounts().filter((account) => account.provider !== 'local')
  const identities = database.identities.list(accounts)
  return validatePortableSignatures({
    definitions: database.identities.listSignatures().map(({ id, name, html }) => ({ id, name, html })),
    accounts: accounts.map(({ provider, email, signature }) => ({ provider, email, html: signature })),
    assignments: identities.map((identity) => { const account = accounts.find((item) => item.id === identity.accountId)!; return { provider: account.provider, accountEmail: account.email, identityEmail: identity.email, newSignatureId: identity.newSignatureId, replySignatureId: identity.replySignatureId } })
  })
}
export function applyPortableSignatures(database: MailDatabase, value: unknown, expected?: PortableSignatures): { skippedAccounts: number; snapshot: PortableSignatures } {
  const data = validatePortableSignatures(value), accounts = database.listAccounts().filter((account) => account.provider !== 'local')
  let snapshot!: PortableSignatures
  database.transaction(() => {
    if (expected && syncDigest(capturePortableSignatures(database)) !== syncDigest(validatePortableSignatures(expected))) throw new Error('Local synchronized settings changed during import.')
    database.identities.applySynchronizedSignatures(data, accounts)
    for (const mapped of data.accounts) for (const account of accounts.filter((account) => account.provider === mapped.provider && account.email.toLowerCase() === mapped.email)) database.updateAccountSettings({ accountId: account.id, displayName: account.displayName, color: account.color, signature: mapped.html, notifications: account.notifications, syncEnabled: account.syncEnabled })
    snapshot = capturePortableSignatures(database)
  })
  return { snapshot, skippedAccounts: data.accounts.filter((mapped) => !accounts.some((account) => account.provider === mapped.provider && account.email.toLowerCase() === mapped.email)).length }
}
