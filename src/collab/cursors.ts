import { comparePos, posToPoint, type Pos } from '../dom'
import type { Presence } from './protocol'

type Resolve = (p: Presence) => { anchor: Pos; head: Pos } | null

/**
 * Other clients' carets and selections, drawn in a layer over the page,
 * outside the editable root: they never enter the document, its HTML or its
 * form value, and the browser never edits them. Made on the first presence
 * message, never at boot.
 */
export class Cursors {
  readonly layer: HTMLElement
  private readonly presences = new Map<string, { presence: Presence; resolve: Resolve }>()
  private frame = 0
  private readonly onMove = () => this.redraw()

  constructor(private readonly root: HTMLElement) {
    const doc = root.ownerDocument
    this.layer = doc.createElement('div')
    this.layer.className = 'wysiwyg-cursors'
    this.layer.setAttribute('aria-hidden', 'true')
    this.layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;overflow:hidden'
    doc.body.append(this.layer)
    doc.addEventListener('scroll', this.onMove, true)
    doc.defaultView?.addEventListener('resize', this.onMove)
  }

  set(presence: Presence, resolve: Resolve): void {
    this.presences.set(presence.clientId, { presence, resolve })
    this.redraw()
  }

  list(): Presence[] {
    return [...this.presences.values()].map((p) => p.presence)
  }

  remove(clientId: string): void {
    if (this.presences.delete(clientId)) this.redraw()
  }

  /** Redraws on the next frame, once however many changes come in. */
  redraw(): void {
    if (this.frame) return
    const raf = globalThis.requestAnimationFrame ?? ((cb: () => void) => setTimeout(cb, 16))
    this.frame = raf(() => {
      this.frame = 0
      this.draw()
    }) as number
  }

  draw(): void {
    const doc = this.root.ownerDocument
    const parts: HTMLElement[] = []
    for (const { presence, resolve } of this.presences.values()) {
      const at = resolve(presence)
      if (!at) continue
      const [from, to] = comparePos(at.anchor, at.head) <= 0 ? [at.anchor, at.head] : [at.head, at.anchor]
      const range = doc.createRange()
      const a = posToPoint(from)
      const b = posToPoint(to)
      range.setStart(a.node, a.offset)
      range.setEnd(b.node, b.offset)
      if (!range.collapsed) {
        for (const r of range.getClientRects()) {
          parts.push(box(doc, r.left, r.top, r.width, r.height, `background:${presence.color};opacity:.25`))
        }
      }
      const caret = doc.createRange()
      const h = posToPoint(at.head)
      caret.setStart(h.node, h.offset)
      const rect = caret.getClientRects()[0] ?? at.head.block.getBoundingClientRect()
      const height = rect.height || 18
      const el = box(doc, rect.left, rect.top, 2, height, `background:${presence.color}`)
      el.dataset.clientId = presence.clientId
      el.className = 'wysiwyg-cursor'
      const label = doc.createElement('span')
      label.textContent = presence.name
      label.style.cssText = `position:absolute;left:0;bottom:100%;white-space:nowrap;font:600 11px/1.4 system-ui,sans-serif;color:#fff;background:${presence.color};padding:0 4px;border-radius:3px 3px 3px 0`
      el.append(label)
      parts.push(el)
    }
    this.layer.replaceChildren(...parts)
  }

  destroy(): void {
    const doc = this.root.ownerDocument
    doc.removeEventListener('scroll', this.onMove, true)
    doc.defaultView?.removeEventListener('resize', this.onMove)
    this.layer.remove()
  }
}

function box(doc: Document, left: number, top: number, width: number, height: number, style: string): HTMLElement {
  const el = doc.createElement('div')
  el.style.cssText = `position:absolute;left:${left}px;top:${top}px;width:${width}px;height:${height}px;${style}`
  return el
}
