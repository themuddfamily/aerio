import type { IpcMain } from 'electron'
import type {
  MailAutomaticRepliesState,
  MailAutomaticReplyAudience,
  MailAutomaticReplyCapabilities,
  MailAutomaticReplyPhase,
  MailAutomaticReplySettings,
  MailProviderId
} from '../../src/mail-types'
import { decodeHtmlEntities } from '../../src/lib/html-entities'
import { GmailApiError, GmailClient, type GmailVacationSettings } from './gmail-client'
import { MicrosoftGraphClient, MicrosoftGraphError, type GraphAutomaticRepliesSetting, type GraphDateTimeTimeZone } from './microsoft-client'
import { GMAIL_SETTINGS_BASIC_SCOPE, MICROSOFT_MAILBOX_SETTINGS_SCOPE } from './mail-settings-scopes'

// Automatic replies live entirely on the provider: Gmail and Exchange send
// them, and they start and stop on schedule whether or not Aerio is running.
// Aerio keeps no local copy; every read is a fresh provider request.

export const GMAIL_SETTINGS_SCOPE = GMAIL_SETTINGS_BASIC_SCOPE
const GMAIL_VACATION_READ_SCOPES = [
  GMAIL_SETTINGS_SCOPE,
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://mail.google.com/'
]
export const MICROSOFT_SETTINGS_SCOPE = MICROSOFT_MAILBOX_SETTINGS_SCOPE
const MICROSOFT_SETTINGS_READ_SCOPES = [MICROSOFT_SETTINGS_SCOPE, 'MailboxSettings.Read']

const MAX_MESSAGE_LENGTH = 100_000
const MAX_SUBJECT_LENGTH = 1_000
const CONSUMER_GOOGLE_DOMAINS = new Set(['gmail.com', 'googlemail.com'])

export class AutomaticReplyPermissionError extends Error {
  constructor(message: string, readonly scope: string) {
    super(message)
    this.name = 'AutomaticReplyPermissionError'
  }
}

export function automaticReplyCapabilities(provider: 'gmail' | 'microsoft', email: string): MailAutomaticReplyCapabilities {
  if (provider === 'microsoft') return { subject: false, separateExternalMessage: true, audiences: ['none', 'contacts', 'all'], requiresBothDates: true }
  const domain = email.split('@').pop()?.toLowerCase() ?? ''
  // restrictToDomain is only meaningful for Google Workspace; consumer Gmail rejects it.
  return {
    subject: true,
    separateExternalMessage: false,
    audiences: CONSUMER_GOOGLE_DOMAINS.has(domain) ? ['all', 'contacts'] : ['all', 'contacts', 'none'],
    requiresBothDates: false
  }
}

export function automaticReplyPhase(settings: MailAutomaticReplySettings, now = Date.now()): MailAutomaticReplyPhase {
  if (!settings.enabled) return 'off'
  if (settings.endAt && Date.parse(settings.endAt) <= now) return 'ended'
  if (settings.startAt && Date.parse(settings.startAt) > now) return 'scheduled'
  return 'active'
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)

export function replyTextToHtml(text: string) {
  return text ? escapeHtml(text).replace(/\r?\n/g, '<br>') : ''
}

export function replyHtmlToText(html: string) {
  const text = html
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]*>/g, '')
  return decodeHtmlEntities(text).replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** True when the provider message carries formatting a plain-text save would drop. */
function hasRichFormatting(html: string) {
  return /<(?!\/?(?:br|p|div|html|body|span|meta|head|title)\b)[a-z]/i.test(html)
}

// Exchange reports schedules in the mailbox's Windows time zone unless they
// were written in UTC. These are the zones Outlook most commonly assigns;
// IANA names are also accepted directly.
const WINDOWS_TIME_ZONES: Readonly<Record<string, string>> = {
  'UTC': 'UTC',
  'Coordinated Universal Time': 'UTC',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Romance Standard Time': 'Europe/Paris',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'FLE Standard Time': 'Europe/Kiev',
  'GTB Standard Time': 'Europe/Bucharest',
  'Turkey Standard Time': 'Europe/Istanbul',
  'Russian Standard Time': 'Europe/Moscow',
  'Israel Standard Time': 'Asia/Jerusalem',
  'Egypt Standard Time': 'Africa/Cairo',
  'South Africa Standard Time': 'Africa/Johannesburg',
  'Arabian Standard Time': 'Asia/Dubai',
  'Pakistan Standard Time': 'Asia/Karachi',
  'India Standard Time': 'Asia/Kolkata',
  'SE Asia Standard Time': 'Asia/Bangkok',
  'Singapore Standard Time': 'Asia/Singapore',
  'China Standard Time': 'Asia/Shanghai',
  'Taipei Standard Time': 'Asia/Taipei',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'W. Australia Standard Time': 'Australia/Perth',
  'Cen. Australia Standard Time': 'Australia/Adelaide',
  'E. Australia Standard Time': 'Australia/Brisbane',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'New Zealand Standard Time': 'Pacific/Auckland',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Alaskan Standard Time': 'America/Anchorage',
  'Pacific Standard Time': 'America/Los_Angeles',
  'US Mountain Standard Time': 'America/Phoenix',
  'Mountain Standard Time': 'America/Denver',
  'Central Standard Time': 'America/Chicago',
  'Central Standard Time (Mexico)': 'America/Mexico_City',
  'Canada Central Standard Time': 'America/Regina',
  'Eastern Standard Time': 'America/New_York',
  'SA Pacific Standard Time': 'America/Bogota',
  'Atlantic Standard Time': 'America/Halifax',
  'Newfoundland Standard Time': 'America/St_Johns',
  'E. South America Standard Time': 'America/Sao_Paulo',
  'Argentina Standard Time': 'America/Buenos_Aires'
}

export function ianaTimeZone(zone: string): string | undefined {
  const value = zone.trim()
  const candidate = WINDOWS_TIME_ZONES[value] ?? value
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate })
    return candidate
  } catch {
    return undefined
  }
}

function zoneOffset(instant: number, zone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(new Date(instant))
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === type)?.value)
  const wall = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour') % 24, part('minute'), part('second'))
  return wall - Math.floor(instant / 1_000) * 1_000
}

/** Converts a wall-clock time in an IANA zone to a UTC instant, resolving DST with the zone's own rules. */
export function zonedWallTimeToInstant(wallTime: string, zone: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?Z?$/.exec(wallTime.trim())
  if (!match) throw new Error(`The provider returned an unreadable date (${wallTime})`)
  const [, year, month, day, hour, minute, second] = match
  const wall = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second ?? 0))
  // Offsets near a DST change differ between the wall time and the instant; one correction settles it.
  const guess = zoneOffset(wall, zone)
  const corrected = zoneOffset(wall - guess, zone)
  return wall - corrected
}

export function graphDateTimeToIso(value: GraphDateTimeTimeZone, warnings: string[]) {
  const zone = ianaTimeZone(value.timeZone || 'UTC')
  if (!zone) warnings.push(`Microsoft reported an unrecognized time zone (${value.timeZone}); its times are shown as UTC.`)
  return new Date(zonedWallTimeToInstant(value.dateTime, zone ?? 'UTC')).toISOString()
}

export function isoToGraphDateTime(iso: string): GraphDateTimeTimeZone {
  // Writing in UTC keeps the instant exact regardless of the mailbox zone.
  return { dateTime: new Date(iso).toISOString().slice(0, 19), timeZone: 'UTC' }
}

const toIsoFromEpoch = (value?: string) => value && Number(value) > 0 ? new Date(Number(value)).toISOString() : undefined

export function fromGmailVacation(value: GmailVacationSettings) {
  const warnings: string[] = []
  const html = value.responseBodyHtml ?? ''
  const plain = value.responseBodyPlainText ?? ''
  if (!plain && html && hasRichFormatting(html)) warnings.push('The Gmail reply contains formatting. Saving from Aerio replaces it with plain text.')
  if (value.restrictToContacts && value.restrictToDomain) warnings.push('Gmail limits this reply to contacts inside your organization. Saving from Aerio keeps only the organization limit.')
  const settings: MailAutomaticReplySettings = {
    enabled: Boolean(value.enableAutoReply),
    startAt: toIsoFromEpoch(value.startTime),
    endAt: toIsoFromEpoch(value.endTime),
    subject: value.responseSubject ?? '',
    internalMessage: plain || replyHtmlToText(html),
    externalMessage: '',
    externalAudience: value.restrictToDomain ? 'none' : value.restrictToContacts ? 'contacts' : 'all'
  }
  if (!settings.startAt) delete settings.startAt
  if (!settings.endAt) delete settings.endAt
  return { settings, warnings }
}

export function toGmailVacation(settings: MailAutomaticReplySettings): GmailVacationSettings {
  return {
    enableAutoReply: settings.enabled,
    responseSubject: settings.subject,
    responseBodyPlainText: settings.internalMessage,
    restrictToContacts: settings.externalAudience === 'contacts',
    restrictToDomain: settings.externalAudience === 'none',
    ...(settings.startAt ? { startTime: String(Date.parse(settings.startAt)) } : {}),
    ...(settings.endAt ? { endTime: String(Date.parse(settings.endAt)) } : {})
  }
}

const graphAudience: Record<MailAutomaticReplyAudience, NonNullable<GraphAutomaticRepliesSetting['externalAudience']>> = { none: 'none', contacts: 'contactsOnly', all: 'all' }

export function fromGraphAutomaticReplies(value: GraphAutomaticRepliesSetting) {
  const warnings: string[] = []
  const internal = value.internalReplyMessage ?? ''
  const external = value.externalReplyMessage ?? ''
  if (hasRichFormatting(internal) || hasRichFormatting(external)) warnings.push('The Outlook reply contains formatting. Saving from Aerio replaces it with plain text.')
  const scheduled = value.status === 'scheduled'
  const settings: MailAutomaticReplySettings = {
    enabled: value.status === 'alwaysEnabled' || scheduled,
    subject: '',
    internalMessage: replyHtmlToText(internal),
    externalMessage: replyHtmlToText(external),
    externalAudience: value.externalAudience === 'none' ? 'none' : value.externalAudience === 'contactsOnly' ? 'contacts' : 'all'
  }
  // Exchange keeps stale schedule dates when replies are off or always on; they are not in effect.
  if (scheduled && value.scheduledStartDateTime) settings.startAt = graphDateTimeToIso(value.scheduledStartDateTime, warnings)
  if (scheduled && value.scheduledEndDateTime) settings.endAt = graphDateTimeToIso(value.scheduledEndDateTime, warnings)
  return { settings, warnings: [...new Set(warnings)] }
}

export function toGraphAutomaticReplies(settings: MailAutomaticReplySettings): GraphAutomaticRepliesSetting {
  const scheduled = Boolean(settings.startAt && settings.endAt)
  return {
    status: !settings.enabled ? 'disabled' : scheduled ? 'scheduled' : 'alwaysEnabled',
    externalAudience: graphAudience[settings.externalAudience],
    internalReplyMessage: replyTextToHtml(settings.internalMessage),
    externalReplyMessage: replyTextToHtml(settings.externalMessage),
    ...(scheduled ? { scheduledStartDateTime: isoToGraphDateTime(settings.startAt!), scheduledEndDateTime: isoToGraphDateTime(settings.endAt!) } : {})
  }
}

/** Validates renderer input before it reaches a provider and returns a normalized copy. */
export function validateAutomaticReplySettings(value: unknown, capabilities: MailAutomaticReplyCapabilities, now = Date.now()): MailAutomaticReplySettings {
  if (!value || typeof value !== 'object') throw new Error('Enter valid automatic reply settings')
  const input = value as Partial<Record<keyof MailAutomaticReplySettings, unknown>>
  if (typeof input.enabled !== 'boolean') throw new Error('Choose whether automatic replies are on')
  const text = (field: 'subject' | 'internalMessage' | 'externalMessage', limit: number) => {
    const entry = input[field] ?? ''
    if (typeof entry !== 'string' || entry.length > limit) throw new Error('The automatic reply is too long')
    return entry
  }
  const instant = (field: 'startAt' | 'endAt') => {
    const entry = input[field]
    if (entry === undefined || entry === null || entry === '') return undefined
    if (typeof entry !== 'string' || !Number.isFinite(Date.parse(entry))) throw new Error('Enter a valid start and end time')
    return new Date(entry).toISOString()
  }
  const audience = input.externalAudience
  if (typeof audience !== 'string' || !capabilities.audiences.includes(audience as MailAutomaticReplyAudience)) throw new Error('This account does not support the chosen reply audience')
  const settings: MailAutomaticReplySettings = {
    enabled: input.enabled,
    subject: capabilities.subject ? text('subject', MAX_SUBJECT_LENGTH).trim() : '',
    internalMessage: text('internalMessage', MAX_MESSAGE_LENGTH),
    externalMessage: capabilities.separateExternalMessage ? text('externalMessage', MAX_MESSAGE_LENGTH) : '',
    externalAudience: audience as MailAutomaticReplyAudience
  }
  const startAt = instant('startAt'), endAt = instant('endAt')
  if (startAt) settings.startAt = startAt
  if (endAt) settings.endAt = endAt
  if (startAt && endAt && Date.parse(endAt) <= Date.parse(startAt)) throw new Error('The end time must be after the start time')
  if (settings.enabled) {
    if (capabilities.requiresBothDates && Boolean(startAt) !== Boolean(endAt)) throw new Error('Microsoft needs both a start and an end time for a scheduled reply')
    if (endAt && Date.parse(endAt) <= now) throw new Error('The end time has already passed')
    if (!settings.internalMessage.trim()) throw new Error('Enter the automatic reply message')
    if (capabilities.separateExternalMessage && settings.externalAudience !== 'none' && !settings.externalMessage.trim()) throw new Error('Enter the reply for people outside your organization')
  }
  return settings
}

export function isAutomaticReplyPermissionError(error: unknown) {
  if (error instanceof AutomaticReplyPermissionError) return true
  if (error instanceof GmailApiError) {
    return error.status === 403 && (error.reason === 'insufficientPermissions' || /insufficient (authentication )?scopes|insufficient permission/i.test(error.message))
  }
  if (error instanceof MicrosoftGraphError) {
    return error.status === 403 || (error.status === 401 && /access.?denied|insufficient privileges/i.test(`${error.code ?? ''} ${error.message}`))
  }
  return false
}

function isMailboxUnavailable(error: unknown) {
  return error instanceof MicrosoftGraphError && /MailboxNotEnabledForRESTAPI|MailboxNotSupportedForRESTAPI|ResourceNotFound/i.test(error.code ?? '')
}

export interface AutomaticRepliesDependencies {
  account(accountId: string): Promise<{ provider: MailProviderId; email: string } | undefined>
  googleToken(accountId: string): Promise<string>
  microsoftToken(accountId: string): Promise<string>
  /** Undefined means the grant predates scope tracking; the provider response decides. */
  grantedScopes(accountId: string, provider: 'gmail' | 'microsoft'): string[] | undefined
  now?: () => number
}

function permissionMessage(provider: 'gmail' | 'microsoft', write: boolean) {
  if (provider === 'gmail') {
    return `Aerio can${write ? '' : 'not'} read this Gmail reply${write ? ' but needs the “Manage your basic mail settings” permission (gmail.settings.basic) to change it' : ''}. Reconnect the account and allow that permission on Google’s consent screen.`
  }
  return `Aerio needs the “Read and write user mailbox settings” permission (MailboxSettings.ReadWrite) to ${write ? 'change' : 'read'} Outlook automatic replies. Reconnect the account and accept the new permission. Some work or school organizations require an administrator to approve it.`
}

export class AutomaticRepliesService {
  constructor(private readonly dependencies: AutomaticRepliesDependencies) {}

  private now() {
    return this.dependencies.now?.() ?? Date.now()
  }

  private access(accountId: string, provider: 'gmail' | 'microsoft') {
    const scopes = this.dependencies.grantedScopes(accountId, provider)
    if (!scopes) return { read: true, write: true, known: false }
    const granted = new Set(scopes)
    const readScopes = provider === 'gmail' ? GMAIL_VACATION_READ_SCOPES : MICROSOFT_SETTINGS_READ_SCOPES
    const writeScope = provider === 'gmail' ? GMAIL_SETTINGS_SCOPE : MICROSOFT_SETTINGS_SCOPE
    return { read: readScopes.some((scope) => granted.has(scope)), write: granted.has(writeScope), known: true }
  }

  private async resolve(accountId: string) {
    if (typeof accountId !== 'string' || !accountId) throw new Error('Invalid account id')
    const account = await this.dependencies.account(accountId)
    if (!account) throw new Error('Account not found')
    return account
  }

  private baseState(accountId: string, provider: MailProviderId): MailAutomaticRepliesState {
    return { accountId, provider, supported: false, canRead: false, canWrite: false, needsReconnect: false, missingScopes: [], warnings: [] }
  }

  private unsupported(accountId: string, provider: MailProviderId): MailAutomaticRepliesState {
    return {
      ...this.baseState(accountId, provider),
      message: 'IMAP and SMTP have no standard way to manage out-of-office replies, so Aerio cannot read or change them for this account. Set automatic replies in your provider’s webmail or server settings (for example a Sieve vacation rule). Aerio never sends automatic replies itself.'
    }
  }

  private async readProvider(accountId: string, provider: 'gmail' | 'microsoft') {
    if (provider === 'gmail') {
      const value = await new GmailClient(accountId, this.dependencies.googleToken).getVacationSettings()
      return { ...fromGmailVacation(value), serverTimeZone: undefined as string | undefined }
    }
    const value = await new MicrosoftGraphClient(() => this.dependencies.microsoftToken(accountId)).mailboxAutomaticReplies()
    return { ...fromGraphAutomaticReplies(value.automaticRepliesSetting ?? {}), serverTimeZone: value.timeZone || undefined }
  }

  async get(accountId: string): Promise<MailAutomaticRepliesState> {
    const account = await this.resolve(accountId)
    if (account.provider !== 'gmail' && account.provider !== 'microsoft') return this.unsupported(accountId, account.provider)
    const provider = account.provider
    const access = this.access(accountId, provider)
    const writeScope = provider === 'gmail' ? GMAIL_SETTINGS_SCOPE : MICROSOFT_SETTINGS_SCOPE
    const state: MailAutomaticRepliesState = {
      ...this.baseState(accountId, provider),
      supported: true,
      capabilities: automaticReplyCapabilities(provider, account.email),
      canWrite: access.write
    }
    if (!access.read) return { ...state, needsReconnect: true, missingScopes: [writeScope], message: permissionMessage(provider, false) }
    try {
      const result = await this.readProvider(accountId, provider)
      const next: MailAutomaticRepliesState = {
        ...state,
        canRead: true,
        settings: result.settings,
        phase: automaticReplyPhase(result.settings, this.now()),
        serverTimeZone: result.serverTimeZone,
        warnings: result.warnings,
        readAt: new Date(this.now()).toISOString()
      }
      if (!access.write) return { ...next, needsReconnect: true, missingScopes: [writeScope], message: permissionMessage(provider, true) }
      return next
    } catch (error) {
      if (isAutomaticReplyPermissionError(error)) return { ...state, canWrite: false, needsReconnect: true, missingScopes: [writeScope], message: permissionMessage(provider, false) }
      if (isMailboxUnavailable(error)) return { ...state, supported: false, canWrite: false, message: 'This Microsoft account’s mailbox does not expose automatic reply settings through Microsoft Graph (for example an on-premises Exchange mailbox). Set automatic replies in Outlook instead.' }
      throw error
    }
  }

  private async write(accountId: string, change: (provider: 'gmail' | 'microsoft', email: string) => Promise<void>) {
    const account = await this.resolve(accountId)
    if (account.provider !== 'gmail' && account.provider !== 'microsoft') throw new Error('Automatic replies are not available for IMAP accounts')
    const provider = account.provider
    const writeScope = provider === 'gmail' ? GMAIL_SETTINGS_SCOPE : MICROSOFT_SETTINGS_SCOPE
    const access = this.access(accountId, provider)
    try {
      // Known-missing grants are reported without a doomed provider request.
      if (access.known && !access.write) throw new AutomaticReplyPermissionError(permissionMessage(provider, true), writeScope)
      await change(provider, account.email)
    } catch (error) {
      if (!isAutomaticReplyPermissionError(error)) throw error
      const current = await this.get(accountId).catch(() => undefined)
      return {
        ...(current ?? { ...this.baseState(accountId, provider), supported: true, capabilities: automaticReplyCapabilities(provider, account.email) }),
        canWrite: false,
        needsReconnect: true,
        missingScopes: [writeScope],
        message: permissionMessage(provider, true)
      }
    }
    // Read back so the screen shows what the provider actually stored.
    return this.get(accountId)
  }

  update(accountId: string, input: MailAutomaticReplySettings) {
    return this.write(accountId, async (provider, email) => {
      const settings = validateAutomaticReplySettings(input, automaticReplyCapabilities(provider, email), this.now())
      if (provider === 'gmail') await new GmailClient(accountId, this.dependencies.googleToken).updateVacationSettings(toGmailVacation(settings))
      else await new MicrosoftGraphClient(() => this.dependencies.microsoftToken(accountId)).updateAutomaticReplies(toGraphAutomaticReplies(settings))
    })
  }

  disable(accountId: string) {
    return this.write(accountId, async (provider) => {
      if (provider === 'microsoft') {
        await new MicrosoftGraphClient(() => this.dependencies.microsoftToken(accountId)).updateAutomaticReplies({ status: 'disabled' })
        return
      }
      // Gmail's PUT replaces the resource; keep the message and only switch it off.
      const client = new GmailClient(accountId, this.dependencies.googleToken)
      const current = await client.getVacationSettings()
      await client.updateVacationSettings({ ...current, enableAutoReply: false })
    })
  }
}

export function registerAutomaticReplies(ipc: Pick<IpcMain, 'handle'>, service: () => AutomaticRepliesService) {
  ipc.handle('mail:automatic-replies:get', (_event, accountId: string) => service().get(accountId))
  ipc.handle('mail:automatic-replies:update', (_event, accountId: string, settings: MailAutomaticReplySettings) => service().update(accountId, settings))
  ipc.handle('mail:automatic-replies:disable', (_event, accountId: string) => service().disable(accountId))
}
