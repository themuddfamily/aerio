import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => undefined },
  dialog: { showOpenDialog: vi.fn() }
}))
import { chooseResult, registerMailImport, validateImportStart, validateLocalTransfer } from './mail-import-ipc'
import { pstHeader } from './mail-import.fixtures'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function setup(filePaths: string[]) {
  const handlers = new Map<string, (...args: any[]) => any>()
  const local = { id: 'local-folders', provider: 'local' }
  const request = vi.fn(async (command: any): Promise<any> => {
    if (command.type === 'local:ensure') return local
    if (command.type === 'import:start') return { id: 'job-1', accountId: 'local-folders' }
    if (command.type === 'accounts:list') return [local]
    return { command }
  })
  const localAccount = vi.fn()
  const showOpenDialog = vi.fn(async () => ({ canceled: false, filePaths }))
  registerMailImport({ ipcMain: { handle: (channel: string, handler: any) => handlers.set(channel, handler) } as any, worker: () => ({ request }) as any, localAccount, showOpenDialog })
  const invoke = async (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender: {} }, ...args)
  return { invoke, request, localAccount, showOpenDialog }
}

describe('mail import IPC', () => {
  it('only starts imports for paths chosen in the dialog and explains unreadable Outlook files', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aerio-import-ipc-'))
    directories.push(directory)
    const mailbox = join(directory, 'Inbox.mbox')
    const pst = join(directory, 'Outlook.pst')
    const ost = join(directory, 'Cache.ost')
    const notPst = join(directory, 'Broken.pst')
    const encrypted = join(directory, 'Secret.pst')
    const msg = join(directory, 'Note.msg')
    writeFileSync(mailbox, 'From a Thu Oct 16 2025\n')
    writeFileSync(pst, pstHeader())
    writeFileSync(ost, pstHeader({ version: 36 }))
    writeFileSync(notPst, 'PST')
    writeFileSync(encrypted, pstHeader({ encryption: 2 }))
    writeFileSync(msg, 'MSG')
    const context = setup([mailbox, pst, ost, notPst, encrypted, msg, directory])
    await expect(context.invoke('mail:import:choose', 'disk')).rejects.toThrow('Choose files or a folder')
    const chosen = await context.invoke('mail:import:choose', 'files')
    expect(chosen.paths).toEqual([mailbox, pst, ost, directory])
    expect(chosen.unsupported).toEqual([
      { path: notPst, reason: expect.stringMatching(/isn’t an Outlook data file/) },
      { path: encrypted, reason: expect.stringMatching(/high encryption/) },
      { path: msg, reason: expect.stringMatching(/\.msg files cannot be imported yet/) }
    ])
    expect(context.showOpenDialog).toHaveBeenCalledWith(undefined, expect.objectContaining({ properties: ['openFile', 'multiSelections'] }))

    await expect(context.invoke('mail:import:start', { paths: [join(directory, 'other.mbox')], duplicates: 'review', mboxVariant: 'mboxrd' })).rejects.toThrow('again')
    await expect(context.invoke('mail:import:start', { paths: [mailbox], duplicates: 'review', mboxVariant: 'mboxrd', parentLabelId: 'folder:local-1' })).resolves.toMatchObject({ id: 'job-1' })
    expect(context.request).toHaveBeenCalledWith({ type: 'import:start', payload: { paths: [mailbox], duplicates: 'review', mboxVariant: 'mboxrd', parentLabelId: 'folder:local-1' } })
    expect(context.localAccount).toHaveBeenCalledWith(expect.objectContaining({ provider: 'local' }))
  })

  it('routes job controls, duplicate review and transfers with validation', async () => {
    const context = setup([])
    await expect(context.invoke('mail:import:choose', 'folder')).resolves.toEqual({ paths: [], unsupported: [] })
    await expect(context.invoke('mail:local:ensure')).resolves.toMatchObject({ provider: 'local' })
    expect(context.localAccount).toHaveBeenCalled()
    await context.invoke('mail:import:list')
    for (const action of ['pause', 'resume', 'cancel', 'dismiss']) {
      await context.invoke(`mail:import:${action}`, 'job-1')
      expect(context.request).toHaveBeenCalledWith({ type: `import:${action}`, payload: { id: 'job-1' } })
    }
    await expect(context.invoke('mail:import:pause', '')).rejects.toThrow('Invalid import id')
    await context.invoke('mail:import:items', 'job-1')
    await context.invoke('mail:import:resolve', 'job-1', ['0:12'], 'import')
    expect(context.request).toHaveBeenCalledWith({ type: 'import:resolve', payload: { jobId: 'job-1', keys: ['0:12'], decision: 'import' } })
    await expect(context.invoke('mail:import:resolve', 'job-1', [], 'import')).rejects.toThrow('Choose the messages')
    await expect(context.invoke('mail:import:resolve', 'job-1', ['k'], 'keep')).rejects.toThrow('import or discard')
    await context.invoke('mail:local:transfer', { sourceAccountId: 'a', threadIds: ['t'], destinationLabelId: 'folder:local-1', mode: 'move' })
    expect(context.request).toHaveBeenCalledWith({ type: 'local:transfer', payload: { sourceAccountId: 'a', threadIds: ['t'], destinationLabelId: 'folder:local-1', mode: 'move' } })
  })

  it('validates start and transfer payloads', () => {
    const approved = new Set(['C:\\mail.mbox'])
    expect(() => validateImportStart(undefined, approved)).toThrow('Choose the files')
    expect(() => validateImportStart({ paths: ['C:\\mail.mbox'], duplicates: 'skip', mboxVariant: 'mboxrd' }, approved)).toThrow('duplicates')
    expect(() => validateImportStart({ paths: ['C:\\mail.mbox'], duplicates: 'import', mboxVariant: 'mboxcl' }, approved)).toThrow('MBOX format')
    expect(() => validateImportStart({ paths: ['C:\\mail.mbox'], duplicates: 'import', mboxVariant: 'mboxo', parentLabelId: 7 }, approved)).toThrow('destination')
    expect(validateImportStart({ paths: ['C:\\mail.mbox'], duplicates: 'import', mboxVariant: 'mboxo' }, approved)).toEqual({ paths: ['C:\\mail.mbox'], duplicates: 'import', mboxVariant: 'mboxo' })
    expect(() => validateLocalTransfer({ sourceAccountId: 'a', threadIds: [], destinationLabelId: 'f', mode: 'copy' })).toThrow('500 conversations')
    expect(() => validateLocalTransfer({ sourceAccountId: 'a', threadIds: ['t'], destinationLabelId: 'f', mode: 'link' })).toThrow('copy or move')
    expect(() => validateLocalTransfer({ threadIds: ['t'], mode: 'copy' })).toThrow('Local Folders destination')
    expect(chooseResult(['C:\\missing\\old.msg']).unsupported[0].reason).toMatch(/\.msg files cannot be imported yet/)
  })
})
