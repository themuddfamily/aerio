import { describe, expect, it } from 'vitest'
import type { ProviderProductivityData } from '../../src/productivity-types'
import { ProductivityStore } from './store'

const data: ProviderProductivityData = {
  calendars: [{ id: 'account:calendar', remoteId: 'remote-calendar', accountId: 'account', provider: 'gmail', name: 'Work', color: '#6558e8', primary: true, canWrite: true }],
  events: [{
    id: 'account:event', remoteId: 'remote-event', accountId: 'account', provider: 'gmail', readOnly: false,
    calendarId: 'account:calendar', title: 'Planning', start: '2026-08-01T09:00:00Z', end: '2026-08-01T10:00:00Z',
    color: '#6558e8', attendees: [], reminderMinutes: 30, recurrence: 'none'
  }],
  contacts: [{
    id: 'account:contact', remoteId: 'people/1', accountId: 'account', provider: 'gmail', readOnly: false,
    name: 'Ada Lovelace', email: 'ada@example.com', group: 'Google', favorite: false, color: '#4d8f78'
  }]
}

describe('ProductivityStore', () => {
  it('atomically replaces an account snapshot and records sync state', () => {
    const store = new ProductivityStore(':memory:')
    store.setSyncing('account')
    expect(store.snapshot().sync.every((state) => state.phase === 'syncing')).toBe(true)
    store.replaceAccount('account', 'gmail', data)
    const snapshot = store.snapshot()
    expect(snapshot.calendars).toEqual(data.calendars)
    expect(snapshot.events).toEqual(data.events)
    expect(snapshot.contacts).toEqual(data.contacts)
    expect(snapshot.sync).toHaveLength(2)
    expect(snapshot.sync.every((state) => state.phase === 'ready' && state.lastSyncedAt)).toBe(true)

    store.replaceAccount('account', 'gmail', { calendars: data.calendars, events: [], contacts: [] })
    expect(store.snapshot()).toMatchObject({ events: [], contacts: [] })
    store.removeAccount('account')
    expect(store.snapshot()).toEqual({ calendars: [], events: [], contacts: [], sync: [] })
    store.close()
  })

  it('retains cached data when a later synchronization fails', () => {
    const store = new ProductivityStore(':memory:')
    store.replaceAccount('account', 'gmail', data)
    store.setError('account', 'Permission needs to be renewed')
    const snapshot = store.snapshot()
    expect(snapshot.events).toHaveLength(1)
    expect(snapshot.sync.every((state) => state.phase === 'error')).toBe(true)
    store.close()
  })

  it('updates the cache after provider event writes', () => {
    const store = new ProductivityStore(':memory:')
    store.replaceAccount('account', 'gmail', data)
    const updated = { ...data.events[0], title: 'Updated planning' }
    store.upsertEvent(updated)
    expect(store.snapshot().events).toEqual([updated])
    store.deleteEvent(updated.id)
    expect(store.snapshot().events).toEqual([])
    store.close()
  })

  it('updates the cache after provider contact writes', () => {
    const store = new ProductivityStore(':memory:')
    store.replaceAccount('account', 'gmail', data)
    const updated = { ...data.contacts[0], name: 'Ada King', revision: 'revision-2' }
    store.upsertContact(updated)
    expect(store.snapshot().contacts).toEqual([updated])
    store.deleteContact(updated.id)
    expect(store.snapshot().contacts).toEqual([])
    store.close()
  })

  it('keeps production local Tasks and Notes outside provider snapshots', () => {
    const store = new ProductivityStore(':memory:')
    expect(store.localSnapshot()).toEqual({ tasks: [], notes: [], contacts: [] })
    store.saveLocal({
      tasks: [{ id: 'task-1', listId: 'Inbox', title: 'Prepare Aerio', priority: 'high', completed: false, subtasks: [] }],
      notes: [{ id: 'note-1', folder: 'Personal', title: 'Launch notes', content: 'Keep this local.', tags: [], pinned: false, archived: false, updatedAt: '2026-08-01T00:00:00Z' }],
      contacts: [{ id: 'contact-local', name: 'Local Person', email: 'local@example.test', group: 'Personal', favorite: false, color: '#4d8f78', source: 'local' }]
    })
    expect(store.localSnapshot()).toMatchObject({ tasks: [{ title: 'Prepare Aerio' }], notes: [{ title: 'Launch notes' }], contacts: [{ name: 'Local Person' }] })
    expect(store.snapshot()).toEqual({ calendars: [], events: [], contacts: [], sync: [] })
    store.close()
  })

  it('rolls transactions back if account replacement or local persistence fails', () => {
    for (const operation of ['replace', 'local'] as const) {
      const store = new ProductivityStore(':memory:')
      const database = (store as unknown as { db: { exec(sql: string): void } }).db
      const originalExec = database.exec.bind(database)
      database.exec = (sql: string) => {
        if (sql === 'COMMIT') throw new Error('disk full')
        originalExec(sql)
      }
      expect(() => operation === 'replace'
        ? store.replaceAccount('account', 'gmail', data)
        : store.saveLocal({ tasks: [], notes: [] })).toThrow('disk full')
      database.exec = originalExec
      expect(operation === 'replace' ? store.snapshot().events : store.localSnapshot().tasks).toEqual([])
      store.close()
    }
  })

  it('rolls account removal back if deletion fails', () => {
    const store = new ProductivityStore(':memory:')
    store.replaceAccount('account', 'gmail', data)
    const database = (store as unknown as { db: { exec(sql: string): void } }).db
    const originalExec = database.exec.bind(database)
    database.exec = (sql: string) => {
      if (sql === 'COMMIT') throw new Error('busy')
      originalExec(sql)
    }
    expect(() => store.removeAccount('account')).toThrow('busy')
    database.exec = originalExec
    expect(store.snapshot().events).toHaveLength(1)
    store.close()
  })
})
