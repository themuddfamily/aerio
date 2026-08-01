import { describe, expect, it } from 'vitest'
import { sanitizeMessageHtml } from './message-security'

describe('sanitizeMessageHtml', () => {
  it('removes active content and blocks tracking images by default', () => {
    const result = sanitizeMessageHtml('<script>alert(1)</script><a href="javascript:alert(2)">bad</a><img src="https://tracker.example/pixel">')
    expect(result).not.toContain('<script')
    expect(result).not.toContain('javascript:')
    expect(result).not.toContain('tracker.example')
    expect(result).toContain('remote-image-blocked')
    expect(result).toContain('Remote image blocked')
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
})
