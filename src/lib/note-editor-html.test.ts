// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { sanitizePastedHtml } from './mail-paste'
import { collapsePastedWhitespace, pendingEditorImages, sanitizeNoteHtml, serializeNoteEditor } from './note-editor-html'

const pixel = 'data:image/png;base64,iVBORw0KGgo='

describe('rich note editor HTML', () => {
  it('stores only managed picture references and never a src', () => {
    const html = `<h2 onclick="alert(1)">Title</h2><img data-aerio-note-image="known" src="${pixel}" alt="Known" onerror="alert(1)">` +
      '<img data-aerio-note-image="unknown" alt="Gone"><img src="https://tracker.example/pixel.gif"><img src="file:///C:/secret.png">' +
      '<a href="javascript:alert(1)">bad</a><a href="https://example.test">good</a><script>alert(1)</script>'
    const safe = sanitizeNoteHtml(html, document, new Set(['known']))
    expect(safe).toBe('<h2>Title</h2><img data-aerio-note-image="known" alt="Known"><a>bad</a><a href="https://example.test">good</a>')
  })

  it('keeps edge whitespace so typed spacing survives', () => {
    expect(sanitizeNoteHtml('  indented<div>  next  </div>\n', document, new Set())).toBe('  indented<div>  next  </div>\n')
  })

  it('serializes the editor without hydrated or pending picture data', () => {
    const editor = document.createElement('div')
    editor.innerHTML = `<div>Text</div><img data-aerio-note-image="img-1" src="${pixel}" alt="Saved"><img src="${pixel}" alt="Pending" data-aerio-cid="x@aerio.local">`
    expect(pendingEditorImages(editor).map((image) => image.alt)).toEqual(['Pending'])
    expect(serializeNoteEditor(editor, new Set(['img-1']))).toEqual({ html: '<div>Text</div><img data-aerio-note-image="img-1" alt="Saved">', content: 'Text' })
  })

  it('sanitizes pasted HTML from hostile and Office sources before collapsing source whitespace', () => {
    const clipboard = '<html><head><style>p{color:red}</style></head><body><!--StartFragment-->\n  <p class="MsoNormal" style="mso-line-height-rule:exactly; color: #333" onmouseover="steal()">Hello\n   world</p>\n' +
      '<iframe src="https://evil.test"></iframe><img src="https://remote.example/x.png"><img src="' + pixel + '" alt="Shot">\n<ul>\n  <li>One</li>\n  <li>Two</li>\n</ul><!--EndFragment--></body></html>'
    const pasted = collapsePastedWhitespace(sanitizePastedHtml(clipboard, document), document)
    expect(pasted).not.toMatch(/script|iframe|onmouseover|remote\.example|class=|mso-/)
    expect(pasted).toContain('<p style="color: #333">Hello world</p>')
    expect(pasted).toContain('<ul><li>One</li><li>Two</li></ul>')
    expect(pasted).toMatch(/<img src="data:image\/png;base64,[^"]+" alt="Shot" data-aerio-cid="[^"]+@aerio\.local">/)
    expect(collapsePastedWhitespace('<pre>  keep\n  this</pre>', document)).toBe('<pre>  keep\n  this</pre>')
  })
})
