import { contextBridge, ipcRenderer } from 'electron'

// Preload for the hidden chat service webContents. It exposes exactly three
// channels; the main process identifies the account by the sender webContents,
// never by anything in a payload.
contextBridge.exposeInMainWorld('aerioChatService', {
  onCommand: (callback: (message: unknown) => void) => {
    ipcRenderer.on('chat-service:command', (_event, message) => callback(message))
  },
  reply: (id: number, result: unknown) => ipcRenderer.send('chat-service:reply', id, result),
  emit: (event: unknown) => ipcRenderer.send('chat-service:event', event)
})
