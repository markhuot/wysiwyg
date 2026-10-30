/**
 * The rules a document must follow. The root holds `blocks`, and blocks hold
 * text, `br` line breaks and `marks`. Marks nest in the order they're listed:
 * an earlier mark always sits outside a later one.
 */
export interface Schema {
  readonly blocks: readonly string[]
  readonly marks: readonly string[]
  /** The block used for new blocks, e.g. the second half of a split heading. */
  readonly defaultBlock: string
}

export const defaultSchema: Schema = {
  blocks: ['p', 'h1', 'h2'],
  marks: ['strong', 'em'],
  defaultBlock: 'p',
}

export interface Violation {
  node: Node
  message: string
}

const TEXT = 3
const ELEMENT = 1

/**
 * Lists every way `root` breaks the schema. It walks the whole document, so
 * it's for tests, debug mode and composition repair, never for boot.
 */
export function validate(root: Element, schema: Schema): Violation[] {
  const out: Violation[] = []
  for (let child = root.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === TEXT) {
      if (/\S/.test((child as Text).data)) out.push({ node: child, message: 'text outside a block' })
    } else if (child.nodeType === ELEMENT) {
      out.push(...validateBlock(child as Element, schema))
    }
  }
  return out
}

export function validateBlock(block: Element, schema: Schema): Violation[] {
  const out: Violation[] = []
  const tag = block.localName
  if (!schema.blocks.includes(tag)) out.push({ node: block, message: `<${tag}> is not an allowed block` })

  const last = block.lastChild
  if (!last) {
    out.push({ node: block, message: `empty <${tag}> needs a placeholder <br>` })
  } else if (isBr(last) && last.previousSibling && !isBr(last.previousSibling)) {
    out.push({ node: last, message: `<${tag}> ends with a <br> that has no placeholder after it` })
  }

  checkInline(block, -1, schema, out)
  return out
}

/** `depth` is the index in `schema.marks` of the mark `parent` is, or -1 for the block. */
function checkInline(parent: Element, depth: number, schema: Schema, out: Violation[]): void {
  let prev: Node | null = null
  for (let child = parent.firstChild; child; prev = child, child = child.nextSibling) {
    if (child.nodeType === TEXT) {
      if (!(child as Text).data) out.push({ node: child, message: 'empty text node' })
      continue
    }
    if (child.nodeType !== ELEMENT) continue

    const el = child as Element
    const tag = el.localName
    if (tag === 'br') {
      if (depth >= 0) out.push({ node: el, message: `<br> inside <${parent.localName}>` })
      continue
    }

    const index = schema.marks.indexOf(tag)
    if (index < 0) {
      out.push({ node: el, message: `<${tag}> is not an allowed mark` })
    } else if (index <= depth) {
      out.push({ node: el, message: `<${tag}> must not sit inside <${parent.localName}>` })
    }
    if (!el.textContent) out.push({ node: el, message: `empty <${tag}>` })
    if (prev && prev.nodeType === ELEMENT && (prev as Element).localName === tag) {
      out.push({ node: el, message: `adjacent <${tag}> elements should be merged` })
    }
    checkInline(el, index < 0 ? depth : index, schema, out)
  }
}

function isBr(node: Node): boolean {
  return node.nodeType === ELEMENT && (node as Element).localName === 'br'
}
