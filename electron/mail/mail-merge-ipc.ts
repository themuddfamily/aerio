import { ipcMain } from 'electron'
import type { MailDraftInput } from '../../src/mail-types'
import type { MailMergeJob, MailMergeJobInput, MailMergeJobSummary, MailMergeRecipientInput } from '../../src/mail-merge-types'
import { isCompleteMailAddress } from '../../src/lib/mail-address'
import { MAIL_MERGE_MAX_FIELDS, MAIL_MERGE_MAX_FIELD_LENGTH, MAIL_MERGE_MAX_RECIPIENTS } from '../../src/lib/mail-merge'
import type { MailWorkerClient } from './worker-client'

const validId = (value: unknown, max = 300): value is string => typeof value === 'string' && value.length > 0 && value.length <= max
const optionalText = (value: unknown) => value === undefined || (typeof value === 'string' && value.length <= MAIL_MERGE_MAX_FIELD_LENGTH)

function validateRecipient(value: unknown): MailMergeRecipientInput {
  const recipient = value as MailMergeRecipientInput
  if (!recipient || typeof recipient !== 'object' || typeof recipient.email !== 'string' || recipient.email.length > 500) throw new Error('A mail merge recipient is invalid')
  if (![recipient.name, recipient.firstName, recipient.lastName, recipient.company].every(optionalText)) throw new Error('A mail merge recipient field is too long')
  if (recipient.fields !== undefined) {
    if (!recipient.fields || typeof recipient.fields !== 'object' || Array.isArray(recipient.fields)) throw new Error('Mail merge columns are invalid')
    const entries = Object.entries(recipient.fields)
    if (entries.length > MAIL_MERGE_MAX_FIELDS) throw new Error(`Use at most ${MAIL_MERGE_MAX_FIELDS} mail merge columns`)
    if (entries.some(([key, field]) => key.length > 100 || typeof field !== 'string' || field.length > MAIL_MERGE_MAX_FIELD_LENGTH)) throw new Error('A mail merge column value is too long')
  }
  return {
    email: recipient.email,
    ...(recipient.name !== undefined ? { name: recipient.name } : {}),
    ...(recipient.firstName !== undefined ? { firstName: recipient.firstName } : {}),
    ...(recipient.lastName !== undefined ? { lastName: recipient.lastName } : {}),
    ...(recipient.company !== undefined ? { company: recipient.company } : {}),
    ...(recipient.fields ? { fields: { ...recipient.fields } } : {})
  }
}

/**
 * Validates a merge request. The shared message goes through the same checks
 * as a draft (approved attachment paths, size limits, sender fields) with no
 * recipients of its own; the list only ever becomes single-To deliveries.
 */
export function validateMailMergeInput(input: unknown, validateMessage: (draft: MailDraftInput) => MailDraftInput): MailMergeJobInput {
  const value = input as MailMergeJobInput
  if (!value || typeof value !== 'object') throw new Error('The mail merge is invalid')
  if (!Array.isArray(value.recipients) || !value.recipients.length) throw new Error('Add at least one mail merge recipient')
  if (value.recipients.length > MAIL_MERGE_MAX_RECIPIENTS) throw new Error(`A mail merge can have at most ${MAIL_MERGE_MAX_RECIPIENTS.toLocaleString('en-US')} recipients`)
  if (value.name !== undefined && (typeof value.name !== 'string' || value.name.length > 200)) throw new Error('The mail merge name is too long')
  const limits = value.limits as unknown as Record<string, unknown>
  if (!limits || typeof limits !== 'object' || typeof limits.perMinute !== 'number' || typeof limits.dailyCap !== 'number') throw new Error('Choose sending limits for the mail merge')
  const message = validateMessage({
    accountId: value.accountId, to: [], cc: [], bcc: [], subject: value.subject, text: value.text, html: value.html,
    attachmentPaths: value.attachmentPaths, fromIdentityId: value.fromIdentityId, replyTo: value.replyTo, sendOptions: value.sendOptions
  })
  if (message.replyTo?.some((item) => !isCompleteMailAddress(item))) throw new Error('Finish or correct the Reply-To email addresses')
  return {
    accountId: message.accountId,
    ...(value.name ? { name: value.name } : {}),
    subject: message.subject,
    text: message.text,
    ...(message.html !== undefined ? { html: message.html } : {}),
    attachmentPaths: message.attachmentPaths,
    ...(message.fromIdentityId ? { fromIdentityId: message.fromIdentityId } : {}),
    ...(message.replyTo?.length ? { replyTo: message.replyTo } : {}),
    ...(message.sendOptions ? { sendOptions: message.sendOptions } : {}),
    recipients: value.recipients.map(validateRecipient),
    limits: { perMinute: limits.perMinute, dailyCap: limits.dailyCap }
  }
}

function jobId(value: unknown) {
  if (!validId(value, 200)) throw new Error('Choose a valid mail merge')
  return value
}

export function registerMailMerge(options: { worker(): Pick<MailWorkerClient, 'request'>; validateMessage(draft: MailDraftInput): MailDraftInput }) {
  ipcMain.handle('mail:merge:list', () => options.worker().request<MailMergeJobSummary[]>({ type: 'merge:list' }))
  ipcMain.handle('mail:merge:get', (_event, id: unknown) => options.worker().request<MailMergeJob | undefined>({ type: 'merge:get', payload: { id: jobId(id) } }))
  ipcMain.handle('mail:merge:create', (_event, input: unknown) =>
    options.worker().request<MailMergeJob>({ type: 'merge:create', payload: validateMailMergeInput(input, options.validateMessage) }))
  ipcMain.handle('mail:merge:pause', (_event, id: unknown) => options.worker().request<MailMergeJobSummary>({ type: 'merge:pause', payload: { id: jobId(id) } }))
  ipcMain.handle('mail:merge:resume', (_event, id: unknown) => options.worker().request<MailMergeJobSummary>({ type: 'merge:resume', payload: { id: jobId(id) } }))
  ipcMain.handle('mail:merge:cancel', (_event, id: unknown) => options.worker().request<MailMergeJobSummary>({ type: 'merge:cancel', payload: { id: jobId(id) } }))
  ipcMain.handle('mail:merge:resolve', (_event, id: unknown, positions: unknown, resolution: unknown) => {
    if (!Array.isArray(positions) || !positions.length || positions.length > MAIL_MERGE_MAX_RECIPIENTS || !positions.every((item) => Number.isInteger(item) && item >= 0)) throw new Error('Choose recipients to review')
    if (resolution !== 'resend' && resolution !== 'skip') throw new Error('Choose resend or skip')
    return options.worker().request<MailMergeJob>({ type: 'merge:resolve', payload: { id: jobId(id), positions: positions as number[], resolution } })
  })
  ipcMain.handle('mail:merge:delete', (_event, id: unknown) => options.worker().request<void>({ type: 'merge:delete', payload: { id: jobId(id) } }))
}
