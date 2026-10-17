import type { MailQuickAction, MailQuickActionRunFailure, MailQuickActionRunResult, MailQuickActionTarget, PendingOperation } from '../../src/mail-types'
import { GMAIL_SYSTEM_DESTINATIONS, quickActionStepNeedsDestination } from '../../src/lib/mail-quick-actions'
import type { MailDatabase } from './database'

type QuickActionDatabase = Pick<MailDatabase, 'getAccount' | 'listLabels' | 'applyLocalAction'>

/**
 * Applies a Quick Action's steps, in order, to each account's selected conversations.
 * Every step is an ordinary queued mutation with the normal undo window, so Undo reverts a run step by step.
 * Account-specific destinations are checked before anything is applied; a step that still fails stops the
 * remaining steps for that account (earlier steps stay applied and undoable) while other accounts carry on.
 */
export function runMailQuickAction(database: QuickActionDatabase, quickAction: MailQuickAction, targets: MailQuickActionTarget[]) {
  const operations: PendingOperation[] = []
  const failures: MailQuickActionRunFailure[] = []
  const changed: MailQuickActionTarget[] = []
  let updatedThreads = 0
  for (const { accountId, threadIds } of targets) {
    const fail = (error: string, step?: number, appliedSteps = 0) => failures.push({ accountId, threadCount: threadIds.length, ...(step === undefined ? {} : { step }), appliedSteps, error })
    const account = database.getAccount(accountId)
    if (!account) { fail('The account is no longer connected'); continue }
    if (account.archived) { fail('Disconnected accounts are read-only'); continue }
    if (quickAction.accountId && quickAction.accountId !== accountId) {
      fail(`This quick action only applies to ${database.getAccount(quickAction.accountId)?.email ?? 'another account'}`)
      continue
    }
    const labels = new Set(database.listLabels([accountId]).map((label) => label.id))
    const invalidStep = quickAction.steps.findIndex((step) => {
      if (!quickActionStepNeedsDestination(step.action)) return false
      if (step.action !== 'move' && account.provider !== 'gmail') return true
      return !step.labelId || !(labels.has(step.labelId) || (account.provider === 'gmail' && (GMAIL_SYSTEM_DESTINATIONS as readonly string[]).includes(step.labelId)))
    })
    if (invalidStep >= 0) {
      const step = quickAction.steps[invalidStep]
      fail(step.action !== 'move' && account.provider !== 'gmail'
        ? 'This provider uses folders instead of labels'
        : `The destination “${step.labelId}” no longer exists; edit the quick action to choose another`, invalidStep)
      continue
    }
    let applied = 0
    for (const [index, step] of quickAction.steps.entries()) {
      try {
        operations.push(database.applyLocalAction({ accountId, threadIds, action: step.action, labelId: step.labelId }))
        applied += 1
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error), index, applied)
        break
      }
    }
    if (applied) changed.push({ accountId, threadIds })
    if (applied === quickAction.steps.length) updatedThreads += threadIds.length
  }
  const result: MailQuickActionRunResult = { operations, updatedThreads, failures }
  return { result, changed }
}
