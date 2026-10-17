import { createHash } from 'node:crypto'
import type {
  MailAccountSummary,
  MailActionKind,
  MailDraftInput,
  MailDraftRecord,
  MailDraftResult,
  MailFolder,
  MailLabel,
  MailMessageDetail,
  MailPage,
  MailThreadDetail,
  PendingOperation
} from '../../src/mail-types'
import type { MessageWindowRequest } from '../../src/types'
import type { McpSettings, McpToolDescriptor } from '../../src/mcp-types'
import { parseMailSearchQuery } from '../../src/lib/mail-search-query'
import type { MailWorkerCommand, MailWorkerResult } from '../mail-protocol'
import type { ChannelErrorCode } from './channel'
import type { McpContent } from './protocol'
import { MCP_ATTACHMENT_DEFAULT_BYTES, MCP_BODY_DEFAULT_CHARS, MCP_FOLDERS, MCP_TOOLS, capabilityEnabled, protocolTool, toolByName, validateToolArguments } from './tools'
import type { McpAutomationStore } from './store'

export class McpToolError extends Error {
  constructor(readonly code: ChannelErrorCode, message: string, readonly details?: string[]) { super(message) }
}

export interface McpToolResult {
  result: Record<string, unknown>
  content?: McpContent[]
}

export interface McpServiceDeps {
  request<T extends MailWorkerResult = void>(command: MailWorkerCommand): Promise<T>
  settings(): McpSettings
  isLocked(): boolean
  /** The same draft validation the renderer's IPC uses. */
  validateDraft(input: MailDraftInput): MailDraftInput
  /** Lets a stored draft keep attachments it already references. */
  approveAttachmentPaths(paths: string[]): void
  /** The renderer's send path: validation, OpenPGP/S/MIME checks, then the Outbox queue. */
  sendDraft(input: MailDraftInput): Promise<MailDraftResult>
  openMessage(input: MessageWindowRequest): void
  readAttachment(accountId: string, messageId: string, attachmentId: string): Promise<Buffer>
  sends: Pick<McpAutomationStore, 'reserveSend' | 'completeSend' | 'releaseSend'>
}

const EDITABLE_DRAFT = new Set<MailDraftResult['status']>(['local', 'syncing', 'synced', 'failed'])
const FOLDER_DESCRIPTIONS: Record<(typeof MCP_FOLDERS)[number], string> = {
  inbox: 'Inbox', starred: 'Flagged (starred)', important: 'Important', sent: 'Sent', drafts: 'Drafts', snoozed: 'Snoozed',
  archive: 'Archive (not in Inbox, Sent, Drafts, Spam, or Trash)', spam: 'Spam / Junk', trash: 'Trash', all: 'All mail except Spam and Trash'
}

type Args = Record<string, unknown>
const text = (args: Args, key: string) => typeof args[key] === 'string' ? args[key] as string : undefined
const bool = (args: Args, key: string) => typeof args[key] === 'boolean' ? args[key] as boolean : undefined
const int = (args: Args, key: string, fallback: number) => typeof args[key] === 'number' ? args[key] as number : fallback
const list = (args: Args, key: string) => Array.isArray(args[key]) ? [...args[key] as string[]] : undefined

function truncate(value: string, maximum: number) {
  return value.length > maximum ? { text: value.slice(0, maximum), truncated: true, length: value.length } : { text: value, truncated: false, length: value.length }
}

/** Executes MCP tool calls through Aerio's existing mail service boundaries. */
export class McpToolService {
  constructor(private readonly deps: McpServiceDeps) {}

  /** Tool listing and Settings descriptors for the current capability choices. */
  descriptors(settings = this.deps.settings()): McpToolDescriptor[] {
    return MCP_TOOLS.map((tool) => ({ name: tool.name, title: tool.title, capability: tool.capability, effect: tool.effect, enabled: settings.enabled && capabilityEnabled(tool.capability, settings.capabilities) }))
  }

  listTools() {
    const settings = this.deps.settings()
    if (!settings.enabled) throw new McpToolError('disabled', 'External automation is turned off in Aerio Settings.')
    return MCP_TOOLS.filter((tool) => capabilityEnabled(tool.capability, settings.capabilities)).map(protocolTool)
  }

  async call(clientId: string, name: unknown, rawArgs: unknown): Promise<McpToolResult> {
    const tool = typeof name === 'string' ? toolByName(name) : undefined
    if (!tool) throw new McpToolError('unknown-tool', `Unknown tool: ${typeof name === 'string' ? name.slice(0, 80) : ''}`)
    const settings = this.deps.settings()
    if (!settings.enabled) throw new McpToolError('disabled', 'External automation is turned off in Aerio Settings.')
    // A locked app answers nothing, including whether an id exists.
    if (this.deps.isLocked()) throw new McpToolError('locked', 'Aerio is locked. Unlock Aerio on this computer, then try again.')
    if (!capabilityEnabled(tool.capability, settings.capabilities)) {
      throw new McpToolError('capability-disabled', `${tool.title} needs the ${tool.capability} capability, which is turned off in Aerio Settings › External automation (MCP).`)
    }
    const problems = validateToolArguments(tool.inputSchema, rawArgs)
    if (problems.length) throw new McpToolError('invalid-arguments', `Invalid arguments for ${tool.name}: ${problems.join('; ')}`, problems)
    const args = (rawArgs ?? {}) as Args
    const scope = settings.accountScope
    switch (tool.name) {
      case 'list_accounts': return { result: { accounts: (await this.accounts(scope)).map((account) => ({
        id: account.id, provider: account.provider, email: account.email, displayName: account.displayName,
        status: account.status, archived: account.archived, ...(account.lastSyncAt ? { lastSyncAt: account.lastSyncAt } : {})
      })) } }
      case 'list_folders': return this.listFolders(scope, text(args, 'accountId'))
      case 'search_mail': return this.search(scope, args)
      case 'get_conversation': {
        const thread = await this.thread(scope, text(args, 'accountId')!, text(args, 'conversationId')!)
        return { result: { accountId: thread.accountId, conversationId: thread.id, subject: thread.subject, messages: thread.messages.map((message) => this.message(message, args)) } }
      }
      case 'get_message': {
        const message = await this.findMessage(scope, args)
        return { result: { accountId: message.accountId, ...this.message(message, args) } }
      }
      case 'get_attachment': return this.attachment(scope, args)
      case 'open_in_aerio': {
        const thread = await this.thread(scope, text(args, 'accountId')!, text(args, 'conversationId')!)
        const messageId = text(args, 'messageId')
        if (messageId && !thread.messages.some((message) => message.id === messageId)) throw new McpToolError('not-found', 'That message is not in this conversation.')
        this.deps.openMessage({ source: 'connected', accountId: thread.accountId, threadId: thread.id, ...(messageId ? { messageId } : {}), title: thread.subject || 'Message' })
        return { result: { opened: true, accountId: thread.accountId, conversationId: thread.id, ...(messageId ? { messageId } : {}) } }
      }
      case 'mark_read': return this.action(scope, args, bool(args, 'read') === false ? 'unread' : 'read')
      case 'flag': return this.action(scope, args, bool(args, 'flagged') === false ? 'unstar' : 'star')
      case 'archive': return this.action(scope, args, 'archive')
      case 'trash_message': return this.action(scope, args, 'trash')
      case 'move': {
        const accountId = (await this.account(scope, text(args, 'accountId')!)).id
        const folderId = text(args, 'folderId')!
        const labels = await this.deps.request<MailLabel[]>({ type: 'labels:list', payload: { accountIds: [accountId] } })
        if (!labels.some((label) => label.id === folderId)) throw new McpToolError('not-found', 'That folder does not exist in this account. Use list_folders.')
        return this.action(scope, args, 'move', folderId)
      }
      case 'create_draft': return this.createDraft(scope, args)
      case 'update_draft': return this.updateDraft(scope, args)
      case 'send_draft': return this.sendDraft(clientId, scope, args)
    }
    throw new McpToolError('unknown-tool', `Unknown tool: ${tool.name}`)
  }

  private async accounts(scope: McpSettings['accountScope']) {
    const accounts = await this.deps.request<MailAccountSummary[]>({ type: 'accounts:list' })
    return scope === 'all' ? accounts : accounts.filter((account) => scope.includes(account.id))
  }

  private async account(scope: McpSettings['accountScope'], accountId: string) {
    const account = (await this.accounts(scope)).find((candidate) => candidate.id === accountId)
    // Out-of-scope and unknown accounts look the same to a client.
    if (!account) throw new McpToolError('account-not-allowed', 'That account is not available to automation clients.')
    return account
  }

  private async listFolders(scope: McpSettings['accountScope'], accountId?: string) {
    const accountIds = accountId ? [(await this.account(scope, accountId)).id] : (await this.accounts(scope)).map((account) => account.id)
    const labels = accountIds.length ? await this.deps.request<MailLabel[]>({ type: 'labels:list', payload: { accountIds } }) : []
    return { result: {
      views: MCP_FOLDERS.map((id) => ({ id, name: FOLDER_DESCRIPTIONS[id] })),
      folders: labels.filter((label) => accountIds.includes(label.accountId)).map((label) => ({
        accountId: label.accountId, id: label.id, name: label.name, type: label.type, ...(label.parentId ? { parentId: label.parentId } : {})
      }))
    } }
  }

  private async search(scope: McpSettings['accountScope'], args: Args) {
    const query = text(args, 'query')?.trim() ?? ''
    if (query) {
      const parsed = parseMailSearchQuery(query)
      if (!parsed.ok) throw new McpToolError('invalid-arguments', `The search is invalid: ${parsed.error}`, [parsed.error])
    }
    const accountId = text(args, 'accountId')
    const folderId = text(args, 'folderId')
    if (folderId && !accountId) throw new McpToolError('invalid-arguments', 'folderId requires accountId', ['folderId requires accountId'])
    const accountIds = accountId ? [(await this.account(scope, accountId)).id] : (await this.accounts(scope)).map((account) => account.id)
    const folder = (text(args, 'folder') ?? (query || folderId ? 'all' : 'inbox')) as MailFolder
    const filters = {
      ...(bool(args, 'unread') !== undefined ? { unread: bool(args, 'unread') } : {}),
      ...(bool(args, 'flagged') !== undefined ? { starred: bool(args, 'flagged') } : {}),
      ...(bool(args, 'hasAttachments') !== undefined ? { hasAttachments: bool(args, 'hasAttachments') } : {}),
      ...(text(args, 'dateFrom') ? { dateFrom: text(args, 'dateFrom') } : {}),
      ...(text(args, 'dateTo') ? { dateTo: text(args, 'dateTo') } : {})
    }
    // A cursor is only valid for the search that produced it.
    const fingerprint = createHash('sha256').update(JSON.stringify({ query, accountIds, folder, folderId, filters })).digest('base64url').slice(0, 16)
    let cursor: string | undefined
    const rawCursor = text(args, 'cursor')
    if (rawCursor) {
      try {
        const value = JSON.parse(Buffer.from(rawCursor, 'base64url').toString('utf8')) as { f?: unknown; c?: unknown }
        if (value.f !== fingerprint || typeof value.c !== 'string' || !value.c) throw new Error('mismatch')
        cursor = value.c
      } catch {
        throw new McpToolError('invalid-arguments', 'The cursor does not belong to this search. Repeat the search without a cursor.', ['cursor is invalid'])
      }
    }
    if (!accountIds.length) return { result: { conversations: [], total: 0 } }
    const page = await this.deps.request<MailPage>({ type: 'mail:list', payload: {
      accountIds, folder, ...(folderId ? { labelId: folderId } : {}), ...(query ? { search: query } : {}),
      ...(Object.keys(filters).length ? { filters } : {}), ...(cursor ? { cursor } : {}), pageSize: int(args, 'pageSize', 20)
    } })
    return { result: {
      conversations: page.items.filter((item) => accountIds.includes(item.accountId)).map((item) => ({
        accountId: item.accountId, conversationId: item.id, subject: item.subject, participants: item.participants, from: item.senderEmail,
        snippet: item.snippet, lastDate: item.lastDate, unread: item.unread, flagged: item.starred, important: item.important,
        hasAttachments: item.hasAttachments, messageCount: item.messageCount, folderIds: item.labelIds
      })),
      total: page.total,
      ...(page.nextCursor ? { nextCursor: Buffer.from(JSON.stringify({ f: fingerprint, c: page.nextCursor })).toString('base64url') } : {})
    } }
  }

  private async thread(scope: McpSettings['accountScope'], accountId: string, conversationId: string) {
    await this.account(scope, accountId)
    try {
      return await this.deps.request<MailThreadDetail>({ type: 'mail:thread', payload: { accountId, threadId: conversationId, allowRemoteImages: false } })
    } catch (error) {
      if (error instanceof Error && /not found/i.test(error.message)) throw new McpToolError('not-found', 'That conversation was not found.')
      throw error
    }
  }

  private async findMessage(scope: McpSettings['accountScope'], args: Args) {
    const thread = await this.thread(scope, text(args, 'accountId')!, text(args, 'conversationId')!)
    const message = thread.messages.find((candidate) => candidate.id === text(args, 'messageId'))
    if (!message) throw new McpToolError('not-found', 'That message is not in this conversation.')
    return message
  }

  private message(message: MailMessageDetail, args: Args) {
    const maximum = int(args, 'maxBodyChars', MCP_BODY_DEFAULT_CHARS)
    return {
      messageId: message.id,
      conversationId: message.threadId,
      from: { name: message.fromName, email: message.fromEmail },
      to: message.to,
      cc: message.cc,
      subject: message.subject,
      date: message.date,
      folderIds: message.labelIds,
      body: truncate(message.text ?? '', maximum),
      ...(bool(args, 'includeHtml') ? { html: truncate(message.sanitizedHtml ?? '', maximum) } : {}),
      attachments: message.attachments.map((attachment) => ({
        attachmentId: attachment.id, filename: attachment.filename, mimeType: attachment.mimeType, size: attachment.size, inline: Boolean(attachment.contentId)
      }))
    }
  }

  private async attachment(scope: McpSettings['accountScope'], args: Args): Promise<McpToolResult> {
    const message = await this.findMessage(scope, args)
    const attachment = message.attachments.find((candidate) => candidate.id === text(args, 'attachmentId'))
    if (!attachment) throw new McpToolError('not-found', 'That attachment is not on this message.')
    const maximum = int(args, 'maxBytes', MCP_ATTACHMENT_DEFAULT_BYTES)
    const tooLarge = (size: number) => new McpToolError('too-large', `The attachment is ${size.toLocaleString('en-US')} bytes, over the ${maximum.toLocaleString('en-US')}-byte limit. Raise maxBytes (up to 10 MB) or open it in Aerio.`)
    if (attachment.size > maximum) throw tooLarge(attachment.size)
    const bytes = await this.deps.readAttachment(message.accountId, message.id, attachment.id)
    if (bytes.length > maximum) throw tooLarge(bytes.length)
    const data = bytes.toString('base64')
    const metadata = { accountId: message.accountId, conversationId: message.threadId, messageId: message.id, attachmentId: attachment.id, filename: attachment.filename, mimeType: attachment.mimeType, size: bytes.length }
    const uri = `aerio://attachment/${[message.accountId, message.id, attachment.id].map(encodeURIComponent).join('/')}`
    return {
      result: { ...metadata, encoding: 'base64', data },
      content: [
        { type: 'text', text: JSON.stringify(metadata, null, 2) },
        attachment.mimeType.startsWith('image/') ? { type: 'image', data, mimeType: attachment.mimeType } : { type: 'resource', resource: { uri, mimeType: attachment.mimeType || 'application/octet-stream', blob: data } }
      ]
    }
  }

  private async action(scope: McpSettings['accountScope'], args: Args, action: MailActionKind, labelId?: string) {
    const accountId = (await this.account(scope, text(args, 'accountId')!)).id
    const conversationIds = list(args, 'conversationIds')!
    try {
      const operation = await this.deps.request<PendingOperation>({ type: 'mail:action', payload: { accountId, threadIds: conversationIds, action, ...(labelId ? { labelId } : {}) } })
      return { result: { operationId: operation.id, action, status: operation.status, conversationIds, ...(operation.undoUntil ? { undoUntil: operation.undoUntil } : {}) } }
    } catch (error) {
      if (error instanceof Error && /was not found/i.test(error.message)) throw new McpToolError('not-found', 'A conversation was not found in this account.')
      throw error
    }
  }

  private async draft(scope: McpSettings['accountScope'], draftId: string) {
    const draft = await this.deps.request<MailDraftRecord | undefined>({ type: 'drafts:get', payload: { id: draftId } })
    const allowed = draft && (scope === 'all' || scope.includes(draft.accountId)) && (await this.accounts(scope)).some((account) => account.id === draft.accountId)
    if (!draft || !allowed) throw new McpToolError('not-found', 'That draft was not found.')
    this.deps.approveAttachmentPaths(draft.attachmentPaths)
    return draft
  }

  private draftInput(record: MailDraftRecord): MailDraftInput {
    const { status: _status, updatedAt, deliveryAt: _deliveryAt, undoUntil: _undoUntil, error: _error, remoteDraftId: _remoteDraftId, remoteRevision: _remoteRevision, ...rest } = record
    return { ...rest, id: record.id, expectedUpdatedAt: updatedAt }
  }

  private async saveDraft(input: MailDraftInput) {
    try {
      const result = await this.deps.request<MailDraftResult>({ type: 'drafts:save', payload: this.deps.validateDraft(input) })
      return { result: { draftId: result.id, status: result.status, updatedAt: result.updatedAt } }
    } catch (error) {
      if (error instanceof Error && /changed after it was opened/i.test(error.message)) throw new McpToolError('conflict', 'The draft changed while it was being updated. Read it again and retry.')
      throw error
    }
  }

  private async createDraft(scope: McpSettings['accountScope'], args: Args) {
    const account = await this.account(scope, text(args, 'accountId')!)
    if (account.archived) throw new McpToolError('failed', 'Reconnect this account in Aerio before writing drafts.')
    const input: MailDraftInput = {
      accountId: account.id, to: list(args, 'to') ?? [], cc: list(args, 'cc') ?? [], bcc: list(args, 'bcc') ?? [],
      subject: text(args, 'subject') ?? '', text: text(args, 'text') ?? '', ...(text(args, 'html') !== undefined ? { html: text(args, 'html') } : {}), attachmentPaths: []
    }
    const replyTo = text(args, 'replyToConversationId')
    if (replyTo) {
      const thread = await this.thread(scope, account.id, replyTo)
      const latest = thread.messages.at(-1)
      input.threadId = thread.id
      if (latest?.messageIdHeader) {
        input.inReplyTo = latest.messageIdHeader
        input.references = [...(latest.references ?? []), latest.messageIdHeader].slice(-50)
      }
    }
    return this.saveDraft(input)
  }

  private async updateDraft(scope: McpSettings['accountScope'], args: Args) {
    const record = await this.draft(scope, text(args, 'draftId')!)
    if (!EDITABLE_DRAFT.has(record.status)) throw new McpToolError('already-sent', `This draft is ${record.status} and can no longer be edited.`)
    const input = this.draftInput(record)
    for (const key of ['to', 'cc', 'bcc'] as const) { const value = list(args, key); if (value) input[key] = value }
    for (const key of ['subject', 'text', 'html'] as const) { const value = text(args, key); if (value !== undefined) input[key] = value }
    return this.saveDraft(input)
  }

  private async sendDraft(clientId: string, scope: McpSettings['accountScope'], args: Args) {
    const draftId = text(args, 'draftId')!
    const key = text(args, 'idempotencyKey')!
    const record = await this.draft(scope, draftId)
    const reservation = this.deps.sends.reserveSend(clientId, key, draftId)
    if (reservation.state !== 'reserved') {
      if (reservation.draftId !== draftId) throw new McpToolError('conflict', 'This idempotency key was already used for a different draft. Use a new key for a new send.')
      if (reservation.state === 'in-progress') throw new McpToolError('conflict', 'A send with this idempotency key is already in progress. Check the draft in Aerio before retrying with a new key.')
      return { result: { ...(reservation.result as Record<string, unknown>), duplicate: true } }
    }
    if (!EDITABLE_DRAFT.has(record.status)) {
      this.deps.sends.releaseSend(clientId, key)
      throw new McpToolError('already-sent', `This draft is already ${record.status}; it was not sent again.`)
    }
    let result: MailDraftResult
    try {
      result = await this.deps.sendDraft(this.draftInput(record))
    } catch (error) {
      // Nothing was queued, so the same key may be retried after fixing the draft.
      this.deps.sends.releaseSend(clientId, key)
      throw error
    }
    const summary = { draftId: result.id, status: result.status, ...(result.deliveryAt ? { deliveryAt: result.deliveryAt } : {}), ...(result.undoUntil ? { undoUntil: result.undoUntil } : {}) }
    this.deps.sends.completeSend(clientId, key, summary)
    return { result: { ...summary, duplicate: false } }
  }
}
