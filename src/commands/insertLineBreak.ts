import type { Pos } from '../dom'
import { BR } from '../inline'
import { replaceRange, type Ctx } from './replaceRange'

/** Shift+Enter. The `<br>` sits at the block level, so marks split around it. */
export function insertLineBreak(ctx: Ctx, from: Pos, to: Pos): Pos {
  return replaceRange(ctx, from, to, () => [[BR]])
}
