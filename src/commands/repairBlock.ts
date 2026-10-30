import { pointToPos, type Point, type Pos } from '../dom'
import { readBlock, writeBlock } from '../inline'
import type { Ctx } from './replaceRange'

/**
 * Rewrites one root child into a valid block. Stray text or a disallowed
 * element (a browser's `<div>`) is wrapped in the default block, and the
 * content is reread, so `<b>` becomes `<strong>` and `<span>`s are unwrapped.
 * Returns where `caret` lands afterwards, if one was given.
 */
export function repairBlock(ctx: Ctx, node: Node, caret?: Point): Pos | null {
  const { root, schema } = ctx
  let block: Element
  if (node.nodeType === 1 && ctx.schema.blocks.includes((node as Element).localName)) {
    block = node as Element
  } else {
    block = root.ownerDocument.createElement(schema.defaultBlock)
    root.replaceChild(block, node)
    block.append(node)
  }
  const pos = caret ? pointToPos(root, caret.node, caret.offset) : null
  writeBlock(block, readBlock(block, schema), schema)
  return pos
}
