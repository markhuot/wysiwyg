import type { Schema } from './schema'

/**
 * A block's content as a flat run list. Commands read the blocks an edit
 * touches into runs, change the runs and write the blocks back, which makes
 * canonical mark nesting a property of `writeBlock` rather than of each command.
 * Runs only live for the length of one edit.
 */
export type Item = { kind: 'text'; text: string; marks: readonly string[] } | { kind: 'br' }

export const BR: Item = { kind: 'br' }

/** Inline tags that mean a schema mark. Used when repairing browser output. */
const ALIASES: Record<string, string> = { b: 'strong', i: 'em' }

function markFor(tag: string, schema: Schema): string | null {
  if (schema.marks.includes(tag)) return tag
  const alias = ALIASES[tag]
  return alias && schema.marks.includes(alias) ? alias : null
}

/** Adds `mark` and keeps the schema's mark order. */
export function withMark(marks: readonly string[], mark: string, schema: Schema): string[] {
  return schema.marks.filter((m) => m === mark || marks.includes(m))
}

export function withoutMark(marks: readonly string[], mark: string): string[] {
  return marks.filter((m) => m !== mark)
}

/**
 * Reads a block into runs. Unknown inline elements are unwrapped and `<b>`/`<i>`
 * become their marks, so this also reads invalid blocks for repair. The
 * trailing placeholder `<br>` is dropped.
 */
export function readBlock(block: Element, schema: Schema): Item[] {
  const items: Item[] = []
  const walk = (node: Node, marks: readonly string[]) => {
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) {
        const text = (c as Text).data
        if (text) items.push({ kind: 'text', text, marks })
      } else if (c.nodeType === 1) {
        const tag = (c as Element).localName
        if (tag === 'br') {
          items.push(BR)
        } else {
          const mark = markFor(tag, schema)
          walk(c, mark ? withMark(marks, mark, schema) : marks)
        }
      }
    }
  }
  walk(block, [])
  if (items.at(-1)?.kind === 'br') items.pop()
  return items
}

function itemLength(item: Item): number {
  return item.kind === 'br' ? 1 : item.text.length
}

export function length(items: readonly Item[]): number {
  let n = 0
  for (const item of items) n += itemLength(item)
  return n
}

/** The runs between `from` and `to`, splitting text runs at the edges. */
export function slice(items: readonly Item[], from: number, to = Infinity): Item[] {
  const out: Item[] = []
  let start = 0
  for (const item of items) {
    const end = start + itemLength(item)
    if (end > from && start < to) {
      if (item.kind === 'br') out.push(item)
      else out.push({ ...item, text: item.text.slice(Math.max(0, from - start), Math.min(end, to) - start) })
    }
    start = end
  }
  return out
}

/** The block's text, with `\n` for each `<br>`. Used for word and grapheme boundaries. */
export function textOf(items: readonly Item[]): string {
  return items.map((i) => (i.kind === 'br' ? '\n' : i.text)).join('')
}

/**
 * The marks a character typed at `offset` takes: those of the text before it,
 * or at the start of a block or line, those of the text after it.
 */
export function marksAt(items: readonly Item[], offset: number): readonly string[] {
  let start = 0
  let before: Item | undefined
  let after: Item | undefined
  for (const item of items) {
    const end = start + itemLength(item)
    if (start < offset && offset <= end) before = item
    if (start <= offset && offset < end && !after) after = item
    start = end
  }
  if (before) return before.kind === 'text' ? before.marks : after?.kind === 'text' ? after.marks : []
  return after?.kind === 'text' ? after.marks : []
}

/**
 * Replaces the block's children with the canonical rendering of `items`:
 * marks nest in schema order, adjacent identical marks merge, empty marks
 * vanish and the placeholder `<br>` is added where the last line is empty.
 */
export function writeBlock(block: Element, items: readonly Item[], schema: Schema): void {
  const doc = block.ownerDocument
  const runs = items.filter((i) => i.kind === 'br' || i.text)

  const render = (group: readonly Item[], depth: number): Node[] => {
    const out: Node[] = []
    if (depth === schema.marks.length) {
      let prev: Item | undefined
      for (const item of group) {
        if (item.kind === 'br') out.push(doc.createElement('br'))
        else if (prev?.kind === 'text') (out.at(-1) as Text).appendData(item.text)
        else out.push(doc.createTextNode(item.text))
        prev = item
      }
      return out
    }
    const mark = schema.marks[depth]!
    const has = (i: Item) => i.kind === 'text' && i.marks.includes(mark)
    for (let i = 0; i < group.length; ) {
      let j = i + 1
      while (j < group.length && has(group[j]!) === has(group[i]!)) j++
      const part = group.slice(i, j)
      if (has(group[i]!)) {
        const el = doc.createElement(mark)
        el.append(...render(part, depth + 1))
        out.push(el)
      } else {
        out.push(...render(part, depth + 1))
      }
      i = j
    }
    return out
  }

  const nodes = render(runs, 0)
  if (!runs.length || runs.at(-1)!.kind === 'br') nodes.push(doc.createElement('br'))
  block.replaceChildren(...nodes)
}
