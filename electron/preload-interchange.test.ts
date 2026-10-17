// @vitest-environment jsdom

import { beforeAll, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, Array<(...args: any[]) => void>>()
  return {
    exposed: {} as Record<string, any>,
    listeners,
    contextBridge: { exposeInMainWorld: vi.fn((name: string, value: any) => { mocks.exposed[name] = value }) },
    ipcRenderer: {
      invoke: vi.fn(async (channel: string, ...args: any[]) => ({ channel, args })),
      on: vi.fn((channel: string, listener: (...args: any[]) => void) => { listeners.set(channel, [...(listeners.get(channel) ?? []), listener]) }),
      removeListener: vi.fn()
    }
  }
})

vi.mock('electron', () => ({ contextBridge: mocks.contextBridge, ipcRenderer: mocks.ipcRenderer }))

import './preload'

describe('preload interchange bridge', () => {
  beforeAll(async () => { await Promise.resolve() })

  it('maps every interchange command to its IPC channel and forwards change events', async () => {
    const interchange = mocks.exposed.aerio.interchange
    await interchange.snapshot()
    await interchange.chooseCalendarFile()
    await interchange.chooseContactsFile()
    await interchange.exportCalendar(['calendar-1'])
    await interchange.exportContacts(['contact-1'], 'vcard4')
    await interchange.saveLocalEvents({ newCalendarName: 'Team' }, [{ id: 'event-1' }])
    await interchange.saveLocalEvent({ id: 'event-1' })
    await interchange.deleteLocalEvent('event-1')
    await interchange.subscribe({ url: 'webcal://example.test/a.ics' })
    await interchange.refresh('subscription-1')
    await interchange.removeCalendar('subscription-1')
    for (const call of [
      ['interchange:snapshot'], ['interchange:calendar-file-choose'], ['interchange:contacts-file-choose'],
      ['interchange:calendar-export', ['calendar-1']], ['interchange:contacts-export', ['contact-1'], 'vcard4'],
      ['interchange:local-events-save', { newCalendarName: 'Team' }, [{ id: 'event-1' }]], ['interchange:local-event-save', { id: 'event-1' }],
      ['interchange:local-event-delete', 'event-1'], ['interchange:subscribe', { url: 'webcal://example.test/a.ics' }],
      ['interchange:refresh', 'subscription-1'], ['interchange:calendar-remove', 'subscription-1']
    ]) expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith(...call)

    const changed = vi.fn()
    const stop = interchange.onChanged(changed)
    mocks.listeners.get('interchange:changed')?.[0]({}, { calendars: [], events: [] })
    expect(changed).toHaveBeenCalledWith({ calendars: [], events: [] })
    stop()
    expect(mocks.ipcRenderer.removeListener).toHaveBeenCalledWith('interchange:changed', expect.any(Function))
  })
})
