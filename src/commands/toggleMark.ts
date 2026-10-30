import { blocksBetween, ordered, type Pos } from '../dom'
import { length, marksAt, readBlock, slice, withMark, withoutMark, writeBlock, type Item } from '../inline'
import type { Ctx } from './replaceRange'

/**
 * Toggles `mark` over a range. If every character in the range already has the
 * mark it's removed, otherwise it's added. The touched blocks are rewritten in
 * canonical form. Block offsets don't change, so the caller's positions stay valid.
 */
export function toggleMark(ctx: Ctx, a: Pos, b: Pos, mark: string): void {
  const [from, to] = ordered(a, b)
  const { schema } = ctx
  const blocks = blocksBetween(from.block, to.block)
  const parts = blocks.map((block, i) => {
    const items = readBlock(block, schema)
    const start = i === 0 ? from.offset : 0
    const end = i === blocks.length - 1 ? to.offset : length(items)
    return { block, items, start, end }
  })

  let any = false
  let all = true
  for (const { items, start, end } of parts) {
    for (const item of slice(items, start, end)) {
      if (item.kind !== 'text') continue
      any = true
      if (!item.marks.includes(mark)) all = false
    }
  }
  if (!any) return

  const apply = (item: Item): Item =>
    item.kind === 'br' ? item : { ...item, marks: all ? withoutMark(item.marks, mark) : withMark(item.marks, mark, schema) }

  for (const { block, items, start, end } of parts) {
    writeBlock(block, [...slice(items, 0, start), ...slice(items, start, end).map(apply), ...slice(items, end)], schema)
  }
}

/** Marks chosen with a collapsed caret, waiting for the next character typed at `block`/`offset`. */
export interface PendingMarks extends Pos {
  marks: readonly string[]
}

/** Toggles `mark` in the set the next character at `pos` will take. */
export function togglePending(ctx: Ctx, pending: PendingMarks | null, pos: Pos, mark: string): PendingMarks {
  const current = pendingAt(pending, pos) ?? marksAt(readBlock(pos.block, ctx.schema), pos.offset)
  const marks = current.includes(mark) ? withoutMark(current, mark) : withMark(current, mark, ctx.schema)
  return { block: pos.block, offset: pos.offset, marks }
}

/** The pending marks if the caret is still where they were set; once it moves they no longer apply. */
export function pendingAt(pending: PendingMarks | null, pos: Pos): readonly string[] | undefined {
  return pending && pending.block === pos.block && pending.offset === pos.offset ? pending.marks : undefined
}
