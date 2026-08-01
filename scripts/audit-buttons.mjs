import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith('.tsx') ? [path] : []
  })
}

const missing = []
let total = 0

function attributesOf(node, source) {
  return new Map(node.attributes.properties
    .filter(ts.isJsxAttribute)
    .map((attribute) => [attribute.name.getText(source), attribute]))
}

function isSubmitButton(attributes) {
  const type = attributes.get('type')
  return type?.initializer && ts.isStringLiteral(type.initializer) && type.initializer.text === 'submit'
}

function hasSubmitForm(node, source) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isJsxElement(parent) && parent.openingElement.tagName.getText(source) === 'form') {
      return attributesOf(parent.openingElement, source).has('onSubmit')
    }
  }
  return false
}

for (const file of sourceFiles('src')) {
  const text = readFileSync(file, 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const visit = (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (node.tagName.getText(source) === 'button') {
        total += 1
        const attributes = attributesOf(node, source)
        const submitsHandledForm = isSubmitButton(attributes) && hasSubmitForm(node, source)
        if (!attributes.has('onClick') && !submitsHandledForm && !attributes.has('disabled')) {
          const position = source.getLineAndCharacterOfPosition(node.getStart(source))
          missing.push(`${file}:${position.line + 1}`)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}

if (missing.length) {
  console.error(`Enabled JSX buttons without an action:\n${missing.join('\n')}`)
  process.exit(1)
}
console.log(`Button contract audit passed: ${total} JSX button definitions have an action, handled submit role, or explicit disabled state.`)
