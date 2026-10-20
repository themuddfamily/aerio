import type { MailLabel, MailRuleAction, MailRuleCondition, MailRuleInput } from '../../src/mail-types'
import { MAIL_RULE_FIELDS } from '../../src/lib/mail-rules'
import { MAIL_BUILT_IN_CATEGORIES } from '../../src/lib/mail-categories'
import type { AiPrompt } from './ai-provider'
import { sanitizeModelText } from './ai-prompts'
import { validateMailRule } from './server-rule-ipc'

export function aiRulePrompt(description: string): AiPrompt {
  return {
    system: [
      'Translate the user’s request into a proposed Aerio mail rule. You have no tools and cannot execute or save rules or change mail.',
      'Return one JSON object only, without commentary. If the request needs unsupported behavior or is too ambiguous, return {"error":"explain what to clarify or what is unsupported"}. Never silently substitute a different action.',
      'Schema: {"name":string,"match":"all"|"any","trigger":"incoming"|"outgoing"|"archive"|"periodic","conditions":[{"field":string,"operator":string,"value":string,"headerName"?:string}],"exceptions":[],"actions":[{"action":string,"destination"?:string,"category"?:string}],"schedule"?:{"intervalMinutes":integer,"folder":"inbox"|"archive"|"sent"|"all"}}.',
      'Use 1–10 conditions and 1–10 actions, at most 10 exceptions. Exceptions have the same schema as conditions and skip the rule if any matches. Name at most 200 characters; condition values at most 500 characters.',
      `Supported fields and comparisons: ${JSON.stringify(MAIL_RULE_FIELDS.map(({ field, operators, value }) => ({ field, operators, value })))}`,
      'Attachment values are "yes" or "no"; importance is "high", "normal", or "low"; size is whole kilobytes; age is whole days. Header conditions require headerName. Use folder/label display names as the value of label conditions.',
      `Category values: ${MAIL_BUILT_IN_CATEGORIES.join(', ')}. Only these inbox categories are supported by this generator.`,
      'Actions: archive, read, star, important, trash, label, move, set-category. label and move require destination: the exact folder/label name from the user request. set-category requires category. No send, reply, forward, delete-permanently, or create-folder action exists.',
      'Default trigger is incoming. archive means explicit Archive commands in Aerio. periodic requires schedule with intervalMinutes from 1 to 10080 and a folder scope; default scope inbox when not specified. Omit schedule for other triggers.',
      'Do not include accountId, enabled, id, execution, serverRuleId, nextRunAt, or labelId. The app owns identities, activation, execution and destinations. Do not claim anything has been saved or applied.'
    ].join('\n'),
    user: description.trim(),
    maxTokens: 2_000
  }
}

type JsonObject = Record<string, unknown>
function object(value: unknown, allowed: string[]): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new Error('The AI returned an unsupported rule format. Try a more specific description.')
  return value as JsonObject
}
const text = (value: unknown) => {
  if (typeof value !== 'string') throw new Error('The AI returned an incomplete rule. Try a more specific description.')
  return value
}

/** Strictly parses an untrusted model response into an inert, validated local draft. */
export function parseAiRulePreview(response: string, accountId: string, labels: MailLabel[]): MailRuleInput {
  if (typeof response !== 'string' || response.length > 20_000) throw new Error('The AI rule response was too large')
  const json = response.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, '$1')
  let parsed: unknown
  try { parsed = JSON.parse(json) } catch { throw new Error('The AI did not return a valid rule. Try a more specific description.') }
  const rule = object(parsed, ['name', 'match', 'trigger', 'conditions', 'exceptions', 'actions', 'schedule', 'error'])
  if (rule.error !== undefined) throw new Error(sanitizeModelText(text(rule.error), 500) || 'Describe a supported rule more specifically')
  const findLabel = (name: string, destination: boolean) => {
    const matches = labels.filter((label) => label.accountId === accountId && label.name.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase() && (!destination || !/draft|sent|outbox/i.test(label.name)))
    if (matches.length !== 1) throw new Error(`Choose an existing, unambiguous folder or label name in your description: “${sanitizeModelText(name, 100)}”`)
    return matches[0].id
  }
  const conditions = (value: unknown, optional = false): MailRuleCondition[] => {
    if (optional && value === undefined) return []
    if (!Array.isArray(value) || value.length > 10) throw new Error('The AI returned invalid rule conditions')
    return value.map((item) => {
      const condition = object(item, ['field', 'operator', 'value', 'headerName'])
      const field = text(condition.field) as MailRuleCondition['field']
      const rawValue = text(condition.value)
      if (field === 'category' && !(MAIL_BUILT_IN_CATEGORIES as readonly string[]).includes(rawValue)) throw new Error('The AI requested an unsupported inbox category')
      return { field, operator: text(condition.operator) as MailRuleCondition['operator'], value: field === 'label' ? findLabel(rawValue, false) : rawValue, ...(condition.headerName !== undefined ? { headerName: text(condition.headerName) } : {}) }
    })
  }
  if (!Array.isArray(rule.actions) || rule.actions.length > 10) throw new Error('The AI returned invalid rule actions')
  const actions: MailRuleAction[] = rule.actions.map((item) => {
    const action = object(item, ['action', 'destination', 'category'])
    const kind = text(action.action) as MailRuleAction['action']
    if (action.destination !== undefined && kind !== 'label' && kind !== 'move') throw new Error('The AI returned an unsupported destination action')
    if (action.category !== undefined && kind !== 'set-category') throw new Error('The AI returned an unsupported category action')
    if (kind === 'set-category' && !(MAIL_BUILT_IN_CATEGORIES as readonly unknown[]).includes(action.category)) throw new Error('The AI requested an unsupported inbox category')
    return { action: kind, ...(kind === 'label' || kind === 'move' ? { labelId: findLabel(text(action.destination), true) } : {}), ...(kind === 'set-category' ? { category: text(action.category) } : {}) }
  })
  const schedule = rule.schedule === undefined ? undefined : object(rule.schedule, ['intervalMinutes', 'folder'])
  if (schedule && rule.trigger !== 'periodic') throw new Error('The AI returned a schedule without a periodic trigger')
  const input: MailRuleInput = {
    accountId, name: text(rule.name), enabled: false, match: text(rule.match) as MailRuleInput['match'], trigger: rule.trigger === undefined ? 'incoming' : text(rule.trigger) as MailRuleInput['trigger'],
    conditions: conditions(rule.conditions), exceptions: conditions(rule.exceptions, true), actions,
    ...(schedule ? { schedule: { intervalMinutes: schedule.intervalMinutes as number, folder: text(schedule.folder) as NonNullable<MailRuleInput['schedule']>['folder'] } } : {})
  }
  return { ...validateMailRule(input), execution: 'local' }
}
