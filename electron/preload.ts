import { contextBridge, ipcRenderer } from 'electron'
import type { AerioDesktopApi, AppState } from '../src/types'

const api: AerioDesktopApi = {
  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: (state: AppState) => ipcRenderer.invoke('state:save', state),
  resetState: () => ipcRenderer.invoke('state:reset'),
  chooseAttachments: () => ipcRenderer.invoke('files:choose'),
  notify: (title: string, body: string) => ipcRenderer.invoke('notification:show', { title, body }),
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized')
  },
  onWindowState: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, maximized: boolean) => callback(maximized)
    ipcRenderer.on('window:maximized-state', listener)
    return () => ipcRenderer.removeListener('window:maximized-state', listener)
  },
  onComposeCommand: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('command:compose', listener)
    return () => ipcRenderer.removeListener('command:compose', listener)
  }
}

contextBridge.exposeInMainWorld('aerio', api)
