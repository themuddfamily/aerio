import { childElement, childElements, elementText, escapeXml, parseXml, type XmlElement } from '../productivity/dav-xml'

// SOAP envelope building and response reading for Exchange Web Services. XML parsing reuses the
// dependency-free, DOCTYPE-refusing reader from the CalDAV client (productivity/dav-xml.ts).
// Request bodies are assembled from escaped template strings; element order follows the EWS
// schema (types.xsd), which Exchange validates strictly.

export const SOAP_NS = 'http://schemas.xmlsoap.org/soap/envelope/'
export const TYPES_NS = 'http://schemas.microsoft.com/exchange/services/2006/types'
export const MESSAGES_NS = 'http://schemas.microsoft.com/exchange/services/2006/messages'

/**
 * The schema version Aerio writes. Exchange 2013 SP1 is the oldest supported server, and 2016,
 * 2019, and Subscription Edition accept requests at this version, so one request shape works for all.
 */
export const REQUEST_SERVER_VERSION = 'Exchange2013_SP1'

export { escapeXml }
export const attr = (value: string) => escapeXml(value)

export interface EnvelopeOptions {
  /** Windows time zone id for unqualified date-times in this request (TimeZoneContext). */
  timeZone?: string
  /** Extra SOAP headers (for example ExchangeImpersonation), already serialized. */
  headers?: string
}

export function soapEnvelope(body: string, options: EnvelopeOptions = {}) {
  const timeZone = options.timeZone ? `<t:TimeZoneContext><t:TimeZoneDefinition Id="${attr(options.timeZone)}"/></t:TimeZoneContext>` : ''
  return '<?xml version="1.0" encoding="utf-8"?>' +
    `<soap:Envelope xmlns:soap="${SOAP_NS}" xmlns:t="${TYPES_NS}" xmlns:m="${MESSAGES_NS}">` +
    `<soap:Header><t:RequestServerVersion Version="${REQUEST_SERVER_VERSION}"/>${timeZone}${options.headers ?? ''}</soap:Header>` +
    `<soap:Body>${body}</soap:Body></soap:Envelope>`
}

export const t = (element: XmlElement | undefined, name: string) => childElement(element, TYPES_NS, name)
export const ts = (element: XmlElement | undefined, name: string) => childElements(element, TYPES_NS, name)
export const m = (element: XmlElement | undefined, name: string) => childElement(element, MESSAGES_NS, name)
export const ms = (element: XmlElement | undefined, name: string) => childElements(element, MESSAGES_NS, name)
export const text = (element: XmlElement | undefined) => elementText(element)
export const tText = (element: XmlElement | undefined, name: string) => elementText(t(element, name))
export const tBool = (element: XmlElement | undefined, name: string) => {
  const value = tText(element, name)
  return value === undefined ? undefined : value === 'true'
}
export const tNumber = (element: XmlElement | undefined, name: string) => {
  const value = Number(tText(element, name))
  return Number.isFinite(value) ? value : undefined
}

/** Follows a path of types-namespace children, e.g. path(item, 'Organizer', 'Mailbox', 'EmailAddress'). */
export function path(element: XmlElement | undefined, ...names: string[]) {
  let current = element
  for (const name of names) current = t(current, name)
  return current
}

export interface EwsServerVersion {
  major: number
  minor: number
  build: number
  revision: number
  /** The schema version string the server reports, e.g. "V2017_07_11". */
  version?: string
}

export interface ParsedEnvelope {
  body: XmlElement
  serverVersion?: EwsServerVersion
}

export class EwsSoapFault extends Error {
  constructor(message: string, readonly code?: string) {
    super(message)
    this.name = 'EwsSoapFault'
  }
}

export function parseEnvelope(xml: string): ParsedEnvelope {
  const root = parseXml(xml)
  if (root.ns !== SOAP_NS || root.name !== 'Envelope') throw new EwsSoapFault('The server did not answer with an EWS SOAP response')
  const header = childElement(root, SOAP_NS, 'Header')
  const body = childElement(root, SOAP_NS, 'Body')
  if (!body) throw new EwsSoapFault('The EWS response has no SOAP body')
  const fault = childElement(body, SOAP_NS, 'Fault')
  if (fault) {
    const detail = fault.children.find((child) => child.name === 'detail')
    const code = detail?.children.find((child) => child.name === 'ResponseCode')
    const message = detail?.children.find((child) => child.name === 'Message')
    const faultString = fault.children.find((child) => child.name === 'faultstring')
    throw new EwsSoapFault(elementText(message) || elementText(faultString) || 'Exchange rejected the request', elementText(code) || undefined)
  }
  const info = header ? childElement(header, TYPES_NS, 'ServerVersionInfo') : undefined
  const serverVersion = info ? {
    major: Number(info.attributes.MajorVersion ?? 0),
    minor: Number(info.attributes.MinorVersion ?? 0),
    build: Number(info.attributes.MajorBuildNumber ?? 0),
    revision: Number(info.attributes.MinorBuildNumber ?? 0),
    ...(info.attributes.Version ? { version: info.attributes.Version } : {})
  } : undefined
  return { body, ...(serverVersion ? { serverVersion } : {}) }
}

export interface EwsResponseMessage {
  element: XmlElement
  responseClass: 'Success' | 'Warning' | 'Error'
  code: string
  message?: string
  /** For ErrorServerBusy: how long Exchange asks the client to wait. */
  backOffMs?: number
}

/** The per-item response messages of an operation, in request order. */
export function responseMessages(body: XmlElement, operation: string): EwsResponseMessage[] {
  const response = m(body, `${operation}Response`)
  if (!response) throw new EwsSoapFault(`The server did not return a ${operation} response`)
  const container = m(response, 'ResponseMessages')
  // A few operations (GetRoomLists, GetRooms, FindPeople) answer with a single unwrapped response.
  const elements = container ? container.children : response.attributes.ResponseClass ? [response] : []
  return elements.map((element) => {
    const responseClass = (element.attributes.ResponseClass ?? 'Error') as EwsResponseMessage['responseClass']
    const backOff = element.children.find((child) => child.name === 'MessageXml')?.children.find((child) => child.attributes.Name === 'BackOffMilliseconds')
    return {
      element,
      responseClass,
      code: text(m(element, 'ResponseCode')) ?? (responseClass === 'Success' ? 'NoError' : 'ErrorInternalServerError'),
      ...(text(m(element, 'MessageText')) ? { message: text(m(element, 'MessageText')) } : {}),
      ...(backOff && Number.isFinite(Number(text(backOff))) ? { backOffMs: Number(text(backOff)) } : {})
    }
  })
}

// --- Request fragments --------------------------------------------------------------------------

export interface FolderRef {
  /** A FolderId from the server, or a distinguished name such as "inbox". */
  id: string
  changeKey?: string
  distinguished?: boolean
  /** For distinguished folders of another mailbox (delegate access, E40). */
  mailbox?: string
}

export const DISTINGUISHED_FOLDERS = new Set([
  'msgfolderroot', 'root', 'inbox', 'sentitems', 'drafts', 'deleteditems', 'junkemail', 'outbox', 'archive',
  'calendar', 'contacts', 'tasks', 'notes', 'journal', 'publicfoldersroot', 'archivemsgfolderroot'
])

export function folderIdXml(folder: FolderRef) {
  if (folder.distinguished ?? DISTINGUISHED_FOLDERS.has(folder.id)) {
    const mailbox = folder.mailbox ? `<t:Mailbox><t:EmailAddress>${escapeXml(folder.mailbox)}</t:EmailAddress></t:Mailbox>` : ''
    return mailbox ? `<t:DistinguishedFolderId Id="${attr(folder.id)}">${mailbox}</t:DistinguishedFolderId>` : `<t:DistinguishedFolderId Id="${attr(folder.id)}"/>`
  }
  return `<t:FolderId Id="${attr(folder.id)}"${folder.changeKey ? ` ChangeKey="${attr(folder.changeKey)}"` : ''}/>`
}

export interface ItemRef { id: string; changeKey?: string }

export const itemIdXml = (item: ItemRef) => `<t:ItemId Id="${attr(item.id)}"${item.changeKey ? ` ChangeKey="${attr(item.changeKey)}"` : ''}/>`
export const fieldUris = (uris: string[]) => uris.map((uri) => `<t:FieldURI FieldURI="${attr(uri)}"/>`).join('')
// eslint-disable-next-line no-control-regex
const INVALID_XML_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g
/** Escapes text content and drops characters XML 1.0 cannot carry. */
export const xmlText = (value: string) => escapeXml(value.replace(INVALID_XML_CHARS, ''))
export const element = (name: string, value: string | number | boolean | undefined) =>
  value === undefined ? '' : `<t:${name}>${xmlText(String(value))}</t:${name}>`

export interface ParsedItemId { id: string; changeKey?: string }
export function readItemId(element: XmlElement | undefined): ParsedItemId | undefined {
  const id = t(element, 'ItemId')
  return id?.attributes.Id ? { id: id.attributes.Id, ...(id.attributes.ChangeKey ? { changeKey: id.attributes.ChangeKey } : {}) } : undefined
}
export function readFolderId(element: XmlElement | undefined): ParsedItemId | undefined {
  const id = t(element, 'FolderId')
  return id?.attributes.Id ? { id: id.attributes.Id, ...(id.attributes.ChangeKey ? { changeKey: id.attributes.ChangeKey } : {}) } : undefined
}

export type { XmlElement }
