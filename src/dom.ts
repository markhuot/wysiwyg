/**
 * A position inside a block, counted in characters, with each content `<br>`
 * counting as one. The trailing placeholder `<br>` isn't content.
 */
export interface Pos {
  block: Element
  offset: number
}

/** A DOM boundary point, like a Range end. */
export interface Point {
  node: Node
  offset: number
}

const TEXT = 3
const ELEMENT = 1

export function isBr(node: Node | null | undefined): node is Element {
  return !!node && node.nodeType === ELEMENT && (node as Element).localName === 'br'
}

/** The root child that contains `node`. Never looks above `root`. */
export function blockOf(root: Element, node: Node): Element | null {
  let n: Node | null = node
  while (n && n !== root && n.parentNode !== root) n = n.parentNode
  return n && n !== root && n.nodeType === ELEMENT ? (n as Element) : null
}

/** Characters plus `<br>`s inside `node`. */
export function leafLength(node: Node): number {
  if (node.nodeType === TEXT) return (node as Text).data.length
  if (isBr(node)) return 1
  let n = 0
  for (let c = node.firstChild; c; c = c.nextSibling) n += leafLength(c)
  return n
}

/** The block's length, not counting the placeholder `<br>`. */
export function contentLength(block: Element): number {
  return leafLength(block) - (isBr(block.lastChild) ? 1 : 0)
}

function lengthBefore(block: Element, target: Node): number {
  let n = 0
  const visit = (parent: Node): boolean => {
    for (let c = parent.firstChild; c; c = c.nextSibling) {
      if (c === target) return true
      if (c.contains(target)) return visit(c)
      n += leafLength(c)
    }
    return false
  }
  visit(block)
  return n
}

export function offsetInBlock(block: Element, node: Node, offset: number): number {
  if (node.nodeType === TEXT) return lengthBefore(block, node) + offset
  const child = node.childNodes[offset]
  if (child) return lengthBefore(block, child)
  return node === block ? leafLength(block) : lengthBefore(block, node) + leafLength(node)
}

/** Maps a DOM point inside `root` to a block position, or null if it's outside. */
export function pointToPos(root: Element, node: Node, offset: number): Pos | null {
  if (node === root) {
    const kids = root.childNodes
    for (let i = offset; i < kids.length; i++) {
      const kid = kids[i]!
      if (kid.nodeType === ELEMENT) return { block: kid as Element, offset: 0 }
    }
    for (let i = Math.min(offset, kids.length) - 1; i >= 0; i--) {
      const kid = kids[i]!
      if (kid.nodeType === ELEMENT) return { block: kid as Element, offset: contentLength(kid as Element) }
    }
    return null
  }
  if (!root.contains(node)) return null
  const block = blockOf(root, node)
  if (!block) return null
  return { block, offset: Math.min(offsetInBlock(block, node, offset), contentLength(block)) }
}

/**
 * Maps a block position to a DOM point. It prefers the end of the text before
 * the position, then the start of the text after it, then the gap before a `<br>`.
 */
export function posToPoint(pos: Pos): Point {
  const leaves: Node[] = []
  const collect = (parent: Node) => {
    for (let c = parent.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === TEXT || isBr(c)) leaves.push(c)
      else if (c.nodeType === ELEMENT) collect(c)
    }
  }
  collect(pos.block)

  let start = 0
  for (const leaf of leaves) {
    const len = leafLength(leaf)
    if (leaf.nodeType === TEXT && start < pos.offset && pos.offset <= start + len) {
      return { node: leaf, offset: pos.offset - start }
    }
    start += len
  }
  start = 0
  for (const leaf of leaves) {
    if (start === pos.offset) {
      if (leaf.nodeType === TEXT) return { node: leaf, offset: 0 }
      const parent = leaf.parentNode!
      return { node: parent, offset: Array.prototype.indexOf.call(parent.childNodes, leaf) }
    }
    start += leafLength(leaf)
  }
  return { node: pos.block, offset: pos.block.childNodes.length }
}

export function comparePos(a: Pos, b: Pos): number {
  if (a.block === b.block) return a.offset - b.offset
  return a.block.compareDocumentPosition(b.block) & 4 /* FOLLOWING */ ? -1 : 1
}

export function ordered(a: Pos, b: Pos): [Pos, Pos] {
  return comparePos(a, b) <= 0 ? [a, b] : [b, a]
}

/** The blocks from `from` to `to`, inclusive. */
export function blocksBetween(from: Element, to: Element): Element[] {
  const out: Element[] = []
  for (let b: Element | null = from; b; b = b.nextElementSibling) {
    out.push(b)
    if (b === to) break
  }
  return out
}

export function getSelectionFor(root: Element): Selection | null {
  const host = root.getRootNode() as Document | (ShadowRoot & { getSelection?: () => Selection | null })
  return (typeof host.getSelection === 'function' ? host.getSelection() : null) ?? root.ownerDocument.getSelection()
}

export function selectPoints(root: Element, anchor: Point, focus: Point = anchor): void {
  getSelectionFor(root)?.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset)
}

/** A point stored as child indexes from the root, so it survives an innerHTML round trip. */
export interface EncodedPoint {
  path: number[]
  offset: number
}

export function encodePoint(root: Element, node: Node, offset: number): EncodedPoint | null {
  const path: number[] = []
  for (let n: Node = node; n !== root; ) {
    const parent = n.parentNode
    if (!parent) return null
    path.unshift(Array.prototype.indexOf.call(parent.childNodes, n))
    n = parent
  }
  return { path, offset }
}

export function decodePoint(root: Element, point: EncodedPoint): Point | null {
  let node: Node = root
  for (const i of point.path) {
    const next = node.childNodes[i]
    if (!next) return null
    node = next
  }
  const max = node.nodeType === TEXT ? (node as Text).data.length : node.childNodes.length
  return { node, offset: Math.min(point.offset, max) }
}
