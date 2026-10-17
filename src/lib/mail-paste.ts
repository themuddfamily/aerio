import {
  COMPOSER_MARKER_ATTRIBUTES, INLINE_IMAGE_ATTRIBUTE, INLINE_IMAGE_MAX_BYTES, RICH_TEXT_ATTRIBUTES, RICH_TEXT_TAGS,
  isAllowedLink, newContentId, parseDataImage, sanitizeStyle
} from './mail-rich-text'

const allowedTags = new Set(RICH_TEXT_TAGS)
// Removed with their content; everything else unknown is unwrapped so its text survives.
const droppedTags = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed', 'svg', 'math', 'head', 'meta', 'link', 'title', 'xml', 'form', 'input', 'button', 'select', 'textarea', 'video', 'audio', 'canvas', 'picture', 'source'])

export interface PasteSanitizeOptions {
  /** Keep Aerio's signature/quote markers (only for HTML Aerio produced itself). */
  keepMarkers?: boolean
  /**
   * Replaces the data-URL image rule, for editors that reference managed
   * pictures instead (Notes): `attributes` are kept on `<img>` in addition to
   * the allowlist, and `keep` decides whether a cleaned image stays.
   */
  images?: { attributes: readonly string[]; keep(element: Element): boolean }
  /** Keep leading and trailing whitespace (Notes render it with `pre-wrap`). */
  preserveEdgeWhitespace?: boolean
}

/**
 * Sanitizes clipboard or dropped HTML into composer-safe markup with the same
 * tag, attribute, and CSS allowlist the outgoing sanitizer applies. Office and
 * Word cruft (conditional comments, `o:p`, `mso-*` styles, classes) is stripped,
 * remote and file images are removed, and embedded images get a Content-ID.
 */
export function sanitizePastedHtml(html: string, document: Document, options: PasteSanitizeOptions = {}) {
  const fragmentStart = html.indexOf('<!--StartFragment-->')
  const fragmentEnd = html.indexOf('<!--EndFragment-->')
  const source = fragmentStart >= 0 && fragmentEnd > fragmentStart ? html.slice(fragmentStart + 20, fragmentEnd) : html
  // Template content is inert: nothing in it loads or runs while it is inspected.
  const template = document.createElement('template')
  template.innerHTML = source
  cleanChildren(template.content, options)
  const container = document.createElement('div')
  container.append(template.content)
  return options.preserveEdgeWhitespace ? container.innerHTML : container.innerHTML.trim()
}

function cleanChildren(parent: ParentNode, options: PasteSanitizeOptions) {
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === 3) continue
    if (node.nodeType !== 1) {
      node.remove()
      continue
    }
    const element = node as Element
    const tag = element.localName.toLowerCase()
    // Word's list bullets are generated text the browser would duplicate.
    if (droppedTags.has(tag) || /mso-list\s*:\s*ignore/i.test(element.getAttribute('style') ?? '')) {
      element.remove()
      continue
    }
    cleanChildren(element, options)
    if (!allowedTags.has(tag)) {
      element.replaceWith(...Array.from(element.childNodes))
      continue
    }
    cleanAttributes(element, tag, options)
    if (tag === 'img' && (options.images ? !options.images.keep(element) : !element.hasAttribute('src'))) element.remove()
  }
}

function cleanAttributes(element: Element, tag: string, options: PasteSanitizeOptions) {
  const allowed = new Set([...(RICH_TEXT_ATTRIBUTES[tag] ?? []), 'style', 'dir', ...(options.keepMarkers ? COMPOSER_MARKER_ATTRIBUTES : []), ...(tag === 'img' ? options.images?.attributes ?? [] : [])])
  for (const { name } of Array.from(element.attributes)) {
    if (!allowed.has(name.toLowerCase())) element.removeAttribute(name)
  }
  const style = element.getAttribute('style')
  if (style !== null) {
    const safe = sanitizeStyle(style)
    if (safe) element.setAttribute('style', safe)
    else element.removeAttribute('style')
  }
  if (tag === 'a') {
    const href = element.getAttribute('href')
    if (href !== null && !isAllowedLink(href)) element.removeAttribute('href')
  }
  if (tag === 'img' && !options.images) {
    const image = parseDataImage(element.getAttribute('src') ?? '')
    if (!image || image.bytes > INLINE_IMAGE_MAX_BYTES) element.removeAttribute('src')
    else if (!options.keepMarkers || !element.getAttribute(INLINE_IMAGE_ATTRIBUTE)) element.setAttribute(INLINE_IMAGE_ATTRIBUTE, newContentId())
  }
}

const escapeHtml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

/** Composer markup for an embedded image; the main process sends it as a cid: part. */
export function inlineImageHtml(dataUrl: string, alt: string) {
  return `<img src="${escapeHtml(dataUrl)}" alt="${escapeHtml(alt)}" ${INLINE_IMAGE_ATTRIBUTE}="${newContentId()}" style="max-width: 100%">`
}

/** An empty bordered table that survives the style allowlist. */
export function tableHtml(columns: number, rows: number) {
  const cell = '<td style="border: 1px solid #c8c8c8; padding: 4px 8px"><br></td>'
  const row = `<tr>${cell.repeat(columns)}</tr>`
  return `<table style="border-collapse: collapse; width: 100%"><tbody>${row.repeat(rows)}</tbody></table><div><br></div>`
}

/** Parses "3x2" (columns x rows) within sensible bounds. */
export function parseTableSize(value: string) {
  const match = value.trim().match(/^(\d{1,2})\s*[x×*,]\s*(\d{1,3})$/i)
  if (!match) return undefined
  const columns = Number(match[1]), rows = Number(match[2])
  return columns >= 1 && columns <= 20 && rows >= 1 && rows <= 100 ? { columns, rows } : undefined
}
