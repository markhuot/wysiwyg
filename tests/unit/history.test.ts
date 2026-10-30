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
})
