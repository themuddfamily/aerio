// DOM helpers for the rich Notes editor (see docs/rich-notes.md). The stored
// format itself is described in note-rich-text.ts.

import { sanitizePastedHtml } from './mail-paste'
import { NOTE_IMAGE_ATTRIBUTE, isNoteImageId, noteHtmlToText } from './note-rich-text'

/**
 * Applies the composer allowlist to a rich note body. Pictures keep only a
 * reference to one of `imageIds` (the note's inline attachments); their `src`
 * is always removed, so neither remote addresses nor data URLs are stored.
 */
export function sanitizeNoteHtml(html: string, document: Document, imageIds: ReadonlySet<string>) {
  return sanitizePastedHtml(html, document, {
    preserveEdgeWhitespace: true,
    images: {
      attributes: [NOTE_IMAGE_ATTRIBUTE],
      keep(element) {
        element.removeAttribute('src')
        const id = element.getAttribute(NOTE_IMAGE_ATTRIBUTE)
        return isNoteImageId(id) && imageIds.has(id)
      }
    }
  })
}

/** The stored body and plain-text projection of the editor's current content. */
export function serializeNoteEditor(editor: HTMLElement, imageIds: ReadonlySet<string>) {
  const html = sanitizeNoteHtml(editor.innerHTML, editor.ownerDocument, imageIds)
  return { html, content: noteHtmlToText(html) }
}

const structuralParents = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'ul', 'ol', 'colgroup'])
const blockElements = new Set(['address', 'blockquote', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'li', 'ol', 'p', 'pre', 'table', 'ul', 'tr', 'td', 'th', 'tbody', 'thead', 'tfoot', 'caption'])
const isBlock = (node: Node | null) => node?.nodeType === 1 && blockElements.has((node as Element).localName)

/**
 * The note editor shows whitespace as typed (`pre-wrap`), so source
 * formatting in pasted HTML (indentation and line breaks between tags) would
 * otherwise appear as blank lines. Collapses it the way a browser would
 * display the pasted HTML; `<pre>` content is left alone.
 */
export function collapsePastedWhitespace(html: string, document: Document) {
  const template = document.createElement('template')
  template.innerHTML = html
  const walk = (parent: Node) => {
    for (const node of Array.from(parent.childNodes)) {
      if (node.nodeType === 1) {
        if ((node as Element).localName !== 'pre') walk(node)
        continue
      }
      if (node.nodeType !== 3) continue
      let value = (node.textContent ?? '').replace(/[\t\n\r\f ]+/g, ' ')
      const parentName = parent.nodeType === 1 ? (parent as Element).localName : ''
      // Like rendered HTML, a line does not start or end with collapsed source whitespace.
      const blockParent = parent.nodeType !== 1 || blockElements.has(parentName)
      if (blockParent && (!node.previousSibling || isBlock(node.previousSibling))) value = value.trimStart()
      if (blockParent && (!node.nextSibling || isBlock(node.nextSibling))) value = value.trimEnd()
      if (!value || (!value.trim() && (structuralParents.has(parentName) || isBlock(node.previousSibling) || isBlock(node.nextSibling)))) node.remove()
      else node.textContent = value
    }
  }
  walk(template.content)
  const container = document.createElement('div')
  container.append(template.content)
  return container.innerHTML
}

/** Pictures placed in the editor (inserted, pasted, or dropped) that are not stored yet. */
export const pendingEditorImages = (editor: HTMLElement) => Array.from(editor.querySelectorAll('img'))
  .filter((image) => !image.hasAttribute(NOTE_IMAGE_ATTRIBUTE) && /^data:image\//i.test(image.getAttribute('src') ?? ''))
