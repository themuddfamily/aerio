import { describe, expect, it } from 'vitest'
import { MAIL_RULE_PRESETS, createMailRuleFromPreset } from './mail-rule-library'
import { mailRuleMatches, type MailRuleMessage } from './mail-rules'

const message: MailRuleMessage = { accountId: 'a', fromName: 'Sender', fromEmail: 'sender@example.test', to: [], cc: [], subject: 'Hello', text: '' }

describe('rule library', () => {
  it('creates independent disabled drafts without identities or server ownership', () => {
    expect(new Set(MAIL_RULE_PRESETS.map((preset) => preset.id)).size).toBe(MAIL_RULE_PRESETS.length)
    for (const preset of MAIL_RULE_PRESETS) {
      const first = createMailRuleFromPreset(preset.id, 'a')
      const second = createMailRuleFromPreset(preset.id, 'b')
      expect(first).toMatchObject({ accountId: 'a', enabled: false })
      expect(first.id).toBeUndefined()
      expect(first.execution).toBeUndefined()
      expect(first.serverRuleId).toBeUndefined()
      first.conditions[0].value = 'changed'
      first.actions[0].action = 'trash'
      first.exceptions?.push({ field: 'subject', operator: 'contains', value: 'changed' })
      expect(second).toEqual(createMailRuleFromPreset(preset.id, 'b'))
    }
    expect(() => createMailRuleFromPreset('missing', 'a')).toThrow('Unknown rule preset')
  })

  it('matches either receipt keyword without matching unrelated subjects', () => {
    const rule = createMailRuleFromPreset('receipts', 'a')
    expect(mailRuleMatches(rule, { ...message, subject: 'Your RECEIPT' })).toBe(true)
    expect(mailRuleMatches(rule, { ...message, subject: 'Invoice 42' })).toBe(true)
    expect(mailRuleMatches(rule, message)).toBe(false)
  })

  it('preserves important old messages and only archives messages over the chosen age', () => {
    const now = Date.parse('2026-10-20T12:00:00Z')
    const rule = createMailRuleFromPreset('old-mail', 'a')
    const old = { ...message, internalDate: '2026-01-01T12:00:00Z' }
    expect(mailRuleMatches(rule, old, now)).toBe(true)
    expect(mailRuleMatches(rule, { ...old, headers: { importance: ['high'] } }, now)).toBe(false)
    expect(mailRuleMatches(rule, { ...old, internalDate: '2026-10-19T12:00:00Z' }, now)).toBe(false)
    expect(createMailRuleFromPreset('sent-project', 'a').trigger).toBe('outgoing')
  })
})
