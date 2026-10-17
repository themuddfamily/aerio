// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { inlineImageHtml, parseTableSize, sanitizePastedHtml, tableHtml } from './mail-paste'

const clean = (html: string, keepMarkers = false) => sanitizePastedHtml(html, document, { keepMarkers })

describe('pasted HTML sanitizer', () => {
  it('strips Word and Office cruft while keeping formatting, alignment, and tables', () => {
    const word = `<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta name=Generator content="Microsoft Word 15"><style>p.MsoNormal{margin:0}</style><!--[if gte mso 9]><xml><o:OfficeDocumentSettings/></xml><![endif]--></head>
<body><!--StartFragment--><p class=MsoNormal align=center style='margin:0in;text-align:center;mso-line-height-alt:12pt'><b><span style='font-family:"Calibri",sans-serif;color:#C00000;mso-fareast-font-family:Calibri'>Hello</span></b><o:p></o:p></p>
<p class=MsoListParagraph style='mso-list:l0 level1 lfo1'><![if !supportLists]><span style='mso-list:Ignore'>·<span>&nbsp;</span></span><![endif]>Item</p>
<table class=MsoTableGrid border=1 cellpadding=0 style='border-collapse:collapse;mso-yfti-tbllook:1184'><tr><td width=200 valign=top style='border:solid windowtext 1.0pt;padding:0in 5.4pt'>Cell</td></tr></table><!--EndFragment--></body></html>`
    const html = clean(word)
    expect(html).toContain('<p align="center" style="text-align: center"><b><span style="font-family: &quot;Calibri&quot;,sans-serif; color: #C00000">Hello</span></b></p>')
    expect(html).toContain('<p>Item</p>')
    expect(html).toContain('<table border="1" cellpadding="0" style="border-collapse: collapse"><tbody><tr><td width="200" valign="top" style="border: solid windowtext 1.0pt; padding: 0in 5.4pt">Cell</td></tr></tbody></table>')
    expect(html).not.toMatch(/mso|class=|<o:p|<style|<meta|<xml|<!--|·/i)
  })

  it('removes scripts, handlers, unsafe links, and remote or file images', () => {
    const html = clean('<div onclick="x()" id="a">Hi<script>alert(1)</script><iframe src="https://x.test"></iframe><a href="javascript:alert(1)" onmouseover="x()">bad</a><a href="https://ok.test">ok</a><img src="https://tracker.test/p.gif"><img src="file:///C:/Users/me/clip.png"><img src="data:image/svg+xml;base64,AAAA"><svg><circle/></svg><form><input value="x"></form></div>')
    expect(html).toBe('<div>Hi<a>bad</a><a href="https://ok.test">ok</a></div>')
  })

  it('assigns embedded images a fresh Content-ID and drops pasted composer markers unless trusted', () => {
    const pasted = clean('<div data-aerio-signature="sig"><img src="data:image/png;base64,AAAA" alt="logo" data-aerio-cid="copied@aerio.local" onerror="x()"></div><div data-aerio-quote="reply">Quote</div>')
    expect(pasted).toMatch(/^<div><img src="data:image\/png;base64,AAAA" alt="logo" data-aerio-cid="[0-9a-f-]+@aerio\.local"><\/div><div>Quote<\/div>$/)
    expect(pasted).not.toContain('copied@aerio.local')
    const trusted = clean('<div data-aerio-signature="sig"><img src="data:image/png;base64,AAAA" data-aerio-cid="kept@aerio.local"></div>', true)
    expect(trusted).toBe('<div data-aerio-signature="sig"><img src="data:image/png;base64,AAAA" data-aerio-cid="kept@aerio.local"></div>')
  })

  it('builds inline image and table markup and parses table sizes', () => {
    expect(inlineImageHtml('data:image/png;base64,AAAA', 'A "quoted" <name>')).toMatch(/^<img src="data:image\/png;base64,AAAA" alt="A &quot;quoted&quot; &lt;name&gt;" data-aerio-cid="[^"]+@aerio\.local" style="max-width: 100%">$/)
    const table = document.createElement('div')
    table.innerHTML = tableHtml(3, 2)
    expect(table.querySelectorAll('tr')).toHaveLength(2)
    expect(table.querySelectorAll('td')).toHaveLength(6)
    expect(clean(tableHtml(2, 1))).toBe(tableHtml(2, 1))
    expect(parseTableSize('3x2')).toEqual({ columns: 3, rows: 2 })
    expect(parseTableSize(' 4 × 10 ')).toEqual({ columns: 4, rows: 10 })
    expect(parseTableSize('0x2')).toBeUndefined()
    expect(parseTableSize('21x2')).toBeUndefined()
    expect(parseTableSize('wide')).toBeUndefined()
  })
})
