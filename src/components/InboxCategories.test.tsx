// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MailCategoryId, MailInboxTab } from '../mail-category-types'
import type { MailAccountSummary, MailThreadSummary } from '../mail-types'
import { defaultInboxTabs } from '../lib/mail-categories'
import InboxCategoryTabs, { useInboxCategories } from './InboxCategoryTabs'
import MailCategoryAssignModal from './MailCategoryAssignModal'
import InboxCategorySettings from './InboxCategorySettings'

const tabs: MailInboxTab[] = defaultInboxTabs().tabs.filter((tab) => tab.enabled)

function Harness({ onSelect = vi.fn() }: { onSelect?: (id: MailCategoryId) => void }) {
  const [selected, setSelected] = useState<MailCategoryId>('primary')
  return <>
    <input aria-label="Search" />
    <InboxCategoryTabs tabs={tabs} selected={selected} counts={{ primary: { unread: 3, total: 9 }, social: { unread: 0, total: 2 }, promotions: { unread: 1200, total: 1500 } }} onSelect={(id) => { onSelect(id); setSelected(id) }} />
  </>
}

const categoriesApi = () => ({
  tabs: vi.fn(async () => defaultInboxTabs()),
  saveTabs: vi.fn(async (config: any) => config),
  counts: vi.fn(async () => ({})),
  assign: vi.fn(async (input: any) => ({ updated: input.threadIds.length, providerOperations: input.accountId === 'gmail' ? 2 : 0, ...(input.remember ? { rule: { id: 'r', kind: input.remember, pattern: 'shop.example', category: input.category, createdAt: '', updatedAt: '' } } : {}) })),
  rules: vi.fn(async () => [{ id: 'rule-1', kind: 'domain', pattern: 'news.example', category: 'promotions', createdAt: '', updatedAt: '' }]),
  saveRule: vi.fn(async (input: any) => ({ id: input.id ?? 'rule-2', createdAt: '', updatedAt: '', ...input, pattern: input.pattern.toLowerCase() })),
  deleteRule: vi.fn(async () => undefined)
})
let api: ReturnType<typeof categoriesApi>

beforeEach(() => {
  api = categoriesApi()
  Object.defineProperty(window, 'aerio', { configurable: true, value: { mail: { categories: api, onEvent: vi.fn(() => vi.fn()) } } })
})

describe('InboxCategoryTabs keyboard navigation', () => {
  it('uses a roving tabindex and moves between tabs with arrows, Home, and End', async () => {
    const onSelect = vi.fn()
    render(<Harness onSelect={onSelect} />)
    const list = screen.getByRole('tablist', { name: 'Inbox categories' })
    const items = within(list).getAllByRole('tab')
    expect(items.map((tab) => tab.textContent)).toEqual(['Primary3', 'Social', 'Promotions999+', 'Updates'])
    expect(items.map((tab) => tab.tabIndex)).toEqual([0, -1, -1, -1])
    expect(items[0]).toHaveAttribute('aria-selected', 'true')
    items[0].focus()
    fireEvent.keyDown(items[0], { key: 'ArrowRight' })
    expect(onSelect).toHaveBeenLastCalledWith('social')
    await waitFor(() => expect(screen.getByRole('tab', { name: /Social/ })).toHaveFocus())
    expect(screen.getByRole('tab', { name: /Social/ }).tabIndex).toBe(0)
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect(onSelect).toHaveBeenLastCalledWith('updates')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
    expect(onSelect).toHaveBeenLastCalledWith('primary')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' })
    expect(onSelect).toHaveBeenLastCalledWith('updates')
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    expect(onSelect).toHaveBeenLastCalledWith('primary')
    expect(screen.getByRole('tab', { name: /Primary/ })).toHaveFocus()
  })

  it('switches tabs with Alt+arrows and Alt+digits but not while typing', async () => {
    const onSelect = vi.fn()
    render(<Harness onSelect={onSelect} />)
    fireEvent.keyDown(window, { key: 'ArrowRight', altKey: true })
    expect(onSelect).toHaveBeenLastCalledWith('social')
    fireEvent.keyDown(window, { key: '3', code: 'Digit3', altKey: true })
    expect(onSelect).toHaveBeenLastCalledWith('promotions')
    await waitFor(() => expect(screen.getByRole('tab', { name: /Promotions/ })).toHaveAttribute('aria-selected', 'true'))
    fireEvent.keyDown(window, { key: 'ArrowLeft', altKey: true })
    expect(onSelect).toHaveBeenLastCalledWith('social')
    onSelect.mockClear()
    fireEvent.keyDown(screen.getByLabelText('Search'), { key: 'ArrowRight', altKey: true })
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(onSelect).not.toHaveBeenCalled()
  })
})

describe('useInboxCategories', () => {
  function Probe({ accountId }: { accountId: string }) {
    const state = useInboxCategories(vi.fn(), accountId)
    return <span>{state.active ? 'active' : 'off'}:{state.tabs.length}:{state.counts.primary?.unread ?? '-'}</span>
  }

  it('loads tabs and per-account or unified counts and reloads them when mail changes', async () => {
    let listener: ((event: any) => void) | undefined
    Object.defineProperty(window, 'aerio', { configurable: true, value: { mail: { categories: api, onEvent: vi.fn((callback: any) => { listener = callback; return vi.fn() }) } } })
    api.counts.mockResolvedValue({ primary: { unread: 4, total: 5 } } as any)
    const { rerender } = render(<Probe accountId="all" />)
    expect(await screen.findByText('active:4:4')).toBeInTheDocument()
    expect(api.counts).toHaveBeenLastCalledWith(undefined)
    rerender(<Probe accountId="account-1" />)
    await waitFor(() => expect(api.counts).toHaveBeenLastCalledWith(['account-1']))
    api.counts.mockClear()
    api.tabs.mockClear()
    act(() => listener?.({ type: 'mail-changed', payload: { accountId: 'account-1', threadIds: ['t'] } }))
    await waitFor(() => expect(api.counts).toHaveBeenCalledTimes(1))
    expect(api.tabs).not.toHaveBeenCalled()
    act(() => listener?.({ type: 'mail-changed', payload: { accountId: 'account-1' } }))
    await waitFor(() => expect(api.tabs).toHaveBeenCalledTimes(1))
  })
})

describe('MailCategoryAssignModal', () => {
  const accounts = [{ id: 'gmail', provider: 'gmail' }, { id: 'imap', provider: 'imap' }] as MailAccountSummary[]
  const item = (overrides: Partial<MailThreadSummary>): MailThreadSummary => ({
    accountId: 'gmail', id: 't1', subject: 'Sale', participants: ['Shop'], senderEmail: 'deals@shop.example', snippet: '', lastDate: '2026-09-01T00:00:00Z',
    unread: false, starred: false, important: false, trashed: false, draft: false, hasAttachments: false, messageCount: 1, labelIds: ['INBOX'],
    category: 'promotions', categorySource: 'provider', ...overrides
  })

  it('moves conversations per account, remembers the domain once, and reports server updates', async () => {
    const user = userEvent.setup()
    const onDone = vi.fn()
    const onClose = vi.fn()
    render(<MailCategoryAssignModal items={[item({}), item({ accountId: 'imap', id: 't2', senderEmail: 'news@shop.example' })]} config={defaultInboxTabs()} accounts={accounts} onClose={onClose} onDone={onDone} onError={vi.fn()} />)
    expect(screen.getByRole('radio', { name: 'Promotions' })).toBeChecked()
    expect(screen.getByText(/Forums/).textContent).toContain('tab hidden')
    // Different senders share a domain, so only the domain can be remembered.
    expect(screen.queryByRole('radio', { name: /this sender$/ })).toBeNull()
    await user.click(screen.getByRole('radio', { name: 'Social' }))
    expect(screen.getByText(/also update the category on the server/)).toBeInTheDocument()
    await user.click(screen.getByRole('radio', { name: /sender’s domain \(shop\.example\)/ }))
    await user.click(screen.getByRole('button', { name: 'Move' }))
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('Moved to Social; future mail from anyone at shop.example goes there too and updated on the server'))
    expect(api.assign.mock.calls.map((call) => call[0])).toEqual([
      { accountId: 'gmail', threadIds: ['t1'], category: 'social', remember: 'domain' },
      { accountId: 'imap', threadIds: ['t2'], category: 'social' }
    ])
    expect(onClose).toHaveBeenCalled()
  })

  it('returns a conversation to automatic classification and reports errors', async () => {
    const user = userEvent.setup()
    const onDone = vi.fn()
    const onError = vi.fn()
    render(<MailCategoryAssignModal items={[item({ categorySource: 'manual' })]} config={defaultInboxTabs()} accounts={accounts} onClose={vi.fn()} onDone={onDone} onError={onError} />)
    expect(screen.getByText(/now: Moved by you/)).toBeInTheDocument()
    await user.click(screen.getByRole('radio', { name: /Automatic/ }))
    expect(screen.queryByText('Always do this')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Move' }))
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('Returned to automatic classification'))
    expect(api.assign).toHaveBeenCalledWith({ accountId: 'gmail', threadIds: ['t1'] })
    api.assign.mockRejectedValueOnce(new Error('A selected conversation was not found'))
    await user.click(screen.getByRole('button', { name: 'Move' }))
    await waitFor(() => expect(onError).toHaveBeenCalledWith('A selected conversation was not found'))
  })
})

describe('InboxCategorySettings', () => {
  it('renames, reorders, enables, adds, and saves tabs', async () => {
    const user = userEvent.setup()
    render(<InboxCategorySettings />)
    const editor = await screen.findByRole('list', { name: 'Inbox tabs' })
    expect(screen.getByRole('button', { name: 'Save tabs' })).toBeDisabled()
    expect(within(editor).getByRole('checkbox', { name: 'Show Primary' })).toBeDisabled()
    await user.click(within(editor).getByRole('checkbox', { name: 'Show Forums' }))
    await user.clear(within(editor).getByRole('textbox', { name: 'Name of updates tab' }))
    await user.type(within(editor).getByRole('textbox', { name: 'Name of updates tab' }), 'Notices')
    await user.click(within(editor).getByRole('button', { name: 'Move Notices earlier' }))
    await user.click(screen.getByRole('button', { name: 'Add tab' }))
    await user.click(screen.getByRole('button', { name: 'Save tabs' }))
    await waitFor(() => expect(api.saveTabs).toHaveBeenCalled())
    const saved = (api.saveTabs.mock.calls[0] as any[])[0].tabs as MailInboxTab[]
    expect(saved.map((tab) => [tab.id.startsWith('custom:') ? 'custom' : tab.id, tab.name, tab.enabled])).toEqual([
      ['primary', 'Primary', true], ['social', 'Social', true], ['updates', 'Notices', true], ['promotions', 'Promotions', true], ['forums', 'Forums', true], ['custom', 'New tab', true]
    ])
    expect(await screen.findByText('Inbox tabs saved')).toBeInTheDocument()
  })

  it('lists, edits, adds, and removes sender and domain rules', async () => {
    const user = userEvent.setup()
    render(<InboxCategorySettings />)
    const rules = await screen.findByRole('list', { name: 'Classification rules' })
    expect(within(rules).getByText('Anyone at news.example')).toBeInTheDocument()
    fireEvent.change(within(rules).getByRole('combobox', { name: 'Tab for news.example' }), { target: { value: 'updates' } })
    await waitFor(() => expect(api.saveRule).toHaveBeenCalledWith({ id: 'rule-1', kind: 'domain', pattern: 'news.example', category: 'updates' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Rule type' }), 'address')
    const add = screen.getByRole('button', { name: 'Add rule' })
    await user.type(screen.getByRole('textbox', { name: 'Sender address or domain' }), 'not-an-address')
    expect(add).toBeDisabled()
    await user.clear(screen.getByRole('textbox', { name: 'Sender address or domain' }))
    await user.type(screen.getByRole('textbox', { name: 'Sender address or domain' }), 'Friend@Example.org')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Tab for new rule' }), 'primary')
    await user.click(add)
    await waitFor(() => expect(api.saveRule).toHaveBeenLastCalledWith({ kind: 'address', pattern: 'Friend@Example.org', category: 'primary' }))
    expect(await within(rules).findByText('friend@example.org')).toBeInTheDocument()
    await user.click(within(rules).getByRole('button', { name: 'Remove rule for news.example' }))
    await waitFor(() => expect(api.deleteRule).toHaveBeenCalledWith('rule-1'))
    await waitFor(() => expect(within(rules).queryByText('Anyone at news.example')).toBeNull())
  })

  it('renders nothing without the categories API', () => {
    Object.defineProperty(window, 'aerio', { configurable: true, value: { mail: {} } })
    const { container } = render(<InboxCategorySettings />)
    expect(container).toBeEmptyDOMElement()
  })
})
