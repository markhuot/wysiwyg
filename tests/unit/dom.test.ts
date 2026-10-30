import { describe, expect, test } from 'bun:test'
import { pointToPos, posToPoint } from '../../src/dom'
import { at, doc } from './helpers'

describe('pointToPos', () => {
  test('counts text and <br>s across marks', () => {
    const ctx = doc('<p>ab<br><strong>c<em>de</em></strong></p>')
    const em = ctx.root.querySelector('em')!.firstChild!
    expect(pointToPos(ctx.root, em, 1)).toEqual(at(ctx, 0, 5))
  })

  test('clamps a caret after the placeholder to the content length', () => {
    const ctx = doc('<p>ab<br><br></p>')
    const p = ctx.root.firstChild!
    expect(pointToPos(ctx.root, p, 4)).toEqual(at(ctx, 0, 3))
  })

  test('maps a point between blocks on the root', () => {
    const ctx = doc('<p>ab</p><p>cd</p>')
    expect(pointToPos(ctx.root, ctx.root, 1)).toEqual(at(ctx, 1, 0))
    expect(pointToPos(ctx.root, ctx.root, 2)).toEqual(at(ctx, 1, 2))
  })

  test('ignores points outside the root', () => {
    const ctx = doc('<p>ab</p>')
    expect(pointToPos(ctx.root, document.createTextNode('x'), 0)).toBeNull()
  })
})

describe('posToPoint', () => {
  test('prefers the end of the text before the position', () => {
    const ctx = doc('<p><strong>ab</strong>cd</p>')
    const point = posToPoint(at(ctx, 0, 2))
    expect(point.node).toBe(ctx.root.querySelector('strong')!.firstChild!)
    expect(point.offset).toBe(2)
  })

  test('after a <br>, the start of the next line', () => {
    const ctx = doc('<p>ab<br>cd</p>')
    const point = posToPoint(at(ctx, 0, 3))
    expect(point.node).toBe(ctx.root.firstChild!.lastChild!)
    expect(point.offset).toBe(0)
  })

  test('on an empty last line, the gap before the placeholder', () => {
    const ctx = doc('<p>ab<br><br></p>')
    expect(posToPoint(at(ctx, 0, 3))).toEqual({ node: ctx.root.firstChild!, offset: 2 })
  })
})
