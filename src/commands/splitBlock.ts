import { contentLength, ordered, type Pos } from '../dom'
import { writeBlock } from '../inline'
import { replaceRange, type Ctx } from './replaceRange'

/**
 * Enter. The second half becomes the schema's default block, so splitting a
 * heading gives a heading and a paragraph. At the very start of a non-empty
 * block an empty default block is inserted above instead, so the block keeps
 * its tag and the caret stays put.
 */
export function splitBlock(ctx: Ctx, a: Pos, b: Pos): Pos {
  const [from, to] = ordered(a, b)
  if (from.block === to.block && to.offset === 0 && contentLength(from.block) > 0) {
    const empty = from.block.ownerDocument.createElement(ctx.schema.defaultBlock)
    writeBlock(empty, [], ctx.schema)
    from.block.before(empty)
    return { block: from.block, offset: 0 }
  }
  return replaceRange(ctx, from, to, () => [[], []])
}
