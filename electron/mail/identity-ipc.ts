import { ipcMain } from 'electron'
import type { MailDraftInput } from '../../src/mail-types'
import type { MailSenderIdentity, MailSenderIdentityInput, MailSignature, MailSignatureInput } from '../../src/mail-identity-types'
import { isCompleteMailAddress } from '../../src/lib/mail-address'
import type { MailWorkerClient } from './worker-client'

const validId = (value: unknown, max = 300): value is string => typeof value === 'string' && value.length > 0 && value.length <= max
const accountIds = (value: unknown) => {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 200 || !value.every((item) => validId(item, 200))) throw new Error('Choose valid mail accounts')
  return value as string[]
}

/** Validates the draft's sender fields; Reply-To may be unfinished until the message is sent. */
export function validateDraftSender(input: Pick<MailDraftInput, 'fromIdentityId' | 'replyTo'>, forSend: boolean) {
  if (input.fromIdentityId !== undefined && !validId(input.fromIdentityId)) throw new Error('Choose a valid From address')
  if (input.replyTo === undefined) return
  if (!Array.isArray(input.replyTo) || input.replyTo.length > 10 || input.replyTo.some((item) => typeof item !== 'string' || item.length > 500)) throw new Error('Use at most 10 Reply-To addresses')
  if (forSend && input.replyTo.some((item) => !isCompleteMailAddress(item))) throw new Error('Finish or correct the Reply-To email addresses')
}

export function registerMailIdentities(options: { worker(): Pick<MailWorkerClient, 'request'> }) {
  ipcMain.handle('mail:identities:list', (_event, ids?: unknown) =>
    options.worker().request<MailSenderIdentity[]>({ type: 'identities:list', payload: { accountIds: accountIds(ids) } }))
  ipcMain.handle('mail:identities:save', (_event, input: MailSenderIdentityInput) => {
    if (!input || typeof input !== 'object' || !validId(input.accountId, 200)) throw new Error('Choose a valid mail account')
    return options.worker().request<MailSenderIdentity>({ type: 'identities:save', payload: input })
  })
  ipcMain.handle('mail:identities:delete', (_event, id: unknown) => {
    if (!validId(id)) throw new Error('Choose a valid sender address')
    return options.worker().request<void>({ type: 'identities:delete', payload: { id } })
  })
  ipcMain.handle('mail:identities:refresh', (_event, accountId: unknown) => {
    if (!validId(accountId, 200)) throw new Error('Choose a valid mail account')
    return options.worker().request<MailSenderIdentity[]>({ type: 'identities:refresh', payload: { accountId } })
  })
  ipcMain.handle('mail:signatures:list', () => options.worker().request<MailSignature[]>({ type: 'signatures:list' }))
  ipcMain.handle('mail:signatures:save', (_event, input: MailSignatureInput) => {
    if (!input || typeof input !== 'object') throw new Error('The signature is invalid')
    return options.worker().request<MailSignature>({ type: 'signatures:save', payload: input })
  })
  ipcMain.handle('mail:signatures:delete', (_event, id: unknown) => {
    if (!validId(id)) throw new Error('Choose a valid signature')
    return options.worker().request<void>({ type: 'signatures:delete', payload: { id } })
  })
}
