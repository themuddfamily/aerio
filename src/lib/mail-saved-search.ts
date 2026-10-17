import type { MailFolder, MailSavedSearch, MailSavedSearchInput, MailSearchFilters } from '../mail-types'
import { mailSearchQueryError } from './mail-search-query'

export const MAIL_FOLDERS: readonly MailFolder[] = ['inbox', 'starred', 'important', 'sent', 'drafts', 'scheduled', 'snoozed', 'archive', 'spam', 'trash', 'all']
const TEXT_FILTERS = ['from', 'to', 'subject', 'attachmentName'] as const
const DATE_FILTERS = ['dateFrom', 'dateTo'] as const
const BOOLEAN_FILTERS = ['hasAttachments', 'unread', 'starred', 'important'] as const

const optionalId = (value: unknown, message: string) => {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || value.length > 500) throw new Error(message)
  return value
}

/** Drops empty values and rejects anything that is not a known search filter. */
export function normalizeMailSearchFilters(value: unknown): MailSearchFilters {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('The search filters are invalid')
  const input = value as Record<string, unknown>
  const known = new Set<string>([...TEXT_FILTERS, ...DATE_FILTERS, ...BOOLEAN_FILTERS])
  if (Object.keys(input).some((key) => !known.has(key))) throw new Error('The search filters are invalid')
  const filters: MailSearchFilters = {}
  for (const key of TEXT_FILTERS) {
    const item = input[key]
    if (item === undefined || item === null) continue
    if (typeof item !== 'string' || item.length > 500) throw new Error('The search filters are invalid')
    if (item.trim()) filters[key] = item.trim()
  }
  for (const key of DATE_FILTERS) {
    const item = input[key]
    if (item === undefined || item === null || item === '') continue
    if (typeof item !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item) || Number.isNaN(Date.parse(item))) throw new Error('Choose valid search dates')
    filters[key] = item
  }
  for (const key of BOOLEAN_FILTERS) {
    const item = input[key]
    if (item === undefined || item === null) continue
    if (typeof item !== 'boolean') throw new Error('The search filters are invalid')
    filters[key] = item
  }
  if (filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo) throw new Error('The search start date must be before the end date')
  return filters
}

/** Validates an untrusted saved-search payload from the renderer. */
export function validateMailSavedSearch(input: unknown): MailSavedSearchInput {
  if (!input || typeof input !== 'object') throw new Error('The saved search is invalid')
  const value = input as Record<string, unknown>
  const id = optionalId(value.id, 'The saved search id is invalid')
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 100) throw new Error('Give this search a name of up to 100 characters')
  const query = value.query === undefined ? '' : value.query
  if (typeof query !== 'string') throw new Error('The saved search query is invalid')
  const queryError = mailSearchQueryError(query)
  if (queryError) throw new Error(queryError)
  if (typeof value.folder !== 'string' || !MAIL_FOLDERS.includes(value.folder as MailFolder)) throw new Error('Choose a mailbox for this search')
  const accountId = optionalId(value.accountId, 'Choose a valid account for this search')
  const labelId = optionalId(value.labelId, 'Choose a valid label for this search')
  if (labelId && !accountId) throw new Error('Choose an account for a label search')
  const filters = normalizeMailSearchFilters(value.filters)
  if (!query.trim() && !Object.keys(filters).length && !labelId) throw new Error('Add search words or filters before saving')
  return {
    ...(id ? { id } : {}),
    name: value.name.trim(),
    query: query.trim(),
    folder: value.folder as MailFolder,
    ...(accountId ? { accountId } : {}),
    ...(labelId ? { labelId } : {}),
    filters
  }
}

const sameFilters = (left: MailSearchFilters, right: MailSearchFilters) => {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)] as (keyof MailSearchFilters)[])
  return [...keys].every((key) => left[key] === right[key])
}

/** True when the mail view is currently showing exactly this saved search. */
export function savedSearchMatchesView(search: MailSavedSearch, view: { accountId: string; folder: MailFolder; labelId?: string; query: string; filters: MailSearchFilters }) {
  return (search.accountId ?? 'all') === view.accountId
    && search.folder === view.folder
    && (search.labelId ?? undefined) === (view.labelId || undefined)
    && search.query.trim() === view.query.trim()
    && sameFilters(search.filters, view.filters)
}
