// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MailPaneSeparator, useResizableMailPanes } from './MailPaneResizer'

const resize = vi.hoisted(() => ({ callbacks: [] as Array<() => void>, disconnect: vi.fn(), observe: vi.fn() }))
const storedValues = new Map<string, string>()
const storage = {
  getItem: vi.fn((key: string) => storedValues.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => { storedValues.set(key, value) }),
  removeItem: vi.fn((key: string) => { storedValues.delete(key) }),
  clear: vi.fn(() => storedValues.clear()),
  key: vi.fn((index: number) => [...storedValues.keys()][index] ?? null),
  get length() { return storedValues.size }
}

class FakeResizeObserver {
  constructor(callback: () => void) { resize.callbacks.push(callback) }
  observe = resize.observe
  disconnect = resize.disconnect
}

function Harness({ width = 1200 }: { width?: number }) {
  const panes = useResizableMailPanes()
  return <div
    data-testid="container"
    ref={(node) => {
      if (node) Object.defineProperty(node, 'clientWidth', { configurable: true, value: width })
      panes.containerRef.current = node
    }}
    style={panes.style}
  >
    <output data-testid="widths">{panes.widths.sidebar}:{panes.widths.list}</output>
    <MailPaneSeparator pane="sidebar" value={panes.widths.sidebar} onPointerDown={panes.startResize} onKeyDown={panes.resizeWithKeyboard} onReset={panes.resetWidths} />
    <MailPaneSeparator pane="list" value={panes.widths.list} onPointerDown={panes.startResize} onKeyDown={panes.resizeWithKeyboard} onReset={panes.resetWidths} />
  </div>
}

describe('mail pane resizing', () => {
  beforeEach(() => {
    storedValues.clear()
    vi.stubGlobal('localStorage', storage)
    Object.defineProperty(window, 'localStorage', { configurable: true, value: storage })
    resize.callbacks.length = 0
    resize.disconnect.mockClear()
    resize.observe.mockClear()
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  })

  it('loads defaults, publishes CSS variables, semantics, and persistent widths', async () => {
    render(<Harness />)
    expect(screen.getByTestId('widths')).toHaveTextContent('220:380')
    const [sidebar, list] = screen.getAllByRole('separator')
    expect(sidebar).toHaveAccessibleName('Resize mail folders')
    expect(sidebar).toHaveAttribute('aria-valuemin', '160')
    expect(sidebar).toHaveAttribute('aria-valuemax', '420')
    expect(list).toHaveAccessibleName('Resize message list')
    expect(list).toHaveAttribute('aria-valuemin', '280')
    expect(list).toHaveAttribute('aria-valuemax', '720')
    expect(screen.getByTestId('container').style.getPropertyValue('--mail-sidebar-width')).toBe('220px')
    await waitFor(() => expect(localStorage.getItem('aerio:mail-pane-widths:v1')).toBe('{"sidebar":220,"list":380}'))
    expect(resize.observe).toHaveBeenCalledWith(screen.getByTestId('container'))
  })

  it('loads valid preferences but replaces malformed, partial, and non-finite values', () => {
    localStorage.setItem('aerio:mail-pane-widths:v1', '{"sidebar":300,"list":500}')
    const first = render(<Harness />)
    expect(screen.getByTestId('widths')).toHaveTextContent('300:500')
    first.unmount()

    for (const value of ['not json', '{"sidebar":300}', '{"sidebar":null,"list":400}']) {
      localStorage.setItem('aerio:mail-pane-widths:v1', value)
      const view = render(<Harness />)
      expect(screen.getByTestId('widths')).toHaveTextContent('220:380')
      view.unmount()
    }
  })

  it('resizes both panes with the keyboard and ignores unrelated keys', () => {
    render(<Harness />)
    const [sidebar, list] = screen.getAllByRole('separator')
    fireEvent.keyDown(sidebar, { key: 'ArrowRight' })
    expect(screen.getByTestId('widths')).toHaveTextContent('236:380')
    fireEvent.keyDown(sidebar, { key: 'ArrowLeft' })
    expect(screen.getByTestId('widths')).toHaveTextContent('220:380')
    fireEvent.keyDown(list, { key: 'ArrowRight' })
    expect(screen.getByTestId('widths')).toHaveTextContent('220:396')
    fireEvent.keyDown(list, { key: 'A' })
    expect(screen.getByTestId('widths')).toHaveTextContent('220:396')
  })

  it('clamps keyboard changes to pane and reader limits', () => {
    localStorage.setItem('aerio:mail-pane-widths:v1', '{"sidebar":420,"list":720}')
    render(<Harness width={900} />)
    expect(screen.getByTestId('widths')).toHaveTextContent('248:280')
    const [sidebar, list] = screen.getAllByRole('separator')
    for (let index = 0; index < 20; index++) fireEvent.keyDown(sidebar, { key: 'ArrowLeft' })
    expect(screen.getByTestId('widths')).toHaveTextContent('160:280')
    for (let index = 0; index < 40; index++) fireEvent.keyDown(list, { key: 'ArrowRight' })
    expect(screen.getByTestId('widths')).toHaveTextContent('160:368')
  })

  it('drags, replaces active drags, and finishes on pointer up or cancellation', () => {
    render(<Harness />)
    const [sidebar, list] = screen.getAllByRole('separator')
    fireEvent.pointerDown(sidebar, { clientX: 100 })
    expect(document.body).toHaveClass('resizing-mail-panes')
    fireEvent.pointerMove(window, { clientX: 150 })
    expect(screen.getByTestId('widths')).toHaveTextContent('270:380')

    fireEvent.pointerDown(list, { clientX: 200 })
    fireEvent.pointerMove(window, { clientX: 240 })
    expect(screen.getByTestId('widths')).toHaveTextContent('270:420')
    fireEvent.pointerCancel(window)
    expect(document.body).not.toHaveClass('resizing-mail-panes')

    fireEvent.pointerDown(sidebar, { clientX: 100 })
    fireEvent.pointerUp(window)
    expect(document.body).not.toHaveClass('resizing-mail-panes')
  })

  it('fits widths after container resizes and resets on double click', async () => {
    localStorage.setItem('aerio:mail-pane-widths:v1', '{"sidebar":400,"list":650}')
    const { rerender } = render(<Harness width={1400} />)
    expect(screen.getByTestId('widths')).toHaveTextContent('400:628')
    rerender(<Harness width={800} />)
    resize.callbacks.at(-1)?.()
    await waitFor(() => expect(screen.getByTestId('widths')).toHaveTextContent('160:280'))
    fireEvent.doubleClick(screen.getAllByRole('separator')[0])
    expect(screen.getByTestId('widths')).toHaveTextContent('160:280')
  })

  it('cleans up observers and active pointer listeners on unmount', () => {
    const view = render(<Harness />)
    fireEvent.pointerDown(screen.getAllByRole('separator')[0], { clientX: 1 })
    view.unmount()
    expect(resize.disconnect).toHaveBeenCalledOnce()
    expect(document.body).not.toHaveClass('resizing-mail-panes')
  })

  it('forwards separator callbacks with the pane identity', () => {
    const pointer = vi.fn()
    const keyboard = vi.fn()
    const reset = vi.fn()
    render(<MailPaneSeparator pane="list" value={401.7} onPointerDown={pointer} onKeyDown={keyboard} onReset={reset} />)
    const separator = screen.getByRole('separator')
    expect(separator).toHaveAttribute('aria-valuenow', '402')
    fireEvent.pointerDown(separator)
    fireEvent.keyDown(separator, { key: 'ArrowRight' })
    fireEvent.doubleClick(separator)
    expect(pointer.mock.calls[0][0]).toBe('list')
    expect(keyboard.mock.calls[0][0]).toBe('list')
    expect(reset).toHaveBeenCalledOnce()
  })
})
