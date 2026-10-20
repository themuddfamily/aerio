import type { IpcMain } from 'electron'
import type { MailWorkerClient } from './mail/worker-client'
export function registerTaskDelegations(ipc: Pick<IpcMain, 'handle'>, worker: () => Pick<MailWorkerClient, 'request'>, unlocked: () => void) {
  for (const method of ['list', 'assign', 'update', 'respond', 'inspect', 'retry'] as const) ipc.handle(`task-delegations:${method}`, (_event, payload) => {
    unlocked()
    return worker().request({ type: `task-delegations:${method}`, payload } as Parameters<MailWorkerClient['request']>[0])
  })
}
