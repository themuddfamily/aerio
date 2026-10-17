import type { IpcMain } from 'electron'
import {
  DELEGATE_FOLDERS,
  isEmailAddress,
  type AttachMailboxInput,
  type DelegateFolderPermission,
  type MailboxDelegate,
  type MailboxSendMode,
  type MeetingRequestDelivery,
  type SaveDelegateInput,
  type UpdateMailboxOwnerInput
} from '../../src/mailbox-owner-types'
import type { MailWorkerCommand, MailWorkerResult } from '../mail-protocol'

// IPC for shared/delegated mailboxes, delegation, and public folders (E40). Every payload is
// validated here before it reaches the mail worker, and nothing runs while Aerio is locked.

interface OwnerWorker { request<T extends MailWorkerResult = void>(command: MailWorkerCommand): Promise<T> }

const id = (value: unknown, label: string, max = 500): string => {
  if (typeof value !== 'string' || !value || value.length > max) throw new Error(`Choose a valid ${label}`)
  return value
}
const address = (value: unknown, label = 'mailbox address') => {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!isEmailAddress(text)) throw new Error(`Enter a valid ${label}`)
  return text
}
const SEND_MODES = new Set<MailboxSendMode>(['none', 'send-as', 'send-on-behalf'])
const LEVELS = new Set<DelegateFolderPermission>(['None', 'Reviewer', 'Author', 'Editor'])
const DELIVERY = new Set<MeetingRequestDelivery>(['DelegatesOnly', 'DelegatesAndMe', 'DelegatesAndSendInformationToMe', 'NoForward'])
const object = (value: unknown, message: string) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}
const displayName = (value: unknown) => {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Use a display name of at most 200 characters')
  return value.trim() || undefined
}
const sendMode = (value: unknown) => {
  if (value === undefined) return undefined
  if (!SEND_MODES.has(value as MailboxSendMode)) throw new Error('Choose how to send from this mailbox')
  return value as MailboxSendMode
}

export function validateAttachMailbox(value: unknown): AttachMailboxInput {
  const input = object(value, 'Enter the shared mailbox details')
  if (input.kind !== 'shared' && input.kind !== 'delegated') throw new Error('Choose a shared or delegated mailbox')
  const name = displayName(input.displayName)
  const mode = sendMode(input.sendMode)
  return {
    accountId: id(input.accountId, 'mail account', 200), address: address(input.address), kind: input.kind,
    ...(name ? { displayName: name } : {}), ...(mode ? { sendMode: mode } : {}),
    ...(input.discoveredBy === 'autodiscover' ? { discoveredBy: 'autodiscover' as const } : {})
  }
}

export function validateUpdateMailbox(value: unknown): UpdateMailboxOwnerInput {
  const input = object(value, 'Choose a shared mailbox')
  const name = displayName(input.displayName)
  const mode = sendMode(input.sendMode)
  return { accountId: id(input.accountId, 'mail account', 200), ownerId: id(input.ownerId, 'shared mailbox', 100), ...(name ? { displayName: name } : {}), ...(mode ? { sendMode: mode } : {}) }
}

export function validateDelegate(value: unknown): MailboxDelegate {
  const input = object(value, 'Enter the delegate')
  const permissions = object(input.permissions, 'Choose the delegate permissions')
  const result = {} as MailboxDelegate['permissions']
  for (const folder of DELEGATE_FOLDERS) {
    const level = permissions[folder] ?? 'None'
    if (!LEVELS.has(level as DelegateFolderPermission)) throw new Error('Choose None, Reviewer, Author, or Editor for each folder')
    result[folder] = level as DelegateFolderPermission
  }
  if (typeof input.receiveCopiesOfMeetingMessages !== 'boolean' || typeof input.viewPrivateItems !== 'boolean') throw new Error('Choose the delegate meeting and private item options')
  const name = displayName(input.displayName)
  return { address: address(input.address, 'delegate address'), ...(name ? { displayName: name } : {}), permissions: result, receiveCopiesOfMeetingMessages: input.receiveCopiesOfMeetingMessages, viewPrivateItems: input.viewPrivateItems }
}

export function validateMeetingDelivery(value: unknown): MeetingRequestDelivery {
  if (!DELIVERY.has(value as MeetingRequestDelivery)) throw new Error('Choose who receives meeting requests')
  return value as MeetingRequestDelivery
}

export function validateSaveDelegate(value: unknown): SaveDelegateInput {
  const input = object(value, 'Enter the delegate')
  if (input.mode !== 'add' && input.mode !== 'update') throw new Error('Choose to add or update the delegate')
  return {
    accountId: id(input.accountId, 'mail account', 200), mode: input.mode, delegate: validateDelegate(input.delegate),
    ...(input.deliverMeetingRequests !== undefined ? { deliverMeetingRequests: validateMeetingDelivery(input.deliverMeetingRequests) } : {})
  }
}

export interface MailboxOwnerIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  worker(): OwnerWorker
  isLocked(): boolean
  /** Shared calendars/contacts changed for an account (attach, remove, subscribe). */
  productivityChanged?(accountId: string): void
}

export function registerMailboxOwnerIpc(options: MailboxOwnerIpcOptions) {
  const handle = (channel: string, run: (...args: unknown[]) => Promise<unknown>) => options.ipcMain.handle(channel, (_event, ...args: unknown[]) => {
    if (options.isLocked()) throw new Error('Unlock Aerio to manage shared mailboxes')
    return run(...args)
  })
  const request = <T extends MailWorkerResult>(command: MailWorkerCommand) => options.worker().request<T>(command)
  const changed = <T>(accountId: string, result: T) => { options.productivityChanged?.(accountId); return result }

  handle('mailbox-owners:list', async (accountId) => request({ type: 'owners:list', payload: accountId === undefined ? {} : { accountId: id(accountId, 'mail account', 200) } }))
  handle('mailbox-owners:discover', async (accountId) => request({ type: 'owners:discover', payload: { accountId: id(accountId, 'mail account', 200) } }))
  handle('mailbox-owners:attach', async (input) => {
    const payload = validateAttachMailbox(input)
    return changed(payload.accountId, await request({ type: 'owners:attach', payload }))
  })
  handle('mailbox-owners:update', async (input) => request({ type: 'owners:update', payload: validateUpdateMailbox(input) }))
  handle('mailbox-owners:remove', async (accountId, ownerId) => {
    const payload = { accountId: id(accountId, 'mail account', 200), ownerId: id(ownerId, 'shared mailbox', 100) }
    return changed(payload.accountId, await request({ type: 'owners:remove', payload }))
  })
  handle('mailbox-owners:sync', async (accountId, ownerId) => {
    const account = id(accountId, 'mail account', 200)
    return changed(account, await request({ type: 'owners:sync', payload: { accountId: account, ...(ownerId !== undefined ? { ownerId: id(ownerId, 'shared mailbox', 100) } : {}) } }))
  })
  handle('mailbox-owners:public-folders', async (accountId, parentFolderId) => request({
    type: 'owners:public-folders', payload: { accountId: id(accountId, 'mail account', 200), ...(parentFolderId !== undefined ? { parentFolderId: id(parentFolderId, 'public folder', 1_000) } : {}) }
  }))
  handle('mailbox-owners:subscribe', async (accountId, folderId, subscribed) => {
    if (typeof subscribed !== 'boolean') throw new Error('Choose whether to show the public folder')
    const account = id(accountId, 'mail account', 200)
    return changed(account, await request({ type: 'owners:subscribe', payload: { accountId: account, folderId: id(folderId, 'public folder', 1_000), subscribed } }))
  })
  handle('mailbox-owners:delegates', async (accountId) => request({ type: 'owners:delegates', payload: { accountId: id(accountId, 'mail account', 200) } }))
  handle('mailbox-owners:save-delegate', async (input) => request({ type: 'owners:save-delegate', payload: validateSaveDelegate(input) }))
  handle('mailbox-owners:remove-delegate', async (accountId, delegate) => request({ type: 'owners:remove-delegate', payload: { accountId: id(accountId, 'mail account', 200), address: address(delegate, 'delegate address') } }))
  handle('mailbox-owners:meeting-delivery', async (accountId, delivery) => request({ type: 'owners:meeting-delivery', payload: { accountId: id(accountId, 'mail account', 200), delivery: validateMeetingDelivery(delivery) } }))
  handle('mailbox-owners:held', async (accountId) => request({ type: 'owners:held', payload: accountId === undefined ? {} : { accountId: id(accountId, 'mail account', 200) } }))
  handle('mailbox-owners:resolve-held', async (operationId, decision) => {
    if (decision !== 'retry' && decision !== 'discard') throw new Error('Choose to retry or discard the change')
    return request({ type: 'owners:resolve-held', payload: { operationId: id(operationId, 'held change', 200), decision } })
  })
}
