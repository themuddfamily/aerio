import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { KEYMAP_DOC_END, KEYMAP_DOC_START, keymapReferenceMarkdown } from './keymap'

const docPath = fileURLToPath(new URL('../../docs/keyboard-shortcuts.md', import.meta.url))

// Regenerate the table with: AERIO_WRITE_KEYMAP_DOC=1 npx vitest run src/lib/keymap-doc.test.ts
describe('keyboard shortcut reference', () => {
  it('matches the keymap registry defaults', () => {
    const doc = readFileSync(docPath, 'utf8').replace(/\r\n/g, '\n')
    const start = doc.indexOf(KEYMAP_DOC_START)
    const end = doc.indexOf(KEYMAP_DOC_END)
    expect(start, 'docs/keyboard-shortcuts.md needs the keymap markers').toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const generated = `\n\n${keymapReferenceMarkdown()}\n\n`
    if (process.env.AERIO_WRITE_KEYMAP_DOC === '1') {
      writeFileSync(docPath, `${doc.slice(0, start + KEYMAP_DOC_START.length)}${generated}${doc.slice(end)}`)
      return
    }
    expect(doc.slice(start + KEYMAP_DOC_START.length, end), 'Regenerate docs/keyboard-shortcuts.md with AERIO_WRITE_KEYMAP_DOC=1').toBe(generated)
  })
})
