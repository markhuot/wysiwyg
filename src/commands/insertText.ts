import type { Pos } from '../dom'
import { length, marksAt } from '../inline'
import { replaceRange, type Ctx } from './replaceRange'

/**
 * Replaces the range with `text`. Without explicit `marks` the text takes the
 * marks of the text before the range, or after it at the start of a line.
 */
export function insertText(ctx: Ctx, from: Pos, to: Pos, text: string, marks?: readonly string[]): Pos {
  return replaceRange(ctx, from, to, (head, tail) => [
    [{ kind: 'text', text, marks: marks ?? marksAt([...head, ...tail], length(head)) }],
  ])
}
