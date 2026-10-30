import type { Pos } from '../dom'
import { length, marksAt } from '../inline'
import { replaceRange, type Ctx } from './replaceRange'

/** Pastes plain text. Each newline splits the block, like Enter. */
export function insertPlainText(ctx: Ctx, from: Pos, to: Pos, text: string): Pos {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  return replaceRange(ctx, from, to, (head, tail) => {
    const marks = marksAt([...head, ...tail], length(head))
    return lines.map((line) => (line ? [{ kind: 'text', text: line, marks }] : []))
  })
}
