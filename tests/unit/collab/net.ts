import { bind, type BindOptions, type Collab } from '../../../src/collab'
import { posToPoint } from '../../../src/dom'
import { CollabServer } from '../../../src/collab/server'
import type { Transport } from '../../../src/collab/transport'
import { createEditor, type Editor } from '../../../src/editor'
import { defaultSchema, validate, type Schema } from '../../../src/schema'

/** A deterministic network: messages wait in a queue until the test delivers them. */
export class Net {
  private queue: { at: number; seq: number; fn: () => void }[] = []
  private now = 0
  private seq = 0
  readonly server: CollabServer

  constructor(
    html: string,
    readonly schema: Schema = defaultSchema,
    private readonly latency: () => number = () => 1,
  ) {
    this.server = new CollabServer({ schema, html: () => html })
  }

  get authority() {
    return this.server.authority('default')
  }

  private push(at: number, fn: () => void): void {
    this.queue.push({ at, seq: this.seq++, fn })
    this.queue.sort((a, b) => a.at - b.at || a.seq - b.seq)
  }

  transport(): Transport {
    return {
      connect: (handlers) => {
        let open = true
        const last = { up: 0, down: 0 }
        const later = (way: 'up' | 'down', fn: () => void) => {
          const at = Math.max(this.now + this.latency(), last[way])
          last[way] = at
          this.push(at, () => open && fn())
        }
        const conn = this.server.connect((message) => later('down', () => handlers.message(message)))
        later('down', () => handlers.open())
        return {
          send: (message) => later('up', () => conn.receive(message)),
          close: () => {
            open = false
            conn.close()
          },
        }
      },
    }
  }

  /** Delivers up to `n` messages, or all of them. */
  deliver(n = Infinity): number {
    let done = 0
    while (this.queue.length && done < n) {
      const next = this.queue.shift()!
      this.now = Math.max(this.now, next.at)
      next.fn()
      done++
    }
    return done
  }

  get queued(): number {
    return this.queue.length
  }
}

export interface Client {
  editor: Editor
  collab: Collab
  root: HTMLElement
}

export function client(net: Net, html = net.authority.htmlAt(0), version = 0, options: Partial<BindOptions> = {}): Client {
  const root = document.createElement('div')
  root.setAttribute('contenteditable', 'true')
  root.setAttribute('data-version', String(version))
  root.innerHTML = html
  document.body.append(root)
  const editor = createEditor(root, net.schema)
  const collab = bind(editor, { server: net.transport(), online: false, debug: true, ...options })
  return { editor, collab, root }
}

export function select(c: Client, block: number, offset: number, endBlock = block, endOffset = offset): void {
  const a = posToPoint({ block: c.root.children[block]!, offset })
  const b = posToPoint({ block: c.root.children[endBlock]!, offset: endOffset })
  document.getSelection()!.setBaseAndExtent(a.node, a.offset, b.node, b.offset)
}

export function input(c: Client, inputType: string, data?: string): void {
  const event = new InputEvent('beforeinput', { inputType, data, bubbles: true, cancelable: true, composed: true })
  c.root.dispatchEvent(event)
}

export function typeAt(c: Client, block: number, offset: number, text: string): void {
  select(c, block, offset)
  input(c, 'insertText', text)
}

/** Brings everyone online and delivers until nothing is left to send. */
export function settle(net: Net, clients: Client[]): void {
  for (const c of clients) c.collab.online = true
  for (let i = 0; i < 1000; i++) {
    net.deliver()
    if (!net.queued && clients.every((c) => !c.collab.pending)) return
  }
  throw new Error('the network never settled')
}

export function expectConverged(net: Net, clients: Client[]): string {
  const html = net.authority.htmlAt()
  for (const c of clients) {
    if (c.root.innerHTML !== html) throw new Error(`client ${c.collab.clientId} diverged:\n  ${c.root.innerHTML}\nserver:\n  ${html}`)
    const violations = validate(c.root, net.schema)
    if (violations.length) throw new Error(`invalid: ${violations.map((v) => v.message).join(', ')}`)
    if (!c.collab.check()) throw new Error('the debug check failed')
  }
  return html
}
