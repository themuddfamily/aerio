import type { AppState, Message, ModuleId } from '../types'

export const uid = (prefix: string) => `${prefix}-${crypto.randomUUID()}`

export function updateMessage(
  state: AppState,
  messageId: string,
  updates: Partial<Message>
): AppState {
  return {
    ...state,
    messages: state.messages.map((message) =>
      message.id === messageId ? { ...message, ...updates } : message
    )
  }
}

export function messageMatches(message: Message, query: string) {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return true
  return [
    message.from,
    message.fromEmail,
    message.subject,
    message.preview,
    message.body.replace(/<[^>]+>/g, ' '),
    ...message.labels
  ].some((value) => value.toLocaleLowerCase().includes(normalized))
}

export function unreadCount(state: AppState, module: ModuleId) {
  if (module === 'mail') return state.messages.filter((message) => message.unread && !message.trashed).length
  if (module === 'chat') return state.conversations.reduce((sum, conversation) => sum + conversation.unread, 0)
  if (module === 'tasks') return state.tasks.filter((task) => !task.completed && task.due && new Date(task.due) < new Date()).length
  return 0
}

export function formatFileSize(bytes: number) {
  if (!bytes) return 'Local file'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
