import type { DuplicateKind, DuplicateRemovalRequest, DuplicateScanRequest } from '../../src/duplicate-cleanup-types'
import type { DuplicateCleanupService } from './duplicate-cleanup'

interface IpcRegistrar {
  handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void
}

const MAX_SCOPES = 500
const MAX_GROUPS = 5_000
const MAX_ITEMS = 1_000

const validId = (value: unknown, max = 1_000): value is string => typeof value === 'string' && value.length > 0 && value.length <= max
const validIds = (value: unknown, max: number): value is string[] => Array.isArray(value) && value.length <= max && value.every((item) => validId(item))
export const validDuplicateKind = (value: unknown): value is DuplicateKind => value === 'mail' || value === 'event' || value === 'task'

export function validScanRequest(value: unknown): value is DuplicateScanRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Partial<Record<string, unknown>>
  if (request.kind === 'mail') {
    const scopes = request.scopes
    return Array.isArray(scopes) && scopes.length > 0 && scopes.length <= MAX_SCOPES && scopes.every((scope) => scope && typeof scope === 'object' &&
      validId((scope as { accountId?: unknown }).accountId) &&
      ((scope as { labelIds?: unknown }).labelIds === undefined || validIds((scope as { labelIds?: unknown }).labelIds, MAX_SCOPES)))
  }
  if (request.kind === 'event') return validIds(request.calendarIds, MAX_SCOPES) && (request.calendarIds as string[]).length > 0
  if (request.kind === 'task') return validIds(request.listIds, MAX_SCOPES) && (request.listIds as string[]).length > 0
  return false
}

export function validRemovalRequest(value: unknown): value is DuplicateRemovalRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Partial<DuplicateRemovalRequest>
  return validId(request.scanId) && Array.isArray(request.groups) && request.groups.length > 0 && request.groups.length <= MAX_GROUPS &&
    request.groups.every((group) => group && typeof group === 'object' && validId(group.groupId) && validId(group.keeperId) &&
      validIds(group.removeIds, MAX_ITEMS) && group.removeIds.length > 0)
}

// Duplicate cleanup handlers (E32). Every request is validated here and refused while Aerio
// is locked; item ownership and revisions are re-checked against the cached scan in the service.
export function registerDuplicateCleanup(ipc: IpcRegistrar, service: () => DuplicateCleanupService, isLocked: () => boolean) {
  const unlocked = () => { if (isLocked()) throw new Error('Unlock Aerio first') }
  ipc.handle('duplicates:scopes', (_event, kind: unknown) => {
    unlocked()
    if (!validDuplicateKind(kind)) throw new Error('Choose mail, calendar, or tasks')
    return service().scopes(kind)
  })
  ipc.handle('duplicates:scan', (_event, request: unknown) => {
    unlocked()
    if (!validScanRequest(request)) throw new Error('Choose at least one account, folder, calendar, or list to scan')
    return service().scan(request)
  })
  ipc.handle('duplicates:remove', (_event, request: unknown) => {
    unlocked()
    if (!validRemovalRequest(request)) throw new Error('Choose the copies to remove and the copy to keep')
    return service().remove(request)
  })
  ipc.handle('duplicates:dismiss', (_event, scanId: unknown, groupId: unknown) => {
    unlocked()
    if (!validId(scanId) || !validId(groupId)) throw new Error('Choose a duplicate group')
    return service().dismiss(scanId, groupId)
  })
  ipc.handle('duplicates:dismissals', () => { unlocked(); return service().dismissals() })
  ipc.handle('duplicates:dismissal-remove', (_event, id: unknown) => {
    unlocked()
    if (!validId(id)) throw new Error('Choose a saved decision')
    return service().removeDismissal(id)
  })
  ipc.handle('duplicates:history', () => { unlocked(); return service().history() })
  ipc.handle('duplicates:undo', (_event, entryId: unknown) => {
    unlocked()
    if (!validId(entryId)) throw new Error('Choose a cleanup to undo')
    return service().undo(entryId)
  })
}
