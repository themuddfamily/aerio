import { describe, expect, it } from 'vitest'
import type { TaskEntity } from '../../src/task-provider-types'
import type { Task } from '../../src/types'
import { findLocalTaskDuplicates, findProviderTaskDuplicates } from './task-duplicates'

const list = { id: 'list-1', label: 'Work', ownerLabel: 'ada@example.com' }
const entity = (id: string, title: string, overrides: Partial<TaskEntity> = {}, fields: Partial<TaskEntity['fields']> = {}): TaskEntity => ({
  id, accountId: 'acc', provider: 'gmail', listId: 'list-1', fields: { title, completed: false, ...fields }, local: { priority: 'normal', recurrence: 'none' },
  remote: { id, accountId: 'acc', provider: 'gmail', remoteId: id, listId: 'list-1', remoteListId: 'l', title, completed: false, readOnly: false, revision: `rev-${id}` },
  ...overrides
})

describe('task duplicate scanner', () => {
  it('groups tasks with the same title, due date, and notes in one list', () => {
    const groups = findProviderTaskDuplicates(list, [
      entity('a', 'Pay rent', {}, { due: '2026-11-01T00:00:00.000Z', notes: 'Online' }),
      entity('b', 'pay  rent', {}, { due: '2026-11-01T00:00:00Z', notes: 'online' }),
      entity('c', 'Pay rent', {}, { due: '2026-12-01T00:00:00.000Z', notes: 'Online' }),
      entity('d', 'Pay rent', {}, { due: '2026-11-01T00:00:00.000Z' }),
      entity('e', 'Pay rent', { listId: 'list-2' }, { due: '2026-11-01T00:00:00.000Z', notes: 'Online' })
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].items.map((item) => item.taskId).sort()).toEqual(['a', 'b'])
    expect(groups[0]).toMatchObject({ confidence: 'high', codes: ['task-details'] })
  })

  it('only groups parents whose subtasks are identical and removes subtasks with their parent', () => {
    const tasks = [
      entity('p1', 'Trip'), entity('p1-a', 'Book flight', { parentId: 'p1' }), entity('p1-b', 'Pack', { parentId: 'p1' }),
      entity('p2', 'Trip'), entity('p2-a', 'Pack', { parentId: 'p2' }), entity('p2-b', 'Book flight', { parentId: 'p2' }),
      entity('p3', 'Trip'), entity('p3-a', 'Book hotel', { parentId: 'p3' }),
      entity('p4', 'Trip')
    ]
    const groups = findProviderTaskDuplicates(list, tasks)
    const parents = groups.find((group) => group.items.some((item) => item.taskId === 'p1'))!
    expect(parents.items.map((item) => item.taskId).sort()).toEqual(['p1', 'p2'])
    expect(parents.items.find((item) => item.taskId === 'p2')!.descendantIds.sort()).toEqual(['p2-a', 'p2-b'])
    expect(parents.notes.join(' ')).toMatch(/same subtasks/)
    // Subtasks of different parents are never compared with each other.
    expect(groups.some((group) => group.items.some((item) => item.taskId === 'p1-a'))).toBe(false)
    // A childless "Trip" and one with different subtasks stay apart.
    expect(groups.some((group) => group.items.some((item) => ['p3', 'p4'].includes(item.taskId)))).toBe(false)
  })

  it('groups duplicate subtasks under the same parent', () => {
    const groups = findProviderTaskDuplicates(list, [entity('p', 'Trip'), entity('c1', 'Pack', { parentId: 'p' }), entity('c2', 'Pack', { parentId: 'p' })])
    expect(groups.map((group) => group.items.map((item) => item.taskId).sort())).toEqual([['c1', 'c2']])
  })

  it('keeps assigned or read-only tasks', () => {
    const [group] = findProviderTaskDuplicates(list, [entity('a', 'Review'), { ...entity('b', 'Review'), remote: { ...entity('b', 'Review').remote!, assigned: true } }])
    expect(group.items.find((item) => item.taskId === 'b')).toMatchObject({ removable: false })
    expect(group.keeperId).toBe('task:b')
  })

  it('compares local tasks with their checklist subtasks', () => {
    const task = (id: string, subtasks: string[], overrides: Partial<Task> = {}): Task => ({
      id, listId: 'Home', title: 'Groceries', priority: 'normal', completed: false, subtasks: subtasks.map((title, index) => ({ id: `${id}-${index}`, title, completed: false })), ...overrides
    })
    const groups = findLocalTaskDuplicates({ id: 'local:Home', label: 'Home', ownerLabel: 'Tasks on this PC' }, [
      task('a', ['Milk', 'Eggs']), task('b', ['Eggs', 'Milk']), task('c', ['Milk']), task('d', ['Milk', 'Eggs'], { listId: 'Work' })
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].items.map((item) => item.taskId).sort()).toEqual(['a', 'b'])
  })
})
