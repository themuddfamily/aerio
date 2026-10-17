import { describe, expect, it } from 'vitest'
import { DAV_PRESETS, davPreset, davServiceRoots, isLoopbackHost, normalizeDavUrl } from './dav-presets'

describe('DAV presets and server addresses', () => {
  it('uses fixed hosts for iCloud and Fastmail', () => {
    expect(davServiceRoots('icloud')).toEqual({ calendar: ['https://caldav.icloud.com/'], contacts: ['https://contacts.icloud.com/'] })
    expect(davServiceRoots('fastmail')).toEqual({ calendar: ['https://caldav.fastmail.com/'], contacts: ['https://carddav.fastmail.com/'] })
    expect(DAV_PRESETS.map((preset) => preset.id)).toEqual(['icloud', 'fastmail', 'nextcloud', 'generic'])
    expect(davPreset('nope' as never).id).toBe('generic')
  })

  it('adds the Nextcloud remote.php/dav root unless it was given', () => {
    expect(davServiceRoots('nextcloud', 'cloud.example.com')).toEqual({
      calendar: ['https://cloud.example.com/', 'https://cloud.example.com/remote.php/dav/'],
      contacts: ['https://cloud.example.com/', 'https://cloud.example.com/remote.php/dav/']
    })
    expect(davServiceRoots('nextcloud', 'https://cloud.example.com/nc/remote.php/dav').calendar).toEqual(['https://cloud.example.com/nc/remote.php/dav'])
    expect(davServiceRoots('generic', 'https://dav.example.com/dav/').calendar).toEqual(['https://dav.example.com/dav/'])
  })

  it('requires HTTPS except on loopback and refuses embedded credentials', () => {
    expect(normalizeDavUrl(' https://dav.example.com/x?y=1#z ')).toBe('https://dav.example.com/x')
    expect(normalizeDavUrl('http://127.0.0.1:5232/')).toBe('http://127.0.0.1:5232/')
    expect(normalizeDavUrl('http://localhost:5232/')).toBe('http://localhost:5232/')
    expect(normalizeDavUrl('http://[::1]:5232/')).toBe('http://[::1]:5232/')
    expect(() => normalizeDavUrl('http://dav.example.com/')).toThrow(/https/)
    expect(() => normalizeDavUrl('http://127.0.0.1.example.com/')).toThrow(/https/)
    expect(() => normalizeDavUrl('ftp://dav.example.com/')).toThrow(/valid https/)
    expect(() => normalizeDavUrl('https://u:p@dav.example.com/')).toThrow(/Remove the user name/)
    expect(() => normalizeDavUrl('')).toThrow(/Enter a server/)
    expect(() => normalizeDavUrl('https://')).toThrow(/valid https/)
    expect(() => davServiceRoots('generic')).toThrow(/Enter a server/)
    expect(isLoopbackHost('127.10.0.1')).toBe(true)
  })
})
