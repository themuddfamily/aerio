// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const rootMocks = vi.hoisted(() => ({
  render: vi.fn(),
  createRoot: vi.fn(() => ({ render: rootMocks.render }))
}))

vi.mock('react-dom/client', () => ({ default: { createRoot: rootMocks.createRoot } }))
vi.mock('./App', () => ({ default: () => <div>Application root</div> }))
vi.mock('./views/MessageWindow', () => ({ default: () => <div>Message window root</div> }))

async function start(search = '') {
  window.history.replaceState({}, '', `/${search}`)
  document.body.innerHTML = '<div id="root"></div>'
  vi.resetModules()
  await import('./main')
  const tree = rootMocks.render.mock.calls.at(-1)?.[0]
  render(tree)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('renderer entry point', () => {
  it('mounts the main application by default', async () => {
    await start()
    expect(rootMocks.createRoot).toHaveBeenCalledWith(document.getElementById('root'))
    expect(screen.getByText('Application root')).toBeInTheDocument()
  })

  it('mounts the standalone reader for message-window URLs', async () => {
    await start('?view=message')
    expect(screen.getByText('Message window root')).toBeInTheDocument()
  })
})
