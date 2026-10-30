import { describe, expect, test } from 'bun:test'
import { deleteRange, stepBackward, stepForward } from '../../src/commands/deleteRange'
import { insertLineBreak } from '../../src/commands/insertLineBreak'
import { insertPlainText } from '../../src/commands/insertPlainText'
import { insertText } from '../../src/commands/insertText'
import { repairBlock } from '../../src/commands/repairBlock'
import { splitBlock } from '../../src/commands/splitBlock'
import { pendingAt, toggleMark, togglePending } from '../../src/commands/toggleMark'
import { at, doc, expectDoc } from './helpers'

describe('splitBlock', () => {
  test('in the middle of a block', () => {
    const ctx = doc('<p>a<strong>bc</strong>d</p>')
    const pos = splitBlock(ctx, at(ctx, 0, 2), at(ctx, 0, 2))
    expectDoc(ctx, '<p>a<strong>b</strong></p><p><strong>c</strong>d</p>')
    expect(pos).toEqual(at(ctx, 1, 0))
  })

  test('at the end of a block leaves an empty paragraph with a placeholder', () => {
    const ctx = doc('<p>ab</p>')
    const pos = splitBlock(ctx, at(ctx, 0, 2), at(ctx, 0, 2))
    expectDoc(ctx, '<p>ab</p><p><br></p>')
    expect(pos).toEqual(at(ctx, 1, 0))
  })

  test('at the start of a heading inserts a paragraph above and keeps the heading', () => {
    const ctx = doc('<h1>Title</h1>')
    const pos = splitBlock(ctx, at(ctx, 0, 0), at(ctx, 0, 0))
    expectDoc(ctx, '<p><br></p><h1>Title</h1>')
    expect(pos).toEqual(at(ctx, 1, 0))
  })

  test('the second half of a split heading becomes a paragraph', () => {
    const ctx = doc('<h1>Title</h1>')
    splitBlock(ctx, at(ctx, 0, 2), at(ctx, 0, 2))
    expectDoc(ctx, '<h1>Ti</h1><p>tle</p>')
  })

  test('over a selection across blocks deletes it, then splits', () => {
    const ctx = doc('<p>abc</p><p>def</p>')
    splitBlock(ctx, at(ctx, 0, 1), at(ctx, 1, 2))
    expectDoc(ctx, '<p>a</p><p>f</p>')
  })
})

describe('deleteRange and joins', () => {
  test('joining a paragraph into a heading keeps the heading', () => {
    const ctx = doc('<h1>ab</h1><p><em>cd</em></p>')
    const prev = stepBackward(ctx, at(ctx, 1, 0), 'char')!
    const pos = deleteRange(ctx, prev, at(ctx, 1, 0))
    expectDoc(ctx, '<h1>ab<em>cd</em></h1>')
    expect(pos).toEqual(at(ctx, 0, 2))
  })

  test('backspace at the start of the document has nowhere to go', () => {
    const ctx = doc('<p>ab</p>')
    expect(stepBackward(ctx, at(ctx, 0, 0), 'char')).toBeNull()
  })

  test('delete at the end of the document has nowhere to go', () => {
    const ctx = doc('<p>ab</p>')
    expect(stepForward(ctx, at(ctx, 0, 2), 'char')).toBeNull()
  })

  test('delete forward at the end of a block joins the next block', () => {
    const ctx = doc('<p>ab</p><h2>cd</h2>')
    const next = stepForward(ctx, at(ctx, 0, 2), 'char')!
    deleteRange(ctx, at(ctx, 0, 2), next)
    expectDoc(ctx, '<p>abcd</p>')
  })

  test('backspace into an empty paragraph removes it and keeps the heading', () => {
    const ctx = doc('<p><br></p><h1>ab</h1>')
    const prev = stepBackward(ctx, at(ctx, 1, 0), 'char')!
    const pos = deleteRange(ctx, prev, at(ctx, 1, 0))
    expectDoc(ctx, '<h1>ab</h1>')
    expect(pos).toEqual(at(ctx, 0, 0))
  })

  test('delete forward from an empty paragraph removes it and keeps the heading', () => {
    const ctx = doc('<h2>x</h2><p><br></p><h1>ab</h1>')
    const next = stepForward(ctx, at(ctx, 1, 0), 'char')!
    const pos = deleteRange(ctx, at(ctx, 1, 0), next)
    expectDoc(ctx, '<h2>x</h2><h1>ab</h1>')
    expect(pos).toEqual(at(ctx, 1, 0))
  })

  test('a range across three blocks with mixed marks', () => {
    const ctx = doc('<h1>a<strong>bc</strong></h1><p>mid</p><p><em>de</em>f</p>')
    const pos = deleteRange(ctx, at(ctx, 0, 2), at(ctx, 2, 1))
    expectDoc(ctx, '<h1>a<strong>b</strong><em>e</em>f</h1>')
    expect(pos).toEqual(at(ctx, 0, 2))
  })

  test('deleting everything in a block leaves the placeholder', () => {
    const ctx = doc('<p><strong>ab</strong></p>')
    deleteRange(ctx, at(ctx, 0, 0), at(ctx, 0, 2))
    expectDoc(ctx, '<p><br></p>')
  })

  test('removing the last character of a mark removes the empty mark', () => {
    const ctx = doc('<p>a<em>b</em>c</p>')
    deleteRange(ctx, at(ctx, 0, 1), at(ctx, 0, 2))
    expectDoc(ctx, '<p>ac</p>')
  })

  test('backspace steps over a whole grapheme', () => {
    const ctx = doc('<p>a👍🏽</p>')
    expect(stepBackward(ctx, at(ctx, 0, 5), 'char')).toEqual(at(ctx, 0, 1))
    expect(stepForward(ctx, at(ctx, 0, 1), 'char')).toEqual(at(ctx, 0, 5))
  })

  test('word steps take the trailing space with the word', () => {
    const ctx = doc('<p>one two three</p>')
    expect(stepBackward(ctx, at(ctx, 0, 8), 'word')).toEqual(at(ctx, 0, 4))
    expect(stepBackward(ctx, at(ctx, 0, 7), 'word')).toEqual(at(ctx, 0, 4))
    expect(stepForward(ctx, at(ctx, 0, 3), 'word')).toEqual(at(ctx, 0, 7))
  })

  test('line steps stop at a <br>, and delete the <br> when right next to it', () => {
    const ctx = doc('<p>ab<br>cd</p>')
    expect(stepBackward(ctx, at(ctx, 0, 5), 'line')).toEqual(at(ctx, 0, 3))
    expect(stepBackward(ctx, at(ctx, 0, 3), 'line')).toEqual(at(ctx, 0, 2))
    expect(stepForward(ctx, at(ctx, 0, 0), 'line')).toEqual(at(ctx, 0, 2))
    expect(stepForward(ctx, at(ctx, 0, 2), 'line')).toEqual(at(ctx, 0, 3))
  })
})

describe('insertLineBreak', () => {
  test('in the middle of bold text splits the mark around the <br>', () => {
    const ctx = doc('<p><strong>abcd</strong></p>')
    const pos = insertLineBreak(ctx, at(ctx, 0, 2), at(ctx, 0, 2))
    expectDoc(ctx, '<p><strong>ab</strong><br><strong>cd</strong></p>')
    expect(pos).toEqual(at(ctx, 0, 3))
  })

  test('at the end of a block adds a placeholder <br>', () => {
    const ctx = doc('<p>ab</p>')
    insertLineBreak(ctx, at(ctx, 0, 2), at(ctx, 0, 2))
    expectDoc(ctx, '<p>ab<br><br></p>')
  })

  test('in an empty block gives two empty lines', () => {
    const ctx = doc('<p><br></p>')
    insertLineBreak(ctx, at(ctx, 0, 0), at(ctx, 0, 0))
    expectDoc(ctx, '<p><br><br></p>')
  })

  test('backspace after a trailing <br> removes the placeholder too', () => {
    const ctx = doc('<p>ab<br><br></p>')
    const prev = stepBackward(ctx, at(ctx, 0, 3), 'char')!
    deleteRange(ctx, prev, at(ctx, 0, 3))
    expectDoc(ctx, '<p>ab</p>')
  })
})

describe('insertText', () => {
  test('takes the marks of the text before the caret at a mark boundary', () => {
    const ctx = doc('<p><strong>ab</strong>cd</p>')
    insertText(ctx, at(ctx, 0, 2), at(ctx, 0, 2), 'X')
    expectDoc(ctx, '<p><strong>abX</strong>cd</p>')
  })

  test('leaving a mark: plain text before the caret wins', () => {
    const ctx = doc('<p>ab<strong>cd</strong></p>')
    insertText(ctx, at(ctx, 0, 2), at(ctx, 0, 2), 'X')
    expectDoc(ctx, '<p>abX<strong>cd</strong></p>')
  })

  test('at the start of a block takes the marks after the caret', () => {
    const ctx = doc('<p><em>ab</em></p>')
    insertText(ctx, at(ctx, 0, 0), at(ctx, 0, 0), 'X')
    expectDoc(ctx, '<p><em>Xab</em></p>')
  })

  test('at the start of a line after a <br> takes the marks after the caret', () => {
    const ctx = doc('<p>ab<br><strong>cd</strong></p>')
    insertText(ctx, at(ctx, 0, 3), at(ctx, 0, 3), 'X')
    expectDoc(ctx, '<p>ab<br><strong>Xcd</strong></p>')
  })

  test('over a selection replaces it with the marks before the selection', () => {
    const ctx = doc('<p><em>ab</em>cd</p><p>ef</p>')
    const pos = insertText(ctx, at(ctx, 0, 1), at(ctx, 1, 1), 'X')
    expectDoc(ctx, '<p><em>aX</em>f</p>')
    expect(pos).toEqual(at(ctx, 0, 2))
  })

  test('into an empty block drops the placeholder', () => {
    const ctx = doc('<p><br></p>')
    insertText(ctx, at(ctx, 0, 0), at(ctx, 0, 0), 'X')
    expectDoc(ctx, '<p>X</p>')
  })

  test('explicit marks override inheritance', () => {
    const ctx = doc('<p>ab</p>')
    insertText(ctx, at(ctx, 0, 1), at(ctx, 0, 1), 'X', ['strong'])
    expectDoc(ctx, '<p>a<strong>X</strong>b</p>')
  })
})

describe('pending marks', () => {
  test('a pending mark is used by the next character at the same caret', () => {
    const ctx = doc('<p>ab</p>')
    const pending = togglePending(ctx, null, at(ctx, 0, 1), 'strong')
    insertText(ctx, at(ctx, 0, 1), at(ctx, 0, 1), 'X', pendingAt(pending, at(ctx, 0, 1)))
    expectDoc(ctx, '<p>a<strong>X</strong>b</p>')
  })

  test('a pending mark is dropped once the caret moves', () => {
    const ctx = doc('<p>ab</p>')
    const pending = togglePending(ctx, null, at(ctx, 0, 1), 'strong')
    expect(pendingAt(pending, at(ctx, 0, 2))).toBeUndefined()
    insertText(ctx, at(ctx, 0, 2), at(ctx, 0, 2), 'X', pendingAt(pending, at(ctx, 0, 2)))
    expectDoc(ctx, '<p>abX</p>')
  })

  test('toggling inside bold text turns bold off for the next character', () => {
    const ctx = doc('<p><strong><em>ab</em></strong></p>')
    const pending = togglePending(ctx, null, at(ctx, 0, 2), 'strong')
    expect(pending.marks).toEqual(['em'])
    const twice = togglePending(ctx, pending, at(ctx, 0, 2), 'strong')
    expect(twice.marks).toEqual(['strong', 'em'])
  })
})

describe('toggleMark', () => {
  test('over a partly bold range merges into one strong, never nested', () => {
    const ctx = doc('<p>a<strong>bc</strong>de</p>')
    toggleMark(ctx, at(ctx, 0, 0), at(ctx, 0, 4), 'strong')
    expectDoc(ctx, '<p><strong>abcd</strong>e</p>')
  })

  test('over a fully bold range removes it', () => {
    const ctx = doc('<p><strong>abc</strong></p>')
    toggleMark(ctx, at(ctx, 0, 0), at(ctx, 0, 3), 'strong')
    expectDoc(ctx, '<p>abc</p>')
  })

  test('unwrapping the middle of a mark leaves both ends marked', () => {
    const ctx = doc('<p><strong>abcde</strong></p>')
    toggleMark(ctx, at(ctx, 0, 1), at(ctx, 0, 4), 'strong')
    expectDoc(ctx, '<p><strong>a</strong>bcd<strong>e</strong></p>')
  })

  test('adding strong to italic text puts strong outside em', () => {
    const ctx = doc('<p><em>abc</em></p>')
    toggleMark(ctx, at(ctx, 0, 1), at(ctx, 0, 2), 'strong')
    expectDoc(ctx, '<p><em>a</em><strong><em>b</em></strong><em>c</em></p>')
  })

  test('across blocks, splitting marks around a <br>', () => {
    const ctx = doc('<h1>ab</h1><p>c<br>d</p>')
    toggleMark(ctx, at(ctx, 0, 1), at(ctx, 1, 3), 'em')
    expectDoc(ctx, '<h1>a<em>b</em></h1><p><em>c</em><br><em>d</em></p>')
  })

  test('a range with no text is a no-op', () => {
    const ctx = doc('<p><br></p>')
    toggleMark(ctx, at(ctx, 0, 0), at(ctx, 0, 0), 'strong')
    expectDoc(ctx, '<p><br></p>')
  })
})

describe('insertPlainText', () => {
  test('multi-line text becomes several blocks', () => {
    const ctx = doc('<h1>ab</h1>')
    const pos = insertPlainText(ctx, at(ctx, 0, 1), at(ctx, 0, 1), 'one\r\ntwo\n\nthree')
    expectDoc(ctx, '<h1>aone</h1><p>two</p><p><br></p><p>threeb</p>')
    expect(pos).toEqual(at(ctx, 3, 5))
  })

  test('takes the marks at the caret', () => {
    const ctx = doc('<p><strong>ab</strong></p>')
    insertPlainText(ctx, at(ctx, 0, 1), at(ctx, 0, 1), 'x\ny')
    expectDoc(ctx, '<p><strong>ax</strong></p><p><strong>yb</strong></p>')
  })
})

describe('repairBlock', () => {
  test('maps <b>/<i> to marks and unwraps <span>s', () => {
    const ctx = doc('<p>a<b>b<span style="color:red">c</span></b><i>d</i><strong></strong></p>')
    repairBlock(ctx, ctx.root.firstChild!)
    expectDoc(ctx, '<p>a<strong>bc</strong><em>d</em></p>')
  })

  test('re-nests em outside strong and merges adjacent marks', () => {
    const ctx = doc('<p><em><strong>a</strong></em><strong>b</strong></p>')
    repairBlock(ctx, ctx.root.firstChild!)
    expectDoc(ctx, '<p><strong><em>a</em>b</strong></p>')
  })

  test('wraps a stray <div> in the default block and keeps the caret', () => {
    const ctx = doc('<p>a</p><div>b<b>c</b></div>')
    const text = ctx.root.children[1]!.querySelector('b')!.firstChild!
    const pos = repairBlock(ctx, ctx.root.children[1]!, { node: text, offset: 1 })
    expectDoc(ctx, '<p>a</p><p>b<strong>c</strong></p>')
    expect(pos).toEqual(at(ctx, 1, 2))
  })

  test('wraps stray root text', () => {
    const ctx = doc('<p>a</p>')
    ctx.root.append('typed')
    repairBlock(ctx, ctx.root.lastChild!)
    expectDoc(ctx, '<p>a</p><p>typed</p>')
  })

  test('adds the placeholder to a block left empty', () => {
    const ctx = doc('<p></p>')
    repairBlock(ctx, ctx.root.firstChild!)
    expectDoc(ctx, '<p><br></p>')
  })
})
