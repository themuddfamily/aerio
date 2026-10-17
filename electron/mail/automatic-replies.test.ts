import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MailAutomaticReplySettings } from '../../src/mail-types'
import {
  AutomaticRepliesService,
  automaticReplyCapabilities,
  automaticReplyPhase,
  fromGmailVacation,
  fromGraphAutomaticReplies,
  graphDateTimeToIso,
  ianaTimeZone,
  registerAutomaticReplies,
  replyHtmlToText,
  replyTextToHtml,
  toGmailVacation,
  toGraphAutomaticReplies,
  validateAutomaticReplySettings,
  zonedWallTimeToInstant,
  GMAIL_SETTINGS_SCOPE,
  type AutomaticRepliesDependencies
} from './automatic-replies'

const NOW = Date.parse('2026-10-17T12:00:00Z')
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const settings = (overrides: Partial<MailAutomaticReplySettings> = {}): MailAutomaticReplySettings => ({
  enabled: true, subject: 'Away', internalMessage: 'Back on Monday', externalMessage: 'Back soon', externalAudience: 'all', ...overrides
})
const gmailScopes = ['https://www.googleapis.com/auth/gmail.modify', GMAIL_SETTINGS_SCOPE]

function service(provider: 'gmail' | 'microsoft' | 'imap', scopes: string[] | undefined, email = 'person@example.test') {
  const dependencies: AutomaticRepliesDependencies = {
    account: vi.fn(async (accountId: string) => accountId === 'account' ? { provider, email } : undefined),
    googleToken: vi.fn(async () => 'google-token'),
    microsoftToken: vi.fn(async () => 'microsoft-token'),
    grantedScopes: vi.fn(() => scopes),
    now: () => NOW
  }
  return { service: new AutomaticRepliesService(dependencies), dependencies }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('automatic reply conversion', () => {
  it('maps Gmail vacation settings, audiences, and epoch boundaries both ways', () => {
    const read = fromGmailVacation({
      enableAutoReply: true, responseSubject: 'Away', responseBodyPlainText: 'Back Monday', restrictToContacts: true,
      startTime: String(Date.parse('2026-10-20T08:00:00Z')), endTime: String(Date.parse('2026-10-27T17:00:00Z'))
    })
    expect(read.settings).toEqual({ enabled: true, subject: 'Away', internalMessage: 'Back Monday', externalMessage: '', externalAudience: 'contacts', startAt: '2026-10-20T08:00:00.000Z', endAt: '2026-10-27T17:00:00.000Z' })
    expect(read.warnings).toEqual([])
    expect(toGmailVacation(read.settings)).toEqual({
      enableAutoReply: true, responseSubject: 'Away', responseBodyPlainText: 'Back Monday', restrictToContacts: true, restrictToDomain: false,
      startTime: String(Date.parse('2026-10-20T08:00:00Z')), endTime: String(Date.parse('2026-10-27T17:00:00Z'))
    })
    expect(toGmailVacation(settings({ externalAudience: 'none' }))).toMatchObject({ restrictToDomain: true, restrictToContacts: false })
    expect(toGmailVacation(settings())).not.toHaveProperty('startTime')
  })

  it('reads HTML-only Gmail replies as text and warns before formatting is replaced', () => {
    const read = fromGmailVacation({ enableAutoReply: false, responseBodyHtml: '<p><b>Away</b> &amp; offline</p><p>Line two<br>three</p>', restrictToContacts: true, restrictToDomain: true, startTime: '0' })
    expect(read.settings).toMatchObject({ enabled: false, internalMessage: 'Away & offline\nLine two\nthree', externalAudience: 'none' })
    expect(read.settings).not.toHaveProperty('startAt')
    expect(read.warnings).toHaveLength(2)
    expect(fromGmailVacation({ responseBodyHtml: '<div>Plain<br></div>' }).warnings).toEqual([])
  })

  it('maps Microsoft status, audiences, and messages and writes schedules in UTC', () => {
    const read = fromGraphAutomaticReplies({
      status: 'scheduled', externalAudience: 'contactsOnly', internalReplyMessage: '<html><body>Away<br>Back Monday</body></html>', externalReplyMessage: 'Out',
      scheduledStartDateTime: { dateTime: '2026-10-20T09:00:00.0000000', timeZone: 'GMT Standard Time' },
      scheduledEndDateTime: { dateTime: '2026-10-27T17:00:00.0000000', timeZone: 'UTC' }
    })
    expect(read.settings).toEqual({ enabled: true, subject: '', internalMessage: 'Away\nBack Monday', externalMessage: 'Out', externalAudience: 'contacts', startAt: '2026-10-20T08:00:00.000Z', endAt: '2026-10-27T17:00:00.000Z' })
    expect(toGraphAutomaticReplies(read.settings)).toEqual({
      status: 'scheduled', externalAudience: 'contactsOnly', internalReplyMessage: 'Away<br>Back Monday', externalReplyMessage: 'Out',
      scheduledStartDateTime: { dateTime: '2026-10-20T08:00:00', timeZone: 'UTC' }, scheduledEndDateTime: { dateTime: '2026-10-27T17:00:00', timeZone: 'UTC' }
    })
    expect(toGraphAutomaticReplies(settings({ enabled: false }))).toMatchObject({ status: 'disabled' })
    expect(toGraphAutomaticReplies(settings({ externalAudience: 'none' }))).toMatchObject({ status: 'alwaysEnabled', externalAudience: 'none' })
    expect(toGraphAutomaticReplies(settings())).not.toHaveProperty('scheduledStartDateTime')
  })

  it('ignores stale Exchange schedule dates when replies are off or always on', () => {
    const stale = { scheduledStartDateTime: { dateTime: '2020-01-01T00:00:00', timeZone: 'UTC' }, scheduledEndDateTime: { dateTime: '2020-01-02T00:00:00', timeZone: 'UTC' } }
    expect(fromGraphAutomaticReplies({ status: 'alwaysEnabled', ...stale }).settings).toMatchObject({ enabled: true, externalAudience: 'all' })
    expect(fromGraphAutomaticReplies({ status: 'alwaysEnabled', ...stale }).settings).not.toHaveProperty('startAt')
    expect(fromGraphAutomaticReplies({ status: 'disabled', externalAudience: 'none', ...stale }).settings).toMatchObject({ enabled: false, externalAudience: 'none' })
    expect(fromGraphAutomaticReplies({ internalReplyMessage: '<table><tr><td>x</td></tr></table>' }).warnings).toHaveLength(1)
  })

  it('converts Windows and IANA zones across daylight-saving changes', () => {
    expect(ianaTimeZone('Pacific Standard Time')).toBe('America/Los_Angeles')
    expect(ianaTimeZone('Europe/Paris')).toBe('Europe/Paris')
    expect(ianaTimeZone('Not A Zone')).toBeUndefined()
    // Summer and winter wall times in the same zone use different offsets.
    expect(new Date(zonedWallTimeToInstant('2026-07-01T09:00:00', 'America/New_York')).toISOString()).toBe('2026-07-01T13:00:00.000Z')
    expect(new Date(zonedWallTimeToInstant('2026-12-01T09:00:00.0000000', 'America/New_York')).toISOString()).toBe('2026-12-01T14:00:00.000Z')
    expect(new Date(zonedWallTimeToInstant('2026-10-25T03:30:00', 'Europe/London')).toISOString()).toBe('2026-10-25T03:30:00.000Z')
    expect(new Date(zonedWallTimeToInstant('2026-03-29T12:00:00', 'Europe/Berlin')).toISOString()).toBe('2026-03-29T10:00:00.000Z')
    expect(() => zonedWallTimeToInstant('tomorrow', 'UTC')).toThrow('unreadable date')
    const warnings: string[] = []
    expect(graphDateTimeToIso({ dateTime: '2026-10-20T09:00:00', timeZone: 'Mars Standard Time' }, warnings)).toBe('2026-10-20T09:00:00.000Z')
    expect(warnings[0]).toContain('unrecognized time zone')
  })

  it('escapes plain text into HTML and back', () => {
    expect(replyTextToHtml('<Away> & "out"\nBack')).toBe('&lt;Away&gt; &amp; &quot;out&quot;<br>Back')
    expect(replyHtmlToText(replyTextToHtml('<Away> & "out"\nBack'))).toBe('<Away> & "out"\nBack')
    expect(replyHtmlToText('<style>p{}</style><p>Hi&nbsp;there</p>\n\n\n\n<p>Bye</p>')).toBe('Hi there\n\nBye')
    expect(replyTextToHtml('')).toBe('')
  })

  it('computes the provider phase relative to now', () => {
    expect(automaticReplyPhase(settings({ enabled: false }), NOW)).toBe('off')
    expect(automaticReplyPhase(settings(), NOW)).toBe('active')
    expect(automaticReplyPhase(settings({ startAt: '2026-10-18T00:00:00Z' }), NOW)).toBe('scheduled')
    expect(automaticReplyPhase(settings({ endAt: '2026-10-17T11:00:00Z' }), NOW)).toBe('ended')
  })

  it('offers organization-only Gmail replies only to Workspace domains', () => {
    expect(automaticReplyCapabilities('gmail', 'me@gmail.com').audiences).toEqual(['all', 'contacts'])
    expect(automaticReplyCapabilities('gmail', 'me@company.test').audiences).toEqual(['all', 'contacts', 'none'])
    expect(automaticReplyCapabilities('microsoft', 'me@company.test')).toMatchObject({ separateExternalMessage: true, requiresBothDates: true, subject: false })
  })

  it('validates input before contacting a provider', () => {
    const gmail = automaticReplyCapabilities('gmail', 'me@gmail.com')
    const microsoft = automaticReplyCapabilities('microsoft', 'me@company.test')
    expect(validateAutomaticReplySettings(settings({ subject: '  Away  ', startAt: '2026-10-18T09:00:00+01:00' }), gmail, NOW)).toEqual({
      enabled: true, subject: 'Away', internalMessage: 'Back on Monday', externalMessage: '', externalAudience: 'all', startAt: '2026-10-18T08:00:00.000Z'
    })
    expect(validateAutomaticReplySettings(settings(), microsoft, NOW).subject).toBe('')
    expect(() => validateAutomaticReplySettings(null, gmail)).toThrow('valid automatic reply')
    expect(() => validateAutomaticReplySettings({ ...settings(), enabled: 'yes' }, gmail)).toThrow('Choose whether')
    expect(() => validateAutomaticReplySettings(settings({ externalAudience: 'none' }), gmail)).toThrow('reply audience')
    expect(() => validateAutomaticReplySettings(settings({ startAt: 'soon' }), gmail)).toThrow('valid start and end')
    expect(() => validateAutomaticReplySettings(settings({ startAt: '2026-10-19T00:00:00Z', endAt: '2026-10-18T00:00:00Z' }), gmail, NOW)).toThrow('after the start')
    expect(() => validateAutomaticReplySettings(settings({ endAt: '2026-10-17T11:00:00Z' }), gmail, NOW)).toThrow('already passed')
    expect(() => validateAutomaticReplySettings(settings({ startAt: '2026-10-18T00:00:00Z' }), microsoft, NOW)).toThrow('both a start and an end')
    expect(() => validateAutomaticReplySettings(settings({ internalMessage: ' ' }), gmail, NOW)).toThrow('reply message')
    expect(() => validateAutomaticReplySettings(settings({ externalMessage: '' }), microsoft, NOW)).toThrow('outside your organization')
    expect(() => validateAutomaticReplySettings(settings({ internalMessage: 'x'.repeat(100_001) }), gmail, NOW)).toThrow('too long')
    // Turning replies off never requires a message or a future end.
    expect(validateAutomaticReplySettings(settings({ enabled: false, internalMessage: '', endAt: '2026-10-01T00:00:00Z' }), gmail, NOW).enabled).toBe(false)
  })
})

describe('AutomaticRepliesService', () => {
  it('explains that IMAP accounts have no provider automatic replies and rejects writes', async () => {
    const { service: replies } = service('imap', undefined)
    const state = await replies.get('account')
    expect(state).toMatchObject({ supported: false, canRead: false, canWrite: false, needsReconnect: false })
    expect(state.message).toContain('IMAP and SMTP have no standard way')
    await expect(replies.update('account', settings())).rejects.toThrow('not available for IMAP')
    await expect(replies.get('missing')).rejects.toThrow('Account not found')
    await expect(replies.get('')).rejects.toThrow('Invalid account id')
  })

  it('reads the active Gmail configuration with the existing grant and explains the missing write scope', async () => {
    const fetchMock = vi.fn(async () => json({ enableAutoReply: true, responseBodyPlainText: 'Away', endTime: String(Date.parse('2026-10-20T00:00:00Z')) }))
    vi.stubGlobal('fetch', fetchMock)
    const { service: replies } = service('gmail', ['https://www.googleapis.com/auth/gmail.modify'])
    const state = await replies.get('account')
    expect(fetchMock).toHaveBeenCalledWith('https://gmail.googleapis.com/gmail/v1/users/me/settings/vacation', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer google-token' }) }))
    expect(state).toMatchObject({ supported: true, canRead: true, canWrite: false, needsReconnect: true, missingScopes: [GMAIL_SETTINGS_SCOPE], phase: 'active', readAt: new Date(NOW).toISOString() })
    expect(state.message).toContain('gmail.settings.basic')

    // A known-missing write grant never sends a doomed update.
    const result = await replies.update('account', settings())
    expect(fetchMock.mock.calls.every((call) => (call as unknown as [string, RequestInit])[1]?.method === undefined)).toBe(true)
    expect(result).toMatchObject({ canWrite: false, needsReconnect: true, canRead: true })
  })

  it('writes Gmail settings and returns the read-back server state', async () => {
    const stored: Record<string, unknown> = {}
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') Object.assign(stored, JSON.parse(String(init.body)))
      return json(stored)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { service: replies } = service('gmail', gmailScopes)
    const state = await replies.update('account', settings({ startAt: '2026-10-18T08:00:00Z', endAt: '2026-10-25T17:00:00Z' }))
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'PUT' })
    expect(stored).toMatchObject({ enableAutoReply: true, responseSubject: 'Away', responseBodyPlainText: 'Back on Monday', startTime: String(Date.parse('2026-10-18T08:00:00Z')) })
    expect(state).toMatchObject({ canWrite: true, needsReconnect: false, phase: 'scheduled', settings: { startAt: '2026-10-18T08:00:00.000Z', endAt: '2026-10-25T17:00:00.000Z' } })
  })

  it('turns Gmail replies off while keeping the stored message', async () => {
    let stored: Record<string, unknown> = { enableAutoReply: true, responseSubject: 'Away', responseBodyHtml: '<b>Away</b>', restrictToContacts: true }
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') stored = JSON.parse(String(init.body))
      return json(stored)
    })
    vi.stubGlobal('fetch', fetchMock)
    const state = await service('gmail', gmailScopes).service.disable('account')
    expect(stored).toEqual({ enableAutoReply: false, responseSubject: 'Away', responseBodyHtml: '<b>Away</b>', restrictToContacts: true })
    expect(state).toMatchObject({ phase: 'off', settings: { enabled: false, internalMessage: 'Away' } })
  })

  it('detects a Gmail insufficient-scope response from a grant without recorded scopes', async () => {
    const forbidden = () => json({ error: { message: 'Request had insufficient authentication scopes.', errors: [{ reason: 'insufficientPermissions' }] } }, 403)
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'PUT' ? forbidden() : json({ enableAutoReply: false }))
    vi.stubGlobal('fetch', fetchMock)
    const { service: replies } = service('gmail', undefined)
    expect(await replies.get('account')).toMatchObject({ canRead: true, canWrite: true, needsReconnect: false })
    const state = await replies.update('account', settings())
    expect(state).toMatchObject({ canRead: true, canWrite: false, needsReconnect: true, missingScopes: [GMAIL_SETTINGS_SCOPE] })

    fetchMock.mockImplementation(async () => forbidden())
    expect(await replies.get('account')).toMatchObject({ canRead: false, needsReconnect: true })
  })

  it('surfaces non-permission Gmail errors such as a rejected organization restriction', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { message: 'Restricting to domain requires a Workspace account', errors: [{ reason: 'failedPrecondition' }] } }, 400)))
    const { service: replies } = service('gmail', gmailScopes)
    await expect(replies.update('account', settings())).rejects.toThrow('Workspace account')
  })

  it('does not call Microsoft Graph until MailboxSettings consent exists, then offers a reconnect', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { service: replies } = service('microsoft', ['Mail.ReadWrite', 'Mail.Send'])
    const state = await replies.get('account')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(state).toMatchObject({ supported: true, canRead: false, canWrite: false, needsReconnect: true, missingScopes: ['MailboxSettings.ReadWrite'] })
    expect(state.message).toContain('MailboxSettings.ReadWrite')
  })

  it('reads, updates, and disables Outlook automatic replies with read-back verification', async () => {
    let setting: Record<string, unknown> = { status: 'disabled', externalAudience: 'all', internalReplyMessage: '', externalReplyMessage: '' }
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        setting = { ...setting, ...JSON.parse(String(init.body)).automaticRepliesSetting }
        return json({})
      }
      return json({ automaticRepliesSetting: setting, timeZone: 'Pacific Standard Time' })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { service: replies } = service('microsoft', ['Mail.ReadWrite', 'MailboxSettings.ReadWrite'])
    expect(await replies.get('account')).toMatchObject({ canRead: true, canWrite: true, phase: 'off', serverTimeZone: 'Pacific Standard Time' })
    expect(fetchMock.mock.calls[0][0]).toBe('https://graph.microsoft.com/v1.0/me/mailboxSettings?$select=automaticRepliesSetting,timeZone')

    const updated = await replies.update('account', settings({ externalAudience: 'contacts', startAt: '2026-10-18T16:00:00Z', endAt: '2026-10-19T16:00:00Z' }))
    const patch = fetchMock.mock.calls.find((call) => (call as unknown as [string, RequestInit])[1]?.method === 'PATCH') as unknown as [string, RequestInit]
    expect(JSON.parse(String(patch[1].body))).toEqual({ automaticRepliesSetting: {
      status: 'scheduled', externalAudience: 'contactsOnly', internalReplyMessage: 'Back on Monday', externalReplyMessage: 'Back soon',
      scheduledStartDateTime: { dateTime: '2026-10-18T16:00:00', timeZone: 'UTC' }, scheduledEndDateTime: { dateTime: '2026-10-19T16:00:00', timeZone: 'UTC' }
    } })
    expect(updated).toMatchObject({ phase: 'scheduled', settings: { externalAudience: 'contacts', startAt: '2026-10-18T16:00:00.000Z' } })

    const disabled = await replies.disable('account')
    const lastPatch = fetchMock.mock.calls.filter((call) => (call as unknown as [string, RequestInit])[1]?.method === 'PATCH').at(-1) as unknown as [string, RequestInit]
    expect(JSON.parse(String(lastPatch[1].body))).toEqual({ automaticRepliesSetting: { status: 'disabled' } })
    expect(disabled).toMatchObject({ phase: 'off', settings: { enabled: false, internalMessage: 'Back on Monday' } })
  })

  it('maps Graph access-denied and unavailable-mailbox responses', async () => {
    const fetchMock = vi.fn(async () => json({ error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } }, 403))
    vi.stubGlobal('fetch', fetchMock)
    const { service: replies } = service('microsoft', undefined)
    expect(await replies.get('account')).toMatchObject({ supported: true, canRead: false, needsReconnect: true })
    expect(await replies.disable('account')).toMatchObject({ canWrite: false, needsReconnect: true, missingScopes: ['MailboxSettings.ReadWrite'] })

    fetchMock.mockImplementation(async () => json({ error: { code: 'MailboxNotEnabledForRESTAPI', message: 'REST API is not yet supported for this mailbox.' } }, 404))
    const unavailable = await replies.get('account')
    expect(unavailable).toMatchObject({ supported: false })
    expect(unavailable.message).toContain('on-premises')

    fetchMock.mockImplementation(async () => json({ error: { code: 'BadRequest', message: 'Invalid schedule' } }, 400))
    await expect(replies.get('account')).rejects.toThrow('Invalid schedule')
  })

  it('registers exact IPC channels', async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>()
    const instance = { get: vi.fn(async () => 'got'), update: vi.fn(async () => 'updated'), disable: vi.fn(async () => 'disabled') }
    registerAutomaticReplies({ handle: (channel: string, handler: any) => { handlers.set(channel, handler) } } as any, () => instance as any)
    await expect(handlers.get('mail:automatic-replies:get')!({}, 'account')).resolves.toBe('got')
    await expect(handlers.get('mail:automatic-replies:update')!({}, 'account', settings())).resolves.toBe('updated')
    await expect(handlers.get('mail:automatic-replies:disable')!({}, 'account')).resolves.toBe('disabled')
    expect(instance.update).toHaveBeenCalledWith('account', settings())
  })
})
