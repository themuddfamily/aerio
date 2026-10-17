import { describe, expect, it } from 'vitest'
import { inlineImageBytes, isAllowedLink, isValidContentId, parseDataImage, sanitizeStyle } from './mail-rich-text'

describe('rich-text style allowlist', () => {
  it('keeps formatting declarations and drops layout, Office, and unknown properties', () => {
    expect(sanitizeStyle('color: #c0392b; background-color: rgb(255, 245, 157); font-family: Georgia, "Times New Roman", serif; font-size: 14pt'))
      .toBe('color: #c0392b; background-color: rgb(255, 245, 157); font-family: Georgia, "Times New Roman", serif; font-size: 14pt')
    expect(sanitizeStyle('FONT-WEIGHT: bold; font-style: italic; text-decoration: underline line-through; text-align: center !important'))
      .toBe('font-weight: bold; font-style: italic; text-decoration: underline line-through; text-align: center')
    expect(sanitizeStyle('border: 1px solid #ccc; border-collapse: collapse; padding: 4px 8px; width: 100%; max-width: 600px'))
      .toBe('border: 1px solid #ccc; border-collapse: collapse; padding: 4px 8px; width: 100%; max-width: 600px')
    expect(sanitizeStyle('mso-list: l0 level1; position: fixed; display: none; margin: 0in; color: red')).toBe('color: red')
    expect(sanitizeStyle('font-size: 12px; width: calc(100% - 1px); color: red red')).toBe('font-size: 12px')
  })

  it('refuses any style that could fetch or execute', () => {
    for (const style of ['background-color: red; background: url(https://tracker.test/x)', 'width: expression(alert(1))', 'color: \\72 ed', 'color: red; @import x', 'color: red /* x */', 'color: javascript:alert(1)']) {
      expect(sanitizeStyle(style)).toBe('')
    }
  })

  it('accepts only absolute web and mail links, raster data images, and well-formed Content-IDs', () => {
    expect(isAllowedLink('https://example.test')).toBe(true)
    expect(isAllowedLink(' mailto:a@example.test')).toBe(true)
    expect(isAllowedLink('javascript:alert(1)')).toBe(false)
    expect(isAllowedLink('/relative')).toBe(false)
    expect(parseDataImage('data:image/png;base64,AAAA')).toEqual({ mimeType: 'image/png', base64: 'AAAA', bytes: 3 })
    expect(parseDataImage('data:image/svg+xml;base64,AAAA')).toBeUndefined()
    expect(parseDataImage('data:image/png,raw')).toBeUndefined()
    expect(isValidContentId('abc-1@aerio.local')).toBe(true)
    expect(isValidContentId('bad id@x')).toBe(false)
    expect(isValidContentId('<a@b>')).toBe(false)
  })

  it('counts embedded image bytes in a draft body', () => {
    expect(inlineImageBytes(undefined)).toBe(0)
    expect(inlineImageBytes('<img src="data:image/png;base64,AAAAAA=="><img src=\'data:image/gif;base64,AAAA\'><img src="https://x.test/a.png">')).toBe(4 + 3)
  })
})
