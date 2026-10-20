import type { MailRuleInput } from '../mail-types'

export interface MailRulePreset {
  id: string
  name: string
  description: string
  guidance: string
  rule: Pick<MailRuleInput, 'match' | 'conditions' | 'exceptions' | 'actions' | 'trigger'>
}

/** Starter rules are drafts, never saved or executed by selecting a preset. */
export const MAIL_RULE_PRESETS: readonly MailRulePreset[] = [
  {
    id: 'vip', name: 'Highlight a sender', description: 'Star mail from someone important.',
    guidance: 'Enter the sender’s email address. Adjust the actions, then enable and save the rule.',
    rule: { match: 'all', conditions: [{ field: 'from', operator: 'equals', value: '' }], actions: [{ action: 'star' }, { action: 'important' }] }
  },
  {
    id: 'newsletters', name: 'File newsletters', description: 'Move messages with an unsubscribe header to a folder or label.',
    guidance: 'Choose a destination. This matches List-Unsubscribe headers beginning with <; adjust the header match for your mailing lists.',
    rule: { match: 'all', conditions: [{ field: 'header', headerName: 'List-Unsubscribe', operator: 'starts-with', value: '<' }], actions: [{ action: 'move', labelId: '' }] }
  },
  {
    id: 'receipts', name: 'Organize receipts and invoices', description: 'File messages whose subjects contain receipt or invoice.',
    guidance: 'Choose a destination and adjust the subject words to suit your receipts.',
    rule: { match: 'any', conditions: [{ field: 'subject', operator: 'contains', value: 'receipt' }, { field: 'subject', operator: 'contains', value: 'invoice' }], actions: [{ action: 'label', labelId: '' }] }
  },
  {
    id: 'attachments', name: 'Collect attachments', description: 'Label incoming messages that have attachments.',
    guidance: 'Choose a destination label or folder. Add a sender or subject condition to narrow the match if needed.',
    rule: { match: 'all', conditions: [{ field: 'has-attachment', operator: 'is', value: 'yes' }], actions: [{ action: 'label', labelId: '' }] }
  },
  {
    id: 'old-mail', name: 'Archive older mail', description: 'Archive messages older than 90 days, except important mail.',
    guidance: 'Adjust the age. After enabling and saving, use Run on existing Inbox to tidy older mail; new mail usually will not match.',
    rule: { match: 'all', conditions: [{ field: 'age', operator: 'greater-than', value: '90' }], exceptions: [{ field: 'importance', operator: 'is', value: 'high' }], actions: [{ action: 'archive' }] }
  },
  {
    id: 'large-mail', name: 'Flag large messages', description: 'Star messages larger than 10 MB for review.',
    guidance: 'The size is in kilobytes. Adjust the threshold and actions before enabling.',
    rule: { match: 'all', conditions: [{ field: 'size', operator: 'greater-than', value: '10240' }], actions: [{ action: 'star' }] }
  },
  {
    id: 'sent-project', name: 'File sent project mail', description: 'Label mail you send with a matching project subject.',
    guidance: 'Enter the project word or tag and choose a destination. This rule processes synced Sent copies.',
    rule: { trigger: 'outgoing', match: 'all', conditions: [{ field: 'subject', operator: 'contains', value: '' }], actions: [{ action: 'label', labelId: '' }] }
  },
  {
    id: 'notifications', name: 'Read routine notifications', description: 'Mark messages from a chosen notification sender as read.',
    guidance: 'Enter the notification sender’s email address. Add conditions or exceptions if some messages need your attention.',
    rule: { match: 'all', conditions: [{ field: 'from', operator: 'equals', value: '' }], actions: [{ action: 'read' }] }
  }
]

/** Each selection owns its conditions/actions, so editing one never changes the library. */
export function createMailRuleFromPreset(id: string, accountId: string): MailRuleInput {
  const preset = MAIL_RULE_PRESETS.find((item) => item.id === id)
  if (!preset) throw new Error('Unknown rule preset')
  return {
    accountId, name: preset.name, enabled: false, trigger: 'incoming',
    ...preset.rule,
    conditions: preset.rule.conditions.map((condition) => ({ ...condition })),
    exceptions: (preset.rule.exceptions ?? []).map((condition) => ({ ...condition })),
    actions: preset.rule.actions.map((action) => ({ ...action }))
  }
}
