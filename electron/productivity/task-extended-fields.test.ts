import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskStore } from './task-store'
import { TaskSyncEngine } from './task-sync-engine'
import { MicrosoftTasksConnector } from './microsoft-tasks-connector'
import { parseTaskBackup } from './task-backup'
import type { ProviderTask, ProviderTaskList, ProviderTaskSnapshot, TaskLocalMetadata } from '../../src/task-provider-types'

// Real SQLite coverage for E44 extended fields on connected tasks: Google local overlays, Microsoft
// native fields, recurring completion, undo, reconciliation, round trips, and backup migration.
const googleList: ProviderTaskList = { id: 'g:list', accountId: 'g', provider: 'gmail', remoteId: 'list', title: 'Errands', readOnly: false }
const googleTask: ProviderTask = { id: 'g:list:task', accountId: 'g', provider: 'gmail', remoteId: 'task', listId: googleList.id, remoteListId: 'list', title: 'Water plants', completed: false, revision: 'g1', readOnly: false, due: '2026-03-07' }
const msList: ProviderTaskList = { id: 'm:microsoft-task-list:list', accountId: 'm', provider: 'microsoft', remoteId: 'list', title: 'Work', readOnly: false, manageReadOnly: false, revisionMode: 'snapshot', revision: `snapshot:${'1'.repeat(64)}` }
const msNative = { priority: 'normal' as const, status: 'notStarted' as const, recurrence: undefined }
const msTask: ProviderTask = { id: 'm:microsoft-task:list:task', accountId: 'm', provider: 'microsoft', remoteId: 'task', listId: msList.id, remoteListId: 'list', title: 'Report', completed: false, revision: 'v1', revisionMode: 'etag', kind: 'task', native: msNative, readOnly: false }
const attachment = { id: 'file', name: 'list.txt', size: 4, path: '/profile/task-attachments/file.txt', mime: 'txt' }
let directory: string, path: string, store: TaskStore
const google = () => store.entities('g', 'gmail')
const microsoft = () => store.entities('m', 'microsoft')[0]
const local = (extended?: TaskLocalMetadata['extended'], recurrence: TaskLocalMetadata['recurrence'] = 'none'): TaskLocalMetadata => ({ priority: 'normal', recurrence, ...(extended ? { extended } : {}) })
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'aerio-task-fields-')); path = join(directory, 'tasks.sqlite')
  store = new TaskStore(path)
  store.replaceProviderSnapshot('g', 'gmail', { lists: [googleList], tasks: [googleTask], checkpoints: {} })
  store.replaceProviderSnapshot('m', 'microsoft', { lists: [msList], tasks: [msTask], checkpoints: {} })
})
afterEach(() => { store.close(); vi.unstubAllGlobals(); rmSync(directory, { recursive: true, force: true }) })

describe('connected task extended fields', () => {
  it('keeps Google start, reminder, progress, tags and attachments as a local overlay that survives refresh and restart', () => {
    const id = google()[0].id
    const extended = { start: '2026-03-06T08:00:00', startTimeZone: 'America/New_York', reminder: '2026-03-07T13:45:00.000Z', percentComplete: 30, categories: ['Home'], attachments: [attachment] }
    store.update(id, { title: 'Water plants' }, Date.now(), local(extended))
    store.replaceProviderSnapshot('g', 'gmail', { lists: [googleList], tasks: [{ ...googleTask, revision: 'g2', title: 'Water the plants' }], checkpoints: {} })
    store.close(); store = new TaskStore(path)
    expect(store.entity(id)?.local.extended).toEqual(extended)
    // The overlay never reaches the provider fields.
    expect(store.operations().at(-1)!.patch).toEqual({ title: 'Water plants' })
    expect(store.localAttachmentPaths()).toContain(attachment.path)
    for (const invalid of [{ startTimeZone: 'Nowhere/Zone', start: '2026-03-06T08:00' }, { percentComplete: -1 }, { reminder: 'soon' }, { attachments: [{ ...attachment, path: undefined }] }]) {
      expect(() => store.setLocal(id, local(invalid as never))).toThrow('Invalid local task fields')
    }
  })

  it('stores Microsoft start, reminder and tags natively, keeping only progress local', () => {
    const id = microsoft().id
    expect(() => store.setLocal(id, local({ start: '2026-10-20' }))).toThrow('Invalid local task fields')
    expect(() => store.setLocal(id, local({ categories: ['Work'] }))).toThrow('Invalid local task fields')
    store.setLocal(id, local({ percentComplete: 50 }))
    expect(microsoft().local.extended).toEqual({ percentComplete: 50 })
    expect(() => store.update(id, { native: { attachments: [] } })).toThrow('change separately')
    expect(() => store.update(google()[0].id, { native: { start: '2026-10-20' } })).toThrow('does not support native task fields')
  })

  it('advances a recurring Google task overlay with the reminder offset kept across daylight saving', () => {
    const id = google()[0].id
    store.update(id, { completed: true }, Date.parse('2026-03-07T15:00:00Z'), local({ start: '2026-03-07T08:00:00', startTimeZone: 'America/New_York', reminder: '2026-03-07T13:45:00.000Z', percentComplete: 80, categories: ['Garden'], attachments: [attachment] }, 'daily'))
    const successor = google().find((task) => task.id !== id)!
    expect(successor.fields).toMatchObject({ due: '2026-03-08', completed: false })
    // 08:45 EST on 7 March becomes 08:45 EDT on 8 March.
    expect(successor.local.extended).toEqual({ start: '2026-03-08T08:00:00', startTimeZone: 'America/New_York', reminder: '2026-03-08T12:45:00.000Z', percentComplete: 0, categories: ['Garden'], attachments: [attachment] })
  })

  it('undoes native extended edits with explicit clears and reconciles normalized accepted results', async () => {
    const id = microsoft().id
    const operation = store.update(id, { native: { start: '2026-10-21', startTimeZone: 'Europe/London', reminder: '2026-10-21T07:00:00.000Z', categories: ['Finance'] } })
    store.start(operation.id); store.fail(operation.id, 'review', 'uncertain-write')
    const accepted: ProviderTask = { ...msTask, revision: 'v2', native: { ...msNative, start: '2026-10-21T00:00:00', startTimeZone: 'Europe/London', reminder: '2026-10-21T07:00:00.000Z', categories: ['Finance'] } }
    store.replaceProviderSnapshot('m', 'microsoft', { lists: [msList], tasks: [{ ...accepted, native: { ...accepted.native, categories: ['Other'] } }], checkpoints: {} })
    expect(() => store.resolve(operation.id, { action: 'accept', remoteId: msTask.id, expectedRevision: 'v2' })).toThrow('intended native fields')
    store.replaceProviderSnapshot('m', 'microsoft', { lists: [msList], tasks: [accepted], checkpoints: {} })
    expect(store.resolve(operation.id, { action: 'accept', remoteId: msTask.id, expectedRevision: 'v2' }).status).toBe('succeeded')
    const undo = store.undo(operation.id)!
    expect(undo.patch.native).toEqual({ start: null, reminder: null, categories: [] })
    // The compensating write reaches Graph as clears.
    const graph = { id: 'task', title: 'Report', '@odata.etag': 'v2', status: 'notStarted', importance: 'normal', startDateTime: { dateTime: '2026-10-21T00:00:00', timeZone: 'Europe/London' }, reminderDateTime: { dateTime: '2026-10-21T07:00:00', timeZone: 'UTC' }, isReminderOn: true, categories: ['Finance'] }
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(graph))).mockResolvedValueOnce(new Response(JSON.stringify({ ...graph, '@odata.etag': 'v3', startDateTime: null, isReminderOn: false, categories: [] })))
    vi.stubGlobal('fetch', fetch)
    await new TaskSyncEngine(store, { online: () => true, connector: () => new MicrosoftTasksConnector('m', async () => 'token', true) }).flush()
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toMatchObject({ startDateTime: null, isReminderOn: false, categories: [] })
    expect(microsoft().fields.native).not.toHaveProperty('start')
    expect(microsoft().fields.native).not.toHaveProperty('reminder')
  })

  it('stores a task re-read after an attachment change only when no edits are pending', () => {
    const id = microsoft().id
    const reread: ProviderTask = { ...msTask, revision: 'v9', native: { ...msNative, attachments: [{ id: 'a1', name: 'spec.pdf', size: 10 }] } }
    store.update(id, { title: 'Pending' })
    expect(store.hasPendingChanges(id)).toBe(true)
    expect(() => store.replaceRemoteTask(reread)).toThrow('pending changes')
    store.undo(store.operations().at(-1)!.id)
    store.replaceRemoteTask(reread)
    expect(microsoft()).toMatchObject({ remote: { revision: 'v9' }, fields: { native: { attachments: [{ id: 'a1' }] } } })
    expect(store.providerSnapshot('m', 'microsoft').tasks[0].revision).toBe('v9')
    expect(() => store.replaceRemoteTask({ ...reread, id: 'unknown' })).toThrow('unrelated task')
  })

  it('round-trips extended fields through schema 2 backups and still restores schema 1 backups', () => {
    store.setLocal(google()[0].id, local({ percentComplete: 10, categories: ['Home'], attachments: [attachment] }))
    store.update(microsoft().id, { native: { reminder: '2026-10-21T07:00:00.000Z' } })
    const backup = store.exportBackup()
    expect(backup.schemaVersion).toBe(2)
    const restored = new TaskStore(join(directory, 'restored.sqlite'))
    try {
      restored.restoreBackup(backup)
      expect(restored.entities('g', 'gmail')[0].local.extended).toEqual({ percentComplete: 10, categories: ['Home'], attachments: [attachment] })
      expect(restored.entities('m', 'microsoft')[0].fields.native?.reminder).toBe('2026-10-21T07:00:00.000Z')
      expect(restored.operations().at(-1)).toMatchObject({ status: 'review', error: 'restored-write' })
      // A backup written before E44 (schema 1, no overlays) restores unchanged.
      const legacy = structuredClone(backup) as unknown as Record<string, any>
      legacy.schemaVersion = 1
      for (const entity of legacy.entities) delete entity.local.extended
      for (const operation of legacy.operations) delete operation.before.local.extended
      restored.restoreBackup(legacy)
      expect(restored.entities('g', 'gmail')[0].local).toEqual({ priority: 'normal', recurrence: 'none' })
    } finally { restored.close() }
    // Schema 1 cannot carry overlays, embedded files must match references, and Microsoft overlays stay progress-only.
    expect(() => parseTaskBackup({ ...backup, schemaVersion: 1 })).toThrow('invalid or unsupported')
    expect(() => parseTaskBackup({ ...backup, attachments: [] })).toThrow('invalid or unsupported')
    expect(() => parseTaskBackup({ ...backup, attachments: [{ id: 'file', name: 'list.txt', size: 4, mime: 'txt', dataBase64: 'bGlzdA==' }] })).not.toThrow()
    expect(() => parseTaskBackup({ ...backup, attachments: [{ id: 'file', name: 'other.txt', size: 4, mime: 'txt', dataBase64: 'bGlzdA==' }] })).toThrow('invalid or unsupported')
    const microsoftOverlay = structuredClone(backup)
    microsoftOverlay.entities.find((entity) => entity.provider === 'microsoft')!.local.extended = { start: '2026-10-21' }
    expect(() => parseTaskBackup(microsoftOverlay)).toThrow('invalid or unsupported')
  })
})
