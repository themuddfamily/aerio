// @vitest-environment jsdom

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpIssuedClient, McpSettings, McpStatus } from '../mcp-types'
import McpAutomationSection from './McpAutomationSection'

const tools: McpStatus['tools'] = [
  { name: 'search_mail', title: 'Search mail', capability: 'read', effect: 'Reads conversation subjects, participants, snippets, and flags.', enabled: false },
  { name: 'archive', title: 'Archive', capability: 'write', effect: 'Archives conversations on the mail server.', enabled: false },
  { name: 'send_draft', title: 'Send draft', capability: 'send', effect: 'Sends email from your accounts to the draft\'s recipients.', enabled: false },
  { name: 'trash_message', title: 'Move to Trash', capability: 'delete', effect: 'Moves conversations to Trash; the provider may delete them permanently later.', enabled: false }
]
const off: McpSettings = { enabled: false, capabilities: { write: false, send: false, delete: false }, accountScope: 'all' }
const client = { id: 'mcp-1', name: 'Claude Desktop', createdAt: '2026-10-01T10:00:00.000Z', lastUsedAt: '2026-10-02T10:00:00.000Z', connected: true }
let current: McpStatus
const statusWith = (settings: McpSettings, clients: McpStatus['clients'] = []): McpStatus => ({
  settings, listening: settings.enabled, endpoint: '\\\\.\\pipe\\aerio-mcp-abc', clients, tools, command: 'C:\\Aerio\\Aerio.exe', args: ['--mcp']
})
const issued: McpIssuedClient = {
  client: { ...client, id: 'mcp-2', name: 'Script', connected: false, lastUsedAt: undefined },
  token: 'aerio_mcp_secret',
  config: { command: 'C:\\Aerio\\Aerio.exe', args: ['--mcp'], claudeDesktop: '{"mcpServers":{"aerio":{"env":{"AERIO_MCP_TOKEN":"aerio_mcp_secret"}}}}', generic: '{"mcpServers":{"aerio":{"type":"stdio"}}}' }
}

const api = {
  status: vi.fn(async () => current),
  save: vi.fn(async (settings: McpSettings) => { current = statusWith(settings, current.clients); return current }),
  createClient: vi.fn(async () => issued),
  revokeClient: vi.fn(async (id: string) => { current = statusWith(current.settings, current.clients.filter((item) => item.id !== id)); return current }),
  onChanged: vi.fn(() => () => undefined)
}
const accounts = [
  { id: 'acct-work', provider: 'gmail', email: 'ada@example.test', displayName: 'Ada Work' },
  { id: 'acct-home', provider: 'imap', email: 'ada.home@example.test', displayName: 'Ada Home' }
]
const clipboard = { writeText: vi.fn(async () => undefined) }

beforeEach(() => {
  vi.clearAllMocks()
  current = statusWith(off)
  Object.defineProperty(window, 'aerio', { configurable: true, value: { mcp: api, mail: { accounts: { list: vi.fn(async () => accounts) } } } })
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard })
})

describe('McpAutomationSection', () => {
  it('is off by default and keeps capability toggles disabled until the bridge is enabled', async () => {
    const user = userEvent.setup()
    render(<McpAutomationSection />)
    const bridge = await screen.findByRole('checkbox', { name: /Enable automation bridge/ })
    expect(bridge).not.toBeChecked()
    expect(screen.getByText('Off. No client can connect.')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /Allow sending/ })).toBeDisabled()
    // Every tool's effect is described before anything is enabled.
    expect(screen.getByText(/Sends email from your accounts/)).toBeInTheDocument()
    expect(screen.getByText(/Moves conversations to Trash/)).toBeInTheDocument()
    await user.click(bridge)
    expect(api.save).toHaveBeenLastCalledWith({ ...off, enabled: true })
    await waitFor(() => expect(screen.getByText('Listening for local clients.')).toBeInTheDocument())
    await user.click(screen.getByRole('checkbox', { name: /Allow changes/ }))
    expect(api.save).toHaveBeenLastCalledWith({ enabled: true, capabilities: { write: true, send: false, delete: false }, accountScope: 'all' })
    await user.click(screen.getByRole('checkbox', { name: /Allow sending/ }))
    expect(api.save).toHaveBeenLastCalledWith({ enabled: true, capabilities: { write: true, send: true, delete: false }, accountScope: 'all' })
  })

  it('limits automation to selected accounts', async () => {
    const user = userEvent.setup()
    current = statusWith({ ...off, enabled: true })
    render(<McpAutomationSection />)
    await user.click(await screen.findByRole('radio', { name: 'Only selected accounts' }))
    expect(api.save).toHaveBeenLastCalledWith({ ...off, enabled: true, accountScope: ['acct-work', 'acct-home'] })
    const allowed = await screen.findByRole('list', { name: 'Allowed accounts' })
    await user.click(within(allowed).getByRole('checkbox', { name: /Ada Home/ }))
    expect(api.save).toHaveBeenLastCalledWith({ ...off, enabled: true, accountScope: ['acct-work'] })
    await user.click(screen.getByRole('radio', { name: 'All accounts' }))
    expect(api.save).toHaveBeenLastCalledWith({ ...off, enabled: true, accountScope: 'all' })
  })

  it('issues a client token once with copyable configuration and revokes clients', async () => {
    const user = userEvent.setup()
    current = statusWith({ ...off, enabled: true }, [client])
    render(<McpAutomationSection />)
    const list = await screen.findByRole('list', { name: 'Automation clients' })
    expect(within(list).getByText('Claude Desktop · connected')).toBeInTheDocument()
    expect(within(list).getByText(/last used/)).toBeInTheDocument()
    const name = screen.getByRole('textbox', { name: 'Client name' })
    await user.clear(name)
    await user.type(name, 'Script')
    await user.click(screen.getByRole('button', { name: /Issue client token/ }))
    expect(api.createClient).toHaveBeenCalledWith('Script')
    const region = await screen.findByRole('region', { name: 'Client configuration' })
    expect(within(region).getByText(/shown only once/)).toBeInTheDocument()
    expect(within(region).getByLabelText('MCP client configuration')).toHaveTextContent('aerio_mcp_secret')
    await user.click(within(region).getByRole('button', { name: /Copy configuration/ }))
    expect(await screen.findByText(/Copied. Paste it/)).toBeInTheDocument()
    expect(await navigator.clipboard.readText()).toBe(issued.config.claudeDesktop)
    await user.click(within(region).getByRole('tab', { name: 'Generic mcpServers' }))
    expect(within(region).getByLabelText('MCP client configuration')).toHaveTextContent('"type":"stdio"')
    await user.click(within(list).getByRole('button', { name: /Revoke/ }))
    expect(api.revokeClient).toHaveBeenCalledWith('mcp-1')
    expect(await screen.findByText(/Its token stopped working immediately/)).toBeInTheDocument()
    expect(screen.getByText('No clients have been issued a token.')).toBeInTheDocument()
  })

  it('shows save failures and renders nothing without the desktop API', async () => {
    const user = userEvent.setup()
    api.save.mockRejectedValueOnce(new Error('Unlock Aerio before changing external automation'))
    const { unmount } = render(<McpAutomationSection />)
    await user.click(await screen.findByRole('checkbox', { name: /Enable automation bridge/ }))
    expect(await screen.findByText('Unlock Aerio before changing external automation')).toBeInTheDocument()
    unmount()
    Object.defineProperty(window, 'aerio', { configurable: true, value: { mail: { accounts: { list: vi.fn(async () => []) } } } })
    const { container } = render(<McpAutomationSection />)
    expect(container).toBeEmptyDOMElement()
  })
})
