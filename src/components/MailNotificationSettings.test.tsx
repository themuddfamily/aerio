// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { defaultMailNotifications } from '../lib/mail-notifications'
import MailNotificationSettings from './MailNotificationSettings'

describe('mail notification settings', () => {
  it('edits button order, previews, quiet hours, categories and per-account mute', async () => {
    const changed = vi.fn()
    Object.defineProperty(window, 'aerio', { configurable: true, value: { mail: { accounts: { list: vi.fn().mockResolvedValue([
      { id: 'a', email: 'me@test', archived: false, notifications: true }, { id: 'b', email: 'off@test', archived: false, notifications: false }
    ]) }, categories: { tabs: vi.fn().mockResolvedValue({ tabs: [{ id: 'primary', name: 'Primary', enabled: true }, { id: 'promotions', name: 'Promotions', enabled: true }] }) } } } })
    function Harness() { const [preferences, setPreferences] = useState(defaultMailNotifications()); return <MailNotificationSettings value={preferences} onChange={(next) => { setPreferences(next); changed(next) }} /> }
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Add notification button' }))
    fireEvent.change(screen.getByLabelText('Notification button 2'), { target: { value: 'archive' } })
    fireEvent.click(screen.getByRole('button', { name: 'Move notification button 2 earlier' }))
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ actions: ['archive', 'open'] }))
    fireEvent.change(screen.getByLabelText('Mail notification preview'), { target: { value: 'hidden' } })
    fireEvent.click(screen.getByLabelText('Silent new-mail notifications'))
    fireEvent.click(screen.getByLabelText('Only notify when Aerio is in the background'))
    fireEvent.click(screen.getByLabelText('Quiet hours for new mail'))
    fireEvent.change(screen.getByLabelText('Quiet hours start'), { target: { value: '21:30' } })
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ preview: 'hidden', silent: true, onlyWhenUnfocused: true, quietHours: { enabled: true, start: '21:30', end: '08:00' } }))
    const accountToggle = await screen.findByLabelText('Notify for me@test')
    expect(screen.getByLabelText('Notify for off@test')).toBeDisabled()
    fireEvent.click(accountToggle)
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ accounts: { a: false } }))
    fireEvent.click(screen.getByLabelText('Notify for all inbox categories'))
    fireEvent.click(screen.getByLabelText('Promotions'))
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ categories: ['primary'] }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove notification button 1' }))
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ actions: ['open'] }))
  })
})
