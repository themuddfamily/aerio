import { createHash } from 'node:crypto'
import sanitizeHtml from 'sanitize-html'
import {
  COMPOSER_MARKER_ATTRIBUTES, INLINE_IMAGE_ATTRIBUTE, RICH_TEXT_ATTRIBUTES, RICH_TEXT_TAGS,
  inlineImageExtension, isAllowedLink, isValidContentId, newContentId, parseDataImage, sanitizeStyle
} from '../../src/lib/mail-rich-text'

export interface InlineImagePart {
  contentId: string
  mimeType: string
  filename: string
  content: Buffer
}

export interface OutgoingHtml {
  html: string
  images: InlineImagePart[]
}

/**
 * Sanitizes composed HTML for delivery and turns every embedded
 * `data:image/...` into a Content-ID part. Remote and file images are removed:
 * a sent message only references images it carries itself.
 */
export function prepareOutgoingHtml(html: string): OutgoingHtml {
  const images: InlineImagePart[] = []
  const byDigest = new Map<string, InlineImagePart>()
  const usedIds = new Set<string>()
  const embed = (src: string, requested: string | undefined) => {
    const image = parseDataImage(src)
    if (!image) return undefined
    const content = Buffer.from(image.base64, 'base64')
    if (!content.length) return undefined
    const digest = createHash('sha256').update(image.mimeType).update(content).digest('hex')
    const known = byDigest.get(digest)
    if (known) return known.contentId
    const contentId = isValidContentId(requested) && !usedIds.has(requested.toLowerCase()) ? requested : newContentId()
    usedIds.add(contentId.toLowerCase())
    const part = { contentId, mimeType: image.mimeType, filename: `image-${images.length + 1}.${inlineImageExtension(image.mimeType)}`, content }
    byDigest.set(digest, part)
    images.push(part)
    return contentId
  }
  const safe = sanitizeHtml(html, {
    allowedTags: RICH_TEXT_TAGS,
    allowedAttributes: {
      ...RICH_TEXT_ATTRIBUTES,
      '*': ['style', 'dir', ...COMPOSER_MARKER_ATTRIBUTES]
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['cid'] },
    allowProtocolRelative: false,
    // Supported at runtime but missing from the bundled typings; keeps marker attributes as `=""`.
    ...({ allowedEmptyAttributes: ['alt', ...COMPOSER_MARKER_ATTRIBUTES] } as sanitizeHtml.IOptions),
    disallowedTagsMode: 'discard',
    nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'title', 'head', 'xml'],
    // Style is filtered by the shared allowlist rather than sanitize-html's CSS parser.
    parseStyleAttributes: false,
    transformTags: {
      '*': (tagName, attribs) => {
        const next: sanitizeHtml.Attributes = { ...attribs }
        if (next.style !== undefined) {
          const style = sanitizeStyle(next.style)
          if (style) next.style = style
          else delete next.style
        }
        if (tagName === 'a' && next.href !== undefined && !isAllowedLink(next.href)) delete next.href
        if (tagName === 'img') {
          const contentId = next.src ? embed(next.src, next[INLINE_IMAGE_ATTRIBUTE]) : undefined
          delete next[INLINE_IMAGE_ATTRIBUTE]
          if (contentId) next.src = `cid:${contentId}`
          else delete next.src
        }
        return { tagName, attribs: next }
      }
    },
    // An image that did not become a carried part has nothing to show.
    exclusiveFilter: (frame) => frame.tag === 'img' && !frame.attribs.src
  }).trim()
  return { html: safe, images }
}
