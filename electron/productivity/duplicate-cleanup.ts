import { createHash, randomUUID } from 'node:crypto'
import type {
  DuplicateCleanupEntry, DuplicateExclusion, DuplicateGroup, DuplicateItem, DuplicateKind,
  DuplicateRemovalItemResult, DuplicateRemovalRequest, DuplicateRemovalResult, DuplicateScanRequest, DuplicateScanResult, DuplicateScopeOwner,
  DuplicateUndoItemResult, DuplicateUndoResult, DuplicateReasonCode, DuplicateConfidence
} from '../../src/duplicate-cleanup-types'
import type { InterchangeSnapshot } from '../../src/interchange-types'
import type { MailAccountSummary, MailLabel } from '../../src/mail-types'
import type { LocalModuleSnapshot, ProductivitySnapshot, SyncedCalendarEvent } from '../../src/productivity-types'
import type { ProviderTaskInput, TaskEntity, TaskLocalMetadata, TaskSnapshot } from '../../src/task-provider-types'
import type { CalendarEvent } from '../../src/types'
import { duplicateReasons } from '../../src/lib/duplicate-grouping'
import type { MailDuplicateItem, MailDuplicateScan, MailDuplicateScope, MailDuplicateTrashInput, MailDuplicateTrashResult } from '../mail/mail-duplicates'
import { eventRevision, findEventDuplicates, type EventCalendarRef, type EventDuplicateItem } from './event-duplicates'
import { findLocalTaskDuplicates, findProviderTaskDuplicates, localTaskRevision, providerTaskRevision, type TaskDuplicateItem } from './task-duplicates'
import type { DuplicateCleanupStore, JournalEvent, JournalMailOperation, JournalTask, JournalTaskDelete, StoredDuplicateCleanupEntry } from './duplicate-cleanup-store'

// Duplicate cleanup service (E32). Scans are cached in memory with each item's revision;
// removal re-checks every item (and the kept copy) against current data, skips stale ones,
// and removes the rest through the owners' normal write paths. Each removal is journaled
// so it can be undone. See docs/duplicate-cleanup.md.

export interface DuplicateCleanupDeps {
  store: Pick<DuplicateCleanupStore, 'saveEntry' | 'entry' | 'entries' | 'dismissals' | 'saveDismissal' | 'deleteDismissal'>
  accounts(): Promise<MailAccountSummary[]>
  mail: {
    labels(accountIds: string[]): Promise<MailLabel[]>
    scan(scopes: MailDuplicateScope[]): Promise<MailDuplicateScan>
    trash(input: MailDuplicateTrashInput): Promise<MailDuplicateTrashResult>
    undo(operationId: string): Promise<boolean>
  }
  calendar: {
    synced(): ProductivitySnapshot
    local(): InterchangeSnapshot
    deleteSynced(eventId: string): Promise<unknown>
    createSynced(event: CalendarEvent): Promise<unknown>
    deleteLocal(eventIds: string[]): void
    restoreLocal(calendarId: string, events: CalendarEvent[]): void
  }
  tasks: {
    snapshot(): Promise<TaskSnapshot>
    delete(id: string): Promise<TaskSnapshot>
    undo(operationId: string): Promise<TaskSnapshot>
    create(accountId: string, listId: string, input: ProviderTaskInput, parentId?: string, local?: TaskLocalMetadata): Promise<TaskSnapshot>
    local(): LocalModuleSnapshot
    saveLocal(snapshot: LocalModuleSnapshot): void
  }
  changed?(kind: DuplicateKind): void
  now?(): string
  id?(): string
  log?(event: string, details: Record<string, unknown>): void
}

type InternalItem = MailDuplicateItem | EventDuplicateItem | TaskDuplicateItem
interface CachedGroup { group: DuplicateGroup; items: Map<string, InternalItem> }
interface CachedScan { kind: DuplicateKind; groups: Map<string, CachedGroup> }
interface RawGroup { confidence: DuplicateConfidence; codes: DuplicateReasonCode[]; notes: string[]; keeperId: string; items: InternalItem[] }

const SCAN_CACHE_LIMIT = 5
const LOCAL_OWNER = 'local'
const HIDDEN_MAIL_LABELS = new Set(['TRASH', 'SPAM', 'DRAFT', 'UNREAD', 'STARRED', 'IMPORTANT'])
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

// The public item, without revisions and write targets.
function publicItem(item: InternalItem): DuplicateItem {
  const { id, title, ownerLabel, containerLabel, date, summary, details, completeness, createdAt, removable, blockedReason } = item
  return {
    id, title, ownerLabel, containerLabel, summary, details, completeness, removable,
    ...(date ? { date } : {}), ...(createdAt ? { createdAt } : {}), ...(blockedReason ? { blockedReason } : {})
  }
}

export function publicEntry(entry: StoredDuplicateCleanupEntry): DuplicateCleanupEntry {
  const { mail: _mail, events: _events, tasks: _tasks, ...rest } = entry
  return rest
}

// Provider bookkeeping is dropped before a deleted event is written back as a new one.
function eventInput(event: CalendarEvent, id: string): CalendarEvent {
  const { remoteId: _remoteId, accountId: _accountId, provider: _provider, readOnly: _readOnly, icalUid: _icalUid, ...rest } = event as SyncedCalendarEvent
  const { conference: _conference, seriesId: _seriesId, originalStart: _originalStart, occurrenceOf: _occurrenceOf, ...input } = rest
  return { ...input, id }
}

export class DuplicateCleanupService {
  private readonly scans = new Map<string, CachedScan>()

  constructor(private readonly deps: DuplicateCleanupDeps) {}

  private now() { return this.deps.now?.() ?? new Date().toISOString() }
  private newId() { return this.deps.id?.() ?? randomUUID() }

  private async accountLabels() {
    const accounts = await this.deps.accounts().catch(() => [] as MailAccountSummary[])
    return { accounts, label: (id: string) => accounts.find((account) => account.id === id)?.email || id }
  }

  async scopes(kind: DuplicateKind): Promise<DuplicateScopeOwner[]> {
    const { accounts, label } = await this.accountLabels()
    if (kind === 'mail') {
      const labels = await this.deps.mail.labels(accounts.map((account) => account.id)).catch(() => [] as MailLabel[])
      return accounts.map((account) => ({
        id: account.id,
        label: account.email || account.displayName,
        readOnly: account.archived,
        ...(account.archived ? { readOnlyReason: 'Archived accounts are read-only. Reconnect the account to clean up its mail.' } : {}),
        containers: labels.filter((item) => item.accountId === account.id && !HIDDEN_MAIL_LABELS.has(item.id) && !item.id.startsWith('CATEGORY_'))
          .map((item) => ({ id: item.id, label: item.name, readOnly: account.archived }))
      }))
    }
    if (kind === 'event') {
      const synced = this.deps.calendar.synced()
      const owners = new Map<string, DuplicateScopeOwner>()
      for (const calendar of synced.calendars) {
        const owner = owners.get(calendar.accountId) ?? { id: calendar.accountId, label: label(calendar.accountId), readOnly: false, containers: [] }
        owner.containers.push({
          id: calendar.id, label: calendar.name, readOnly: !calendar.canWrite,
          ...(!calendar.canWrite ? { readOnlyReason: calendar.provider === 'dav' ? 'This calendar is read-only on the server.' : 'Reconnect this account to allow calendar changes.' } : {})
        })
        owners.set(calendar.accountId, owner)
      }
      const local = this.deps.calendar.local()
      if (local.calendars.length) owners.set(LOCAL_OWNER, {
        id: LOCAL_OWNER, label: 'Calendars on this PC', readOnly: false,
        containers: local.calendars.map((calendar) => ({
          id: calendar.id, label: calendar.name, readOnly: calendar.kind !== 'local',
          ...(calendar.kind !== 'local' ? { readOnlyReason: 'Subscribed internet calendars are read-only.' } : {})
        }))
      })
      return [...owners.values()].map((owner) => ({ ...owner, readOnly: owner.containers.every((item) => item.readOnly) }))
    }
    const snapshot = await this.deps.tasks.snapshot()
    const owners: DuplicateScopeOwner[] = snapshot.accounts.map((account) => ({
      id: account.accountId,
      label: label(account.accountId),
      readOnly: !account.canWrite,
      ...(!account.canWrite ? { readOnlyReason: 'Reconnect this account with Tasks write access to clean up its lists.' } : {}),
      containers: snapshot.lists.filter((list) => list.accountId === account.accountId).map((list) => ({
        id: list.id, label: list.title, readOnly: list.readOnly,
        ...(list.readOnly ? { readOnlyReason: 'This list is read-only or has a pending change to resolve.' } : {})
      }))
    }))
    const localLists = [...new Set(this.deps.tasks.local().tasks.map((task) => task.listId))].sort()
    if (localLists.length) owners.push({ id: LOCAL_OWNER, label: 'Tasks on this PC', readOnly: false, containers: localLists.map((name) => ({ id: `local:${name}`, label: name, readOnly: false })) })
    return owners
  }

  async scan(request: DuplicateScanRequest): Promise<DuplicateScanResult> {
    const excluded: DuplicateExclusion[] = []
    let scanned = 0
    let raw: RawGroup[] = []
    if (request.kind === 'mail') {
      const result = await this.deps.mail.scan(request.scopes)
      scanned = result.scanned
      excluded.push(...result.excluded)
      raw = result.groups
    } else if (request.kind === 'event') {
      const { label } = await this.accountLabels()
      const synced = this.deps.calendar.synced()
      const local = this.deps.calendar.local()
      for (const calendarId of request.calendarIds) {
        const provider = synced.calendars.find((calendar) => calendar.id === calendarId)
        const interchange = local.calendars.find((calendar) => calendar.id === calendarId)
        if (!provider && !interchange) { excluded.push({ label: calendarId, reason: 'This calendar is no longer available' }); continue }
        if (provider && !provider.canWrite) { excluded.push({ label: provider.name, reason: provider.provider === 'dav' ? 'This calendar is read-only on the server.' : 'Reconnect this account to allow calendar changes.' }); continue }
        if (interchange && interchange.kind !== 'local') { excluded.push({ label: interchange.name, reason: 'Subscribed internet calendars are read-only.' }); continue }
        const ref: EventCalendarRef = provider
          ? { id: provider.id, label: provider.name, ownerLabel: label(provider.accountId), source: provider.provider === 'dav' ? 'dav' : 'provider' }
          : { id: interchange!.id, label: interchange!.name, ownerLabel: 'Calendars on this PC', source: 'local' }
        const events: CalendarEvent[] = provider ? synced.events.filter((event) => event.calendarId === calendarId) : local.events.filter((event) => event.calendarId === calendarId)
        scanned += events.length
        raw.push(...findEventDuplicates(ref, events))
      }
    } else {
      const { label } = await this.accountLabels()
      const snapshot = await this.deps.tasks.snapshot()
      const local = this.deps.tasks.local()
      for (const listId of request.listIds) {
        if (listId.startsWith('local:')) {
          const name = listId.slice('local:'.length)
          const tasks = local.tasks.filter((task) => task.listId === name)
          if (!tasks.length) { excluded.push({ label: name, reason: 'This list has no tasks' }); continue }
          scanned += tasks.length
          raw.push(...findLocalTaskDuplicates({ id: listId, label: name, ownerLabel: 'Tasks on this PC' }, local.tasks))
          continue
        }
        const list = snapshot.lists.find((item) => item.id === listId)
        if (!list) { excluded.push({ label: listId, reason: 'This list is no longer available' }); continue }
        if (list.readOnly) { excluded.push({ label: list.title, reason: 'This list is read-only or its account needs Tasks write access.' }); continue }
        const tasks = snapshot.tasks.filter((task) => task.listId === listId)
        scanned += tasks.length
        raw.push(...findProviderTaskDuplicates({ id: list.id, label: list.title, ownerLabel: label(list.accountId) }, tasks))
      }
    }
    const dismissals = this.deps.store.dismissals().filter((item) => item.kind === request.kind)
    const groups = new Map<string, CachedGroup>()
    let dismissed = 0
    for (const group of raw) {
      const ids = group.items.map((item) => item.id)
      if (dismissals.some((dismissal) => ids.every((id) => dismissal.itemIds.includes(id)))) { dismissed += 1; continue }
      const id = createHash('sha256').update(`${request.kind}\n${[...ids].sort().join('\n')}`).digest('hex').slice(0, 24)
      const items = group.items.map(publicItem)
      groups.set(id, {
        group: { id, kind: request.kind, confidence: group.confidence, reasons: duplicateReasons(group.codes), items, keeperId: group.keeperId, notes: group.notes },
        items: new Map(group.items.map((item) => [item.id, item]))
      })
    }
    const scanId = this.newId()
    this.scans.set(scanId, { kind: request.kind, groups })
    while (this.scans.size > SCAN_CACHE_LIMIT) this.scans.delete(this.scans.keys().next().value!)
    this.deps.log?.('duplicate-scan', { kind: request.kind, scanned, groups: groups.size, excluded: excluded.length, dismissed })
    return {
      scanId,
      kind: request.kind,
      scannedAt: this.now(),
      scanned,
      groups: [...groups.values()].map((item) => item.group).sort((a, b) => b.items.length - a.items.length || a.items[0].title.localeCompare(b.items[0].title)),
      excluded,
      dismissed
    }
  }

  private cached(scanId: string) {
    const scan = this.scans.get(scanId)
    if (!scan) throw new Error('This scan has expired. Scan again to review duplicates.')
    return scan
  }

  dismissals() { return this.deps.store.dismissals() }

  dismiss(scanId: string, groupId: string) {
    const scan = this.cached(scanId)
    const group = scan.groups.get(groupId)
    if (!group) throw new Error('That duplicate group is no longer available')
    this.deps.store.saveDismissal({
      id: groupId, kind: scan.kind, itemIds: group.group.items.map((item) => item.id), titles: group.group.items.map((item) => item.title), createdAt: this.now()
    })
    scan.groups.delete(groupId)
    return this.deps.store.dismissals()
  }

  removeDismissal(id: string) {
    this.deps.store.deleteDismissal(id)
    return this.deps.store.dismissals()
  }

  history() { return this.deps.store.entries().map(publicEntry) }

  async remove(request: DuplicateRemovalRequest): Promise<DuplicateRemovalResult> {
    const scan = this.cached(request.scanId)
    const results: DuplicateRemovalItemResult[] = []
    const accepted: { groupId: string; keeper: InternalItem; items: InternalItem[] }[] = []
    const seen = new Set<string>()
    for (const removal of request.groups) {
      const group = scan.groups.get(removal.groupId)
      if (!group) throw new Error('A duplicate group is no longer available. Scan again.')
      const keeper = group.items.get(removal.keeperId)
      if (!keeper) throw new Error('Choose a copy to keep from the group')
      if (removal.removeIds.includes(removal.keeperId)) throw new Error('The copy you keep cannot also be removed')
      const items: InternalItem[] = []
      for (const id of removal.removeIds) {
        const item = group.items.get(id)
        if (!item || seen.has(id)) throw new Error('Choose copies from the reviewed group')
        seen.add(id)
        if (!item.removable) results.push({ groupId: removal.groupId, itemId: id, title: item.title, outcome: 'skipped', message: item.blockedReason ?? 'This copy cannot be removed' })
        else items.push(item)
      }
      if (items.length) accepted.push({ groupId: removal.groupId, keeper, items })
    }
    const entry: StoredDuplicateCleanupEntry = { id: this.newId(), kind: scan.kind, createdAt: this.now(), removed: 0, titles: [] }
    if (scan.kind === 'mail') await this.removeMail(accepted, results, entry)
    else if (scan.kind === 'event') await this.removeEvents(accepted, results, entry)
    else await this.removeTasks(accepted, results, entry)
    // Removed groups leave the cached scan; stale and failed ones stay for another try.
    for (const { groupId } of accepted) {
      const cached = scan.groups.get(groupId)
      for (const result of results.filter((item) => item.groupId === groupId && item.outcome === 'removed')) cached?.items.delete(result.itemId)
      if (cached && cached.items.size < 2) scan.groups.delete(groupId)
    }
    const removed = results.filter((item) => item.outcome === 'removed')
    this.deps.log?.('duplicate-cleanup', { kind: scan.kind, removed: removed.length, stale: results.filter((item) => item.outcome === 'stale').length, failed: results.filter((item) => item.outcome === 'failed').length })
    if (removed.length || entry.mail?.length || entry.events?.length || entry.tasks?.length) {
      entry.removed = removed.length
      entry.titles = removed.map((item) => item.title).slice(0, 50)
      this.deps.store.saveEntry(entry)
      this.deps.changed?.(scan.kind)
      return { entry: publicEntry(entry), results }
    }
    return { results }
  }

  private staleKeeper(groupId: string, items: InternalItem[], results: DuplicateRemovalItemResult[]) {
    for (const item of items) results.push({ groupId, itemId: item.id, title: item.title, outcome: 'stale', message: 'The copy you chose to keep changed or was removed since the scan. Scan again.' })
  }

  private async removeMail(accepted: { groupId: string; keeper: InternalItem; items: InternalItem[] }[], results: DuplicateRemovalItemResult[], entry: StoredDuplicateCleanupEntry) {
    const byAccount = new Map<string, { groupId: string; item: MailDuplicateItem }[]>()
    const keepers = new Map<string, MailDuplicateItem>()
    for (const { groupId, keeper, items } of accepted) {
      keepers.set(groupId, keeper as MailDuplicateItem)
      for (const item of items as MailDuplicateItem[]) byAccount.set(item.accountId, [...(byAccount.get(item.accountId) ?? []), { groupId, item }])
    }
    for (const [accountId, entries] of byAccount) {
      try {
        // The worker re-checks each message and its group's kept copy before trashing anything.
        const result = await this.deps.mail.trash({ accountId, items: entries.map(({ groupId, item }) => {
          const keeper = keepers.get(groupId)!
          return { messageId: item.messageId, revision: item.revision, keeper: { messageId: keeper.messageId, revision: keeper.revision } }
        }) })
        for (const { groupId, item } of entries) {
          const outcome = result.results.find((value) => value.messageId === item.messageId)
          results.push({ groupId, itemId: item.id, title: item.title, outcome: outcome?.outcome ?? 'failed', ...(outcome?.message ? { message: outcome.message } : !outcome ? { message: 'The mail store did not report this message' } : {}) })
        }
        if (result.operation) {
          const removedIds = new Set(result.results.filter((value) => value.outcome === 'removed').map((value) => value.messageId))
          const operation: JournalMailOperation = { accountId, operationId: result.operation.id, items: entries.filter(({ item }) => removedIds.has(item.messageId)).map(({ item }) => ({ itemId: item.id, title: item.title })) }
          entry.mail = [...(entry.mail ?? []), operation]
        }
      } catch (error) {
        for (const { groupId, item } of entries) results.push({ groupId, itemId: item.id, title: item.title, outcome: 'failed', message: message(error) })
      }
    }
  }

  private currentEvents(item: EventDuplicateItem) {
    const events: CalendarEvent[] = item.source === 'local' ? this.deps.calendar.local().events : this.deps.calendar.synced().events
    const current = item.eventIds.map((id) => events.find((event) => event.id === id))
    if (current.some((event) => !event || event.calendarId !== item.calendarId)) return undefined
    return current as CalendarEvent[]
  }

  private async removeEvents(accepted: { groupId: string; keeper: InternalItem; items: InternalItem[] }[], results: DuplicateRemovalItemResult[], entry: StoredDuplicateCleanupEntry) {
    for (const { groupId, keeper, items } of accepted) {
      const kept = keeper as EventDuplicateItem
      const keptNow = this.currentEvents(kept)
      if (!keptNow || eventRevision(keptNow) !== kept.revision) { this.staleKeeper(groupId, items, results); continue }
      for (const item of items as EventDuplicateItem[]) {
        const current = this.currentEvents(item)
        if (!current || eventRevision(current) !== item.revision) {
          results.push({ groupId, itemId: item.id, title: item.title, outcome: 'stale', message: current ? 'This event changed since the scan; scan again to review it' : 'This event is no longer in the calendar' })
          continue
        }
        const journal: JournalEvent = { itemId: item.id, title: item.title, source: item.source, calendarId: item.calendarId, events: current }
        try {
          if (item.source === 'local') this.deps.calendar.deleteLocal(item.eventIds)
          else {
            if (item.series || current.length !== 1) throw new Error('Repeating series in synchronized calendars cannot be removed here')
            await this.deps.calendar.deleteSynced(current[0].id)
          }
          entry.events = [...(entry.events ?? []), journal]
          results.push({ groupId, itemId: item.id, title: item.title, outcome: 'removed' })
        } catch (error) {
          results.push({ groupId, itemId: item.id, title: item.title, outcome: 'failed', message: message(error) })
        }
      }
    }
  }

  private async removeTasks(accepted: { groupId: string; keeper: InternalItem; items: InternalItem[] }[], results: DuplicateRemovalItemResult[], entry: StoredDuplicateCleanupEntry) {
    let snapshot = await this.deps.tasks.snapshot()
    for (const { groupId, keeper, items } of accepted) {
      const kept = keeper as TaskDuplicateItem
      if (!this.taskCurrent(kept, snapshot)) { this.staleKeeper(groupId, items, results); continue }
      for (const item of items as TaskDuplicateItem[]) {
        if (!this.taskCurrent(item, snapshot)) {
          results.push({ groupId, itemId: item.id, title: item.title, outcome: 'stale', message: 'This task changed or was removed since the scan; scan again to review it' })
          continue
        }
        if (item.source === 'local') {
          const local = this.deps.tasks.local()
          const index = local.tasks.findIndex((task) => task.id === item.taskId)
          const task = local.tasks[index]
          try {
            this.deps.tasks.saveLocal({ ...local, tasks: local.tasks.filter((value) => value.id !== item.taskId) })
            entry.tasks = [...(entry.tasks ?? []), { itemId: item.id, title: item.title, source: 'local', task, index }]
            results.push({ groupId, itemId: item.id, title: item.title, outcome: 'removed' })
          } catch (error) {
            results.push({ groupId, itemId: item.id, title: item.title, outcome: 'failed', message: message(error) })
          }
          continue
        }
        const entity = snapshot.tasks.find((task) => task.id === item.taskId)!
        const journal: Extract<JournalTask, { source: 'provider' }> = { itemId: item.id, title: item.title, source: 'provider', accountId: entity.accountId, listId: entity.listId, deletes: [] }
        try {
          // Subtasks first (deepest first), then the task itself; the kept copy has equivalent subtasks.
          for (const id of [...item.descendantIds, item.taskId]) {
            const before = snapshot.tasks.find((task) => task.id === id)!
            snapshot = await this.deps.tasks.delete(id)
            const operation = snapshot.operations.filter((value) => value.entityId === id && value.kind === 'delete' && value.status !== 'cancelled').sort((a, b) => b.sequence - a.sequence)[0]
            journal.deletes.push({ entityId: id, ...(operation ? { operationId: operation.id } : {}), entity: before })
          }
          results.push({ groupId, itemId: item.id, title: item.title, outcome: 'removed' })
        } catch (error) {
          const done = journal.deletes.length
          results.push({ groupId, itemId: item.id, title: item.title, outcome: 'failed', message: done ? `${message(error)} (${done} subtask${done === 1 ? ' was' : 's were'} removed; Undo restores ${done === 1 ? 'it' : 'them'})` : message(error) })
        }
        if (journal.deletes.length) entry.tasks = [...(entry.tasks ?? []), journal]
      }
    }
  }

  private taskCurrent(item: TaskDuplicateItem, snapshot: TaskSnapshot) {
    if (item.source === 'local') {
      const task = this.deps.tasks.local().tasks.find((value) => value.id === item.taskId)
      return Boolean(task && `local:${task.listId}` === item.listId && localTaskRevision(task) === item.revision)
    }
    const task = snapshot.tasks.find((value) => value.id === item.taskId)
    return Boolean(task && task.listId === item.listId && providerTaskRevision(task, snapshot.tasks.filter((value) => value.listId === item.listId)) === item.revision)
  }

  async undo(entryId: string): Promise<DuplicateUndoResult> {
    const entry = this.deps.store.entry(entryId)
    if (!entry) throw new Error('That cleanup can no longer be undone')
    if (entry.undoneAt) throw new Error('That cleanup has already been undone')
    const results: DuplicateUndoItemResult[] = []
    for (const operation of entry.mail ?? []) {
      let restored = false
      let failure = 'The mail change can no longer be undone here. Restore the messages from Trash.'
      try { restored = await this.deps.mail.undo(operation.operationId) } catch (error) { failure = `${message(error)}. Restore the messages from Trash.` }
      for (const item of operation.items) results.push({ itemId: item.itemId, title: item.title, outcome: restored ? 'restored' : 'failed', ...(restored ? {} : { message: failure }) })
    }
    for (const journal of entry.events ?? []) results.push(await this.undoEvent(journal))
    for (const journal of entry.tasks ?? []) results.push(await this.undoTask(journal))
    const failures = results.filter((item) => item.outcome === 'failed')
    const undone: StoredDuplicateCleanupEntry = {
      ...entry,
      undoneAt: this.now(),
      ...(failures.length ? { warnings: [...(entry.warnings ?? []), ...failures.map((item) => `${item.title}: ${item.message ?? 'could not be restored'}`)] } : {})
    }
    this.deps.store.saveEntry(undone)
    this.deps.changed?.(entry.kind)
    this.deps.log?.('duplicate-cleanup-undone', { kind: entry.kind, restored: results.length - failures.length, failed: failures.length })
    return { entry: publicEntry(undone), results }
  }

  private async undoEvent(journal: JournalEvent): Promise<DuplicateUndoItemResult> {
    try {
      if (journal.source === 'local') {
        const existing = new Set(this.deps.calendar.local().events.map((event) => event.id))
        this.deps.calendar.restoreLocal(journal.calendarId, journal.events.filter((event) => !existing.has(event.id)))
        return { itemId: journal.itemId, title: journal.title, outcome: 'restored' }
      }
      // The provider assigns a new id; online meeting links are not recreated.
      const [event] = journal.events
      await this.deps.calendar.createSynced(eventInput(event, `event-${this.newId()}`))
      return { itemId: journal.itemId, title: journal.title, outcome: 'restored', ...(event.conference ? { message: 'The online meeting link was not recreated.' } : {}) }
    } catch (error) {
      return { itemId: journal.itemId, title: journal.title, outcome: 'failed', message: message(error) }
    }
  }

  private async undoTask(journal: JournalTask): Promise<DuplicateUndoItemResult> {
    try {
      if (journal.source === 'local') {
        const local = this.deps.tasks.local()
        if (!local.tasks.some((task) => task.id === journal.task.id)) {
          const tasks = [...local.tasks]
          tasks.splice(Math.min(journal.index, tasks.length), 0, journal.task)
          this.deps.tasks.saveLocal({ ...local, tasks })
        }
        return { itemId: journal.itemId, title: journal.title, outcome: 'restored' }
      }
      // Parents come back before their subtasks: the reverse of the deletion order.
      const ids = new Map<string, string>()
      for (const deleted of [...journal.deletes].reverse()) await this.restoreTask(journal, deleted, ids)
      return { itemId: journal.itemId, title: journal.title, outcome: 'restored' }
    } catch (error) {
      return { itemId: journal.itemId, title: journal.title, outcome: 'failed', message: message(error) }
    }
  }

  // Undo the queued delete; when the task queue can no longer undo it, recreate the task.
  private async restoreTask(journal: Extract<JournalTask, { source: 'provider' }>, deleted: JournalTaskDelete, ids: Map<string, string>) {
    if (deleted.operationId) {
      try {
        await this.deps.tasks.undo(deleted.operationId)
        ids.set(deleted.entityId, deleted.entityId)
        return
      } catch {
        // Fall through to recreating the task.
      }
    }
    const before = await this.deps.tasks.snapshot()
    const entity: TaskEntity = deleted.entity
    const parentId = entity.parentId ? ids.get(entity.parentId) ?? entity.parentId : undefined
    const after = await this.deps.tasks.create(journal.accountId, journal.listId, entity.fields, parentId, entity.local)
    const known = new Set(before.tasks.map((task) => task.id))
    const created = after.tasks.find((task) => !known.has(task.id) && task.listId === journal.listId && task.fields.title === entity.fields.title)
    ids.set(entity.id, created?.id ?? entity.id)
  }
}
