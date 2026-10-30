import { describe, expect, setSystemTime, test } from 'bun:test'
import { History, MERGE_MS } from '../../src/history'

function setup() {
  const root = document.createElement('div')
  root.innerHTML = '<p>a</p>'
  return { root, history: new History(root) }
}

describe('History', () => {
  test('undo and redo restore snapshots', () => {
    const { root, history } = setup()
    history.record()
    root.innerHTML = '<p>b</p>'
    expect(history.undo()).toBe(true)
    expect(root.innerHTML).toBe('<p>a</p>')
    expect(history.redo()).toBe(true)
    expect(root.innerHTML).toBe('<p>b</p>')
    expect(history.redo()).toBe(false)
  })

  test('typing at the caret the last keystroke left merges into one entry', () => {
    const { root, history } = setup()
    history.record('k1')
    root.innerHTML = '<p>ab</p>'
    history.typed('k2')
    history.record('k2')
    root.innerHTML = '<p>abc</p>'
    history.undo()
    expect(root.innerHTML).toBe('<p>a</p>')
  })

  test('a caret move starts a new entry', () => {
    const { root, history } = setup()
    history.record('k1')
    root.innerHTML = '<p>ab</p>'
    history.typed('k2')
    history.record('elsewhere')
    root.innerHTML = '<p>abc</p>'
    history.undo()
    expect(root.innerHTML).toBe('<p>ab</p>')
  })

  test('a pause starts a new entry', () => {
    const { root, history } = setup()
    try {
      setSystemTime(new Date(0))
      history.record('k1')
      root.innerHTML = '<p>ab</p>'
      history.typed('k2')
      setSystemTime(new Date(MERGE_MS + 1))
      history.record('k2')
      root.innerHTML = '<p>abc</p>'
      history.undo()
      expect(root.innerHTML).toBe('<p>ab</p>')
    } finally {
      setSystemTime()
    }
  })

  test('a new change clears redo', () => {
    const { root, history } = setup()
    history.record()
    root.innerHTML = '<p>b</p>'
    history.undo()
    history.record()
    expect(history.redo()).toBe(false)
  })

  test('reset restores the starting HTML even after the limit evicts old entries', () => {
    const root = document.createElement('div')
    root.innerHTML = '<p>start</p>'
    const history = new History(root, 3)
    for (let i = 0; i < 10; i++) {
      history.record()
      root.innerHTML = `<p>${i}</p>`
    }
    history.reset()
    expect(root.innerHTML).toBe('<p>start</p>')
    expect(history.undo()).toBe(false)
  })

  test('reset with nothing recorded changes nothing', () => {
    const { root, history } = setup()
    root.innerHTML = '<p>set by the app</p>'
    history.reset()
    expect(root.innerHTML).toBe('<p>set by the app</p>')
  })

  test('after a reset the next change records the restored HTML as the start', () => {
    const { root, history } = setup()
    history.record()
    root.innerHTML = '<p>b</p>'
    history.reset()
    history.record()
    root.innerHTML = '<p>c</p>'
    history.reset()
    expect(root.innerHTML).toBe('<p>a</p>')
  })
})
