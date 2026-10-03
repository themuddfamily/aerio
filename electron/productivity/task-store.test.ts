import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TaskStore } from './task-store'
import type { ProviderTask, ProviderTaskSnapshot } from '../../src/task-provider-types'

const list = { id: 'account:list', accountId: 'account', provider: 'gmail' as const, remoteId: 'list', title: 'Work', readOnly: false }
const remote: ProviderTask = { id: 'account:list:task', accountId: 'account', provider: 'gmail', remoteId: 'task', listId: list.id, remoteListId: 'list', title: 'Original', notes: 'Notes', completed: false, revision: 'v1', readOnly: false }
const snapshot = (tasks = [remote]): ProviderTaskSnapshot => ({ lists: [list], tasks, checkpoints: { [list.id]: '2026-10-01T00:00:00Z' } })
let directory: string
let path: string
let store: TaskStore
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'aerio-task-store-'))
  path = join(directory, 'tasks.sqlite')
  store = new TaskStore(path)
  store.replaceProviderSnapshot('account', 'gmail', snapshot())
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
const existing = () => store.entities('account', 'gmail')[0]
const complete = (operationId: string, result?: ProviderTask) => { store.start(operationId); store.succeed(operationId, result) }

describe('durable task state and undo', () => {
  it.each(['', undefined])('reconciles a lost response clearing notes when the provider returns %s', (notes) => {
    const id = existing().id
    const operation = store.update(id, { notes: null, due: null, completed: false })
    store.start(operation.id); store.fail(operation.id, 'review', 'uncertain-write')
    store.replaceProviderSnapshot('account', 'gmail', snapshot([{ ...remote, notes, due: undefined, revision: 'cleared-v2' }]))
    expect(store.resolve(operation.id, { action: 'accept', remoteId: remote.id, expectedRevision: 'cleared-v2' }).status).toBe('succeeded')
    expect(store.entity(id)?.fields.notes ?? '').toBe('')
    expect(store.operations()).toHaveLength(1)
  })

  it('accepts a created task with empty notes omitted by the provider', () => {
    const created = store.create('account', 'gmail', list.id, { title: 'Empty notes', notes: '', completed: false })
    store.start(created.operation.id); store.fail(created.operation.id, 'review', 'uncertain-write')
    const result = { ...remote, id: 'account:list:created', remoteId: 'created', title: 'Empty notes', notes: undefined, revision: 'created-v1' }
    store.replaceProviderSnapshot('account', 'gmail', snapshot([remote, result]))
    store.resolve(created.operation.id, { action: 'accept', remoteId: result.id, expectedRevision: result.revision })
    expect(store.entity(created.entity.id)?.remote?.id).toBe(result.id)
    expect(store.entities('account', 'gmail').filter((task) => task.fields.title === 'Empty notes')).toHaveLength(1)
  })

  it.each([' ', 'Remaining notes'])('rejects a cleared-note result containing %j and retains review state', (notes) => {
    const operation = store.update(existing().id, { notes: null })
    store.start(operation.id); store.fail(operation.id, 'review', 'uncertain-write')
    store.replaceProviderSnapshot('account', 'gmail', snapshot([{ ...remote, notes, revision: 'uncleared-v2' }]))
    expect(() => store.resolve(operation.id, { action: 'accept', remoteId: remote.id, expectedRevision: 'uncleared-v2' })).toThrow('does not match')
    expect(store.operations()[0].status).toBe('review')
    expect(store.resolutionHistory(operation.id)).toEqual([])
  })

  it('creates a task with its metadata and generates recurrence from metadata saved in the same completion transaction', () => {
    const created = store.create('account', 'gmail', list.id, { title: 'Configured', completed: false }, undefined, { priority: 'high', recurrence: 'weekly' })
    expect(created.entity.local).toEqual({ priority: 'high', recurrence: 'weekly' })
    const taskId = existing().id
    store.update(taskId, { completed: true }, Date.parse('2026-10-01T10:00:00Z'), { priority: 'low', recurrence: 'daily' })
    expect(store.entity(taskId)?.local).toEqual({ priority: 'low', recurrence: 'daily' })
    expect(store.entities('account', 'gmail').find((task) => task.fields.due === '2026-10-02')?.local.recurrence).toBe('daily')
  })

  it('rolls back editor metadata along with field changes if queue persistence fails', () => {
    const taskId = existing().id
    const db = new DatabaseSync(path)
    db.exec("CREATE TRIGGER fail_editor BEFORE INSERT ON task_operations BEGIN SELECT RAISE(ABORT,'editor fixture'); END")
    db.close()
    expect(() => store.update(taskId, { title: 'Failed save' }, Date.now(), { priority: 'high', recurrence: 'weekly' })).toThrow('editor fixture')
    expect(store.entity(taskId)).toMatchObject({ fields: { title: 'Original' }, local: { priority: 'normal', recurrence: 'none' } })
    expect(store.operations()).toEqual([])
  })

  it('explicitly retries a reviewed revision, rebases queued successors and preserves the original baseline in its audit trail', () => {
    const taskId = existing().id
    const first = store.update(taskId, { title: 'Mine' })
    const second = store.update(taskId, { completed: true })
    store.start(first.id); store.fail(first.id, 'conflict', 'revision-conflict')
    store.replaceProviderSnapshot('account', 'gmail', snapshot([{ ...remote, title: 'Theirs', revision: 'v2' }]))
    expect(() => store.resolve(first.id, { action: 'retry', expectedRevision: 'v1' })).toThrow('revision changed')
    expect(store.resolutionHistory(first.id)).toEqual([])
    expect(store.resolve(first.id, { action: 'retry', expectedRevision: 'v2' })).toMatchObject({ status: 'queued', base: { revision: 'v2' } })
    expect(store.operations().find((operation) => operation.id === second.id)?.base?.revision).toBe('v2')
    expect(store.resolutionHistory(first.id)[0]).toMatchObject({ previousStatus: 'conflict', previousBase: { revision: 'v1' }, resolution: { action: 'retry', expectedRevision: 'v2' } })
    store.close(); store = new TaskStore(path)
    expect(store.resolutionHistory(first.id)).toHaveLength(1)
  })

  it('requires explicit not-applied confirmation before retrying an uncertain creation', () => {
    const created = store.create('account', 'gmail', list.id, { title: 'Uncertain', completed: false })
    store.start(created.operation.id); store.fail(created.operation.id, 'review', 'uncertain-write')
    expect(() => store.resolve(created.operation.id, { action: 'retry' })).toThrow('Confirm')
    expect(store.resolve(created.operation.id, { action: 'retry', confirmedNotApplied: true })).toMatchObject({ status: 'queued', attempts: 1 })
    expect(store.next()?.id).toBe(created.operation.id)
  })

  it('attaches a refreshed uncertain creation to its original local identity and repairs imported child references', () => {
    const created = store.create('account', 'gmail', list.id, { title: 'Created', completed: false })
    store.setLocal(created.entity.id, { priority: 'high', recurrence: 'weekly' })
    store.start(created.operation.id); store.fail(created.operation.id, 'review', 'uncertain-write')
    const accepted = { ...remote, id: 'account:list:accepted', remoteId: 'accepted', title: 'Created', notes: undefined, revision: 'accepted-v1' }
    store.replaceProviderSnapshot('account', 'gmail', snapshot([remote, accepted, { ...remote, id: 'account:list:child', remoteId: 'child', parentId: accepted.id }]))
    expect(store.entities('account', 'gmail')).toHaveLength(4)
    expect(store.resolve(created.operation.id, { action: 'accept', remoteId: accepted.id, expectedRevision: 'accepted-v1' }).status).toBe('succeeded')
    expect(store.entities('account', 'gmail')).toHaveLength(3)
    expect(store.entity(created.entity.id)).toMatchObject({ remote: { id: accepted.id, revision: accepted.revision }, local: { priority: 'high', recurrence: 'weekly' } })
    expect(store.entities('account', 'gmail').find((task) => task.remote?.remoteId === 'child')?.parentId).toBe(created.entity.id)
  })

  it('rejects accepting a mismatched or locally edited candidate without merging either identity', () => {
    const created = store.create('account', 'gmail', list.id, { title: 'Created', completed: false })
    store.start(created.operation.id); store.fail(created.operation.id, 'review', 'uncertain-write')
    const accepted = { ...remote, id: 'account:list:accepted', remoteId: 'accepted', title: 'Different', notes: undefined, revision: 'accepted-v1' }
    store.replaceProviderSnapshot('account', 'gmail', snapshot([remote, accepted]))
    expect(() => store.resolve(created.operation.id, { action: 'accept', remoteId: accepted.id, expectedRevision: 'accepted-v1' })).toThrow('does not match')
    const imported = store.entities('account', 'gmail').find((task) => task.remote?.id === accepted.id)!
    store.replaceProviderSnapshot('account', 'gmail', snapshot([remote, { ...accepted, title: 'Created' }]))
    store.setLocal(imported.id, { priority: 'high', recurrence: 'none' })
    expect(() => store.resolve(created.operation.id, { action: 'accept', remoteId: accepted.id, expectedRevision: 'accepted-v1' })).toThrow('local changes')
    expect(store.entity(imported.id)).toBeDefined()
    expect(store.resolutionHistory(created.operation.id)).toEqual([])
    expect(store.operations()[0].status).toBe('review')
  })

  it('accepts an uncertain completion only when the refreshed task matches, then releases the recurring successor', () => {
    const taskId = existing().id
    store.setLocal(taskId, { priority: 'normal', recurrence: 'daily' })
    const completion = store.update(taskId, { completed: true })
    store.start(completion.id); store.fail(completion.id, 'review', 'uncertain-write')
    expect(() => store.resolve(completion.id, { action: 'accept', remoteId: remote.id, expectedRevision: 'v1' })).toThrow('does not match')
    store.replaceProviderSnapshot('account', 'gmail', snapshot([{ ...remote, completed: true, revision: 'v2' }]))
    store.resolve(completion.id, { action: 'accept', remoteId: remote.id, expectedRevision: 'v2' })
    expect(store.next()?.kind).toBe('create')
  })

  it('accepts a lost deletion response only after refresh establishes absence', () => {
    const deletion = store.delete(existing().id)
    store.start(deletion.id); store.fail(deletion.id, 'review', 'uncertain-write')
    expect(() => store.resolve(deletion.id, { action: 'accept' })).toThrow('still present')
    store.replaceProviderSnapshot('account', 'gmail', snapshot([]))
    expect(store.resolve(deletion.id, { action: 'accept' }).status).toBe('succeeded')
    expect(store.undo(deletion.id)?.kind).toBe('create')
  })

  it('discards a conflict and its pending successors without silently sending them', () => {
    const taskId = existing().id
    const first = store.update(taskId, { title: 'Mine' })
    store.update(taskId, { completed: true })
    store.start(first.id); store.fail(first.id, 'conflict', 'revision-conflict')
    store.replaceProviderSnapshot('account', 'gmail', snapshot([{ ...remote, title: 'Theirs', revision: 'v2' }]))
    store.resolve(first.id, { action: 'discard' })
    expect(store.entity(taskId)?.fields).toMatchObject({ title: 'Theirs', completed: false })
    expect(store.operations().every((operation) => operation.status === 'cancelled')).toBe(true)
    expect(store.next()).toBeUndefined()
  })

  it('discards an uncertain recurring completion and its unsent generated occurrence atomically', () => {
    const taskId = existing().id
    store.setLocal(taskId, { priority: 'normal', recurrence: 'daily' })
    const completion = store.update(taskId, { completed: true })
    store.start(completion.id); store.fail(completion.id, 'review', 'uncertain-write')
    store.resolve(completion.id, { action: 'discard' })
    expect(store.entities('account', 'gmail')).toHaveLength(1)
    expect(store.entity(taskId)?.fields.completed).toBe(false)
    expect(store.operations().every((operation) => operation.status === 'cancelled')).toBe(true)
    store.update(taskId, { completed: true })
    expect(store.entities('account', 'gmail')).toHaveLength(2)
  })

  it('queues one recurring occurrence atomically with completion, preserves it on restart, and waits for confirmed completion', () => {
    const taskId = existing().id
    store.setLocal(taskId, { priority: 'high', recurrence: 'monthly', timedDue: '2028-01-31T14:30:00Z' })
    store.update(taskId, { due: '2028-01-31' })
    const completion = store.update(taskId, { completed: true }, Date.parse('2028-01-31T10:00:00Z'))
    store.update(taskId, { completed: true })
    const next = store.entities('account', 'gmail').find((task) => task.id !== taskId)!
    expect(next).toMatchObject({ fields: { due: '2028-02-29', completed: false }, local: { priority: 'high', recurrence: 'monthly', timedDue: '2028-02-29T14:30:00.000Z' } })
    const creates = store.operations().filter((operation) => operation.kind === 'create')
    expect(creates).toHaveLength(1)
    expect(creates[0].dependsOn).toBe(completion.id)
    store.close(); store = new TaskStore(path)
    expect(store.entity(next.id)).toBeDefined()
    expect(store.next()?.kind).toBe('update')
    const due = store.next()!
    complete(due.id, { ...remote, due: '2028-01-31', revision: 'v2' })
    store.start(completion.id)
    store.fail(completion.id, 'conflict', 'revision-conflict')
    expect(store.next()).toBeUndefined()
  })

  it('uses UTC daily/weekly calendar arithmetic and completion time for an undated recurrence', () => {
    const taskId = existing().id
    store.setLocal(taskId, { priority: 'normal', recurrence: 'daily' })
    const completion = store.update(taskId, { completed: true }, Date.parse('2026-12-31T23:45:00Z'))
    expect(store.entities('account', 'gmail').find((task) => task.id !== taskId)?.fields.due).toBe('2027-01-01')
    store.undo(completion.id)
    store.setLocal(taskId, { priority: 'normal', recurrence: 'weekly' })
    store.update(taskId, { completed: true }, Date.parse('2026-12-31T23:45:00Z'))
    expect(store.entities('account', 'gmail').find((task) => task.id !== taskId)?.fields.due).toBe('2027-01-07')
  })

  it('cancels the unsent next occurrence and copied subtasks when undoing a completion', () => {
    store.replaceProviderSnapshot('account', 'gmail', snapshot([remote, { ...remote, id: 'account:list:child', remoteId: 'child', parentId: remote.id, completed: true }]))
    const taskId = existing().id
    store.setLocal(taskId, { priority: 'high', recurrence: 'daily' })
    const completion = store.update(taskId, { completed: true }, Date.parse('2026-10-01T10:00:00Z'))
    const tasks = store.entities('account', 'gmail')
    expect(tasks).toHaveLength(4)
    const next = tasks.find((task) => !task.remote && !task.parentId)!
    expect(tasks.find((task) => task.parentId === next.id)).toMatchObject({ fields: { title: 'Original', completed: false } })
    store.undo(completion.id)
    expect(store.entities('account', 'gmail')).toHaveLength(2)
    expect(store.entity(taskId)?.fields.completed).toBe(false)
    expect(store.operations().every((operation) => operation.status === 'cancelled')).toBe(true)
    store.update(taskId, { completed: true })
    expect(store.entities('account', 'gmail')).toHaveLength(4)
  })

  it('rolls back completion, occurrence creation and copied subtasks together when queue persistence fails', () => {
    const taskId = existing().id
    store.setLocal(taskId, { priority: 'normal', recurrence: 'daily' })
    const db = new DatabaseSync(path)
    db.exec("CREATE TRIGGER fail_occurrence BEFORE INSERT ON task_occurrences BEGIN SELECT RAISE(ABORT,'occurrence fixture'); END")
    db.close()
    expect(() => store.update(taskId, { completed: true })).toThrow('occurrence fixture')
    expect(store.operations()).toEqual([])
    expect(store.entities('account', 'gmail')).toHaveLength(1)
    expect(store.entity(taskId)?.fields.completed).toBe(false)
  })

  it('does not create duplicate successors when reopening and completing the original task again', () => {
    const taskId = existing().id
    store.setLocal(taskId, { priority: 'normal', recurrence: 'daily' })
    store.update(taskId, { completed: true })
    store.update(taskId, { completed: false })
    store.update(taskId, { completed: true })
    expect(store.operations().filter((operation) => operation.kind === 'create')).toHaveLength(1)
    expect(store.entities('account', 'gmail')).toHaveLength(2)
  })

  it('holds completion undo while its successor might exist, then permits it after successor deletion is confirmed', () => {
    const taskId = existing().id
    store.setLocal(taskId, { priority: 'normal', recurrence: 'daily' })
    const completion = store.update(taskId, { completed: true })
    complete(completion.id, { ...remote, completed: true, revision: 'v2' })
    const creation = store.next()!
    store.start(creation.id)
    expect(() => store.undo(completion.id)).toThrow('next occurrence')
    store.succeed(creation.id, { ...remote, id: 'account:list:next', remoteId: 'next', revision: 'next-v1' })
    expect(() => store.undo(completion.id)).toThrow('next occurrence')
    const deletion = store.undo(creation.id)!
    complete(deletion.id)
    expect(store.undo(completion.id)).toMatchObject({ patch: { completed: false }, base: { revision: 'v2' } })
  })

  it('cancels a recurring offline task and its generated successor when undoing its initial creation', () => {
    const created = store.create('account', 'gmail', list.id, { title: 'Offline recurring', completed: false })
    store.setLocal(created.entity.id, { priority: 'normal', recurrence: 'daily' })
    store.update(created.entity.id, { completed: true })
    store.undo(created.operation.id)
    expect(store.entities('account', 'gmail')).toHaveLength(1)
    expect(store.operations().every((operation) => operation.status === 'cancelled')).toBe(true)
  })

  it('cancels a move under an unsent parent without cancelling unrelated edits to that existing task', () => {
    const taskId = existing().id
    const parent = store.create('account', 'gmail', list.id, { title: 'New parent', completed: false })
    const move = store.move(taskId, parent.entity.id)
    const edit = store.update(taskId, { title: 'Retained edit' })
    store.undo(parent.operation.id)
    expect(store.operations().find((operation) => operation.id === move.id)?.status).toBe('cancelled')
    expect(store.operations().find((operation) => operation.id === edit.id)?.status).toBe('queued')
    expect(store.entity(taskId)).toMatchObject({ parentId: undefined, fields: { title: 'Retained edit' } })
  })

  it('keeps a pending edit visible after remote deletion but hides an unmodified deleted task', () => {
    const taskId = existing().id
    store.replaceProviderSnapshot('account', 'gmail', snapshot([]))
    expect(store.entity(taskId)).toBeUndefined()
    store.replaceProviderSnapshot('account', 'gmail', snapshot())
    store.update(taskId, { title: 'Preserved intent' })
    store.replaceProviderSnapshot('account', 'gmail', snapshot([]))
    expect(store.entity(taskId)?.fields.title).toBe('Preserved intent')
    expect(store.next()?.base?.revision).toBe('v1')
  })

  it('treats an undefined patch field as unchanged', () => {
    const taskId = existing().id
    store.update(taskId, { title: undefined, completed: true })
    expect(store.entity(taskId)?.fields).toMatchObject({ title: 'Original', completed: true })
  })

  it('preserves stable local identity, metadata and offline overlays across refresh and restart without changing the write baseline', () => {
    const id = existing().id
    const operation = store.update(id, { title: 'Offline edit', notes: null })
    store.setLocal(id, { priority: 'high', recurrence: 'weekly', timedDue: '2026-10-03T14:00:00Z' })
    store.replaceProviderSnapshot('account', 'gmail', snapshot([{ ...remote, title: 'External edit', revision: 'v2' }]))
    store.close(); store = new TaskStore(path)
    expect(store.entity(id)).toMatchObject({ id, fields: { title: 'Offline edit', notes: undefined }, remote: { revision: 'v2' }, local: { priority: 'high', recurrence: 'weekly' } })
    expect(store.operations()[0]).toMatchObject({ id: operation.id, status: 'queued', base: { revision: 'v1' } })
    expect(store.providerSnapshot('account', 'gmail').tasks[0].title).toBe('External edit')
  })

  it('assigns one local identity before creation and preserves it when the provider assigns its remote identity', () => {
    const created = store.create('account', 'gmail', list.id, { title: 'New', completed: false })
    const result = { ...remote, id: 'account:list:new', remoteId: 'new', title: 'New', revision: 'new-v1' }
    complete(created.operation.id, result)
    store.replaceProviderSnapshot('account', 'gmail', snapshot([remote, result]))
    expect(store.entity(created.entity.id)?.remote).toEqual(result)
    expect(store.entities('account', 'gmail')).toHaveLength(2)
  })

  it('rolls back both a new entity and operation if the durable queue insert fails', () => {
    const db = new DatabaseSync(path)
    db.exec("CREATE TRIGGER fail_queue BEFORE INSERT ON task_operations BEGIN SELECT RAISE(ABORT,'fixture'); END")
    db.close()
    expect(() => store.create('account', 'gmail', list.id, { title: 'Failed', completed: false })).toThrow('fixture')
    expect(store.operations()).toEqual([])
    expect(store.entities('account', 'gmail')).toHaveLength(1)
    const check = new DatabaseSync(path)
    expect(check.prepare('SELECT COUNT(*) AS count FROM task_entities').get()?.count).toBe(1)
    check.close()
  })

  it('blocks a dependent child until its offline parent has a remote identity', () => {
    const parent = store.create('account', 'gmail', list.id, { title: 'Parent', completed: false })
    const child = store.create('account', 'gmail', list.id, { title: 'Child', completed: false }, parent.entity.id)
    expect(store.next()?.id).toBe(parent.operation.id)
    store.start(parent.operation.id)
    expect(store.next()).toBeUndefined()
    store.succeed(parent.operation.id, { ...remote, id: 'account:list:parent', remoteId: 'parent', title: 'Parent' })
    expect(store.next()?.id).toBe(child.operation.id)
    expect(store.entity(child.entity.id)?.parentId).toBe(parent.entity.id)
  })

  it('cancels an unsent parent, descendants and their queued edits without deleting unrelated work', () => {
    const parent = store.create('account', 'gmail', list.id, { title: 'Parent', completed: false })
    const child = store.create('account', 'gmail', list.id, { title: 'Child', completed: false }, parent.entity.id)
    store.create('account', 'gmail', list.id, { title: 'Grandchild', completed: false }, child.entity.id)
    store.update(child.entity.id, { title: 'Edited child' })
    const other = store.update(existing().id, { completed: true })
    expect(store.undo(parent.operation.id)).toBeUndefined()
    expect(store.entities('account', 'gmail')).toHaveLength(1)
    expect(store.next()?.id).toBe(other.id)
    expect(store.operations().slice(0, 4).every((operation) => operation.status === 'cancelled')).toBe(true)
  })

  it('serializes edits to one task, rebases on its own successful write, and lets unrelated work continue', () => {
    const id = existing().id
    const first = store.update(id, { title: 'First' })
    const second = store.update(id, { completed: true })
    const other = store.create('account', 'gmail', list.id, { title: 'Other', completed: false })
    store.start(first.id)
    store.fail(first.id, 'conflict', 'revision-conflict')
    expect(store.next()?.id).toBe(other.operation.id)
    expect(store.operations().find((operation) => operation.id === second.id)?.base?.revision).toBe('v1')
  })

  it('rebases queued successors only after its own successful write and undo restores the actual previous state', () => {
    const id = existing().id
    const first = store.update(id, { title: 'First' })
    const second = store.update(id, { title: 'Second' })
    complete(first.id, { ...remote, title: 'First', revision: 'v2' })
    expect(store.operations().find((operation) => operation.id === second.id)?.base?.revision).toBe('v2')
    complete(second.id, { ...remote, title: 'Second', revision: 'v3' })
    const undo = store.undo(second.id)!
    expect(undo).toMatchObject({ kind: 'update', patch: { title: 'First' }, base: { revision: 'v3' }, undoOf: second.id })
    expect(store.entity(id)?.fields.title).toBe('First')
    expect(() => store.undo(second.id)).toThrow('already undone')
  })

  it('does not resurrect an earlier cancelled optimistic edit when undoing a later write', () => {
    const id = existing().id
    const cancelled = store.update(id, { title: 'Cancelled' })
    const second = store.update(id, { title: 'Second' })
    store.undo(cancelled.id)
    complete(second.id, { ...remote, title: 'Second', revision: 'v2' })
    expect(store.undo(second.id)?.patch.title).toBe('Original')
  })

  it('restores a deleted task with its original local identity and a fresh remote identity', () => {
    const id = existing().id
    const deletion = store.delete(id)
    expect(store.entity(id)).toBeUndefined()
    complete(deletion.id)
    expect(store.providerSnapshot('account', 'gmail').tasks).toEqual([])
    const undo = store.undo(deletion.id)!
    expect(store.entity(id)).toMatchObject({ id, remote: undefined, fields: { title: 'Original' } })
    complete(undo.id, { ...remote, id: 'account:list:restored', remoteId: 'restored', revision: 'new-v1' })
    expect(store.entity(id)?.remote?.remoteId).toBe('restored')
  })

  it('retains an interrupted in-flight write for review across restarts and blocks successors', () => {
    const id = existing().id
    const operation = store.update(id, { title: 'Maybe written' })
    store.update(id, { completed: true })
    store.start(operation.id)
    store.close(); store = new TaskStore(path)
    expect(store.operations()[0]).toMatchObject({ status: 'review', attempts: 1, error: 'interrupted-write', base: { revision: 'v1' } })
    expect(store.next()).toBeUndefined()
    expect(store.entity(id)?.fields.title).toBe('Maybe written')
    expect(() => store.undo(operation.id)).toThrow('Resolve')
  })

  it('preserves native parent mapping and rejects hierarchy cycles, foreign parents and parent deletion', () => {
    store.replaceProviderSnapshot('account', 'gmail', snapshot([remote, { ...remote, id: 'account:list:child', remoteId: 'child', parentId: remote.id }]))
    const [parent, child] = store.entities('account', 'gmail')
    expect(child.parentId).toBe(parent.id)
    expect(() => store.move(parent.id, child.id)).toThrow('cycle')
    expect(() => store.move(child.id, 'missing')).toThrow('Invalid parent')
    expect(() => store.delete(parent.id)).toThrow('subtasks')
    const move = store.move(child.id)
    expect(store.entity(child.id)?.parentId).toBeUndefined()
    complete(move.id, { ...child.remote!, parentId: undefined, revision: 'v2' })
    expect(store.undo(move.id)?.parentId).toBe(parent.id)
  })

  it('rejects read-only writes and invalid mutations without persisting them', () => {
    expect(() => store.update(existing().id, { completed: 'yes' } as never)).toThrow('Invalid')
    expect(() => store.create('account', 'gmail', 'missing', { title: 'Task', completed: false })).toThrow('read-only')
    store.replaceProviderSnapshot('account', 'gmail', snapshot([{ ...remote, assigned: true }]))
    expect(() => store.update(existing().id, { title: 'Unsafe' })).toThrow('read-only')
    expect(store.operations()).toEqual([])
  })

  it('rolls back an invalid cross-account identity collision rather than changing either account', () => {
    const before = store.providerSnapshot('account', 'gmail')
    const foreignList = { ...list, accountId: 'other' }
    expect(() => store.replaceProviderSnapshot('other', 'gmail', { lists: [foreignList], tasks: [{ ...remote, accountId: 'other' }], checkpoints: {} })).toThrow('another account')
    expect(store.providerSnapshot('other', 'gmail').tasks).toEqual([])
    expect(store.providerSnapshot('account', 'gmail')).toEqual(before)
    expect(existing().accountId).toBe('account')
  })
})
