import { createHash } from 'node:crypto'
import type { ApplyMailActionInput, MailAccountSummary, MailActionKind, MailSendOptions, MailWorkerEvent } from '../../src/mail-types'
import type { MailSenderIdentity } from '../../src/mail-identity-types'
import {
  parseOwnerLabel,
  PRIMARY_MAILBOX_OWNER,
  PUBLIC_FOLDERS_OWNER,
  type AttachMailboxInput,
  type DiscoveredMailbox,
  type HeldMailboxOperation,
  type MailboxDelegation,
  type MailboxDiscoveryResult,
  type MailboxOwnerSummary,
  type MeetingRequestDelivery,
  type PublicFolderNode,
  type SaveDelegateInput,
  type UpdateMailboxOwnerInput
} from '../../src/mailbox-owner-types'
import { isPinMailAction } from '../../src/lib/mail-pins'
import { addDelegate, delegationErrorMessage, getDelegates, removeDelegate, updateDelegate } from '../exchange/ews-delegation'
import { EwsClient, EwsError } from '../exchange/ews-client'
import {
  applyOwnerExchangeAction, browsePublicFolders, discoverExchangeMailboxes, probeExchangeMailbox, publicFolderAccess, publicFolderClient, sendExchangeDelegated,
  syncExchangeOwner, syncPublicFolders
} from '../exchange/ews-shared-mailbox'
import { EwsAuthError, EwsNetworkError } from '../exchange/ews-transport'
import type { ExchangeAccountConfig } from '../exchange/exchange-config'
import type { FolderRef } from '../exchange/ews-xml'
import type { MailDatabase } from './database'
import { applyOwnerGraphAction, isGraphDenied, isGraphMissing, probeGraphMailbox, sendGraphDelegated, syncGraphOwner } from './graph-shared-mailbox'
import type { MicrosoftGraphClient } from './microsoft-client'
import { MicrosoftGraphError } from './microsoft-client'
import { accessRemovedMessage, MailboxAccessRemovedError, ownerLabels, type StoredOwnerMessage } from './mailbox-owner-sync'
import type { StoredMailboxOwner, StoredOwnerFolder } from './mailbox-owner-store'
import { formatSenderAddress, SenderIdentityError } from './sender-identity'

// Mail-worker side of shared/delegated mailboxes and public folders (E40): attaching and removing
// owners, synchronizing them after the account's own mailbox, enforcing their effective rights on
// queued actions, holding actions when access is removed, delegate management, the public folder
// browser, and send as / send on behalf.

export type MailboxOwnerCommand =
  | { type: 'owners:list'; payload: { accountId?: string } }
  | { type: 'owners:discover'; payload: { accountId: string } }
  | { type: 'owners:attach'; payload: AttachMailboxInput }
  | { type: 'owners:update'; payload: UpdateMailboxOwnerInput }
  | { type: 'owners:remove'; payload: { accountId: string; ownerId: string } }
  | { type: 'owners:sync'; payload: { accountId: string; ownerId?: string } }
  | { type: 'owners:public-folders'; payload: { accountId: string; parentFolderId?: string } }
  | { type: 'owners:subscribe'; payload: { accountId: string; folderId: string; subscribed: boolean } }
  | { type: 'owners:delegates'; payload: { accountId: string } }
  | { type: 'owners:save-delegate'; payload: SaveDelegateInput }
  | { type: 'owners:remove-delegate'; payload: { accountId: string; address: string } }
  | { type: 'owners:meeting-delivery'; payload: { accountId: string; delivery: MeetingRequestDelivery } }
  | { type: 'owners:held'; payload: { accountId?: string } }
  | { type: 'owners:resolve-held'; payload: { operationId: string; decision: 'retry' | 'discard' } }
  | { type: 'owners:productivity-folders'; payload: { accountId: string } }

/** A calendar or contacts folder of another owner for the Exchange Calendar/Contacts service. */
export interface OwnerProductivityFolder {
  ref: FolderRef
  name: string
  kind: 'calendar' | 'contacts'
  headers?: Record<string, string>
  readOnly?: boolean
}

export type MailboxOwnerResult = MailboxOwnerSummary | MailboxOwnerSummary[] | MailboxDiscoveryResult | PublicFolderNode[] | MailboxDelegation | HeldMailboxOperation[] | OwnerProductivityFolder[] | undefined

export const isMailboxOwnerCommand = (command: { type: string }): command is MailboxOwnerCommand => command.type.startsWith('owners:')

export interface MailboxOwnerWorkerDeps {
  database: MailDatabase
  exchangeClient(accountId: string): Promise<EwsClient>
  exchangeConfig(accountId: string): Promise<ExchangeAccountConfig>
  microsoftClient(accountId: string, mailbox?: string): MicrosoftGraphClient
  store(accountId: string, message: StoredOwnerMessage): Promise<{ isNew: boolean }>
  emit(event: MailWorkerEvent): void
  checkpoint?(accountId: string): Promise<void>
}

export type OwnerOperationOutcome = { status: 'succeeded' } | { status: 'held' | 'failed'; error: string }

const ownerIdFor = (address: string) => `mbx-${createHash('sha256').update(address.trim().toLowerCase()).digest('hex').slice(0, 12)}`
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const isTransient = (error: unknown) => error instanceof EwsNetworkError || error instanceof EwsAuthError || (error instanceof MicrosoftGraphError && (error.status === 429 || error.status >= 500 || error.status === 401))

export class MailboxOwnerService {
  private readonly syncing = new Map<string, Promise<MailboxOwnerSummary>>()

  constructor(private readonly deps: MailboxOwnerWorkerDeps) {}

  private get db() { return this.deps.database }
  private get owners() { return this.db.mailboxOwners }

  private account(accountId: string) {
    const account = this.db.getAccount(accountId)
    if (!account) throw new Error('That mail account is no longer connected')
    if (account.provider !== 'exchange' && account.provider !== 'microsoft') throw new Error('Shared mailboxes are available for Exchange and Microsoft 365 accounts')
    return account
  }

  private changed(accountId: string) {
    this.deps.emit({ type: 'mail-changed', payload: { accountId } })
  }

  private requireOwner(accountId: string, ownerId: string) {
    const owner = this.owners.get(accountId, ownerId)
    if (!owner) throw new Error('That shared mailbox is no longer attached')
    return owner
  }

  list(accountId?: string) {
    return this.owners.list(accountId).map((owner) => this.owners.summary(owner))
  }

  // --- Attach, update, remove -------------------------------------------------------------------

  private async probe(account: MailAccountSummary, ownerId: string, address: string, displayName: string, previous: StoredOwnerFolder[] = []) {
    if (account.provider === 'exchange') return probeExchangeMailbox(await this.deps.exchangeClient(account.id), ownerId, address, displayName)
    return probeGraphMailbox(this.deps.microsoftClient(account.id, address), ownerId, displayName, previous)
  }

  async attach(input: AttachMailboxInput) {
    const account = this.account(input.accountId)
    const address = input.address.trim().toLowerCase()
    if (address === account.email.toLowerCase()) throw new Error('That is this account’s own mailbox')
    const id = ownerIdFor(address)
    if (this.owners.get(account.id, id)) throw new Error(`${address} is already attached to this account`)
    const displayName = input.displayName?.trim() || address
    let folders
    try {
      folders = await this.probe(account, id, address, displayName)
    } catch (error) {
      if (error instanceof MailboxAccessRemovedError) throw new Error(`Aerio could not open ${address}: ${error.code === 'ErrorNonExistentMailbox' || error.code === 'ErrorMailboxNotFound' ? 'the mailbox does not exist or the address is wrong.' : 'this account has no permission for that mailbox. Ask its owner or an administrator to grant access (Full Access, or delegate folder permissions).'}`)
      throw error
    }
    const owner = this.owners.save({
      id, accountId: account.id, provider: account.provider as 'exchange' | 'microsoft', kind: input.kind, address, displayName, status: 'active',
      sendMode: 'none', discoveredBy: input.discoveredBy ?? 'manual'
    })
    this.owners.replaceFolders(account.id, id, folders)
    this.owners.replaceLabels(account.id, id, ownerLabels(owner, folders))
    if (input.sendMode && input.sendMode !== 'none') this.applySendMode(account, owner, input.sendMode)
    this.changed(account.id)
    void this.syncOwner(account.id, id).catch(() => undefined)
    return this.owners.summary(this.owners.get(account.id, id)!)
  }

  /** Creates or updates the sender identity for send as / send on behalf; 'none' removes it. */
  private applySendMode(account: MailAccountSummary, owner: StoredMailboxOwner, mode: 'none' | 'send-as' | 'send-on-behalf') {
    const identities = this.db.identities.list([account], [account.id])
    const existing = (owner.identityId ? identities.find((identity) => identity.id === owner.identityId) : undefined)
      ?? identities.find((identity) => identity.email.toLowerCase() === owner.address.toLowerCase() && identity.source === 'manual')
    if (mode === 'none') {
      if (existing?.delegation) this.db.identities.delete(existing.id)
      this.owners.save({ ...owner, sendMode: 'none', identityId: undefined })
      return
    }
    const identity = this.db.identities.save(account, {
      ...(existing ? { id: existing.id } : {}), accountId: account.id, email: owner.address, name: existing?.name || owner.displayName, delegation: mode
    })
    this.owners.save({ ...owner, sendMode: mode, identityId: identity.id })
  }

  update(input: UpdateMailboxOwnerInput) {
    const account = this.account(input.accountId)
    let owner = this.requireOwner(account.id, input.ownerId)
    if (input.displayName !== undefined && input.displayName.trim()) {
      owner = this.owners.save({ ...owner, displayName: input.displayName.trim() })
      this.owners.replaceLabels(account.id, owner.id, ownerLabels(owner, this.owners.folders(account.id, owner.id)))
    }
    if (input.sendMode !== undefined) {
      if (owner.kind === 'public-folders' && input.sendMode !== 'none') throw new Error('Public folders cannot be used as a From address')
      this.applySendMode(account, owner, input.sendMode)
    }
    this.changed(account.id)
    return this.owners.summary(this.owners.get(account.id, owner.id)!)
  }

  remove(accountId: string, ownerId: string) {
    const owner = this.requireOwner(accountId, ownerId)
    if (owner.identityId) {
      const identity = this.db.identities.get(owner.identityId)
      if (identity?.delegation) this.db.identities.delete(identity.id)
    }
    this.owners.purge(accountId, ownerId)
    this.changed(accountId)
  }

  // --- Synchronization --------------------------------------------------------------------------

  /** Synchronizes every attached owner of an account; one owner's failure never stops the others. */
  async syncAccount(accountId: string) {
    for (const owner of this.owners.list(accountId)) {
      if (owner.status === 'access-removed') continue
      await this.syncOwner(accountId, owner.id).catch(() => undefined)
    }
  }

  private context(owner: StoredMailboxOwner) {
    return {
      accountId: owner.accountId, owner, owners: this.owners, database: this.db,
      store: (message: StoredOwnerMessage) => this.deps.store(owner.accountId, message),
      ...(this.deps.checkpoint ? { checkpoint: () => this.deps.checkpoint!(owner.accountId) } : {})
    }
  }

  private async publicClient(owner: StoredMailboxOwner) {
    return publicFolderClient(await this.deps.exchangeClient(owner.accountId), owner.address)
  }

  /** One owner: folders and rights, then mail. Access removal stops it and holds its queued actions. */
  async syncOwner(accountId: string, ownerId: string, force = false): Promise<MailboxOwnerSummary> {
    const key = `${accountId}\u0000${ownerId}`
    // A background sync already running for this owner is joined; an explicit request runs again
    // after it, so folders subscribed meanwhile are included.
    const running = this.syncing.get(key)
    if (running && !force) return running
    if (running) await running.catch(() => undefined)
    if (this.syncing.has(key)) return this.syncing.get(key)!
    const owner = this.requireOwner(accountId, ownerId)
    if (owner.status === 'access-removed' && !force) return this.owners.summary(owner)
    const work = this.runSync(accountId, ownerId, owner)
    this.syncing.set(key, work)
    try { return await work } finally { this.syncing.delete(key) }
  }

  private async runSync(accountId: string, ownerId: string, initial: StoredMailboxOwner) {
    let owner = initial
    this.owners.setStatus(accountId, ownerId, 'syncing', owner.error)
    try {
      owner = this.requireOwner(accountId, ownerId)
      const context = this.context(owner)
      const result = owner.provider === 'microsoft'
        ? await syncGraphOwner(context, this.deps.microsoftClient(accountId, owner.address))
        : owner.kind === 'public-folders'
          ? await syncPublicFolders(context, await this.publicClient(owner))
          : await syncExchangeOwner(context, await this.deps.exchangeClient(accountId))
      this.owners.setStatus(accountId, ownerId, 'active', result.failures.length ? `Aerio has no access to: ${result.failures.join(', ')}` : undefined, true)
    } catch (error) {
      if (error instanceof MailboxAccessRemovedError) this.revoke(owner, error.message)
      else if (this.owners.get(accountId, ownerId)) this.owners.setStatus(accountId, ownerId, 'error', errorText(error))
      throw error
    } finally {
      this.changed(accountId)
    }
    return this.owners.summary(this.requireOwner(accountId, ownerId))
  }

  /** Marks the owner's tree "access removed", stops its sync, and holds its queued actions for review. */
  revoke(owner: StoredMailboxOwner, message = accessRemovedMessage(owner.displayName, 'ErrorAccessDenied')) {
    this.owners.setStatus(owner.accountId, owner.id, 'access-removed', message)
    this.owners.holdOperations(owner.accountId, owner.id, message)
    this.changed(owner.accountId)
  }

  async sync(accountId: string, ownerId?: string) {
    this.account(accountId)
    const targets = ownerId ? [this.requireOwner(accountId, ownerId)] : this.owners.list(accountId)
    for (const owner of targets) {
      try { await this.syncOwner(accountId, owner.id, true) } catch (error) { if (ownerId && !(error instanceof MailboxAccessRemovedError)) throw error }
    }
    return this.list(accountId)
  }

  // --- Discovery and public folders ---------------------------------------------------------------

  private async exchangeDiscovery(accountId: string) {
    const config = await this.deps.exchangeConfig(accountId)
    return discoverExchangeMailboxes({ email: config.email, ewsUrl: config.ewsUrl, credentials: { auth: config.auth, username: config.username, password: config.password, bearerToken: config.bearerToken } })
  }

  async discover(accountId: string): Promise<MailboxDiscoveryResult> {
    const account = this.account(accountId)
    if (account.provider === 'microsoft') {
      return { supported: false, mailboxes: [], note: 'Microsoft Graph does not list the shared mailboxes you were granted. Enter the shared mailbox address to attach it.' }
    }
    const attached = new Set(this.owners.list(accountId).map((owner) => owner.address.toLowerCase()))
    const found = await this.exchangeDiscovery(accountId)
    const mailboxes: DiscoveredMailbox[] = found.alternativeMailboxes.map((entry) => ({
      address: entry.smtpAddress.toLowerCase(), displayName: entry.displayName, kind: entry.type === 'Delegate' ? 'delegated' : 'shared', attached: attached.has(entry.smtpAddress.toLowerCase())
    }))
    return {
      supported: true, mailboxes,
      ...(found.publicFolderMailbox ? { publicFolderMailbox: found.publicFolderMailbox } : {}),
      ...(mailboxes.length ? {} : { note: 'Autodiscover did not report any delegated or shared mailboxes. You can still attach one by address.' })
    }
  }

  /** The mailbox that routes public folder requests: Autodiscover's PublicFolderInformation, else the user's own. */
  private async publicFolderMailbox(accountId: string) {
    const existing = this.owners.get(accountId, PUBLIC_FOLDERS_OWNER)
    if (existing) return existing.address
    const account = this.account(accountId)
    try {
      return (await this.exchangeDiscovery(accountId)).publicFolderMailbox ?? account.email
    } catch {
      return account.email
    }
  }

  async browsePublicFolders(accountId: string, parentFolderId?: string) {
    const account = this.account(accountId)
    if (account.provider !== 'exchange') throw new Error('Public folders are available for Exchange Server accounts')
    const mailbox = await this.publicFolderMailbox(accountId)
    const subscribed = new Set(this.owners.folders(accountId, PUBLIC_FOLDERS_OWNER).filter((folder) => folder.subscribed).map((folder) => folder.folderId))
    try {
      return await browsePublicFolders(publicFolderClient(await this.deps.exchangeClient(accountId), mailbox), parentFolderId, subscribed)
    } catch (error) {
      if (error instanceof EwsError && (error.code === 'ErrorNoPublicFolderReplicaAvailable' || error.code === 'ErrorPublicFolderMailboxDiscoveryFailed' || error.code === 'ErrorFolderNotFound')) {
        throw new Error('This Exchange organization has no public folders, or none are available to this account.')
      }
      if (error instanceof EwsError && error.code === 'ErrorAccessDenied') throw new Error('Exchange refused access to the public folders.')
      throw error
    }
  }

  async subscribePublicFolder(accountId: string, folderId: string, subscribed: boolean) {
    const account = this.account(accountId)
    if (account.provider !== 'exchange') throw new Error('Public folders are available for Exchange Server accounts')
    let owner = this.owners.get(accountId, PUBLIC_FOLDERS_OWNER)
    if (!subscribed) {
      if (!owner) return undefined
      const folder = this.owners.folders(accountId, owner.id).find((item) => item.folderId === folderId)
      if (folder) {
        this.owners.saveFolder(accountId, owner.id, { ...folder, subscribed: false })
        if (folder.labelId) this.db.reconcileRemoteFolder(accountId, folder.labelId, new Set())
      }
      if (!this.owners.folders(accountId, owner.id).some((item) => item.subscribed)) {
        this.owners.purge(accountId, owner.id)
        this.changed(accountId)
        return undefined
      }
      this.owners.replaceLabels(accountId, owner.id, ownerLabels(owner, this.owners.folders(accountId, owner.id)))
      this.changed(accountId)
      return this.owners.summary(owner)
    }
    const mailbox = owner?.address ?? await this.publicFolderMailbox(accountId)
    const access = await publicFolderAccess(publicFolderClient(await this.deps.exchangeClient(accountId), mailbox), PUBLIC_FOLDERS_OWNER, folderId)
    if (access.access === 'none') throw new Error(`Exchange does not let this account read “${access.name}”.`)
    owner ??= this.owners.save({ id: PUBLIC_FOLDERS_OWNER, accountId, provider: 'exchange', kind: 'public-folders', address: mailbox, displayName: 'Public Folders', status: 'active', sendMode: 'none', discoveredBy: 'manual' })
    const previous = this.owners.folders(accountId, owner.id).find((item) => item.folderId === folderId)
    this.owners.saveFolder(accountId, owner.id, { ...access, subscribed: true, ...(previous?.syncState ? { syncState: previous.syncState } : {}) })
    this.owners.replaceLabels(accountId, owner.id, ownerLabels(owner, this.owners.folders(accountId, owner.id)))
    this.changed(accountId)
    void this.syncOwner(accountId, owner.id, true).catch(() => undefined)
    return this.owners.summary(this.owners.get(accountId, owner.id)!)
  }

  /** Calendar and contacts folders of attached Exchange owners for the Calendar/Contacts service. */
  productivityFolders(accountId: string): OwnerProductivityFolder[] {
    const account = this.db.getAccount(accountId)
    if (account?.provider !== 'exchange') return []
    const result: OwnerProductivityFolder[] = []
    for (const owner of this.owners.list(accountId)) {
      if (owner.status === 'access-removed') continue
      for (const folder of this.owners.folders(accountId, owner.id)) {
        if ((folder.kind !== 'calendar' && folder.kind !== 'contacts') || folder.access === 'none') continue
        if (owner.kind === 'public-folders') {
          if (!folder.subscribed) continue
          result.push({ ref: { id: folder.folderId, distinguished: false }, name: `${folder.name} (Public Folders)`, kind: folder.kind, headers: { 'X-AnchorMailbox': owner.address, 'X-PublicFolderMailbox': owner.address }, readOnly: true })
        } else if (folder.distinguished === 'calendar' || folder.distinguished === 'contacts') {
          result.push({ ref: { id: folder.distinguished, mailbox: owner.address }, name: `${owner.displayName} – ${folder.name}`, kind: folder.kind, readOnly: folder.access !== 'write' })
        }
      }
    }
    return result
  }

  // --- Delegation (Exchange) ----------------------------------------------------------------------

  async delegates(accountId: string): Promise<MailboxDelegation> {
    const account = this.account(accountId)
    if (account.provider !== 'exchange') {
      return { accountId, supported: false, delegates: [], deliverMeetingRequests: 'DelegatesAndSendInformationToMe', note: 'Microsoft Graph has no API for mailbox delegates. Manage delegates in Outlook or the Microsoft 365 admin center.' }
    }
    try {
      const result = await getDelegates(await this.deps.exchangeClient(accountId), account.email)
      return { accountId, supported: true, ...result }
    } catch (error) {
      if (error instanceof EwsError && (error.code === 'ErrorInvalidRequest' || error.code === 'ErrorSchemaValidation' || error.code === 'ErrorInvalidOperation')) {
        return { accountId, supported: false, delegates: [], deliverMeetingRequests: 'DelegatesAndSendInformationToMe', note: delegationErrorMessage(error) }
      }
      throw new Error(delegationErrorMessage(error))
    }
  }

  async saveDelegate(input: SaveDelegateInput) {
    const account = this.account(input.accountId)
    if (account.provider !== 'exchange') throw new Error('Delegates can be managed for Exchange Server accounts')
    const client = await this.deps.exchangeClient(account.id)
    try {
      if (input.mode === 'add') await addDelegate(client, account.email, input.delegate, input.deliverMeetingRequests)
      else await updateDelegate(client, account.email, input.delegate, input.deliverMeetingRequests)
    } catch (error) {
      throw new Error(delegationErrorMessage(error))
    }
    return this.delegates(account.id)
  }

  async removeDelegate(accountId: string, address: string) {
    const account = this.account(accountId)
    if (account.provider !== 'exchange') throw new Error('Delegates can be managed for Exchange Server accounts')
    try { await removeDelegate(await this.deps.exchangeClient(accountId), account.email, address) } catch (error) { throw new Error(delegationErrorMessage(error)) }
    return this.delegates(accountId)
  }

  async setMeetingDelivery(accountId: string, delivery: MeetingRequestDelivery) {
    const account = this.account(accountId)
    if (account.provider !== 'exchange') throw new Error('Delegates can be managed for Exchange Server accounts')
    try { await updateDelegate(await this.deps.exchangeClient(accountId), account.email, undefined, delivery) } catch (error) { throw new Error(delegationErrorMessage(error)) }
    return this.delegates(accountId)
  }

  // --- Held actions ---------------------------------------------------------------------------------

  resolveHeld(operationId: string, decision: 'retry' | 'discard') {
    const held = this.owners.heldOperation(operationId)
    if (!held) throw new Error('That held change was already resolved')
    if (decision === 'discard') this.db.restoreOperationSnapshot(operationId, 'cancelled', 'Discarded after access to the mailbox changed')
    else {
      const owner = this.owners.get(held.accountId, held.ownerId)
      if (!owner || owner.status === 'access-removed') throw new Error(`Access to ${held.ownerName} is still removed. Synchronize the mailbox after access is restored, or discard the change.`)
      this.owners.releaseHeld(operationId)
    }
    this.changed(held.accountId)
    return this.owners.held()
  }

  // --- Action enforcement ---------------------------------------------------------------------------

  /** Maps Archive/Trash/Inbox/Junk to folders of the same mailbox; undefined destination = flag change. */
  private resolveAction(owner: StoredMailboxOwner, folders: StoredOwnerFolder[], kind: MailActionKind, labelId?: string) {
    const special = (name: string) => folders.find((folder) => folder.kind === 'mail' && folder.distinguished === name)
    const named: Record<string, string> = { deleteditems: 'Deleted Items', inbox: 'Inbox', junkemail: 'Junk Email', archive: 'Archive' }
    const target = (name: string) => {
      const folder = special(name)
      if (!folder?.labelId) throw new Error(`${owner.displayName} has no ${named[name]} folder that Aerio can use`)
      return folder
    }
    let destination: StoredOwnerFolder | undefined
    if (kind === 'trash' || (kind === 'move' && labelId === 'TRASH')) destination = target('deleteditems')
    else if (kind === 'untrash' || kind === 'unarchive' || (kind === 'move' && labelId === 'INBOX')) destination = target('inbox')
    else if (kind === 'move' && labelId === 'SPAM') destination = target('junkemail')
    else if (kind === 'archive' || (kind === 'move' && labelId === 'ARCHIVE')) destination = target('archive')
    else if (kind === 'move' || kind === 'label') {
      const parsed = parseOwnerLabel(labelId)
      if (!parsed || parsed.ownerId !== owner.id || !parsed.folderId) throw new Error('Messages can only be moved to folders of the same mailbox')
      destination = folders.find((folder) => folder.folderId === parsed.folderId)
      if (!destination) throw new Error('That folder is no longer available in the shared mailbox')
    } else if (kind === 'unlabel') throw new Error('Shared mailbox folders cannot be removed from a message; move it instead')
    if (destination && destination.access !== 'write') throw new Error(`You have read-only access to ${destination.name} in ${owner.displayName}`)
    return destination
  }

  private sourceFolders(accountId: string, owner: StoredMailboxOwner, folders: StoredOwnerFolder[], threadIds: string[]) {
    // The folder a message is in now (its owner label), which a queued move may already have changed.
    const labels = new Set(this.db.remoteMessagesForThreads(accountId, threadIds).flatMap((message) => message.labelIds.filter((label) => label.startsWith('owner:'))))
    return folders.filter((folder) => folder.labelId && labels.has(folder.labelId))
  }

  private assertWritable(owner: StoredMailboxOwner, sources: StoredOwnerFolder[]) {
    if (owner.status === 'access-removed') throw new Error(`Access to ${owner.displayName} was removed. Its cached mail is read-only until you remove the mailbox in account settings.`)
    const readOnly = sources.filter((folder) => folder.access !== 'write')
    if (readOnly.length) {
      throw new Error(`You have read-only access to ${readOnly.map((folder) => folder.name).join(', ')} in ${owner.displayName}. Ask the mailbox owner for Editor permission to change these messages.`)
    }
  }

  /**
   * Checks an action on conversations before it is applied locally. Actions on another owner's
   * messages are refused when that folder is read-only or access was removed, and Trash/Archive/
   * Inbox/Junk are mapped to that mailbox's own folders.
   */
  planAction(input: ApplyMailActionInput): { input: ApplyMailActionInput; ownerId: string } {
    const owners = [...this.owners.ownersOfThreads(input.accountId, input.threadIds)]
    const destination = parseOwnerLabel(input.labelId)
    if (owners.length > 1) throw new Error('Select conversations from one mailbox at a time')
    const ownerId = owners[0] ?? PRIMARY_MAILBOX_OWNER
    if (ownerId === PRIMARY_MAILBOX_OWNER) {
      if (destination && (input.action === 'move' || input.action === 'label')) throw new Error('Messages cannot be moved between your mailbox and a shared mailbox or public folder')
      return { input, ownerId }
    }
    if (isPinMailAction(input.action)) return { input, ownerId }
    const owner = this.requireOwner(input.accountId, ownerId)
    const folders = this.owners.folders(input.accountId, ownerId)
    this.assertWritable(owner, this.sourceFolders(input.accountId, owner, folders, input.threadIds))
    const target = this.resolveAction(owner, folders, input.action, input.labelId)
    return { input: target ? { ...input, action: 'move', labelId: target.labelId } : input, ownerId }
  }

  /** The owner of a queued action: its tag, or the single non-primary owner of its conversations (undo, rules, snooze). */
  operationOwner(row: Record<string, unknown>) {
    const tagged = row.owner_id ? String(row.owner_id) : PRIMARY_MAILBOX_OWNER
    if (tagged !== PRIMARY_MAILBOX_OWNER) return tagged
    let threadIds: string[] = []
    try { threadIds = JSON.parse(String(row.thread_ids_json)) as string[] } catch { threadIds = [] }
    const owners = [...this.owners.ownersOfThreads(String(row.account_id), threadIds)]
    if (owners.length === 1 && owners[0] !== PRIMARY_MAILBOX_OWNER) {
      this.owners.tagOperation(String(row.id), owners[0])
      return owners[0]
    }
    return PRIMARY_MAILBOX_OWNER
  }

  /** Sends one queued action of another owner, enforcing rights; access removal holds it. */
  async runOperation(row: Record<string, unknown>): Promise<OwnerOperationOutcome> {
    const id = String(row.id)
    const accountId = String(row.account_id)
    const ownerId = this.operationOwner(row)
    const kind = String(row.kind) as MailActionKind
    const labelId = row.label_id ? String(row.label_id) : undefined
    const threadIds = JSON.parse(String(row.thread_ids_json)) as string[]
    const owner = this.owners.get(accountId, ownerId)
    const fail = (error: string): OwnerOperationOutcome => {
      this.db.restoreOperationSnapshot(id, 'failed', error)
      return { status: 'failed', error }
    }
    if (!owner) return fail('The shared mailbox was removed before this change was sent')
    if (owner.status === 'access-removed') {
      const error = owner.error ?? accessRemovedMessage(owner.displayName, 'ErrorAccessDenied')
      this.owners.holdOperation(id, error)
      return { status: 'held', error }
    }
    const folders = this.owners.folders(accountId, ownerId)
    let destination: StoredOwnerFolder | undefined
    try {
      this.assertWritable(owner, this.sourceFolders(accountId, owner, folders, threadIds))
      destination = this.resolveAction(owner, folders, kind, labelId)
    } catch (error) {
      return fail(errorText(error))
    }
    const remote = this.db.remoteMessagesForThreads(accountId, threadIds).flatMap((message) => message.remoteUid ? [message.remoteUid] : [])
    const effectiveKind: MailActionKind = destination ? 'move' : kind
    try {
      if (owner.provider === 'exchange') {
        const client = owner.kind === 'public-folders' ? await this.publicClient(owner) : await this.deps.exchangeClient(accountId)
        const failure = await applyOwnerExchangeAction(client, remote, effectiveKind, destination?.folderId)
        if (failure) throw failure
      } else {
        await applyOwnerGraphAction(this.deps.microsoftClient(accountId, owner.address), remote, effectiveKind, destination?.folderId)
      }
      return { status: 'succeeded' }
    } catch (error) {
      // A message moved or deleted elsewhere converges on the next sync.
      if (isGraphMissing(error)) return { status: 'succeeded' }
      const denied = (error instanceof EwsError && (error.code === 'ErrorAccessDenied' || error.code === 'ErrorNonExistentMailbox')) || isGraphDenied(error)
      if (!denied || isTransient(error)) throw error
      return this.writeDenied(owner, id, threadIds, folders, errorText(error))
    }
  }

  /** A refused write: either the whole mailbox is gone (hold) or the folder became read-only (fail). */
  private async writeDenied(owner: StoredMailboxOwner, operationId: string, threadIds: string[], folders: StoredOwnerFolder[], detail: string): Promise<OwnerOperationOutcome> {
    const account = this.account(owner.accountId)
    try {
      if (owner.kind === 'public-folders') {
        const client = await this.publicClient(owner)
        const subscribed = folders.filter((folder) => folder.subscribed)
        const results = subscribed.length ? await client.getFolders(subscribed.map((folder) => ({ id: folder.folderId, distinguished: false }))) : []
        if (results.length && results.every((result) => result instanceof EwsError)) throw new MailboxAccessRemovedError(accessRemovedMessage(owner.displayName, 'ErrorAccessDenied'), 'ErrorAccessDenied')
      } else await this.probe(account, owner.id, owner.address, owner.displayName, folders)
    } catch (error) {
      if (error instanceof MailboxAccessRemovedError) {
        this.revoke(owner, error.message)
        this.owners.holdOperation(operationId, error.message)
        return { status: 'held', error: error.message }
      }
      throw error
    }
    const message = `${owner.provider === 'exchange' ? 'Exchange' : 'Microsoft 365'} refused the change: you have read-only access to this folder in ${owner.displayName}. (${detail})`
    for (const folder of this.sourceFolders(owner.accountId, owner, folders, threadIds)) this.owners.setFolderAccess(owner.accountId, owner.id, folder.folderId, 'read', message)
    this.db.restoreOperationSnapshot(operationId, 'failed', message)
    this.changed(owner.accountId)
    return { status: 'failed', error: message }
  }

  // --- Sending ------------------------------------------------------------------------------------------

  /**
   * Send as / send on behalf for an identity with `delegation`. Refusals throw SenderIdentityError,
   * which keeps the draft with the explanation.
   */
  async sendDelegated(account: MailAccountSummary, identity: MailSenderIdentity, mime: Buffer, options?: MailSendOptions, remoteDraftId?: string) {
    const mode = identity.delegation!
    const owner = this.owners.list(account.id).find((item) => item.address.toLowerCase() === identity.email.toLowerCase() && item.kind !== 'public-folders')
    if (owner?.status === 'access-removed') throw new SenderIdentityError(`Access to ${owner.displayName} was removed, so Aerio cannot send ${mode === 'send-as' ? 'as' : 'on behalf of'} it. The message was kept as a draft.`)
    if (account.provider === 'exchange') {
      const client = await this.deps.exchangeClient(account.id)
      const sent = owner ? this.owners.folders(account.id, owner.id).find((folder) => folder.distinguished === 'sentitems') : undefined
      await sendExchangeDelegated(client, {
        mode, ownerAddress: identity.email, delegateAddress: account.email, delegateSender: formatSenderAddress(account.displayName, account.email), mime,
        saveToOwnerSentItems: sent?.access === 'write', readReceipt: Boolean(options?.requestReadReceipt), deliveryReceipt: Boolean(options?.requestDeliveryReceipt)
      })
      if (remoteDraftId) await client.deleteItems([remoteDraftId], 'HardDelete').catch(() => undefined)
      return
    }
    await sendGraphDelegated(this.deps.microsoftClient(account.id), { mode, ownerAddress: identity.email, delegateAddress: account.email, mime, ...(options ? { options } : {}), ...(remoteDraftId ? { remoteDraftId } : {}) })
  }

  // --- Worker commands ----------------------------------------------------------------------------------

  async handle(command: MailboxOwnerCommand): Promise<MailboxOwnerResult> {
    switch (command.type) {
      case 'owners:list': return this.list(command.payload.accountId)
      case 'owners:discover': return this.discover(command.payload.accountId)
      case 'owners:attach': return this.attach(command.payload)
      case 'owners:update': return this.update(command.payload)
      case 'owners:remove': this.remove(command.payload.accountId, command.payload.ownerId); return undefined
      case 'owners:sync': return this.sync(command.payload.accountId, command.payload.ownerId)
      case 'owners:public-folders': return this.browsePublicFolders(command.payload.accountId, command.payload.parentFolderId)
      case 'owners:subscribe': return this.subscribePublicFolder(command.payload.accountId, command.payload.folderId, command.payload.subscribed)
      case 'owners:delegates': return this.delegates(command.payload.accountId)
      case 'owners:save-delegate': return this.saveDelegate(command.payload)
      case 'owners:remove-delegate': return this.removeDelegate(command.payload.accountId, command.payload.address)
      case 'owners:meeting-delivery': return this.setMeetingDelivery(command.payload.accountId, command.payload.delivery)
      case 'owners:held': return this.owners.held(command.payload.accountId)
      case 'owners:resolve-held': return this.resolveHeld(command.payload.operationId, command.payload.decision)
      case 'owners:productivity-folders': return this.productivityFolders(command.payload.accountId)
    }
  }
}
