// Shared rich-text policy for composed mail. The renderer applies it to pasted
// HTML and the main process applies it again to every outgoing message, so a
// hostile clipboard or a tampered draft cannot reach recipients unfiltered.

/** Marks an inline image with the Content-ID it is sent under. */
export const INLINE_IMAGE_ATTRIBUTE = 'data-aerio-cid'
/** Composer markers that must survive sanitization (see mail-signature.ts). */
export const COMPOSER_MARKER_ATTRIBUTES = ['data-aerio-signature', 'data-aerio-quote', 'data-aerio-signature-spacer'] as const

export const RICH_TEXT_TAGS = [
  'a', 'b', 'blockquote', 'br', 'caption', 'code', 'col', 'colgroup', 'div', 'em', 'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
  'i', 'img', 'li', 'ol', 'p', 'pre', 's', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot',
  'th', 'thead', 'tr', 'u', 'ul'
]

/** Attributes allowed per tag in addition to `style` and `dir` on every tag. */
export const RICH_TEXT_ATTRIBUTES: Record<string, string[]> = {
  a: ['href', 'title'],
  img: ['src', 'alt', 'width', 'height', INLINE_IMAGE_ATTRIBUTE],
  font: ['color', 'face', 'size'],
  table: ['border', 'cellpadding', 'cellspacing', 'width', 'align'],
  col: ['span', 'width'],
  colgroup: ['span', 'width'],
  td: ['align', 'colspan', 'rowspan', 'valign', 'width'],
  th: ['align', 'colspan', 'rowspan', 'valign', 'width'],
  tr: ['align', 'valign'],
  p: ['align'],
  div: ['align'],
  h1: ['align'], h2: ['align'], h3: ['align'], h4: ['align'], h5: ['align'], h6: ['align']
}

/** Inline images may be any of these; anything else (SVG especially) is dropped. */
export const INLINE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']
export const INLINE_IMAGE_MAX_BYTES = 5 * 1024 * 1024
const dataImagePattern = /^data:(image\/(?:png|jpeg|gif|webp|bmp));base64,([A-Za-z0-9+/=\s]+)$/i

const length = String.raw`(?:0|-?\d*\.?\d+(?:px|pt|em|rem|%|cm|mm|in)?)`
const color = String.raw`(?:#[0-9a-f]{3,8}|rgba?\(\s*[\d.%\s,/]+\)|hsla?\(\s*[\d.%\s,/deg]+\)|[a-z]{3,20})`
const borderStyle = 'none|hidden|solid|dashed|dotted|double|groove|ridge|inset|outset'
const lengths = (max: number) => new RegExp(`^${length}(?:\\s+${length}){0,${max - 1}}$`, 'i')
const border = new RegExp(`^(?:(?:${length}|${borderStyle}|thin|medium|thick|${color})\\s*){1,3}$`, 'i')
const sizeValue = new RegExp(`^(?:auto|${length})$`, 'i')
const colorValue = new RegExp(`^${color}$`, 'i')

/** CSS properties allowed in `style`, with the shape each value must have. */
export const RICH_TEXT_STYLES: Record<string, RegExp> = {
  color: colorValue,
  'background-color': colorValue,
  'font-family': /^[\w\s,'"-]{1,200}$/,
  'font-size': new RegExp(`^(?:xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|smaller|larger|${length})$`, 'i'),
  'font-weight': /^(?:normal|bold|bolder|lighter|[1-9]00)$/i,
  'font-style': /^(?:normal|italic|oblique)$/i,
  'text-decoration': /^(?:none|(?:underline|line-through|overline)(?:\s+(?:underline|line-through|overline))*)$/i,
  'text-decoration-line': /^(?:none|(?:underline|line-through|overline)(?:\s+(?:underline|line-through|overline))*)$/i,
  'text-align': /^(?:left|right|center|justify|start|end)$/i,
  'vertical-align': /^(?:top|middle|bottom|baseline)$/i,
  border, 'border-top': border, 'border-right': border, 'border-bottom': border, 'border-left': border,
  'border-color': new RegExp(`^${color}(?:\\s+${color}){0,3}$`, 'i'),
  'border-style': new RegExp(`^(?:${borderStyle})(?:\\s+(?:${borderStyle})){0,3}$`, 'i'),
  'border-width': lengths(4),
  'border-collapse': /^(?:collapse|separate)$/i,
  padding: lengths(4), 'padding-top': lengths(1), 'padding-right': lengths(1), 'padding-bottom': lengths(1), 'padding-left': lengths(1),
  width: sizeValue, height: sizeValue, 'max-width': new RegExp(`^(?:none|${length})$`, 'i')
}

/**
 * Keeps only allowlisted declarations with well-formed values. Anything that
 * could fetch or execute (url(), expression(), escapes, at-rules) is refused
 * outright, so Office `mso-*` noise and layout properties simply disappear.
 */
export function sanitizeStyle(style: string) {
  if (/url\s*\(|expression|javascript:|\\|[<>@]|\/\*/i.test(style)) return ''
  const declarations: string[] = []
  for (const declaration of style.split(';')) {
    const separator = declaration.indexOf(':')
    if (separator < 0) continue
    const property = declaration.slice(0, separator).trim().toLowerCase()
    const value = declaration.slice(separator + 1).replace(/\s*!important\s*$/i, '').trim()
    if (value && RICH_TEXT_STYLES[property]?.test(value)) declarations.push(`${property}: ${value}`)
  }
  return declarations.join('; ')
}

export function isAllowedLink(href: string) {
  return /^(?:https?:\/\/|mailto:)/i.test(href.trim())
}

export interface DataImage {
  mimeType: string
  /** Base64 payload with whitespace removed. */
  base64: string
  bytes: number
}

/** Parses a base64 `data:image/...` URL of an allowed raster type. */
export function parseDataImage(src: string): DataImage | undefined {
  const match = src.trim().match(dataImagePattern)
  if (!match) return undefined
  const base64 = match[2].replaceAll(/\s+/g, '')
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return { mimeType: match[1].toLowerCase(), base64, bytes: Math.max(0, Math.floor(base64.length * 3 / 4) - padding) }
}

const contentIdPattern = /^[A-Za-z0-9._-]{1,100}@[A-Za-z0-9.-]{1,100}$/
export const isValidContentId = (value: string | undefined): value is string => Boolean(value && contentIdPattern.test(value))
export const newContentId = () => `${crypto.randomUUID()}@aerio.local`

/** Total decoded size of the embedded images in a draft, counted against the attachment limit. */
export function inlineImageBytes(html: string | undefined) {
  if (!html) return 0
  let total = 0
  for (const match of html.matchAll(/src\s*=\s*["']?(data:image\/[^"'\s>]+)/gi)) total += parseDataImage(match[1])?.bytes ?? 0
  return total
}

export const inlineImageExtension = (mimeType: string) => ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp' } as Record<string, string>)[mimeType] ?? 'img'
