import type { IpcMain } from 'electron'
import type { MailCategoryAssignInput, MailInboxTabsConfig } from '../../src/mail-category-types'
import { isMailCategoryId, normalizeInboxTabs, validateCategoryRuleInput } from '../../src/lib/mail-categories'
import type { MailWorkerCommand, MailWorkerResult } from '../mail-protocol'

interface InboxCategoryWorker {
  request<T extends MailWorkerResult = void>(command: MailWorkerCommand): Promise<T>
}

const text = (value: unknown, max = 500): value is string => typeof value === 'string' && value.length > 0 && value.length <= max

function accountIds(value: unknown) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 200 || !value.every((item) => text(item, 200))) throw new Error('Choose valid mail accounts')
  return [...value] as string[]
}

export function validateTabsInput(value: unknown): MailInboxTabsConfig {
  return normalizeInboxTabs(value)
}

export function validateAssignInput(value: unknown): MailCategoryAssignInput {
  const input = value as Partial<MailCategoryAssignInput> | undefined
  if (!input || typeof input !== 'object' || !text(input.accountId, 200)) throw new Error('Choose a valid mail account')
  if (!Array.isArray(input.threadIds) || !input.threadIds.length || input.threadIds.length > 500 || !input.threadIds.every((id) => text(id))) throw new Error('Choose up to 500 conversations')
  if (input.category !== undefined && !isMailCategoryId(input.category)) throw new Error('Choose an inbox tab')
  if (input.remember !== undefined && input.remember !== 'address' && input.remember !== 'domain') throw new Error('Choose to remember the sender or the domain')
  if (input.remember && input.category === undefined) throw new Error('Choose a tab to remember for this sender')
  return {
    accountId: input.accountId,
    threadIds: [...input.threadIds],
    ...(input.category ? { category: input.category } : {}),
    ...(input.remember ? { remember: input.remember } : {})
  }
}

/** Inbox category tabs and classification rules (E33). Every payload is validated before it reaches the mail worker. */
export function registerMailInboxCategories(options: { ipcMain: Pick<IpcMain, 'handle'>; worker(): InboxCategoryWorker }) {
  const { ipcMain, worker } = options
  ipcMain.handle('mail:categories:tabs', () => worker().request({ type: 'categories:tabs' }))
  ipcMain.handle('mail:categories:save-tabs', (_event, config: unknown) =>
    worker().request({ type: 'categories:save-tabs', payload: validateTabsInput(config) }))
  ipcMain.handle('mail:categories:counts', (_event, ids?: unknown) =>
    worker().request({ type: 'categories:counts', payload: { accountIds: accountIds(ids) } }))
  ipcMain.handle('mail:categories:assign', (_event, input: unknown) =>
    worker().request({ type: 'categories:assign', payload: validateAssignInput(input) }))
  ipcMain.handle('mail:categories:rules', () => worker().request({ type: 'categories:rules' }))
  ipcMain.handle('mail:categories:save-rule', (_event, input: unknown) =>
    worker().request({ type: 'categories:save-rule', payload: validateCategoryRuleInput(input) }))
  ipcMain.handle('mail:categories:delete-rule', (_event, id: unknown) => {
    if (!text(id, 200)) throw new Error('Choose a valid classification rule')
    return worker().request({ type: 'categories:delete-rule', payload: { id } })
  })
}
