// Shared RFC 5545 / RFC 6350 content-line handling: unfolding, parameter parsing, escaping, folding,
// and a component tree builder with resource limits. ICS and vCard parsers both build on this.

export class InterchangeFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InterchangeFormatError'
  }
}

export interface ContentLimits {
  maxChars: number
  maxLines: number
  maxLineLength: number
  maxComponents: number
  maxPropertiesPerComponent: number
  maxDepth: number
}

export interface ContentLine {
  group?: string
  name: string
  params: Record<string, string[]>
  value: string
}

export interface Component {
  name: string
  properties: ContentLine[]
  children: Component[]
}

export interface ComponentParseResult {
  roots: Component[]
  warnings: string[]
}

const decodeCaret = (value: string) => value.replace(/\^(\^|n|')/g, (_match, code: string) => code === 'n' ? '\n' : code === "'" ? '"' : '^')

// Returns undefined when the line has no value separator; callers record a warning and continue.
export function parseContentLine(line: string): ContentLine | undefined {
  let index = 0
  while (index < line.length && line[index] !== ';' && line[index] !== ':') index++
  if (index >= line.length) return undefined
  const fullName = line.slice(0, index).trim()
  if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)?$/.test(fullName)) return undefined
  const dot = fullName.indexOf('.')
  const params: Record<string, string[]> = {}
  while (line[index] === ';') {
    index++
    let nameEnd = index
    while (nameEnd < line.length && !'=;:'.includes(line[nameEnd])) nameEnd++
    const paramName = line.slice(index, nameEnd).trim().toUpperCase()
    index = nameEnd
    const values: string[] = []
    if (line[index] === '=') {
      index++
      for (;;) {
        if (line[index] === '"') {
          const close = line.indexOf('"', index + 1)
          if (close < 0) return undefined
          values.push(decodeCaret(line.slice(index + 1, close)))
          index = close + 1
        } else {
          let end = index
          while (end < line.length && !',;:'.includes(line[end])) end++
          values.push(decodeCaret(line.slice(index, end)))
          index = end
        }
        if (line[index] !== ',') break
        index++
      }
      if (paramName) params[paramName] = [...(params[paramName] ?? []), ...values]
    } else if (paramName) {
      // vCard 2.1 bare parameters such as TEL;WORK;VOICE are TYPE values.
      params.TYPE = [...(params.TYPE ?? []), paramName]
    }
  }
  if (line[index] !== ':') return undefined
  return {
    ...(dot > 0 ? { group: fullName.slice(0, dot) } : {}),
    name: (dot > 0 ? fullName.slice(dot + 1) : fullName).toUpperCase(),
    params,
    value: line.slice(index + 1)
  }
}

export function unescapeText(value: string) {
  return value.replace(/\\([\\;,:nN])/g, (_match, code: string) => code === 'n' || code === 'N' ? '\n' : code)
}

export function escapeText(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n')
}

// Splits on unescaped separators (for N, ADR, ORG, CATEGORIES, and multi-value text) and unescapes each part.
export function splitEscaped(value: string, separator: ';' | ',') {
  const parts: string[] = []
  let current = ''
  for (let index = 0; index < value.length; index++) {
    const character = value[index]
    if (character === '\\' && index + 1 < value.length) {
      current += character + value[index + 1]
      index++
    } else if (character === separator) {
      parts.push(unescapeText(current))
      current = ''
    } else current += character
  }
  parts.push(unescapeText(current))
  return parts
}

export function formatParam(name: string, values: string[]) {
  const formatted = values.map((value) => {
    const clean = value.replace(/[\r\n"]/g, ' ')
    return /[:;,]/.test(clean) ? `"${clean}"` : clean
  })
  return `;${name}=${formatted.join(',')}`
}

const utf8Length = (character: string) => {
  const code = character.codePointAt(0) ?? 0
  return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
}

// Folds a content line at 75 octets without splitting a UTF-8 sequence.
export function foldLine(line: string) {
  const output: string[] = []
  let current = ''
  let size = 0
  for (const character of line) {
    const length = utf8Length(character)
    const limit = output.length ? 74 : 75
    if (size + length > limit) {
      output.push(current)
      current = ''
      size = 0
    }
    current += character
    size += length
  }
  output.push(current)
  return output.join('\r\n ')
}

export function unfoldLines(text: string, limits: Pick<ContentLimits, 'maxChars' | 'maxLines' | 'maxLineLength'>) {
  if (text.length > limits.maxChars) throw new InterchangeFormatError(`The file is larger than the ${Math.round(limits.maxChars / 1024 / 1024)} MB import limit`)
  const raw = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/)
  if (raw.length > limits.maxLines) throw new InterchangeFormatError('The file has too many lines to import safely')
  const lines: string[] = []
  for (const line of raw) {
    const previous = lines[lines.length - 1]
    const softBreak = previous !== undefined && previous.endsWith('=') && /QUOTED-PRINTABLE/i.test(previous.slice(0, previous.indexOf(':') + 1 || previous.length))
    if (softBreak || ((line.startsWith(' ') || line.startsWith('\t')) && lines.length)) {
      // vCard 2.1 quoted-printable soft line breaks continue without leading whitespace.
      const joined = softBreak ? previous.slice(0, -1) + line : previous + line.slice(1)
      if (joined.length > limits.maxLineLength) throw new InterchangeFormatError('The file contains a property that is too long to import safely')
      lines[lines.length - 1] = joined
    } else {
      if (line.length > limits.maxLineLength) throw new InterchangeFormatError('The file contains a property that is too long to import safely')
      lines.push(line)
    }
  }
  return lines.filter((line) => line.trim().length > 0)
}

// Builds BEGIN/END component trees. Mismatched END lines are fatal; components left open at the end of
// the file are discarded with a warning so that complete records before a truncation still import.
export function parseComponents(text: string, limits: ContentLimits): ComponentParseResult {
  const lines = unfoldLines(text, limits)
  const roots: Component[] = []
  const stack: Component[] = []
  const warnings: string[] = []
  let components = 0
  let malformed = 0
  for (const line of lines) {
    const parsed = parseContentLine(line)
    if (!parsed) {
      malformed++
      continue
    }
    if (parsed.name === 'BEGIN') {
      const name = parsed.value.trim().toUpperCase()
      if (!name) throw new InterchangeFormatError('The file contains an unnamed BEGIN line')
      if (stack.length >= limits.maxDepth) throw new InterchangeFormatError('The file nests components too deeply')
      if (++components > limits.maxComponents) throw new InterchangeFormatError(`The file contains more than ${limits.maxComponents.toLocaleString('en-US')} records`)
      const component: Component = { name, properties: [], children: [] }
      if (stack.length) stack[stack.length - 1].children.push(component)
      else roots.push(component)
      stack.push(component)
    } else if (parsed.name === 'END') {
      const name = parsed.value.trim().toUpperCase()
      const current = stack.pop()
      if (!current || current.name !== name) throw new InterchangeFormatError(`The file has an unexpected END:${name.slice(0, 40)}`)
    } else if (stack.length) {
      const current = stack[stack.length - 1]
      if (current.properties.length >= limits.maxPropertiesPerComponent) throw new InterchangeFormatError(`A ${current.name} record has too many properties`)
      current.properties.push(parsed)
    }
  }
  if (malformed) warnings.push(`${malformed} malformed line${malformed === 1 ? ' was' : 's were'} skipped`)
  if (stack.length) {
    warnings.push(`The file ended before ${stack[stack.length - 1].name} was closed; incomplete records were skipped`)
    for (let depth = stack.length - 1; depth >= 0; depth--) {
      const parent = depth > 0 ? stack[depth - 1].children : roots
      const unfinished = stack[depth]
      // Keep the outer container (VCALENDAR) but drop the unfinished leaf records inside it.
      if (depth > 0 || unfinished.name !== 'VCALENDAR') parent.splice(parent.indexOf(unfinished), 1)
    }
  }
  return { roots, warnings }
}

export const firstProperty = (component: Component, name: string) => component.properties.find((property) => property.name === name)
export const allProperties = (component: Component, name: string) => component.properties.filter((property) => property.name === name)
export const paramValue = (line: ContentLine, name: string) => line.params[name]?.[0]
