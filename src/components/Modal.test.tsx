// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Modal, { ModalShell } from './Modal'

function fakePopout() {
  const childDocument = document.implementation.createHTMLDocument('Popout')
  const handlers = new Map<string, Array<() => void>>()
  const child = {
    document: childDocument,
    closed: false,
    focus: vi.fn(),
    close: vi.fn(function (this: { closed: boolean }) { this.closed = true }),
    addEventListener: vi.fn((event: string, handler: () => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
    }),
    removeEventListener: vi.fn((event: string, handler: () => void) => {
      handlers.set(event, (handlers.get(event) ?? []).filter((value) => value !== handler))
    }),
    emit(event: string) { for (const handler of handlers.get(event) ?? []) handler() }
  }
  return child
}

describe('Modal', () => {
  beforeEach(() => {
    document.documentElement.setAttribute('data-theme', 'dark')
    document.documentElement.setAttribute('data-density', 'compact')
    document.documentElement.lang = 'en-GB'
    window.focus = vi.fn()
  })

  afterEach(() => vi.useRealTimers())

  it('renders standard and custom headings and closes through all enabled routes', () => {
    const onClose = vi.fn()
    const { rerender } = render(<Modal title="Settings" subtitle="Preferences" width="small" onClose={onClose}><button>Child</button></Modal>)
    const dialog = screen.getByRole('dialog', { name: 'Settings' })
    expect(dialog).toHaveClass('modal-small')
    expect(screen.getByText('Preferences')).toBeInTheDocument()
    fireEvent.mouseDown(screen.getByText('Child'))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.mouseDown(dialog.parentElement!)
    expect(onClose).toHaveBeenCalledOnce()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(3)

    rerender(<ModalShell
      title="Custom" heading={<h1>Custom heading</h1>} className="special" backdropClassName="special-backdrop"
      closeTitle="Dismiss this" onClose={onClose}
    ><span>Body</span></ModalShell>)
    expect(screen.getByRole('dialog')).toHaveClass('special')
    expect(screen.getByRole('presentation')).toHaveClass('special-backdrop')
    expect(screen.getByTitle('Dismiss this')).toBeInTheDocument()
  })

  it('keeps a non-dismissible modal open', () => {
    const onClose = vi.fn()
    render(<Modal title="Busy" closeEnabled={false} onClose={onClose}>Working</Modal>)
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled()
    fireEvent.mouseDown(screen.getByRole('presentation'))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does nothing when the browser blocks a popout', () => {
    vi.spyOn(window, 'open').mockReturnValue(null)
    render(<Modal title="Blocked" onClose={vi.fn()}>Body</Modal>)
    fireEvent.click(screen.getByRole('button', { name: 'Pop out Blocked' }))
    expect(screen.getByRole('dialog', { name: 'Blocked' })).toBeInTheDocument()
  })

  it('prepares, portals, retitles, and docks a popout window', async () => {
    const child = fakePopout()
    vi.spyOn(window, 'open').mockReturnValue(child as unknown as Window)
    Object.defineProperties(window, {
      screenX: { configurable: true, value: 100 },
      screenY: { configurable: true, value: 50 },
      outerWidth: { configurable: true, value: 1200 },
      outerHeight: { configurable: true, value: 900 }
    })
    const style = document.createElement('style')
    style.textContent = '.modal { color: red }'
    document.head.append(style)
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = '/app.css'
    document.head.append(link)

    const { rerender } = render(<Modal title="Compose" width="large" onClose={vi.fn()}>Popped body</Modal>)
    fireEvent.click(screen.getByRole('button', { name: 'Pop out Compose' }))
    await waitFor(() => expect(child.document.body.textContent).toContain('Popped body'))
    expect(window.open).toHaveBeenCalledWith(
      'about:blank', expect.stringMatching(/^aerio-modal-/),
      expect.stringContaining('width=900,height=760,left=250,top=120')
    )
    expect(child.document.title).toBe('Compose — Aerio')
    expect(child.document.documentElement.lang).toBe('en-GB')
    expect(child.document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(child.document.documentElement.getAttribute('data-density')).toBe('compact')
    expect(child.document.body.classList.contains('modal-popout-host')).toBe(true)
    expect(child.document.head.querySelector('meta[charset="UTF-8"]')).toBeTruthy()
    expect(child.document.head.querySelectorAll('style, link[rel="stylesheet"]')).toHaveLength(2)
    expect(child.focus).toHaveBeenCalledOnce()

    rerender(<Modal title="New title" width="large" onClose={vi.fn()}>Popped body</Modal>)
    expect(child.document.title).toBe('New title — Aerio')
    const dockButton = child.document.querySelector<HTMLButtonElement>('button[aria-label="Return New title to main window"]')!
    dockButton.click()
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'New title' })).toBeInTheDocument())
    expect(child.close).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
  })

  it('uses explicit and small default popout dimensions', async () => {
    const explicit = fakePopout()
    const small = fakePopout()
    vi.spyOn(window, 'open').mockReturnValueOnce(explicit as unknown as Window).mockReturnValueOnce(small as unknown as Window)
    const first = render(<Modal title="Explicit" popoutSize={{ width: 600, height: 500 }} onClose={vi.fn()}>Body</Modal>)
    fireEvent.click(screen.getByRole('button', { name: 'Pop out Explicit' }))
    expect(window.open).toHaveBeenLastCalledWith('about:blank', expect.any(String), expect.stringContaining('width=600,height=500'))
    first.unmount()

    render(<Modal title="Small" width="small" onClose={vi.fn()}>Body</Modal>)
    fireEvent.click(screen.getByRole('button', { name: 'Pop out Small' }))
    expect(window.open).toHaveBeenLastCalledWith('about:blank', expect.any(String), expect.stringContaining('width=520,height=620'))
  })

  it('treats external popout closure as close or dock according to closeEnabled', async () => {
    const firstChild = fakePopout()
    const secondChild = fakePopout()
    vi.spyOn(window, 'open').mockReturnValueOnce(firstChild as unknown as Window).mockReturnValueOnce(secondChild as unknown as Window)
    const onClose = vi.fn()
    const first = render(<Modal title="Closable" onClose={onClose}>Body</Modal>)
    fireEvent.click(screen.getByRole('button', { name: 'Pop out Closable' }))
    firstChild.emit('beforeunload')
    expect(onClose).toHaveBeenCalledOnce()
    first.unmount()

    render(<Modal title="Locked" closeEnabled={false} onClose={onClose}>Body</Modal>)
    fireEvent.click(screen.getByRole('button', { name: 'Pop out Locked' }))
    secondChild.emit('beforeunload')
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Locked' })).toBeInTheDocument())
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('detects a popout that closes without beforeunload', async () => {
    vi.useFakeTimers()
    const child = fakePopout()
    vi.spyOn(window, 'open').mockReturnValue(child as unknown as Window)
    const onClose = vi.fn()
    render(<Modal title="Polled" onClose={onClose}>Body</Modal>)
    fireEvent.click(screen.getByRole('button', { name: 'Pop out Polled' }))
    child.closed = true
    await vi.advanceTimersByTimeAsync(250)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('uses appearance, language, position, and medium-size fallbacks safely', async () => {
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.removeAttribute('data-density')
    document.documentElement.lang = ''
    Object.defineProperties(window, {
      screenX: { configurable: true, value: -1_000 }, screenY: { configurable: true, value: -1_000 },
      outerWidth: { configurable: true, value: 200 }, outerHeight: { configurable: true, value: 200 }
    })
    const child = fakePopout()
    vi.spyOn(window, 'open').mockReturnValue(child as unknown as Window)
    render(<Modal title="Fallbacks" onClose={vi.fn()}>Body</Modal>)
    fireEvent.click(screen.getByRole('button', { name: 'Pop out Fallbacks' }))
    expect(window.open).toHaveBeenCalledWith('about:blank', expect.any(String), expect.stringContaining('width=720,height=760,left=0,top=0'))
    expect(child.document.documentElement.lang).toBe('en')
    expect(child.document.documentElement.hasAttribute('data-theme')).toBe(false)
    child.emit('beforeunload')
    child.emit('beforeunload')
  })

  it('ignores the close event produced while docking a popout', async () => {
    const child = fakePopout()
    child.close.mockImplementation(() => { child.closed = true; child.emit('beforeunload') })
    const onClose = vi.fn()
    vi.spyOn(window, 'open').mockReturnValue(child as unknown as Window)
    render(<Modal title="Dock safely" onClose={onClose}>Body</Modal>)
    fireEvent.click(screen.getByRole('button', { name: 'Pop out Dock safely' }))
    await waitFor(() => expect(child.document.body.textContent).toContain('Body'))
    child.document.querySelector<HTMLButtonElement>('button[aria-label="Return Dock safely to main window"]')!.click()
    expect(onClose).not.toHaveBeenCalled()
  })
})
