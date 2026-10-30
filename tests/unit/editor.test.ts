import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { createEditor, type Editor } from '../../src/editor'
import { defaultSchema } from '../../src/schema'

const live: Editor[] = []

const LISTENERS = ['beforeinput', 'keydown', 'compositionstart', 'compositionend', 'formdata', 'reset']

function mount(html: string): HTMLElement {
  const el = document.createElement('div')
  el.setAttribute('contenteditable', 'true')
  el.innerHTML = html
  document.body.append(el)
  return el
}

function edit(el: HTMLElement, inputType: string): InputEvent {
  const event = new InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true, composed: true })
  el.dispatchEvent(event)
  return event
}

afterEach(() => {
  for (const editor of live.splice(0)) editor.destroy()
  document.body.replaceChildren()
})

describe('createEditor', () => {
  test('makes zero DOM mutations', () => {
    const el = mount('<h1>Title</h1><p>a <strong>b</strong></p>')
    const observer = new MutationObserver(() => {})
    observer.observe(el, { subtree: true, childList: true, attributes: true, characterData: true })
    live.push(createEditor(el, defaultSchema))
    expect(observer.takeRecords()).toEqual([])
    observer.disconnect()
  })

  test('cancels edits on its element and ignores unregistered elements', () => {
    const mine = mount('<p>a</p>')
    const other = mount('<p>b</p>')
    live.push(createEditor(mine))
    expect(edit(mine, 'insertOrderedList').defaultPrevented).toBe(true)
    expect(edit(other, 'insertOrderedList').defaultPrevented).toBe(false)
  })

  test('finds the editor when an engine targets a block inside it', () => {
    const el = mount('<p>a</p>')
    live.push(createEditor(el))
    expect(edit(el.firstElementChild as HTMLElement, 'insertOrderedList').defaultPrevented).toBe(true)
  })

  test('lets composition run natively', () => {
    const el = mount('<p>a</p>')
    live.push(createEditor(el))
    expect(edit(el, 'insertCompositionText').defaultPrevented).toBe(false)
  })

  test('destroy() unregisters one editor and leaves the others', () => {
    const a = mount('<p>a</p>')
    const b = mount('<p>b</p>')
    const editorA = createEditor(a)
    live.push(editorA, createEditor(b))
    editorA.destroy()
    expect(edit(a, 'insertOrderedList').defaultPrevented).toBe(false)
    expect(edit(b, 'insertOrderedList').defaultPrevented).toBe(true)
  })

  test('listeners are added on the first editor and removed after the last destroy', () => {
    const add = spyOn(document, 'addEventListener')
    const remove = spyOn(document, 'removeEventListener')
    try {
      const a = createEditor(mount('<p>a</p>'))
      const b = createEditor(mount('<p>b</p>'))
      expect(add.mock.calls.map((c) => c[0])).toEqual(LISTENERS)
      a.destroy()
      a.destroy()
      expect(remove).not.toHaveBeenCalled()
      b.destroy()
      expect(remove.mock.calls.map((c) => c[0])).toEqual(LISTENERS)
    } finally {
      add.mockRestore()
      remove.mockRestore()
    }
  })

  test('getHTML returns the element HTML as is', () => {
    const el = mount('<p>a<em>b</em></p>')
    const editor = createEditor(el)
    live.push(editor)
    expect(editor.getHTML()).toBe('<p>a<em>b</em></p>')
  })

  test('a form reset restores the starting HTML and clears undo', () => {
    const form = document.createElement('form')
    document.body.append(form)
    const el = mount('<p>ab</p>')
    form.append(el)
    live.push(createEditor(el))
    document.getSelection()!.collapse(el.firstChild!.firstChild!, 1)
    edit(el, 'insertParagraph')
    expect(el.innerHTML).toBe('<p>a</p><p>b</p>')
    form.reset()
    expect(el.innerHTML).toBe('<p>ab</p>')
    edit(el, 'historyUndo')
    expect(el.innerHTML).toBe('<p>ab</p>')
  })

  test('a reset leaves editors outside the form alone', () => {
    const form = document.createElement('form')
    document.body.append(form)
    const el = mount('<p>ab</p>')
    live.push(createEditor(el))
    document.getSelection()!.collapse(el.firstChild!.firstChild!, 1)
    edit(el, 'insertParagraph')
    form.reset()
    expect(el.innerHTML).toBe('<p>a</p><p>b</p>')
  })
})
