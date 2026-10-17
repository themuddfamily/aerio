// @vitest-environment jsdom

import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KeymapOverrides, KeymapPlatform } from '../lib/keymap'
import KeyboardShortcutsSection from './KeyboardShortcutsSection'

function Harness({ initial, platform = 'windows', onChange }: { initial?: KeymapOverrides; platform?: KeymapPlatform; onChange(next?: KeymapOverrides): void }) {
  const [overrides, setOverrides] = useState(initial)
  return <KeyboardShortcutsSection platform={platform} overrides={overrides} onChange={(next) => { setOverrides(next); onChange(next) }} />
}

const row = (name: string) => screen.getByRole('button', { name: new RegExp(`^Record a shortcut for ${name},`) }).closest('li') as HTMLElement
const record = async (name: string) => {
  await userEvent.click(screen.getByRole('button', { name: new RegExp(`^Record a shortcut for ${name},`) }))
  return screen.getByRole('button', { name: `Press the new shortcut for ${name}, or Escape to cancel` })
}

afterEach(() => vi.restoreAllMocks())

describe('KeyboardShortcutsSection', () => {
  it('lists commands with current bindings and filters by name, area, or key', async () => {
    const user = userEvent.setup()
    render(<Harness onChange={vi.fn()} />)
    expect(within(row('Reply')).getByText('Ctrl+R')).toBeInTheDocument()
    expect(within(row('Add or remove star')).getByText('None')).toBeInTheDocument()
    await user.type(screen.getByLabelText('Search keyboard shortcuts'), 'ctrl+shift+3')
    expect(screen.getByRole('button', { name: /^Record a shortcut for Run Quick Action in slot 3,/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Record a shortcut for Reply,/ })).toBeNull()
    await user.clear(screen.getByLabelText('Search keyboard shortcuts'))
    await user.type(screen.getByLabelText('Search keyboard shortcuts'), 'message editor')
    expect(screen.getByRole('button', { name: /^Record a shortcut for Save draft,/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Record a shortcut for Open Mail,/ })).toBeNull()
    await user.clear(screen.getByLabelText('Search keyboard shortcuts'))
    await user.type(screen.getByLabelText('Search keyboard shortcuts'), 'zzz')
    expect(screen.getByText('No commands match “zzz”.')).toBeInTheDocument()
  })

  it('records a shortcut as a portable override and shows macOS modifiers', async () => {
    const onChange = vi.fn()
    const { unmount } = render(<Harness onChange={onChange} />)
    const capture = await record('Archive')
    // A lone modifier keeps recording; the chord completes it.
    fireEvent.keyDown(capture, { key: 'Control', code: 'ControlLeft', ctrlKey: true })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.keyDown(capture, { key: 'e', code: 'KeyE', ctrlKey: true })
    expect(onChange).toHaveBeenLastCalledWith({ version: 1, bindings: { 'mail.archive': ['Mod+E'] } })
    expect(within(row('Archive')).getByText('Ctrl+E')).toBeInTheDocument()
    expect(within(row('Archive')).getByText(/Customized/)).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Archive now uses Ctrl+E.')
    unmount()
    render(<Harness platform="mac" initial={{ version: 1, bindings: { 'mail.archive': ['Mod+E'] } }} onChange={vi.fn()} />)
    expect(within(row('Archive')).getByText('Cmd+E')).toBeInTheDocument()
    expect(within(row('Mark as read')).getByText('Cmd+T')).toBeInTheDocument()
  })

  it('rejects reserved keys, warns about plain keys, and cancels with Escape or Tab', async () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    let capture = await record('Move to Trash')
    fireEvent.keyDown(capture, { key: 'c', code: 'KeyC', ctrlKey: true })
    expect(screen.getByRole('status')).toHaveTextContent('Ctrl+C stays reserved for text editing')
    fireEvent.keyDown(capture, { key: 'ArrowDown', code: 'ArrowDown' })
    expect(screen.getByRole('status')).toHaveTextContent('reserved for keyboard navigation')
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.keyDown(capture, { key: 'Escape', code: 'Escape' })
    expect(screen.getByRole('status')).toHaveTextContent('Recording cancelled.')
    expect(screen.queryByRole('button', { name: /Press the new shortcut/ })).toBeNull()
    capture = await record('Move to Trash')
    const tab = fireEvent.keyDown(capture, { key: 'Tab', code: 'Tab' })
    expect(tab).toBe(true) // not prevented, so focus can move on
    expect(screen.queryByRole('button', { name: /Press the new shortcut/ })).toBeNull()
    capture = await record('Move to Trash')
    fireEvent.keyDown(capture, { key: 'x', code: 'KeyX' })
    expect(onChange).toHaveBeenLastCalledWith({ version: 1, bindings: { 'mail.trash': ['X'] } })
    expect(screen.getByRole('status')).toHaveTextContent('It works only while focus is outside text fields.')
  })

  it('detects conflicts in the same context and reassigns only after confirmation', async () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    let capture = await record('Archive')
    fireEvent.keyDown(capture, { key: 'r', code: 'KeyR', ctrlKey: true })
    expect(screen.getByRole('status')).toHaveTextContent('Ctrl+R is already used by Reply.')
    expect(onChange).not.toHaveBeenCalled()
    await userEvent.click(within(screen.getByRole('group', { name: 'Resolve shortcut conflict' })).getByRole('button', { name: 'Cancel' }))
    expect(onChange).not.toHaveBeenCalled()
    capture = await record('Archive')
    fireEvent.keyDown(capture, { key: 'r', code: 'KeyR', ctrlKey: true })
    await userEvent.click(screen.getByRole('button', { name: 'Reassign' }))
    expect(onChange).toHaveBeenLastCalledWith({ version: 1, bindings: { 'mail.reply': [], 'mail.archive': ['Mod+R'] } })
    expect(within(row('Reply')).getByText('None')).toBeInTheDocument()
    // Mail and message-editor shortcuts never run together, so they may share a key.
    capture = await record('Save draft')
    fireEvent.keyDown(capture, { key: 'r', code: 'KeyR', ctrlKey: true })
    expect(onChange).toHaveBeenLastCalledWith({ version: 1, bindings: { 'mail.reply': [], 'mail.archive': ['Mod+R'], 'compose.saveDraft': ['Mod+R'] } })
  })

  it('lists stored conflicts, clears and resets single commands, and resets everything', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<Harness initial={{ version: 1, bindings: { 'mail.archive': ['Mod+K'] } }} onChange={onChange} />)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Conflicting shortcuts')
    expect(alert).toHaveTextContent('Ctrl+K Search and run a command · Archive')
    expect(row('Archive')).toHaveClass('conflicted')
    await user.click(screen.getByRole('button', { name: 'Reset Archive to its default shortcut' }))
    expect(onChange).toHaveBeenLastCalledWith(undefined)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: 'Reset all' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Clear the shortcut for Reply' }))
    expect(onChange).toHaveBeenLastCalledWith({ version: 1, bindings: { 'mail.reply': [] } })
    expect(screen.getByRole('button', { name: 'Clear the shortcut for Reply' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Reset all' }))
    expect(window.confirm).toHaveBeenCalled()
    expect(onChange).toHaveBeenLastCalledWith(undefined)
    expect(within(row('Reply')).getByText('Ctrl+R')).toBeInTheDocument()
  })
})
