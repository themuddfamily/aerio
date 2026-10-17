import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { createHmac, randomBytes } from 'node:crypto'
import { parseXml, type XmlElement } from '../productivity/dav-xml'
import { AV, encodeAvPairs, fileTime, ntowfV2, parseAuthenticateMessage } from './ntlm'
import { escapeXml, MESSAGES_NS, SOAP_NS, TYPES_NS } from './ews-xml'

// An in-process Exchange Web Services and Autodiscover responder for tests. It speaks real SOAP
// over HTTP on 127.0.0.1, validates Basic, NTLMv2 (per connection), and bearer authentication,
// and keeps a small mailbox with folders, messages (raw MIME), calendar items, and contacts.
// Sync states are opaque tokens over a change sequence, so paging, incremental checkpoints, and
// invalid states behave like Exchange. Nothing here is packaged or reachable off loopback.

export type FixtureAuth = 'basic' | 'ntlm' | 'negotiate' | 'kerberos-only' | 'bearer' | 'none'

export interface FixtureFolder {
  id: string
  changeKey: string
  parentId?: string
  displayName: string
  folderClass: string
  distinguished?: string
  modifiedSeq: number
  canWrite: boolean
}

export interface FixtureItem {
  id: string
  changeKey: string
  folderId: string
  kind: 'message' | 'calendar' | 'contact' | 'note'
  addedSeq: number
  modifiedSeq: number
  /** Only the read flag changed since `readSeq` (reported as ReadFlagChange). */
  readOnlyChangeSeq?: number
  mime?: Buffer
  isRead?: boolean
  flagged?: boolean
  importance?: string
  conversationId?: string
  isDraft?: boolean
  received?: string
  /** Calendar/contact/note properties as serialized type elements, by local name. */
  props: Map<string, string>
  /** FileAttachments (notes). */
  attachments?: FixtureAttachment[]
}

/** A global address list entry (E41 directory tests). */
export interface FixtureDirectoryEntry {
  name: string
  email: string
  /** Mailbox (default), PublicDL, ... */
  mailboxType?: string
  /** FindPeople PersonaType; derived from mailboxType when omitted. */
  personaType?: string
  title?: string
  department?: string
  company?: string
  office?: string
  phone?: string
  /** Distribution group members (addresses of other entries). */
  members?: string[]
}
export interface FixtureAttachment { id: string; name: string; contentType: string; contentId?: string; isInline: boolean; content: Buffer }

export interface AutodiscoverAnswer {
  status?: number
  location?: string
  /** Also redirect authenticated POSTs (a misconfigured HTTPS endpoint). */
  redirectPost?: boolean
  ewsUrl?: string
  redirectUrl?: string
  redirectAddr?: string
  serverVersion?: string
  displayName?: string
}

export interface EwsFixtureOptions {
  auth?: FixtureAuth
  username?: string
  password?: string
  domain?: string
  token?: string
  /** ServerVersionInfo in every response (default Exchange 2019 CU12). */
  version?: { major: number; minor: number; build: number; revision: number }
}

const wrap = (body: string, version: EwsFixtureOptions['version']) => '<?xml version="1.0" encoding="utf-8"?>' +
  `<s:Envelope xmlns:s="${SOAP_NS}"><s:Header><h:ServerVersionInfo xmlns:h="${TYPES_NS}" MajorVersion="${version!.major}" MinorVersion="${version!.minor}" MajorBuildNumber="${version!.build}" MinorBuildNumber="${version!.revision}" Version="V2017_07_11"/></s:Header>` +
  `<s:Body xmlns:m="${MESSAGES_NS}" xmlns:t="${TYPES_NS}">${body}</s:Body></s:Envelope>`

const ok = (operation: string, inner: string) => `<m:${operation}ResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode>${inner}</m:${operation}ResponseMessage>`
const fail = (operation: string, code: string, text = code) => `<m:${operation}ResponseMessage ResponseClass="Error"><m:MessageText>${escapeXml(text)}</m:MessageText><m:ResponseCode>${code}</m:ResponseCode><m:DescriptiveLinkKey>0</m:DescriptiveLinkKey></m:${operation}ResponseMessage>`
const reply = (operation: string, messages: string[]) => `<m:${operation}Response><m:ResponseMessages>${messages.join('')}</m:ResponseMessages></m:${operation}Response>`

const child = (element: XmlElement | undefined, name: string) => element?.children.find((item) => item.name === name)
const children = (element: XmlElement | undefined, name: string) => element?.children.filter((item) => item.name === name) ?? []
const text = (element: XmlElement | undefined): string => element ? element.text + element.children.map(text).join('') : ''

const parseFragment = (xml: string) => parseXml(xml.replace(/^<t:(\w+)/, `<t:$1 xmlns:t="${TYPES_NS}"`))

/** Serializes a parsed element back to `t:`-prefixed XML (fixture storage only). */
export function serialize(element: XmlElement): string {
  const attributes = Object.entries(element.attributes).map(([name, value]) => ` ${name}="${escapeXml(value)}"`).join('')
  const body = element.children.length ? element.children.map(serialize).join('') : escapeXml(element.text)
  return `<t:${element.name}${attributes}>${body}</t:${element.name}>`
}

const DISTINGUISHED: [string, string, string][] = [
  ['msgfolderroot', 'Top of Information Store', 'IPF.Note'],
  ['inbox', 'Inbox', 'IPF.Note'], ['sentitems', 'Sent Items', 'IPF.Note'], ['drafts', 'Drafts', 'IPF.Note'], ['deleteditems', 'Deleted Items', 'IPF.Note'],
  ['junkemail', 'Junk Email', 'IPF.Note'], ['calendar', 'Calendar', 'IPF.Appointment'], ['contacts', 'Contacts', 'IPF.Contact']
]

export class EwsFixtureServer {
  readonly server: Server
  url = ''
  origin = ''
  seq = 1
  generation = 1
  hierarchySeq = 1
  folders = new Map<string, FixtureFolder>()
  items = new Map<string, FixtureItem>()
  removed = new Map<string, { folderId: string; addedSeq: number; removedSeq: number }>()
  removedFolders = new Map<string, number>()
  sent: { mime: Buffer; readReceipt: boolean; deliveryReceipt: boolean }[] = []
  log: { operation: string; body: string; headers: IncomingMessage['headers'] }[] = []
  autodiscover = new Map<string, AutodiscoverAnswer>()
  /** Next responses for an operation: an error code or 'busy' (ErrorServerBusy with back-off). */
  failures = new Map<string, string[]>()
  sessionsExpired = false
  deletedOccurrences: { masterId: string; instanceIndex: number }[] = []
  /** Global address list for ResolveNames, ExpandDL, and FindPeople. */
  directory: FixtureDirectoryEntry[] = []
  /** Room lists by address: GetRoomLists/GetRooms. */
  roomLists = new Map<string, { name: string; rooms: string[] }>()
  /** Like servers that search the directory only with a query string. */
  findPeopleNeedsQuery = false
  private readonly authenticated = new WeakSet<Socket>()
  private readonly challenges = new WeakMap<Socket, Buffer>()
  private counter = 0

  constructor(readonly options: EwsFixtureOptions = {}) {
    this.options = { auth: 'ntlm', username: 'CONTOSO\\ada', password: 'Pa55w0rd!', domain: 'CONTOSO', token: 'token-1', version: { major: 15, minor: 2, build: 1118, revision: 7 }, ...options }
    for (const [distinguished, displayName, folderClass] of DISTINGUISHED) {
      const id = this.nextId('F')
      this.folders.set(id, { id, changeKey: 'ck1', displayName, folderClass, distinguished, modifiedSeq: this.hierarchySeq, canWrite: true, ...(distinguished !== 'msgfolderroot' ? { parentId: '' } : {}) })
    }
    const root = this.folder('msgfolderroot').id
    for (const folder of this.folders.values()) if (folder.distinguished !== 'msgfolderroot') folder.parentId = root
    this.server = createServer((request, response) => void this.handle(request, response).catch((error) => {
      response.statusCode = 500
      response.end(String(error))
    }))
  }

  async start() {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('No fixture address')
    this.origin = `http://127.0.0.1:${address.port}`
    this.url = `${this.origin}/EWS/Exchange.asmx`
    return this
  }

  async stop() {
    this.server.closeAllConnections?.()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  nextId(prefix: string) { return `${prefix}${(++this.counter).toString().padStart(4, '0')}${randomBytes(6).toString('base64url')}==` }

  folder(distinguished: string) {
    const found = [...this.folders.values()].find((folder) => folder.distinguished === distinguished)
    if (!found) throw new Error(`No ${distinguished} folder`)
    return found
  }

  addFolder(displayName: string, folderClass = 'IPF.Note', parentId = this.folder('msgfolderroot').id) {
    const id = this.nextId('F')
    const folder: FixtureFolder = { id, changeKey: 'ck1', parentId, displayName, folderClass, modifiedSeq: ++this.hierarchySeq, canWrite: true }
    this.folders.set(id, folder)
    return folder
  }

  addMessage(folderId: string, input: { subject: string; from?: string; body?: string; isRead?: boolean; flagged?: boolean; importance?: string; conversationId?: string; messageId?: string; received?: string }) {
    const id = this.nextId('M')
    const received = input.received ?? new Date(Date.UTC(2026, 9, 1, 9, 0, this.counter)).toISOString()
    const mime = Buffer.from([
      `From: ${input.from ?? 'Grace <grace@contoso.test>'}`, 'To: Ada <ada@contoso.test>', `Subject: ${input.subject}`, `Date: ${new Date(received).toUTCString()}`,
      `Message-ID: <${input.messageId ?? `${id.replace(/[^A-Za-z0-9]/g, '')}@contoso.test`}>`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', input.body ?? `Body of ${input.subject}`, ''
    ].join('\r\n'))
    const seq = ++this.seq
    const item: FixtureItem = { id, changeKey: `ck${seq}`, folderId, kind: 'message', addedSeq: seq, modifiedSeq: seq, mime, isRead: input.isRead ?? false, flagged: input.flagged ?? false, importance: input.importance ?? 'Normal', conversationId: input.conversationId ?? `CONV-${id}`, received, props: new Map() }
    this.items.set(id, item)
    return item
  }

  /** Adds a calendar item, contact, or sticky note from serialized `t:` property elements. */
  addItem(folderId: string, kind: 'calendar' | 'contact' | 'note', props: Record<string, string>) {
    const id = this.nextId(kind === 'calendar' ? 'C' : kind === 'note' ? 'N' : 'P')
    const seq = ++this.seq
    const item: FixtureItem = { id, changeKey: `ck${seq}`, folderId, kind, addedSeq: seq, modifiedSeq: seq, props: new Map(Object.entries(props)) }
    this.items.set(id, item)
    return item
  }

  /** A change made by another client: bumps the ChangeKey so stale writes conflict. */
  touch(itemId: string, change: (item: FixtureItem) => void, readOnly = false) {
    const item = this.items.get(itemId)
    if (!item) throw new Error('No such item')
    change(item)
    const seq = ++this.seq
    item.modifiedSeq = seq
    item.changeKey = `ck${seq}`
    if (readOnly) item.readOnlyChangeSeq = seq
    else item.readOnlyChangeSeq = undefined
  }

  removeItem(itemId: string) {
    const item = this.items.get(itemId)
    if (!item) return
    this.items.delete(itemId)
    this.removed.set(itemId, { folderId: item.folderId, addedSeq: item.addedSeq, removedSeq: ++this.seq })
  }

  moveItem(itemId: string, folderId: string) {
    const item = this.items.get(itemId)
    if (!item) return undefined
    this.removeItem(itemId)
    const id = this.nextId(item.kind === 'message' ? 'M' : 'C')
    const seq = ++this.seq
    const moved = { ...item, id, folderId, addedSeq: seq, modifiedSeq: seq, changeKey: `ck${seq}`, readOnlyChangeSeq: undefined, props: new Map(item.props) }
    this.items.set(id, moved)
    return moved
  }

  invalidateSyncStates() { this.generation++ }
  expireSessions(expired = true) { this.sessionsExpired = expired }
  failNext(operation: string, ...codes: string[]) { this.failures.set(operation, [...(this.failures.get(operation) ?? []), ...codes]) }
  operations() { return this.log.map((entry) => entry.operation) }

  // --- HTTP ------------------------------------------------------------------------------------

  private async read(request: IncomingMessage) {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks).toString('utf8')
  }

  private challenge(response: ServerResponse, schemes: string[]) {
    response.statusCode = 401
    response.setHeader('WWW-Authenticate', schemes)
    response.setHeader('Content-Length', '0')
    response.end()
  }

  /** True when authenticated; otherwise the 401 has been sent. */
  private authenticate(request: IncomingMessage, response: ServerResponse) {
    const mode = this.options.auth!
    if (mode === 'none') return true
    const header = request.headers.authorization ?? ''
    const socket = request.socket
    if (this.sessionsExpired) {
      this.authenticated.delete(socket)
      const schemes = mode === 'basic' ? ['Basic realm="contoso"'] : mode === 'bearer' ? ['Bearer'] : mode === 'kerberos-only' ? ['Negotiate'] : mode === 'negotiate' ? ['Negotiate'] : ['NTLM', 'Negotiate']
      this.challenge(response, schemes)
      return false
    }
    if (mode === 'basic') {
      const expected = `Basic ${Buffer.from(`${this.options.username}:${this.options.password}`).toString('base64')}`
      if (header === expected) return true
      this.challenge(response, ['Basic realm="contoso"'])
      return false
    }
    if (mode === 'bearer') {
      if (header === `Bearer ${this.options.token}`) return true
      this.challenge(response, ['Bearer'])
      return false
    }
    if (mode === 'kerberos-only') {
      // A Kerberos-only server ignores NTLM tokens carried in Negotiate.
      this.challenge(response, ['Negotiate'])
      return false
    }
    const scheme = mode === 'negotiate' ? 'Negotiate' : 'NTLM'
    if (this.authenticated.has(socket) && !header) return true
    const match = new RegExp(`^${scheme} (.+)$`, 'i').exec(header)
    if (!match) {
      this.challenge(response, mode === 'negotiate' ? ['Negotiate'] : ['NTLM', 'Negotiate'])
      return false
    }
    const token = Buffer.from(match[1], 'base64')
    const type = token.length >= 12 ? token.readUInt32LE(8) : 0
    if (type === 1) {
      const serverChallenge = randomBytes(8)
      this.challenges.set(socket, serverChallenge)
      const domain = this.options.domain ?? ''
      const targetInfo = encodeAvPairs([
        { id: AV.NB_DOMAIN, value: Buffer.from(domain, 'utf16le') }, { id: AV.NB_COMPUTER, value: Buffer.from('EXCH01', 'utf16le') },
        { id: AV.TIMESTAMP, value: fileTime() }
      ])
      const name = Buffer.from(domain, 'utf16le')
      const message = Buffer.alloc(56)
      Buffer.from('NTLMSSP\0', 'latin1').copy(message, 0)
      message.writeUInt32LE(2, 8)
      message.writeUInt16LE(name.length, 12); message.writeUInt16LE(name.length, 14); message.writeUInt32LE(56, 16)
      message.writeUInt32LE(0xe28a8235 >>> 0, 20)
      serverChallenge.copy(message, 24)
      message.writeUInt16LE(targetInfo.length, 40); message.writeUInt16LE(targetInfo.length, 42); message.writeUInt32LE(56 + name.length, 44)
      this.challenge(response, [`${scheme} ${Buffer.concat([message, name, targetInfo]).toString('base64')}`])
      return false
    }
    const serverChallenge = this.challenges.get(socket)
    if (type === 3 && serverChallenge) {
      const parsed = parseAuthenticateMessage(token)
      const [expectedDomain, expectedUser] = (this.options.username ?? '').includes('\\') ? (this.options.username ?? '').split('\\') : [this.options.domain ?? '', this.options.username ?? '']
      const proof = parsed.ntResponse.subarray(0, 16)
      const temp = parsed.ntResponse.subarray(16)
      const expected = createHmac('md5', ntowfV2(this.options.password ?? '', expectedUser, parsed.domain)).update(Buffer.concat([serverChallenge, temp])).digest()
      if (parsed.user.toLowerCase() === expectedUser.toLowerCase() && parsed.domain.toLowerCase() === expectedDomain.toLowerCase() && proof.equals(expected)) {
        this.authenticated.add(socket)
        return true
      }
    }
    this.challenge(response, ['NTLM', 'Negotiate'])
    return false
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    const body = await this.read(request)
    const url = new URL(request.url ?? '/', this.origin)
    const host = String(request.headers['x-fixture-host'] ?? request.headers.host ?? '').toLowerCase()
    if (url.pathname.toLowerCase() === '/autodiscover/autodiscover.xml') return this.handleAutodiscover(request, response, host, body)
    if (url.pathname !== '/EWS/Exchange.asmx') { response.statusCode = 404; response.end(); return }
    if (!this.authenticate(request, response)) return
    let root: XmlElement
    try { root = parseXml(body) } catch { response.statusCode = 400; response.end(); return }
    const operationElement = child(root, 'Body')?.children[0]
    const operation = operationElement?.name ?? ''
    this.log.push({ operation, body, headers: request.headers })
    const pending = this.failures.get(operation)
    const failure = pending?.shift()
    if (failure === 'busy') {
      return this.send(response, reply(operation, [`<m:${operation}ResponseMessage ResponseClass="Error"><m:MessageText>Server busy</m:MessageText><m:ResponseCode>ErrorServerBusy</m:ResponseCode><m:DescriptiveLinkKey>0</m:DescriptiveLinkKey><m:MessageXml><t:Value Name="BackOffMilliseconds">5</t:Value></m:MessageXml></m:${operation}ResponseMessage>`]))
    }
    if (failure) return this.send(response, reply(operation, [fail(operation, failure)]))
    const handlers: Record<string, (element: XmlElement) => string> = {
      GetFolder: (element) => this.getFolder(element), FindFolder: (element) => this.findFolder(element), SyncFolderHierarchy: (element) => this.syncHierarchy(element),
      SyncFolderItems: (element) => this.syncItems(element), GetItem: (element) => this.getItem(element), UpdateItem: (element) => this.updateItem(element),
      MoveItem: (element) => this.moveOrCopy(element, 'MoveItem'), CopyItem: (element) => this.moveOrCopy(element, 'CopyItem'), DeleteItem: (element) => this.deleteItem(element),
      CreateItem: (element) => this.createItem(element), CreateFolder: (element) => this.createFolder(element), UpdateFolder: (element) => this.updateFolder(element),
      MoveFolder: (element) => this.moveFolder(element), DeleteFolder: (element) => this.deleteFolder(element),
      ...directoryHandlers(this),
      GetAttachment: (element) => this.getAttachment(element), CreateAttachment: (element) => this.createAttachment(element), DeleteAttachment: (element) => this.deleteAttachment(element)
    }
    const handler = handlers[operation]
    if (!handler) {
      response.statusCode = 500
      return this.send(response, `<s:Fault><faultcode>s:Client</faultcode><faultstring>The request failed schema validation</faultstring><detail><e:ResponseCode xmlns:e="http://schemas.microsoft.com/exchange/services/2006/errors">ErrorSchemaValidation</e:ResponseCode></detail></s:Fault>`)
    }
    this.send(response, handler(operationElement!))
  }

  private send(response: ServerResponse, body: string) {
    const payload = Buffer.from(wrap(body, this.options.version), 'utf8')
    if (!response.statusCode || response.statusCode === 200) response.statusCode = 200
    response.setHeader('Content-Type', 'text/xml; charset=utf-8')
    response.setHeader('Content-Length', String(payload.length))
    response.end(payload)
  }

  private handleAutodiscover(request: IncomingMessage, response: ServerResponse, host: string, body: string) {
    const answer = this.autodiscover.get(host)
    this.log.push({ operation: `Autodiscover ${request.method} ${host}`, body, headers: request.headers })
    if (!answer) { response.statusCode = 404; response.end(); return }
    // A host that only redirects (the HTTP redirect method) has no HTTPS Autodiscover service unless redirectPost is set.
    if (answer.location && (request.method === 'GET' || answer.redirectPost)) { response.statusCode = answer.status ?? 302; response.setHeader('Location', answer.location); response.end(); return }
    if (answer.location) { response.statusCode = 404; response.end(); return }
    if (request.method !== 'POST') { response.statusCode = 405; response.end(); return }
    if (answer.status && answer.status !== 200) { response.statusCode = answer.status; response.end(); return }
    if (!this.authenticate(request, response)) return
    const email = /<EMailAddress>([^<]+)<\/EMailAddress>/.exec(body)?.[1] ?? ''
    const account = answer.redirectAddr ? `<Action>redirectAddr</Action><RedirectAddr>${answer.redirectAddr}</RedirectAddr>`
      : answer.redirectUrl ? `<Action>redirectUrl</Action><RedirectUrl>${answer.redirectUrl}</RedirectUrl>`
        : `<AccountType>email</AccountType><Action>settings</Action><Protocol><Type>EXCH</Type><Server>exch01.contoso.test</Server><ServerVersion>${answer.serverVersion ?? '73C28880'}</ServerVersion><EwsUrl>${answer.ewsUrl ?? this.url}</EwsUrl></Protocol>`
    const xml = `<?xml version="1.0" encoding="utf-8"?><Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006"><Response xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a"><User><DisplayName>${answer.displayName ?? 'Ada Lovelace'}</DisplayName><AutoDiscoverSMTPAddress>${email}</AutoDiscoverSMTPAddress></User><Account>${account}</Account></Response></Autodiscover>`
    response.statusCode = 200
    response.setHeader('Content-Type', 'text/xml')
    response.end(xml)
  }

  // --- Folders ---------------------------------------------------------------------------------

  private resolveFolder(element: XmlElement | undefined) {
    if (!element) return undefined
    if (element.name === 'DistinguishedFolderId') return [...this.folders.values()].find((folder) => folder.distinguished === element.attributes.Id)
    return this.folders.get(element.attributes.Id ?? '')
  }

  private folderXml(folder: FixtureFolder) {
    const tag = folder.folderClass === 'IPF.Appointment' ? 'CalendarFolder' : folder.folderClass === 'IPF.Contact' ? 'ContactsFolder' : 'Folder'
    const count = [...this.items.values()].filter((item) => item.folderId === folder.id).length
    const childCount = [...this.folders.values()].filter((item) => item.parentId === folder.id).length
    return `<t:${tag}><t:FolderId Id="${folder.id}" ChangeKey="${folder.changeKey}"/>${folder.parentId ? `<t:ParentFolderId Id="${folder.parentId}"/>` : ''}<t:FolderClass>${folder.folderClass}</t:FolderClass><t:DisplayName>${escapeXml(folder.displayName)}</t:DisplayName><t:TotalCount>${count}</t:TotalCount><t:ChildFolderCount>${childCount}</t:ChildFolderCount><t:EffectiveRights><t:CreateAssociated>true</t:CreateAssociated><t:CreateContents>${folder.canWrite}</t:CreateContents><t:CreateHierarchy>true</t:CreateHierarchy><t:Delete>${folder.canWrite}</t:Delete><t:Modify>${folder.canWrite}</t:Modify><t:Read>true</t:Read></t:EffectiveRights></t:${tag}>`
  }

  private getFolder(element: XmlElement) {
    return reply('GetFolder', (child(element, 'FolderIds')?.children ?? []).map((id) => {
      const folder = this.resolveFolder(id)
      return folder ? ok('GetFolder', `<m:Folders>${this.folderXml(folder)}</m:Folders>`) : fail('GetFolder', 'ErrorFolderNotFound')
    }))
  }

  private descendants(parentId: string): FixtureFolder[] {
    const direct = [...this.folders.values()].filter((folder) => folder.parentId === parentId)
    return direct.flatMap((folder) => [folder, ...this.descendants(folder.id)])
  }

  private findFolder(element: XmlElement) {
    const parent = this.resolveFolder(child(element, 'ParentFolderIds')?.children[0])
    if (!parent) return reply('FindFolder', [fail('FindFolder', 'ErrorFolderNotFound')])
    const all = element.attributes.Traversal === 'Shallow' ? [...this.folders.values()].filter((folder) => folder.parentId === parent.id) : this.descendants(parent.id)
    const view = child(element, 'IndexedPageFolderView')
    const offset = Number(view?.attributes.Offset ?? 0)
    const max = Number(view?.attributes.MaxEntriesReturned ?? 1000)
    const page = all.slice(offset, offset + max)
    const last = offset + page.length >= all.length
    return reply('FindFolder', [ok('FindFolder', `<m:RootFolder IndexedPagingOffset="${offset + page.length}" TotalItemsInView="${all.length}" IncludesLastItemInRange="${last}"><t:Folders>${page.map((folder) => this.folderXml(folder)).join('')}</t:Folders></m:RootFolder>`)])
  }

  private parseState(value: string | undefined, prefix: string) {
    if (!value) return 0
    const [kind, generation, seq] = Buffer.from(value, 'base64').toString('utf8').split(':')
    if (kind !== prefix || Number(generation) !== this.generation || !Number.isFinite(Number(seq))) return undefined
    return Number(seq)
  }

  private state(prefix: string, seq: number) { return Buffer.from(`${prefix}:${this.generation}:${seq}`).toString('base64') }

  private syncHierarchy(element: XmlElement) {
    const since = this.parseState(text(child(element, 'SyncState')).trim() || undefined, 'H')
    if (since === undefined) return reply('SyncFolderHierarchy', [fail('SyncFolderHierarchy', 'ErrorInvalidSyncStateData')])
    const changes = [...this.folders.values()].filter((folder) => folder.modifiedSeq > since && folder.distinguished !== 'msgfolderroot')
      .map((folder) => `<t:${since === 0 ? 'Create' : 'Update'}>${this.folderXml(folder)}</t:${since === 0 ? 'Create' : 'Update'}>`)
    for (const [id, removedSeq] of this.removedFolders) if (removedSeq > since && since > 0) changes.push(`<t:Delete><t:FolderId Id="${id}"/></t:Delete>`)
    return reply('SyncFolderHierarchy', [ok('SyncFolderHierarchy', `<m:SyncState>${this.state('H', this.hierarchySeq)}</m:SyncState><m:IncludesLastFolderInRange>true</m:IncludesLastFolderInRange><m:Changes>${changes.join('')}</m:Changes>`)])
  }

  private createFolder(element: XmlElement) {
    const parent = this.resolveFolder(child(element, 'ParentFolderId')?.children[0])
    const spec = child(element, 'Folders')?.children[0]
    const name = text(child(spec, 'DisplayName'))
    if (!parent) return reply('CreateFolder', [fail('CreateFolder', 'ErrorParentFolderNotFound')])
    if ([...this.folders.values()].some((folder) => folder.parentId === parent.id && folder.displayName.toLowerCase() === name.toLowerCase())) return reply('CreateFolder', [fail('CreateFolder', 'ErrorFolderExists')])
    const folder = this.addFolder(name, text(child(spec, 'FolderClass')) || 'IPF.Note', parent.id)
    return reply('CreateFolder', [ok('CreateFolder', `<m:Folders><t:Folder><t:FolderId Id="${folder.id}" ChangeKey="${folder.changeKey}"/></t:Folder></m:Folders>`)])
  }

  private updateFolder(element: XmlElement) {
    const change = child(child(element, 'FolderChanges'), 'FolderChange')
    const folder = this.resolveFolder(change?.children[0])
    if (!folder) return reply('UpdateFolder', [fail('UpdateFolder', 'ErrorFolderNotFound')])
    const name = text(child(child(child(child(change, 'Updates'), 'SetFolderField'), 'Folder'), 'DisplayName'))
    if (name) folder.displayName = name
    folder.modifiedSeq = ++this.hierarchySeq
    return reply('UpdateFolder', [ok('UpdateFolder', `<m:Folders><t:Folder><t:FolderId Id="${folder.id}" ChangeKey="${folder.changeKey}"/></t:Folder></m:Folders>`)])
  }

  private moveFolder(element: XmlElement) {
    const target = this.resolveFolder(child(element, 'ToFolderId')?.children[0])
    const folder = this.resolveFolder(child(element, 'FolderIds')?.children[0])
    if (!target || !folder) return reply('MoveFolder', [fail('MoveFolder', 'ErrorFolderNotFound')])
    folder.parentId = target.id
    folder.modifiedSeq = ++this.hierarchySeq
    return reply('MoveFolder', [ok('MoveFolder', `<m:Folders><t:Folder><t:FolderId Id="${folder.id}" ChangeKey="${folder.changeKey}"/></t:Folder></m:Folders>`)])
  }

  private deleteFolder(element: XmlElement) {
    const folder = this.resolveFolder(child(element, 'FolderIds')?.children[0])
    if (!folder || folder.distinguished) return reply('DeleteFolder', [fail('DeleteFolder', folder ? 'ErrorDeleteDistinguishedFolder' : 'ErrorFolderNotFound')])
    const trash = this.folder('deleteditems')
    if (element.attributes.DeleteType === 'MoveToDeletedItems') {
      folder.parentId = trash.id
      folder.modifiedSeq = ++this.hierarchySeq
    } else {
      this.folders.delete(folder.id)
      this.removedFolders.set(folder.id, ++this.hierarchySeq)
    }
    return reply('DeleteFolder', [ok('DeleteFolder', '')])
  }

  // --- Items -----------------------------------------------------------------------------------

  private itemXml(item: FixtureItem, includeMime = false) {
    if (item.kind === 'message') {
      return `<t:Message>${includeMime && item.mime ? `<t:MimeContent CharacterSet="UTF-8">${item.mime.toString('base64')}</t:MimeContent>` : ''}<t:ItemId Id="${item.id}" ChangeKey="${item.changeKey}"/><t:ParentFolderId Id="${item.folderId}"/><t:ItemClass>IPM.Note</t:ItemClass><t:Size>${item.mime?.length ?? 0}</t:Size><t:DateTimeReceived>${item.received}</t:DateTimeReceived><t:Importance>${item.importance}</t:Importance><t:IsDraft>${Boolean(item.isDraft)}</t:IsDraft><t:Flag><t:FlagStatus>${item.flagged ? 'Flagged' : 'NotFlagged'}</t:FlagStatus></t:Flag><t:ConversationId Id="${item.conversationId}"/><t:IsRead>${item.isRead}</t:IsRead></t:Message>`
    }
    if (item.kind === 'note') {
      const attachments = item.attachments?.length ? `<t:Attachments>${item.attachments.map((attachment) => `<t:FileAttachment><t:AttachmentId Id="${attachment.id}"/><t:Name>${escapeXml(attachment.name)}</t:Name><t:ContentType>${escapeXml(attachment.contentType)}</t:ContentType>${attachment.contentId ? `<t:ContentId>${escapeXml(attachment.contentId)}</t:ContentId>` : ''}<t:Size>${attachment.content.length}</t:Size><t:IsInline>${attachment.isInline}</t:IsInline></t:FileAttachment>`).join('')}</t:Attachments>` : ''
      return `<t:Message><t:ItemId Id="${item.id}" ChangeKey="${item.changeKey}"/><t:ParentFolderId Id="${item.folderId}"/>${[...item.props.values()].join('')}${attachments}</t:Message>`
    }
    const tag = item.kind === 'calendar' ? 'CalendarItem' : 'Contact'
    const extras = item.kind === 'calendar'
      ? `${item.props.has('CalendarItemType') ? '' : `<t:CalendarItemType>${item.props.has('Recurrence') ? 'RecurringMaster' : 'Single'}</t:CalendarItemType>`}${item.props.has('MyResponseType') ? '' : '<t:MyResponseType>Organizer</t:MyResponseType>'}`
      : ''
    return `<t:${tag}><t:ItemId Id="${item.id}" ChangeKey="${item.changeKey}"/><t:ParentFolderId Id="${item.folderId}"/>${[...item.props.values()].join('')}${extras}</t:${tag}>`
  }

  private syncItems(element: XmlElement) {
    const folder = this.resolveFolder(child(element, 'SyncFolderId')?.children[0])
    if (!folder) return reply('SyncFolderItems', [fail('SyncFolderItems', 'ErrorFolderNotFound')])
    const since = this.parseState(text(child(element, 'SyncState')).trim() || undefined, `I${folder.id}`)
    if (since === undefined) return reply('SyncFolderItems', [fail('SyncFolderItems', 'ErrorInvalidSyncStateData', 'Synchronization state data is corrupt or otherwise invalid.')])
    const max = Number(text(child(element, 'MaxChangesReturned')) || 512)
    type Change = { seq: number; xml: string }
    const changes: Change[] = []
    for (const item of this.items.values()) {
      if (item.folderId !== folder.id) continue
      if (item.addedSeq > since) changes.push({ seq: item.modifiedSeq, xml: `<t:Create>${this.itemXml(item)}</t:Create>` })
      else if (item.modifiedSeq > since) {
        changes.push({ seq: item.modifiedSeq, xml: item.readOnlyChangeSeq === item.modifiedSeq ? `<t:ReadFlagChange><t:ItemId Id="${item.id}" ChangeKey="${item.changeKey}"/><t:IsRead>${item.isRead}</t:IsRead></t:ReadFlagChange>` : `<t:Update>${this.itemXml(item)}</t:Update>` })
      }
    }
    for (const [id, removed] of this.removed) {
      if (removed.folderId === folder.id && removed.removedSeq > since && removed.addedSeq <= since) changes.push({ seq: removed.removedSeq, xml: `<t:Delete><t:ItemId Id="${id}"/></t:Delete>` })
    }
    changes.sort((a, b) => a.seq - b.seq)
    const page = changes.slice(0, max)
    const last = page.length === changes.length
    const next = last ? this.seq : page[page.length - 1].seq
    return reply('SyncFolderItems', [ok('SyncFolderItems', `<m:SyncState>${this.state(`I${folder.id}`, next)}</m:SyncState><m:IncludesLastItemInRange>${last}</m:IncludesLastItemInRange><m:Changes>${page.map((change) => change.xml).join('')}</m:Changes>`)])
  }

  private getItem(element: XmlElement) {
    const includeMime = text(child(child(element, 'ItemShape'), 'IncludeMimeContent')).trim() === 'true'
    return reply('GetItem', (child(element, 'ItemIds')?.children ?? []).map((id) => {
      const item = this.items.get(id.attributes.Id ?? '')
      return item ? ok('GetItem', `<m:Items>${this.itemXml(item, includeMime)}</m:Items>`) : fail('GetItem', 'ErrorItemNotFound', 'The specified object was not found in the store.')
    }))
  }

  private bump(item: FixtureItem) {
    const seq = ++this.seq
    item.modifiedSeq = seq
    item.changeKey = `ck${seq}`
    item.readOnlyChangeSeq = undefined
  }

  private updateItem(element: XmlElement) {
    const neverOverwrite = element.attributes.ConflictResolution === 'NeverOverwrite'
    return reply('UpdateItem', children(child(element, 'ItemChanges'), 'ItemChange').map((change) => {
      const idElement = change.children[0]
      if (idElement?.name === 'OccurrenceItemId') {
        const master = this.items.get(idElement.attributes.RecurringMasterId ?? '')
        if (!master) return fail('UpdateItem', 'ErrorItemNotFound')
        this.bump(master)
        return ok('UpdateItem', `<m:Items><t:CalendarItem><t:ItemId Id="${master.id}" ChangeKey="${master.changeKey}"/></t:CalendarItem></m:Items>`)
      }
      const item = this.items.get(idElement?.attributes.Id ?? '')
      if (!item) return fail('UpdateItem', 'ErrorItemNotFound', 'The specified object was not found in the store.')
      if (neverOverwrite && idElement.attributes.ChangeKey && idElement.attributes.ChangeKey !== item.changeKey) {
        return fail('UpdateItem', 'ErrorIrresolvableConflict', 'The send or update operation could not be performed because the change key passed in the request does not match the current change key for the item.')
      }
      let readOnly = true
      for (const update of child(change, 'Updates')?.children ?? []) {
        const uri = child(update, 'FieldURI')?.attributes.FieldURI ?? child(update, 'IndexedFieldURI')?.attributes.FieldURI ?? ''
        const value = update.children.find((node) => node.name !== 'FieldURI' && node.name !== 'IndexedFieldURI')?.children[0]
        if (item.kind === 'message') {
          if (uri === 'message:IsRead') item.isRead = text(value).trim() === 'true'
          else { readOnly = false }
          if (uri === 'item:Flag') item.flagged = text(child(value, 'FlagStatus')).trim() === 'Flagged'
          if (uri === 'item:Importance') item.importance = text(value).trim()
          continue
        }
        readOnly = false
        const indexed = child(update, 'IndexedFieldURI')
        if (indexed) {
          const container = uri === 'contacts:EmailAddress' ? 'EmailAddresses' : 'PhoneNumbers'
          const existing = item.props.get(container)
          const entries = new Map<string, string>()
          if (existing) for (const entry of children(parseFragment(existing), 'Entry')) entries.set(entry.attributes.Key ?? '', text(entry))
          if (update.name === 'DeleteItemField') entries.delete(indexed.attributes.FieldIndex ?? '')
          else for (const entry of children(value, 'Entry')) entries.set(entry.attributes.Key ?? '', text(entry))
          if (entries.size) item.props.set(container, `<t:${container}>${[...entries].map(([key, entry]) => `<t:Entry Key="${key}">${escapeXml(entry)}</t:Entry>`).join('')}</t:${container}>`)
          else item.props.delete(container)
          continue
        }
        const name = uri.split(':')[1] ?? ''
        if (update.name === 'DeleteItemField') item.props.delete(name)
        else if (value) item.props.set(value.name, serialize(value))
      }
      this.bump(item)
      if (readOnly && item.kind === 'message') item.readOnlyChangeSeq = item.modifiedSeq
      const tag = item.kind === 'message' || item.kind === 'note' ? 'Message' : item.kind === 'calendar' ? 'CalendarItem' : 'Contact'
      return ok('UpdateItem', `<m:Items><t:${tag}><t:ItemId Id="${item.id}" ChangeKey="${item.changeKey}"/></t:${tag}></m:Items>`)
    }))
  }

  private moveOrCopy(element: XmlElement, operation: 'MoveItem' | 'CopyItem') {
    const target = this.resolveFolder(child(element, 'ToFolderId')?.children[0])
    return reply(operation, (child(element, 'ItemIds')?.children ?? []).map((id) => {
      const item = this.items.get(id.attributes.Id ?? '')
      if (!item || !target) return fail(operation, item ? 'ErrorFolderNotFound' : 'ErrorItemNotFound')
      if (operation === 'MoveItem') {
        const moved = this.moveItem(item.id, target.id)!
        return ok(operation, `<m:Items><t:Message><t:ItemId Id="${moved.id}" ChangeKey="${moved.changeKey}"/></t:Message></m:Items>`)
      }
      const id2 = this.nextId('M')
      const seq = ++this.seq
      this.items.set(id2, { ...item, id: id2, folderId: target.id, addedSeq: seq, modifiedSeq: seq, changeKey: `ck${seq}`, props: new Map(item.props) })
      return ok(operation, `<m:Items><t:Message><t:ItemId Id="${id2}" ChangeKey="ck${seq}"/></t:Message></m:Items>`)
    }))
  }

  private deleteItem(element: XmlElement) {
    return reply('DeleteItem', (child(element, 'ItemIds')?.children ?? []).map((id) => {
      if (id.name === 'OccurrenceItemId') {
        const master = this.items.get(id.attributes.RecurringMasterId ?? '')
        if (!master) return fail('DeleteItem', 'ErrorItemNotFound')
        this.deletedOccurrences.push({ masterId: master.id, instanceIndex: Number(id.attributes.InstanceIndex) })
        this.bump(master)
        return ok('DeleteItem', '')
      }
      const item = this.items.get(id.attributes.Id ?? '')
      if (!item) return fail('DeleteItem', 'ErrorItemNotFound', 'The specified object was not found in the store.')
      if (element.attributes.DeleteType === 'MoveToDeletedItems' && item.kind === 'message') this.moveItem(item.id, this.folder('deleteditems').id)
      else this.removeItem(item.id)
      return ok('DeleteItem', '')
    }))
  }

  // --- Attachments (notes) ---------------------------------------------------------------------

  /** Adds the distinguished Notes folder (IPF.StickyNote); mailboxes without one answer ErrorFolderNotFound. */
  addNotesFolder() {
    const existing = [...this.folders.values()].find((folder) => folder.distinguished === 'notes')
    if (existing) return existing
    const folder = this.addFolder('Notes', 'IPF.StickyNote')
    folder.distinguished = 'notes'
    return folder
  }

  /** Adds a FileAttachment to an item as another client would (bumps its ChangeKey). */
  attach(itemId: string, input: { name: string; contentType: string; content: Buffer; contentId?: string; isInline?: boolean }) {
    const item = this.items.get(itemId)
    if (!item) throw new Error('No such item')
    const attachment: FixtureAttachment = { id: this.nextId('A'), name: input.name, contentType: input.contentType, content: input.content, isInline: Boolean(input.isInline), ...(input.contentId ? { contentId: input.contentId } : {}) }
    item.attachments = [...(item.attachments ?? []), attachment]
    this.bump(item)
    return attachment
  }

  private attachmentFrom(file: XmlElement): FixtureAttachment {
    const contentId = text(child(file, 'ContentId')).trim()
    return {
      id: this.nextId('A'), name: text(child(file, 'Name')), contentType: text(child(file, 'ContentType')) || 'application/octet-stream',
      ...(contentId ? { contentId } : {}), isInline: text(child(file, 'IsInline')).trim() === 'true', content: Buffer.from(text(child(file, 'Content')).replace(/\s+/g, ''), 'base64')
    }
  }

  private findAttachment(id: string) {
    for (const item of this.items.values()) {
      const attachment = item.attachments?.find((entry) => entry.id === id)
      if (attachment) return { item, attachment }
    }
    return undefined
  }

  private getAttachment(element: XmlElement) {
    return reply('GetAttachment', (child(element, 'AttachmentIds')?.children ?? []).map((id) => {
      const found = this.findAttachment(id.attributes.Id ?? '')
      if (!found) return fail('GetAttachment', 'ErrorItemNotFound')
      const { attachment } = found
      return ok('GetAttachment', `<m:Attachments><t:FileAttachment><t:AttachmentId Id="${attachment.id}"/><t:Name>${escapeXml(attachment.name)}</t:Name><t:ContentType>${escapeXml(attachment.contentType)}</t:ContentType>${attachment.contentId ? `<t:ContentId>${escapeXml(attachment.contentId)}</t:ContentId>` : ''}<t:Size>${attachment.content.length}</t:Size><t:IsInline>${attachment.isInline}</t:IsInline><t:Content>${attachment.content.toString('base64')}</t:Content></t:FileAttachment></m:Attachments>`)
    }))
  }

  private createAttachment(element: XmlElement) {
    const parent = child(element, 'ParentItemId')
    const item = this.items.get(parent?.attributes.Id ?? '')
    if (!item) return reply('CreateAttachment', [fail('CreateAttachment', 'ErrorItemNotFound')])
    if (parent?.attributes.ChangeKey && parent.attributes.ChangeKey !== item.changeKey) return reply('CreateAttachment', [fail('CreateAttachment', 'ErrorIrresolvableConflict')])
    const created = children(child(element, 'Attachments'), 'FileAttachment').map((file) => this.attachmentFrom(file))
    item.attachments = [...(item.attachments ?? []), ...created]
    this.bump(item)
    return reply('CreateAttachment', created.map((attachment) => ok('CreateAttachment', `<m:Attachments><t:FileAttachment><t:AttachmentId Id="${attachment.id}" RootItemId="${item.id}" RootItemChangeKey="${item.changeKey}"/></t:FileAttachment></m:Attachments>`)))
  }

  private deleteAttachment(element: XmlElement) {
    return reply('DeleteAttachment', (child(element, 'AttachmentIds')?.children ?? []).map((id) => {
      const found = this.findAttachment(id.attributes.Id ?? '')
      if (!found) return fail('DeleteAttachment', 'ErrorItemNotFound')
      found.item.attachments = found.item.attachments!.filter((attachment) => attachment !== found.attachment)
      this.bump(found.item)
      return ok('DeleteAttachment', `<m:RootItemId RootItemId="${found.item.id}" RootItemChangeKey="${found.item.changeKey}"/>`)
    }))
  }

  private createItem(element: XmlElement) {
    const disposition = element.attributes.MessageDisposition
    const target = this.resolveFolder(child(element, 'SavedItemFolderId')?.children[0])
    return reply('CreateItem', (child(element, 'Items')?.children ?? []).map((spec) => {
      if (spec.name === 'Message' && !child(spec, 'MimeContent')) {
        // A sticky note (ItemClass IPM.StickyNote) saved into a Notes folder.
        if (!target) return fail('CreateItem', 'ErrorFolderNotFound')
        if (!target.canWrite) return fail('CreateItem', 'ErrorAccessDenied', 'Access is denied. Check credentials and try again.')
        const props: Record<string, string> = {}
        for (const property of spec.children) if (property.name !== 'Attachments') props[property.name] = serialize(property)
        const item = this.addItem(target.id, 'note', props)
        item.attachments = children(child(spec, 'Attachments'), 'FileAttachment').map((file) => this.attachmentFrom(file))
        return ok('CreateItem', `<m:Items><t:Message><t:ItemId Id="${item.id}" ChangeKey="${item.changeKey}"/></t:Message></m:Items>`)
      }
      if (spec.name === 'Message') {
        const mime = Buffer.from(text(child(spec, 'MimeContent')).replace(/\s+/g, ''), 'base64')
        const subject = /^Subject: (.*)$/m.exec(mime.toString('utf8'))?.[1]?.trim() ?? '(No subject)'
        if (disposition === 'SendAndSaveCopy' || disposition === 'SendOnly') {
          this.sent.push({ mime, readReceipt: text(child(spec, 'IsReadReceiptRequested')).trim() === 'true', deliveryReceipt: text(child(spec, 'IsDeliveryReceiptRequested')).trim() === 'true' })
          if (disposition === 'SendOnly') return ok('CreateItem', '<m:Items/>')
        }
        const folder = target ?? this.folder(disposition === 'SaveOnly' ? 'drafts' : 'sentitems')
        const item = this.addMessage(folder.id, { subject, isRead: true })
        item.mime = mime
        item.isDraft = disposition === 'SaveOnly'
        return ok('CreateItem', disposition === 'SendAndSaveCopy' ? '<m:Items/>' : `<m:Items><t:Message><t:ItemId Id="${item.id}" ChangeKey="${item.changeKey}"/></t:Message></m:Items>`)
      }
      if (!target) return fail('CreateItem', 'ErrorFolderNotFound')
      if (!target.canWrite) return fail('CreateItem', 'ErrorAccessDenied', 'Access is denied. Check credentials and try again.')
      const props: Record<string, string> = {}
      for (const property of spec.children) props[property.name] = serialize(property)
      const item = this.addItem(target.id, spec.name === 'Contact' ? 'contact' : 'calendar', props)
      return ok('CreateItem', `<m:Items><t:${spec.name}><t:ItemId Id="${item.id}" ChangeKey="${item.changeKey}"/></t:${spec.name}></m:Items>`)
    }))
  }
}

// --- Directory (E41) ----------------------------------------------------------------------------

const directoryMailbox = (entry: FixtureDirectoryEntry, tag = 'Mailbox') =>
  `<t:${tag}><t:Name>${escapeXml(entry.name)}</t:Name><t:EmailAddress>${escapeXml(entry.email)}</t:EmailAddress><t:RoutingType>SMTP</t:RoutingType><t:MailboxType>${entry.mailboxType ?? 'Mailbox'}</t:MailboxType></t:${tag}>`

const directoryContact = (entry: FixtureDirectoryEntry) => `<t:Contact><t:DisplayName>${escapeXml(entry.name)}</t:DisplayName>` +
  `${entry.company ? `<t:CompanyName>${escapeXml(entry.company)}</t:CompanyName>` : ''}` +
  `${entry.phone ? `<t:PhoneNumbers><t:Entry Key="BusinessPhone">${escapeXml(entry.phone)}</t:Entry></t:PhoneNumbers>` : ''}` +
  `${entry.title ? `<t:JobTitle>${escapeXml(entry.title)}</t:JobTitle>` : ''}${entry.department ? `<t:Department>${escapeXml(entry.department)}</t:Department>` : ''}` +
  `${entry.office ? `<t:OfficeLocation>${escapeXml(entry.office)}</t:OfficeLocation>` : ''}<t:ContactSource>ActiveDirectory</t:ContactSource></t:Contact>`

/** ResolveNames-style ambiguous name resolution: any word of the name or the address starts with the entry. */
const resolves = (entry: FixtureDirectoryEntry, term: string) => {
  const lower = term.toLowerCase()
  return entry.email.toLowerCase().startsWith(lower) || entry.name.toLowerCase().startsWith(lower) || entry.name.toLowerCase().split(/\s+/).some((word) => word.startsWith(lower))
}

function directoryHandlers(server: EwsFixtureServer): Record<string, (element: XmlElement) => string> {
  const find = (email: string) => server.directory.find((entry) => entry.email.toLowerCase() === email.toLowerCase())
  return {
    ResolveNames: (element) => {
      const term = text(child(element, 'UnresolvedEntry')).trim()
      const found = server.directory.filter((entry) => resolves(entry, term)).slice(0, 100)
      if (!found.length) return reply('ResolveNames', [fail('ResolveNames', 'ErrorNameResolutionNoResults', 'No results were found.')])
      const full = element.attributes.ReturnFullContactData === 'true'
      const set = `<m:ResolutionSet TotalItemsInView="${found.length}" IncludesLastItemInRange="true">${found.map((entry) => `<t:Resolution>${directoryMailbox(entry)}${full ? directoryContact(entry) : ''}</t:Resolution>`).join('')}</m:ResolutionSet>`
      if (found.length === 1) return reply('ResolveNames', [ok('ResolveNames', set)])
      return reply('ResolveNames', [`<m:ResolveNamesResponseMessage ResponseClass="Warning"><m:MessageText>Multiple results were found.</m:MessageText><m:ResponseCode>ErrorNameResolutionMultipleResults</m:ResponseCode><m:DescriptiveLinkKey>0</m:DescriptiveLinkKey>${set}</m:ResolveNamesResponseMessage>`])
    },
    ExpandDL: (element) => {
      const email = text(child(child(element, 'Mailbox'), 'EmailAddress')).trim()
      const group = find(email)
      if (!group?.members) return reply('ExpandDL', [fail('ExpandDL', 'ErrorNameResolutionNoResults', 'No results were found.')])
      const members = group.members.map(find).filter((entry): entry is FixtureDirectoryEntry => Boolean(entry))
      return reply('ExpandDL', [ok('ExpandDL', `<m:DLExpansion TotalItemsInView="${members.length}" IncludesLastItemInRange="true">${members.map((entry) => directoryMailbox(entry)).join('')}</m:DLExpansion>`)])
    },
    GetRoomLists: () => `<m:GetRoomListsResponse ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode><m:RoomLists>${[...server.roomLists].map(([email, list]) => directoryMailbox({ name: list.name, email, mailboxType: 'PublicDL' }, 'Address')).join('')}</m:RoomLists></m:GetRoomListsResponse>`,
    GetRooms: (element) => {
      const email = text(child(child(element, 'RoomList'), 'EmailAddress')).trim().toLowerCase()
      const list = [...server.roomLists].find(([address]) => address.toLowerCase() === email)?.[1]
      if (!list) return `<m:GetRoomsResponse ResponseClass="Error"><m:MessageText>No results were found.</m:MessageText><m:ResponseCode>ErrorNameResolutionNoResults</m:ResponseCode><m:DescriptiveLinkKey>0</m:DescriptiveLinkKey></m:GetRoomsResponse>`
      const rooms = list.rooms.map(find).filter((entry): entry is FixtureDirectoryEntry => Boolean(entry))
      return `<m:GetRoomsResponse ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode><m:Rooms>${rooms.map((room) => `<t:Room>${directoryMailbox(room, 'Id')}</t:Room>`).join('')}</m:Rooms></m:GetRoomsResponse>`
    },
    FindPeople: (element) => {
      const query = text(child(element, 'QueryString')).trim()
      if (!query && server.findPeopleNeedsQuery) return `<m:FindPeopleResponse ResponseClass="Error"><m:MessageText>A query string is required to search the directory.</m:MessageText><m:ResponseCode>ErrorInvalidArgument</m:ResponseCode><m:DescriptiveLinkKey>0</m:DescriptiveLinkKey></m:FindPeopleResponse>`
      const view = child(element, 'IndexedPageItemView')
      const offset = Number(view?.attributes.Offset ?? 0)
      const max = Number(view?.attributes.MaxEntriesReturned ?? 100)
      const all = server.directory.filter((entry) => !query || resolves(entry, query))
      const page = all.slice(offset, offset + max)
      const persona = (entry: FixtureDirectoryEntry, index: number) => `<t:Persona><t:PersonaId Id="PERSONA${offset + index}"/><t:PersonaType>${entry.personaType ?? (entry.mailboxType === 'PublicDL' ? 'DistributionList' : 'Person')}</t:PersonaType>` +
        `<t:DisplayName>${escapeXml(entry.name)}</t:DisplayName>${directoryMailbox(entry, 'EmailAddress')}${entry.title ? `<t:Title>${escapeXml(entry.title)}</t:Title>` : ''}` +
        `${entry.department ? `<t:Department>${escapeXml(entry.department)}</t:Department>` : ''}${entry.company ? `<t:CompanyName>${escapeXml(entry.company)}</t:CompanyName>` : ''}</t:Persona>`
      return `<m:FindPeopleResponse ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode><m:People>${page.map(persona).join('')}</m:People><m:TotalNumberOfPeopleInView>${all.length}</m:TotalNumberOfPeopleInView><m:FirstMatchingRowIndex>0</m:FirstMatchingRowIndex><m:FirstLoadedRowIndex>${offset}</m:FirstLoadedRowIndex></m:FindPeopleResponse>`
    }
  }
}

/** Serialized `t:` elements for fixture calendar items. */
export const calendarProps = (input: { subject: string; start: string; end: string; location?: string; body?: string; uid?: string; recurrence?: string; attendees?: string[]; extra?: Record<string, string> }) => ({
  Subject: `<t:Subject>${escapeXml(input.subject)}</t:Subject>`,
  ...(input.body ? { Body: `<t:Body BodyType="Text">${escapeXml(input.body)}</t:Body>` } : {}),
  ReminderIsSet: '<t:ReminderIsSet>true</t:ReminderIsSet>',
  ReminderMinutesBeforeStart: '<t:ReminderMinutesBeforeStart>15</t:ReminderMinutesBeforeStart>',
  Start: `<t:Start>${input.start}</t:Start>`,
  End: `<t:End>${input.end}</t:End>`,
  IsAllDayEvent: '<t:IsAllDayEvent>false</t:IsAllDayEvent>',
  ...(input.location ? { Location: `<t:Location>${escapeXml(input.location)}</t:Location>` } : {}),
  UID: `<t:UID>${input.uid ?? randomBytes(8).toString('hex')}</t:UID>`,
  ...(input.attendees?.length ? { RequiredAttendees: `<t:RequiredAttendees>${input.attendees.map((email) => `<t:Attendee><t:Mailbox><t:EmailAddress>${email}</t:EmailAddress></t:Mailbox><t:ResponseType>Accept</t:ResponseType></t:Attendee>`).join('')}</t:RequiredAttendees>`, IsMeeting: '<t:IsMeeting>true</t:IsMeeting>' } : {}),
  ...(input.recurrence ? { Recurrence: input.recurrence } : {}),
  StartTimeZoneId: '<t:StartTimeZoneId>UTC</t:StartTimeZoneId>',
  ...input.extra
})

export const contactProps = (input: { name: string; given?: string; surname?: string; email?: string; phone?: string; company?: string }) => ({
  DisplayName: `<t:DisplayName>${escapeXml(input.name)}</t:DisplayName>`,
  ...(input.given ? { GivenName: `<t:GivenName>${escapeXml(input.given)}</t:GivenName>` } : {}),
  ...(input.company ? { CompanyName: `<t:CompanyName>${escapeXml(input.company)}</t:CompanyName>` } : {}),
  ...(input.email ? { EmailAddresses: `<t:EmailAddresses><t:Entry Key="EmailAddress1">${escapeXml(input.email)}</t:Entry></t:EmailAddresses>` } : {}),
  ...(input.phone ? { PhoneNumbers: `<t:PhoneNumbers><t:Entry Key="MobilePhone">${escapeXml(input.phone)}</t:Entry></t:PhoneNumbers>` } : {}),
  ...(input.surname ? { Surname: `<t:Surname>${escapeXml(input.surname)}</t:Surname>` } : {})
})

/** Serialized `t:` elements for a fixture sticky note. `extra` keeps unmodeled properties (e.g. an ExtendedProperty for the note color). */
export const noteProps = (input: { subject: string; body?: string; html?: boolean; categories?: string[]; extra?: Record<string, string> }) => ({
  ItemClass: '<t:ItemClass>IPM.StickyNote</t:ItemClass>',
  Subject: `<t:Subject>${escapeXml(input.subject)}</t:Subject>`,
  Body: `<t:Body BodyType="${input.html ? 'HTML' : 'Text'}">${escapeXml(input.body ?? '')}</t:Body>`,
  ...(input.categories?.length ? { Categories: `<t:Categories>${input.categories.map((value) => `<t:String>${escapeXml(value)}</t:String>`).join('')}</t:Categories>` } : {}),
  ...input.extra
})
