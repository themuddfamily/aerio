import type {
  MailBuiltInCategory,
  MailCategoryAssignInput,
  MailCategoryAssignResult,
  MailCategoryCounts,
  MailCategoryRule,
  MailCategoryRuleInput,
  MailInboxTabsConfig
} from '../../src/mail-category-types'
import type { MailWorkerEvent } from '../../src/mail-types'
import { MAIL_CATEGORY_HEADERS, classifyMailHeuristically } from '../../src/lib/mail-categories'
import type { MailDatabase } from './database'
import { assignMailCategory } from './inbox-categories'

// Worker side of the inbox category IPC (E33).

export type InboxCategoryCommand =
  | { type: 'categories:tabs' }
  | { type: 'categories:save-tabs'; payload: MailInboxTabsConfig }
  | { type: 'categories:counts'; payload: { accountIds?: string[] } }
  | { type: 'categories:assign'; payload: MailCategoryAssignInput }
  | { type: 'categories:rules' }
  | { type: 'categories:save-rule'; payload: MailCategoryRuleInput }
  | { type: 'categories:delete-rule'; payload: { id: string } }

export type InboxCategoryResult = MailInboxTabsConfig | MailCategoryCounts | MailCategoryAssignResult | MailCategoryRule | MailCategoryRule[]

export const isInboxCategoryCommand = (command: { type: string }): command is InboxCategoryCommand => command.type.startsWith('categories:')

/** The header-based heuristic for a freshly parsed message (PostalMime header list). */
export function categoryHintFromHeaders(fromEmail: string, headers: { key: string; value: string }[] | undefined): MailBuiltInCategory {
  const wanted = new Set<string>(MAIL_CATEGORY_HEADERS)
  const values: Record<string, string[]> = {}
  for (const header of headers ?? []) {
    const key = header.key.toLowerCase()
    if (wanted.has(key)) (values[key] ??= []).push(header.value)
  }
  return classifyMailHeuristically({ fromEmail, headers: values })
}

/** Classification settings reclassify conversations in every account, so every mail view reloads. */
function changedEverywhere(database: MailDatabase, emit: (event: MailWorkerEvent) => void) {
  for (const account of database.listAccounts()) emit({ type: 'mail-changed', payload: { accountId: account.id } })
}

export function handleInboxCategoryCommand(database: MailDatabase, command: InboxCategoryCommand, emit: (event: MailWorkerEvent) => void): InboxCategoryResult | void {
  const store = database.inboxCategories
  switch (command.type) {
    case 'categories:tabs': return store.tabs()
    case 'categories:save-tabs': {
      const saved = store.saveTabs(command.payload)
      changedEverywhere(database, emit)
      return saved
    }
    case 'categories:counts': return store.counts(command.payload.accountIds)
    case 'categories:assign': {
      const result = assignMailCategory(database, command.payload)
      if (result.rule) changedEverywhere(database, emit)
      else emit({ type: 'mail-changed', payload: { accountId: command.payload.accountId, threadIds: command.payload.threadIds } })
      return result
    }
    case 'categories:rules': return store.rules()
    case 'categories:save-rule': {
      const rule = store.saveRule(command.payload)
      changedEverywhere(database, emit)
      return rule
    }
    case 'categories:delete-rule':
      store.deleteRule(command.payload.id)
      changedEverywhere(database, emit)
  }
}
