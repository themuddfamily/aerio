import { createHash } from 'node:crypto'
import type { DuplicateConfidence, DuplicateItem, DuplicateReasonCode } from '../../src/duplicate-cleanup-types'
import type { TaskEntity } from '../../src/task-provider-types'
import type { Task } from '../../src/types'
import { normalizeText, suggestedKeeper } from '../../src/lib/duplicate-grouping'

// Task duplicate scanner (E32). Tasks are compared inside one list and under the same
// parent. A task's subtasks are part of its signature, so a parent only matches a parent
// with identical subtasks; removing such a duplicate removes its subtasks too, because the
// kept copy has equivalent ones.

export interface TaskDuplicateItem extends DuplicateItem {
  source: 'provider' | 'local'
  taskId: string
  listId: string
  // Provider subtasks removed with the task, deepest first.
  descendantIds: string[]
  revision: string
}

export interface TaskDuplicateGroup {
  confidence: DuplicateConfidence
  codes: DuplicateReasonCode[]
  notes: string[]
  keeperId: string
  items: TaskDuplicateItem[]
}

export interface TaskListRef {
  id: string
  label: string
  ownerLabel: string
}

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const dueKey = (value: string | undefined) => {
  if (!value) return ''
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value
}
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

function children(tasks: TaskEntity[]) {
  const map = new Map<string, TaskEntity[]>()
  for (const task of tasks) if (task.parentId) map.set(task.parentId, [...(map.get(task.parentId) ?? []), task])
  return map
}

function descendants(task: TaskEntity, byParent: Map<string, TaskEntity[]>): TaskEntity[] {
  return (byParent.get(task.id) ?? []).flatMap((child) => [...descendants(child, byParent), child])
}

function providerSignature(task: TaskEntity, byParent: Map<string, TaskEntity[]>): string {
  const kids = (byParent.get(task.id) ?? []).map((child) => providerSignature(child, byParent)).sort()
  return `${normalizeText(task.fields.title)}|${dueKey(task.fields.due)}|${normalizeText(task.fields.notes)}|[${kids.join(',')}]`
}

export function providerTaskRevision(task: TaskEntity, all: TaskEntity[]) {
  const byParent = children(all)
  return hash([task, ...descendants(task, byParent)].map((item) => ({
    id: item.id, parentId: item.parentId ?? null, fields: item.fields, local: item.local, revision: item.remote?.revision ?? null, updatedAt: item.remote?.updatedAt ?? null
  })))
}

export function localTaskRevision(task: Task) {
  return hash(task)
}

function groupBy<T>(values: T[], key: (value: T) => string) {
  const map = new Map<string, T[]>()
  for (const value of values) map.set(key(value), [...(map.get(key(value)) ?? []), value])
  return [...map.values()].filter((bucket) => bucket.length > 1)
}

function finish(items: TaskDuplicateItem[], hasChildren: boolean): TaskDuplicateGroup {
  return {
    confidence: 'high',
    codes: ['task-details'],
    notes: hasChildren ? ['Each copy has the same subtasks. Removing a copy removes its subtasks; the kept copy keeps its own.'] : [],
    keeperId: suggestedKeeper(items),
    items
  }
}

export function findProviderTaskDuplicates(list: TaskListRef, tasks: TaskEntity[]): TaskDuplicateGroup[] {
  const inList = tasks.filter((task) => task.listId === list.id)
  const byParent = children(inList)
  const buckets = groupBy(inList, (task) => `${task.parentId ?? ''}\n${providerSignature(task, byParent)}`)
  return buckets.map((bucket) => {
    const items = bucket.map((task): TaskDuplicateItem => {
      const below = descendants(task, byParent)
      const blocked = [task, ...below].find((item) => item.remote?.readOnly || item.remote?.assigned)
      const blockedReason = blocked ? (blocked === task ? 'This task is read-only or assigned to you by someone else.' : 'One of its subtasks is read-only or assigned, so this copy is kept.') : undefined
      return {
        id: `task:${task.id}`,
        source: 'provider',
        taskId: task.id,
        listId: list.id,
        descendantIds: below.map((item) => item.id),
        revision: providerTaskRevision(task, inList),
        title: task.fields.title,
        ownerLabel: list.ownerLabel,
        containerLabel: list.label,
        ...(task.fields.due ? { date: task.fields.due } : {}),
        summary: [task.fields.completed ? 'Completed' : 'Open', below.length ? plural(below.length, 'subtask') : ''].filter(Boolean).join(' · '),
        details: [
          { label: 'Title', value: task.fields.title },
          { label: 'Due', value: task.fields.due ?? 'None' },
          { label: 'Notes', value: (task.fields.notes ?? '').slice(0, 300) || 'None' },
          { label: 'Status', value: task.fields.completed ? 'Completed' : 'Open' },
          { label: 'Subtasks', value: below.map((item) => item.fields.title).join(', ') || 'None' },
          { label: 'List', value: list.label }
        ],
        completeness: (task.fields.notes ? 1 : 0) + (task.fields.due ? 1 : 0) + (task.remote ? 1 : 0),
        ...(task.remote?.updatedAt ? { createdAt: task.remote.updatedAt } : {}),
        removable: !blockedReason,
        ...(blockedReason ? { blockedReason } : {})
      }
    })
    return finish(items, items.some((item) => item.descendantIds.length > 0))
  })
}

const subtaskSignature = (task: Task) => task.subtasks.map((item) => normalizeText(item.title)).sort().join(',')

export function findLocalTaskDuplicates(list: TaskListRef, tasks: Task[]): TaskDuplicateGroup[] {
  const inList = tasks.filter((task) => `local:${task.listId}` === list.id)
  const buckets = groupBy(inList, (task) => `${normalizeText(task.title)}|${dueKey(task.due)}|${normalizeText(task.notes)}|[${subtaskSignature(task)}]`)
  return buckets.map((bucket) => {
    const items = bucket.map((task): TaskDuplicateItem => ({
      id: `local-task:${task.id}`,
      source: 'local',
      taskId: task.id,
      listId: list.id,
      descendantIds: [],
      revision: localTaskRevision(task),
      title: task.title,
      ownerLabel: list.ownerLabel,
      containerLabel: list.label,
      ...(task.due ? { date: task.due } : {}),
      summary: [task.completed ? 'Completed' : 'Open', task.subtasks.length ? plural(task.subtasks.length, 'subtask') : ''].filter(Boolean).join(' · '),
      details: [
        { label: 'Title', value: task.title },
        { label: 'Due', value: task.due ?? 'None' },
        { label: 'Notes', value: (task.notes ?? '').slice(0, 300) || 'None' },
        { label: 'Status', value: task.completed ? 'Completed' : 'Open' },
        { label: 'Subtasks', value: task.subtasks.map((item) => `${item.completed ? '✓ ' : ''}${item.title}`).join(', ') || 'None' },
        { label: 'List', value: list.label }
      ],
      completeness: (task.notes ? 1 : 0) + (task.due ? 1 : 0) + task.subtasks.filter((item) => item.completed).length / 100 + (task.priority !== 'normal' ? 1 : 0) + (task.recurrence && task.recurrence !== 'none' ? 1 : 0),
      removable: true
    }))
    return finish(items, bucket.some((task) => task.subtasks.length > 0))
  })
}
