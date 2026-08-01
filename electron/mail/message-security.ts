import sanitizeHtml from 'sanitize-html'

const encodeRemote = (url: string) => Buffer.from(url, 'utf8').toString('base64url')

const imageDimension = (value: string | undefined, maximum: number) => {
  const match = value?.trim().match(/^(\d{1,5})(?:px)?$/i)
  if (!match) return undefined
  return Math.min(Math.max(Number(match[1]), 1), maximum)
}

const blockedImageAttributes = (attributes: Record<string, string>) => {
  const width = imageDimension(attributes.width, 1600)
  const height = imageDimension(attributes.height, 1200)
  const compact = width !== undefined && height !== undefined && width <= 96 && height <= 96
  const tracker = width !== undefined && height !== undefined && width <= 4 && height <= 4
  const className = [
    'remote-image-blocked',
    compact ? 'remote-image-compact' : '',
    tracker ? 'remote-image-tracker' : '',
    width && height ? 'remote-image-proportional' : ''
  ].filter(Boolean).join(' ')
  const style = [
    width ? `--blocked-image-width:${width}px` : '',
    height ? `--blocked-image-height:${height}px` : '',
    width && height ? `--blocked-image-aspect:${width}/${height}` : ''
  ].filter(Boolean).join(';')
  const description = attributes.alt?.trim()

  return {
    class: className,
    title: description || 'Remote image blocked',
    role: 'img',
    'aria-label': description ? `Remote image blocked: ${description}` : 'Remote image blocked',
    ...(style ? { style } : {})
  }
}

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
      span: ['style', 'role', 'aria-label'],
      table: ['border', 'cellpadding', 'cellspacing', 'width'],
      td: ['align', 'colspan', 'rowspan', 'valign', 'width'],
      th: ['align', 'colspan', 'rowspan', 'valign', 'width'],
      font: ['color', 'face', 'size']
    },
    allowedSchemes: ['http', 'https', 'mailto', 'cid', 'data', 'aerio-image'],
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    allowedStyles: {
      span: {
        '--blocked-image-width': [/^\d{1,4}px$/],
        '--blocked-image-height': [/^\d{1,4}px$/],
        '--blocked-image-aspect': [/^\d{1,4}\/\d{1,4}$/]
      }
    },
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
            attribs: blockedImageAttributes(attributes),
            text: 'Remote image blocked'
          }
        }
        const attribs: Record<string, string> = { ...attributes }
        attribs.src = remote ? `aerio-image://fetch/${encodeRemote(src)}` : src
        return {
          tagName: 'img',
          attribs
        }
      },
      span: (_tag, attributes) => {
        const { style: _untrustedStyle, ...attribs } = attributes
        return { tagName: 'span', attribs }
      }
    }
  })
}
