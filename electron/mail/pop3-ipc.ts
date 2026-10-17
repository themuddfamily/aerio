import { createHash } from 'node:crypto'
import { ipcMain } from 'electron'
import type { MailAccountSummary } from '../../src/mail-types'
import type {
  Pop3AccountSettings,
  Pop3AccountSettingsUpdate,
  Pop3AccountStatus,
  Pop3ConnectionConfig,
  Pop3ConnectionTestResult
} from '../../src/pop3-types'
import { ImapSmtpClient } from './imap-client'
import { Pop3Session } from './pop3-client'
import { connectionConfigOf, pop3ClientOptions, pop3SmtpConfig, serverSettingsOf, validatePop3Account, validatePop3Destination, validatePop3Retention, validatePop3Server } from './pop3-settings'
import type { Pop3StoredSettings } from './pop3-store'
import type { MailWorkerClient } from './worker-client'

// Main-process POP3 account handlers. Passwords stay in the encrypted vault;
// the mail worker keeps the non-secret settings and the download checkpoints.

/** Connects, signs in, checks UIDL support and the SMTP server, and changes nothing. */
export async function testPop3Connection(config: Pop3ConnectionConfig, trust: { ca?: string } = {}): Promise<Pop3ConnectionTestResult> {
  const session = await Pop3Session.open(pop3ClientOptions(config, trust.ca ? { tls: { ca: trust.ca } } : {}))
  let result: Omit<Pop3ConnectionTestResult, 'smtpVerified'>
  try {
    const stat = await session.stat()
    await session.uidl()
    result = { capabilities: session.capabilities, authMethod: session.authMethod, encrypted: session.encrypted, messages: stat.count, bytes: stat.bytes }
    await session.quit()
  } finally {
    session.close()
  }
  await new ImapSmtpClient(pop3SmtpConfig(config), trust).verifySmtp()
  return { ...result, smtpVerified: true }
}

export interface Pop3IpcDeps {
  worker(): Pick<MailWorkerClient, 'request'>
  vault(): { storePop3(accountId: string, config: Pop3ConnectionConfig): void; pop3Config(accountId: string): Pop3ConnectionConfig | undefined; remove(accountId: string): Promise<void> }
  accountColor(accountId: string): string
  /** Tells the credential provider which protocol an account uses. */
  setProvider(accountId: string, provider: MailAccountSummary['provider'] | undefined): void
  locked(): boolean
  test?(config: Pop3ConnectionConfig): Promise<Pop3ConnectionTestResult>
}

const validAccountId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(value)

export const pop3AccountId = (config: Pick<Pop3ConnectionConfig, 'email' | 'username' | 'pop3Host'>) =>
  createHash('sha256').update(`pop3:${config.email}:${config.username}:${config.pop3Host}`).digest('hex').slice(0, 24)

export function registerPop3Ipc(deps: Pop3IpcDeps) {
  const test = (config: Pop3ConnectionConfig) => (deps.test ?? testPop3Connection)(config)
  const unlocked = () => { if (deps.locked()) throw new Error('Unlock Aerio before changing mail accounts') }
  const account = async (accountId: string) => {
    const found = (await deps.worker().request<MailAccountSummary[]>({ type: 'accounts:list' })).find((item) => item.id === accountId)
    if (!found || found.provider !== 'pop3') throw new Error('POP3 account not found')
    return found
  }
  const settings = async (accountId: string): Promise<Pop3AccountSettings> => {
    const stored = await deps.worker().request<Pop3StoredSettings>({ type: 'pop3', payload: { action: 'settings:get', accountId } })
    const config = deps.vault().pop3Config(accountId)
    return { ...(config ? serverSettingsOf(config) : stored.server), retention: stored.retention, destination: stored.destination, passwordConfigured: Boolean(config?.password) }
  }

  ipcMain.handle('mail:pop3:test', (_event, raw: unknown) => {
    unlocked()
    const input = validatePop3Account(raw)
    return test(connectionConfigOf(input))
  })

  ipcMain.handle('mail:pop3:connect', async (_event, raw: unknown) => {
    unlocked()
    const input = validatePop3Account(raw)
    const config = connectionConfigOf(input)
    await test(config)
    const accountId = pop3AccountId(config)
    const existing = (await deps.worker().request<MailAccountSummary[]>({ type: 'accounts:list' })).find((item) => item.id === accountId || item.email === input.email)
    if (existing) throw new Error(`${input.email} is already connected in Aerio. Remove that account first to set it up again with POP3.`)
    const summary: MailAccountSummary = {
      id: accountId,
      provider: 'pop3',
      email: input.email,
      displayName: input.displayName?.trim() || input.email.split('@')[0],
      color: deps.accountColor(accountId),
      status: 'connecting',
      archived: false,
      signature: '',
      notifications: true,
      syncEnabled: true
    }
    deps.setProvider(accountId, 'pop3')
    try {
      await deps.worker().request({ type: 'accounts:upsert', payload: summary })
      deps.vault().storePop3(accountId, config)
      await deps.worker().request({ type: 'pop3', payload: { action: 'settings:save', accountId, settings: { server: serverSettingsOf(config), retention: input.retention, destination: input.destination } } })
      await deps.worker().request({ type: 'sync:start', payload: { accountId } })
      return summary
    } catch (error) {
      deps.setProvider(accountId, undefined)
      await deps.vault().remove(accountId)
      await deps.worker().request({ type: 'accounts:disconnect', payload: { accountId, mode: 'delete' } }).catch(() => undefined)
      throw error
    }
  })

  ipcMain.handle('mail:pop3:settings', async (_event, accountId: unknown) => {
    if (!validAccountId(accountId)) throw new Error('Choose a valid POP3 account')
    await account(accountId)
    return settings(accountId)
  })

  ipcMain.handle('mail:pop3:update', async (_event, accountId: unknown, raw: unknown) => {
    unlocked()
    if (!validAccountId(accountId)) throw new Error('Choose a valid POP3 account')
    const input = raw as Partial<Pop3AccountSettingsUpdate> | undefined
    if (!input || typeof input !== 'object') throw new Error('Enter valid POP3 and SMTP settings')
    if (input.password !== undefined && (typeof input.password !== 'string' || input.password.length > 1_000)) throw new Error('Enter a valid password')
    const current = await account(accountId)
    const server = validatePop3Server(input)
    const retention = validatePop3Retention(input.retention)
    const destination = validatePop3Destination(input.destination)
    const saved = deps.vault().pop3Config(accountId)
    const password = input.password?.trim() ? input.password : saved?.password
    if (!password) throw new Error('Enter the password for this POP3 account')
    const config = connectionConfigOf({ ...server, email: current.email, password })
    const connectionChanged = !saved || JSON.stringify(serverSettingsOf(saved)) !== JSON.stringify(serverSettingsOf(config)) || saved.password !== password
    // New server settings or a new password are only saved after they work.
    if (connectionChanged) {
      await test(config)
      deps.vault().storePop3(accountId, config)
    }
    await deps.worker().request({ type: 'pop3', payload: { action: 'settings:save', accountId, settings: { server: serverSettingsOf(config), retention, destination } } })
    deps.setProvider(accountId, 'pop3')
    if (connectionChanged && current.syncEnabled) await deps.worker().request({ type: 'sync:start', payload: { accountId } })
    return settings(accountId)
  })

  ipcMain.handle('mail:pop3:status', async (_event, accountId: unknown) => {
    if (!validAccountId(accountId)) throw new Error('Choose a valid POP3 account')
    await account(accountId)
    return deps.worker().request<Pop3AccountStatus>({ type: 'pop3', payload: { action: 'status', accountId } })
  })
}
