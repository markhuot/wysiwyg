import { describe, expect, test } from 'bun:test'
import { Mapping, StepMap } from '../../../src/collab/mapping'
import { CLOSE, element, flatten, parseHTML, renderHTML, replaceContent, sliceSize, StepError, type Token } from '../../../src/collab/model'
import { AddMarkStep, ModelTarget, RemoveMarkStep, ReplaceStep, SetBlockStep, Step } from '../../../src/collab/steps'
import type { Item } from '../../../src/inline'
import { defaultSchema } from '../../../src/schema'

const model = (html: string) => new ModelTarget(parseHTML(html, defaultSchema), defaultSchema)
const html = (target: ModelTarget) => renderHTML(target.doc.content, defaultSchema)
const text = (t: string, marks: string[] = []): Item => ({ kind: 'text', text: t, marks })
const open = (tag: string): Token => ({ kind: 'open', tag })

/** Applies `step`, checks the HTML, then checks its inverse restores the original. */
function roundTrip(start: string, step: Step, after: string) {
  const target = model(start)
  const inverse = step.apply(target)
  expect(html(target)).toBe(after)
  for (const s of inverse) s.apply(target)
  expect(html(target)).toBe(start)
}

describe('HTML', () => {
  test('parses and renders the canonical form unchanged', () => {
    const source = '<h1>T&amp;C &lt;x&gt;</h1><p>a <strong>b<em>c</em></strong><br>d</p><p><br></p><p>e<br><br></p><p>x&nbsp;y</p>'
    expect(renderHTML(parseHTML(source, defaultSchema).content, defaultSchema)).toBe(source)
  })

  test('reads b/i as marks, unwraps unknown inline tags and drops whitespace between blocks', () => {
    const doc = parseHTML('<p><b>a</b><span>b</span><i>c</i></p>\n  <p>d</p>', defaultSchema)
    expect(renderHTML(doc.content, defaultSchema)).toBe('<p><strong>a</strong>b<em>c</em></p><p>d</p>')
  })

  test('refuses blocks the schema lacks and text outside blocks', () => {
    expect(() => parseHTML('<div>a</div>', defaultSchema)).toThrow(StepError)
    expect(() => parseHTML('loose', defaultSchema)).toThrow(StepError)
  })
})

describe('ReplaceStep', () => {
  test('types inside a block', () => {
    roundTrip('<p>ab</p>', new ReplaceStep(2, 2, [text('X')]), '<p>aXb</p>')
  })

  test('typing takes the marks in the slice, merging with neighbours', () => {
    roundTrip('<p><strong>ab</strong>c</p>', new ReplaceStep(3, 3, [text('X', ['strong'])]), '<p><strong>abX</strong>c</p>')
  })

  test('split is a close and an open; the second block takes the slice tag', () => {
    roundTrip('<h1>abcd</h1>', new ReplaceStep(3, 3, [CLOSE, open('p')]), '<h1>ab</h1><p>cd</p>')
  })

  test('joining deletes the close and open between blocks, so the start block keeps its tag', () => {
    roundTrip('<h1>ab</h1><p>cd</p>', new ReplaceStep(3, 5, []), '<h1>abcd</h1>')
  })

  test('the empty-start join deletes the empty block, so the end block keeps its tag', () => {
    roundTrip('<p><br></p><h1>ab</h1>', new ReplaceStep(0, 2, []), '<h1>ab</h1>')
  })

  test('a range delete across blocks', () => {
    roundTrip('<p>abc</p><h2>d</h2><p>efg</p>', new ReplaceStep(2, 10, []), '<p>afg</p>')
  })

  test('inserts whole blocks at a boundary', () => {
    roundTrip('<p>a</p>', new ReplaceStep(3, 3, [open('h2'), text('b'), CLOSE]), '<p>a</p><h2>b</h2>')
  })

  test('refuses unbalanced results, unknown tags, nesting and emptying the document, leaving it unchanged', () => {
    const target = model('<p>ab</p>')
    expect(() => new ReplaceStep(1, 1, [CLOSE]).apply(target)).toThrow(StepError)
    expect(() => new ReplaceStep(0, 0, [CLOSE, open('p')]).apply(target)).toThrow(StepError)
    expect(() => new ReplaceStep(2, 2, [CLOSE, open('div')]).apply(target)).toThrow(StepError)
    expect(() => new ReplaceStep(2, 2, [open('p'), CLOSE]).apply(target)).toThrow(StepError)
    expect(() => new ReplaceStep(2, 2, [text('x', ['u'])]).apply(target)).toThrow(StepError)
    expect(() => new ReplaceStep(0, 4, []).apply(target)).toThrow(StepError)
    expect(() => new ReplaceStep(3, 9, []).apply(target)).toThrow(StepError)
    expect(html(target)).toBe('<p>ab</p>')
  })

  test('merges typing runs and backspacing into them, and nothing else', () => {
    const a = new ReplaceStep(2, 2, [text('ab')])
    expect(a.merge(new ReplaceStep(4, 4, [text('c')]))?.toJSON()).toEqual(new ReplaceStep(2, 2, [text('ab'), text('c')]).toJSON())
    expect(a.merge(new ReplaceStep(3, 4, []))?.toJSON()).toEqual(new ReplaceStep(2, 2, [text('a')]).toJSON())
    expect(a.merge(new ReplaceStep(5, 5, [text('c')]))).toBeNull()
    expect(a.merge(new ReplaceStep(4, 4, [CLOSE, open('p')]))).toBeNull()
    expect(a.merge(new ReplaceStep(1, 4, []))).toBeNull()
  })
})

describe('mark steps', () => {
  test('add and remove a mark across blocks, skipping breaks', () => {
    roundTrip('<p>ab</p><p>c<br>d</p>', new AddMarkStep(2, 9, 'em'), '<p>a<em>b</em></p><p><em>c</em><br><em>d</em></p>')
    roundTrip('<p><em>ab</em></p>', new RemoveMarkStep(1, 2, 'em'), '<p>a<em>b</em></p>')
  })

  test('the inverse only touches text that changed', () => {
    roundTrip('<p>a<strong>b</strong>c</p>', new AddMarkStep(1, 4, 'strong'), '<p><strong>abc</strong></p>')
    const target = model('<p>a<strong>b</strong>c</p>')
    expect(new AddMarkStep(1, 4, 'strong').apply(target).map((s) => s.toJSON())).toEqual([
      { stepType: 'removeMark', from: 1, to: 2, mark: 'strong' },
      { stepType: 'removeMark', from: 3, to: 4, mark: 'strong' },
    ])
  })

  test('nests marks in schema order whatever order they were added in', () => {
    roundTrip('<p><em>ab</em></p>', new AddMarkStep(1, 3, 'strong'), '<p><strong><em>ab</em></strong></p>')
  })
})

describe('SetBlockStep', () => {
  test('changes a block tag', () => {
    roundTrip('<p>a</p><p>b</p>', new SetBlockStep(3, 'h2'), '<p>a</p><h2>b</h2>')
  })

  test('refuses a position that is not a block start and a tag the schema lacks', () => {
    expect(() => new SetBlockStep(1, 'h1').apply(model('<p>a</p>'))).toThrow(StepError)
    expect(() => new SetBlockStep(0, 'div').apply(model('<p>a</p>'))).toThrow(StepError)
  })
})

describe('JSON', () => {
  test('steps round-trip and bad input is refused', () => {
    for (const step of [new ReplaceStep(1, 2, [text('a', ['em']), { kind: 'br' }, CLOSE, open('h1')]), new AddMarkStep(1, 2, 'em'), new SetBlockStep(0, 'h1')]) {
      expect(Step.fromJSON(JSON.parse(JSON.stringify(step))).toJSON()).toEqual(step.toJSON())
    }
    expect(() => Step.fromJSON({ stepType: 'replace', from: -1, to: 0, slice: [] })).toThrow(StepError)
    expect(() => Step.fromJSON({ stepType: 'replace', from: 0, to: 0, slice: [{ kind: 'script' }] } as never)).toThrow(StepError)
    expect(() => Step.fromJSON({ stepType: 'nope' } as never)).toThrow(StepError)
  })
})

describe('mapping', () => {
  const insert = new StepMap([5, 0, 3])
  const del = new StepMap([5, 4, 0])

  test('positions at an insertion follow assoc', () => {
    expect(insert.map(5, -1)).toBe(5)
    expect(insert.map(5, 1)).toBe(8)
    expect(insert.map(4)).toBe(4)
    expect(insert.map(6)).toBe(9)
  })

  test('positions in a deleted range collapse to its start and are flagged', () => {
    const inside = del.mapResult(7)
    expect(inside.pos).toBe(5)
    expect(inside.deleted).toBe(true)
    expect(inside.deletedAcross).toBe(true)
    expect(del.mapResult(5, 1).deletedAfter).toBe(true)
    expect(del.mapResult(5, 1).deleted).toBe(true)
    expect(del.mapResult(5, -1).deleted).toBe(false)
    expect(del.mapResult(9, -1).deletedBefore).toBe(true)
    expect(del.map(12)).toBe(8)
  })

  test('a mirror recovers a position inside text deleted and reinserted', () => {
    // Undo an insert of 3 at 5, insert 2 elsewhere earlier, redo the insert at its new place.
    const mapping = new Mapping()
    mapping.appendMap(new StepMap([5, 3, 0]))
    mapping.appendMap(new StepMap([0, 0, 2]))
    mapping.appendMap(new StepMap([7, 0, 3]), 0)
    expect(mapping.map(6)).toBe(8)
    // Without the mirror it would collapse to the edge.
    const plain = new Mapping([new StepMap([5, 3, 0]), new StepMap([0, 0, 2]), new StepMap([7, 0, 3])])
    expect(plain.map(6)).toBe(10)
  })

  test('slices map through part of the pipeline', () => {
    const mapping = new Mapping([new StepMap([0, 0, 1]), new StepMap([0, 0, 10])])
    expect(mapping.slice(1).map(3)).toBe(13)
    expect(mapping.slice(0, 1).map(3)).toBe(4)
  })
})

describe('nested containers', () => {
  // A list item holding a table whose cell holds two paragraphs, with no schema checks: the follow-up adds those.
  const cell = element('cell', [element('p', [text('First')]), element('p', [text('Second')])])
  const content = [element('p', [text('Outer')]), element('table', [element('row', [cell, element('cell', [element('p', [text('x')])])])])]

  test('positions count every container token', () => {
    // p(7) + table open, row open, cell open, p open = 11, so "First" starts at 11.
    const tokens = flatten(content)
    expect(tokens.slice(3, 8).map((t) => (t.kind === 'open' ? t.tag : t.kind === 'text' ? t.text : t.kind))).toEqual(['table', 'row', 'cell', 'p', 'First'])
    expect(sliceSize(tokens.slice(0, 7))).toBe(11)
  })

  test('a split inside a cell paragraph stays inside the cell and maps positions after it', () => {
    const at = 11 + 2
    const step = new ReplaceStep(at, at, [CLOSE, open('p')])
    const { content: next } = replaceContent(content, at, at, step.slice)
    const table = next[1] as ReturnType<typeof element>
    const row = table.content[0] as ReturnType<typeof element>
    expect((row.content[0] as ReturnType<typeof element>).content.map((p) => (p as ReturnType<typeof element>).content)).toEqual([
      [text('Fi')],
      [text('rst')],
      [text('Second')],
    ])
    expect(row.content).toHaveLength(2)
    // "Second" started at 11 + 7 = 18; after the split it starts two later.
    expect(step.getMap().map(18)).toBe(20)
    expect(renderHTML(next, defaultSchema)).toBe(
      '<p>Outer</p><table><row><cell><p>Fi</p><p>rst</p><p>Second</p></cell><cell><p>x</p></cell></row></table>',
    )
  })

  test('a delete across two cell paragraphs joins them inside the cell', () => {
    const { content: next, removed } = replaceContent(content, 16, 19, [])
    expect(removed).toEqual([CLOSE, open('p'), text('S')])
    expect(renderHTML(next, defaultSchema)).toContain('<cell><p>Firstecond</p></cell>')
  })
})
