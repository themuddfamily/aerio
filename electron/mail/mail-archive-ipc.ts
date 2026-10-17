import type { IpcMain } from 'electron'
import type { MailArchiveItem, MailArchiveJob, MailArchivePreview, MailArchiveStatus } from '../../src/mail-archive-types'
import { validateMailArchivePolicy } from '../../src/lib/mail-archive'
import type { MailWorkerCommand, MailWorkerResult } from '../mail-protocol'

interface MailArchiveWorker {
  request<T extends MailWorkerResult = void>(command: MailWorkerCommand): Promise<T>
}

export interface MailArchiveIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  worker(): MailArchiveWorker
  isLocked(): boolean
}

const id = (value: unknown, label: string) => {
  if (typeof value !== 'string' || !value || value.length > 200) throw new Error(`Invalid ${label} id`)
  return value
}

/**
 * IPC for automatic archiving (E31). Policies are validated here and again in
 * the worker (which knows the provider). Previews list subjects and senders,
 * so every channel refuses while Aerio is locked.
 */
export function registerMailArchiving(options: MailArchiveIpcOptions) {
  const { ipcMain } = options
  const unlocked = () => {
    if (options.isLocked()) throw new Error('Unlock Aerio to manage automatic archiving')
  }
  ipcMain.handle('mail:archive:get', (_event, accountId: unknown) => {
    unlocked()
    return options.worker().request<MailArchiveStatus>({ type: 'archive:get', payload: { accountId: id(accountId, 'account') } })
  })
  ipcMain.handle('mail:archive:save', (_event, input: unknown) => {
    unlocked()
    return options.worker().request<MailArchiveStatus>({ type: 'archive:save', payload: validateMailArchivePolicy(input) })
  })
  ipcMain.handle('mail:archive:preview', (_event, input: unknown) => {
    unlocked()
    return options.worker().request<MailArchivePreview>({ type: 'archive:preview', payload: validateMailArchivePolicy(input) })
  })
  ipcMain.handle('mail:archive:run', (_event, accountId: unknown) => {
    unlocked()
    return options.worker().request<MailArchiveJob>({ type: 'archive:run', payload: { accountId: id(accountId, 'account') } })
  })
  for (const action of ['resume', 'cancel'] as const) {
    ipcMain.handle(`mail:archive:${action}`, (_event, jobId: unknown) => {
      unlocked()
      return options.worker().request<MailArchiveJob>({ type: `archive:${action}`, payload: { jobId: id(jobId, 'archive run') } })
    })
  }
  ipcMain.handle('mail:archive:items', (_event, jobId: unknown) => {
    unlocked()
    return options.worker().request<MailArchiveItem[]>({ type: 'archive:items', payload: { jobId: id(jobId, 'archive run') } })
  })
}
