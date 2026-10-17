import { describe, expect, it } from 'vitest'
import { MCP_TOOLS, capabilityEnabled, protocolTool, toolByName, validateToolArguments, type JsonSchema } from './tools'

function walk(schema: JsonSchema, visit: (schema: JsonSchema) => void) {
  visit(schema)
  if (schema.type === 'object') Object.values(schema.properties).forEach((child) => walk(child, visit))
  if (schema.type === 'array') walk(schema.items, visit)
}

describe('MCP tool catalog', () => {
  it('publishes unique snake_case tools with closed JSON Schema object inputs', () => {
    expect(new Set(MCP_TOOLS.map((tool) => tool.name)).size).toBe(MCP_TOOLS.length)
    expect(MCP_TOOLS.map((tool) => tool.name)).toEqual([
      'list_accounts', 'list_folders', 'search_mail', 'get_conversation', 'get_message', 'get_attachment', 'open_in_aerio',
      'mark_read', 'flag', 'move', 'archive', 'create_draft', 'update_draft', 'send_draft', 'trash_message'
    ])
    for (const tool of MCP_TOOLS) {
      expect(tool.name).toMatch(/^[a-z][a-z_]{2,40}$/)
      expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false })
      for (const required of tool.inputSchema.required ?? []) expect(tool.inputSchema.properties).toHaveProperty(required)
      walk(tool.inputSchema, (schema) => {
        expect(['object', 'string', 'integer', 'boolean', 'array']).toContain(schema.type)
        if (schema.type === 'string' && schema.enum) expect(schema.enum.length).toBeGreaterThan(0)
        if (schema.type === 'integer') expect(schema.minimum).toBeLessThanOrEqual(schema.maximum ?? Infinity)
      })
      expect(tool.effect.length).toBeGreaterThan(10)
      // The serialized schema is plain JSON (no functions or undefined values).
      expect(JSON.parse(JSON.stringify(tool.inputSchema))).toEqual(tool.inputSchema)
    }
  })

  it('maps tools to read, write, send, and delete capabilities with matching annotations', () => {
    const byCapability = (capability: string) => MCP_TOOLS.filter((tool) => tool.capability === capability).map((tool) => tool.name)
    expect(byCapability('read')).toEqual(['list_accounts', 'list_folders', 'search_mail', 'get_conversation', 'get_message', 'get_attachment', 'open_in_aerio'])
    expect(byCapability('write')).toEqual(['mark_read', 'flag', 'move', 'archive', 'create_draft', 'update_draft'])
    expect(byCapability('send')).toEqual(['send_draft'])
    expect(byCapability('delete')).toEqual(['trash_message'])
    for (const tool of MCP_TOOLS) expect(tool.annotations.readOnlyHint).toBe(tool.capability === 'read')
    expect(toolByName('trash_message')?.annotations.destructiveHint).toBe(true)
    const none = { write: false, send: false, delete: false }
    expect(capabilityEnabled('read', none)).toBe(true)
    expect(capabilityEnabled('send', none)).toBe(false)
    expect(capabilityEnabled('send', { ...none, send: true })).toBe(true)
  })

  it('serializes tools for tools/list with the effect in the description and no internal fields', () => {
    const tool = protocolTool(toolByName('send_draft')!)
    expect(Object.keys(tool).sort()).toEqual(['annotations', 'description', 'inputSchema', 'name', 'title'])
    expect(tool.description).toContain('Effect: Sends email')
  })
})

describe('tool argument validation', () => {
  const schema = (name: string) => toolByName(name)!.inputSchema

  it('accepts valid arguments and treats a missing arguments object as empty', () => {
    expect(validateToolArguments(schema('list_accounts'), undefined)).toEqual([])
    expect(validateToolArguments(schema('search_mail'), { query: 'from:ada invoice', folder: 'inbox', pageSize: 50, unread: true, dateFrom: '2026-01-31' })).toEqual([])
    expect(validateToolArguments(schema('mark_read'), { accountId: 'a', conversationIds: ['t1', 't2'], read: false })).toEqual([])
  })

  it('reports missing, unknown, mistyped, out-of-range, and malformed values', () => {
    expect(validateToolArguments(schema('get_message'), { accountId: 'a' })).toEqual(['conversationId is required', 'messageId is required'])
    expect(validateToolArguments(schema('list_accounts'), { verbose: true })).toEqual(['verbose is not a supported argument'])
    expect(validateToolArguments(schema('list_accounts'), [])).toEqual(['(arguments) must be an object'])
    expect(validateToolArguments(schema('search_mail'), { pageSize: 51 })).toEqual(['pageSize must be at most 50'])
    expect(validateToolArguments(schema('search_mail'), { pageSize: 1.5 })).toEqual(['pageSize must be an integer'])
    expect(validateToolArguments(schema('search_mail'), { folder: 'outbox' })[0]).toMatch(/folder must be one of inbox/)
    expect(validateToolArguments(schema('search_mail'), { dateFrom: '2026-13-45' })).toEqual(['dateFrom must be a date (YYYY-MM-DD)'])
    expect(validateToolArguments(schema('search_mail'), { unread: 'yes' })).toEqual(['unread must be true or false'])
    expect(validateToolArguments(schema('search_mail'), { query: 'x'.repeat(1_001) })).toEqual(['query must be at most 1000 characters'])
    expect(validateToolArguments(schema('archive'), { accountId: 'a', conversationIds: [] })).toEqual(['conversationIds must contain at least 1 item'])
    expect(validateToolArguments(schema('archive'), { accountId: 'a', conversationIds: ['t', 't'] })).toEqual(['conversationIds must not repeat items'])
    expect(validateToolArguments(schema('archive'), { accountId: 'a', conversationIds: Array.from({ length: 101 }, (_, index) => `t${index}`) })).toEqual(['conversationIds must contain at most 100 items'])
    expect(validateToolArguments(schema('archive'), { accountId: '', conversationIds: [7] })).toEqual(['accountId must be at least 1 characters', 'conversationIds[0] must be a string'])
    expect(validateToolArguments(schema('send_draft'), { draftId: 'd', idempotencyKey: 'short' })).toEqual(['idempotencyKey must be at least 8 characters'])
    expect(validateToolArguments(schema('create_draft'), { accountId: 'a', subject: 's', text: 't', to: 'ada@example.com' })).toEqual(['to must be an array'])
  })

  it('stops after twenty problems', () => {
    const values = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`unknown${index}`, index]))
    expect(validateToolArguments(schema('list_accounts'), values)).toHaveLength(20)
  })
})
