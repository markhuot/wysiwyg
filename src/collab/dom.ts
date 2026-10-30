import { readBlock, writeBlock, type Item } from '../inline'
import type { Schema } from '../schema'
import { checkNodes, checkTag, cut, element, EMPTY, flatten, markContent, mergeText, nodeSize, parse, StepError, type Attrs, type ElementNode, type Node, type Token } from './model'
import type { SizeIndex } from './sizes'
import type { Target } from './steps'

export function attrsOf(block: Element): Attrs {
  if (!block.attributes.length) return EMPTY
  const out: Record<string, string> = {}
  for (const a of block.attributes) out[a.name] = a.value
  return out
}

/** A live block as a model node. */
export function readNode(block: Element, schema: Schema): ElementNode {
  return element(block.localName, mergeText(readBlock(block, schema)), attrsOf(block))
}

export function readTokens(blocks: readonly Element[], schema: Schema): Token[] {
  return flatten(blocks.map((b) => readNode(b, schema)))
}

/**
 * Applies steps to the editor's live DOM. It touches only the blocks a
 * step's range covers: they're read into tokens, spliced exactly as the
 * model splices them, and written back with `writeBlock`. The size index
 * converts positions to blocks and is kept up to date.
 */
export class DomTarget implements Target {
  constructor(
    readonly root: Element,
    readonly schema: Schema,
    readonly index: SizeIndex,
  ) {}

  private blocks(first: number, last: number): Element[] {
    const out: Element[] = []
    for (let b = this.root.children[first] ?? null; b && out.length <= last - first; b = b.nextElementSibling) out.push(b)
    return out
  }

  /** The blocks a range touches: `first` to `last`, or none (`last < first`) for an insertion between blocks. */
  private region(from: number, to: number): [number, number] {
    const { index } = this
    if (from < 0 || to > index.total || from > to) throw new StepError(`range ${from}–${to} is outside the document (size ${index.total})`)
    const first = index.find(from)
    if (from === to && (first === index.count || index.start(first) === from)) return [first, first - 1]
    return [first, index.find(to - 1)]
  }

  replace(from: number, to: number, slice: readonly Token[]): Token[] {
    const [first, last] = this.region(from, to)
    const old = this.blocks(first, last)
    const start = this.index.start(first)
    const tokens = readTokens(old, this.schema)
    const removed = cut(tokens, from - start, to - start)
    const nodes = parse([...cut(tokens, 0, from - start), ...slice, ...cut(tokens, to - start)])
    checkNodes(nodes, 'doc', this.schema)
    if (this.index.count - old.length + nodes.length === 0) throw new StepError('the document needs at least one block')
    this.write(old, nodes, first)
    this.index.splice(first, old.length, nodes.map(nodeSize))
    return removed
  }

  mark(from: number, to: number, mark: string, add: boolean): [number, number][] {
    if (!this.schema.marks.includes(mark)) throw new StepError(`<${mark}> is not an allowed mark`)
    const [first, last] = this.region(from, to)
    const old = this.blocks(first, last)
    const start = this.index.start(first)
    const changed: [number, number][] = []
    const nodes = markContent(old.map((b) => readNode(b, this.schema)), from - start, to - start, mark, add, this.schema, start, changed)
    if (changed.length) this.write(old, nodes, first)
    return changed
  }

  setBlock(pos: number, tag: string, attrs: Attrs): { tag: string; attrs: Attrs } {
    const i = this.index.find(pos)
    if (i >= this.index.count || this.index.start(i) !== pos) throw new StepError(`no block starts at ${pos}`)
    checkTag(tag, 'doc', this.schema)
    const block = this.root.children[i]!
    const old = { tag: block.localName, attrs: attrsOf(block) }
    const next = this.root.ownerDocument.createElement(tag)
    for (const [k, v] of Object.entries(attrs)) next.setAttribute(k, v)
    next.append(...block.childNodes)
    block.replaceWith(next)
    return old
  }

  /** Writes `nodes` where `old` were, reusing an element when its tag and attributes still fit. */
  private write(old: readonly Element[], nodes: readonly Node[], first: number): void {
    const doc = this.root.ownerDocument
    let before: ChildNode | null = old.length ? old.at(-1)!.nextSibling : (this.root.children[first] ?? null)
    const reuse = old.slice()
    const out: Element[] = []
    for (const node of nodes) {
      const n = node as ElementNode
      let el = reuse[0]
      if (el && el.localName === n.tag && sameAttrs(attrsOf(el), n.attrs)) {
        reuse.shift()
      } else {
        el = doc.createElement(n.tag)
        for (const [k, v] of Object.entries(n.attrs)) el.setAttribute(k, v)
      }
      writeBlock(el, n.content as Item[], this.schema)
      out.push(el)
    }
    for (const el of reuse) el.remove()
    // Put the blocks in order, moving only the ones that aren't already there.
    for (let i = out.length - 1; i >= 0; i--) {
      const el = out[i]!
      if (el.nextSibling !== before || el.parentNode !== this.root) this.root.insertBefore(el, before)
      before = el
    }
  }
}

function sameAttrs(a: Attrs, b: Attrs): boolean {
  const ka = Object.keys(a)
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k])
}

