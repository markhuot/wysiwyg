import { createEditor, defaultSchema, validate, type Editor, type Schema } from '../../src'
import { bind, ReplaceStep, schemaHash, type Transport } from '../../src/collab'
import { CollabServer } from '../../src/collab/server'
import { IdleBuild } from '../../src/collab/sizes'
import { posToPoint } from '../../src/dom'

const schemas: Record<string, Schema> = {
  default: defaultSchema,
  paragraph: { blocks: ['p'], marks: ['strong', 'em'], defaultBlock: 'p' },
}

let editor: Editor | undefined

/** An in-page server connection. Messages to the server wait in `held` while `hold` is set. */
function local(server: CollabServer, hold = { on: false, held: [] as (() => void)[] }): Transport {
  return {
    connect(handlers) {
      const conn = server.connect((m) => handlers.message(m))
      queueMicrotask(() => handlers.open())
      return {
        send: (m) => (hold.on ? hold.held.push(() => conn.receive(m)) : conn.receive(m)),
        close: () => conn.close(),
      }
    },
  }
}

function largeDocument(n: number): string {
  const parts = ['<h1>A large document</h1>']
  for (let i = 1; i <= n; i++) {
    parts.push(`<p>Paragraph ${i}. The quick brown fox <strong>jumps over</strong> the <em>lazy</em> dog, and <strong><em>keeps going</em></strong>.</p>`)
  }
  return parts.join('')
}

const tick = () => new Promise((r) => setTimeout(r, 0))

/** Test hooks: mount an editor on fresh markup, read it back, place the selection by block offsets. */
const fixture = {
  /** `form` mounts the editor inside a form (posting to /submitted); `name` sets the root's name attribute. */
  mount(html: string, schema = 'default', options: { form?: boolean; name?: string } = {}) {
    editor?.destroy()
    const host = document.getElementById('host')!
    const name = options.name ? ` name="${options.name}"` : ''
    const ed = `<div id="ed" contenteditable="true"${name}>${html}</div>`
    host.innerHTML = options.form
      ? `<form id="form" method="post" action="/submitted"><input name="title" value="t">${ed}<button>Submit</button></form>`
      : ed
    const el = host.querySelector('#ed') as HTMLElement
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

  /**
   * Times the multiplayer paths on a document of `n` paragraphs against an
   * in-page server: the idle build's slices, finishing it synchronously from
   * scratch, a keystroke becoming a step, rebasing an unconfirmed keystroke
   * over a remote step, and applying a remote step.
   */
  async perf(n = 3000) {
    editor?.destroy()
    const host = document.getElementById('host')!
    const html = largeDocument(n)
    host.innerHTML = `<div id="ed" contenteditable="true" data-version="0">${html}</div>`
    const el = host.firstElementChild as HTMLElement

    const idle = new IdleBuild(el).start()
    while (!idle.done) await new Promise((r) => setTimeout(r, 5))

    let start = performance.now()
    new IdleBuild(el).finish()
    const finish = performance.now() - start

    const server = new CollabServer({ schema: defaultSchema, html: () => html })
    const hold = { on: false, held: [] as (() => void)[] }
    editor = createEditor(el)
    const collab = bind(editor, { server: local(server, hold), online: false, sizes: { version: 0, sizes: server.authority('default').sizesAt(0) } })
    collab.online = true
    await tick()
    const other = server.connect(() => {})
    other.receive({ v: 1, type: 'hello', doc: 'default', clientId: 'other', schemaHash: schemaHash(defaultSchema), version: 0 })

    const block = el.children[2000]!
    const keystroke = () => {
      const text = block.firstChild as Text
      el.focus()
      document.getSelection()!.collapse(text, 5)
      const event = new InputEvent('beforeinput', { inputType: 'insertText', data: 'x', bubbles: true, cancelable: true })
      const t = performance.now()
      el.dispatchEvent(event)
      return performance.now() - t
    }
    const remote = (version: number) => {
      const t = performance.now()
      other.receive({ v: 1, type: 'steps', version, steps: [new ReplaceStep(20, 20, [{ kind: 'text', text: 'r', marks: [] }]).toJSON()], clientId: 'other' })
      return performance.now() - t
    }
    // Medians of several runs, so one GC pause or a busy machine doesn't decide the result.
    const median = (xs: number[]) => xs.sort((x, y) => x - y)[xs.length >> 1]!
    const steps: number[] = []
    const applies: number[] = []
    const rebases: number[] = []
    for (let i = 0; i < 7; i++) {
      steps.push(keystroke())
      await tick()
      applies.push(remote(server.authority('default').version))
      // Hold our next keystroke on the wire so the remote step has to rebase it.
      hold.on = true
      keystroke()
      rebases.push(remote(server.authority('default').version))
      hold.on = false
      for (const send of hold.held.splice(0)) send()
      await tick()
      // Past the typing merge window, so every keystroke is a fresh step.
      await new Promise((r) => setTimeout(r, 0))
    }
    const step = median(steps)
    const apply = median(applies)
    const rebase = median(rebases)

    collab.destroy()
    const converged = el.innerHTML === server.authority('default').htmlAt()
    return { slices: idle.stats.slices, longestSlice: idle.stats.longest, finish, step, apply, rebase, converged, blocks: el.children.length }
  },
}

declare global {
  interface Window {
    fixture: typeof fixture
  }
}

window.fixture = fixture
