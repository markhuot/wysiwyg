import { createEditor, defaultSchema, validate, type Editor, type Schema } from '../src'
import { bind, websocket, withLatency, type Collab, type CollabEvent } from '../src/collab'
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

// The form: the editors post like textareas. Submit shows what would be posted instead of leaving the page.
const form = document.getElementById('single') as HTMLFormElement
form.addEventListener('submit', (e) => {
  e.preventDefault()
  const lines = [...new FormData(form)].map(([name, value]) => {
    const html = String(value)
    return `${name} = ${html.length > 600 ? `${html.slice(0, 600)}… (${html.length.toLocaleString()} chars)` : html}`
  })
  form.querySelector('[data-posted]')!.textContent = lines.join('\n\n')
})

// The collaborative editors: both start from the server's HTML at one version, with its size index.
const params = new URLSearchParams(location.search)
const docId = params.get('doc') ?? 'demo'

interface CollabCard {
  editor: Editor
  collab: Collab
}

async function collaborate(): Promise<{ c: CollabCard; d: CollabCard }> {
  const query = new URLSearchParams({ doc: docId })
  if (params.has('version')) query.set('version', params.get('version')!)
  const payload: { html: string; version: number; head: number; sizes: number[] } = await (await fetch(`/collab/doc?${query}`)).json()
  // Kept as text until the binding needs it, as it would be in a <script type="application/json">.
  const sizes = JSON.stringify({ version: payload.version, sizes: payload.sizes })

  const older = document.querySelector<HTMLAnchorElement>('[data-older]')!
  older.href = `?${new URLSearchParams({ doc: docId, version: String(Math.max(0, payload.head - 10)) })}`

  const start = (id: string, name: string, color: string): CollabCard => {
    const el = document.getElementById(id)!
    el.innerHTML = payload.html
    el.dataset.version = String(payload.version)
    const card = el.closest('.card')!
    const latency = card.querySelector<HTMLSelectElement>('[data-latency]')!
    const online = card.querySelector<HTMLInputElement>('[data-online]')!
    online.checked = !params.has('offline')
    const editor = createEditor(el, defaultSchema)
    const collab = bind(editor, {
      server: withLatency(websocket('/collab'), () => Number(latency.value)),
      doc: docId,
      sizes: () => JSON.parse(sizes),
      name,
      color,
      online: online.checked,
    })
    online.addEventListener('change', () => (collab.online = online.checked))

    const status = card.querySelector('[data-status]')!
    const sync = card.querySelector('[data-sync]')!
    const badge = card.querySelector('[data-valid]')!
    const render = () => {
      sync.textContent = `v${collab.confirmedVersion} · ${collab.pending} unsent`
      const violations = validate(el, defaultSchema)
      badge.textContent = violations.length ? `${violations.length} violations` : 'valid'
      badge.className = `badge ${violations.length ? 'bad' : 'ok'}`
    }
    collab.addEventListener('status', (e) => {
      const { status: s } = (e as Event & { detail: Extract<CollabEvent, { type: 'status' }> }).detail
      status.textContent = s
      status.className = `badge ${s === 'online' ? 'ok' : s === 'offline' ? 'bad' : ''}`
    })
    collab.addEventListener('error', (e) => console.error((e as Event & { detail: CollabEvent }).detail))
    collab.addEventListener('sync', render)
    status.textContent = online.checked ? 'connecting' : 'offline'
    new MutationObserver(() => requestAnimationFrame(render)).observe(el, { subtree: true, childList: true, characterData: true })
    render()
    return { editor, collab }
  }

  return { c: start('editor-c', 'Ada', '#d0368a'), d: start('editor-d', 'Grace', '#0a7ea4') }
}

const collabReady = collaborate()

// A handle for the e2e tests and for poking around in the console.
const handle = { a, b, createEditor, bind, validate, posToPoint, collab: collabReady }

declare global {
  interface Window {
    demo: typeof handle
  }
}

window.demo = handle
