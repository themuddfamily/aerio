// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useRef } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ContextMenuProvider,
  copyText,
  registerContextMenuDocument,
  useContextMenu,
  type ContextMenuItem
} from './ContextMenu'

function CustomMenu({ items, label = 'Actions' }: { items: ContextMenuItem[]; label?: string }) {
  const { showContextMenu, closeContextMenu } = useContextMenu()
  const trigger = useRef<HTMLButtonElement>(null)
  return <>
    <button ref={trigger} onContextMenu={(event) => showContextMenu(event, items, label)}>Open custom menu</button>
    <button onClick={closeContextMenu}>Close custom menu</button>
  </>
}

function renderProvider(node: React.ReactNode) {
  return render(<ContextMenuProvider>{node}</ContextMenuProvider>)
}

describe('ContextMenuProvider', () => {
  let writeText: ReturnType<typeof vi.fn>
  let readText: ReturnType<typeof vi.fn>
  let execCommand: ReturnType<typeof vi.fn>

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined)
    readText = vi.fn().mockResolvedValue('PASTE')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText, readText } })
    execCommand = vi.fn().mockReturnValue(true)
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })
    Object.defineProperty(document, 'queryCommandEnabled', { configurable: true, value: vi.fn().mockReturnValue(true) })
    vi.spyOn(window, 'open').mockImplementation(() => null)
  })

  it('requires consumers to be inside the provider', () => {
    const Consumer = () => { useContextMenu(); return null }
    expect(() => render(<Consumer />)).toThrow('useContextMenu must be used inside ContextMenuProvider')
  })

  it('renders item states, activates an item, and closes the menu', () => {
    const action = vi.fn()
    const disabled = vi.fn()
    const items: ContextMenuItem[] = [
      { label: 'Enabled', shortcut: 'Ctrl+E', action },
      { label: 'Checked', checked: true, separatorBefore: true, danger: true, action },
      { label: 'Disabled', disabled: true, action: disabled }
    ]
    renderProvider(<CustomMenu items={items} />)
    const trigger = screen.getByRole('button', { name: 'Open custom menu' })
    fireEvent.contextMenu(trigger, { clientX: 40, clientY: 60 })
    const menu = screen.getByRole('menu', { name: 'Actions' })
    expect(within(menu).getByText('Ctrl+E')).toBeInTheDocument()
    expect(within(menu).getByRole('menuitemcheckbox', { name: 'Checked' })).toHaveAttribute('aria-checked', 'true')
    expect(within(menu).getByRole('menuitemcheckbox', { name: 'Checked' })).toHaveClass('danger', 'separated')
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Disabled' }))
    expect(disabled).not.toHaveBeenCalled()
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Enabled/ }))
    expect(action).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('supports wraparound arrows, Home, End, Space, Enter, Escape, and Tab', async () => {
    const actions = [vi.fn(), vi.fn(), vi.fn()]
    renderProvider(<CustomMenu items={[
      { label: 'First', action: actions[0] },
      { label: 'Disabled', disabled: true, action: vi.fn() },
      { label: 'Last', action: actions[2] }
    ]} />)
    const trigger = screen.getByRole('button', { name: 'Open custom menu' })
    const reopen = () => fireEvent.contextMenu(trigger)

    reopen()
    let menu = screen.getByRole('menu')
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    fireEvent.keyDown(menu, { key: ' ' })
    expect(actions[2]).toHaveBeenCalledOnce()

    reopen()
    menu = screen.getByRole('menu')
    fireEvent.keyDown(menu, { key: 'End' })
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    fireEvent.keyDown(menu, { key: 'Enter' })
    expect(actions[0]).toHaveBeenCalledOnce()

    reopen()
    menu = screen.getByRole('menu')
    fireEvent.keyDown(menu, { key: 'End' })
    fireEvent.keyDown(menu, { key: 'Home' })
    fireEvent.keyDown(menu, { key: 'Escape' })
    await waitFor(() => expect(trigger).toHaveFocus())

    reopen()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Tab' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('does not open empty menus and can be closed through the provider API', () => {
    renderProvider(<CustomMenu items={[]} />)
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open custom menu' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    // Rerender with a real item using a second provider instance.
    renderProvider(<CustomMenu items={[{ label: 'One', action: vi.fn() }]} label="Second" />)
    const triggers = screen.getAllByRole('button', { name: 'Open custom menu' })
    fireEvent.contextMenu(triggers[1])
    expect(screen.getByRole('menu', { name: 'Second' })).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: 'Close custom menu' })[1])
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('dismisses on pointer, right-click, blur, resize, and armed scrolling', async () => {
    vi.useFakeTimers()
    renderProvider(<CustomMenu items={[{ label: 'One', action: vi.fn() }]} />)
    const trigger = screen.getByRole('button', { name: 'Open custom menu' })
    const open = () => fireEvent.contextMenu(trigger)

    open()
    fireEvent.pointerDown(screen.getByRole('menu'))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    open()
    fireEvent.pointerDown(document.body, { button: 2 })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    open()
    fireEvent(window, new Event('blur'))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    open()
    fireEvent(window, new Event('resize'))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    open()
    fireEvent.scroll(window)
    expect(screen.getByRole('menu')).toBeInTheDocument()
    await vi.advanceTimersByTimeAsync(151)
    fireEvent.scroll(window)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    vi.useRealTimers()
  })

  it('offers full editing actions for selected input text', async () => {
    const { container } = renderProvider(<input defaultValue="hello world" />)
    const input = container.querySelector('input')!
    input.focus()
    input.setSelectionRange(0, 5)
    fireEvent.contextMenu(input)
    expect(screen.getByRole('menu')).toHaveAccessibleName('Edit')
    expect(screen.getByRole('menuitem', { name: /Undo/ })).toBeEnabled()
    expect(screen.getByRole('menuitem', { name: /Redo/ })).toBeEnabled()
    fireEvent.click(screen.getByRole('menuitem', { name: /Copy/ }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('hello'))

    input.setSelectionRange(0, 5)
    fireEvent.contextMenu(input)
    fireEvent.click(screen.getByRole('menuitem', { name: /Cut/ }))
    await waitFor(() => expect(input).toHaveValue(' world'))

    input.setSelectionRange(0, 0)
    fireEvent.contextMenu(input)
    fireEvent.click(screen.getByRole('menuitem', { name: /Paste/ }))
    await waitFor(() => expect(input).toHaveValue('PASTE world'))

    input.setSelectionRange(0, 5)
    fireEvent.contextMenu(input)
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete/ }))
    expect(input).toHaveValue(' world')

    fireEvent.contextMenu(input)
    fireEvent.click(screen.getByRole('menuitem', { name: /Select all/ }))
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(input.value.length)

    fireEvent.contextMenu(input)
    fireEvent.click(screen.getByRole('menuitem', { name: /Undo/ }))
    expect(execCommand).toHaveBeenCalledWith('undo')
    fireEvent.contextMenu(input)
    fireEvent.click(screen.getByRole('menuitem', { name: /Redo/ }))
    expect(execCommand).toHaveBeenCalledWith('redo')
  })

  it('disables mutations for read-only fields and contains clipboard failures', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'))
    readText.mockRejectedValueOnce(new Error('denied'))
    const { container } = renderProvider(<><input defaultValue="secret" readOnly /><textarea defaultValue="notes" /></>)
    const input = container.querySelector('input')!
    input.setSelectionRange(0, 6)
    fireEvent.contextMenu(input)
    expect(screen.getByRole('menuitem', { name: /Cut/ })).toBeDisabled()
    expect(screen.getByRole('menuitem', { name: /Paste/ })).toBeDisabled()
    fireEvent.click(screen.getByRole('menuitem', { name: /Copy/ }))
    await waitFor(() => expect(writeText).toHaveBeenCalled())

    const textarea = container.querySelector('textarea')!
    fireEvent.contextMenu(textarea)
    fireEvent.click(screen.getByRole('menuitem', { name: /Paste/ }))
    await Promise.resolve()
    expect(textarea).toHaveValue('notes')
  })

  it('handles contenteditable selection and commands', () => {
    const { container } = renderProvider(<div contentEditable>editable</div>)
    const editable = container.querySelector('[contenteditable]') as HTMLElement
    Object.defineProperty(editable, 'isContentEditable', { configurable: true, value: true })
    vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => 'edit' } as Selection)
    fireEvent.contextMenu(editable)
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete/ }))
    expect(execCommand).toHaveBeenCalledWith('insertText', false, '')

    fireEvent.contextMenu(editable)
    fireEvent.click(screen.getByRole('menuitem', { name: /Select all/ }))
    expect(execCommand).toHaveBeenCalledWith('selectAll')
  })

  it('provides image and linked-image actions using decoded original sources', async () => {
    const original = 'https://images.example.test/photo.png'
    const encoded = btoa(original).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const { container } = renderProvider(<a href="https://link.example.test"><img src={`aerio-image://fetch/${encoded}`} alt="A photo" /></a>)
    fireEvent.contextMenu(container.querySelector('img')!)
    const menu = screen.getByRole('menu', { name: 'A photo' })
    expect(within(menu).getByRole('menuitem', { name: 'Open image' })).toBeEnabled()
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Copy image address' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(original))

    fireEvent.contextMenu(container.querySelector('img')!)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy alt text' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('A photo'))

    fireEvent.contextMenu(container.querySelector('img')!)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open link' }))
    expect(anchorClick).toHaveBeenCalled()

    fireEvent.contextMenu(container.querySelector('img')!)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy link' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://link.example.test/'))
  })

  it('handles plain and malformed image sources', () => {
    const { container } = renderProvider(<><img src="https://example.test/image.png" alt="" /><img src="aerio-image://fetch/%" alt="broken" /></>)
    const images = container.querySelectorAll('img')
    fireEvent.contextMenu(images[0])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open image' }))
    expect(window.open).toHaveBeenCalledWith('https://example.test/image.png', '_blank', 'noopener')

    fireEvent.contextMenu(images[1])
    expect(screen.getByRole('menuitem', { name: 'Open image' })).toBeDisabled()
  })

  it('offers link and selected-text menus and ignores an unselected page', async () => {
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const { container } = renderProvider(<><a href="https://example.test/path">Example</a><p>Selected text</p><div>Nothing</div></>)
    const anchor = container.querySelector('a')!
    fireEvent.contextMenu(anchor)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open link' }))
    expect(anchorClick).toHaveBeenCalled()
    fireEvent.contextMenu(anchor)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy link' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://example.test/path'))

    vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => ' Selected text ' } as Selection)
    fireEvent.contextMenu(container.querySelector('p')!)
    expect(screen.getByRole('menu')).toHaveAccessibleName('Selected text')
    fireEvent.click(screen.getByRole('menuitem', { name: /Copy/ }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Selected text'))

    vi.mocked(window.getSelection).mockReturnValue({ toString: () => ' ' } as Selection)
    fireEvent.contextMenu(container.querySelector('div')!)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('opens native menus from the keyboard for the focused element', async () => {
    const { container } = renderProvider(<input defaultValue="keyboard" />)
    const input = container.querySelector('input')!
    input.focus()
    input.setSelectionRange(0, 4)
    fireEvent.keyDown(window, { key: 'F10', shiftKey: true })
    expect(screen.getByRole('menu')).toHaveAccessibleName('Edit')
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    await waitFor(() => expect(input).toHaveFocus())

    fireEvent.keyDown(window, { key: 'ContextMenu' })
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'A' })
  })

  it('registers and unregisters additional menu documents', () => {
    const other = document.implementation.createHTMLDocument('Other')
    const unregisterBefore = registerContextMenuDocument(other)
    const { unmount } = renderProvider(<span>Child</span>)
    const unregisterAfter = registerContextMenuDocument(document)
    unregisterAfter()
    unregisterBefore()
    unmount()
  })

  it('exposes safe clipboard copying as a standalone helper', async () => {
    await copyText('copy me')
    expect(writeText).toHaveBeenCalledWith('copy me')
    writeText.mockRejectedValueOnce(new Error('denied'))
    await expect(copyText('protected')).resolves.toBeUndefined()
  })

  it('ignores unsupported targets and handles disabled and number editors', async () => {
    const { container } = renderProvider(<><input type="checkbox" /><input type="text" disabled defaultValue="locked" /><input type="number" defaultValue="12" /></>)
    fireEvent.contextMenu(container.querySelector('input[type="checkbox"]')!)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    fireEvent.contextMenu(window)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    const disabled = container.querySelector<HTMLInputElement>('input[disabled]')!
    fireEvent.contextMenu(disabled)
    expect(screen.getByRole('menuitem', { name: /Paste/ })).toBeDisabled()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })

    const number = container.querySelector<HTMLInputElement>('input[type="number"]')!
    fireEvent.contextMenu(number)
    fireEvent.click(screen.getByRole('menuitem', { name: /Paste/ }))
    await waitFor(() => expect(number).toHaveValue(12))
  })

  it('contains keyboard navigation when every menu item is disabled', () => {
    renderProvider(<CustomMenu items={[
      { label: 'Unavailable one', disabled: true, checked: false, action: vi.fn() },
      { label: 'Unavailable two', disabled: true, action: vi.fn() }
    ]} />)
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open custom menu' }))
    const menu = screen.getByRole('menu')
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    fireEvent.keyDown(menu, { key: 'Home' })
    fireEvent.keyDown(menu, { key: 'End' })
    fireEvent.keyDown(menu, { key: 'Enter' })
    fireEvent.mouseEnter(screen.getByRole('menuitemcheckbox', { name: 'Unavailable one' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })
})
