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

  it('keeps production local Tasks and Notes outside provider snapshots', () => {
    const store = new ProductivityStore(':memory:')
    store.saveLocal({
      tasks: [{ id: 'task-1', listId: 'Inbox', title: 'Prepare Aerio', priority: 'high', completed: false, subtasks: [] }],
      notes: [{ id: 'note-1', folder: 'Personal', title: 'Launch notes', content: 'Keep this local.', tags: [], pinned: false, archived: false, updatedAt: '2026-08-01T00:00:00Z' }]
    })
    expect(store.localSnapshot()).toMatchObject({ tasks: [{ title: 'Prepare Aerio' }], notes: [{ title: 'Launch notes' }] })
    expect(store.snapshot()).toEqual({ calendars: [], events: [], contacts: [], sync: [] })
    store.close()
  })
})
