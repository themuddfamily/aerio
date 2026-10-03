import { describe, expect, it, vi } from 'vitest'
import type { App, MenuItemConstructorOptions } from 'electron'
import { applicationMenuTemplate, registerMacLoginItem } from './mac-integration'

describe('macOS native integration policy', () => {
  it('provides native application/editing/window roles and a workspace reopen action', () => {
    const reopen = vi.fn()
    const template = applicationMenuTemplate('darwin', reopen)!
    expect(template.some((item) => item.role === 'appMenu')).toBe(true)
    expect(template.some((item) => item.role === 'editMenu')).toBe(true)
    const windows = template.find((item) => item.role === 'windowMenu')!.submenu as MenuItemConstructorOptions[]
    expect(windows.map((item) => item.role).filter(Boolean)).toEqual(['minimize', 'zoom', 'front', 'close'])
    windows.find((item) => item.id === 'aerio-open')!.click!(undefined as never, undefined as never, undefined as never)
    expect(reopen).toHaveBeenCalledOnce()
    const view = template.find((item) => item.label === 'View')!.submenu as MenuItemConstructorOptions[]
    expect(view.map((item) => item.role).filter(Boolean)).toEqual(['resetZoom', 'zoomIn', 'zoomOut', 'togglefullscreen'])
  })
  it.each(['win32', 'linux'] as const)('preserves the frameless menu policy on %s', (platform) => {
    expect(applicationMenuTemplate(platform, vi.fn())).toBeNull()
  })
  function application(openAtLogin: boolean, status: string) {
    return { setLoginItemSettings: vi.fn(), getLoginItemSettings: vi.fn(() => ({ openAtLogin, status })) } as unknown as Pick<App, 'setLoginItemSettings' | 'getLoginItemSettings'>
  }
  it('records a successful native registration without unsupported Windows arguments', () => {
    const app = application(true, 'enabled')
    registerMacLoginItem(app, true)
    expect(app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true })
  })
  it.each([[false, 'not-registered'], [false, 'not-found'], [false, 'requires-approval'], [true, 'requires-approval']])('refuses silent or unapproved registration: %j/%s', (open, status) => {
    expect(() => registerMacLoginItem(application(Boolean(open), String(status)), true)).toThrow('macOS has not enabled')
  })
  it('verifies removal and propagates a removal failure', () => {
    registerMacLoginItem(application(false, 'not-registered'), false)
    expect(() => registerMacLoginItem(application(true, 'enabled'), false)).toThrow('could not remove')
  })
  it('removes a newly pending registration instead of leaving an unsaved native item behind', () => {
    const app = application(false, 'not-registered')
    vi.mocked(app.getLoginItemSettings)
      .mockReturnValueOnce({ openAtLogin: false, status: 'not-registered' } as ReturnType<App['getLoginItemSettings']>)
      .mockReturnValueOnce({ openAtLogin: true, status: 'requires-approval' } as ReturnType<App['getLoginItemSettings']>)
    expect(() => registerMacLoginItem(app, true)).toThrow('macOS has not enabled')
    expect(app.setLoginItemSettings).toHaveBeenNthCalledWith(1, { openAtLogin: true })
    expect(app.setLoginItemSettings).toHaveBeenNthCalledWith(2, { openAtLogin: false })
  })
  it('restores the prior state after a status-query failure and preserves that failure if cleanup also fails', () => {
    const app = application(false, 'not-registered')
    vi.mocked(app.getLoginItemSettings)
      .mockReturnValueOnce({ openAtLogin: false, status: 'not-registered' } as ReturnType<App['getLoginItemSettings']>)
      .mockImplementationOnce(() => { throw new Error('Native status query failed') })
    vi.mocked(app.setLoginItemSettings).mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error('Cleanup failed') })
    expect(() => registerMacLoginItem(app, true)).toThrow('Native status query failed')
    expect(app.setLoginItemSettings).toHaveBeenNthCalledWith(2, { openAtLogin: false })
  })
})
