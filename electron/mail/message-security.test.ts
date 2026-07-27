import { describe, expect, it } from 'vitest'
import { sanitizeMessageHtml } from './message-security'

describe('sanitizeMessageHtml', () => {
  it('removes active content and blocks tracking images by default', () => {
    const result = sanitizeMessageHtml('<script>alert(1)</script><a href="javascript:alert(2)">bad</a><img src="https://tracker.example/pixel">')
    expect(result).not.toContain('<script')
    expect(result).not.toContain('javascript:')
    expect(result).not.toContain('tracker.example')
    expect(result).toContain('remote-image-blocked')
  })

  it('routes user-approved remote images through the isolated protocol', () => {
    const result = sanitizeMessageHtml('<img src="https://images.example/photo.png">', true)
    expect(result).toContain('aerio-image://fetch/')
    expect(result).not.toContain('src="https://')
  })
})
