import type { AppPreferences } from '../src/types'
import { messageToolbarCommands, normalizeMessageToolbar, type MessageToolbarCommand } from '../src/lib/message-toolbar'
export function registerMessageToolbar({ ipcMain, load, save, broadcast }: {
  ipcMain: { handle(channel: string, handler: (event: unknown, input?: unknown) => unknown): void }
  load(): AppPreferences; save(preferences: AppPreferences): unknown; broadcast(commands: MessageToolbarCommand[]): void
}) {
  ipcMain.handle('message-toolbar:get', () => normalizeMessageToolbar(load().settings.messageToolbar))
  ipcMain.handle('message-toolbar:set', (_event, input) => {
    if (!Array.isArray(input) || input.length > messageToolbarCommands.length || input.some((item) => !messageToolbarCommands.includes(item))) throw new Error('Invalid message toolbar commands.')
    const commands = normalizeMessageToolbar(input)
    const preferences = load()
    save({ ...preferences, settings: { ...preferences.settings, messageToolbar: commands } })
    broadcast(commands)
    return commands
  })
}
