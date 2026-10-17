import type { MailFolder } from '../mail-types'
import type {
  MailDownloadMode,
  MailFolderOfflineOverride,
  MailFolderViewExtension,
  MailOfflineContentState,
  MailOfflinePolicy,
  MailSyncWindow
} from '../offline-sync-types'

/** Existing accounts keep downloading everything until the user chooses otherwise. */
export const DEFAULT_OFFLINE_POLICY: MailOfflinePolicy = { downloadMode: 'full', window: { unit: 'all', amount: 0 } }
/** "Load all" lifts a folder's window for this long; the next sync after that may reclaim the extra bodies. */
export const LOAD_ALL_DURATION_MS = 24 * 60 * 60_000
export const MAX_WINDOW_DAYS = 3650
export const MAX_WINDOW_MONTHS = 120
export const NOT_DOWNLOADED_NOTICE = 'Not downloaded — connect to load'

export const MODE_RANK: Record<MailDownloadMode, number> = { headers: 0, bodies: 1, full: 2 }
export const STATE_RANK: Record<MailOfflineContentState, number> = { headers: 0, body: 1, full: 2 }

export const stateForMode = (mode: MailDownloadMode): MailOfflineContentState => mode === 'full' ? 'full' : mode === 'bodies' ? 'body' : 'headers'

/** True when the stored content already contains what the mode asks for. */
export const stateSatisfies = (state: MailOfflineContentState, mode: MailDownloadMode) => STATE_RANK[state] >= MODE_RANK[mode]

/** Folder roles that every provider adds to a message's labels, so an override can follow e.g. "Inbox" across providers. */
export const ROLE_LOCATIONS = ['INBOX', 'SENT', 'DRAFT', 'SPAM', 'TRASH'] as const
/** Flags are not places a message is stored in. */
const NON_LOCATION_LABELS = new Set(['UNREAD', 'STARRED', 'IMPORTANT'])

const ROLE_FOR_FOLDER: Partial<Record<MailFolder, string>> = { inbox: 'INBOX', sent: 'SENT', drafts: 'DRAFT', spam: 'SPAM', trash: 'TRASH' }

/** The policy location a message-list view belongs to; '' is the whole account. */
export function folderViewLocation(folder: MailFolder, labelId?: string) {
  if (labelId) return labelId
  return ROLE_FOR_FOLDER[folder] ?? ''
}

export function messageLocations(labelIds: readonly string[]) {
  const locations = labelIds.filter((label) => label && !NON_LOCATION_LABELS.has(label) && !label.startsWith('keyword:') && !label.startsWith('category:'))
  return locations.length ? [...new Set(locations)] : ['']
}

const isMode = (value: unknown): value is MailDownloadMode => value === 'full' || value === 'bodies' || value === 'headers'

export function normalizeDownloadMode(value: unknown): MailDownloadMode {
  if (!isMode(value)) throw new Error('Choose what to download for offline use')
  return value
}

export function normalizeWindow(value: unknown): MailSyncWindow {
  const input = value as Partial<MailSyncWindow> | undefined
  if (!input || typeof input !== 'object') throw new Error('Choose how much mail to synchronize')
  if (input.unit === 'all') return { unit: 'all', amount: 0 }
  if (input.unit !== 'days' && input.unit !== 'months') throw new Error('Choose how much mail to synchronize')
  const max = input.unit === 'days' ? MAX_WINDOW_DAYS : MAX_WINDOW_MONTHS
  const amount = Number(input.amount)
  if (!Number.isInteger(amount) || amount < 1 || amount > max) throw new Error(`Enter between 1 and ${max} ${input.unit}`)
  return { unit: input.unit, amount }
}

export function normalizePolicy(value: unknown): MailOfflinePolicy {
  const input = value as Partial<MailOfflinePolicy> | undefined
  if (!input || typeof input !== 'object') throw new Error('Choose an offline download policy')
  return { downloadMode: normalizeDownloadMode(input.downloadMode), window: normalizeWindow(input.window) }
}

export function normalizeOverride(value: unknown): { downloadMode?: MailDownloadMode; window?: MailSyncWindow } {
  const input = value as { downloadMode?: unknown; window?: unknown } | undefined
  if (!input || typeof input !== 'object') throw new Error('Choose a folder override')
  const result: { downloadMode?: MailDownloadMode; window?: MailSyncWindow } = {}
  if (input.downloadMode !== undefined) result.downloadMode = normalizeDownloadMode(input.downloadMode)
  if (input.window !== undefined) result.window = normalizeWindow(input.window)
  if (!result.downloadMode && !result.window) throw new Error('Choose a download mode or date window for this folder, or use the account default')
  return result
}

/** "Load more" widens a window by its own length per step: 30 days, then 60, then 90… */
export function scaledWindow(window: MailSyncWindow, extraSteps: number): MailSyncWindow {
  if (window.unit === 'all' || extraSteps <= 0) return window
  const max = window.unit === 'days' ? MAX_WINDOW_DAYS : MAX_WINDOW_MONTHS
  const amount = window.amount * (1 + extraSteps)
  return amount >= max ? { unit: 'all', amount: 0 } : { unit: window.unit, amount }
}

export function windowStart(window: MailSyncWindow, now = new Date()): Date | undefined {
  if (window.unit === 'all') return undefined
  const start = new Date(now.getTime())
  if (window.unit === 'days') start.setUTCDate(start.getUTCDate() - window.amount)
  else start.setUTCMonth(start.getUTCMonth() - window.amount)
  return start
}

export function windowsEqual(left: MailSyncWindow, right: MailSyncWindow) {
  return left.unit === right.unit && (left.unit === 'all' || left.amount === right.amount)
}

export function describeWindow(window: MailSyncWindow) {
  if (window.unit === 'all') return 'All mail'
  if (window.unit === 'days') return window.amount === 1 ? 'Last day' : `Last ${window.amount} days`
  return window.amount === 1 ? 'Last month' : window.amount % 12 === 0 ? `Last ${window.amount / 12} year${window.amount === 12 ? '' : 's'}` : `Last ${window.amount} months`
}

export const DOWNLOAD_MODE_LABELS: Record<MailDownloadMode, { title: string; detail: string }> = {
  full: { title: 'Full offline content', detail: 'Original messages and attachments are stored on this computer. Uses the most disk space; everything opens and searches offline.' },
  bodies: { title: 'Messages without attachments', detail: 'Message text is stored; attachments download when you open them. Attachment contents are not searchable until opened.' },
  headers: { title: 'Headers only', detail: 'Only sender, subject and date are stored. Each message downloads when you open it; offline search covers headers only.' }
}

export interface OfflinePolicyContext {
  defaults: MailOfflinePolicy
  overrides: Pick<MailFolderOfflineOverride, 'labelId' | 'downloadMode' | 'window'>[]
  extensions: MailFolderViewExtension[]
  now?: Date
}

export interface ResolvedOfflinePolicy {
  policy: MailOfflinePolicy
  /** Undefined when all mail is in scope. */
  start?: Date
  extraSteps: number
  loadAllUntil?: string
}

/** Resolves the effective policy for one location (a label/folder id, a folder role, or '' for the account). */
export function resolveLocationPolicy(context: OfflinePolicyContext, location: string): ResolvedOfflinePolicy {
  const now = context.now ?? new Date()
  const override = location ? context.overrides.find((item) => item.labelId === location) : undefined
  const base: MailOfflinePolicy = {
    downloadMode: override?.downloadMode ?? context.defaults.downloadMode,
    window: override?.window ?? context.defaults.window
  }
  const extensions = context.extensions.filter((item) => item.labelId === '' || item.labelId === location)
  const extraSteps = Math.max(0, ...extensions.map((item) => item.extraSteps))
  const loadAllUntil = extensions.map((item) => item.loadAllUntil).filter((value): value is string => Boolean(value) && Date.parse(value!) > now.getTime()).sort().at(-1)
  const window = loadAllUntil ? { unit: 'all' as const, amount: 0 } : scaledWindow(base.window, extraSteps)
  return { policy: { downloadMode: base.downloadMode, window }, start: windowStart(window, now), extraSteps, ...(loadAllUntil ? { loadAllUntil } : {}) }
}

export type MailWantedContent = MailDownloadMode | 'outside'

/**
 * What a message's locations ask to keep. A message in several places (Gmail
 * labels, IMAP copies) keeps the most complete content any of them wants; it
 * is outside the scope only when every location's window excludes it.
 */
export function wantedContent(context: OfflinePolicyContext, date: string, labelIds: readonly string[]): MailWantedContent {
  const time = Date.parse(date)
  let wanted: MailWantedContent = 'outside'
  for (const location of messageLocations(labelIds)) {
    const resolved = resolveLocationPolicy(context, location)
    if (resolved.start && Number.isFinite(time) && time < resolved.start.getTime()) continue
    wanted = combineWanted([wanted, resolved.policy.downloadMode])
  }
  return wanted
}

export function combineWanted(values: readonly MailWantedContent[]): MailWantedContent {
  let best: MailWantedContent = 'outside'
  for (const value of values) {
    if (value === 'outside') continue
    if (best === 'outside' || MODE_RANK[value] > MODE_RANK[best]) best = value
  }
  return best
}

/** The earliest window start of any location the account may use; undefined when some location keeps all mail. */
export function earliestStart(context: OfflinePolicyContext, locations: readonly string[] = []): Date | undefined {
  const candidates = new Set<string>(['', ...context.overrides.map((item) => item.labelId), ...context.extensions.map((item) => item.labelId), ...locations])
  let earliest: Date | undefined
  for (const location of candidates) {
    const { start } = resolveLocationPolicy(context, location)
    if (!start) return undefined
    if (!earliest || start < earliest) earliest = start
  }
  return earliest
}

/** The earliest start among specific locations (one provider folder's labels); undefined when any keeps all mail. */
export function startForLocations(context: OfflinePolicyContext, locations: readonly string[]): Date | undefined {
  let earliest: Date | undefined
  for (const location of locations.length ? locations : ['']) {
    const { start } = resolveLocationPolicy(context, location)
    if (!start) return undefined
    if (!earliest || start < earliest) earliest = start
  }
  return earliest
}

/** The strongest download mode any location uses. */
export function strongestMode(context: OfflinePolicyContext): MailDownloadMode {
  const modes = [context.defaults.downloadMode, ...context.overrides.map((item) => item.downloadMode).filter(isMode)]
  return modes.reduce((best, mode) => MODE_RANK[mode] > MODE_RANK[best] ? mode : best, 'headers' as MailDownloadMode)
}

/**
 * When every location resolves to the same mode and window, a provider's own
 * date filter is exact and messages can be downloaded in that mode directly,
 * without first reading their labels.
 */
export function uniformPolicy(context: OfflinePolicyContext): ResolvedOfflinePolicy | undefined {
  const base = resolveLocationPolicy(context, '')
  const locations = new Set([...context.overrides.map((item) => item.labelId), ...context.extensions.map((item) => item.labelId)])
  for (const location of locations) {
    const resolved = resolveLocationPolicy(context, location)
    if (resolved.policy.downloadMode !== base.policy.downloadMode || resolved.start?.getTime() !== base.start?.getTime()) return undefined
  }
  return base
}

/** True when the account downloads everything in full, which is the behavior before E36. */
export function isDefaultScope(context: OfflinePolicyContext) {
  const uniform = uniformPolicy(context)
  return Boolean(uniform && uniform.policy.downloadMode === 'full' && !uniform.start)
}

/** Gmail's `after:` accepts epoch seconds, which keeps the boundary exact across time zones. */
export function gmailAfterQuery(start?: Date) {
  return start ? `after:${Math.floor(start.getTime() / 1000)}` : undefined
}
