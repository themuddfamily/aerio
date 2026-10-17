import { afterEach, describe, expect, it } from 'vitest'
import { McpToolError } from './service'
import { serviceHarness } from './test-fixtures'

const harnesses: ReturnType<typeof serviceHarness>[] = []
const setup = (...args: Parameters<typeof serviceHarness>) => { const harness = serviceHarness(...args); harnesses.push(harness); return harness }
afterEach(() => { for (const harness of harnesses.splice(0)) harness.close() })

async function failure(promise: Promise<unknown>) {
  try { await promise } catch (error) {
    expect(error).toBeInstanceOf(McpToolError)
    return error as McpToolError
  }
  throw new Error('Expected the tool call to fail')
}

describe('MCP tool service: reading mail', () => {
  it('lists accounts and folders limited to the configured account scope', async () => {
    const { service, setSettings } = setup()
    expect((await service.call('c', 'list_accounts', {})).result.accounts).toEqual([
      { id: 'acct-work', provider: 'gmail', email: 'ada@example.test', displayName: 'Ada Work', status: 'ready', archived: false, lastSyncAt: '2026-10-01T10:00:00.000Z' },
      { id: 'acct-home', provider: 'imap', email: 'ada.home@example.test', displayName: 'Ada Home', status: 'ready', archived: false }
    ])
    setSettings({ accountScope: ['acct-home'] })
    expect((await service.call('c', 'list_accounts', {})).result.accounts).toEqual([expect.objectContaining({ id: 'acct-home' })])
    const folders = (await service.call('c', 'list_folders', {})).result as any
    expect(folders.folders).toEqual([{ accountId: 'acct-home', id: 'folder:INBOX', name: 'INBOX', type: 'system' }])
    expect(folders.views.map((view: { id: string }) => view.id)).toContain('archive')
    expect((await failure(service.call('c', 'list_folders', { accountId: 'acct-work' }))).code).toBe('account-not-allowed')
    setSettings({ accountScope: [] })
    expect((await service.call('c', 'list_folders', {})).result.folders).toEqual([])
  })

  it('searches with the existing parser and paginates with search-bound cursors', async () => {
    const { service, worker } = setup()
    const first = (await service.call('c', 'search_mail', { query: 'from:grace report', pageSize: 4 })).result as any
    expect(worker.request).toHaveBeenLastCalledWith({ type: 'mail:list', payload: { accountIds: ['acct-work', 'acct-home'], folder: 'all', search: 'from:grace report', pageSize: 4 } })
    expect(first.conversations).toHaveLength(4)
    expect(first.conversations[0]).toEqual({
      accountId: 'acct-work', conversationId: 'acct-work-thread-0', subject: 'Quarterly report 0', participants: ['Grace <grace@example.test>'], from: 'grace@example.test',
      snippet: 'Confidential numbers 0', lastDate: '2026-09-30T10:00:00.000Z', unread: true, flagged: false, important: false, hasAttachments: true, messageCount: 2, folderIds: ['INBOX']
    })
    expect(first.total).toBe(10)
    const seen = first.conversations.map((item: any) => item.conversationId)
    let cursor = first.nextCursor
    while (cursor) {
      const page = (await service.call('c', 'search_mail', { query: 'from:grace report', pageSize: 4, cursor })).result as any
      seen.push(...page.conversations.map((item: any) => item.conversationId))
      cursor = page.nextCursor
    }
    expect(seen).toHaveLength(10)
    expect(new Set(seen).size).toBe(10)
    // A cursor from one search cannot be replayed against another.
    const reused = await failure(service.call('c', 'search_mail', { query: 'something else', pageSize: 4, cursor: first.nextCursor }))
    expect(reused.code).toBe('invalid-arguments')
    expect((await failure(service.call('c', 'search_mail', { cursor: 'not-a-cursor' }))).code).toBe('invalid-arguments')
  })

  it('maps filters and folders, rejects invalid search syntax, and requires an account for folder ids', async () => {
    const { service, worker } = setup()
    await service.call('c', 'search_mail', { accountId: 'acct-work', folderId: 'Label_Projects', unread: true, flagged: false, hasAttachments: true, dateFrom: '2026-01-01', dateTo: '2026-12-31' })
    expect(worker.request).toHaveBeenLastCalledWith({ type: 'mail:list', payload: {
      accountIds: ['acct-work'], folder: 'all', labelId: 'Label_Projects', filters: { unread: true, starred: false, hasAttachments: true, dateFrom: '2026-01-01', dateTo: '2026-12-31' }, pageSize: 20
    } })
    await service.call('c', 'search_mail', {})
    expect(worker.request).toHaveBeenLastCalledWith({ type: 'mail:list', payload: { accountIds: ['acct-work', 'acct-home'], folder: 'inbox', pageSize: 20 } })
    const invalid = await failure(service.call('c', 'search_mail', { query: '"unclosed' }))
    expect(invalid).toMatchObject({ code: 'invalid-arguments' })
    expect(invalid.message).toMatch(/The search is invalid/)
    expect((await failure(service.call('c', 'search_mail', { folderId: 'INBOX' }))).message).toMatch(/folderId requires accountId/)
  })

  it('never widens an empty account scope to every account', async () => {
    const { service, worker, setSettings } = setup()
    setSettings({ accountScope: [] })
    worker.request.mockClear()
    expect((await service.call('c', 'search_mail', { query: 'report' })).result).toEqual({ conversations: [], total: 0 })
    expect(worker.request).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'mail:list' }))
  })

  it('reads conversations and messages with truncated bodies and optional sanitized HTML', async () => {
    const { service, worker } = setup()
    const conversation = (await service.call('c', 'get_conversation', { accountId: 'acct-work', conversationId: 'acct-work-thread-0', maxBodyChars: 6 })).result as any
    expect(worker.request).toHaveBeenCalledWith({ type: 'mail:thread', payload: { accountId: 'acct-work', threadId: 'acct-work-thread-0', allowRemoteImages: false } })
    expect(conversation.messages).toHaveLength(2)
    expect(conversation.messages[0].body).toEqual({ text: 'First ', truncated: true, length: 18 })
    expect(conversation.messages[0]).not.toHaveProperty('html')
    const message = (await service.call('c', 'get_message', { accountId: 'acct-work', conversationId: 'acct-work-thread-0', messageId: 'acct-work-thread-0-m2', includeHtml: true })).result as any
    expect(message).toMatchObject({ accountId: 'acct-work', messageId: 'acct-work-thread-0-m2', from: { name: 'Grace', email: 'grace@example.test' }, html: { text: '<p>Second</p>', truncated: false } })
    expect(message.attachments).toContainEqual({ attachmentId: 'att-png', filename: 'chart.png', mimeType: 'image/png', size: 4, inline: true })
    expect((await failure(service.call('c', 'get_message', { accountId: 'acct-work', conversationId: 'acct-work-thread-0', messageId: 'nope' }))).code).toBe('not-found')
    expect((await failure(service.call('c', 'get_conversation', { accountId: 'acct-work', conversationId: 'missing' }))).code).toBe('not-found')
  })

  it('returns attachments as base64 within the size limit and refuses larger ones before reading them', async () => {
    const { service, deps } = setup()
    const base = { accountId: 'acct-work', conversationId: 'acct-work-thread-0', messageId: 'acct-work-thread-0-m2' }
    const pdf = await service.call('c', 'get_attachment', { ...base, attachmentId: 'att-pdf' })
    expect(pdf.result).toMatchObject({ filename: 'report.pdf', mimeType: 'application/pdf', size: 13, encoding: 'base64', data: Buffer.from('%PDF-1.7 test').toString('base64') })
    expect(pdf.content?.[1]).toEqual({ type: 'resource', resource: { uri: 'aerio://attachment/acct-work/acct-work-thread-0-m2/att-pdf', mimeType: 'application/pdf', blob: Buffer.from('%PDF-1.7 test').toString('base64') } })
    expect((await service.call('c', 'get_attachment', { ...base, attachmentId: 'att-png' })).content?.[1]).toEqual({ type: 'image', data: Buffer.from([137, 80, 78, 71]).toString('base64'), mimeType: 'image/png' })
    deps.readAttachment.mockClear()
    expect((await failure(service.call('c', 'get_attachment', { ...base, attachmentId: 'att-big' }))).code).toBe('too-large')
    expect(deps.readAttachment).not.toHaveBeenCalled()
    // The extracted size is checked again in case the metadata understated it.
    expect((await failure(service.call('c', 'get_attachment', { ...base, attachmentId: 'att-pdf', maxBytes: 12 }))).code).toBe('too-large')
    expect((await failure(service.call('c', 'get_attachment', { ...base, attachmentId: 'missing' }))).code).toBe('not-found')
  })

  it('opens a conversation in Aerio only when it exists', async () => {
    const { service, deps } = setup()
    expect((await service.call('c', 'open_in_aerio', { accountId: 'acct-work', conversationId: 'acct-work-thread-0', messageId: 'acct-work-thread-0-m2' })).result).toEqual({ opened: true, accountId: 'acct-work', conversationId: 'acct-work-thread-0', messageId: 'acct-work-thread-0-m2' })
    expect(deps.openMessage).toHaveBeenCalledWith({ source: 'connected', accountId: 'acct-work', threadId: 'acct-work-thread-0', messageId: 'acct-work-thread-0-m2', title: 'Quarterly report 0' })
    expect((await failure(service.call('c', 'open_in_aerio', { accountId: 'acct-work', conversationId: 'acct-work-thread-0', messageId: 'other' }))).code).toBe('not-found')
    expect(deps.openMessage).toHaveBeenCalledOnce()
  })
})

describe('MCP tool service: access controls', () => {
  it('refuses every tool without touching mail data while Aerio is locked', async () => {
    const { service, worker, setLocked } = setup()
    setLocked(true)
    worker.request.mockClear()
    for (const [name, args] of [['list_accounts', {}], ['search_mail', { query: 'x' }], ['get_message', { accountId: 'acct-work', conversationId: 't', messageId: 'm' }], ['send_draft', { draftId: 'd', idempotencyKey: 'key-000001' }]] as const) {
      const error = await failure(service.call('c', name, args))
      expect(error.code).toBe('locked')
      expect(error.message).not.toMatch(/report|grace/i)
    }
    expect(worker.request).not.toHaveBeenCalled()
    // Tool definitions carry no mail data and stay listable.
    expect(service.listTools().length).toBeGreaterThan(0)
  })

  it('hides and refuses write, send, and delete tools until each capability is enabled', async () => {
    const { service, worker, setSettings } = setup({ enabled: true, capabilities: { write: false, send: false, delete: false }, accountScope: 'all' })
    expect(service.listTools().map((tool) => tool.name)).toEqual(['list_accounts', 'list_folders', 'search_mail', 'get_conversation', 'get_message', 'get_attachment', 'open_in_aerio'])
    worker.request.mockClear()
    for (const [name, capability, args] of [
      ['archive', 'write', { accountId: 'acct-work', conversationIds: ['acct-work-thread-0'] }],
      ['create_draft', 'write', { accountId: 'acct-work', subject: 's', text: 't' }],
      ['send_draft', 'send', { draftId: 'd', idempotencyKey: 'key-000001' }],
      ['trash_message', 'delete', { accountId: 'acct-work', conversationIds: ['acct-work-thread-0'] }]
    ] as const) {
      const error = await failure(service.call('c', name, args))
      expect(error.code).toBe('capability-disabled')
      expect(error.message).toContain(`${capability} capability`)
    }
    expect(worker.request).not.toHaveBeenCalled()
    setSettings({ capabilities: { write: true, send: false, delete: false } })
    expect(service.listTools().map((tool) => tool.name)).toContain('archive')
    expect(service.listTools().map((tool) => tool.name)).not.toContain('send_draft')
    expect(service.descriptors().find((tool) => tool.name === 'send_draft')).toMatchObject({ capability: 'send', enabled: false })
    expect(service.descriptors().find((tool) => tool.name === 'archive')).toMatchObject({ capability: 'write', enabled: true })
  })

  it('refuses everything while the bridge is disabled, and rejects unknown tools and invalid arguments', async () => {
    const { service, setSettings } = setup()
    expect((await failure(service.call('c', 'nope', {}))).code).toBe('unknown-tool')
    expect((await failure(service.call('c', 'get_message', { accountId: 'acct-work' }))).details).toEqual(['conversationId is required', 'messageId is required'])
    setSettings({ enabled: false })
    expect((await failure(service.call('c', 'list_accounts', {}))).code).toBe('disabled')
    expect(() => service.listTools()).toThrow(/turned off/)
    expect(service.descriptors().every((tool) => !tool.enabled)).toBe(true)
  })

  it('treats out-of-scope accounts like unknown ones for reads, actions, and drafts', async () => {
    const { service, worker, setSettings } = setup()
    const draft = (await service.call('c', 'create_draft', { accountId: 'acct-work', to: ['grace@example.test'], subject: 'Hi', text: 'Hello' })).result as any
    setSettings({ accountScope: ['acct-home'] })
    worker.request.mockClear()
    expect((await failure(service.call('c', 'get_conversation', { accountId: 'acct-work', conversationId: 'acct-work-thread-0' }))).code).toBe('account-not-allowed')
    expect((await failure(service.call('c', 'archive', { accountId: 'acct-work', conversationIds: ['acct-work-thread-0'] }))).code).toBe('account-not-allowed')
    expect((await failure(service.call('c', 'get_conversation', { accountId: 'acct-unknown', conversationId: 'x' }))).message).toBe('That account is not available to automation clients.')
    expect((await failure(service.call('c', 'update_draft', { draftId: draft.draftId, subject: 'Changed' }))).code).toBe('not-found')
    expect((await failure(service.call('c', 'send_draft', { draftId: draft.draftId, idempotencyKey: 'key-000001' }))).code).toBe('not-found')
    expect(worker.request).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'mail:thread' }))
    expect(worker.request).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'mail:action' }))
    expect(worker.request).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'drafts:save' }))
  })
})

describe('MCP tool service: changing mail', () => {
  it('queues read, flag, archive, move, and trash through the mail operation queue', async () => {
    const { service, worker } = setup()
    const target = { accountId: 'acct-work', conversationIds: ['acct-work-thread-0', 'acct-work-thread-1'] }
    for (const [name, args, action] of [
      ['mark_read', {}, 'read'], ['mark_read', { read: false }, 'unread'], ['flag', {}, 'star'], ['flag', { flagged: false }, 'unstar'], ['archive', {}, 'archive'], ['trash_message', {}, 'trash']
    ] as const) {
      const result = (await service.call('c', name, { ...target, ...args })).result
      expect(result).toEqual({ operationId: `op-${action}`, action, status: 'queued', conversationIds: target.conversationIds, undoUntil: '2026-10-01T10:00:10.000Z' })
      expect(worker.request).toHaveBeenLastCalledWith({ type: 'mail:action', payload: { accountId: 'acct-work', threadIds: target.conversationIds, action } })
    }
    await service.call('c', 'move', { ...target, folderId: 'Label_Projects' })
    expect(worker.request).toHaveBeenLastCalledWith({ type: 'mail:action', payload: { accountId: 'acct-work', threadIds: target.conversationIds, action: 'move', labelId: 'Label_Projects' } })
    expect((await failure(service.call('c', 'move', { ...target, folderId: 'folder:INBOX' }))).code).toBe('not-found')
    expect((await failure(service.call('c', 'archive', { accountId: 'acct-work', conversationIds: ['ghost'] }))).code).toBe('not-found')
  })

  it('creates threaded reply drafts and updates only unsent drafts through draft validation', async () => {
    const { service, worker, deps } = setup()
    const created = (await service.call('c', 'create_draft', { accountId: 'acct-work', to: ['grace@example.test'], subject: 'Re: Quarterly report 0', text: 'Thanks', replyToConversationId: 'acct-work-thread-0' })).result as any
    expect(created).toMatchObject({ draftId: 'draft-1', status: 'local' })
    expect(deps.validateDraft).toHaveBeenCalledWith(expect.objectContaining({ attachmentPaths: [], threadId: 'acct-work-thread-0', inReplyTo: '<m2@example.test>', references: ['<m1@example.test>', '<m2@example.test>'] }))
    worker.drafts.get('draft-1')!.attachmentPaths = ['C:\\kept.pdf']
    const updated = (await service.call('c', 'update_draft', { draftId: 'draft-1', subject: 'Updated', cc: ['lin@example.test'] })).result as any
    expect(updated.draftId).toBe('draft-1')
    expect(deps.approveAttachmentPaths).toHaveBeenCalledWith(['C:\\kept.pdf'])
    expect(worker.drafts.get('draft-1')).toMatchObject({ subject: 'Updated', cc: ['lin@example.test'], to: ['grace@example.test'], text: 'Thanks', attachmentPaths: ['C:\\kept.pdf'], inReplyTo: '<m2@example.test>' })
    worker.drafts.get('draft-1')!.status = 'sent'
    expect((await failure(service.call('c', 'update_draft', { draftId: 'draft-1', text: 'Too late' }))).code).toBe('already-sent')
    expect((await failure(service.call('c', 'update_draft', { draftId: 'missing' }))).code).toBe('not-found')
  })

  it('reports a concurrent draft edit as a conflict instead of overwriting it', async () => {
    const { service, worker } = setup()
    await service.call('c', 'create_draft', { accountId: 'acct-work', subject: 'Draft', text: 'Body' })
    const original = worker.request.getMockImplementation()!
    worker.request.mockImplementationOnce(original).mockImplementationOnce(original).mockImplementationOnce(async (command) => {
      if (command.type === 'drafts:save') throw new Error('This draft changed after it was opened. Your version was not overwritten; save it as a copy to keep both versions.')
      return original(command)
    })
    expect((await failure(service.call('c', 'update_draft', { draftId: 'draft-1', text: 'Mine' }))).code).toBe('conflict')
  })

  it('refuses drafts for disconnected accounts', async () => {
    const { service, worker } = setup()
    const original = worker.request.getMockImplementation()!
    worker.request.mockImplementation(async (command) => command.type === 'accounts:list' ? [{ ...(await original(command))[0], archived: true }] : original(command))
    expect((await failure(service.call('c', 'create_draft', { accountId: 'acct-work', subject: 's', text: 't' }))).message).toMatch(/Reconnect/)
  })
})

describe('MCP tool service: duplicate send prevention', () => {
  it('sends a draft once per idempotency key and returns the first result on retries', async () => {
    const { service, deps } = setup()
    const { draftId } = (await service.call('client-a', 'create_draft', { accountId: 'acct-work', to: ['grace@example.test'], subject: 'Report', text: 'Attached' })).result as any
    const first = (await service.call('client-a', 'send_draft', { draftId, idempotencyKey: 'retry-key-0001' })).result
    expect(first).toEqual({ draftId, status: 'send-pending', deliveryAt: '2026-10-01T10:01:10.000Z', undoUntil: '2026-10-01T10:01:10.000Z', duplicate: false })
    expect(deps.sendDraft).toHaveBeenCalledWith(expect.objectContaining({ id: draftId, expectedUpdatedAt: expect.any(String), to: ['grace@example.test'] }))
    const retry = (await service.call('client-a', 'send_draft', { draftId, idempotencyKey: 'retry-key-0001' })).result
    expect(retry).toEqual({ ...first, duplicate: true })
    expect(deps.sendDraft).toHaveBeenCalledOnce()
    // A new key cannot resend a draft that is already on its way.
    expect((await failure(service.call('client-a', 'send_draft', { draftId, idempotencyKey: 'another-key-02' }))).code).toBe('already-sent')
    // Reusing a key for a different draft is refused rather than silently ignored.
    const other = (await service.call('client-a', 'create_draft', { accountId: 'acct-work', to: ['lin@example.test'], subject: 'Other', text: 'x' })).result as any
    expect((await failure(service.call('client-a', 'send_draft', { draftId: other.draftId, idempotencyKey: 'retry-key-0001' }))).code).toBe('conflict')
    expect(deps.sendDraft).toHaveBeenCalledOnce()
  })

  it('lets only one of two concurrent calls with the same key reach the send path', async () => {
    const { service, deps } = setup()
    const { draftId } = (await service.call('c', 'create_draft', { accountId: 'acct-work', to: ['grace@example.test'], subject: 'Once', text: 'x' })).result as any
    let release!: () => void
    deps.sendDraft.mockImplementationOnce(async (input) => {
      await new Promise<void>((resolve) => { release = resolve })
      return { id: input.id!, status: 'send-pending', updatedAt: 'now' }
    })
    const firstCall = service.call('c', 'send_draft', { draftId, idempotencyKey: 'concurrent-01' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    const second = await failure(service.call('c', 'send_draft', { draftId, idempotencyKey: 'concurrent-01' }))
    expect(second).toMatchObject({ code: 'conflict' })
    expect(second.message).toMatch(/already in progress/)
    release()
    expect((await firstCall).result).toMatchObject({ draftId, duplicate: false })
    expect(deps.sendDraft).toHaveBeenCalledOnce()
  })

  it('frees the key when the send path refuses the draft, so a corrected draft can be retried', async () => {
    const { service, deps } = setup()
    const { draftId } = (await service.call('c', 'create_draft', { accountId: 'acct-work', to: ['unfinished'], subject: 'Fix me', text: 'x' })).result as any
    deps.sendDraft.mockRejectedValueOnce(new Error('Finish or correct the recipient email addresses'))
    await expect(service.call('c', 'send_draft', { draftId, idempotencyKey: 'fix-and-retry' })).rejects.toThrow(/Finish or correct/)
    await service.call('c', 'update_draft', { draftId, to: ['grace@example.test'] })
    expect((await service.call('c', 'send_draft', { draftId, idempotencyKey: 'fix-and-retry' })).result).toMatchObject({ duplicate: false })
    expect(deps.sendDraft).toHaveBeenCalledTimes(2)
  })

  it('keeps idempotency keys separate per client', async () => {
    const { service, deps, worker } = setup()
    const a = (await service.call('client-a', 'create_draft', { accountId: 'acct-work', to: ['grace@example.test'], subject: 'A', text: 'x' })).result as any
    const b = (await service.call('client-b', 'create_draft', { accountId: 'acct-work', to: ['grace@example.test'], subject: 'B', text: 'x' })).result as any
    await service.call('client-a', 'send_draft', { draftId: a.draftId, idempotencyKey: 'shared-key-01' })
    await service.call('client-b', 'send_draft', { draftId: b.draftId, idempotencyKey: 'shared-key-01' })
    expect(deps.sendDraft).toHaveBeenCalledTimes(2)
    expect(worker.drafts.get(b.draftId)?.status).toBe('send-pending')
  })
})
