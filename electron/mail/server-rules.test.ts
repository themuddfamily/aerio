import { describe, expect, it, vi } from 'vitest'
import type { MailProviderId, MailRule } from '../../src/mail-types'
import { MailSettingsPermissionError, mailSettingsScopeStatus } from './mail-settings-scopes'
import { MailServerRuleError, MailServerRuleMappingError, MailServerRuleService } from './server-rules'

const json = (body: unknown, status = 200) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const rule = (overrides: Partial<MailRule> = {}): MailRule => ({
  id: 'rule-1', accountId: 'gmail-1', name: 'Newsletters', enabled: true, match: 'all',
  conditions: [{ field: 'from', operator: 'equals', value: 'news@example.com' }],
  actions: [{ action: 'archive' }], matchCount: 0, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
  ...overrides
})

function setup(options: { granted?: boolean; responses?: Array<Response | ((url: string, init: RequestInit) => Response)> } = {}) {
  const providers: Record<string, MailProviderId> = { 'gmail-1': 'gmail', 'microsoft-1': 'microsoft', 'imap-1': 'fastmail' }
  const responses = [...(options.responses ?? [])]
  const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    const next = responses.shift()
    if (!next) throw new Error(`Unexpected request ${init.method ?? 'GET'} ${url}`)
    return typeof next === 'function' ? next(url, init) : next
  })
  const service = new MailServerRuleService({
    provider: (accountId) => providers[accountId],
    accessToken: async () => 'token',
    access: (_accountId, provider) => mailSettingsScopeStatus(provider, options.granted === false ? 'Mail.ReadWrite' : 'https://www.googleapis.com/auth/gmail.settings.basic MailboxSettings.ReadWrite', 'server-rules'),
    labels: async (accountId) => [{ accountId, id: 'folder:receipts', name: 'Receipts', type: 'user' }, { accountId, id: 'Label_1', name: 'Projects', type: 'user' }],
    fetch: fetch as unknown as typeof globalThis.fetch
  })
  const calls = () => fetch.mock.calls.map(([url, init]) => `${(init as RequestInit | undefined)?.method ?? 'GET'} ${url}`)
  return { service, fetch, calls }
}

describe('server rule capabilities and permissions', () => {
  it('reports what each provider supports', () => {
    const { service } = setup()
    expect(service.capabilities('gmail-1')).toMatchObject({ supported: true, permission: 'granted', api: 'gmail-filters', updateInPlace: false, canDisable: false, outgoing: false, exceptions: true })
    expect(service.capabilities('gmail-1').conditions).not.toContain('age')
    expect(service.capabilities('microsoft-1')).toMatchObject({ supported: true, api: 'microsoft-message-rules', updateInPlace: true, canDisable: true })
    expect(service.capabilities('microsoft-1').actions).not.toContain('star')
    expect(service.capabilities('imap-1')).toMatchObject({ supported: false, permission: 'unsupported', reason: expect.stringContaining('server rules') })
    expect(() => service.capabilities('missing')).toThrow('Account not found')
  })

  it('asks for a reconnect before any request when the settings scope is missing', async () => {
    const { service, fetch } = setup({ granted: false })
    expect(service.capabilities('gmail-1')).toMatchObject({ permission: 'missing', missingScopes: ['https://www.googleapis.com/auth/gmail.settings.basic'], reason: expect.stringContaining('Reconnect') })
    await expect(service.list('gmail-1')).rejects.toBeInstanceOf(MailSettingsPermissionError)
    await expect(service.list('imap-1')).rejects.toThrow('server rules')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('turns a provider 403 into a reconnect explanation', async () => {
    const { service } = setup({ responses: [json({ error: { message: 'Request had insufficient authentication scopes.', errors: [{ reason: 'insufficientPermissions' }] } }, 403)] })
    await expect(service.list('gmail-1')).rejects.toThrow(/Reconnect the account/)
  })
})

describe('Gmail filters', () => {
  it('lists filters with label names and links to local rules', async () => {
    const { service, calls } = setup({ responses: [json({ filter: [
      { id: 'filter-1', criteria: { query: 'from:news@example.com' }, action: { addLabelIds: ['Label_1'], removeLabelIds: ['INBOX'] } },
      { id: 'filter-2', criteria: { from: 'other@example.com' }, action: { forward: 'me@example.com' } }
    ] })] })
    const rules = await service.list('gmail-1', [rule({ serverRuleId: 'filter-1', execution: 'server' })])
    expect(calls()).toEqual(['GET https://gmail.googleapis.com/gmail/v1/users/me/settings/filters'])
    expect(rules).toEqual([
      { id: 'filter-1', accountId: 'gmail-1', provider: 'gmail', name: 'Newsletters', enabled: true, conditions: ['Matches: from:news@example.com'], exceptions: [], actions: ['Apply label Projects', 'Archive'], linkedRuleId: 'rule-1' },
      expect.objectContaining({ id: 'filter-2', name: 'Gmail filter', actions: ['Forward to me@example.com'] })
    ])
    expect(rules[1]).not.toHaveProperty('linkedRuleId')
  })

  it('handles an account with no filters', async () => {
    const { service } = setup({ responses: [json({})] })
    await expect(service.list('gmail-1')).resolves.toEqual([])
  })

  it('creates a filter and replaces an earlier upload only after the new one exists', async () => {
    const { service, fetch, calls } = setup({ responses: [json({ id: 'filter-new', criteria: { query: 'from:news@example.com' }, action: { removeLabelIds: ['INBOX'] } }), json(undefined, 204)] })
    const result = await service.upload(rule({ serverRuleId: 'filter-old' }))
    expect(calls()).toEqual([
      'POST https://gmail.googleapis.com/gmail/v1/users/me/settings/filters',
      'DELETE https://gmail.googleapis.com/gmail/v1/users/me/settings/filters/filter-old'
    ])
    expect(JSON.parse(String((fetch.mock.calls[0][1] as RequestInit).body))).toEqual({ criteria: { query: 'from:news@example.com' }, action: { removeLabelIds: ['INBOX'] } })
    expect(result).toMatchObject({ serverRuleId: 'filter-new', serverRule: { id: 'filter-new', linkedRuleId: 'rule-1' }, mapping: { supported: true } })
  })

  it('tolerates an earlier filter already deleted in Gmail', async () => {
    const { service } = setup({ responses: [json({ id: 'filter-new' }), json({ error: { message: 'Not found' } }, 404)] })
    await expect(service.upload(rule({ serverRuleId: 'filter-old' }))).resolves.toMatchObject({ serverRuleId: 'filter-new' })
  })

  it('removes the new filter again when the earlier one cannot be deleted, so two copies never run', async () => {
    const { service, calls } = setup({ responses: [json({ id: 'filter-new' }), json({ error: { message: 'Backend error' } }, 400), json(undefined, 204)] })
    await expect(service.upload(rule({ serverRuleId: 'filter-old' }))).rejects.toBeInstanceOf(MailServerRuleError)
    expect(calls().at(-1)).toBe('DELETE https://gmail.googleapis.com/gmail/v1/users/me/settings/filters/filter-new')
  })

  it('refuses unsupported mappings without calling Gmail and rejects missing filter ids', async () => {
    const { service, fetch } = setup({ responses: [json({})] })
    const error = await service.upload(rule({ conditions: [{ field: 'age', operator: 'greater-than', value: '3' }] })).catch((value) => value)
    expect(error).toBeInstanceOf(MailServerRuleMappingError)
    expect(error.message).toContain('age')
    expect(error.mapping.supported).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
    await expect(service.upload(rule())).rejects.toThrow('did not return the new filter')
  })

  it('cannot disable Gmail filters but deletes them, ignoring ones already gone', async () => {
    const { service, calls } = setup({ responses: [json({ error: { message: 'gone' } }, 404)] })
    await expect(service.setEnabled('gmail-1', 'filter-1', false)).rejects.toThrow('can’t be turned off')
    await service.delete('gmail-1', 'filter-1')
    expect(calls()).toEqual(['DELETE https://gmail.googleapis.com/gmail/v1/users/me/settings/filters/filter-1'])
  })
})

describe('Microsoft inbox rules', () => {
  const microsoftRule = (overrides: Partial<MailRule> = {}) => rule({ accountId: 'microsoft-1', actions: [{ action: 'move', labelId: 'folder:receipts' }], ...overrides })

  it('lists rules across pages in sequence order', async () => {
    const { service, calls } = setup({ responses: [
      json({ value: [{ id: 'b', displayName: 'Second', sequence: 2, isEnabled: false, actions: { delete: true } }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next' }),
      json({ value: [{ id: 'a', displayName: '', sequence: 1, isEnabled: true, conditions: { subjectContains: ['x'] }, actions: { moveToFolder: 'receipts' } }] })
    ] })
    const rules = await service.list('microsoft-1', [microsoftRule({ serverRuleId: 'a' })])
    expect(calls()).toEqual(['GET https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messageRules', 'GET https://graph.microsoft.com/v1.0/next'])
    expect(rules.map((item) => [item.id, item.name, item.enabled, item.linkedRuleId])).toEqual([['a', 'Outlook rule', true, 'rule-1'], ['b', 'Second', false, undefined]])
    expect(rules[0].actions).toEqual(['Move to Receipts'])
  })

  it('creates a rule after the highest existing sequence', async () => {
    const { service, fetch, calls } = setup({ responses: [
      json({ value: [{ id: 'x', displayName: 'X', sequence: 4, isEnabled: true }] }),
      json({ id: 'rule-created', displayName: 'Newsletters', isEnabled: true })
    ] })
    const result = await service.upload(microsoftRule())
    expect(calls()).toEqual(['GET https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messageRules', 'POST https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messageRules'])
    expect(JSON.parse(String((fetch.mock.calls[1][1] as RequestInit).body))).toMatchObject({ displayName: 'Newsletters', sequence: 5, actions: { moveToFolder: 'receipts' } })
    expect(result.serverRuleId).toBe('rule-created')
  })

  it('resolves the Archive folder and updates an uploaded rule in place', async () => {
    const { service, fetch, calls } = setup({ responses: [json({ id: 'archive-id' }), json({ id: 'existing', displayName: 'Newsletters', isEnabled: true })] })
    const result = await service.upload(microsoftRule({ serverRuleId: 'existing', actions: [{ action: 'archive' }] }))
    expect(calls()).toEqual([
      'GET https://graph.microsoft.com/v1.0/me/mailFolders/archive?$select=id',
      'PATCH https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messageRules/existing'
    ])
    expect(JSON.parse(String((fetch.mock.calls[1][1] as RequestInit).body)).actions.moveToFolder).toBe('archive-id')
    expect(result).toMatchObject({ serverRuleId: 'existing', serverRule: { linkedRuleId: 'rule-1' } })
  })

  it('recreates a rule deleted in Outlook and reports a missing Archive folder', async () => {
    const recreated = setup({ responses: [json({ error: { message: 'gone' } }, 404), json({ value: [] }), json({ id: 'again' })] })
    await expect(recreated.service.upload(microsoftRule({ serverRuleId: 'existing' }))).resolves.toMatchObject({ serverRuleId: 'again' })
    const failing = setup({ responses: [json({ error: { message: 'Server busy' } }, 400)] })
    await expect(failing.service.upload(microsoftRule({ serverRuleId: 'existing' }))).rejects.toThrow('Server busy')
    const noArchive = setup({ responses: [json({})] })
    await expect(noArchive.service.upload(microsoftRule({ actions: [{ action: 'archive' }] }))).rejects.toThrow('no Archive folder')
    const noId = setup({ responses: [json({ value: [] }), json({})] })
    await expect(noId.service.upload(microsoftRule())).rejects.toThrow('did not return the new rule')
  })

  it('turns rules on and off and deletes them', async () => {
    const { service, fetch, calls } = setup({ responses: [json({ id: 'a', displayName: 'Rule', isEnabled: false }), json(undefined, 204), json({ error: { message: 'Throttled' } }, 400)] })
    await expect(service.setEnabled('microsoft-1', 'a', false, [microsoftRule({ serverRuleId: 'a' })])).resolves.toMatchObject({ id: 'a', enabled: false, linkedRuleId: 'rule-1' })
    expect(JSON.parse(String((fetch.mock.calls[0][1] as RequestInit).body))).toEqual({ isEnabled: false })
    await service.delete('microsoft-1', 'a')
    await expect(service.delete('microsoft-1', 'a')).rejects.toThrow('Throttled')
    expect(calls()[1]).toBe('DELETE https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messageRules/a')
  })
})
