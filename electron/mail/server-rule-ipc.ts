import type { IpcMain } from 'electron'
import type { MailServerRule, MailServerRuleCapabilities, MailServerRuleUploadResult } from '../../src/mail-server-rule-types'
import type { MailLabel, MailProviderId, MailRule, MailRuleCondition, MailRuleInput } from '../../src/mail-types'
import { mailRuleConditionError } from '../../src/lib/mail-rules'
import { isMailCategoryId } from '../../src/lib/mail-categories'
import type { MailWorkerCommand } from '../mail-protocol'
import type { MailSettingsScopeStatus } from './mail-settings-scopes'
import { MailServerRuleService } from './server-rules'

const RULE_ACTIONS = new Set(['archive', 'read', 'star', 'important', 'trash', 'label', 'move', 'set-category'])

function validateConditions(value: unknown, label: string, minimum: number): MailRuleCondition[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > 10) throw new Error(minimum ? 'Add between one and ten conditions' : `Add at most ten ${label}`)
  return value.map((condition: MailRuleCondition) => {
    const error = mailRuleConditionError(condition)
    if (error) throw new Error(error)
    return {
      field: condition.field,
      operator: condition.operator,
      value: condition.value.trim(),
      ...(condition.field === 'header' ? { headerName: condition.headerName!.trim() } : {})
    }
  })
}

/** Validates a renderer rule. Execution and server links are owned by the main process, not the renderer. */
export function validateMailRule(input: MailRuleInput): MailRuleInput {
  if (!input || typeof input !== 'object') throw new Error('The rule is invalid')
  if (input.id !== undefined && (typeof input.id !== 'string' || !input.id || input.id.length > 200)) throw new Error('The rule id is invalid')
  if (typeof input.accountId !== 'string' || !input.accountId || input.accountId.length > 200) throw new Error('Choose an account for this rule')
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200) throw new Error('Give this rule a name')
  if (typeof input.enabled !== 'boolean' || !['all', 'any'].includes(input.match)) throw new Error('Choose how this rule should match')
  if (input.trigger !== undefined && !['incoming', 'outgoing', 'archive'].includes(input.trigger)) throw new Error('Choose when this rule runs')
  const conditions = validateConditions(input.conditions, 'conditions', 1)
  const exceptions = input.exceptions === undefined ? [] : validateConditions(input.exceptions, 'exceptions', 0)
  if (!Array.isArray(input.actions) || input.actions.length < 1 || input.actions.length > 10) throw new Error('Add between one and ten actions')
  for (const action of input.actions) {
    if (!action || !RULE_ACTIONS.has(action.action)) throw new Error('Choose a valid rule action')
    if ((action.action === 'label' || action.action === 'move') && (typeof action.labelId !== 'string' || !action.labelId || action.labelId.length > 500)) throw new Error('Choose a label or folder for the rule')
    if (action.action === 'set-category' && !isMailCategoryId(action.category)) throw new Error('Choose an inbox category for the rule')
  }
  const { execution: _execution, serverRuleId: _serverRuleId, ...rest } = input
  return { ...rest, name: input.name.trim(), conditions, exceptions, trigger: input.trigger ?? 'incoming' }
}

export interface ServerRuleIpcDeps {
  request(command: MailWorkerCommand): Promise<unknown>
  provider(accountId: string): MailProviderId | undefined
  accessToken(accountId: string, provider: MailProviderId): Promise<string>
  access(accountId: string, provider: MailProviderId): MailSettingsScopeStatus
  diagnostic?(event: string, accountId: string, details: Record<string, unknown>): void
  fetch?: typeof fetch
}

const validId = (value: unknown, label: string) => {
  if (typeof value !== 'string' || !value || value.length > 1_000) throw new Error(`Invalid ${label}`)
  return value
}

// Rule IPC: local rule saves keep the stored execution mode and server link,
// and the server-rule handlers are the only path that changes them.
export function registerMailRuleHandlers(ipcMain: Pick<IpcMain, 'handle'>, deps: ServerRuleIpcDeps) {
  const service = new MailServerRuleService({
    provider: deps.provider,
    accessToken: (accountId) => deps.accessToken(accountId, deps.provider(accountId) ?? 'gmail'),
    access: deps.access,
    labels: async (accountId) => await deps.request({ type: 'labels:list', payload: { accountIds: [accountId] } }) as MailLabel[],
    fetch: deps.fetch
  })
  const rules = async (accountId?: string) => {
    const value = await deps.request({ type: 'rules:list', payload: { accountIds: accountId ? [accountId] : undefined } })
    return Array.isArray(value) ? value as MailRule[] : []
  }
  const saveRule = async (input: MailRuleInput) => await deps.request({ type: 'rules:save', payload: input }) as MailRule

  ipcMain.handle('mail:rules:save', (_event, input: MailRuleInput) => {
    const valid = validateMailRule(input)
    if (!valid.id) return saveRule({ ...valid, execution: 'local' })
    return rules(valid.accountId).then((stored) => {
      const current = stored.find((rule) => rule.id === valid.id)
      return saveRule({ ...valid, execution: current?.execution ?? 'local', ...(current?.serverRuleId ? { serverRuleId: current.serverRuleId } : {}) })
    })
  })

  ipcMain.handle('mail:server-rules:capabilities', (_event, accountId: string): MailServerRuleCapabilities =>
    service.capabilities(validId(accountId, 'account')))

  ipcMain.handle('mail:server-rules:list', async (_event, accountId: string): Promise<MailServerRule[]> => {
    validId(accountId, 'account')
    return service.list(accountId, await rules(accountId))
  })

  ipcMain.handle('mail:server-rules:upload', async (_event, ruleId: string): Promise<MailServerRuleUploadResult> => {
    validId(ruleId, 'rule id')
    const rule = (await rules()).find((item) => item.id === ruleId)
    if (!rule) throw new Error('Rule not found')
    if (!rule.enabled && deps.provider(rule.accountId) === 'gmail') throw new Error('Turn the rule on before uploading it; Gmail filters can’t be turned off')
    const uploaded = await service.upload(rule)
    try {
      // From here on only the provider runs this rule.
      const saved = await saveRule({ ...rule, execution: 'server', serverRuleId: uploaded.serverRuleId })
      deps.diagnostic?.('server-rule-uploaded', rule.accountId, { provider: uploaded.mapping.provider, replaced: Boolean(rule.serverRuleId) })
      return { rule: saved, serverRule: uploaded.serverRule, mapping: uploaded.mapping }
    } catch (error) {
      // An unlinked server copy would run alongside the local rule.
      if (uploaded.serverRuleId !== rule.serverRuleId) await service.delete(rule.accountId, uploaded.serverRuleId).catch(() => undefined)
      throw error
    }
  })

  ipcMain.handle('mail:server-rules:delete', async (_event, accountId: string, serverRuleId: string) => {
    validId(accountId, 'account')
    validId(serverRuleId, 'server rule id')
    await service.delete(accountId, serverRuleId)
    // Hand a linked rule back to this computer, off, so nothing runs twice or unexpectedly.
    for (const rule of (await rules(accountId)).filter((item) => item.serverRuleId === serverRuleId)) {
      const { serverRuleId: _removed, ...local } = rule
      await saveRule({ ...local, execution: 'local', enabled: false })
    }
    deps.diagnostic?.('server-rule-deleted', accountId, { provider: deps.provider(accountId) })
  })

  ipcMain.handle('mail:server-rules:set-enabled', async (_event, accountId: string, serverRuleId: string, enabled: boolean) => {
    validId(accountId, 'account')
    validId(serverRuleId, 'server rule id')
    if (typeof enabled !== 'boolean') throw new Error('Choose whether the rule is on')
    const stored = await rules(accountId)
    const updated = await service.setEnabled(accountId, serverRuleId, enabled, stored)
    for (const rule of stored.filter((item) => item.serverRuleId === serverRuleId && item.enabled !== enabled)) await saveRule({ ...rule, enabled })
    return updated
  })
}
