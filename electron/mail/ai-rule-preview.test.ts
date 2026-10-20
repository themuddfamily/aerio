import { describe, expect, it } from 'vitest'
import { aiRulePrompt, parseAiRulePreview } from './ai-rule-preview'
import type { MailLabel } from '../../src/mail-types'

const draft = { name: 'File invoices', match: 'all', trigger: 'incoming', conditions: [{ field: 'subject', operator: 'contains', value: 'invoice' }], exceptions: [{ field: 'from', operator: 'equals', value: 'vip@example.test' }], actions: [{ action: 'move', destination: 'Receipts' }] }
const labels: MailLabel[] = [{ accountId: 'a', id: 'label-1', name: 'Receipts', type: 'user' }, { accountId: 'other', id: 'foreign', name: 'Receipts', type: 'user' }]
const parse = (value: unknown, destinations = labels) => parseAiRulePreview(JSON.stringify(value), 'a', destinations)

describe('AI rule previews', () => {
  it('resolves names locally into an inert validated draft and supports fenced JSON', () => {
    const expected = { accountId: 'a', name: 'File invoices', enabled: false, execution: 'local', trigger: 'incoming', match: 'all', conditions: draft.conditions, exceptions: draft.exceptions, actions: [{ action: 'move', labelId: 'label-1' }] }
    expect(parse(draft)).toEqual(expected)
    expect(parseAiRulePreview('```json\n' + JSON.stringify(draft) + '\n```', 'a', labels)).toEqual(expected)
    expect(parse({ ...draft, conditions: [{ field: 'label', operator: 'is', value: 'receipts' }] }).conditions[0].value).toBe('label-1')
  })

  it('rejects malformed responses, unknown properties, injected ownership, unsupported actions and invalid comparisons', () => {
    for (const response of ['not JSON', '[]', 'null', '{', 'A rule: ' + JSON.stringify(draft), 'x'.repeat(20001)]) expect(() => parseAiRulePreview(response, 'a', labels)).toThrow()
    for (const change of [
      { enabled: true }, { id: 'existing' }, { accountId: 'other' }, { execution: 'server' }, { serverRuleId: 'remote' }, { nextRunAt: 'now' },
      { actions: [{ action: 'forward', destination: 'attacker@test' }] },
      { actions: [{ action: 'move', labelId: 'foreign', destination: 'Receipts' }] },
      { actions: [{ action: 'read', destination: 'Receipts' }] },
      { conditions: [{ field: 'age', operator: 'contains', value: '1' }] },
      { conditions: [] }, { actions: [] }, { trigger: 'made-up' },
      { conditions: [{ field: 'category', operator: 'is', value: 'custom:made-up' }] },
      { actions: [{ action: 'set-category', category: 'custom:made-up' }] }
    ]) expect(() => parse({ ...draft, ...change })).toThrow()
  })

  it('requires destinations to exist unambiguously in the chosen account and disallows Sent/Drafts', () => {
    expect(() => parse(draft, labels.filter((label) => label.accountId === 'other'))).toThrow('existing')
    expect(() => parse(draft, [...labels, { accountId: 'a', id: 'duplicate', name: 'Receipts', type: 'user' }])).toThrow('unambiguous')
    expect(() => parse({ ...draft, actions: [{ action: 'move', destination: 'Sent items' }] }, [{ accountId: 'a', id: 'sent', name: 'Sent items', type: 'system' }])).toThrow('existing')
    expect(() => parse({ ...draft, actions: [{ action: 'label' }] })).toThrow('incomplete')
  })

  it('validates scheduled/Archive triggers and returns model refusal as an error', () => {
    expect(parse({ ...draft, trigger: 'archive' }).trigger).toBe('archive')
    expect(parse({ ...draft, trigger: 'periodic', schedule: { intervalMinutes: 30, folder: 'archive' } }).schedule).toEqual({ intervalMinutes: 30, folder: 'archive' })
    expect(() => parse({ ...draft, trigger: 'periodic', schedule: { intervalMinutes: 0, folder: 'inbox' } })).toThrow('interval')
    expect(() => parse({ ...draft, schedule: { intervalMinutes: 30, folder: 'inbox' } })).toThrow('without a periodic')
    expect(() => parse({ error: 'Forwarding is unsupported' })).toThrow('Forwarding is unsupported')
  })

  it('sends only the user description and static capabilities without mailbox context or tools', () => {
    const prompt = aiRulePrompt('Archive invoices older than 30 days')
    expect(prompt.user).toBe('Archive invoices older than 30 days')
    expect(prompt.system).toContain('No send, reply, forward')
    expect(prompt.system).toContain('periodic')
    expect(prompt.system).not.toContain('label-1')
    expect(prompt.system).not.toContain('vip@example.test')
    expect(prompt).not.toHaveProperty('tools')
  })
})
