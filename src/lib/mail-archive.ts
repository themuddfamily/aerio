import type { MailProviderId } from '../mail-types'
import type { MailArchiveFrequency, MailArchiveJob, MailArchivePolicyInput } from '../mail-archive-types'

export const MAIL_ARCHIVE_MAX_DAYS = 36_500
export const MAIL_ARCHIVE_MAX_MONTHS = 1_200
export const MAIL_ARCHIVE_MAX_FOLDERS = 500
const DAY_MS = 24 * 60 * 60_000

export function defaultMailArchivePolicy(accountId: string): MailArchivePolicyInput {
  return {
    accountId,
    enabled: false,
    scope: 'account',
    folderIds: [],
    olderThan: 12,
    unit: 'months',
    frequency: 'weekly',
    exclude: { starred: true, unread: true, pinned: true, drafts: true, sent: false, folderIds: [] },
    destinationLabelId: '',
    subfolders: { perAccount: true, perYear: true, mirrorSourcePath: false },
    removal: 'trash'
  }
}

/** Messages received before the returned instant are old enough to archive. */
export function mailArchiveCutoff(policy: Pick<MailArchivePolicyInput, 'olderThan' | 'unit'>, now = new Date()) {
  if (policy.unit === 'days') return new Date(now.getTime() - policy.olderThan * DAY_MS)
  const cutoff = new Date(now.getTime())
  const day = cutoff.getUTCDate()
  cutoff.setUTCDate(1)
  cutoff.setUTCMonth(cutoff.getUTCMonth() - policy.olderThan)
  // Clamp to the last day of a shorter month (31 March minus one month is 28/29 February).
  const lastDay = new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0)).getUTCDate()
  cutoff.setUTCDate(Math.min(day, lastDay))
  return cutoff
}

export function nextMailArchiveRun(from: Date, frequency: MailArchiveFrequency) {
  if (frequency === 'daily') return new Date(from.getTime() + DAY_MS)
  if (frequency === 'weekly') return new Date(from.getTime() + 7 * DAY_MS)
  return mailArchiveCutoff({ olderThan: -1, unit: 'months' }, from)
}

/** Why permanent deletion cannot be chosen for an account, or undefined when it can. */
export function mailArchiveDeleteUnavailable(provider: MailProviderId | undefined) {
  if (provider === 'gmail') return 'Gmail permanent deletion needs full mailbox access, which Aerio does not request. Archived Gmail messages go to Trash, which Gmail empties after 30 days.'
  return undefined
}

export function mailArchiveSupported(provider: MailProviderId | undefined, archived = false) {
  return Boolean(provider) && provider !== 'local' && !archived
}

export const isFinishedMailArchiveJob = (job: Pick<MailArchiveJob, 'status'>) => job.status === 'completed' || job.status === 'cancelled' || job.status === 'failed'

const text = (value: unknown, max = 500): value is string => typeof value === 'string' && value.length > 0 && value.length <= max
const bool = (value: unknown, label: string) => {
  if (typeof value !== 'boolean') throw new Error(`Choose whether to ${label}`)
  return value
}
const folderList = (value: unknown) => {
  if (!Array.isArray(value) || value.length > MAIL_ARCHIVE_MAX_FOLDERS || !value.every((item) => text(item))) throw new Error('Choose valid folders')
  return [...new Set(value as string[])]
}

/** Validates an untrusted policy from the renderer; throws a user-facing message. */
export function validateMailArchivePolicy(input: unknown, provider?: MailProviderId): MailArchivePolicyInput {
  const value = input as Partial<MailArchivePolicyInput> | undefined
  if (!value || typeof value !== 'object') throw new Error('The archive policy is invalid')
  if (!text(value.accountId, 200)) throw new Error('Choose an account')
  if (value.scope !== 'account' && value.scope !== 'folders') throw new Error('Choose what to archive')
  const folderIds = folderList(value.folderIds ?? [])
  if (value.scope === 'folders' && !folderIds.length) throw new Error('Choose at least one folder to archive')
  if (value.unit !== 'days' && value.unit !== 'months') throw new Error('Choose days or months')
  const max = value.unit === 'days' ? MAIL_ARCHIVE_MAX_DAYS : MAIL_ARCHIVE_MAX_MONTHS
  if (typeof value.olderThan !== 'number' || !Number.isInteger(value.olderThan) || value.olderThan < 1 || value.olderThan > max) throw new Error(`Enter an age between 1 and ${max} ${value.unit}`)
  if (value.frequency !== 'daily' && value.frequency !== 'weekly' && value.frequency !== 'monthly') throw new Error('Choose how often to archive')
  if (value.removal !== 'trash' && value.removal !== 'delete') throw new Error('Choose what happens to the server copy')
  if (value.removal === 'delete') {
    const reason = mailArchiveDeleteUnavailable(provider)
    if (reason) throw new Error(reason)
  }
  const exclude = value.exclude as Partial<MailArchivePolicyInput['exclude']> | undefined
  if (!exclude || typeof exclude !== 'object') throw new Error('Choose which messages to keep')
  const subfolders = value.subfolders as Partial<MailArchivePolicyInput['subfolders']> | undefined
  if (!subfolders || typeof subfolders !== 'object') throw new Error('Choose how archived folders are organized')
  const enabled = bool(value.enabled, 'archive automatically')
  const destinationLabelId = typeof value.destinationLabelId === 'string' ? value.destinationLabelId : ''
  if (destinationLabelId.length > 500 || (enabled && !destinationLabelId)) throw new Error('Choose a Local Folders folder for archived mail')
  return {
    accountId: value.accountId,
    enabled,
    scope: value.scope,
    folderIds,
    olderThan: value.olderThan,
    unit: value.unit,
    frequency: value.frequency,
    exclude: {
      starred: bool(exclude.starred, 'keep starred or flagged messages'),
      unread: bool(exclude.unread, 'keep unread messages'),
      pinned: bool(exclude.pinned, 'keep pinned conversations'),
      drafts: bool(exclude.drafts, 'keep drafts'),
      sent: bool(exclude.sent, 'keep sent mail'),
      folderIds: folderList(exclude.folderIds ?? [])
    },
    destinationLabelId,
    subfolders: {
      perAccount: bool(subfolders.perAccount, 'add a folder per account'),
      perYear: bool(subfolders.perYear, 'add a folder per year'),
      mirrorSourcePath: bool(subfolders.mirrorSourcePath, 'mirror source folders')
    },
    removal: value.removal
  }
}

export function mailArchiveFrequencyLabel(frequency: MailArchiveFrequency) {
  return frequency === 'daily' ? 'Every day' : frequency === 'weekly' ? 'Every week' : 'Every month'
}

export function mailArchiveJobSummary(job: MailArchiveJob) {
  const parts = [`${job.done.toLocaleString()} of ${job.total.toLocaleString()} archived`]
  if (job.failed) parts.push(`${job.failed.toLocaleString()} failed`)
  if (job.skipped) parts.push(`${job.skipped.toLocaleString()} skipped`)
  const inProgress = job.pending + job.copied + job.removalQueued
  if (inProgress && job.status !== 'cancelled') parts.push(`${inProgress.toLocaleString()} in progress`)
  return parts.join(' · ')
}
