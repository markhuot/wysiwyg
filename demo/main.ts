import { createEditor, defaultSchema, validate, type Editor, type Schema } from '../src'
import { posToPoint } from '../src/dom'

const paragraphSchema: Schema = { blocks: ['p'], marks: ['strong', 'em'], defaultBlock: 'p' }

const PARAGRAPHS = 3000

/** The author's markup for the large editor. Built before boot, so it isn't part of the boot time. */
function largeDocument(): string {
  const parts = [
    '<h1>A large document</h1>',
    `<p>This editor starts with ${PARAGRAPHS.toLocaleString()} paragraphs. <strong>createEditor</strong> never reads them, so boot time doesn't grow with the document.</p>`,
  ]
  for (let i = 1; i <= PARAGRAPHS; i++) {
    if (i % 50 === 1) parts.push(`<h2>Section ${Math.ceil(i / 50)}</h2>`)
    parts.push(
      `<p>Paragraph ${i}. The quick brown fox <strong>jumps over</strong> the <em>lazy</em> dog, and <strong><em>keeps going</em></strong>.</p>`,
    )
  }
  return parts.join('')
}

const elA = document.getElementById('editor-a')!
const elB = document.getElementById('editor-b')!
elA.innerHTML = largeDocument()

function boot(el: HTMLElement, schema: Schema): Editor {
  const start = performance.now()
  const editor = createEditor(el, schema)
  const ms = performance.now() - start
  const card = el.closest('.card')!
  card.querySelector('[data-boot]')!.textContent = `createEditor: ${ms.toFixed(3)} ms`
  card.querySelector('[data-size]')!.textContent = `${el.children.length.toLocaleString()} blocks`
  return editor
}

const a = boot(elA, defaultSchema)
const b = boot(elB, paragraphSchema)

/** Live innerHTML and validate() badge. The demo observes; the editor doesn't need to. */
function watch(el: HTMLElement, schema: Schema): void {
  const card = el.closest('.card')!
  const pre = card.querySelector('[data-html]')!
  const badge = card.querySelector('[data-valid]')!
  let queued = false
  const render = () => {
    queued = false
    const html = el.innerHTML
    pre.textContent = html.length > 4000 ? `${html.slice(0, 4000)}… (${html.length.toLocaleString()} chars)` : html
    const violations = validate(el, schema)
    badge.textContent = violations.length ? `${violations.length} violations` : 'valid'
    badge.className = `badge ${violations.length ? 'bad' : 'ok'}`
    card.querySelector('[data-size]')!.textContent = `${el.children.length.toLocaleString()} blocks`
  }
  new MutationObserver(() => {
    if (!queued) requestAnimationFrame(render)
    queued = true
  }).observe(el, { subtree: true, childList: true, characterData: true })
  render()
}

watch(elA, defaultSchema)
watch(elB, paragraphSchema)

// A handle for the e2e tests and for poking around in the console.
const handle = { a, b, createEditor, validate, posToPoint }

declare global {
  interface Window {
    demo: typeof handle
  }
}

window.demo = handle
