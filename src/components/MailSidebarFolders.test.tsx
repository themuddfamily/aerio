// @vitest-environment jsdom

import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MailAccountSummary, MailLabel } from '../mail-types'
import type { MailFolderAppearance, MailFolderFavorite } from '../mail-folder-preference-types'
import { appearanceIndex, favoriteIndex } from '../lib/mail-folder-preferences'
import { MailFavoritesSidebar, MailFolderDisplayModal, MailFolderTreeSidebar } from './MailSidebarFolders'

const account = (id: string, provider: MailAccountSummary['provider'], email: string): MailAccountSummary => ({
  id, provider, email, displayName: email, color: '#6558e8', status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true
})
const folder = (accountId: string, path: string, type: MailLabel['type'] = 'user'): MailLabel => {
  const split = path.lastIndexOf('/')
  return { accountId, id: `folder:${path}`, name: path, type, ...(split > 0 ? { parentId: `folder:${path.slice(0, split)}` } : {}) }
}
const favorite = (accountId: string, labelId: string, position: number, overrides: Partial<MailFolderFavorite> = {}): MailFolderFavorite => ({
  accountId, labelId, position, lastKnownName: labelId.replace(/^folder:/, ''), addedAt: '2026-10-01T00:00:00Z', ...overrides
})

const accounts = [account('work', 'imap', 'me@work.test'), account('home', 'gmail', 'me@home.test')]
const labels: MailLabel[] = [folder('work', 'Projects'), folder('work', 'Receipts'), { accountId: 'home', id: 'Label_1', name: 'Projects', type: 'user', color: '#4a86e8' }]

beforeEach(() => { try { window.localStorage.clear() } catch { /* Storage can be unavailable. */ } })

describe('MailFavoritesSidebar', () => {
  const favorites = [favorite('work', 'folder:Projects', 0), favorite('home', 'Label_1', 1), favorite('work', 'folder:Receipts', 2, { alias: 'Bills' })]
  const renderFavorites = (items = favorites, appearance: MailFolderAppearance[] = []) => {
    const props = { onOpen: vi.fn(), onReorder: vi.fn(), onRemove: vi.fn(), onContextMenu: vi.fn() }
    render(<MailFavoritesSidebar favorites={items} accounts={accounts} labels={labels} appearance={appearanceIndex({ favorites: [], appearance })} selectedAccountId="all" {...props} />)
    return props
  }

  it('lists favorites across accounts, telling same-named folders apart by account, and opens them', async () => {
    const props = renderFavorites(favorites, [{ accountId: 'work', labelId: 'folder:Receipts', color: '#188038', hidden: false }])
    const group = screen.getByRole('group', { name: 'Favorites' })
    const buttons = within(group).getAllByRole('button')
    expect(buttons.map((button) => button.textContent)).toEqual(['Projects me@work.test', 'Projects me@home.test', 'Bills'])
    expect(within(buttons[2]).getByText('Bills')).toHaveStyle({ color: '#188038' })
    expect(within(buttons[1]).getByText('Projects', { exact: false })).toHaveStyle({ color: '#4a86e8' })
    await userEvent.click(buttons[1])
    expect(props.onOpen).toHaveBeenCalledWith(labels[2])
  })

  it('reorders with Alt+Arrow keys and drag and drop', () => {
    const props = renderFavorites()
    const buttons = within(screen.getByRole('group', { name: 'Favorites' })).getAllByRole('button')
    fireEvent.keyDown(buttons[0], { key: 'ArrowDown', altKey: true })
    expect(props.onReorder).toHaveBeenLastCalledWith([favorites[1], favorites[0], favorites[2]])
    fireEvent.keyDown(buttons[0], { key: 'ArrowUp', altKey: true })
    expect(props.onReorder).toHaveBeenCalledTimes(1)
    fireEvent.dragStart(screen.getByTestId('favorite-work-folder:Receipts'))
    fireEvent.dragOver(screen.getByTestId('favorite-work-folder:Projects'))
    fireEvent.drop(screen.getByTestId('favorite-work-folder:Projects'))
    expect(props.onReorder).toHaveBeenLastCalledWith([favorites[2], favorites[0], favorites[1]])
  })

  it('shows a favorite of a deleted folder as unavailable with a Remove option', async () => {
    const stale = favorite('work', 'folder:Old/Clients', 0)
    const props = renderFavorites([stale])
    expect(screen.getByText('Clients')).toBeInTheDocument()
    expect(screen.getByText(/Unavailable/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Remove Clients from Favorites' }))
    expect(props.onRemove).toHaveBeenCalledWith(stale)
    expect(props.onOpen).not.toHaveBeenCalled()
  })
})

describe('MailFolderTreeSidebar', () => {
  const many = [folder('work', 'INBOX', 'system'), folder('work', 'Clients'), ...Array.from({ length: 14 }, (_, index) => folder('work', `Clients/Client ${String(index + 1).padStart(2, '0')}`)), folder('work', 'Receipts')]
  const renderTree = (props: Partial<Parameters<typeof MailFolderTreeSidebar>[0]> = {}) => {
    const handlers = { onOpen: vi.fn(), onContextMenu: vi.fn(), onToggleHidden: vi.fn() }
    const result = render(<MailFolderTreeSidebar accounts={accounts} labels={many} accountFilter="work" appearance={new Map()} favorites={new Map()} selectedAccountId="work" showHidden={false} {...handlers} {...props} />)
    return { ...handlers, ...result }
  }

  it('shows the whole tree beyond twelve folders, with a filter and collapsible parents', async () => {
    const user = userEvent.setup()
    renderTree()
    expect(screen.getByRole('button', { name: 'Client 14' })).toBeInTheDocument()
    expect(screen.getAllByRole('treeitem')).toHaveLength(17)
    await user.click(screen.getByRole('button', { name: 'Collapse Clients' }))
    expect(screen.queryByRole('button', { name: 'Client 01' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Expand Clients' })).toBeInTheDocument()
    // The filter searches inside collapsed folders.
    await user.type(screen.getByLabelText('Filter folders'), 'client 07')
    expect(screen.getAllByRole('treeitem').map((item) => item.textContent)).toEqual(['Clients', 'Client 07'])
    await user.clear(screen.getByLabelText('Filter folders'))
    await user.click(screen.getByRole('button', { name: 'Expand Clients' }))
    expect(screen.getByRole('button', { name: 'Client 01' })).toBeInTheDocument()
  })

  it('hides hidden folders, offers the Show hidden folders toggle, and marks favorites', () => {
    const appearance = appearanceIndex({ favorites: [], appearance: [{ accountId: 'work', labelId: 'folder:Receipts', hidden: true, icon: 'receipt' }] })
    const favorites = favoriteIndex({ favorites: [favorite('work', 'folder:Clients', 0)], appearance: [] })
    const { onToggleHidden, rerender } = renderTree({ appearance, favorites })
    expect(screen.queryByRole('button', { name: 'Receipts' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show hidden folders (1)' }))
    expect(onToggleHidden).toHaveBeenCalled()
    rerender(<MailFolderTreeSidebar accounts={accounts} labels={many} accountFilter="work" appearance={appearance} favorites={favorites} selectedAccountId="work" showHidden onToggleHidden={onToggleHidden} onOpen={vi.fn()} onContextMenu={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Receipts' }).closest('[role="treeitem"]')).toHaveClass('is-hidden')
    expect(screen.getByRole('button', { name: 'Hide hidden folders' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Clients' }).querySelector('.mail-folder-favorite-mark')).not.toBeNull()
  })

  it('groups folders by account for the unified view and opens folders from any account', async () => {
    const { onOpen } = renderTree({ labels, accountFilter: 'all' })
    expect(screen.getByRole('tree', { name: 'Folders in me@work.test' })).toBeInTheDocument()
    expect(screen.getByRole('tree', { name: 'Folders in me@home.test' })).toBeInTheDocument()
    await userEvent.click(within(screen.getByRole('tree', { name: 'Folders in me@home.test' })).getByRole('button', { name: 'Projects' }))
    expect(onOpen).toHaveBeenCalledWith(labels[2])
    await userEvent.click(screen.getByRole('button', { name: 'me@work.test' }))
    expect(within(screen.getByRole('tree', { name: 'Folders in me@work.test' })).queryByRole('treeitem')).not.toBeInTheDocument()
  })
})

describe('MailFolderDisplayModal', () => {
  it('saves a local icon, name color, visibility, and favorite alias for a non-Gmail folder', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn(async () => true)
    const onClose = vi.fn()
    render(<MailFolderDisplayModal label={labels[0]} account={accounts[0]} labels={labels} favorite={favorite('work', 'folder:Projects', 0)} onSave={onSave} onClose={onClose} />)
    expect(screen.getByText(/name, color, and contents on the mail server stay as they are/)).toBeInTheDocument()
    await user.type(screen.getByLabelText('Name in Favorites'), 'Client work')
    await user.click(screen.getByRole('button', { name: 'Briefcase icon' }))
    await user.click(screen.getByRole('button', { name: 'Teal' }))
    await user.click(screen.getByLabelText('Hide from the sidebar folder list'))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith({ alias: 'Client work', appearance: { accountId: 'work', labelId: 'folder:Projects', icon: 'briefcase', color: '#00897b', hidden: true } })
    expect(onClose).toHaveBeenCalled()
  })

  it('leaves Gmail label colors to Gmail', async () => {
    const onSave = vi.fn(async () => true)
    render(<MailFolderDisplayModal label={labels[2]} account={accounts[1]} labels={labels} appearance={{ accountId: 'home', labelId: 'Label_1', icon: 'star', hidden: false }} onSave={onSave} onClose={vi.fn()} />)
    expect(screen.getByText(/Gmail label colors are synchronized with Gmail/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Teal' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Name in Favorites')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith({ appearance: { accountId: 'home', labelId: 'Label_1', icon: 'star', hidden: false } })
  })
})
