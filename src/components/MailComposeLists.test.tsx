// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MailAccountSummary } from '../mail-types'
import { ContextMenuProvider } from './ContextMenu'
import MailComposeModal from './MailComposeModal'

const accounts: MailAccountSummary[] = [{
  id: 'account', provider: 'gmail', email: 'me@example.test', displayName: 'Me', color: '#123456', status: 'ready', archived: false,
  signature: '', notifications: true, syncEnabled: true
}]
const api = {
  chooseAttachments: vi.fn(async () => []),
  mail: {
    mail: { suggestRecipients: vi.fn(async () => []) },
    drafts: { save: vi.fn(async () => ({ id: 'draft', status: 'synced', updatedAt: '2026-08-08T10:00:00Z' })), send: vi.fn(async () => ({ id: 'draft', status: 'send-pending', updatedAt: '2026-08-08T10:00:00Z' })), schedule: vi.fn(), delete: vi.fn(), stageMessageAttachments: vi.fn(async () => []) }
  },
  productivity: {
    snapshot: vi.fn(async () => ({
      calendars: [], events: [], sync: [],
      contacts: [{ id: 'g:alan', remoteId: 'people/alan', accountId: 'g', provider: 'gmail', readOnly: true, name: 'Alan Turing', email: 'alan@example.test', group: 'Team', groupIds: ['contactGroups/team'], favorite: false, color: '#000' }],
      contactGroups: [{ id: 'g:team', remoteId: 'contactGroups/team', accountId: 'g', provider: 'gmail', name: 'Team', system: false, readOnly: true }]
    })),
    localSnapshot: vi.fn(async () => ({
      tasks: [], notes: [],
      contacts: [{ id: 'ada', name: 'Ada Lovelace', email: 'ada@example.test', group: 'Personal', favorite: false, color: '#000', source: 'local' }],
      contactLists: [{ id: 'list-1', name: 'Book club', source: 'local', members: [{ contactId: 'ada', email: 'ada@old.test' }, { email: 'guest@example.test' }] }]
    }))
  }
}
const rowInput = (label: string) => {
  const row = Array.from(document.querySelectorAll<HTMLElement>('.compose-row')).find((item) => item.querySelector('label')?.textContent === label)
  return row!.querySelector('input') as HTMLInputElement
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'aerio', { configurable: true, value: api })
})

describe('MailComposeModal distribution lists', () => {
  it('previews a matching list and expands it to member addresses when picked', async () => {
    const user = userEvent.setup(), onToast = vi.fn()
    render(<ContextMenuProvider><MailComposeModal accounts={accounts} onClose={vi.fn()} onSent={vi.fn()} onToast={onToast} /></ContextMenuProvider>)
    await waitFor(() => expect(api.productivity.localSnapshot).toHaveBeenCalled())
    await user.type(rowInput('To'), 'me@example.test, book')
    const suggestion = await screen.findByRole('button', { name: /Book club · Local list/ })
    expect(suggestion).toHaveTextContent('Ada Lovelace, guest@example.test')
    await user.click(suggestion)
    expect(rowInput('To')).toHaveValue('me@example.test, Ada Lovelace <ada@example.test>, guest@example.test, ')
    expect(onToast).toHaveBeenCalledWith('Book club: 2 recipients added')
  })

  it('expands a typed list name on blur and before sending', async () => {
    const user = userEvent.setup(), onToast = vi.fn()
    render(<ContextMenuProvider><MailComposeModal accounts={accounts} onClose={vi.fn()} onSent={vi.fn()} onToast={onToast} /></ContextMenuProvider>)
    await waitFor(() => expect(api.productivity.snapshot).toHaveBeenCalled())
    await user.type(rowInput('Cc'), 'Team')
    await user.click(rowInput('Subject'))
    expect(rowInput('Cc')).toHaveValue('Alan Turing <alan@example.test>, ')
    expect(onToast).toHaveBeenCalledWith('Team: 1 recipient added')
    // A send that does not blur the field (keyboard or programmatic) still expands first and stops for review.
    await user.type(rowInput('To'), 'team')
    fireEvent.click(screen.getByRole('button', { name: /^Send/ }))
    await waitFor(() => expect(rowInput('To')).toHaveValue('Alan Turing <alan@example.test>, '))
    expect(onToast).toHaveBeenLastCalledWith('Team: 1 recipient added. Review the recipients, then send again.')
    expect(api.mail.drafts.send).not.toHaveBeenCalled()
  })
})
