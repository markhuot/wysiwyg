import { blocksBetween, ordered, type Pos } from '../dom'
import { length, readBlock, slice, writeBlock, type Item } from '../inline'
import type { Schema } from '../schema'

/** What every command works on: the editor root and its schema. Commands never look above `root`. */
export interface Ctx {
  root: Element
  schema: Schema
}

/**
 * Replaces the content between two positions with `lines`, the core every
 * edit goes through. One line edits inside the start block. Each further line
 * starts a new default block, and the text after the range joins the last one.
 * `make` gets the runs before and after the range so it can pick marks.
 * Returns the position after the inserted content.
 */
export function replaceRange(
  ctx: Ctx,
  a: Pos,
  b: Pos,
  make: (head: Item[], tail: Item[]) => Item[][],
): Pos {
  const [from, to] = ordered(a, b)
  const { schema } = ctx
  const head = slice(readBlock(from.block, schema), 0, from.offset)
  const tail = slice(readBlock(to.block, schema), to.offset)
  const lines = make(head, tail)

  for (const block of blocksBetween(from.block, to.block).slice(1)) block.remove()

  const last = lines.length - 1
  if (last <= 0) {
    const line = lines[0] ?? []
    writeBlock(from.block, [...head, ...line, ...tail], schema)
    return { block: from.block, offset: length(head) + length(line) }
  }

  writeBlock(from.block, [...head, ...lines[0]!], schema)
  let prev = from.block
  for (let i = 1; i <= last; i++) {
    const block = from.block.ownerDocument.createElement(schema.defaultBlock)
    writeBlock(block, i === last ? [...lines[i]!, ...tail] : lines[i]!, schema)
    prev.after(block)
    prev = block
  }
  return { block: prev, offset: length(lines[last]!) }
}
