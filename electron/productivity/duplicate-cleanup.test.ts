import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InterchangeSnapshot } from '../../src/interchange-types'
import type { MailAccountSummary } from '../../src/mail-types'
import type { LocalModuleSnapshot, ProductivitySnapshot, SyncedCalendar, SyncedCalendarEvent } from '../../src/productivity-types'
import type { TaskEntity, TaskOperation, TaskSnapshot } from '../../src/task-provider-types'
import type { CalendarEvent, Task } from '../../src/types'
import type { MailDuplicateScan, MailDuplicateTrashInput } from '../mail/mail-duplicates'
import { DuplicateCleanupService, type DuplicateCleanupDeps } from './duplicate-cleanup'
import { DuplicateCleanupStore } from './duplicate-cleanup-store'

const directories: string[] = []
const stores: DuplicateCleanupStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const account: MailAccountSummary = { id: 'acc', provider: 'gmail', email: 'ada@example.com', displayName: 'Ada', color: '#000', status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true }
const calendar = (id: string, overrides: Partial<SyncedCalendar> = {}): SyncedCalendar => ({ id, remoteId: id, accountId: 'acc', provider: 'gmail', name: id, color: '#000', primary: false, canWrite: true, ...overrides })
const event = (id: string, overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id, calendarId: 'home', title: 'Dentist', start: '2026-10-05T09:00:00.000Z', end: '2026-10-05T10:00:00.000Z', color: '#000', attendees: [], reminderMinutes: 10, ...overrides
})
const synced = (id: string, overrides: Partial<SyncedCalendarEvent> = {}): SyncedCalendarEvent => ({ ...event(id, { calendarId: 'work' }), remoteId: `r-${id}`, accountId: 'acc', provider: 'gmail', readOnly: false, ...overrides })
const entity = (id: string, title: string, parentId?: string): TaskEntity => ({
  id, accountId: 'acc', provider: 'gmail', listId: 'list', ...(parentId ? { parentId } : {}), fields: { title, completed: false }, local: { priority: 'normal', recurrence: 'none' },
  remote: { id, accountId: 'acc', provider: 'gmail', remoteId: id, listId: 'list', remoteListId: 'l', title, completed: false, readOnly: false, revision: 'r1' }
})
const localTask = (id: string, listId = 'Home'): Task => ({ id, listId, title: 'Water plants', priority: 'normal', completed: false, subtasks: [] })

function harness(options: { mailScan?: MailDuplicateScan } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'aerio-dupe-service-'))
  directories.push(directory)
  const store = new DuplicateCleanupStore(join(directory, 'productivity.sqlite'))
  stores.push(store)
  const productivity: ProductivitySnapshot = {
    calendars: [calendar('work'), calendar('readonly', { canWrite: false })],
    events: [synced('w1'), synced('w2'), synced('w3'), synced('ro1', { calendarId: 'readonly' }), synced('ro2', { calendarId: 'readonly' })],
    contacts: [], sync: []
  }
  const interchange: InterchangeSnapshot = {
    calendars: [{ id: 'home', kind: 'local', name: 'Home', color: '#000' }, { id: 'feed', kind: 'subscription', name: 'Holidays', color: '#000', url: 'https://example.com/h.ics' }],
    events: [{ ...event('h1'), readOnly: false }, { ...event('h2'), readOnly: false }, { ...event('f1', { calendarId: 'feed' }), readOnly: true }]
  }
  let sequence = 0
  const tasks: TaskSnapshot = {
    lists: [{ id: 'list', accountId: 'acc', provider: 'gmail', remoteId: 'l', title: 'Errands', readOnly: false }, { id: 'locked', accountId: 'acc', provider: 'gmail', remoteId: 'x', title: 'Shared', readOnly: true }],
    tasks: [entity('p1', 'Move'), entity('p1-a', 'Boxes', 'p1'), entity('p2', 'Move'), entity('p2-a', 'Boxes', 'p2')],
    remoteTasks: [], operations: [], accounts: [{ accountId: 'acc', provider: 'gmail', canRead: true, canWrite: true, archived: false, phase: 'ready' }]
  }
  const removed = new Map<string, TaskEntity>()
  let local: LocalModuleSnapshot = { tasks: [localTask('t1'), localTask('t2'), localTask('t3', 'Work')], notes: [] }
  const copy = () => structuredClone(tasks)
  const deps = {
    store,
    accounts: vi.fn(async () => [account]),
    mail: {
      labels: vi.fn(async () => [{ accountId: 'acc', id: 'INBOX', name: 'Inbox', type: 'system' as const }, { accountId: 'acc', id: 'TRASH', name: 'Trash', type: 'system' as const }]),
      scan: vi.fn(async () => options.mailScan ?? { scanned: 0, groups: [], excluded: [] }),
      trash: vi.fn(async (input: MailDuplicateTrashInput) => ({
        operation: { id: `op-${input.accountId}`, accountId: input.accountId, kind: 'trash' as const, status: 'queued' as const },
        results: input.items.map((item) => item.messageId === 'stale-msg'
          ? { messageId: item.messageId, outcome: 'stale' as const, message: 'This message changed since the scan; scan again to review it' }
          : { messageId: item.messageId, outcome: 'removed' as const })
      })),
      undo: vi.fn(async () => true)
    },
    calendar: {
      synced: () => productivity,
      local: () => interchange,
      deleteSynced: vi.fn(async (id: string) => { productivity.events = productivity.events.filter((item) => item.id !== id) }),
      createSynced: vi.fn(async (input: CalendarEvent) => { productivity.events.push({ ...input, remoteId: 'new', accountId: 'acc', provider: 'gmail', readOnly: false }) }),
      deleteLocal: vi.fn((ids: string[]) => { interchange.events = interchange.events.filter((item) => !ids.includes(item.id)) }),
      restoreLocal: vi.fn((_calendarId: string, events: CalendarEvent[]) => { interchange.events.push(...events.map((item) => ({ ...item, readOnly: false }))) })
    },
    tasks: {
      snapshot: vi.fn(async () => copy()),
      delete: vi.fn(async (id: string) => {
        const target = tasks.tasks.find((item) => item.id === id)!
        if (tasks.tasks.some((item) => item.parentId === id)) throw new Error('Delete or move subtasks first')
        removed.set(id, target)
        tasks.tasks = tasks.tasks.filter((item) => item.id !== id)
        tasks.operations.push({ id: `del-${id}`, sequence: sequence += 1, entityId: id, accountId: 'acc', provider: 'gmail', kind: 'delete', status: 'queued', patch: {}, before: target, attempts: 0, retryAt: 0 } as TaskOperation)
        return copy()
      }),
      undo: vi.fn(async (operationId: string) => {
        const id = operationId.replace(/^del-/, '')
        tasks.tasks.push(removed.get(id)!)
        return copy()
      }),
      create: vi.fn(async (_accountId: string, listId: string, input: TaskEntity['fields'], parentId?: string) => {
        tasks.tasks.push({ ...entity(`new-${tasks.tasks.length}`, input.title, parentId), listId })
        return copy()
      }),
      local: () => local,
      saveLocal: vi.fn((snapshot: LocalModuleSnapshot) => { local = snapshot })
    },
    changed: vi.fn(),
    id: (() => { let next = 0; return () => `id-${next += 1}` })(),
    now: () => '2026-10-17T12:00:00.000Z'
  } satisfies DuplicateCleanupDeps
  return { service: new DuplicateCleanupService(deps), deps, store, productivity, interchange, tasks, get local() { return local } }
}

describe('duplicate cleanup service: calendars', () => {
  it('lists calendars with read-only reasons and excludes read-only calendars from scans', async () => {
    const { service } = harness()
    const owners = await service.scopes('event')
    expect(owners.find((owner) => owner.id === 'acc')!.containers.find((item) => item.id === 'readonly')).toMatchObject({ readOnly: true, readOnlyReason: expect.stringMatching(/Reconnect/) })
    expect(owners.find((owner) => owner.id === 'local')!.containers.find((item) => item.id === 'feed')).toMatchObject({ readOnly: true })
    const result = await service.scan({ kind: 'event', calendarIds: ['readonly', 'feed', 'missing'] })
    expect(result.groups).toEqual([])
    expect(result.excluded.map((item) => item.label)).toEqual(['readonly', 'Holidays', 'missing'])
  })

  it('removes a local duplicate, journals it, and undo restores the exact event', async () => {
    const h = harness()
    const scan = await h.service.scan({ kind: 'event', calendarIds: ['home'] })
    expect(scan.groups).toHaveLength(1)
    const [group] = scan.groups
    const remove = group.items.find((item) => item.id !== group.keeperId)!
    const result = await h.service.remove({ scanId: scan.scanId, groups: [{ groupId: group.id, keeperId: group.keeperId, removeIds: [remove.id] }] })
    expect(result.results).toEqual([{ groupId: group.id, itemId: remove.id, title: 'Dentist', outcome: 'removed' }])
    expect(h.deps.calendar.deleteLocal).toHaveBeenCalledWith([remove.id.replace('event:', '')])
    expect(h.deps.changed).toHaveBeenCalledWith('event')
    expect(h.service.history()).toEqual([expect.objectContaining({ id: result.entry!.id, kind: 'event', removed: 1, titles: ['Dentist'] })])
    // The journal is kept in the store but never exposed to the renderer.
    expect(h.service.history()[0]).not.toHaveProperty('events')
    const undo = await h.service.undo(result.entry!.id)
    expect(undo.results).toEqual([{ itemId: remove.id, title: 'Dentist', outcome: 'restored' }])
    expect(h.interchange.events.map((item) => item.id).sort()).toEqual(['f1', 'h1', 'h2'])
    await expect(h.service.undo(result.entry!.id)).rejects.toThrow(/already been undone/)
  })

  it('skips stale events, reports partial failures per item, and recreates synced events on undo', async () => {
    const h = harness()
    const scan = await h.service.scan({ kind: 'event', calendarIds: ['work'] })
    const [group] = scan.groups
    expect(group.items).toHaveLength(3)
    // A sync changed w3 after the scan, and the provider refuses to delete w2.
    h.productivity.events = h.productivity.events.map((item) => item.id === 'w3' ? { ...item, description: 'Bring forms' } : item)
    h.deps.calendar.deleteSynced.mockImplementationOnce(async () => { throw new Error('Google returned 503') })
    const result = await h.service.remove({ scanId: scan.scanId, groups: [{ groupId: group.id, keeperId: 'event:w1', removeIds: ['event:w2', 'event:w3'] }] })
    expect(result.results).toEqual([
      { groupId: group.id, itemId: 'event:w2', title: 'Dentist', outcome: 'failed', message: 'Google returned 503' },
      { groupId: group.id, itemId: 'event:w3', title: 'Dentist', outcome: 'stale', message: expect.stringMatching(/changed since the scan/) }
    ])
    expect(result.entry).toBeUndefined()
    // The failed item can be retried from the same scan.
    const retry = await h.service.remove({ scanId: scan.scanId, groups: [{ groupId: group.id, keeperId: 'event:w1', removeIds: ['event:w2'] }] })
    expect(retry.results[0]).toMatchObject({ itemId: 'event:w2', outcome: 'removed' })
    expect(h.deps.calendar.deleteSynced).toHaveBeenLastCalledWith('w2')
    await h.service.undo(retry.entry!.id)
    const recreated = h.deps.calendar.createSynced.mock.calls[0][0] as SyncedCalendarEvent
    expect(recreated).toMatchObject({ calendarId: 'work', title: 'Dentist' })
    expect(recreated.id).not.toBe('w2')
    expect(recreated).not.toHaveProperty('remoteId')
    expect(recreated).not.toHaveProperty('accountId')
  })

  it('refuses to remove copies when the kept copy changed since the scan', async () => {
    const h = harness()
    const scan = await h.service.scan({ kind: 'event', calendarIds: ['home'] })
    const [group] = scan.groups
    const other = group.items.find((item) => item.id !== group.keeperId)!
    h.interchange.events = h.interchange.events.filter((item) => `event:${item.id}` !== group.keeperId)
    const result = await h.service.remove({ scanId: scan.scanId, groups: [{ groupId: group.id, keeperId: group.keeperId, removeIds: [other.id] }] })
    expect(result.results[0]).toMatchObject({ outcome: 'stale', message: expect.stringMatching(/copy you chose to keep/) })
    expect(h.deps.calendar.deleteLocal).not.toHaveBeenCalled()
  })

  it('skips items that cannot be removed and validates the request against the scan', async () => {
    const h = harness()
    h.productivity.events = [
      ...[0, 7].map((day) => synced(`a${day}`, { seriesId: 'sa', originalStart: `2026-10-${5 + day}T09:00:00.000Z` })),
      ...[0, 7].map((day) => synced(`b${day}`, { seriesId: 'sb', originalStart: `2026-10-${5 + day}T09:00:00.000Z` }))
    ]
    const scan = await h.service.scan({ kind: 'event', calendarIds: ['work'] })
    const [group] = scan.groups
    const other = group.items.find((item) => item.id !== group.keeperId)!
    const result = await h.service.remove({ scanId: scan.scanId, groups: [{ groupId: group.id, keeperId: group.keeperId, removeIds: [other.id] }] })
    expect(result.results[0]).toMatchObject({ outcome: 'skipped', message: expect.stringMatching(/review only/) })
    expect(h.deps.calendar.deleteSynced).not.toHaveBeenCalled()
    await expect(h.service.remove({ scanId: scan.scanId, groups: [{ groupId: group.id, keeperId: group.keeperId, removeIds: [group.keeperId] }] })).rejects.toThrow(/cannot also be removed/)
    await expect(h.service.remove({ scanId: scan.scanId, groups: [{ groupId: group.id, keeperId: group.keeperId, removeIds: ['event:unknown'] }] })).rejects.toThrow(/reviewed group/)
    await expect(h.service.remove({ scanId: 'expired', groups: [{ groupId: group.id, keeperId: group.keeperId, removeIds: [other.id] }] })).rejects.toThrow(/expired/)
  })
})

describe('duplicate cleanup service: "Not duplicates"', () => {
  it('persists dismissals so the group is not suggested again', async () => {
    const h = harness()
    const scan = await h.service.scan({ kind: 'event', calendarIds: ['home'] })
    const dismissals = h.service.dismiss(scan.scanId, scan.groups[0].id)
    expect(dismissals).toEqual([expect.objectContaining({ kind: 'event', itemIds: ['event:h1', 'event:h2'] })])
    // A new service on the same store (as after a restart) still hides the group.
    const restarted = new DuplicateCleanupService({ ...h.deps })
    const again = await restarted.scan({ kind: 'event', calendarIds: ['home'] })
    expect(again).toMatchObject({ groups: [], dismissed: 1 })
    restarted.removeDismissal(dismissals[0].id)
    expect((await restarted.scan({ kind: 'event', calendarIds: ['home'] })).groups).toHaveLength(1)
  })
})

describe('duplicate cleanup service: tasks', () => {
  it('removes a duplicate parent after its subtasks and undoes in reverse order', async () => {
    const h = harness()
    const scan = await h.service.scan({ kind: 'task', listIds: ['list', 'locked'] })
    expect(scan.excluded).toEqual([{ label: 'Shared', reason: expect.stringMatching(/read-only/) }])
    const [group] = scan.groups
    expect(group.items.map((item) => item.id).sort()).toEqual(['task:p1', 'task:p2'])
    const result = await h.service.remove({ scanId: scan.scanId, groups: [{ groupId: group.id, keeperId: 'task:p1', removeIds: ['task:p2'] }] })
    expect(result.results[0]).toMatchObject({ outcome: 'removed' })
    expect(h.deps.tasks.delete.mock.calls.map((call) => call[0])).toEqual(['p2-a', 'p2'])
    // The kept copy keeps its own subtask.
    expect(h.tasks.tasks.map((item) => item.id).sort()).toEqual(['p1', 'p1-a'])
    await h.service.undo(result.entry!.id)
    expect(h.deps.tasks.undo.mock.calls.map((call) => call[0])).toEqual(['del-p2', 'del-p2-a'])
    expect(h.tasks.tasks.map((item) => item.id).sort()).toEqual(['p1', 'p1-a', 'p2', 'p2-a'])
  })

  it('recreates tasks when the queue can no longer undo the delete', async () => {
    const h = harness()
    const scan = await h.service.scan({ kind: 'task', listIds: ['list'] })
    const [group] = scan.groups
    const result = await h.service.remove({ scanId: scan.scanId, groups: [{ groupId: group.id, keeperId: 'task:p1', removeIds: ['task:p2'] }] })
    h.deps.tasks.undo.mockRejectedValue(new Error('Resolve the task operation before undoing it'))
    const undo = await h.service.undo(result.entry!.id)
    expect(undo.results).toEqual([{ itemId: 'task:p2', title: 'Move', outcome: 'restored' }])
    const [parentCall, childCall] = h.deps.tasks.create.mock.calls
    expect(parentCall.slice(0, 4)).toEqual(['acc', 'list', expect.objectContaining({ title: 'Move' }), undefined])
    // The subtask is recreated under the recreated parent.
    expect(childCall[3]).toMatch(/^new-/)
  })

  it('reports a partial failure when a subtask was removed but its parent was not', async () => {
    const h = harness()
    const scan = await h.service.scan({ kind: 'task', listIds: ['list'] })
    const [group] = scan.groups
    const remove = h.deps.tasks.delete.getMockImplementation()!
    h.deps.tasks.delete.mockImplementation(async (id: string) => {
      if (id === 'p2') throw new Error('Tasks write access was revoked')
      return remove(id)
    })
    const result = await h.service.remove({ scanId: scan.scanId, groups: [{ groupId: group.id, keeperId: 'task:p1', removeIds: ['task:p2'] }] })
    expect(result.results[0]).toMatchObject({ outcome: 'failed', message: expect.stringMatching(/revoked .*1 subtask was removed; Undo restores it/) })
    // The partial removal is journaled so it can be undone.
    expect(result.entry).toBeDefined()
    await h.service.undo(result.entry!.id)
    expect(h.tasks.tasks.some((item) => item.id === 'p2-a')).toBe(true)
  })

  it('removes and restores local tasks and skips stale ones', async () => {
    const h = harness()
    const scan = await h.service.scan({ kind: 'task', listIds: ['local:Home'] })
    const [group] = scan.groups
    const result = await h.service.remove({ scanId: scan.scanId, groups: [{ groupId: group.id, keeperId: 'local-task:t1', removeIds: ['local-task:t2'] }] })
    expect(result.results[0]).toMatchObject({ outcome: 'removed' })
    expect(h.local.tasks.map((item) => item.id)).toEqual(['t1', 't3'])
    await h.service.undo(result.entry!.id)
    expect(h.local.tasks.map((item) => item.id)).toEqual(['t1', 't2', 't3'])

    const rescan = await h.service.scan({ kind: 'task', listIds: ['local:Home'] })
    h.deps.tasks.saveLocal({ ...h.local, tasks: h.local.tasks.map((item) => item.id === 't2' ? { ...item, completed: true } : item) })
    const stale = await h.service.remove({ scanId: rescan.scanId, groups: [{ groupId: rescan.groups[0].id, keeperId: 'local-task:t1', removeIds: ['local-task:t2'] }] })
    expect(stale.results[0]).toMatchObject({ outcome: 'stale' })
  })
})

describe('duplicate cleanup service: mail', () => {
  const item = (messageId: string) => ({
    id: `mail:acc:${messageId}`, accountId: 'acc', messageId, revision: '1|live', title: 'Report', ownerLabel: 'ada@example.com', containerLabel: 'All Mail',
    summary: 'Ada', details: [], completeness: 1, removable: true
  })

  it('trashes duplicates through the mail queue with the kept copy re-checked, and undoes through mail undo', async () => {
    const h = harness({ mailScan: { scanned: 4, excluded: [], groups: [{ confidence: 'high', codes: ['message-id', 'content-hash'], notes: [], keeperId: 'mail:acc:keep', items: [item('keep'), item('extra'), item('stale-msg')] }] } })
    const scopes = await h.service.scopes('mail')
    expect(scopes[0].containers.map((container) => container.id)).toEqual(['INBOX'])
    const scan = await h.service.scan({ kind: 'mail', scopes: [{ accountId: 'acc' }] })
    expect(scan.groups[0].reasons.map((reason) => reason.code)).toEqual(['message-id', 'content-hash'])
    // Revisions and write targets stay in the main process.
    expect(scan.groups[0].items[0]).not.toHaveProperty('revision')
    const [group] = scan.groups
    const result = await h.service.remove({ scanId: scan.scanId, groups: [{ groupId: group.id, keeperId: 'mail:acc:keep', removeIds: ['mail:acc:extra', 'mail:acc:stale-msg'] }] })
    expect(h.deps.mail.trash).toHaveBeenCalledWith({ accountId: 'acc', items: [
      { messageId: 'extra', revision: '1|live', keeper: { messageId: 'keep', revision: '1|live' } },
      { messageId: 'stale-msg', revision: '1|live', keeper: { messageId: 'keep', revision: '1|live' } }
    ] })
    expect(result.results.map((value) => value.outcome)).toEqual(['removed', 'stale'])
    const undo = await h.service.undo(result.entry!.id)
    expect(h.deps.mail.undo).toHaveBeenCalledWith('op-acc')
    expect(undo.results).toEqual([{ itemId: 'mail:acc:extra', title: 'Report', outcome: 'restored' }])
  })

  it('reports mail that can no longer be undone and points to Trash', async () => {
    const h = harness({ mailScan: { scanned: 2, excluded: [], groups: [{ confidence: 'high', codes: ['message-id'], notes: [], keeperId: 'mail:acc:keep', items: [item('keep'), item('extra')] }] } })
    const scan = await h.service.scan({ kind: 'mail', scopes: [{ accountId: 'acc' }] })
    const result = await h.service.remove({ scanId: scan.scanId, groups: [{ groupId: scan.groups[0].id, keeperId: 'mail:acc:keep', removeIds: ['mail:acc:extra'] }] })
    h.deps.mail.undo.mockResolvedValueOnce(false)
    const undo = await h.service.undo(result.entry!.id)
    expect(undo.results[0]).toMatchObject({ outcome: 'failed', message: expect.stringMatching(/Trash/) })
    expect(undo.entry.warnings?.[0]).toMatch(/Report/)
  })

  it('reports every message as failed when the mail store cannot be reached', async () => {
    const h = harness({ mailScan: { scanned: 2, excluded: [], groups: [{ confidence: 'high', codes: ['message-id'], notes: [], keeperId: 'mail:acc:keep', items: [item('keep'), item('extra')] }] } })
    const scan = await h.service.scan({ kind: 'mail', scopes: [{ accountId: 'acc' }] })
    h.deps.mail.trash.mockRejectedValueOnce(new Error('The mail worker stopped unexpectedly (1)'))
    const result = await h.service.remove({ scanId: scan.scanId, groups: [{ groupId: scan.groups[0].id, keeperId: 'mail:acc:keep', removeIds: ['mail:acc:extra'] }] })
    expect(result).toEqual({ results: [expect.objectContaining({ outcome: 'failed', message: 'The mail worker stopped unexpectedly (1)' })] })
  })
})
