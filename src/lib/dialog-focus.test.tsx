// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react'
import { useDialogFocus } from './dialog-focus'
import { fireEvent } from '@testing-library/dom'
import { describe, expect, it, vi } from 'vitest'

function Harness({
  onClose,
  active = true,
  closeEnabled = true,
  children
}: {
  onClose: () => void
  active?: boolean
  closeEnabled?: boolean
  children?: React.ReactNode
}) {
  const ref = useDialogFocus<HTMLDivElement>(onClose, active, closeEnabled)
  return <div ref={ref} role="dialog" tabIndex={-1}>{children}</div>
}

function visible(element: Element) {
  Object.defineProperty(element, 'getClientRects', { configurable: true, value: () => [{ width: 10, height: 10 }] })
}

describe('useDialogFocus', () => {
  it('focuses autofocus, the first control, or the dialog itself', async () => {
    const first = render(<Harness onClose={vi.fn()}><button>First</button><button autoFocus>Preferred</button></Harness>)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preferred' })).toHaveFocus())
    first.unmount()

    const second = render(<Harness onClose={vi.fn()}><button>First</button></Harness>)
    await waitFor(() => expect(screen.getByRole('button', { name: 'First' })).toHaveFocus())
    second.unmount()

    render(<Harness onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveFocus())
  })

  it('does not manage focus while inactive', async () => {
    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()
    render(<Harness onClose={vi.fn()} active={false}><button>Inside</button></Harness>)
    await Promise.resolve()
    expect(outside).toHaveFocus()
    outside.remove()
  })

  it('closes on Escape using the latest callback and close-enabled value', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = render(<Harness onClose={first}><button>Inside</button></Harness>)
    rerender(<Harness onClose={second} closeEnabled={false}><button>Inside</button></Harness>)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(first).not.toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()

    rerender(<Harness onClose={second}><button>Inside</button></Harness>)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(second).toHaveBeenCalledOnce()
  })

  it('ignores keys originating in a context menu', () => {
    const onClose = vi.fn()
    render(<Harness onClose={onClose}><div role="menu"><button>Menu action</button></div></Harness>)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Menu action' }), { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('wraps Tab focus between visible controls in both directions', () => {
    render(<><button>Outside</button><Harness onClose={vi.fn()}><button>First</button><button aria-hidden="true">Hidden</button><button>Last</button></Harness></>)
    const first = screen.getByRole('button', { name: 'First' })
    const last = screen.getByRole('button', { name: 'Last' })
    visible(first)
    visible(last)

    last.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(first).toHaveFocus()
    first.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(last).toHaveFocus()

    screen.getByRole('button', { name: 'Outside' }).focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(first).toHaveFocus()
    screen.getByRole('button', { name: 'Outside' }).focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(last).toHaveFocus()
  })

  it('keeps Tab on a dialog without visible controls and ignores other keys', () => {
    render(<Harness onClose={vi.fn()}><button>Invisible in jsdom</button></Harness>)
    const dialog = screen.getByRole('dialog')
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(dialog).toHaveFocus()
    fireEvent.keyDown(document, { key: 'A' })
    expect(dialog).toHaveFocus()
  })

  it('restores the previously focused element after unmount', async () => {
    const outside = document.createElement('button')
    outside.textContent = 'Previous'
    document.body.append(outside)
    outside.focus()
    const view = render(<Harness onClose={vi.fn()}><button>Inside</button></Harness>)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Inside' })).toHaveFocus())
    view.unmount()
    await waitFor(() => expect(outside).toHaveFocus())
    outside.remove()
  })
})
