import type {
  MailAccountSummary, MailActionKind, MailLabel, MailQuickAction, MailQuickActionInput, MailQuickActionRunResult,
  MailQuickActionStep, MailQuickActionTarget, MailThreadSummary
} from '../mail-types'

export const MAX_QUICK_ACTION_STEPS = 10
export const MAX_QUICK_ACTION_TARGETS = 1000

export const QUICK_ACTION_STEP_LABELS: Record<MailActionKind, string> = {
  read: 'Mark as read', unread: 'Mark as unread', star: 'Add star', unstar: 'Remove star',
  important: 'Mark important', unimportant: 'Mark not important', label: 'Apply label', unlabel: 'Remove label',
  move: 'Move to folder or label', archive: 'Archive', unarchive: 'Move to Inbox', trash: 'Move to Trash', untrash: 'Restore from Trash'
}

const STEP_KINDS = Object.keys(QUICK_ACTION_STEP_LABELS) as MailActionKind[]

export const quickActionStepNeedsDestination = (action: MailActionKind) => action === 'label' || action === 'unlabel' || action === 'move'

/** Gmail system destinations that are always valid even though they are not listed as user labels. */
export const GMAIL_SYSTEM_DESTINATIONS = ['INBOX', 'SPAM', 'TRASH'] as const

/** Destinations a step may target for an account, matching the bulk Move and Labels dialogs. */
export function quickActionDestinations(action: MailActionKind, account: Pick<MailAccountSummary, 'id' | 'provider'> | undefined, labels: MailLabel[]): MailLabel[] {
  if (!account || !quickActionStepNeedsDestination(action)) return []
  const own = labels.filter((label) => label.accountId === account.id)
  if (action !== 'move') return account.provider === 'gmail' ? own.filter((label) => label.type === 'user') : []
  if (account.provider !== 'gmail') return own.filter((label) => !/draft|sent|outbox/i.test(label.name))
  const system = (id: string, name: string): MailLabel => ({ accountId: account.id, id, name, type: 'system' })
  return [system('INBOX', 'Inbox'), ...own.filter((label) => label.type === 'user'), system('SPAM', 'Spam'), system('TRASH', 'Trash')]
}

// Shortcut slots 1-9 map to the remappable keymap commands quickActionCommandId(slot) in ./keymap.

export function describeQuickActionStep(step: MailQuickActionStep, labels: MailLabel[] = [], accountId?: string) {
  const base = QUICK_ACTION_STEP_LABELS[step.action]
  if (!step.labelId) return base
  const name = labels.find((label) => label.accountId === accountId && label.id === step.labelId)?.name
    ?? ({ INBOX: 'Inbox', SPAM: 'Spam', TRASH: 'Trash' } as Record<string, string>)[step.labelId] ?? step.labelId
  return `${base}: ${name}`
}

const optionalString = (value: unknown, message: string) => {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || value.length > 500) throw new Error(message)
  return value
}

/** Validates an untrusted Quick Action payload from the renderer. */
export function validateMailQuickAction(input: unknown): MailQuickActionInput {
  if (!input || typeof input !== 'object') throw new Error('The quick action is invalid')
  const value = input as Record<string, unknown>
  const id = optionalString(value.id, 'The quick action id is invalid')
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 80) throw new Error('Give this quick action a name of up to 80 characters')
  const accountId = optionalString(value.accountId, 'Choose a valid account for this quick action')
  if (!Array.isArray(value.steps) || !value.steps.length) throw new Error('Add at least one step')
  if (value.steps.length > MAX_QUICK_ACTION_STEPS) throw new Error(`Quick actions can have up to ${MAX_QUICK_ACTION_STEPS} steps`)
  const steps = value.steps.map((raw, index): MailQuickActionStep => {
    const step = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    if (typeof step.action !== 'string' || !STEP_KINDS.includes(step.action as MailActionKind)) throw new Error(`Step ${index + 1} has an unknown action`)
    const action = step.action as MailActionKind
    const labelId = optionalString(step.labelId, `Step ${index + 1} has an invalid destination`)
    if (!quickActionStepNeedsDestination(action)) return { action }
    if (!labelId) throw new Error(`Choose a destination for step ${index + 1}`)
    if (!accountId) throw new Error(`Step ${index + 1} uses an account-specific destination; choose an account for this quick action`)
    return { action, labelId }
  })
  let shortcut: number | undefined
  if (value.shortcut !== undefined && value.shortcut !== null && value.shortcut !== 0) {
    if (typeof value.shortcut !== 'number' || !Number.isInteger(value.shortcut) || value.shortcut < 1 || value.shortcut > 9) throw new Error('Choose a shortcut from 1 to 9')
    shortcut = value.shortcut
  }
  return {
    ...(id ? { id } : {}),
    name: value.name.trim(),
    ...(accountId ? { accountId } : {}),
    steps,
    ...(shortcut ? { shortcut } : {}),
    showInToolbar: value.showInToolbar === true
  }
}

/** Validates the conversations a Quick Action is asked to run on. */
export function validateMailQuickActionTargets(input: unknown): MailQuickActionTarget[] {
  if (!Array.isArray(input) || !input.length) throw new Error('Select at least one conversation')
  let total = 0
  const targets = input.map((raw) => {
    const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    if (typeof value.accountId !== 'string' || !value.accountId || value.accountId.length > 500) throw new Error('The selected account is invalid')
    if (!Array.isArray(value.threadIds) || !value.threadIds.length || value.threadIds.some((id) => typeof id !== 'string' || !id || id.length > 500)) throw new Error('The selected conversations are invalid')
    total += value.threadIds.length
    return { accountId: value.accountId, threadIds: [...new Set(value.threadIds as string[])] }
  })
  if (total > MAX_QUICK_ACTION_TARGETS) throw new Error(`Quick actions can run on up to ${MAX_QUICK_ACTION_TARGETS.toLocaleString()} conversations at once`)
  return targets
}

/** Groups visible conversations by account for a run request. */
export function quickActionTargets(items: Pick<MailThreadSummary, 'accountId' | 'id'>[]): MailQuickActionTarget[] {
  const groups = new Map<string, string[]>()
  for (const item of items) groups.set(item.accountId, [...(groups.get(item.accountId) ?? []), item.id])
  return [...groups].map(([accountId, threadIds]) => ({ accountId, threadIds }))
}

/** User-facing summary of a run, naming each account that was skipped or only partly updated. */
export function summarizeQuickActionRun(action: Pick<MailQuickAction, 'name' | 'steps'>, result: MailQuickActionRunResult, accounts: Pick<MailAccountSummary, 'id' | 'email'>[] = []) {
  const plural = (count: number) => `${count.toLocaleString()} conversation${count === 1 ? '' : 's'}`
  const parts: string[] = []
  if (result.updatedThreads) parts.push(`“${action.name}” applied to ${plural(result.updatedThreads)}`)
  for (const failure of result.failures) {
    const email = accounts.find((account) => account.id === failure.accountId)?.email ?? 'an account'
    const subject = `${plural(failure.threadCount)} in ${email}`
    if (failure.step === undefined) parts.push(`${subject} skipped: ${failure.error}`)
    else if (!failure.appliedSteps) parts.push(`${subject} not updated, step ${failure.step + 1} failed: ${failure.error}`)
    else parts.push(`${subject} partly updated, step ${failure.step + 1} failed after ${failure.appliedSteps} step${failure.appliedSteps === 1 ? '' : 's'} (Undo reverts them): ${failure.error}`)
  }
  return parts.join(' · ') || `“${action.name}” made no changes`
}
