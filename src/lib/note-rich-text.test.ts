import { describe, expect, it } from 'vitest'
import { noteEditorHtml, noteHtmlToText, noteImageIds, plainTextToNoteHtml } from './note-rich-text'

describe('rich note text projection', () => {
  it('converts plain-text notes losslessly', () => {
    const samples = [
      '', 'One line', 'Two\nlines', 'Trailing newline\n', '\nLeading blank', 'Blank\n\n\nlines', '\n', '\n\n',
      '  indented\n\tand tabbed  ', 'Markup <b>stays</b> text & "quotes" \'too\'', 'Entities &amp; &lt;not&gt; &#38; &copy;',
      'Unicode — café ✓ 日本語', 'CR\r\nLF', 'a b'
    ]
    for (const sample of samples) expect(noteHtmlToText(plainTextToNoteHtml(sample))).toBe(sample)
    expect(plainTextToNoteHtml('a\n\nb')).toBe('<div>a</div><div><br></div><div>b</div>')
    expect(plainTextToNoteHtml('<script>')).toBe('<div>&lt;script&gt;</div>')
  })

  it('projects headings, lists, tables, links, and pictures to searchable text', () => {
    const html = '<h1>Plan</h1><p>Read the <a href="https://example.test" title="a > b">brief</a>.</p>' +
      '<ul><li>First</li><li>Second <b>bold</b></li></ul><ol><li>One</li></ol>' +
      '<table><tbody><tr><td>Cell A</td><td>Cell B</td></tr><tr><td>C</td><td>D</td></tr></tbody></table>' +
      '<div><img data-aerio-note-image="img-1" alt="Diagram > flow"></div><div>Line<br>break</div><!-- hidden -->'
    expect(noteHtmlToText(html)).toBe('Plan\nRead the brief.\nFirst\nSecond bold\nOne\nCell A\tCell B\nC\tD\nLine\nbreak')
    expect(noteHtmlToText('First line<div>second</div>')).toBe('First line\nsecond')
    expect(noteHtmlToText('Tom &amp; Jerry&nbsp;&lt;3')).toBe('Tom & Jerry <3')
  })

  it('lists referenced inline pictures once and ignores invalid ids', () => {
    expect(noteImageIds('<img data-aerio-note-image="a"><img data-aerio-note-image=\'b\'><img data-aerio-note-image="a"><img data-aerio-note-image="bad id">')).toEqual(['a', 'b'])
    expect(noteImageIds(undefined)).toEqual([])
  })

  it('shows plain notes through the lossless conversion and rich notes as stored', () => {
    expect(noteEditorHtml({ content: 'a\nb' })).toBe('<div>a</div><div>b</div>')
    expect(noteEditorHtml({ content: 'ignored', html: '<h2>Rich</h2>' })).toBe('<h2>Rich</h2>')
  })
})
