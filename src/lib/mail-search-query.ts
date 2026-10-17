// Parses the mail search box into a small Boolean AST and compiles it to FTS5
// MATCH syntax. The compiled strings are always bound as SQL parameters; every
// user-supplied word is re-quoted here so FTS5 operators, column filters, and
// special characters in the raw input can never change the query structure.

export type MailSearchField = 'from' | 'to' | 'subject' | 'body' | 'attachment'

export type MailSearchNode =
  | { kind: 'term'; value: string; phrase: boolean; field?: MailSearchField }
  | { kind: 'not'; child: MailSearchNode }
  | { kind: 'and'; children: MailSearchNode[] }
  | { kind: 'or'; children: MailSearchNode[] }

/**
 * `include` must match at least one message in a conversation. `exclude` comes
 * from top-level NOT terms and removes any conversation with a matching message,
 * which lets a search such as `-newsletter` stand on its own.
 */
export interface CompiledMailSearch {
  include?: string
  exclude?: string
}

export type MailSearchParseResult =
  | { ok: true; node?: MailSearchNode; compiled?: CompiledMailSearch }
  | { ok: false; error: string; position: number }

export const MAIL_SEARCH_MAX_LENGTH = 1_000
const MAX_TERMS = 64
const MAX_DEPTH = 16

const FIELD_ALIASES: Record<string, MailSearchField> = {
  from: 'from', sender: 'from',
  to: 'to', cc: 'to', recipient: 'to', recipients: 'to',
  subject: 'subject',
  body: 'body',
  attachment: 'attachment', file: 'attachment', filename: 'attachment'
}

const FIELD_COLUMNS: Record<MailSearchField, string> = {
  from: 'sender',
  to: 'recipients',
  subject: 'subject',
  body: 'body',
  attachment: 'attachment_names'
}

type Token =
  | { type: 'word' | 'phrase'; value: string; position: number }
  | { type: 'field'; field: MailSearchField; name: string; position: number }
  | { type: 'and' | 'or' | 'not' | 'open' | 'close'; position: number }

class MailSearchSyntaxError extends Error {
  constructor(message: string, readonly position: number) {
    super(message)
  }
}

// FTS5's unicode61 tokenizer ignores punctuation, so a word without any letter
// or digit would compile to an empty phrase that silently matches nothing.
const searchable = (value: string) => /[\p{L}\p{N}]/u.test(value)

function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  while (index < input.length) {
    const char = input[index]
    if (/\s/.test(char)) { index += 1; continue }
    if (char === '(') { tokens.push({ type: 'open', position: index }); index += 1; continue }
    if (char === ')') { tokens.push({ type: 'close', position: index }); index += 1; continue }
    if (char === '"') {
      const end = input.indexOf('"', index + 1)
      if (end < 0) throw new MailSearchSyntaxError(`Close the quotation mark at character ${index + 1}`, index)
      const value = input.slice(index + 1, end).trim().replaceAll(/\s+/g, ' ')
      if (searchable(value)) tokens.push({ type: 'phrase', value, position: index })
      else if (tokens.at(-1)?.type === 'field') throw new MailSearchSyntaxError('Add words inside the quotation marks', index)
      index = end + 1
      continue
    }
    const start = index
    while (index < input.length && !/[\s()"]/.test(input[index])) index += 1
    let word = input.slice(start, index)
    let position = start
    if (word === 'AND' || word === 'OR' || word === 'NOT') {
      tokens.push({ type: word === 'AND' ? 'and' : word === 'OR' ? 'or' : 'not', position })
      continue
    }
    // A leading hyphen negates the next term or group; stray dashes such as `--` stay punctuation.
    if (word.startsWith('-') && (searchable(word) || (word === '-' && (input[index] === '(' || input[index] === '"')))) {
      tokens.push({ type: 'not', position })
      word = word.slice(1)
      position += 1
      if (!word) continue
    }
    const colon = word.indexOf(':')
    const field = colon > 0 ? FIELD_ALIASES[word.slice(0, colon).toLowerCase()] : undefined
    if (field) {
      tokens.push({ type: 'field', field, name: word.slice(0, colon + 1), position })
      word = word.slice(colon + 1)
      position += colon + 1
      if (!word) continue
    }
    if (searchable(word)) tokens.push({ type: 'word', value: word, position })
    else if (tokens.at(-1)?.type === 'field') throw new MailSearchSyntaxError(`Add a search term after ${(tokens.at(-1) as { name: string }).name}`, position)
  }
  return tokens
}

const negate = (child: MailSearchNode): MailSearchNode => child.kind === 'not' ? child.child : { kind: 'not', child }

class Parser {
  private index = 0
  private terms = 0

  constructor(private readonly tokens: Token[], private readonly length: number) {}

  parse() {
    if (!this.tokens.length) return undefined
    const node = this.or(0, undefined)
    const extra = this.peek()
    if (extra?.type === 'close') throw new MailSearchSyntaxError(`Remove the unmatched closing parenthesis at character ${extra.position + 1}`, extra.position)
    return node
  }

  private peek() { return this.tokens[this.index] }

  private position() { return this.peek()?.position ?? this.length }

  private startsPrimary(token: Token | undefined) {
    return token !== undefined && ['word', 'phrase', 'field', 'open', 'not'].includes(token.type)
  }

  private or(depth: number, field: MailSearchField | undefined): MailSearchNode {
    const children = [this.and(depth, field)]
    while (this.peek()?.type === 'or') {
      this.index += 1
      if (!this.startsPrimary(this.peek())) throw new MailSearchSyntaxError('Add a search term after OR', this.position())
      children.push(this.and(depth, field))
    }
    return children.length === 1 ? children[0] : { kind: 'or', children }
  }

  private and(depth: number, field: MailSearchField | undefined): MailSearchNode {
    const children = [this.unary(depth, field)]
    for (;;) {
      const token = this.peek()
      if (token?.type === 'and') {
        this.index += 1
        if (!this.startsPrimary(this.peek())) throw new MailSearchSyntaxError('Add a search term after AND', this.position())
        children.push(this.unary(depth, field))
      } else if (this.startsPrimary(token)) {
        children.push(this.unary(depth, field))
      } else break
    }
    return children.length === 1 ? children[0] : { kind: 'and', children }
  }

  private unary(depth: number, field: MailSearchField | undefined): MailSearchNode {
    if (this.peek()?.type === 'not') {
      this.index += 1
      if (!this.startsPrimary(this.peek())) throw new MailSearchSyntaxError('Add a search term after NOT', this.position())
      return negate(this.unary(depth, field))
    }
    return this.primary(depth, field)
  }

  private primary(depth: number, field: MailSearchField | undefined): MailSearchNode {
    const token = this.peek()
    if (!token) throw new MailSearchSyntaxError('Finish the search', this.length)
    if (token.type === 'field') {
      if (field) throw new MailSearchSyntaxError(`Field filters such as ${token.name} cannot be nested inside another field filter`, token.position)
      this.index += 1
      const next = this.peek()
      if (!next || !['word', 'phrase', 'open'].includes(next.type)) throw new MailSearchSyntaxError(`Add a search term after ${token.name}`, this.position())
      return this.primary(depth, token.field)
    }
    if (token.type === 'open') {
      if (depth >= MAX_DEPTH) throw new MailSearchSyntaxError('This search has too many nested parentheses', token.position)
      this.index += 1
      if (this.peek()?.type === 'close') throw new MailSearchSyntaxError(`Add a search term inside the parentheses at character ${token.position + 1}`, token.position)
      if (!this.peek()) throw new MailSearchSyntaxError(`Add a closing parenthesis for the one at character ${token.position + 1}`, token.position)
      const node = this.or(depth + 1, field)
      if (this.peek()?.type !== 'close') throw new MailSearchSyntaxError(`Add a closing parenthesis for the one at character ${token.position + 1}`, token.position)
      this.index += 1
      return node
    }
    if (token.type === 'word' || token.type === 'phrase') {
      this.index += 1
      this.terms += 1
      if (this.terms > MAX_TERMS) throw new MailSearchSyntaxError(`Use ${MAX_TERMS} search terms or fewer`, token.position)
      return { kind: 'term', value: token.value, phrase: token.type === 'phrase', ...(field ? { field } : {}) }
    }
    const label = token.type === 'close' ? 'a closing parenthesis' : token.type.toUpperCase()
    throw new MailSearchSyntaxError(`Add a search term before ${label} at character ${token.position + 1}`, token.position)
  }
}

const NESTED_NOT_ERROR = 'Combine NOT with at least one term to include inside parentheses or OR groups, for example invoice NOT paid'

function compileTerm(node: Extract<MailSearchNode, { kind: 'term' }>) {
  const quoted = `"${node.value.replaceAll('"', '""')}"${node.phrase ? '' : '*'}`
  return node.field ? `${FIELD_COLUMNS[node.field]}:${quoted}` : quoted
}

function compileNode(node: MailSearchNode): string {
  if (node.kind === 'term') return compileTerm(node)
  if (node.kind === 'not') throw new MailSearchSyntaxError(NESTED_NOT_ERROR, 0)
  if (node.kind === 'or') return node.children.map((child) => `(${compileNode(child)})`).join(' OR ')
  return compileConjunction(node.children)
}

// FTS5 only has a binary NOT, so `a -b c` becomes `(a AND c) NOT (b)`.
function compileConjunction(children: MailSearchNode[]) {
  const positives = children.filter((child) => child.kind !== 'not')
  const negatives = children.flatMap((child) => child.kind === 'not' ? [child.child] : [])
  if (!positives.length) throw new MailSearchSyntaxError(NESTED_NOT_ERROR, 0)
  const included = positives.length === 1 ? compileNode(positives[0]) : positives.map((child) => `(${compileNode(child)})`).join(' AND ')
  if (!negatives.length) return included
  return `(${included}) NOT (${negatives.map((child) => `(${compileNode(child)})`).join(' OR ')})`
}

export function compileMailSearchNode(node: MailSearchNode): CompiledMailSearch {
  const children = node.kind === 'and' ? node.children : [node]
  const positives = children.filter((child) => child.kind !== 'not')
  const negatives = children.flatMap((child) => child.kind === 'not' ? [child.child] : [])
  return {
    ...(positives.length ? { include: compileConjunction(positives) } : {}),
    ...(negatives.length ? { exclude: negatives.map((child) => `(${compileNode(child)})`).join(' OR ') } : {})
  }
}

export function parseMailSearchQuery(input: string): MailSearchParseResult {
  if (typeof input !== 'string') return { ok: false, error: 'The search is invalid', position: 0 }
  if (input.length > MAIL_SEARCH_MAX_LENGTH) return { ok: false, error: `Shorten the search to ${MAIL_SEARCH_MAX_LENGTH.toLocaleString()} characters or fewer`, position: MAIL_SEARCH_MAX_LENGTH }
  try {
    const node = new Parser(tokenize(input), input.length).parse()
    return node ? { ok: true, node, compiled: compileMailSearchNode(node) } : { ok: true }
  } catch (error) {
    if (error instanceof MailSearchSyntaxError) return { ok: false, error: error.message, position: error.position }
    throw error
  }
}

/** Returns a user-facing validation message, or undefined when the search is valid. */
export function mailSearchQueryError(input: string) {
  const result = parseMailSearchQuery(input)
  return result.ok ? undefined : result.error
}

/** Compiles a search for the database, throwing a user-facing error when it is invalid. */
export function compileMailSearchQuery(input: string): CompiledMailSearch | undefined {
  const result = parseMailSearchQuery(input)
  if (!result.ok) throw new Error(result.error)
  return result.compiled
}
