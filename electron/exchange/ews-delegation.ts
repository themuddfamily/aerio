import {
  DELEGATE_FOLDERS,
  type DelegateFolder,
  type DelegateFolderPermission,
  type MailboxDelegate,
  type MeetingRequestDelivery
} from '../../src/mailbox-owner-types'
import { EwsError, type EwsClient } from './ews-client'
import { element, escapeXml, m, t, text, tText, type XmlElement } from './ews-xml'

// Exchange delegate management (GetDelegate, AddDelegate, UpdateDelegate, RemoveDelegate), E40.
// The signed-in user manages delegates of their own mailbox: folder permission levels for
// Calendar, Tasks, Inbox, Contacts, and Notes, whether the delegate receives copies of meeting
// messages and may view private items, and where meeting requests are delivered.

const PERMISSION_ELEMENTS: Record<DelegateFolder, string> = {
  calendar: 'CalendarFolderPermissionLevel',
  tasks: 'TasksFolderPermissionLevel',
  inbox: 'InboxFolderPermissionLevel',
  contacts: 'ContactsFolderPermissionLevel',
  notes: 'NotesFolderPermissionLevel'
}
const LEVELS = new Set<DelegateFolderPermission>(['None', 'Reviewer', 'Author', 'Editor'])
export const MEETING_DELIVERY = new Set<MeetingRequestDelivery>(['DelegatesOnly', 'DelegatesAndMe', 'DelegatesAndSendInformationToMe', 'NoForward'])

const mailboxXml = (owner: string) => `<m:Mailbox><t:EmailAddress>${escapeXml(owner)}</t:EmailAddress></m:Mailbox>`
const userIdXml = (address: string) => `<t:UserId><t:PrimarySmtpAddress>${escapeXml(address)}</t:PrimarySmtpAddress></t:UserId>`

/** One DelegateUser element; the permission order follows types.xsd. */
export function delegateUserXml(delegate: MailboxDelegate) {
  const permissions = DELEGATE_FOLDERS.map((folder) => element(PERMISSION_ELEMENTS[folder], delegate.permissions[folder] ?? 'None')).join('')
  return `<t:DelegateUser>${userIdXml(delegate.address)}<t:DelegatePermissions>${permissions}</t:DelegatePermissions>${element('ReceiveCopiesOfMeetingMessages', delegate.receiveCopiesOfMeetingMessages)}${element('ViewPrivateItems', delegate.viewPrivateItems)}</t:DelegateUser>`
}

/** Custom permission sets (set in Outlook) are shown as the closest standard level below them. */
const level = (value: string | undefined): DelegateFolderPermission => LEVELS.has(value as DelegateFolderPermission) ? value as DelegateFolderPermission : value === 'Custom' ? 'Reviewer' : 'None'

export function parseDelegateUser(user: XmlElement | undefined): MailboxDelegate | undefined {
  const id = t(user, 'UserId')
  const address = tText(id, 'PrimarySmtpAddress')?.trim()
  if (!address) return undefined
  const permissions = t(user, 'DelegatePermissions')
  return {
    address,
    ...(tText(id, 'DisplayName') ? { displayName: tText(id, 'DisplayName') } : {}),
    permissions: Object.fromEntries(DELEGATE_FOLDERS.map((folder) => [folder, level(tText(permissions, PERMISSION_ELEMENTS[folder]))])) as Record<DelegateFolder, DelegateFolderPermission>,
    receiveCopiesOfMeetingMessages: tText(user, 'ReceiveCopiesOfMeetingMessages') === 'true',
    viewPrivateItems: tText(user, 'ViewPrivateItems') === 'true'
  }
}

const topLevelError = (operation: string, response: XmlElement | undefined) => {
  if (!response || response.attributes.ResponseClass !== 'Error') return undefined
  const code = text(m(response, 'ResponseCode')) ?? 'ErrorInternalServerError'
  return new EwsError(text(m(response, 'MessageText')) ?? `${operation} failed (${code})`, code)
}

export interface DelegateResult { delegates: MailboxDelegate[]; deliverMeetingRequests: MeetingRequestDelivery }

const result = (response: XmlElement | undefined, delegates: MailboxDelegate[]): DelegateResult => {
  const delivery = text(m(response, 'DeliverMeetingRequests')) as MeetingRequestDelivery | undefined
  return { delegates, deliverMeetingRequests: delivery && MEETING_DELIVERY.has(delivery) ? delivery : 'DelegatesAndSendInformationToMe' }
}

/** The delegates of `owner` (normally the signed-in user's mailbox) with their permissions. */
export async function getDelegates(client: Pick<EwsClient, 'callWithResponse'>, owner: string): Promise<DelegateResult> {
  const { response, messages } = await client.callWithResponse('GetDelegate', `<m:GetDelegate IncludePermissions="true">${mailboxXml(owner)}</m:GetDelegate>`)
  const failure = topLevelError('GetDelegate', response)
  if (failure) throw failure
  const delegates: MailboxDelegate[] = []
  for (const message of messages) {
    if (message.responseClass === 'Error') throw new EwsError(message.message ?? 'A delegate could not be read', message.code)
    const delegate = parseDelegateUser(m(message.element, 'DelegateUser'))
    if (delegate) delegates.push(delegate)
  }
  return result(response, delegates)
}

const writeDelegates = async (client: Pick<EwsClient, 'callWithResponse'>, operation: 'AddDelegate' | 'UpdateDelegate', owner: string, delegates: MailboxDelegate[], delivery?: MeetingRequestDelivery) => {
  const users = delegates.length ? `<m:DelegateUsers>${delegates.map(delegateUserXml).join('')}</m:DelegateUsers>` : ''
  const { response, messages } = await client.callWithResponse(operation, `<m:${operation}>${mailboxXml(owner)}${users}${delivery ? `<m:DeliverMeetingRequests>${delivery}</m:DeliverMeetingRequests>` : ''}</m:${operation}>`)
  const failure = topLevelError(operation, response) ?? messages.filter((message) => message.responseClass === 'Error').map((message) => new EwsError(message.message ?? `${operation} failed (${message.code})`, message.code))[0]
  if (failure) throw failure
}

export const addDelegate = (client: Pick<EwsClient, 'callWithResponse'>, owner: string, delegate: MailboxDelegate, delivery?: MeetingRequestDelivery) =>
  writeDelegates(client, 'AddDelegate', owner, [delegate], delivery)

export const updateDelegate = (client: Pick<EwsClient, 'callWithResponse'>, owner: string, delegate: MailboxDelegate | undefined, delivery?: MeetingRequestDelivery) =>
  writeDelegates(client, 'UpdateDelegate', owner, delegate ? [delegate] : [], delivery)

export async function removeDelegate(client: Pick<EwsClient, 'callWithResponse'>, owner: string, address: string) {
  const { response, messages } = await client.callWithResponse('RemoveDelegate', `<m:RemoveDelegate>${mailboxXml(owner)}<m:UserIds>${userIdXml(address)}</m:UserIds></m:RemoveDelegate>`)
  const failure = topLevelError('RemoveDelegate', response) ?? messages.filter((message) => message.responseClass === 'Error').map((message) => new EwsError(message.message ?? `RemoveDelegate failed (${message.code})`, message.code))[0]
  if (failure) throw failure
}

/** Explains delegate-management errors in the settings screen. */
export function delegationErrorMessage(error: unknown) {
  if (error instanceof EwsError) {
    if (error.code === 'ErrorDelegateAlreadyExists') return 'That person is already a delegate. Edit their permissions instead.'
    if (error.code === 'ErrorNotDelegate' || error.code === 'ErrorDelegateNoUser') return 'Exchange does not know that address as a delegate of this mailbox.'
    if (error.code === 'ErrorDelegateMissingConfiguration' || error.code === 'ErrorDelegateCannotAddOwner') return error.message
    if (error.code === 'ErrorAccessDenied') return 'Exchange refused the change: this account may not manage delegates of the mailbox.'
    if (error.code === 'ErrorInvalidRequest' || error.code === 'ErrorSchemaValidation' || error.code === 'ErrorInvalidOperation') return `This Exchange server does not support managing delegates through EWS (${error.code}).`
    return `Exchange refused the change: ${error.message}`
  }
  return error instanceof Error ? error.message : 'Delegates could not be changed'
}
