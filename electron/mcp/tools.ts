import type { McpCapability, McpCapabilitySettings } from '../../src/mcp-types'

/** The subset of JSON Schema (2020-12) Aerio's tool inputs use; `validateToolArguments` enforces all of it. */
export type JsonSchema =
  | { type: 'object'; properties: Record<string, JsonSchema>; required?: string[]; additionalProperties?: false; description?: string }
  | { type: 'string'; minLength?: number; maxLength?: number; enum?: string[]; format?: 'date' | 'email'; description?: string }
  | { type: 'integer'; minimum?: number; maximum?: number; default?: number; description?: string }
  | { type: 'boolean'; default?: boolean; description?: string }
  | { type: 'array'; items: JsonSchema; minItems?: number; maxItems?: number; uniqueItems?: boolean; description?: string }

export interface McpToolAnnotations {
  title: string
  readOnlyHint: boolean
  destructiveHint: boolean
  idempotentHint: boolean
  openWorldHint: boolean
}

export interface McpToolDefinition {
  name: string
  title: string
  description: string
  capability: McpCapability
  effect: string
  inputSchema: JsonSchema & { type: 'object' }
  annotations: McpToolAnnotations
}

export const MCP_FOLDERS = ['inbox', 'starred', 'important', 'sent', 'drafts', 'snoozed', 'archive', 'spam', 'trash', 'all'] as const
export const MCP_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024
export const MCP_ATTACHMENT_DEFAULT_BYTES = 5 * 1024 * 1024
export const MCP_BODY_DEFAULT_CHARS = 20_000
export const MCP_BODY_MAX_CHARS = 200_000

const id = (description: string): JsonSchema => ({ type: 'string', minLength: 1, maxLength: 500, description })
const accountId = id('Account id from list_accounts.')
const conversationId = id('Conversation id from search_mail.')
const messageId = id('Message id from get_conversation.')
const conversationIds: JsonSchema = { type: 'array', items: conversationId, minItems: 1, maxItems: 100, uniqueItems: true, description: 'Up to 100 conversation ids in the same account.' }
const addresses = (description: string): JsonSchema => ({ type: 'array', items: { type: 'string', minLength: 1, maxLength: 500 }, maxItems: 100, description })
const bodyChars: JsonSchema = { type: 'integer', minimum: 0, maximum: MCP_BODY_MAX_CHARS, default: MCP_BODY_DEFAULT_CHARS, description: 'Maximum characters of plain-text body per message; longer bodies are truncated and marked.' }
const includeHtml: JsonSchema = { type: 'boolean', default: false, description: 'Also return the sanitized HTML body (remote content stays blocked).' }
const object = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema & { type: 'object' } =>
  ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false })

const read = (title: string, idempotent = true): McpToolAnnotations => ({ title, readOnlyHint: true, destructiveHint: false, idempotentHint: idempotent, openWorldHint: false })
const change = (title: string, destructive: boolean, idempotent: boolean, openWorld = false): McpToolAnnotations => ({ title, readOnlyHint: false, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: openWorld })

/** Every tool the bridge can expose. Capabilities that are off are removed from tools/list and refused on call. */
export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'list_accounts', title: 'List accounts', capability: 'read',
    description: 'List the mail accounts this client may access, with their provider and sync status.',
    effect: 'Reads account names, addresses, providers, and sync status.',
    inputSchema: object({}), annotations: read('List accounts')
  },
  {
    name: 'list_folders', title: 'List folders', capability: 'read',
    description: 'List mailbox views (inbox, sent, archive, …) and the provider folders or labels of the allowed accounts. Use a folder id with search_mail or move.',
    effect: 'Reads folder and label names.',
    inputSchema: object({ accountId: { ...accountId, description: 'Limit to one account. Omit for all allowed accounts.' } as JsonSchema }), annotations: read('List folders')
  },
  {
    name: 'search_mail', title: 'Search mail', capability: 'read',
    description: 'Search the offline mail index with Aerio\'s search syntax (words, "phrases", OR, NOT/-, parentheses, from:, to:, cc:, subject:, body:, attachment:). Returns conversations newest first; pass nextCursor back as cursor for the next page.',
    effect: 'Reads conversation subjects, participants, snippets, and flags.',
    inputSchema: object({
      query: { type: 'string', maxLength: 1_000, description: 'Search text in Aerio search syntax. Omit to list the folder.' },
      accountId: { ...accountId, description: 'Limit to one account. Omit for all allowed accounts.' } as JsonSchema,
      folder: { type: 'string', enum: [...MCP_FOLDERS], description: 'Mailbox view. Defaults to "all" when query is set, otherwise "inbox".' },
      folderId: id('Provider folder or label id from list_folders (requires accountId).'),
      unread: { type: 'boolean', description: 'Only unread (true) or read (false) conversations.' },
      flagged: { type: 'boolean', description: 'Only flagged/starred (true) or unflagged (false) conversations.' },
      hasAttachments: { type: 'boolean', description: 'Only conversations with (true) or without (false) attachments.' },
      dateFrom: { type: 'string', format: 'date', minLength: 10, maxLength: 10, description: 'Latest message on or after this date (YYYY-MM-DD).' },
      dateTo: { type: 'string', format: 'date', minLength: 10, maxLength: 10, description: 'Latest message on or before this date (YYYY-MM-DD).' },
      pageSize: { type: 'integer', minimum: 1, maximum: 50, default: 20, description: 'Conversations per page.' },
      cursor: { type: 'string', minLength: 1, maxLength: 2_000, description: 'nextCursor from the previous page.' }
    }), annotations: read('Search mail')
  },
  {
    name: 'get_conversation', title: 'Read conversation', capability: 'read',
    description: 'Read every message in a conversation: headers, plain-text bodies, and attachment metadata.',
    effect: 'Reads message headers, bodies, and attachment names.',
    inputSchema: object({ accountId, conversationId, maxBodyChars: bodyChars, includeHtml }, ['accountId', 'conversationId']), annotations: read('Read conversation')
  },
  {
    name: 'get_message', title: 'Read message', capability: 'read',
    description: 'Read one message from a conversation: headers, plain-text body, and attachment metadata.',
    effect: 'Reads one message\'s headers, body, and attachment names.',
    inputSchema: object({ accountId, conversationId, messageId, maxBodyChars: bodyChars, includeHtml }, ['accountId', 'conversationId', 'messageId']), annotations: read('Read message')
  },
  {
    name: 'get_attachment', title: 'Download attachment', capability: 'read',
    description: `Download one attachment as base64. Attachments larger than maxBytes (at most ${MCP_ATTACHMENT_MAX_BYTES / 1024 / 1024} MB) are refused.`,
    effect: `Reads attachment contents up to ${MCP_ATTACHMENT_MAX_BYTES / 1024 / 1024} MB each.`,
    inputSchema: object({
      accountId, conversationId, messageId,
      attachmentId: id('Attachment id from get_message or get_conversation.'),
      maxBytes: { type: 'integer', minimum: 1, maximum: MCP_ATTACHMENT_MAX_BYTES, default: MCP_ATTACHMENT_DEFAULT_BYTES, description: 'Refuse attachments larger than this many bytes.' }
    }, ['accountId', 'conversationId', 'messageId', 'attachmentId']), annotations: read('Download attachment')
  },
  {
    name: 'open_in_aerio', title: 'Open in Aerio', capability: 'read',
    description: 'Open a conversation (optionally at one message) in an Aerio message window on this computer.',
    effect: 'Opens a message window in Aerio. Nothing is changed.',
    inputSchema: object({ accountId, conversationId, messageId: { ...messageId, description: 'Message to focus. Omit to open the conversation.' } as JsonSchema }, ['accountId', 'conversationId']),
    annotations: read('Open in Aerio', false)
  },
  {
    name: 'mark_read', title: 'Mark read or unread', capability: 'write',
    description: 'Mark conversations read or unread. The change is queued and synchronized like an action taken in Aerio.',
    effect: 'Marks conversations read or unread on the mail server.',
    inputSchema: object({ accountId, conversationIds, read: { type: 'boolean', default: true, description: 'true marks read, false marks unread.' } }, ['accountId', 'conversationIds']),
    annotations: change('Mark read or unread', false, true, true)
  },
  {
    name: 'flag', title: 'Flag or unflag', capability: 'write',
    description: 'Flag (star) or unflag conversations.',
    effect: 'Flags or unflags conversations on the mail server.',
    inputSchema: object({ accountId, conversationIds, flagged: { type: 'boolean', default: true, description: 'true flags, false removes the flag.' } }, ['accountId', 'conversationIds']),
    annotations: change('Flag or unflag', false, true, true)
  },
  {
    name: 'move', title: 'Move to folder', capability: 'write',
    description: 'Move conversations to a folder or label from list_folders in the same account.',
    effect: 'Moves conversations to another folder on the mail server.',
    inputSchema: object({ accountId, conversationIds, folderId: id('Destination folder or label id from list_folders.') }, ['accountId', 'conversationIds', 'folderId']),
    annotations: change('Move to folder', false, true, true)
  },
  {
    name: 'archive', title: 'Archive', capability: 'write',
    description: 'Archive conversations (remove them from the inbox without deleting them).',
    effect: 'Archives conversations on the mail server.',
    inputSchema: object({ accountId, conversationIds }, ['accountId', 'conversationIds']),
    annotations: change('Archive', false, true, true)
  },
  {
    name: 'create_draft', title: 'Create draft', capability: 'write',
    description: 'Create a draft in Aerio\'s Drafts. Nothing is sent. Pass replyToConversationId to thread it as a reply.',
    effect: 'Creates drafts (synchronized to the provider\'s Drafts). Nothing is sent.',
    inputSchema: object({
      accountId,
      to: addresses('Recipient addresses.'), cc: addresses('Cc addresses.'), bcc: addresses('Bcc addresses.'),
      subject: { type: 'string', maxLength: 998 },
      text: { type: 'string', maxLength: 1_000_000, description: 'Plain-text body.' },
      html: { type: 'string', maxLength: 2_000_000, description: 'Optional HTML body.' },
      replyToConversationId: id('Thread the draft as a reply to the latest message in this conversation.')
    }, ['accountId', 'subject', 'text']),
    annotations: change('Create draft', false, false)
  },
  {
    name: 'update_draft', title: 'Update draft', capability: 'write',
    description: 'Change the recipients, subject, or body of an unsent draft. Omitted fields keep their current value. Attachments are kept.',
    effect: 'Edits unsent drafts.',
    inputSchema: object({
      draftId: id('Draft id from create_draft.'),
      to: addresses('Replacement recipients.'), cc: addresses('Replacement Cc.'), bcc: addresses('Replacement Bcc.'),
      subject: { type: 'string', maxLength: 998 },
      text: { type: 'string', maxLength: 1_000_000 },
      html: { type: 'string', maxLength: 2_000_000 }
    }, ['draftId']),
    annotations: change('Update draft', false, true)
  },
  {
    name: 'send_draft', title: 'Send draft', capability: 'send',
    description: 'Send a draft through Aerio\'s normal send path (Outbox, undo window, OpenPGP/S/MIME checks). Reusing an idempotencyKey returns the first result instead of sending again.',
    effect: 'Sends email from your accounts to the draft\'s recipients.',
    inputSchema: object({
      draftId: id('Draft id from create_draft.'),
      idempotencyKey: { type: 'string', minLength: 8, maxLength: 200, description: 'A unique key for this send, reused on retries.' }
    }, ['draftId', 'idempotencyKey']),
    annotations: change('Send draft', false, true, true)
  },
  {
    name: 'trash_message', title: 'Move to Trash', capability: 'delete',
    description: 'Move conversations to Trash, like Delete in Aerio. Providers may empty Trash later.',
    effect: 'Moves conversations to Trash; the provider may delete them permanently later.',
    inputSchema: object({ accountId, conversationIds }, ['accountId', 'conversationIds']),
    annotations: change('Move to Trash', true, true, true)
  }
]

export function toolByName(name: string) {
  return MCP_TOOLS.find((tool) => tool.name === name)
}

export function capabilityEnabled(capability: McpCapability, capabilities: McpCapabilitySettings) {
  return capability === 'read' || capabilities[capability]
}

/** The MCP `tools/list` shape of a definition (internal fields such as capability are omitted). */
export function protocolTool(tool: McpToolDefinition) {
  return { name: tool.name, title: tool.title, description: `${tool.description} Effect: ${tool.effect}`, inputSchema: tool.inputSchema, annotations: tool.annotations }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

function validate(schema: JsonSchema, value: unknown, path: string, errors: string[]) {
  if (errors.length >= 20) return
  const at = path || '(arguments)'
  switch (schema.type) {
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) { errors.push(`${at} must be an object`); return }
      const record = value as Record<string, unknown>
      for (const key of schema.required ?? []) if (record[key] === undefined) errors.push(`${path ? `${path}.` : ''}${key} is required`)
      for (const [key, child] of Object.entries(record)) {
        const childSchema = schema.properties[key]
        if (!childSchema) {
          if (schema.additionalProperties === false) errors.push(`${path ? `${path}.` : ''}${key} is not a supported argument`)
          continue
        }
        if (child === undefined) continue
        validate(childSchema, child, path ? `${path}.${key}` : key, errors)
      }
      return
    }
    case 'string':
      if (typeof value !== 'string') { errors.push(`${at} must be a string`); return }
      if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${at} must be at least ${schema.minLength} characters`)
      if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${at} must be at most ${schema.maxLength} characters`)
      if (schema.enum && !schema.enum.includes(value)) errors.push(`${at} must be one of ${schema.enum.join(', ')}`)
      if (schema.format === 'date' && (!DATE.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)))) errors.push(`${at} must be a date (YYYY-MM-DD)`)
      return
    case 'integer':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) { errors.push(`${at} must be an integer`); return }
      if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at} must be at least ${schema.minimum}`)
      if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at} must be at most ${schema.maximum}`)
      return
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(`${at} must be true or false`)
      return
    case 'array':
      if (!Array.isArray(value)) { errors.push(`${at} must be an array`); return }
      if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at} must contain at least ${schema.minItems} item${schema.minItems === 1 ? '' : 's'}`)
      if (schema.maxItems !== undefined && value.length > schema.maxItems) { errors.push(`${at} must contain at most ${schema.maxItems} items`); return }
      if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) errors.push(`${at} must not repeat items`)
      value.forEach((item, index) => validate(schema.items, item, `${at}[${index}]`, errors))
  }
}

/** Validates tool arguments against the tool's input schema; returns readable problems (empty when valid). */
export function validateToolArguments(schema: JsonSchema, value: unknown) {
  const errors: string[] = []
  validate(schema, value ?? {}, '', errors)
  return errors.slice(0, 20)
}
