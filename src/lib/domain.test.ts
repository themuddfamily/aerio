import { describe, expect, it } from 'vitest'
import { formatFileSize, uid, unreadCount } from './domain'
import type { AppState } from '../types'

const state = (tasks: AppState['tasks'] = []): AppState => ({
  accounts: [], events: [], contacts: [], notes: [], tasks
})

describe('domain helpers', () => {
  it('creates distinct ids with the requested prefix', () => {
    expect(uid('task')).toMatch(/^task-/)
    expect(uid('task')).not.toBe(uid('task'))
  })

  it('counts only overdue incomplete tasks', () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    const future = new Date(Date.now() + 60_000).toISOString()
    expect(unreadCount(state([
      { id: '1', listId: 'Today', title: 'Late', due: past, priority: 'normal', completed: false, subtasks: [] },
      { id: '2', listId: 'Today', title: 'Done', due: past, priority: 'normal', completed: true, subtasks: [] },
      { id: '3', listId: 'Today', title: 'Later', due: future, priority: 'normal', completed: false, subtasks: [] }
    ]), 'tasks')).toBe(1)
    expect(unreadCount(state(), 'mail')).toBe(0)
  })

  it('formats attachment sizes', () => {
    expect(formatFileSize(0)).toBe('Local file')
    expect(formatFileSize(1024)).toBe('1 KB')
    expect(formatFileSize(1_572_864)).toBe('1.5 MB')
  })
})
