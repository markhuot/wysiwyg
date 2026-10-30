import { createEditor, defaultSchema, validate, type Editor, type Schema } from '../../src'
import { posToPoint } from '../../src/dom'

const schemas: Record<string, Schema> = {
  default: defaultSchema,
  paragraph: { blocks: ['p'], marks: ['strong', 'em'], defaultBlock: 'p' },
}

let editor: Editor | undefined

/** Test hooks: mount an editor on fresh markup, read it back, place the selection by block offsets. */
const fixture = {
  mount(html: string, schema = 'default') {
    editor?.destroy()
    const host = document.getElementById('host')!
    host.innerHTML = `<div id="ed" contenteditable="true">${html}</div>`
    const el = host.firstElementChild as HTMLElement
    editor = createEditor(el, schemas[schema]!)
    el.focus()
  },
  html: () => editor!.getHTML(),
  violations: () => validate(editor!.root, editor!.schema).map((v) => v.message),
  select(block: number, offset: number, endBlock = block, endOffset = offset) {
    const root = editor!.root
    const a = posToPoint({ block: root.children[block]!, offset })
    const b = posToPoint({ block: root.children[endBlock]!, offset: endOffset })
    root.focus()
    document.getSelection()!.setBaseAndExtent(a.node, a.offset, b.node, b.offset)
  },
}

declare global {
  interface Window {
    fixture: typeof fixture
  }
}

window.fixture = fixture
