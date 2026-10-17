import { BrowserWindow, dialog, type IpcMain } from 'electron'
import { statSync } from 'node:fs'
import type {
  MailAccountSummary,
  MailImportChooseResult,
  MailImportItem,
  MailImportJob,
  MailImportStartInput,
  MailLocalTransferInput,
  MailLocalTransferResult
} from '../../src/mail-types'
import { MAIL_IMPORT_EXTENSIONS, mailImportSourceKind, unsupportedMailImportReason } from '../../src/lib/local-folders'
import type { MailWorkerCommand, MailWorkerResult } from '../mail-protocol'
import { pstHeaderProblem } from './pst-header'

const pstProblem = (path: string) => {
  try { return pstHeaderProblem(path) } catch { return undefined }
}

interface MailImportWorker {
  request<T extends MailWorkerResult = void>(command: MailWorkerCommand): Promise<T>
}

export interface MailImportIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  worker(): MailImportWorker
  /** Records the Local Folders account so credential lookups know its provider. */
  localAccount(account: MailAccountSummary): void
  showOpenDialog?: (owner: BrowserWindow | undefined, options: Electron.OpenDialogOptions) => Promise<Electron.OpenDialogReturnValue>
}

const id = (value: unknown, label = 'import') => {
  if (typeof value !== 'string' || !value || value.length > 200) throw new Error(`Invalid ${label} id`)
  return value
}

export function validateImportStart(input: unknown, approved: Set<string>): MailImportStartInput {
  const value = input as Partial<MailImportStartInput> | undefined
  if (!value || !Array.isArray(value.paths) || !value.paths.length || value.paths.length > 500) throw new Error('Choose the files or folders to import')
  // Only paths the user picked in Aerio's own dialog can be read.
  for (const path of value.paths) if (typeof path !== 'string' || !approved.has(path)) throw new Error('Choose the files or folders to import again')
  if (value.duplicates !== 'review' && value.duplicates !== 'import') throw new Error('Choose how duplicates are handled')
  if (value.mboxVariant !== 'mboxrd' && value.mboxVariant !== 'mboxo') throw new Error('Choose the MBOX format')
  if (value.parentLabelId !== undefined && (typeof value.parentLabelId !== 'string' || !value.parentLabelId || value.parentLabelId.length > 500)) throw new Error('Choose a valid destination folder')
  return { paths: [...value.paths], duplicates: value.duplicates, mboxVariant: value.mboxVariant, ...(value.parentLabelId ? { parentLabelId: value.parentLabelId } : {}) }
}

export function validateLocalTransfer(input: unknown): MailLocalTransferInput {
  const value = input as Partial<MailLocalTransferInput> | undefined
  const text = (item: unknown) => typeof item === 'string' && item.length > 0 && item.length <= 500
  if (!value || !text(value.sourceAccountId) || !text(value.destinationLabelId)) throw new Error('Choose messages and a Local Folders destination')
  if (!Array.isArray(value.threadIds) || !value.threadIds.length || value.threadIds.length > 500 || !value.threadIds.every(text)) throw new Error('Choose up to 500 conversations')
  if (value.mode !== 'copy' && value.mode !== 'move') throw new Error('Choose copy or move')
  return { sourceAccountId: value.sourceAccountId!, threadIds: [...value.threadIds], destinationLabelId: value.destinationLabelId!, mode: value.mode }
}

export function chooseResult(paths: string[]): MailImportChooseResult {
  const result: MailImportChooseResult = { paths: [], unsupported: [] }
  for (const path of paths) {
    // Outlook files with an unreadable header (or high encryption) are
    // explained right away rather than failing once the import starts.
    const reason = statSync(path, { throwIfNoEntry: false })?.isDirectory() ? undefined
      : unsupportedMailImportReason(path) ?? (mailImportSourceKind(path) === 'pst' ? pstProblem(path) : undefined)
    if (reason) result.unsupported.push({ path, reason })
    else result.paths.push(path)
  }
  return result
}

export function registerMailImport(options: MailImportIpcOptions) {
  const { ipcMain } = options
  const approved = new Set<string>()
  const show = options.showOpenDialog ?? ((owner, settings) => owner ? dialog.showOpenDialog(owner, settings) : dialog.showOpenDialog(settings))

  ipcMain.handle('mail:local:ensure', async () => {
    const account = await options.worker().request<MailAccountSummary>({ type: 'local:ensure' })
    options.localAccount(account)
    return account
  })
  ipcMain.handle('mail:import:choose', async (event, kind: unknown) => {
    if (kind !== 'files' && kind !== 'folder') throw new Error('Choose files or a folder')
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const result = await show(owner, kind === 'folder'
      ? { title: 'Import a mail folder', properties: ['openDirectory'] }
      : {
        title: 'Import MBOX, EML or Outlook files',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Mail archives and Outlook data files', extensions: MAIL_IMPORT_EXTENSIONS }, { name: 'All files', extensions: ['*'] }]
      })
    if (result.canceled) return { paths: [], unsupported: [] } satisfies MailImportChooseResult
    const chosen = chooseResult(result.filePaths)
    for (const path of chosen.paths) approved.add(path)
    return chosen
  })
  ipcMain.handle('mail:import:start', async (_event, input: unknown) => {
    const job = await options.worker().request<MailImportJob>({ type: 'import:start', payload: validateImportStart(input, approved) })
    const account = (await options.worker().request<MailAccountSummary[]>({ type: 'accounts:list' })).find((item) => item.id === job.accountId)
    if (account) options.localAccount(account)
    return job
  })
  ipcMain.handle('mail:import:list', () => options.worker().request<MailImportJob[]>({ type: 'import:list' }))
  for (const action of ['pause', 'resume', 'cancel', 'dismiss'] as const) {
    ipcMain.handle(`mail:import:${action}`, (_event, jobId: unknown) => options.worker().request<MailImportJob>({ type: `import:${action}`, payload: { id: id(jobId) } }))
  }
  ipcMain.handle('mail:import:items', (_event, jobId: unknown) => options.worker().request<MailImportItem[]>({ type: 'import:items', payload: { jobId: id(jobId) } }))
  ipcMain.handle('mail:import:resolve', (_event, jobId: unknown, keys: unknown, decision: unknown) => {
    if (!Array.isArray(keys) || !keys.length || keys.length > 5_000 || !keys.every((key) => typeof key === 'string' && key.length > 0 && key.length <= 100)) throw new Error('Choose the messages to review')
    if (decision !== 'import' && decision !== 'discard') throw new Error('Choose import or discard')
    return options.worker().request<MailImportJob>({ type: 'import:resolve', payload: { jobId: id(jobId), keys: keys as string[], decision } })
  })
  ipcMain.handle('mail:local:transfer', (_event, input: unknown) =>
    options.worker().request<MailLocalTransferResult>({ type: 'local:transfer', payload: validateLocalTransfer(input) }))
}
