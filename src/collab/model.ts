import { BR, nest, type Item, type Nested } from '../inline'
import type { Schema } from '../schema'

/**
 * The document as data, for the server, for tests and for checking the live
 * DOM against. It's a tree: the doc holds blocks, blocks hold inline items.
 * Nothing here assumes one level, so containers (lists, tables, cells) are
 * just more element nodes with element children.
 *
 * Positions are flat integers, as in ProseMirror: entering or leaving an
 * element counts 1, a UTF-16 unit or a `<br>` counts 1. Position 0 is the
 * start of the doc's content.
 */
export type Attrs = Readonly<Record<string, string>>

export interface ElementNode {
  readonly kind: 'node'
  readonly tag: string
  readonly attrs: Attrs
  readonly content: readonly Node[]
}

export type Node = ElementNode | Item

/** The flat form of content. A slice is a token list, and may leave elements open at either end. */
export type Token = Item | { readonly kind: 'open'; readonly tag: string; readonly attrs?: Attrs } | { readonly kind: 'close' }

export const CLOSE: Token = { kind: 'close' }

/** Thrown when a step doesn't apply: positions out of range, unbalanced content or a schema violation. */
export class StepError extends Error {}

export const EMPTY: Attrs = Object.freeze({})

export function element(tag: string, content: readonly Node[] = [], attrs: Attrs = EMPTY): ElementNode {
  return { kind: 'node', tag, attrs, content }
}

export function tokenSize(token: Token): number {
  return token.kind === 'text' ? token.text.length : 1
}

export function nodeSize(node: Node): number {
  if (node.kind === 'text') return node.text.length
  if (node.kind === 'br') return 1
  return 2 + contentSize(node.content)
}

export function contentSize(content: readonly Node[]): number {
  let n = 0
  for (const node of content) n += nodeSize(node)
  return n
}

export function sliceSize(tokens: readonly Token[]): number {
  let n = 0
  for (const t of tokens) n += tokenSize(t)
  return n
}

export function flatten(nodes: readonly Node[], out: Token[] = []): Token[] {
  for (const node of nodes) {
    if (node.kind !== 'node') {
      out.push(node)
    } else {
      out.push(node.attrs === EMPTY || !Object.keys(node.attrs).length ? { kind: 'open', tag: node.tag } : { kind: 'open', tag: node.tag, attrs: node.attrs })
      flatten(node.content, out)
      out.push(CLOSE)
    }
  }
  return out
}

/** Builds nodes from balanced tokens. Throws on a stray close or an unclosed open. */
export function parse(tokens: readonly Token[]): Node[] {
  const stack: { tag: string; attrs: Attrs; content: Node[] }[] = [{ tag: '', attrs: EMPTY, content: [] }]
  for (const t of tokens) {
    if (t.kind === 'open') {
      stack.push({ tag: t.tag, attrs: t.attrs ?? EMPTY, content: [] })
    } else if (t.kind === 'close') {
      const done = stack.pop()!
      if (!stack.length) throw new StepError('unbalanced content: a close with nothing open')
      stack.at(-1)!.content.push(element(done.tag, mergeText(done.content), done.attrs))
    } else {
      stack.at(-1)!.content.push(t)
    }
  }
  if (stack.length !== 1) throw new StepError('unbalanced content: an open that never closes')
  return mergeText(stack[0]!.content)
}

/** The tokens between unit offsets `from` and `to`, splitting text at the edges. */
export function cut(tokens: readonly Token[], from: number, to = Infinity): Token[] {
  const out: Token[] = []
  let start = 0
  for (const t of tokens) {
    const end = start + tokenSize(t)
    if (end > from && start < to) {
      if (t.kind === 'text') out.push({ ...t, text: t.text.slice(Math.max(0, from - start), Math.min(end, to) - start) })
      else out.push(t)
    }
    start = end
    if (start >= to) break
  }
  return out
}

export function sameMarks(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((m) => b.includes(m))
}

/** Merges adjacent text with the same marks and drops empty text, so equal content has one form. */
export function mergeText<T extends Node | Token>(items: readonly T[]): T[] {
  const out: T[] = []
  for (const item of items) {
    if (item.kind === 'text') {
      if (!item.text) continue
      const prev = out.at(-1)
      if (prev?.kind === 'text' && sameMarks(prev.marks, item.marks)) {
        out[out.length - 1] = { ...prev, text: prev.text + item.text }
        continue
      }
    }
    out.push(item)
  }
  return out
}

/** How many elements are open at `pos` inside `content`. */
function depthAt(content: readonly Node[], pos: number): number {
  let start = 0
  for (const node of content) {
    const end = start + nodeSize(node)
    if (node.kind === 'node' && start < pos && pos < end) return 1 + depthAt(node.content, pos - start - 1)
    if (end >= pos) return 0
    start = end
  }
  return 0
}

/** Whether splicing `slice` over `from`–`to` leaves `content` balanced, so the change can stay inside it. */
function fits(content: readonly Node[], from: number, to: number, slice: readonly Token[]): boolean {
  let depth = depthAt(content, from)
  for (const t of slice) {
    if (t.kind === 'open') depth++
    else if (t.kind === 'close' && --depth < 0) return false
  }
  return depth === depthAt(content, to)
}

export interface Replaced {
  content: Node[]
  removed: Token[]
}

/**
 * Splices `slice` over `from`–`to` in `content`, as the flat token sequence
 * would. It descends into the deepest element the change fits inside, then
 * re-reads only the children the range touches, so a keystroke rebuilds one
 * block. `check` sees the new children and the tag of their parent.
 */
export function replaceContent(
  content: readonly Node[],
  from: number,
  to: number,
  slice: readonly Token[],
  check: (nodes: readonly Node[], parent: string) => void = () => {},
  parent = 'doc',
): Replaced {
  let start = 0
  for (let i = 0; i < content.length; i++) {
    const node = content[i]!
    const end = start + nodeSize(node)
    if (node.kind === 'node' && start < from && to < end) {
      if (!fits(node.content, from - start - 1, to - start - 1, slice)) break
      const inner = replaceContent(node.content, from - start - 1, to - start - 1, slice, check, node.tag)
      const out = content.slice()
      out[i] = element(node.tag, inner.content, node.attrs)
      return { content: out, removed: inner.removed }
    }
    if (end > from) break
    start = end
  }

  // The children the range touches, from the one `from` is in to the one `to` is in.
  let first = content.length
  let last = -1
  let regionStart = 0
  start = 0
  for (let i = 0; i < content.length; i++) {
    const end = start + nodeSize(content[i]!)
    if (end > from && start < to) {
      if (first > i) {
        first = i
        regionStart = start
      }
      last = i
    } else if (start >= from && first > i) {
      // An insertion at a boundary between children.
      first = i
      regionStart = start
    }
    start = end
  }
  if (from < 0 || to > start || from > to) throw new StepError(`range ${from}–${to} is outside the content (size ${start})`)
  if (first === content.length) regionStart = start

  const tokens = flatten(content.slice(first, last + 1))
  const removed = cut(tokens, from - regionStart, to - regionStart)
  const nodes = parse([...cut(tokens, 0, from - regionStart), ...slice, ...cut(tokens, to - regionStart)])
  check(nodes, parent)
  const out = mergeText([...content.slice(0, first), ...nodes, ...content.slice(Math.max(first, last + 1))])
  return { content: out, removed }
}

/** A range of positions, `[from, to)`. */
export type Range = readonly [number, number]

/**
 * Adds or removes a mark on the text between `from` and `to`, at any depth.
 * Returns the ranges whose text actually changed, so the change inverts exactly.
 */
export function markContent(
  content: readonly Node[],
  from: number,
  to: number,
  mark: string,
  add: boolean,
  schema: Schema,
  offset = 0,
  changed: [number, number][] = [],
): Node[] {
  const out: Node[] = []
  let start = 0
  for (const node of content) {
    const size = nodeSize(node)
    const end = start + size
    if (end <= from || start >= to) {
      out.push(node)
    } else if (node.kind === 'node') {
      out.push(element(node.tag, markContent(node.content, from - start - 1, to - start - 1, mark, add, schema, offset + start + 1, changed), node.attrs))
    } else if (node.kind === 'text' && node.marks.includes(mark) !== add) {
      const a = Math.max(from, start) - start
      const b = Math.min(to, end) - start
      const marks = add ? schema.marks.filter((m) => m === mark || node.marks.includes(m)) : node.marks.filter((m) => m !== mark)
      if (a > 0) out.push({ ...node, text: node.text.slice(0, a) })
      out.push({ kind: 'text', text: node.text.slice(a, b), marks })
      if (b < size) out.push({ ...node, text: node.text.slice(b) })
      const range: [number, number] = [offset + start + a, offset + start + b]
      const prev = changed.at(-1)
      if (prev && prev[1] === range[0]) prev[1] = range[1]
      else changed.push(range)
    } else {
      out.push(node)
    }
    start = end
  }
  return mergeText(out)
}

/** Finds the element whose open token is at `pos`. */
export function elementAt(content: readonly Node[], pos: number): { node: ElementNode; path: number[] } | null {
  let start = 0
  for (let i = 0; i < content.length; i++) {
    const node = content[i]!
    const end = start + nodeSize(node)
    if (start === pos) return node.kind === 'node' ? { node, path: [i] } : null
    if (node.kind === 'node' && start < pos && pos < end) {
      const inner = elementAt(node.content, pos - start - 1)
      return inner && { node: inner.node, path: [i, ...inner.path] }
    }
    if (start > pos) return null
    start = end
  }
  return null
}

/** Replaces the element at `path` with `make(old)`. */
export function updateAt(content: readonly Node[], path: readonly number[], make: (old: ElementNode) => ElementNode): Node[] {
  const out = content.slice()
  const [i, ...rest] = path
  const old = out[i!] as ElementNode
  out[i!] = rest.length ? element(old.tag, updateAt(old.content, rest, make), old.attrs) : make(old)
  return out
}

/**
 * Checks new nodes against the schema in their parent's context. The doc
 * holds blocks, blocks hold text and `<br>`. Containers come with the
 * follow-up that adds them.
 */
export function checkNodes(nodes: readonly Node[], parent: string, schema: Schema): void {
  for (const node of nodes) {
    if (parent === 'doc') {
      if (node.kind !== 'node') throw new StepError(`${node.kind} outside a block`)
      if (!schema.blocks.includes(node.tag)) throw new StepError(`<${node.tag}> is not an allowed block`)
      checkNodes(node.content, node.tag, schema)
    } else if (node.kind === 'node') {
      throw new StepError(`<${node.tag}> inside <${parent}>`)
    } else if (node.kind === 'text') {
      for (const m of node.marks) if (!schema.marks.includes(m)) throw new StepError(`<${m}> is not an allowed mark`)
    }
  }
}

/** The content of each block, in schema order. Steps keep marks ordered, so this only fixes foreign input. */
export function checkTag(tag: string, parent: string, schema: Schema): void {
  if (parent === 'doc' && !schema.blocks.includes(tag)) throw new StepError(`<${tag}> is not an allowed block`)
}

/** Sizes of the doc's children, which is what the binding's size index holds. */
export function childSizes(doc: ElementNode): number[] {
  return doc.content.map(nodeSize)
}

// ---- HTML ----

const ESCAPE_TEXT: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', ' ': '&nbsp;' }
const ESCAPE_ATTR: Record<string, string> = { '&': '&amp;', '"': '&quot;', ' ': '&nbsp;' }

const escapeText = (s: string) => s.replace(/[&<> ]/g, (c) => ESCAPE_TEXT[c]!)
const escapeAttr = (s: string) => s.replace(/[&" ]/g, (c) => ESCAPE_ATTR[c]!)

function renderAttrs(attrs: Attrs): string {
  let out = ''
  for (const [k, v] of Object.entries(attrs)) out += ` ${k}="${escapeAttr(v)}"`
  return out
}

function renderNested(nodes: readonly Nested[]): string {
  let out = ''
  for (const n of nodes) {
    if (typeof n === 'string') out += escapeText(n)
    else if (n.kind === 'br') out += '<br>'
    else out += `<${n.mark}>${renderNested(n.children)}</${n.mark}>`
  }
  return out
}

/** The HTML the live editor has for these nodes, byte for byte: `writeBlock`'s canonical form, serialized as `innerHTML` does. */
export function renderHTML(nodes: readonly Node[], schema: Schema): string {
  let out = ''
  const inline: Item[] = []
  const flush = () => {
    if (inline.length) out += renderNested(nest(inline, schema))
    inline.length = 0
  }
  for (const node of nodes) {
    if (node.kind !== 'node') {
      inline.push(node)
      continue
    }
    flush()
    const isBlock = node.content.every((c) => c.kind !== 'node')
    out += `<${node.tag}${renderAttrs(node.attrs)}>`
    out += isBlock ? renderNested(nest(node.content as Item[], schema, true)) : renderHTML(node.content, schema)
    out += `</${node.tag}>`
  }
  flush()
  return out
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (all, name: string) => {
    if (name[0] === '#') return String.fromCodePoint(name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10))
    return ENTITIES[name.toLowerCase()] ?? all
  })
}

const MARK_ALIASES: Record<string, string> = { b: 'strong', i: 'em' }

/**
 * Parses HTML into a doc, without a DOM. It reads what the editor writes:
 * schema blocks at the top, text, `<br>` and marks inside them. Like
 * `readBlock`, unknown inline tags are unwrapped and the placeholder `<br>`
 * is dropped. Whitespace between blocks is ignored.
 */
export function parseHTML(html: string, schema: Schema): ElementNode {
  const blocks: Node[] = []
  let block: { tag: string; attrs: Record<string, string>; items: Item[] } | null = null
  const marks: string[] = []
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|([^<]+)/g
  for (let m: RegExpExecArray | null; (m = re.exec(html)); ) {
    const [, slash, rawTag, rawAttrs, text] = m
    if (text !== undefined) {
      if (block) {
        const t = decode(text)
        if (t) block.items.push({ kind: 'text', text: t, marks: schema.marks.filter((mk) => marks.includes(mk)) })
      } else if (/\S/.test(text)) {
        throw new StepError('text outside a block')
      }
      continue
    }
    if (!rawTag) continue
    const tag = rawTag.toLowerCase()
    if (!block) {
      if (slash) continue
      if (!schema.blocks.includes(tag)) throw new StepError(`<${tag}> is not an allowed block`)
      const attrs: Record<string, string> = {}
      for (const a of (rawAttrs ?? '').matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
        attrs[a[1]!.toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? '')
      }
      block = { tag, attrs, items: [] }
      continue
    }
    if (tag === block.tag && slash && !marks.length) {
      if (block.items.at(-1)?.kind === 'br') block.items.pop()
      blocks.push(element(block.tag, mergeText(block.items), Object.keys(block.attrs).length ? block.attrs : EMPTY))
      block = null
      continue
    }
    if (tag === 'br') {
      if (!slash) block.items.push(BR)
      continue
    }
    const mark = schema.marks.includes(tag) ? tag : MARK_ALIASES[tag]
    if (!mark || !schema.marks.includes(mark)) continue
    if (slash) {
      const i = marks.lastIndexOf(mark)
      if (i >= 0) marks.splice(i, 1)
    } else {
      marks.push(mark)
    }
  }
  if (block) throw new StepError(`<${block.tag}> is never closed`)
  return element('doc', blocks)
}
