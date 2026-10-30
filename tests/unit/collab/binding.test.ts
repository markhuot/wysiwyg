import { afterEach, describe, expect, test } from 'bun:test'
import { bind } from '../../../src/collab'
import { getSelectionFor, pointToPos } from '../../../src/dom'
import { createEditor } from '../../../src/editor'
import { client, expectConverged, input, Net, select, settle, typeAt, type Client } from './net'

const live: Client[] = []
const track = (c: Client) => (live.push(c), c)

afterEach(() => {
  for (const c of live.splice(0)) {
    c.collab.destroy()
    c.editor.destroy()
  }
  document.body.replaceChildren()
})

function caret(c: Client): [number, number] {
  const sel = getSelectionFor(c.root)!
  const pos = pointToPos(c.root, sel.focusNode!, sel.focusOffset)!
  return [Array.prototype.indexOf.call(c.root.children, pos.block), pos.offset]
}

function pair(html: string): { net: Net; a: Client; b: Client } {
  const net = new Net(html)
  const a = track(client(net))
  const b = track(client(net))
  settle(net, [a, b])
  return { net, a, b }
}

describe('bind', () => {
  test('reads and writes nothing in the document at boot', () => {
    const root = document.createElement('div')
    root.setAttribute('contenteditable', 'true')
    root.setAttribute('data-version', '3')
    root.innerHTML = '<h1>Title</h1><p>a <strong>b</strong></p>'
    document.body.append(root)
    const editor = createEditor(root)

    let reads = 0
    for (const block of root.children) {
      for (const prop of ['firstChild', 'childNodes', 'textContent', 'nextElementSibling', 'previousElementSibling']) {
        const proto = Object.getPrototypeOf(block)
        let owner = proto
        while (owner && !Object.getOwnPropertyDescriptor(owner, prop)) owner = Object.getPrototypeOf(owner)
        const desc = Object.getOwnPropertyDescriptor(owner, prop)!
        Object.defineProperty(block, prop, { configurable: true, get() { reads++; return desc.get!.call(this) } })
      }
    }
    const getAttribute = root.getAttribute.bind(root)
    let attributeReads = 0
    root.getAttribute = (name: string) => (attributeReads++, getAttribute(name))
    const observer = new MutationObserver(() => {})
    observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true })

    const collab = bind(editor, { server: new Net('<p>x</p>').transport(), online: false })
    expect(observer.takeRecords()).toEqual([])
    expect(reads).toBe(0)
    expect(attributeReads).toBe(0)
    expect(document.querySelector('.wysiwyg-cursors')).toBeNull()
    collab.destroy()
    editor.destroy()
  })

  test('typing works before the connection opens and merges when it does', () => {
    const net = new Net('<p>ab</p>')
    const a = track(client(net))
    const b = track(client(net))
    typeAt(a, 0, 1, 'x')
    typeAt(a, 0, 2, 'y')
    typeAt(b, 0, 2, 'z')
    // a's two keystrokes became one step.
    expect(a.collab.pending).toBe(1)
    settle(net, [a, b])
    expect(expectConverged(net, [a, b])).toBe('<p>axybz</p>')
  })

  test('remote edits keep the local caret where it was relative to the text', () => {
    const { net, a, b } = pair('<p>abcd</p><p>efgh</p>')
    // The clients share one document, so one selection: b edits first, then a's caret is placed.
    typeAt(b, 0, 0, 'XY')
    select(b, 1, 0)
    input(b, 'insertParagraph')
    select(a, 1, 2)
    net.deliver()
    expect(a.root.innerHTML).toBe('<p>XYabcd</p><p><br></p><p>efgh</p>')
    expect(caret(a)).toEqual([2, 2])
  })

  test('the caret stays inside text typed here when a remote edit lands before it', () => {
    const { net, a, b } = pair('<p>abcd</p>')
    a.collab.online = false
    typeAt(b, 0, 0, 'Z')
    typeAt(a, 0, 4, 'Q')
    net.deliver()
    a.collab.online = true
    net.deliver()
    expect(a.root.innerHTML).toBe('<p>ZabcdQ</p>')
    settle(net, [a, b])
    expectConverged(net, [a, b])
    expect(caret(a)).toEqual([0, 6])
  })

  test('pending marks follow the text when a remote edit lands before them', () => {
    const { net, a, b } = pair('<p>abcd</p>')
    typeAt(b, 0, 0, 'Z')
    select(a, 0, 2)
    input(a, 'formatBold')
    net.deliver()
    input(a, 'insertText', 'X')
    settle(net, [a, b])
    expect(expectConverged(net, [a, b])).toBe('<p>Zab<strong>X</strong>cd</p>')
  })

  test('composition: the composed block becomes a step, and remote steps wait for it to end', () => {
    const { net, a, b } = pair('<p>ab</p><p>cd</p>')
    select(a, 0, 2)
    a.root.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    // The browser composes natively.
    const text = a.root.firstElementChild!.firstChild as Text
    text.insertData(2, 'にほ')
    typeAt(b, 1, 0, 'R')
    net.deliver()
    expect(a.root.innerHTML).toBe('<p>abにほ</p><p>cd</p>')
    a.root.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    expect(a.root.innerHTML).toBe('<p>abにほ</p><p>Rcd</p>')
    settle(net, [a, b])
    expect(expectConverged(net, [a, b])).toBe('<p>abにほ</p><p>Rcd</p>')
  })

  test('undo reverts only local changes, wherever remote edits moved them', () => {
    const { net, a, b } = pair('<p>abcd</p>')
    typeAt(a, 0, 2, 'A')
    settle(net, [a, b])
    typeAt(b, 0, 0, 'B1')
    typeAt(b, 0, 7, 'B2')
    settle(net, [a, b])
    expect(a.root.innerHTML).toBe('<p>B1abAcdB2</p>')
    input(a, 'historyUndo')
    expect(a.root.innerHTML).toBe('<p>B1abcdB2</p>')
    input(a, 'historyUndo')
    expect(a.root.innerHTML).toBe('<p>B1abcdB2</p>')
    input(a, 'historyRedo')
    settle(net, [a, b])
    expect(expectConverged(net, [a, b])).toBe('<p>B1abAcdB2</p>')
  })

  test("undo skips a change whose text someone else deleted", () => {
    const { net, a, b } = pair('<p>abcd</p><p>e</p>')
    typeAt(a, 0, 2, 'X')
    select(a, 1, 1)
    input(a, 'insertParagraph')
    settle(net, [a, b])
    select(b, 0, 1, 0, 4)
    input(b, 'deleteContentBackward')
    settle(net, [a, b])
    input(a, 'historyUndo')
    input(a, 'historyUndo')
    settle(net, [a, b])
    expect(expectConverged(net, [a, b])).toBe('<p>ad</p><p>e</p>')
  })

  test("other clients' cursors map through later edits and go away on disconnect", async () => {
    const { net, a, b } = pair('<p>abcd</p>')
    select(a, 0, 1, 0, 3)
    a.root.ownerDocument.dispatchEvent(new Event('selectionchange'))
    await Bun.sleep(30)
    net.deliver()
    expect(b.collab.remoteCursors().map((c) => [c.clientId, c.from.offset, c.to.offset])).toEqual([[a.collab.clientId, 1, 3]])
    expect(document.querySelector('.wysiwyg-cursors')).not.toBeNull()
    expect(b.root.innerHTML).toBe('<p>abcd</p>')
    typeAt(b, 0, 0, 'ZZ')
    expect(b.collab.remoteCursors().map((c) => [c.from.offset, c.to.offset])).toEqual([[3, 5]])
    a.collab.online = false
    net.deliver()
    expect(b.collab.remoteCursors()).toEqual([])
  })

  test("a client that hasn't edited yet places others' cursors", async () => {
    const net = new Net('<p>abcd</p>')
    const sizes = () => ({ version: 0, sizes: net.authority.sizesAt(0) })
    const a = track(client(net))
    const b = track(client(net, undefined, 0, { sizes, debug: false }))
    settle(net, [a, b])
    select(a, 0, 2)
    a.root.ownerDocument.dispatchEvent(new Event('selectionchange'))
    await Bun.sleep(30)
    net.deliver()
    expect(b.collab.remoteCursors().map((c) => c.to.offset)).toEqual([2])
  })

  test('a form reset leaves the shared document alone', () => {
    const net = new Net('<p>ab</p>')
    const form = document.createElement('form')
    document.body.append(form)
    const a = track(client(net))
    form.append(a.root)
    settle(net, [a])
    typeAt(a, 0, 1, 'X')
    form.reset()
    expect(a.root.innerHTML).toBe('<p>aXb</p>')
  })

  test('the debug check catches a change no step reported', () => {
    const { a } = pair('<p>ab</p>')
    typeAt(a, 0, 1, 'X')
    expect(a.collab.check()).toBe(true)
    a.root.firstElementChild!.append('sneaky')
    const error = console.error
    console.error = () => {}
    try {
      expect(a.collab.check()).toBe(false)
    } finally {
      console.error = error
    }
  })
})
