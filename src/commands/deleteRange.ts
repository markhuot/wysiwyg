import { contentLength, type Pos } from '../dom'
import { readBlock, textOf } from '../inline'
import { replaceRange, type Ctx } from './replaceRange'

export type DeleteUnit = 'char' | 'word' | 'line'

/** Deletes between two positions. Across blocks, the end block joins the start block and takes its tag. */
export function deleteRange(ctx: Ctx, from: Pos, to: Pos): Pos {
  return replaceRange(ctx, from, to, () => [[]])
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/**
 * Where a backward delete of `unit` from a collapsed caret ends. At the start
 * of a block that's the end of the previous block (a join), or null at the
 * start of the document.
 */
export function stepBackward(ctx: Ctx, pos: Pos, unit: DeleteUnit): Pos | null {
  if (pos.offset === 0) {
    const prev = pos.block.previousElementSibling
    return prev ? { block: prev, offset: contentLength(prev) } : null
  }
  const before = textOf(readBlock(pos.block, ctx.schema)).slice(0, pos.offset)
  let offset: number
  if (unit === 'word') {
    offset = before.length - before.match(/\S*\s*$/)![0].length
  } else if (unit === 'line') {
    const start = before.lastIndexOf('\n') + 1
    offset = start === before.length ? start - 1 : start
  } else {
    offset = 0
    for (const s of graphemes.segment(before)) offset = s.index
  }
  return { block: pos.block, offset }
}

/** The forward mirror of `stepBackward`. At the end of a block that's the start of the next one. */
export function stepForward(ctx: Ctx, pos: Pos, unit: DeleteUnit): Pos | null {
  const text = textOf(readBlock(pos.block, ctx.schema))
  if (pos.offset >= text.length) {
    const next = pos.block.nextElementSibling
    return next ? { block: next, offset: 0 } : null
  }
  const after = text.slice(pos.offset)
  let n: number
  if (unit === 'word') {
    n = after.match(/^\s*\S*/)![0].length
  } else if (unit === 'line') {
    const end = after.indexOf('\n')
    n = end < 0 ? after.length : Math.max(end, 1)
  } else {
    n = graphemes.segment(after)[Symbol.iterator]().next().value!.segment.length
  }
  return { block: pos.block, offset: pos.offset + n }
}
