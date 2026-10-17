import type {
  CreateMailFolderInput,
  DeleteMailFolderInput,
  MailFolderDeletePreview,
  MailFolderMutationResult,
  MailLabel,
  MailProviderId,
  UpdateMailFolderInput
} from '../../src/mail-types'
import {
  gmailLabelColor,
  isSystemMailFolder,
  mailFolderCapabilities,
  mailFolderDescendants,
  mailFolderLeafName,
  mailFolderNameConflict,
  mailFolderNameError
} from '../../src/lib/mail-folders'
import type { MailDatabase } from './database'
import { FolderConflictError, FolderNotEmptyError } from './folder-errors'
import { GmailApiError, type GmailClient } from './gmail-client'
import { labelsForImapFolders, type ImapSmtpClient } from './imap-client'
import { MicrosoftGraphError, microsoftLabels, type MicrosoftGraphClient } from './microsoft-client'
import type { ExchangeFolderApi } from '../exchange/ews-mail'
import { EwsError } from '../exchange/ews-client'

type GmailFolderApi = Pick<GmailClient, 'listLabels' | 'getLabel' | 'createLabel' | 'patchLabel' | 'deleteLabel'>
type MicrosoftFolderApi = Pick<MicrosoftGraphClient, 'listFolders' | 'folder' | 'createFolder' | 'renameFolder' | 'moveFolder' | 'deleteFolder'>
type ImapFolderApi = Pick<ImapSmtpClient, 'withConnection' | 'listFolders' | 'createFolder' | 'renameFolder' | 'deleteFolder'>

export interface MailFolderManagerDeps {
  database: MailDatabase
  online(): boolean
  gmail(accountId: string): GmailFolderApi
  microsoft(accountId: string): MicrosoftFolderApi
  imap(accountId: string): Promise<ImapFolderApi>
  /** On-premises Exchange (EWS); optional so existing test doubles stay valid. */
  exchange?(accountId: string): Promise<Pick<ExchangeFolderApi, 'listLabels' | 'folder' | 'createFolder' | 'renameFolder' | 'moveFolder' | 'deleteFolder'>>
}

const folderPath = (labelId: string) => labelId.startsWith('folder:') ? labelId.slice(7) : labelId

// Provider folder/label management. Changes run directly against the provider
// (never optimistically) because a folder id is needed before messages can be
// moved into it; every request is journaled so an interrupted change is
// reconciled from the provider's folder list on the next start.
export class MailFolderManager {
  constructor(private readonly deps: MailFolderManagerDeps) {}

  private get database() {
    return this.deps.database
  }

  private account(accountId: string) {
    const account = this.database.getAccount(accountId)
    if (!account) throw new Error('Account not found')
    if (account.archived) throw new Error('Reconnect this account before changing its folders')
    if (!this.deps.online() && account.provider !== 'local') throw new Error('Folder changes require an internet connection. Nothing was changed.')
    return account
  }

  private label(accountId: string, labelId: string) {
    const labels = this.database.listLabels([accountId])
    const label = labels.find((item) => item.id === labelId)
    if (!label) throw new FolderConflictError('This folder no longer exists. The folder list was refreshed.')
    if (isSystemMailFolder(label)) throw new Error(`${label.name} is a system folder and cannot be changed`)
    return { label, labels }
  }

  async refresh(accountId: string): Promise<MailLabel[]> {
    const provider = this.database.getAccount(accountId)?.provider
    if (!provider) return []
    // Local Folders have no server: the stored list is the folder list.
    if (provider === 'local') return this.database.listLabels([accountId])
    let labels: MailLabel[]
    if (provider === 'gmail') labels = await this.deps.gmail(accountId).listLabels()
    else if (provider === 'microsoft') labels = microsoftLabels(accountId, await this.deps.microsoft(accountId).listFolders())
    else if (provider === 'exchange') labels = await (await this.exchange(accountId)).listLabels(accountId)
    else {
      const client = await this.deps.imap(accountId)
      labels = labelsForImapFolders(accountId, await client.withConnection((connection) => client.listFolders(connection)))
    }
    this.database.replaceLabels(accountId, labels)
    return this.database.listLabels([accountId])
  }

  private async exchange(accountId: string) {
    if (!this.deps.exchange) throw new Error('Exchange folder management is not available')
    return this.deps.exchange(accountId)
  }

  private async journal<T>(accountId: string, kind: 'create' | 'update' | 'delete', labelId: string | undefined, input: unknown, run: () => Promise<T>) {
    const id = this.database.beginFolderOperation(accountId, kind, labelId, input)
    try {
      const result = await run()
      this.database.finishFolderOperation(id, 'succeeded')
      return result
    } catch (error) {
      const friendly = providerFolderError(error)
      this.database.finishFolderOperation(id, 'failed', friendly.message)
      // A conflict means Aerio's cached folder list is stale; re-read it so
      // the next attempt starts from the provider's current state.
      if (friendly instanceof FolderConflictError) await this.refresh(accountId).catch(() => undefined)
      throw friendly
    }
  }

  preview(accountId: string, labelId: string): MailFolderDeletePreview {
    const account = this.database.getAccount(accountId)
    if (!account) throw new Error('Account not found')
    const { label, labels } = this.label(accountId, labelId)
    const usage = this.database.folderUsage(accountId, labelId)
    const capabilities = mailFolderCapabilities(account.provider)
    return {
      labelId,
      ...usage,
      childFolders: mailFolderDescendants(label, labels).length,
      deleteKeepsMessages: capabilities.deleteKeepsMessages,
      messagesMoveTo: account.provider === 'gmail' ? 'All Mail' : account.provider === 'microsoft' || account.provider === 'exchange' ? 'Deleted Items' : 'Trash'
    }
  }

  private validateParent(provider: MailProviderId, labels: MailLabel[], parentId: string | undefined) {
    if (!parentId) return undefined
    const parent = labels.find((label) => label.id === parentId)
    if (!parent) throw new FolderConflictError('The parent folder no longer exists. The folder list was refreshed.')
    if (provider === 'gmail' && parent.type !== 'user') throw new Error('Gmail labels can only be nested under other user labels')
    return parent
  }

  private validateColor(provider: MailProviderId, color: string | undefined) {
    if (color === undefined) return undefined
    if (!mailFolderCapabilities(provider).canColor) throw new Error('This provider does not support folder colors')
    const value = gmailLabelColor(color)
    if (!value) throw new Error('Choose one of the Gmail label colors')
    return { backgroundColor: value.backgroundColor, textColor: value.textColor }
  }

  async create(input: CreateMailFolderInput): Promise<MailFolderMutationResult> {
    const account = this.account(input.accountId)
    if (account.provider === 'local') return this.database.localMail.createFolder(input)
    const capabilities = mailFolderCapabilities(account.provider)
    if (!capabilities.canCreate) throw new Error('This provider does not allow creating folders')
    const name = input.name.trim()
    const nameError = mailFolderNameError(name, account.provider)
    if (nameError) throw new Error(nameError)
    const labels = this.database.listLabels([input.accountId])
    if (input.parentId && !capabilities.canNest) throw new Error('This provider does not support nested folders')
    const parent = this.validateParent(account.provider, labels, input.parentId)
    const color = this.validateColor(account.provider, input.color)
    if (mailFolderNameConflict(input.accountId, name, parent?.id, labels)) throw new Error(`A ${capabilities.kind} named “${name}” already exists here`)
    const createdId = await this.journal(input.accountId, 'create', undefined, input, async () => {
      if (account.provider === 'gmail') return (await this.deps.gmail(input.accountId).createLabel(parent ? `${parent.name}/${name}` : name, color)).id
      if (account.provider === 'microsoft') return `folder:${(await this.deps.microsoft(input.accountId).createFolder(name, parent ? folderPath(parent.id) : undefined)).id}`
      if (account.provider === 'exchange') return `folder:${(await (await this.exchange(input.accountId)).createFolder(name, parent ? folderPath(parent.id) : undefined)).id}`
      return `folder:${(await (await this.deps.imap(input.accountId)).createFolder(parent ? folderPath(parent.id) : undefined, name)).path}`
    })
    const refreshed = await this.refresh(input.accountId)
    return { label: refreshed.find((label) => label.id === createdId), labels: refreshed, renamed: {} }
  }

  async update(input: UpdateMailFolderInput): Promise<MailFolderMutationResult> {
    const account = this.account(input.accountId)
    if (account.provider === 'local') return this.database.localMail.updateFolder(input)
    const capabilities = mailFolderCapabilities(account.provider)
    const { label, labels } = this.label(input.accountId, input.labelId)
    const currentName = mailFolderLeafName(label, labels)
    const name = input.name === undefined ? currentName : input.name.trim()
    const parentId = input.parentId === undefined ? label.parentId : input.parentId ?? undefined
    const renaming = name !== currentName
    const moving = parentId !== label.parentId
    if (renaming && !capabilities.canRename) throw new Error('This provider does not allow renaming folders')
    if (moving && !capabilities.canNest) throw new Error('This provider does not support nested folders')
    if (renaming || moving) {
      const nameError = mailFolderNameError(name, account.provider)
      if (nameError) throw new Error(nameError)
    }
    const descendants = mailFolderDescendants(label, labels)
    if (moving && (parentId === label.id || descendants.some((item) => item.id === parentId))) throw new Error('A folder cannot be moved inside itself')
    const parent = moving ? this.validateParent(account.provider, labels, parentId) : labels.find((item) => item.id === parentId)
    const color = this.validateColor(account.provider, input.color)
    if ((renaming || moving) && mailFolderNameConflict(input.accountId, name, parent?.id, labels, label.id)) throw new Error(`A ${capabilities.kind} named “${name}” already exists here`)
    if (!renaming && !moving && !color) return { label, labels, renamed: {} }

    const renamed: Record<string, string> = {}
    await this.journal(input.accountId, 'update', label.id, input, async () => {
      if (account.provider === 'gmail') {
        const client = this.deps.gmail(input.accountId)
        const fullName = parent ? `${parent.name}/${name}` : name
        await client.patchLabel(label.id, { ...(renaming || moving ? { name: fullName } : {}), ...(color ? { color } : {}) })
        // Gmail nests by name only, so child labels are renamed explicitly.
        if (renaming || moving) {
          for (const child of descendants.filter((item) => item.name.startsWith(`${label.name}/`))) {
            await client.patchLabel(child.id, { name: fullName + child.name.slice(label.name.length) })
          }
        }
        return
      }
      if (account.provider === 'microsoft') {
        const client = this.deps.microsoft(input.accountId)
        const id = folderPath(label.id)
        if (renaming) await client.renameFolder(id, name)
        if (moving) {
          const moved = await client.moveFolder(id, parent ? folderPath(parent.id) : undefined)
          if (moved?.id && moved.id !== id) renamed[label.id] = `folder:${moved.id}`
        }
        return
      }
      if (account.provider === 'exchange') {
        const client = await this.exchange(input.accountId)
        const id = folderPath(label.id)
        if (renaming) await client.renameFolder(id, name)
        if (moving) {
          const moved = await client.moveFolder(id, parent ? folderPath(parent.id) : undefined)
          if (moved?.id && moved.id !== id) renamed[label.id] = `folder:${moved.id}`
        }
        return
      }
      const oldPath = folderPath(label.id)
      const result = await (await this.deps.imap(input.accountId)).renameFolder(oldPath, parent ? folderPath(parent.id) : undefined, name)
      if (result.path === oldPath) return
      // IMAP ids are mailbox paths: the folder and all of its subfolders move.
      renamed[label.id] = `folder:${result.path}`
      for (const child of descendants) {
        const childPath = folderPath(child.id)
        if (result.delimiter && childPath.startsWith(`${oldPath}${result.delimiter}`)) renamed[child.id] = `folder:${result.path}${childPath.slice(oldPath.length)}`
      }
    })
    if (Object.keys(renamed).length) {
      this.database.renameFolderReferences(input.accountId, renamed)
      this.renameProviderState(input.accountId, renamed)
    }
    const refreshed = await this.refresh(input.accountId)
    const id = renamed[label.id] ?? label.id
    return { label: refreshed.find((item) => item.id === id), labels: refreshed, renamed }
  }

  async delete(input: DeleteMailFolderInput): Promise<MailFolderMutationResult> {
    const account = this.account(input.accountId)
    if (account.provider === 'local') return this.database.localMail.deleteFolder(input)
    if (!mailFolderCapabilities(account.provider).canDelete) throw new Error('This provider does not allow deleting folders')
    const { label, labels } = this.label(input.accountId, input.labelId)
    if (mailFolderDescendants(label, labels).length) throw new Error('Delete or move this folder’s subfolders first')
    const pending = this.database.pendingOperationsForLabel(input.accountId, label.id)
    if (pending) throw new Error(`${pending} pending mail change${pending === 1 ? ' still uses' : 's still use'} this folder. Wait for ${pending === 1 ? 'it' : 'them'} to finish or undo ${pending === 1 ? 'it' : 'them'}, then try again.`)
    const local = this.database.folderUsage(input.accountId, label.id).messages
    if (local > 0 && !input.confirmNonEmpty) throw new FolderNotEmptyError(local)
    await this.journal(input.accountId, 'delete', label.id, input, async () => {
      if (account.provider === 'gmail') {
        const client = this.deps.gmail(input.accountId)
        // The cached count can lag behind Gmail; check the live total too.
        const remote = (await client.getLabel(label.id)).messagesTotal ?? 0
        if (remote > 0 && !input.confirmNonEmpty) throw new FolderNotEmptyError(remote)
        await client.deleteLabel(label.id)
        return
      }
      if (account.provider === 'microsoft') {
        const client = this.deps.microsoft(input.accountId)
        const folder = await client.folder(folderPath(label.id))
        if (folder.childFolderCount) throw new Error('Delete or move this folder’s subfolders first')
        if ((folder.totalItemCount ?? 0) > 0 && !input.confirmNonEmpty) throw new FolderNotEmptyError(folder.totalItemCount ?? 0)
        await client.deleteFolder(folderPath(label.id))
        return
      }
      if (account.provider === 'exchange') {
        const client = await this.exchange(input.accountId)
        const folder = await client.folder(folderPath(label.id))
        if (folder.childFolderCount) throw new Error('Delete or move this folder’s subfolders first')
        if ((folder.totalCount ?? 0) > 0 && !input.confirmNonEmpty) throw new FolderNotEmptyError(folder.totalCount ?? 0)
        await client.deleteFolder(folderPath(label.id))
        return
      }
      await (await this.deps.imap(input.accountId)).deleteFolder(folderPath(label.id), Boolean(input.confirmNonEmpty))
    })
    if (account.provider === 'gmail') this.database.removeLabelReferences(input.accountId, label.id)
    else if (account.provider === 'exchange') {
      // The folder (and its messages) moved to Deleted Items; the next sync lists them there.
      this.database.reconcileRemoteFolder(input.accountId, folderPath(label.id), new Set())
      this.renameProviderState(input.accountId, { [label.id]: '' })
    } else if (account.provider !== 'microsoft') {
      // The server copies now live in Trash and are downloaded there by the
      // next sync; drop the cached copies that still point at the old path.
      this.database.reconcileRemoteFolder(input.accountId, folderPath(label.id), new Set())
      this.renameProviderState(input.accountId, { [label.id]: '' })
    }
    const refreshed = await this.refresh(input.accountId)
    return { labels: refreshed, renamed: {}, deletedId: label.id }
  }

  // IMAP keeps per-folder UIDVALIDITY checkpoints keyed by path and Microsoft
  // keeps delta links keyed by folder id; follow the rename (or drop on delete).
  private renameProviderState(accountId: string, renamed: Record<string, string>) {
    const state = this.database.getProviderState<{ folders?: Record<string, unknown>; deltaLinks?: Record<string, unknown> }>(accountId, {})
    let changed = false
    for (const key of ['folders', 'deltaLinks'] as const) {
      const entries = state[key]
      if (!entries) continue
      for (const [from, to] of Object.entries(renamed)) {
        const oldKey = folderPath(from)
        if (!(oldKey in entries)) continue
        if (to) entries[folderPath(to)] = entries[oldKey]
        delete entries[oldKey]
        changed = true
      }
    }
    if (changed) this.database.setProviderState(accountId, state)
  }
}

// Converts provider-specific failures into the conflict/error classes the
// manager and renderer understand, keeping the provider's wording otherwise.
export function providerFolderError(error: unknown): Error {
  if (error instanceof FolderConflictError || error instanceof FolderNotEmptyError) return error
  if (error instanceof GmailApiError || error instanceof MicrosoftGraphError) {
    if (error.status === 409) return new Error('A folder or label with that name already exists on the server')
    if (error.status === 404) return new FolderConflictError('The folder was changed or removed on the server. The folder list was refreshed.')
    return error
  }
  if (error instanceof EwsError) {
    if (error.code === 'ErrorFolderExists') return new Error('A folder with that name already exists on the Exchange server')
    if (error.code === 'ErrorFolderNotFound' || error.code === 'ErrorItemNotFound') return new FolderConflictError('The folder was changed or removed on the Exchange server. The folder list was refreshed.')
    return error
  }
  const code = (error as { serverResponseCode?: string } | undefined)?.serverResponseCode
  if (code === 'ALREADYEXISTS') return new Error('A folder with that name already exists on the mail server')
  if (code === 'NONEXISTENT') return new FolderConflictError('The folder was changed or removed on the mail server. The folder list was refreshed.')
  return error instanceof Error ? error : new Error(String(error))
}
