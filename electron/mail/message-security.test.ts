import { describe, expect, it, vi } from 'vitest'
import { sanitizeMessageHtml, sanitizeMessageHtmlWithReport } from './message-security'

describe('sanitizeMessageHtml', () => {
  it('removes active content and blocks tracking images by default', () => {
    const result = sanitizeMessageHtml('<script>alert(1)</script><a href="javascript:alert(2)">bad</a><img src="https://tracker.example/pixel">')
    expect(result).not.toContain('<script')
    expect(result).not.toContain('javascript:')
    expect(result).not.toContain('tracker.example')
    expect(result).toContain('remote-image-blocked')
    expect(result).toContain('Tracking image blocked')
  })

  it('preserves safe, clamped dimensions for blocked image placeholders', () => {
    const result = sanitizeMessageHtml('<img src="https://images.example/photo.png" alt="A wide photo" width="2400" height="900">')
    expect(result).toContain('--blocked-image-width:1600px')
    expect(result).toContain('--blocked-image-height:900px')
    expect(result).toContain('--blocked-image-aspect:1600/900')
    expect(result).toContain('aria-label="Remote image blocked: A wide photo"')
  })

  it('uses a compact placeholder for small images and ignores unsafe dimensions and styles', () => {
    const compact = sanitizeMessageHtml('<img src="https://images.example/icon.png" width="32" height="32">')
    const unsafe = sanitizeMessageHtml('<span style="position:fixed;width:99999px">Hello</span><img src="https://images.example/photo.png" width="calc(100vw)" height="-2">')
    expect(compact).toContain('remote-image-compact')
    expect(unsafe).not.toContain('position')
    expect(unsafe).not.toContain('99999')
    expect(unsafe).not.toContain('--blocked-image-')
  })

  it('routes user-approved remote images through the isolated protocol', () => {
    const result = sanitizeMessageHtml('<img src="https://images.example/photo.png">', true)
    expect(result).toContain('aerio-image://fetch/')
    expect(result).not.toContain('src="https://')
  })

  it('uses the safe link destination as the hover tooltip', () => {
    const result = sanitizeMessageHtml('<a href="https://example.com/account?tab=billing" title="Misleading title">Open account</a>')
    const blocked = sanitizeMessageHtml('<a href="javascript:alert(1)">Bad link</a>')

    expect(result).toContain('href="https://example.com/account?tab=billing"')
    expect(result).toContain('title="https://example.com/account?tab=billing"')
    expect(result).not.toContain('Misleading title')
    expect(blocked).toContain('href="#"')
    expect(blocked).toContain('title="#"')
  })

  it('handles partial, tracking, local, and missing image attributes', () => {
    const partial = sanitizeMessageHtml('<img src="https://images.example/wide.png" width="200"><img src="https://images.example/tall.png" height="300">')
    const tracker = sanitizeMessageHtml('<img src="https://images.example/pixel.gif" width="1" height="1">')
    const local = sanitizeMessageHtml('<img src="cid:logo"><img><a>Empty</a><a href="mailto:ada@example.com">Mail</a>', true)

    expect(partial).toContain('--blocked-image-width:200px')
    expect(partial).toContain('--blocked-image-height:300px')
    expect(tracker).toContain('remote-image-tracker')
    expect(local).toContain('src="cid:logo"')
    expect(local).toContain('href="#"')
    expect(local).toContain('href="mailto:ada@example.com"')
  })
})

describe('sanitizeMessageHtmlWithReport tracking protection', () => {
  const newsletter = [
    '<img src="https://images.example/hero.png" width="600" height="300" alt="Hero">',
    '<img src="https://open.example/o.gif" width="1" height="1">',
    '<img src="https://cdn.example/spacer.png" style="display:none">',
    '<img src="https://u1.ct.sendgrid.net/wf/open?upn=abc">',
    '<img src="https://u1.ct.sendgrid.net/wf/open?upn=def">'
  ].join('')

  it('reports remote images and groups suspected trackers by host while blocked', () => {
    const { html, remoteContent } = sanitizeMessageHtmlWithReport(newsletter)
    expect(html).not.toContain('aerio-image://fetch/')
    expect(remoteContent.remoteImages).toBe(5)
    expect(remoteContent.trackers).toEqual([
      { host: 'open.example', reasons: ['tiny-dimensions', 'tracking-path'], count: 1 },
      { host: 'cdn.example', reasons: ['hidden-style'], count: 1 },
      { host: 'u1.ct.sendgrid.net', reasons: ['known-tracker-host', 'tracking-path'], count: 2 }
    ])
  })

  it('keeps suspected trackers blocked when other remote images are permitted', () => {
    const { html, remoteContent } = sanitizeMessageHtmlWithReport(newsletter, true)
    const proxied = [...html.matchAll(/aerio-image:\/\/fetch\/([A-Za-z0-9_-]+)/g)].map((match) => Buffer.from(match[1], 'base64url').toString('utf8'))
    expect(proxied).toEqual(['https://images.example/hero.png'])
    expect(html.match(/remote-image-tracker/g)).toHaveLength(4)
    expect(html).toContain('Suspected tracking image blocked because it is served by a known email tracking service and its address looks like an open-tracking link')
    expect(html).toContain('Suspected tracking image blocked because it is styled to be hidden')
    expect(html).not.toContain('display:none')
    expect(remoteContent.trackers).toHaveLength(3)
  })

  it('never forwards untrusted image styles once remote images are permitted', () => {
    const { html } = sanitizeMessageHtmlWithReport('<img src="https://images.example/a.png" style="position:fixed" width="200" height="100">', true)
    expect(html).toContain('aerio-image://fetch/')
    expect(html).not.toContain('position')
  })

  it('does not report local or embedded images and does not fetch while classifying', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { remoteContent } = sanitizeMessageHtmlWithReport('<img src="cid:logo" width="1" height="1"><img src="data:image/gif;base64,R0lGOD" width="1" height="1">', true)
    sanitizeMessageHtmlWithReport(newsletter, true)
    expect(remoteContent).toEqual({ remoteImages: 0, trackers: [] })
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})
