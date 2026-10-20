export const messageToolbarCommands = ['reply', 'replyAll', 'forward', 'read', 'archive', 'trash', 'star', 'pin'] as const
export type MessageToolbarCommand = typeof messageToolbarCommands[number]
export const messageToolbarLabels: Record<MessageToolbarCommand, string> = { reply: 'Reply', replyAll: 'Reply all', forward: 'Forward', read: 'Read / unread', archive: 'Archive / inbox', trash: 'Trash / restore', star: 'Star / unstar', pin: 'Pin / unpin' }
export function normalizeMessageToolbar(value: unknown): MessageToolbarCommand[] {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is MessageToolbarCommand => typeof item === 'string' && messageToolbarCommands.includes(item as MessageToolbarCommand)))] : [...messageToolbarCommands]
}
export interface MessageToolbarApi {
  get(): Promise<MessageToolbarCommand[]>
  set(commands: MessageToolbarCommand[]): Promise<MessageToolbarCommand[]>
  onChange(callback: (commands: MessageToolbarCommand[]) => void): () => void
}
