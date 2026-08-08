import type { AppState, ModuleId } from '../types'

export const uid = (prefix: string) => `${prefix}-${crypto.randomUUID()}`

export function unreadCount(state: AppState, module: ModuleId) {
  if (module === 'tasks') return state.tasks.filter((task) => !task.completed && task.due && new Date(task.due) < new Date()).length
  return 0
}

export function formatFileSize(bytes: number) {
  if (!bytes) return 'Local file'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
