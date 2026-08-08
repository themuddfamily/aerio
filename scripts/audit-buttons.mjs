import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { API } from 'typescript/unstable/sync'
import {
  isJsxAttribute,
  isJsxElement,
  isJsxOpeningElement,
  isJsxSelfClosingElement,
  isStringLiteral
} from 'typescript/unstable/ast/is'

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
    .filter(isJsxAttribute)
    .map((attribute) => [attribute.name.getText(source), attribute]))
}

function isSubmitButton(attributes) {
  const type = attributes.get('type')
  return type?.initializer && isStringLiteral(type.initializer) && type.initializer.text === 'submit'
}

function hasSubmitForm(node, source) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (isJsxElement(parent) && parent.openingElement.tagName.getText(source) === 'form') {
      return attributesOf(parent.openingElement, source).has('onSubmit')
    }
  }
  return false
}

const api = new API({ cwd: process.cwd() })
const snapshot = api.updateSnapshot({ openProjects: ['tsconfig.json'] })

for (const file of sourceFiles('src')) {
  const project = snapshot.getDefaultProjectForFile(file)
  const source = project?.program.getSourceFile(file)
  if (!source) throw new Error(`Could not parse ${file}`)
  const visit = (node) => {
    if (isJsxOpeningElement(node) || isJsxSelfClosingElement(node)) {
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
    node.forEachChild(visit)
  }
  visit(source)
}

snapshot.dispose()
api.close()

if (missing.length) {
  console.error(`Enabled JSX buttons without an action:\n${missing.join('\n')}`)
  process.exit(1)
}
console.log(`Button contract audit passed: ${total} JSX button definitions have an action, handled submit role, or explicit disabled state.`)
