import { API } from 'typescript/unstable/sync'
import { isJsxAttribute, isJsxOpeningElement, isJsxSelfClosingElement } from 'typescript/unstable/ast/is'

const required = new Map([
  ['src/App.tsx', 3],
  ['src/components/TitleBar.tsx', 1],
  ['src/components/MailComposeModal.tsx', 1],
  ['src/views/CalendarView.tsx', 3],
  ['src/views/ContactsView.tsx', 3],
  ['src/views/TasksView.tsx', 3],
  ['src/views/NotesView.tsx', 3],
  ['src/views/ConnectedMailView.tsx', 3]
])

const missing = []
let total = 0
const api = new API({ cwd: process.cwd() })
const snapshot = api.updateSnapshot({ openProjects: ['tsconfig.json'] })

for (const [file, minimum] of required) {
  const project = snapshot.getDefaultProjectForFile(file)
  const source = project?.program.getSourceFile(file)
  if (!source) throw new Error(`Could not parse ${file}`)
  let count = 0
  const visit = (node) => {
    if ((isJsxOpeningElement(node) || isJsxSelfClosingElement(node)) && node.attributes.properties.some((property) => isJsxAttribute(property) && property.name.getText(source) === 'onContextMenu')) count += 1
    node.forEachChild(visit)
  }
  visit(source)
  total += count
  if (count < minimum) missing.push(`${file}: expected at least ${minimum}, found ${count}`)
}

snapshot.dispose()
api.close()

if (missing.length || total < 30) {
  console.error(`Context-menu coverage audit failed:\n${[...missing, ...(total < 30 ? [`expected at least 30 right-click targets, found ${total}`] : [])].join('\n')}`)
  process.exit(1)
}

console.log(`Context-menu coverage audit passed: ${total} right-click target definitions span global chrome, compose surfaces, and connected features.`)
