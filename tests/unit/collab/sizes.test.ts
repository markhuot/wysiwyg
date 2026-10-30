import { afterEach, describe, expect, test } from 'bun:test'
import { bind } from '../../../src/collab'
import { IdleBuild, SizeIndex } from '../../../src/collab/sizes'
import { createEditor } from '../../../src/editor'
import { Net, typeAt, type Client } from './net'

afterEach(() => document.body.replaceChildren())

function blocks(n: number): HTMLElement {
  const root = document.createElement('div')
  root.setAttribute('contenteditable', 'true')
  root.innerHTML = Array.from({ length: n }, (_, i) => `<p>Paragraph ${i} <strong>bold</strong></p>`).join('')
  document.body.append(root)
  return root
}

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !done(); i++) await Bun.sleep(2)
  expect(done()).toBe(true)
}

describe('SizeIndex', () => {
  test('prefix sums, lookups, updates and splices agree with a plain array', () => {
    let seed = 7
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    const sizes = Array.from({ length: 50 }, () => 2 + Math.floor(random() * 20))
    const index = new SizeIndex(sizes.slice())
    const check = () => {
      let start = 0
      sizes.forEach((size, i) => {
        expect(index.start(i)).toBe(start)
        expect(index.find(start)).toBe(i)
        expect(index.find(start + size - 1)).toBe(i)
        start += size
      })
      expect(index.total).toBe(start)
      expect(index.find(start)).toBe(sizes.length)
    }
    check()
    for (let k = 0; k < 30; k++) {
      const i = Math.floor(random() * sizes.length)
      if (random() < 0.5) {
        sizes[i] = 2 + Math.floor(random() * 20)
        index.set(i, sizes[i]!)
      } else {
        const add = Array.from({ length: Math.floor(random() * 3) }, () => 2 + Math.floor(random() * 5))
        const remove = Math.min(Math.floor(random() * 3), sizes.length - i)
        sizes.splice(i, remove, ...add)
        index.splice(i, remove, add)
      }
      check()
    }
  })
})

describe('IdleBuild', () => {
  test('in idle slices, finished early, or from the server: the same index', async () => {
    const root = blocks(500)
    const idle = new IdleBuild(root, () => {}, 0).start()
    await until(() => idle.done)
    expect(idle.stats.slices).toBeGreaterThan(1)

    const early = new IdleBuild(root, () => {}, 0).start()
    await Bun.sleep(2)
    expect(early.done).toBe(false)
    const finished = early.finish()

    const net = new Net(root.innerHTML)
    expect(finished.toArray()).toEqual(idle.finish().toArray())
    expect(finished.toArray()).toEqual(net.authority.sizesAt())
  })

  test('an edit before the build finishes completes it synchronously first', () => {
    const net = new Net(blocks(300).innerHTML)
    const root = document.body.firstElementChild as HTMLElement
    const editor = createEditor(root)
    const collab = bind(editor, { server: net.transport(), online: false, debug: true })
    const c: Client = { editor, collab, root }
    typeAt(c, 299, 3, 'X')
    expect(collab.pending).toBe(1)
    expect(collab.check()).toBe(true)
    expect(collab.sizes()).toEqual(new IdleBuild(root).finish().toArray())
    collab.destroy()
    editor.destroy()
  })

  test("a server index arriving mid-build replaces it; one for another version is ignored", async () => {
    const root = blocks(400)
    const net = new Net(root.innerHTML)
    const editor = createEditor(root)
    const collab = bind(editor, { server: net.transport(), online: false })
    const build = (collab as unknown as { build: IdleBuild }).build
    collab.online = true
    net.deliver()
    // The welcome carried the index, so the build stopped.
    expect((collab as unknown as { build: unknown }).build).toBeNull()
    expect(build.done).toBe(false)
    expect(collab.sizes()).toEqual(net.authority.sizesAt())
    collab.destroy()
    editor.destroy()

    const wrong = { version: 3, sizes: new Array(400).fill(99) }
    const other = bind(createEditor(root), { server: net.transport(), online: false, sizes: () => wrong })
    expect(other.sizes()).toEqual(net.authority.sizesAt())
    other.destroy()
  })
})
