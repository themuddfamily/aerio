import { describe, expect, it, vi } from 'vitest'
import type { MailRule, MailRuleInput } from '../../src/mail-types'
import { mailSettingsScopeStatus } from './mail-settings-scopes'
import { registerMailRuleHandlers, validateMailRule } from './server-rule-ipc'

const json = (body: unknown, status = 200) => new Response(body === undefined ? null : JSON.stringify(body), { status })

const stored = (overrides: Partial<MailRule> = {}): MailRule => ({
  id: 'rule-1', accountId: 'gmail-1', name: 'Newsletters', enabled: true, match: 'all',
  conditions: [{ field: 'from', operator: 'equals', value: 'news@example.com' }], actions: [{ action: 'archive' }],
  exceptions: [], trigger: 'incoming', execution: 'local', matchCount: 0, createdAt: '', updatedAt: '',
  ...overrides
})

function setup(rules: MailRule[], responses: Response[] = [], failSave = false) {
  const handlers = new Map<string, (...args: any[]) => any>()
  const saved: MailRuleInput[] = []
  const request = vi.fn(async (command: any) => {
    if (command.type === 'rules:list') return rules
    if (command.type === 'labels:list') return []
    if (command.type === 'rules:save') {
      if (failSave && command.payload.execution === 'server') throw new Error('Database locked')
      saved.push(command.payload)
      return { ...stored(), ...command.payload }
    }
    throw new Error(`Unexpected ${command.type}`)
  })
  const queue = [...responses]
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => queue.shift() ?? json({}))
  const diagnostic = vi.fn()
  registerMailRuleHandlers({ handle: (channel: string, handler: any) => handlers.set(channel, handler) } as any, {
    request,
    provider: (accountId) => accountId.startsWith('gmail') ? 'gmail' : accountId.startsWith('microsoft') ? 'microsoft' : 'imap',
    accessToken: async () => 'token',
    access: (_accountId, provider) => mailSettingsScopeStatus(provider, 'https://www.googleapis.com/auth/gmail.settings.basic MailboxSettings.ReadWrite', 'server-rules'),
    diagnostic,
    fetch: fetch as any
  })
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args)
  return { invoke, saved, fetch, request, diagnostic }
}

describe('mail rule IPC validation', () => {
  const base: MailRuleInput = { accountId: 'gmail-1', name: ' Rule ', enabled: true, match: 'all', conditions: [{ field: 'subject', operator: 'contains', value: ' x ' }], actions: [{ action: 'archive' }] }

  it('normalizes advanced conditions, exceptions, and triggers and strips renderer-supplied execution', () => {
    expect(validateMailRule({
      ...base, trigger: 'outgoing', execution: 'server', serverRuleId: 'forged',
      conditions: [{ field: 'header', headerName: ' List-Id ', operator: 'contains', value: ' list ' }, { field: 'subject', operator: 'contains', value: 'x', headerName: 'ignored' }],
      exceptions: [{ field: 'size', operator: 'greater-than', value: '10' }]
    })).toEqual({
      accountId: 'gmail-1', name: 'Rule', enabled: true, match: 'all', trigger: 'outgoing', actions: [{ action: 'archive' }],
      conditions: [{ field: 'header', headerName: 'List-Id', operator: 'contains', value: 'list' }, { field: 'subject', operator: 'contains', value: 'x' }],
      exceptions: [{ field: 'size', operator: 'greater-than', value: '10' }]
    })
    expect(validateMailRule(base)).toMatchObject({ trigger: 'incoming', exceptions: [] })
  })

  it.each([
    [{ trigger: 'sent' }, 'Choose when this rule runs'],
    [{ exceptions: 'bad' }, 'Add at most ten exceptions'],
    [{ exceptions: Array.from({ length: 11 }, () => base.conditions[0]) }, 'Add at most ten exceptions'],
    [{ exceptions: [{ field: 'age', operator: 'is', value: '1' }] }, 'Finish every rule condition'],
    [{ conditions: [{ field: 'importance', operator: 'is', value: 'urgent' }] }, 'Choose an importance level']
  ])('rejects %j', (change, message) => {
    expect(() => validateMailRule({ ...base, ...change } as MailRuleInput)).toThrow(message)
  })
})

describe('mail rule and server rule IPC', () => {
  it('keeps the stored execution mode when a rule is edited and forces new rules local', async () => {
    const { invoke, saved } = setup([stored({ execution: 'server', serverRuleId: 'filter-1' })])
    await invoke('mail:rules:save', { ...stored(), name: 'Renamed', execution: 'local' })
    expect(saved[0]).toMatchObject({ id: 'rule-1', name: 'Renamed', execution: 'server', serverRuleId: 'filter-1' })
    await invoke('mail:rules:save', { ...stored(), id: undefined, execution: 'server', serverRuleId: 'forged' })
    expect(saved[1]).toMatchObject({ execution: 'local' })
    expect(saved[1]).not.toHaveProperty('serverRuleId')
    await invoke('mail:rules:save', { ...stored(), id: 'unknown' })
    expect(saved[2]).toMatchObject({ execution: 'local' })
  })

  it('uploads a rule and switches it to server execution', async () => {
    const { invoke, saved, diagnostic } = setup([stored()], [json({ id: 'filter-1' })])
    const result = await invoke('mail:server-rules:upload', 'rule-1')
    expect(saved).toEqual([expect.objectContaining({ id: 'rule-1', execution: 'server', serverRuleId: 'filter-1' })])
    expect(result).toMatchObject({ rule: { execution: 'server' }, serverRule: { id: 'filter-1' }, mapping: { supported: true } })
    expect(diagnostic).toHaveBeenCalledWith('server-rule-uploaded', 'gmail-1', { provider: 'gmail', replaced: false })
  })

  it('removes a fresh server copy when linking it locally fails', async () => {
    const { invoke, fetch } = setup([stored()], [json({ id: 'filter-1' }), json(undefined, 204)], true)
    await expect(invoke('mail:server-rules:upload', 'rule-1')).rejects.toThrow('Database locked')
    expect(fetch.mock.calls.at(-1)?.[0]).toContain('/settings/filters/filter-1')
    expect((fetch.mock.calls.at(-1)?.[1] as RequestInit).method).toBe('DELETE')
  })

  it('refuses missing rules, invalid ids, and disabled Gmail uploads', async () => {
    const { invoke, fetch } = setup([stored({ enabled: false })])
    await expect(invoke('mail:server-rules:upload', 'missing')).rejects.toThrow('Rule not found')
    await expect(invoke('mail:server-rules:upload', '')).rejects.toThrow('Invalid rule id')
    await expect(invoke('mail:server-rules:upload', 'rule-1')).rejects.toThrow('Turn the rule on')
    expect(() => invoke('mail:server-rules:capabilities', 3)).toThrow('Invalid account')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('lists server rules and reports capabilities', async () => {
    const { invoke } = setup([stored({ execution: 'server', serverRuleId: 'filter-1' })], [json({ filter: [{ id: 'filter-1' }] })])
    expect(invoke('mail:server-rules:capabilities', 'gmail-1')).toMatchObject({ supported: true, permission: 'granted' })
    await expect(invoke('mail:server-rules:list', 'gmail-1')).resolves.toEqual([expect.objectContaining({ id: 'filter-1', linkedRuleId: 'rule-1' })])
  })

  it('returns a linked rule to local execution, turned off, when its server copy is deleted', async () => {
    const { invoke, saved } = setup([stored({ execution: 'server', serverRuleId: 'filter-1' }), stored({ id: 'rule-2' })], [json(undefined, 204)])
    await invoke('mail:server-rules:delete', 'gmail-1', 'filter-1')
    expect(saved).toEqual([expect.objectContaining({ id: 'rule-1', execution: 'local', enabled: false })])
    expect(saved[0]).not.toHaveProperty('serverRuleId')
    await expect(invoke('mail:server-rules:delete', 'gmail-1', '')).rejects.toThrow('Invalid server rule id')
  })

  it('mirrors Outlook on/off state onto the linked local rule', async () => {
    const { invoke, saved } = setup([stored({ accountId: 'microsoft-1', execution: 'server', serverRuleId: 'rule-a' })], [json({ id: 'rule-a', displayName: 'Newsletters', isEnabled: false })])
    await expect(invoke('mail:server-rules:set-enabled', 'microsoft-1', 'rule-a', false)).resolves.toMatchObject({ enabled: false, linkedRuleId: 'rule-1' })
    expect(saved).toEqual([expect.objectContaining({ id: 'rule-1', enabled: false, execution: 'server' })])
    await expect(invoke('mail:server-rules:set-enabled', 'microsoft-1', 'rule-a', 'no')).rejects.toThrow('Choose whether')
  })
})
