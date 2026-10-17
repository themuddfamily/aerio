import { ipcMain } from 'electron'
import type { InvitationRespondInput } from '../../src/invitation-types'
import { createInvitationService, validRespondInput, type InvitationServiceOptions } from './invitations'

const validId = (value: unknown, max = 500): value is string => typeof value === 'string' && value.length > 0 && value.length <= max

// Meeting invitation IPC (E22). Renderer input is validated here; the service never trusts it.
export function registerMeetingInvitations(options: InvitationServiceOptions) {
  const service = createInvitationService(options)
  ipcMain.handle('invitations:inspect', (_event, accountId: unknown, messageId: unknown) => {
    if (!validId(accountId, 200) || !validId(messageId)) throw new Error('Choose a valid message')
    return service.inspect(accountId, messageId)
  })
  ipcMain.handle('invitations:respond', (_event, input: unknown) => {
    const value = input as Partial<InvitationRespondInput> | undefined
    if (!value || !validId(value.accountId, 200) || !validId(value.messageId) || !validRespondInput(value)) throw new Error('Choose a valid meeting response')
    const { accountId, messageId } = value as InvitationRespondInput
    return service.respond({ accountId, messageId, response: value.response, comment: value.comment, proposed: value.proposed })
  })
  ipcMain.handle('invitations:apply-cancellation', (_event, accountId: unknown, messageId: unknown) => {
    if (!validId(accountId, 200) || !validId(messageId)) throw new Error('Choose a valid message')
    return service.applyCancellation(accountId, messageId)
  })
  ipcMain.handle('productivity:event-respond', (_event, eventId: unknown, input: unknown) => {
    if (!validId(eventId) || !validRespondInput(input)) throw new Error('Choose a valid meeting response')
    return service.respondToEvent(eventId, { response: input.response, comment: input.comment, proposed: input.proposed })
  })
  return service
}
