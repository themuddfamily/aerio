import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TaskStore } from './task-store'
import { parseTaskBackup, type TaskBackup } from './task-backup'
import type { ProviderTask } from '../../src/task-provider-types'

const list = { id: 'account:list', accountId: 'account', provider: 'gmail' as const, remoteId: 'list', title: 'Work', readOnly: false }
const remote: ProviderTask = { id: 'account:list:task', accountId: 'account', provider: 'gmail', remoteId: 'task', listId: list.id, remoteListId: 'list', title: 'Original', completed: false, revision: 'v1', readOnly: false }
let directory: string, path: string, store: TaskStore
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'aerio-task-backup-')); path = join(directory, 'tasks.sqlite')
  store = new TaskStore(path)
  store.replaceProviderSnapshot('account', 'gmail', { lists: [list], tasks: [remote], checkpoints: { [list.id]: '2026-10-01T10:00:00Z' } })
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
const id = () => store.entities('account', 'gmail')[0].id
const seed = () => {
  const first = store.update(id(), { title: 'Reviewed change' })
  store.start(first.id); store.fail(first.id, 'conflict', 'revision-conflict')
  store.resolve(first.id, { action: 'retry', expectedRevision: 'v1' })
  store.start(first.id); store.succeed(first.id, { ...remote, title: 'Reviewed change', revision: 'v2' })
  store.setLocal(id(), { priority: 'high', recurrence: 'weekly', timedDue: '2026-10-01T00:30:00+02:00' })
  store.update(id(), { completed: true }, Date.parse('2026-10-01T10:00:00Z'))
  const parent = store.create('account', 'gmail', list.id, { title: 'Offline parent', notes: '保留', completed: false })
  store.create('account', 'gmail', list.id, { title: 'Offline child', completed: false }, parent.entity.id)
  return store.exportBackup()
}

describe('provider task backup and restore', () => {
  it('round trips identities, original revisions, Unicode, metadata, hierarchy, occurrence links and resolution history without replaying pending writes', () => {
    const backup = seed()
    const expected = store.entities('account', 'gmail')
    const previousHistory = store.resolutionHistory(backup.operations[0].id)
    store.restoreBackup(JSON.parse(JSON.stringify(backup)))
    expect(store.entities('account', 'gmail')).toEqual(expected)
    expect(store.operations().filter((operation) => operation.status === 'review')).toHaveLength(4)
    expect(store.operations().filter((operation) => operation.status === 'review').every((operation) => operation.error === 'restored-write')).toBe(true)
    expect(store.operations()[0].status).toBe('succeeded')
    expect(store.resolutionHistory(backup.operations[0].id)).toEqual(previousHistory)
    expect(store.next()).toBeUndefined()
    expect(store.providerSnapshot('account', 'gmail').checkpoints).toEqual({})
    store.close(); store = new TaskStore(path)
    expect(store.next()).toBeUndefined()
    expect(store.entities('account', 'gmail').map((task) => task.id)).toEqual(expected.map((task) => task.id))
    expect(store.exportBackup().occurrences).toEqual(backup.occurrences)
  })

  it('holds an interrupted write and keeps its original attempt count and baseline', () => {
    const operation = store.update(id(), { title: 'Maybe sent' })
    store.start(operation.id)
    const backup = store.exportBackup()
    store.restoreBackup(backup)
    expect(store.operations()[0]).toMatchObject({ status: 'review', attempts: 1, base: { revision: 'v1' }, error: 'restored-write' })
    expect(() => store.resolve(operation.id, { action: 'retry', expectedRevision: 'v1' })).toThrow('Confirm')
    store.resolve(operation.id, { action: 'retry', expectedRevision: 'v1', confirmedNotApplied: true })
    expect(store.next()?.id).toBe(operation.id)
  })

  it('discards a restored unsent parent and its never-attempted child rather than orphaning child review state', () => {
    const parent = store.create('account', 'gmail', list.id, { title: 'Parent', completed: false })
    store.create('account', 'gmail', list.id, { title: 'Child', completed: false }, parent.entity.id)
    store.restoreBackup(store.exportBackup())
    store.resolve(parent.operation.id, { action: 'discard' })
    expect(store.entities('account', 'gmail')).toHaveLength(1)
    expect(store.operations().every((operation) => operation.status === 'cancelled')).toBe(true)
  })

  it('discards a restored recurring completion and its unattempted successor together', () => {
    store.setLocal(id(), { priority: 'normal', recurrence: 'daily' })
    const completion = store.update(id(), { completed: true })
    store.restoreBackup(store.exportBackup())
    store.resolve(completion.id, { action: 'discard' })
    expect(store.entities('account', 'gmail')).toHaveLength(1)
    expect(store.entity(id())?.fields.completed).toBe(false)
    expect(store.exportBackup().occurrences).toEqual([])
  })

  it('restores deletion history and its stable local identity so a later explicit undo can recreate the task', () => {
    const taskId = id(), deletion = store.delete(taskId)
    store.start(deletion.id); store.succeed(deletion.id)
    store.restoreBackup(store.exportBackup())
    expect(store.entity(taskId)).toBeUndefined()
    expect(store.undo(deletion.id)).toMatchObject({ kind: 'create', entityId: taskId, patch: { title: 'Original' } })
  })

  it('retains historical rows when their provider list has been removed', () => {
    store.update(id(), { title: 'Pending in removed list' })
    store.replaceProviderSnapshot('account', 'gmail', { lists: [], tasks: [], checkpoints: {} })
    const backup = store.exportBackup()
    store.restoreBackup(backup)
    expect(store.entities('account', 'gmail')[0].fields.title).toBe('Pending in removed list')
    expect(store.operations()[0].status).toBe('review')
  })

  it('rolls back replacement completely if SQLite rejects a restored row', () => {
    const before = seed()
    const db = new DatabaseSync(path)
    db.exec("CREATE TRIGGER fail_restore BEFORE INSERT ON task_entities BEGIN SELECT RAISE(ABORT,'restore fixture'); END"); db.close()
    expect(() => store.restoreBackup(before)).toThrow('restore fixture')
    const after = store.exportBackup()
    expect({ ...after, exportedAt: before.exportedAt }).toEqual(before)
    expect(store.operations().some((operation) => operation.status === 'queued')).toBe(true)
  })

  const invalid: [string, (backup: TaskBackup) => void][] = [
    ['duplicate entities', (backup) => { backup.entities.push(structuredClone(backup.entities[0])) }],
    ['duplicate accounts', (backup) => { backup.accounts.push(structuredClone(backup.accounts[0])) }],
    ['duplicate operations', (backup) => { backup.operations.push(structuredClone(backup.operations[0])) }],
    ['remote identity collisions', (backup) => { backup.entities[1].remote = backup.entities[0].remote }],
    ['invalid priority', (backup) => { backup.entities[0].local.priority = 'urgent' as never }],
    ['invalid timestamp', (backup) => { backup.exportedAt = '2026-02-30T10:00:00Z' }],
    ['unknown credential fields', (backup) => { (backup.entities[0] as any).accessToken = 'must-not-be-imported' }],
    ['dangling parent', (backup) => { backup.entities[0].parentId = 'missing' }],
    ['hierarchy cycles', (backup) => { backup.entities[0].parentId = backup.entities[0].id }],
    ['foreign operation baseline', (backup) => { backup.operations[0].base!.accountId = 'foreign' }],
    ['missing operation entity', (backup) => { backup.operations[0].entityId = 'missing' }],
    ['reordered operations', (backup) => { backup.operations.reverse() }],
    ['future dependency', (backup) => { backup.operations[0].dependsOn = backup.operations.at(-1)!.id }],
    ['malformed reference', (backup) => { backup.operations[0].parentId = 0 as never }],
    ['dangling undo', (backup) => { backup.operations[0].undoOf = 'missing' }],
    ['unknown operation status', (backup) => { backup.operations[0].status = 'ready' as never }],
    ['invalid mutation fields', (backup) => { backup.operations[0].patch.completed = 'yes' as never }],
    ['missing list', (backup) => { backup.accounts[0].snapshot.lists = [] }],
    ['dangling recurrence', (backup) => { backup.occurrences[0].creationId = 'missing' }],
    ['wrong recurrence completion', (backup) => { backup.occurrences[0].completionId = backup.operations[0].id }],
    ['dangling resolution', (backup) => { backup.resolutions[0].operationId = 'missing' }],
    ['unknown resolution fields', (backup) => { (backup.resolutions[0].resolution as any).token = 'not-allowed' }]
  ]
  it.each(invalid)('rejects %s before changing existing state', (_label, mutate) => {
    const before = seed(), malformed = structuredClone(before)
    mutate(malformed)
    expect(() => store.restoreBackup(malformed)).toThrow('invalid or unsupported')
    expect({ ...store.exportBackup(), exportedAt: before.exportedAt }).toEqual(before)
  })

  it('rejects malformed envelopes and returns a detached validated graph', () => {
    for (const malformed of [null, [], {}, { format: 'aerio-provider-tasks', schemaVersion: 99 }]) expect(() => parseTaskBackup(malformed)).toThrow('invalid or unsupported')
    const backup = store.exportBackup(), parsed = parseTaskBackup(backup)
    backup.entities[0].fields.title = 'Changed after validation'
    expect(parsed.entities[0].fields.title).toBe('Original')
  })
})
