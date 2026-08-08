import { describe, expect, it } from 'vitest'
import { decodeHtmlEntities } from './html-entities'

describe('decodeHtmlEntities', () => {
  it('decodes decimal and hexadecimal numeric entities', () => {
    expect(decodeHtmlEntities('It&#39;s ready &#x1F44B;')).toBe("It's ready \ud83d\udc4b")
  })

  it('decodes common named entities used in message snippets', () => {
    expect(decodeHtmlEntities('&ldquo;Tom &amp; Jerry&rdquo; &mdash; done'))
      .toBe('\u201cTom & Jerry\u201d \u2014 done')
  })

  it('leaves malformed, unknown, and invalid entities intact', () => {
    expect(decodeHtmlEntities('&madeup; &#xD800; &#not-finished'))
      .toBe('&madeup; &#xD800; &#not-finished')
  })

  it('returns decoded markup as text for React to escape during rendering', () => {
    expect(decodeHtmlEntities('&lt;script&gt;alert(&quot;no&quot;)&lt;/script&gt;'))
      .toBe('<script>alert("no")</script>')
  })
})
