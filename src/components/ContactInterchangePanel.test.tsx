// @vitest-environment jsdom

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Contact } from '../types'
import type { ContactImportPreview, InterchangeDesktopApi } from '../interchange-types'
import ContactInterchangePanel from './ContactInterchangePanel'

const contact = (overrides: Partial<Contact>): Contact => ({ id: 'c', name: 'Name', email: '', group: 'Personal', favorite: false, color: '#000', ...overrides })

const api = (preview: ContactImportPreview | undefined): InterchangeDesktopApi => ({
  snapshot: vi.fn(), onChanged: vi.fn(() => () => undefined), chooseCalendarFile: vi.fn(),
  chooseContactsFile: vi.fn(async () => preview),
  exportCalendar: vi.fn(), exportContacts: vi.fn(async () => ({ savedPath: 'C:\\c.vcf', count: 1 })),
  saveLocalEvents: vi.fn(), saveLocalEvent: vi.fn(), deleteLocalEvent: vi.fn(), subscribe: vi.fn(), refresh: vi.fn(), removeCalendar: vi.fn()
})

const existing = [
  contact({ id: 'local-ada', name: 'Ada Lovelace', email: 'ada@test', source: 'local', favorite: true }),
  { ...contact({ id: 'google-grace', name: 'Grace Hopper', email: 'grace@test' }), remoteId: 'people/1', accountId: 'google', provider: 'gmail', readOnly: false } as Contact
]

const renderPanel = (desktop: InterchangeDesktopApi) => {
  const props = { onLocalContactsChange: vi.fn(), onSaveProviderContact: vi.fn(async (_accountId: string, saved: Contact) => saved), onToast: vi.fn() }
  render(<ContactInterchangePanel api={desktop} contacts={existing} providerAccounts={[{ id: 'google', email: 'me@gmail.test', provider: 'gmail' }]} {...props} />)
  return props
}

describe('ContactInterchangePanel', () => {
  it('maps CSV columns with a preview, merges duplicates, and saves local contacts', async () => {
    const user = userEvent.setup()
    const desktop = api({
      fileName: 'people.csv', format: 'csv', warnings: [],
      table: { headers: ['First Name', 'Last Name', 'E-mail Address', 'Mobile Phone', 'Department'], rows: [['Ada', 'Lovelace', 'ADA@test', '+44 1', 'R&D'], ['Alan', 'Turing', 'alan@test', '', 'Maths'], ['', '', '', '', 'Nobody']] }
    })
    const props = renderPanel(desktop)
    await user.click(screen.getByRole('button', { name: /Import/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Import contacts' })
    expect(screen.getByLabelText('Import E-mail Address as')).toHaveValue('email')
    expect(screen.getByLabelText('Import Department as')).toHaveValue('ignore')
    expect(dialog).toHaveTextContent('1 new · 1 to merge · 0 skipped · 1 without a name or email')
    expect(dialog).toHaveTextContent('Merge with Ada Lovelace')
    await user.selectOptions(screen.getByLabelText('Import Department as'), 'group')
    await user.selectOptions(screen.getByLabelText('Contacts already saved'), 'skip')
    expect(dialog).toHaveTextContent('1 new · 0 to merge · 1 skipped')
    await user.selectOptions(screen.getByLabelText('Contacts already saved'), 'merge')
    await user.click(screen.getByRole('button', { name: /Import 2 contacts/ }))
    const saved = props.onLocalContactsChange.mock.calls[0][0] as Contact[]
    expect(saved.map((item) => item.name)).toEqual(['Alan Turing', 'Ada Lovelace'])
    expect(saved[0]).toMatchObject({ source: 'local', group: 'Maths', email: 'alan@test' })
    expect(saved[1]).toMatchObject({ id: 'local-ada', favorite: true, phone: '+44 1', email: 'ada@test' })
    expect(props.onToast).toHaveBeenCalledWith('Imported 1 new and updated 1 contact')
  })

  it('imports vCards into a provider account, merging with that account’s contacts', async () => {
    const user = userEvent.setup()
    const desktop = api({
      fileName: 'people.vcf', format: 'vcard', warnings: ['1 contact without a name or email address was skipped'],
      contacts: [contact({ id: 'n1', name: 'Grace Hopper', email: 'grace@test', title: 'Admiral' }), contact({ id: 'n2', name: 'Ada Lovelace', email: 'ada@test' })]
    })
    const props = renderPanel(desktop)
    await user.click(screen.getByRole('button', { name: /Import/ }))
    await user.selectOptions(await screen.findByLabelText('Import into'), 'google')
    expect(screen.getByRole('dialog')).toHaveTextContent('1 new · 1 to merge · 0 skipped')
    expect(screen.getByRole('dialog')).toHaveTextContent('1 contact without a name or email address was skipped')
    await user.click(screen.getByRole('button', { name: /Import 2 contacts/ }))
    await waitFor(() => expect(props.onSaveProviderContact).toHaveBeenCalledTimes(2))
    expect(props.onSaveProviderContact).toHaveBeenCalledWith('google', expect.objectContaining({ id: 'google-grace', title: 'Admiral' }), true)
    expect(props.onSaveProviderContact).toHaveBeenCalledWith('google', expect.objectContaining({ id: 'n2', favorite: false }), false)
    expect(props.onLocalContactsChange).not.toHaveBeenCalled()
  })

  it('exports a chosen scope and format', async () => {
    const user = userEvent.setup()
    const desktop = api(undefined)
    renderPanel(desktop)
    await user.click(screen.getByRole('button', { name: /Export/ }))
    await user.selectOptions(screen.getByLabelText('Contacts'), 'local')
    await user.selectOptions(screen.getByLabelText('Format'), 'vcard4')
    expect(screen.getByRole('dialog')).toHaveTextContent('1 contact selected')
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^Export$/ }))
    await waitFor(() => expect(desktop.exportContacts).toHaveBeenCalledWith(['local-ada'], 'vcard4'))
  })
})
