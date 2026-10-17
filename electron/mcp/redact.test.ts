import { describe, expect, it } from 'vitest'
import { mcpDiagnosticDetails, redactMcpText } from './redact'

describe('MCP diagnostics redaction', () => {
  it('records argument names but never argument values, content, or addresses', () => {
    const details = mcpDiagnosticDetails({
      tool: 'create_draft', clientId: 'mcp-1234', outcome: 'ok', durationMs: 12.6, itemCount: 3,
      arguments: { accountId: 'acct-work', to: ['grace@example.test'], subject: 'Secret merger', text: 'Confidential body', 'bad key!': 1 }
    })
    expect(details).toEqual({ tool: 'create_draft', clientId: 'mcp-1234', outcome: 'ok', durationMs: 13, itemCount: 3, argumentNames: ['accountId', 'subject', 'text', 'to'] })
    const serialized = JSON.stringify(details)
    for (const secret of ['grace@example.test', 'Secret merger', 'Confidential body', 'acct-work']) expect(serialized).not.toContain(secret)
  })

  it('scrubs addresses, quoted text, and encoded data from error reasons', () => {
    const reason = redactMcpText(new Error('Send to grace@example.test failed for "Quarterly numbers" with payload JVBERi0xLjcgdGVzdCBkYXRhIHRoYXQgaXMgbG9uZyBlbm91Z2ggdG8gbWF0Y2g='))
    expect(reason).toBe('Send to [address] failed for [text] with payload [data]')
    expect(redactMcpText('word '.repeat(100))).toHaveLength(300)
    expect(redactMcpText(undefined)).toBe('')
  })

  it('replaces unsafe identifiers and keeps refusal codes', () => {
    expect(mcpDiagnosticDetails({ tool: 'grace@example.test subject', clientId: 'x y', errorCode: 'locked', outcome: 'refused', duplicate: true, arguments: ['a'] }))
      .toEqual({ tool: '[invalid]', clientId: '[invalid]', errorCode: 'locked', outcome: 'refused', duplicate: true })
    expect(mcpDiagnosticDetails({ errorCode: '<script>', error: 'Thread for ada@example.test not found' })).toEqual({ errorCode: '[invalid]', reason: 'Thread for [address] not found' })
  })
})
