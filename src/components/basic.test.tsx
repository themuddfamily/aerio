// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MailMessageDetail, MailThreadDetail } from '../mail-types'
import { ContextMenuProvider } from './ContextMenu'
import MailMessageSourceModal from './MailMessageSourceModal'
import MessageHtml from './MessageHtml'
import ProviderLogo from './ProviderLogo'
import SenderAvatar from './SenderAvatar'
import ThreadListPreview from './ThreadListPreview'
import ThreadMessageAccordion from './ThreadMessageAccordion'
import TitleBar from './TitleBar'

const message = (overrides: Partial<MailMessageDetail> = {}): MailMessageDetail => ({
  accountId: 'account-1', id: 'message/1', threadId: 'thread-1',
  fromName: 'Ada Lovelace', fromEmail: 'ada@example.com', to: ['person@example.test'], cc: [],
  subject: 'Analytical engine', date: '2026-08-08T10:15:30Z',
  text: 'A detailed message about the analytical engine.', html: '', sanitizedHtml: '', labelIds: [], attachments: [],
  ...overrides
})

describe('small mail presentation components', () => {
  it.each([
    ['gmail', 'G'],
    ['microsoft', ''],
    ['icloud', ''],
    ['yahoo', 'Y!'],
    ['fastmail', ''],
    ['proton-bridge', ''],
    ['imap', '']
  ] as const)('renders the %s provider artwork at the requested size', (provider, text) => {
    const { container } = render(<ProviderLogo provider={provider} size={31} />)
    const logo = container.firstElementChild as HTMLElement
    expect(logo).toHaveStyle({ width: '31px', height: '31px' })
    expect(logo).toHaveAttribute('aria-hidden', 'true')
    if (text) expect(logo).toHaveTextContent(text)
    if (provider === 'microsoft') expect(logo.querySelectorAll('i')).toHaveLength(4)
    if (provider === 'fastmail') expect(logo.querySelector('img')).toHaveAttribute('alt', '')
  })

  it('shows sender initials and removes a favicon after its load fails', () => {
    const { container, rerender } = render(<SenderAvatar email="ada@example.com" name="Ada Lovelace" large fallbackColor="#abcdef" />)
    const avatar = container.firstElementChild as HTMLElement
    expect(avatar).toHaveClass('large')
    expect(avatar).toHaveStyle({ background: '#abcdef' })
    expect(avatar).toHaveTextContent('AL')
    const image = avatar.querySelector('img')!
    expect(image).toHaveAttribute('src', 'aerio-image://favicon/example.com')
    fireEvent.error(image)
    expect(avatar.querySelector('img')).toBeNull()

    rerender(<SenderAvatar email="invalid" name="" />)
    expect(container.firstElementChild).toHaveTextContent('I')
    expect(container.querySelector('img')).toBeNull()

    rerender(<SenderAvatar email="" name="" />)
    expect(container.firstElementChild).toHaveTextContent('?')
  })

  it('adds native destination tooltips only to non-empty links', async () => {
    const { container, rerender } = render(<MessageHtml className="mail" html={'<a href=" https://example.com/path ">Visit</a><a href=" ">Blank</a>'} />)
    expect(container.firstElementChild).toHaveClass('mail')
    await waitFor(() => expect(screen.getByRole('link', { name: 'Visit' })).toHaveAttribute('title', 'https://example.com/path'))
    expect(screen.getByText('Blank')).not.toHaveAttribute('title')
    rerender(<MessageHtml html="<p>Changed</p>" />)
    expect(screen.getByText('Changed')).toBeInTheDocument()
  })

  it('renders thread previews and reports click, double-click, and context actions', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    const onOpenWindow = vi.fn()
    const onContextMenu = vi.fn()
    const messages = [
      message({ id: 'first', text: '   ', attachments: [{ id: 'a', messageId: 'first', filename: 'file.txt', mimeType: 'text/plain', size: 2 }] }),
      message({ id: 'second', fromName: '', fromEmail: 'grace@example.com', text: 'A   reply\nwith spacing' })
    ]
    const thread: MailThreadDetail = { accountId: 'account-1', id: 'thread-1', subject: 'Thread subject', messages }
    render(<ThreadListPreview
      thread={thread} selectedMessageId="second" dateLabel={(value) => `date:${value}`}
      onSelect={onSelect} onOpenWindow={onOpenWindow} onContextMenu={onContextMenu}
    />)
    expect(screen.getByRole('group')).toHaveAccessibleName('Messages in Thread subject')
    expect(screen.getByText('No message preview available')).toBeInTheDocument()
    expect(screen.getByText('A reply with spacing')).toBeInTheDocument()
    expect(screen.getByText('Original')).toBeInTheDocument()
    expect(screen.getByText('Reply 1')).toBeInTheDocument()
    const second = screen.getByRole('button', { name: 'Open message from grace@example.com' })
    expect(second).toHaveAttribute('aria-current', 'true')
    await user.click(second)
    expect(onSelect).toHaveBeenCalledWith(messages[1])
    fireEvent.doubleClick(second)
    expect(onOpenWindow).toHaveBeenCalledWith(messages[1])
    fireEvent.contextMenu(second)
    expect(onContextMenu).toHaveBeenCalledOnce()
  })

  it('switches an accordion between preview, HTML content, reply, and plain text', async () => {
    const onToggle = vi.fn()
    const onReply = vi.fn()
    const onContextMenu = vi.fn()
    const htmlMessage = message({ sanitizedHtml: '<a href="https://example.com">Body link</a>' })
    const { container, rerender } = render(<ThreadMessageAccordion
      message={htmlMessage} expanded={false} onToggle={onToggle} onReply={onReply} onContextMenu={onContextMenu}
    />)
    const collapsed = screen.getByRole('button', { name: 'Expand message from Ada Lovelace' })
    expect(collapsed).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('A detailed message about the analytical engine.')).toBeInTheDocument()
    expect(container.querySelector('.thread-message-content-shell')).toHaveAttribute('aria-hidden', 'true')
    expect(container.querySelector('.thread-message-content-shell')).toHaveAttribute('inert')
    fireEvent.click(collapsed)
    expect(onToggle).toHaveBeenCalledOnce()

    rerender(<ThreadMessageAccordion message={htmlMessage} expanded onToggle={onToggle} onReply={onReply}><span>Attachment child</span></ThreadMessageAccordion>)
    expect(screen.getByRole('button', { name: 'Collapse message from Ada Lovelace' })).toHaveAttribute('aria-expanded', 'true')
    expect(container.querySelector('.thread-message-content-shell')).toHaveAttribute('aria-hidden', 'false')
    expect(container.querySelector('.thread-message-content-shell')).not.toHaveAttribute('inert')
    await waitFor(() => expect(screen.getByRole('link', { name: 'Body link' })).toHaveAttribute('title', 'https://example.com'))
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
    expect(onReply).toHaveBeenCalledOnce()
    expect(screen.getByText('Attachment child')).toBeInTheDocument()

    rerender(<ThreadMessageAccordion message={message({ sanitizedHtml: '', text: '' })} expanded onToggle={onToggle} />)
    expect(screen.queryByRole('button', { name: 'Reply' })).not.toBeInTheDocument()
    expect(document.querySelector('.mail-text')).toBeInTheDocument()
  })
})

describe('window and source controls', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'aerio', {
      configurable: true,
      value: {
        window: { isMaximized: vi.fn().mockResolvedValue(false), minimize: vi.fn(), maximize: vi.fn(), close: vi.fn() },
        onWindowState: vi.fn(() => vi.fn())
      }
    })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined), readText: vi.fn().mockResolvedValue('pasted') }
    })
  })

  it('drives window controls, state updates, and its custom context menu', async () => {
    const user = userEvent.setup()
    render(<ContextMenuProvider><TitleBar title="Message" /></ContextMenuProvider>)
    expect(screen.getByText('Message')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Minimize' }))
    await user.click(screen.getByRole('button', { name: 'Maximize' }))
    await user.click(screen.getAllByRole('button', { name: 'Close' }).at(-1)!)
    expect(window.aerio.window.minimize).toHaveBeenCalledOnce()
    expect(window.aerio.window.maximize).toHaveBeenCalledOnce()
    expect(window.aerio.window.close).toHaveBeenCalledOnce()

    const stateHandler = vi.mocked(window.aerio.onWindowState).mock.calls[0][0]
    stateHandler(true)
    expect(await screen.findByRole('button', { name: 'Restore' })).toBeInTheDocument()

    fireEvent.contextMenu(document.querySelector('.titlebar')!, { clientX: 20, clientY: 30 })
    const menu = await screen.findByRole('menu', { name: 'Window' })
    expect(within(menu).getByRole('menuitem', { name: 'Restore' })).toBeInTheDocument()
    await user.click(within(menu).getByRole('menuitem', { name: 'Restore' }))
    expect(window.aerio.window.maximize).toHaveBeenCalledTimes(2)
  })

  it('uses the default window title', async () => {
    render(<ContextMenuProvider><TitleBar /></ContextMenuProvider>)
    expect(screen.getByText('Aerio')).toBeInTheDocument()
    await waitFor(() => expect(window.aerio.window.isMaximized).toHaveBeenCalledOnce())
  })

  it('copies source content and closes from either footer action', async () => {
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, 'writeText')
    const onClose = vi.fn()
    const { rerender } = render(<MailMessageSourceModal mode="headers" subject="Hello" content="Subject: Hello" onClose={onClose} />)
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Message headers')
    expect(screen.getByText('Subject: Hello')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Copy headers' }))
    expect(writeText).toHaveBeenCalledWith('Subject: Hello')
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: 'Close' }).at(-1)!)
    expect(onClose).toHaveBeenCalledOnce()

    rerender(<MailMessageSourceModal mode="source" subject="Hello" content="raw source" onClose={onClose} />)
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Message source')
  })
})
