// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextMenuProvider, useContextMenu } from './ContextMenu'
import ThreadMessageAccordion from './ThreadMessageAccordion'
import { useMailMessageTools } from './MailMessageTools'
import type { MailAccountSummary, MailListUnsubscribeInfo, MailMessageDetail } from '../mail-types'

vi.mock('./Modal', () => ({ default: ({ title, children, onClose }: any) => <div role="dialog" aria-label={title}>{children}<button onClick={onClose}>Close dialog</button></div> }))
vi.mock('./SenderAvatar', () => ({ default: () => <span /> }))
const message: MailMessageDetail = { accountId: 'a', id: 'm1', threadId: 't', fromName: 'News', fromEmail: 'news@example.test', to: ['me@example.test'], cc: [], subject: 'Weekly news', date: '2026-10-01T09:00:00Z', text: 'News', html: '', sanitizedHtml: '', labelIds: ['INBOX'], attachments: [] }
const ref = { accountId: 'a', threadId: 't', messageId: 'm1' }
const info: MailListUnsubscribeInfo = {
  listId: 'weekly.example.test',
  options: [
    { kind: 'https', url: 'https://lists.example.test/u?id=1', destination: 'lists.example.test', oneClick: true },
    { kind: 'mailto', url: 'mailto:leave@example.test', destination: 'leave@example.test', oneClick: false, mailto: { to: ['leave@example.test'], subject: '', body: '' } }
  ],
  warnings: ['An unencrypted HTTP unsubscribe link was ignored; Aerio only uses HTTPS links']
}
const tools = { unsubscribeInfo: vi.fn(), unsubscribe: vi.fn() }
const onToast = vi.fn()

function Harness({ archived = false }: { archived?: boolean }) {
  const menu = useContextMenu()
  const actions = useMailMessageTools({ accounts: [{ id: 'a', provider: 'imap', email: 'me@example.test', archived } as MailAccountSummary], onToast, collapseAll: () => {}, expandAll: () => {}, onUpdated: () => {} })
  return <><ThreadMessageAccordion message={message} expanded onToggle={() => {}} onReply={() => {}} onMoreActions={(event) => menu.showContextMenu(event, actions.items(message), 'Message options')} />{actions.dialog}</>
}
async function openDialog(archived = false) {
  const user = userEvent.setup()
  render(<ContextMenuProvider><Harness archived={archived} /></ContextMenuProvider>)
  await user.click(screen.getByRole('button', { name: 'Message options' }))
  await user.click(screen.getByRole('menuitem', { name: 'Unsubscribe from list…' }))
  return user
}
beforeEach(() => {
  vi.clearAllMocks()
  tools.unsubscribeInfo.mockResolvedValue(info)
  tools.unsubscribe.mockResolvedValue({ method: 'one-click', destination: 'lists.example.test', status: 'unsubscribed' })
  Object.defineProperty(window, 'aerio', { configurable: true, value: { mail: { messageTools: tools } } })
})

describe('mailing-list unsubscribe dialog', () => {
  it('never contacts the list while the message or the dialog is merely shown', async () => {
    render(<ContextMenuProvider><Harness /></ContextMenuProvider>)
    expect(tools.unsubscribeInfo).not.toHaveBeenCalled()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Message options' }))
    await user.click(screen.getByRole('menuitem', { name: 'Unsubscribe from list…' }))
    expect(await screen.findByText('lists.example.test')).toBeInTheDocument()
    expect(tools.unsubscribeInfo).toHaveBeenCalledWith(ref)
    expect(tools.unsubscribe).not.toHaveBeenCalled()
  })
  it('shows each destination and performs only the action the user chooses', async () => {
    const user = await openDialog()
    const web = await screen.findByRole('region', { name: 'Unsubscribe through lists.example.test' })
    expect(within(web).getByText('https://lists.example.test/u?id=1')).toBeInTheDocument()
    expect(screen.getByText(/from weekly\.example\.test/)).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Unsubscribe header problems' })).toHaveTextContent(/unencrypted HTTP/)
    await user.click(within(web).getByRole('button', { name: 'Unsubscribe' }))
    expect(tools.unsubscribe).toHaveBeenCalledWith(ref, { url: 'https://lists.example.test/u?id=1', method: 'one-click' })
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Unsubscribe request accepted (lists.example.test)'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('keeps the dialog open with the failure and offers the browser and mailto alternatives', async () => {
    tools.unsubscribe.mockRejectedValueOnce(new Error('lists.example.test tried to redirect the unsubscribe request, which Aerio does not follow.'))
    const user = await openDialog()
    const web = await screen.findByRole('region', { name: 'Unsubscribe through lists.example.test' })
    await user.click(within(web).getByRole('button', { name: 'Unsubscribe' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/does not follow/)
    tools.unsubscribe.mockResolvedValueOnce({ method: 'browser', destination: 'lists.example.test', status: 'opened' })
    await user.click(within(web).getByRole('button', { name: 'Open in browser' }))
    expect(tools.unsubscribe).toHaveBeenLastCalledWith(ref, { url: 'https://lists.example.test/u?id=1', method: 'browser' })
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Unsubscribe page opened in your browser (lists.example.test)'))
  })
  it('sends mailto unsubscribes only from writable accounts and explains missing metadata', async () => {
    await openDialog(true)
    const mail = await screen.findByRole('region', { name: 'Unsubscribe through leave@example.test' })
    expect(within(mail).getByRole('button', { name: 'Send unsubscribe email' })).toBeDisabled()
    expect(within(mail).getByText(/archived/)).toBeInTheDocument()
  })
  it('explains when an email has no usable unsubscribe metadata', async () => {
    tools.unsubscribeInfo.mockResolvedValueOnce({ options: [], warnings: ['The List-Unsubscribe header is malformed'] })
    await openDialog()
    expect(await screen.findByText(/does not include a usable unsubscribe link/)).toBeInTheDocument()
    expect(screen.getByText('The List-Unsubscribe header is malformed')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Unsubscribe' })).toBeNull()
  })
})
