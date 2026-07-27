import sanitizeHtml from 'sanitize-html'

const encodeRemote = (url: string) => Buffer.from(url, 'utf8').toString('base64url')

export function sanitizeMessageHtml(html: string, allowRemoteImages = false) {
  return sanitizeHtml(html, {
    allowedTags: [
      'a', 'abbr', 'address', 'article', 'aside', 'b', 'blockquote', 'br', 'caption', 'center',
      'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'details', 'div', 'dl', 'dt', 'em',
      'figcaption', 'figure', 'font', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
      'hr', 'i', 'img', 'ins', 'kbd', 'li', 'main', 'mark', 'ol', 'p', 'pre', 'q', 's',
      'section', 'small', 'span', 'strike', 'strong', 'sub', 'summary', 'sup', 'table',
      'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'tt', 'u', 'ul'
    ],
    allowedAttributes: {
      '*': ['class', 'dir', 'lang', 'title'],
      a: ['href', 'name', 'target'],
      img: ['src', 'alt', 'title', 'width', 'height'],
      table: ['border', 'cellpadding', 'cellspacing', 'width'],
      td: ['align', 'colspan', 'rowspan', 'valign', 'width'],
      th: ['align', 'colspan', 'rowspan', 'valign', 'width'],
      font: ['color', 'face', 'size']
    },
    allowedSchemes: ['http', 'https', 'mailto', 'cid', 'data', 'aerio-image'],
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    transformTags: {
      a: (_tag, attributes) => {
        const href = attributes.href ?? ''
        return {
          tagName: 'a',
          attribs: {
            ...attributes,
            href: /^https?:\/\//i.test(href) || /^mailto:/i.test(href) ? href : '#',
            target: '_blank',
            rel: 'noreferrer noopener'
          }
        }
      },
      img: (_tag, attributes) => {
        const src = attributes.src ?? ''
        const remote = /^https?:\/\//i.test(src)
        if (remote && !allowRemoteImages) {
          return {
            tagName: 'span',
            attribs: { class: 'remote-image-blocked', title: attributes.alt || 'Remote image blocked' }
          }
        }
        const attribs: Record<string, string> = { ...attributes }
        attribs.src = remote ? `aerio-image://fetch/${encodeRemote(src)}` : src
        return {
          tagName: 'img',
          attribs
        }
      }
    }
  })
}
