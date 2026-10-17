// Dependency-free, namespace-aware XML reader for WebDAV multistatus responses, plus request body
// builders. It reads only what DAV servers send: elements, attributes, text, CDATA, comments, and
// processing instructions. DOCTYPE declarations are refused so entity expansion cannot be abused.

export const DAV_NS = 'DAV:'
export const CALDAV_NS = 'urn:ietf:params:xml:ns:caldav'
export const CARDDAV_NS = 'urn:ietf:params:xml:ns:carddav'
export const CALENDARSERVER_NS = 'http://calendarserver.org/ns/'
export const APPLE_ICAL_NS = 'http://apple.com/ns/ical/'

export class DavXmlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DavXmlError'
  }
}

export interface XmlElement {
  ns: string
  name: string
  attributes: Record<string, string>
  children: XmlElement[]
  text: string
}

export interface XmlLimits {
  maxChars: number
  maxDepth: number
  maxElements: number
}

export const XML_LIMITS: XmlLimits = { maxChars: 64 * 1024 * 1024, maxDepth: 64, maxElements: 2_000_000 }

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

function decodeEntities(value: string) {
  if (!value.includes('&')) return value
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, code: string) => {
    if (code[0] === '#') {
      const point = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match
    }
    return ENTITIES[code] ?? match
  })
}

interface OpenElement {
  element: XmlElement
  rawName: string
  prefixes: Map<string, string>
}

const NAME = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/

function splitName(raw: string): [string | undefined, string] {
  const colon = raw.indexOf(':')
  return colon > 0 ? [raw.slice(0, colon), raw.slice(colon + 1)] : [undefined, raw]
}

function resolve(prefixes: Map<string, string>, prefix: string | undefined, raw: string) {
  if (prefix === undefined) return prefixes.get('') ?? ''
  if (prefix === 'xml') return 'http://www.w3.org/XML/1998/namespace'
  const ns = prefixes.get(prefix)
  if (ns === undefined) throw new DavXmlError(`The server response uses an undeclared XML prefix in <${raw}>`)
  return ns
}

function parseAttributes(source: string): [string, string][] {
  const attributes: [string, string][] = []
  const pattern = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    attributes.push([match[1], decodeEntities(match[3] ?? match[4] ?? '')])
  }
  if (source.replace(pattern, '').trim()) throw new DavXmlError('The server response contains a malformed XML attribute')
  return attributes
}

/** Parses a complete XML document and returns its root element. */
export function parseXml(input: string, limits: XmlLimits = XML_LIMITS): XmlElement {
  if (input.length > limits.maxChars) throw new DavXmlError('The server response is too large')
  const text = input.replace(/^﻿/, '')
  const stack: OpenElement[] = []
  let root: XmlElement | undefined
  let elements = 0
  let index = 0
  const appendText = (value: string) => {
    const current = stack[stack.length - 1]
    if (current) current.element.text += value
    else if (value.trim()) throw new DavXmlError('The server response has text outside the XML root element')
  }
  while (index < text.length) {
    const open = text.indexOf('<', index)
    if (open < 0) {
      appendText(decodeEntities(text.slice(index)))
      break
    }
    if (open > index) appendText(decodeEntities(text.slice(index, open)))
    if (text.startsWith('<!--', open)) {
      const close = text.indexOf('-->', open + 4)
      if (close < 0) throw new DavXmlError('The server response has an unterminated XML comment')
      index = close + 3
    } else if (text.startsWith('<![CDATA[', open)) {
      const close = text.indexOf(']]>', open + 9)
      if (close < 0) throw new DavXmlError('The server response has an unterminated CDATA section')
      appendText(text.slice(open + 9, close))
      index = close + 3
    } else if (text.startsWith('<?', open)) {
      const close = text.indexOf('?>', open + 2)
      if (close < 0) throw new DavXmlError('The server response has an unterminated XML declaration')
      index = close + 2
    } else if (text.startsWith('<!', open)) {
      throw new DavXmlError('The server response contains a DOCTYPE declaration, which Aerio does not accept')
    } else if (text[open + 1] === '/') {
      const close = text.indexOf('>', open)
      if (close < 0) throw new DavXmlError('The server response has an unterminated XML end tag')
      const rawName = text.slice(open + 2, close).trim()
      const current = stack.pop()
      if (!current || current.rawName !== rawName) throw new DavXmlError(`The server response has a mismatched XML end tag </${rawName}>`)
      index = close + 1
    } else {
      // Find the tag end while honoring quoted attribute values that may contain '>'.
      let close = open + 1
      let quote: string | undefined
      for (; close < text.length; close++) {
        const character = text[close]
        if (quote) { if (character === quote) quote = undefined }
        else if (character === '"' || character === "'") quote = character
        else if (character === '>') break
      }
      if (close >= text.length) throw new DavXmlError('The server response has an unterminated XML tag')
      let body = text.slice(open + 1, close)
      const selfClosing = body.endsWith('/')
      if (selfClosing) body = body.slice(0, -1)
      const nameEnd = body.search(/[\s]/)
      const rawName = nameEnd < 0 ? body : body.slice(0, nameEnd)
      if (!NAME.test(rawName)) throw new DavXmlError('The server response contains an invalid XML element name')
      if (root && !stack.length) throw new DavXmlError('The server response has more than one XML root element')
      if (++elements > limits.maxElements) throw new DavXmlError('The server response contains too many XML elements')
      if (stack.length >= limits.maxDepth) throw new DavXmlError('The server response is nested too deeply')
      const rawAttributes = parseAttributes(nameEnd < 0 ? '' : body.slice(nameEnd))
      const parentPrefixes = stack[stack.length - 1]?.prefixes ?? new Map<string, string>()
      let prefixes = parentPrefixes
      for (const [name, value] of rawAttributes) {
        if (name === 'xmlns' || name.startsWith('xmlns:')) {
          if (prefixes === parentPrefixes) prefixes = new Map(parentPrefixes)
          prefixes.set(name === 'xmlns' ? '' : name.slice(6), value)
        }
      }
      const [prefix, local] = splitName(rawName)
      const attributes: Record<string, string> = {}
      for (const [name, value] of rawAttributes) {
        if (name === 'xmlns' || name.startsWith('xmlns:')) continue
        const [attributePrefix, attributeLocal] = splitName(name)
        // Unprefixed attributes have no namespace; prefixed ones are keyed by Clark notation.
        attributes[attributePrefix === undefined ? attributeLocal : `{${resolve(prefixes, attributePrefix, name)}}${attributeLocal}`] = value
      }
      const element: XmlElement = { ns: resolve(prefixes, prefix, rawName), name: local, attributes, children: [], text: '' }
      const parent = stack[stack.length - 1]
      if (parent) parent.element.children.push(element)
      else root = element
      if (!selfClosing) stack.push({ element, rawName, prefixes })
      index = close + 1
    }
  }
  if (stack.length) throw new DavXmlError(`The server response ended before </${stack[stack.length - 1].rawName}>`)
  if (!root) throw new DavXmlError('The server response is not XML')
  return root
}

export const clark = (ns: string, name: string) => `{${ns}}${name}`
export const isElement = (element: XmlElement | undefined, ns: string, name: string) => Boolean(element && element.ns === ns && element.name === name)
export const childElement = (element: XmlElement | undefined, ns: string, name: string) => element?.children.find((child) => child.ns === ns && child.name === name)
export const childElements = (element: XmlElement | undefined, ns: string, name: string) => element?.children.filter((child) => child.ns === ns && child.name === name) ?? []
export const elementText = (element: XmlElement | undefined): string | undefined => element ? (element.text + element.children.map(elementText).join('')).trim() : undefined

/** Status line such as "HTTP/1.1 404 Not Found" → 404. */
export function statusCode(element: XmlElement | undefined) {
  const match = /\s(\d{3})(?:\s|$)/.exec(` ${elementText(element) ?? ''} `)
  return match ? Number(match[1]) : undefined
}

export interface DavResponse {
  href: string
  status?: number
  props: Map<string, XmlElement>
  propStatus: Map<string, number>
}

export interface Multistatus {
  responses: DavResponse[]
  syncToken?: string
}

export function parseMultistatus(input: string): Multistatus {
  const root = parseXml(input)
  if (!isElement(root, DAV_NS, 'multistatus')) throw new DavXmlError('The server did not return a WebDAV multistatus response')
  const responses: DavResponse[] = []
  for (const response of childElements(root, DAV_NS, 'response')) {
    const href = elementText(childElement(response, DAV_NS, 'href'))
    if (!href) continue
    const props = new Map<string, XmlElement>()
    const propStatus = new Map<string, number>()
    for (const propstat of childElements(response, DAV_NS, 'propstat')) {
      const status = statusCode(childElement(propstat, DAV_NS, 'status')) ?? 200
      for (const prop of childElements(propstat, DAV_NS, 'prop')) {
        for (const value of prop.children) {
          const key = clark(value.ns, value.name)
          propStatus.set(key, status)
          if (status >= 200 && status < 300) props.set(key, value)
        }
      }
    }
    const status = statusCode(childElement(response, DAV_NS, 'status'))
    responses.push({ href, ...(status !== undefined ? { status } : {}), props, propStatus })
  }
  const syncToken = elementText(childElement(root, DAV_NS, 'sync-token'))
  return { responses, ...(syncToken ? { syncToken } : {}) }
}

export const prop = (response: DavResponse, ns: string, name: string) => response.props.get(clark(ns, name))
export const propText = (response: DavResponse, ns: string, name: string) => elementText(prop(response, ns, name))

// --- Request bodies ---------------------------------------------------------------------------

export const escapeXml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const PREFIXES: Record<string, string> = { [DAV_NS]: 'd', [CALDAV_NS]: 'c', [CARDDAV_NS]: 'card', [CALENDARSERVER_NS]: 'cs', [APPLE_ICAL_NS]: 'ical' }
const DECLARATIONS = Object.entries(PREFIXES).map(([ns, prefix]) => `xmlns:${prefix}="${ns}"`).join(' ')

export type PropName = [ns: string, name: string]
const propList = (props: PropName[]) => props.map(([ns, name]) => `<${PREFIXES[ns]}:${name}/>`).join('')

export function propfindBody(props: PropName[]) {
  return `<?xml version="1.0" encoding="utf-8"?><d:propfind ${DECLARATIONS}><d:prop>${propList(props)}</d:prop></d:propfind>`
}

export function syncCollectionBody(syncToken: string | undefined, props: PropName[]) {
  return `<?xml version="1.0" encoding="utf-8"?><d:sync-collection ${DECLARATIONS}><d:sync-token>${escapeXml(syncToken ?? '')}</d:sync-token><d:sync-level>1</d:sync-level><d:prop>${propList(props)}</d:prop></d:sync-collection>`
}

export function multigetBody(kind: 'calendar' | 'addressbook', hrefs: string[]) {
  const root = kind === 'calendar' ? 'c:calendar-multiget' : 'card:addressbook-multiget'
  const data = kind === 'calendar' ? '<c:calendar-data/>' : '<card:address-data/>'
  return `<?xml version="1.0" encoding="utf-8"?><${root} ${DECLARATIONS}><d:prop><d:getetag/>${data}</d:prop>${hrefs.map((href) => `<d:href>${escapeXml(href)}</d:href>`).join('')}</${root}>`
}
