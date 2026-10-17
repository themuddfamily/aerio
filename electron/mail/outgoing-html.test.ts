import { describe, expect, it } from 'vitest'
import { prepareOutgoingHtml } from './outgoing-html'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

describe('outgoing HTML', () => {
  it('keeps rich formatting, tables, alignment, and composer markers', () => {
    const { html, images } = prepareOutgoingHtml('<div style="text-align: center; position: fixed">Hi <span style="color: #c0392b; font-family: Georgia, serif; font-size: large">there</span> <font face="Verdana" color="red">old</font></div>' +
      '<table style="border-collapse: collapse; width: 100%"><tbody><tr><td style="border: 1px solid #c8c8c8; padding: 4px 8px" colspan="2">Cell</td></tr></tbody></table>' +
      '<div data-aerio-signature-spacer=""><br></div><div data-aerio-signature="sig-1">-- <br><b>Ada</b></div><div data-aerio-quote="forward">Quoted</div>')
    expect(images).toEqual([])
    expect(html).toBe('<div style="text-align: center">Hi <span style="color: #c0392b; font-family: Georgia, serif; font-size: large">there</span> <font face="Verdana" color="red">old</font></div>' +
      '<table style="border-collapse: collapse; width: 100%"><tbody><tr><td style="border: 1px solid #c8c8c8; padding: 4px 8px" colspan="2">Cell</td></tr></tbody></table>' +
      '<div data-aerio-signature-spacer=""><br /></div><div data-aerio-signature="sig-1">-- <br /><b>Ada</b></div><div data-aerio-quote="forward">Quoted</div>')
  })

  it('removes scripts, handlers, unsafe links, styles that fetch, and remote images', () => {
    const { html, images } = prepareOutgoingHtml('<p onclick="x()" class="a">Text<script>alert(1)</script><style>p{}</style><a href="javascript:alert(1)">bad</a><a href="https://ok.test" target="_blank">ok</a>' +
      '<span style="background: url(https://t.test/x)">u</span><img src="https://tracker.test/p.gif"><img src="cid:foreign@example.test"><img src="data:image/svg+xml;base64,AAAA"><iframe src="https://x.test"></iframe></p>')
    expect(html).toBe('<p>Text<a>bad</a><a href="https://ok.test">ok</a><span>u</span></p>')
    expect(images).toEqual([])
  })

  it('converts embedded images to Content-ID parts, reusing requested ids and de-duplicating identical images', () => {
    const { html, images } = prepareOutgoingHtml(`<p><img src="data:image/png;base64,${png}" alt="Logo" data-aerio-cid="logo-1@aerio.local" style="max-width: 100%">` +
      `<img src="data:image/png;base64,${png}" data-aerio-cid="other@aerio.local"><img src="data:image/jpeg;base64,/9j/AA==" data-aerio-cid="logo-1@aerio.local"><img src="data:image/gif;base64,R0lGOD==" data-aerio-cid="bad id"></p>`)
    expect(images.map((image) => [image.contentId.replace(/^[0-9a-f-]{36}/, 'uuid'), image.mimeType, image.filename])).toEqual([
      ['logo-1@aerio.local', 'image/png', 'image-1.png'],
      ['uuid@aerio.local', 'image/jpeg', 'image-2.jpg'],
      ['uuid@aerio.local', 'image/gif', 'image-3.gif']
    ])
    expect(images[0].content.subarray(1, 4).toString()).toBe('PNG')
    expect(html).toBe(`<p><img src="cid:logo-1@aerio.local" alt="Logo" style="max-width: 100%" /><img src="cid:logo-1@aerio.local" /><img src="cid:${images[1].contentId}" /><img src="cid:${images[2].contentId}" /></p>`)
    expect(html).not.toContain('data:')
    expect(html).not.toContain('data-aerio-cid')
  })
})
