import { readFileSync } from 'node:fs'
import ts from 'typescript'

const required = new Map([
  ['src/App.tsx', 3],
  ['src/components/TitleBar.tsx', 1],
  ['src/components/ComposeModal.tsx', 1],
  ['src/components/GmailComposeModal.tsx', 1],
  ['src/views/MailView.tsx', 3],
  ['src/views/CalendarView.tsx', 3],
  ['src/views/ContactsView.tsx', 3],
  ['src/views/TasksView.tsx', 3],
  ['src/views/NotesView.tsx', 3],
  ['src/views/ChatView.tsx', 3],
  ['src/views/GmailView.tsx', 3]
])

const missing = []
let total = 0

for (const [file, minimum] of required) {
  const text = readFileSync(file, 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let count = 0
  const visit = (node) => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.attributes.properties.some((property) => ts.isJsxAttribute(property) && property.name.getText(source) === 'onContextMenu')) count += 1
    ts.forEachChild(node, visit)
  }
  visit(source)
  total += count
  if (count < minimum) missing.push(`${file}: expected at least ${minimum}, found ${count}`)
}

if (missing.length || total < 40) {
  console.error(`Context-menu coverage audit failed:\n${[...missing, ...(total < 40 ? [`expected at least 40 right-click targets, found ${total}`] : [])].join('\n')}`)
  process.exit(1)
}

console.log(`Context-menu coverage audit passed: ${total} right-click target definitions span global chrome, compose surfaces, and every feature.`)
