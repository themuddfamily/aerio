import { describe, expect, it } from 'vitest'
import { linuxTrayHostAvailable } from './tray-availability'

describe('Linux tray host availability', () => {
  it('requires an explicitly registered StatusNotifier host', async () => {
    expect(await linuxTrayHostAvailable(async () => '(<true>,)\n')).toBe(true)
  })
  it.each(['(<false>,)', '', 'true', '(<true>,)\nother', '(<"true">,)'])('refuses an absent or malformed host reply: %j', async (reply) => {
    expect(await linuxTrayHostAvailable(async () => reply)).toBe(false)
  })
  it('keeps a usable taskbar path if D-Bus or the probe executable fails', async () => {
    expect(await linuxTrayHostAvailable(async () => { throw new Error('Missing host/tool or timeout') })).toBe(false)
  })
})
