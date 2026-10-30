import { expect } from 'bun:test'
import type { Ctx } from '../../src/commands/replaceRange'
import type { Pos } from '../../src/dom'
import { defaultSchema, validate, type Schema } from '../../src/schema'

export function doc(html: string, schema: Schema = defaultSchema): Ctx {
  const root = document.createElement('div')
  root.innerHTML = html
  return { root, schema }
}

/** Position `offset` in the root's `index`th block. */
export function at(ctx: Ctx, index: number, offset: number): Pos {
  return { block: ctx.root.children[index]!, offset }
}

/** Asserts the exact HTML and that it's valid for the schema. */
export function expectDoc(ctx: Ctx, html: string): void {
  expect(ctx.root.innerHTML).toBe(html)
  expect(validate(ctx.root, ctx.schema).map((v) => v.message)).toEqual([])
}
