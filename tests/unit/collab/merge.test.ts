import { afterEach, describe, expect, test } from 'bun:test'
import { SetBlockStep } from '../../../src/collab'
import { client, expectConverged, input, Net, select, settle, typeAt, type Client } from './net'

const live: Client[] = []

function setup(html: string, n = 2): { net: Net; clients: Client[] } {
  const net = new Net(html)
  const clients = Array.from({ length: n }, () => client(net))
  live.push(...clients)
  settle(net, clients)
  // Both edit offline from here, so their edits are concurrent.
  for (const c of clients) c.collab.online = false
  return { net, clients }
}

afterEach(() => {
  for (const c of live.splice(0)) {
    c.collab.destroy()
    c.editor.destroy()
  }
  document.body.replaceChildren()
})

/** Runs both orders: A's edits reach the server first, then B's first. */
function both(html: string, a: (c: Client) => void, b: (c: Client) => void): [string, string] {
  const out: string[] = []
  for (const order of [0, 1]) {
    const { net, clients } = setup(html)
    a(clients[0]!)
    b(clients[1]!)
    const first = clients[order]!
    first.collab.online = true
    net.deliver()
    settle(net, clients)
    out.push(expectConverged(net, clients))
  }
  return out as [string, string]
}

describe('merging concurrent edits', () => {
  test('split vs typing in the tail: the text lands in the new block', () => {
    const results = both(
      '<p>abcd</p>',
      (c) => {
        select(c, 0, 2)
        input(c, 'insertParagraph')
      },
      (c) => typeAt(c, 0, 3, 'X'),
    )
    expect(results).toEqual(['<p>ab</p><p>cXd</p>', '<p>ab</p><p>cXd</p>'])
  })

  test('join vs typing on either side keeps all the text', () => {
    const join = (c: Client) => {
      select(c, 1, 0)
      input(c, 'deleteContentBackward')
    }
    expect(both('<h1>ab</h1><p>cd</p>', join, (c) => typeAt(c, 0, 1, 'X'))).toEqual(['<h1>aXbcd</h1>', '<h1>aXbcd</h1>'])
    expect(both('<h1>ab</h1><p>cd</p>', join, (c) => typeAt(c, 1, 1, 'Y'))).toEqual(['<h1>abcYd</h1>', '<h1>abcYd</h1>'])
  })

  test('the empty-start join keeps the heading tag while the other side types in it', () => {
    const join = (c: Client) => {
      select(c, 0, 0)
      input(c, 'deleteContentForward')
    }
    expect(both('<p><br></p><h1>ab</h1>', join, (c) => typeAt(c, 1, 2, 'Z'))).toEqual(['<h1>abZ</h1>', '<h1>abZ</h1>'])
  })

  test('two splits at the same point give an empty block between them', () => {
    const split = (c: Client) => {
      select(c, 0, 2)
      input(c, 'insertParagraph')
    }
    expect(both('<p>abcd</p>', split, split)).toEqual(['<p>ab</p><p><br></p><p>cd</p>', '<p>ab</p><p><br></p><p>cd</p>'])
  })

  test('bold vs typing inside the range and at each edge', () => {
    const bold = (c: Client) => {
      select(c, 0, 1, 0, 3)
      input(c, 'formatBold')
    }
    // Inside the range, typed text is bold only if the bold is ordered after it. Every client agrees either way.
    expect(both('<p>abcd</p>', bold, (c) => typeAt(c, 0, 2, 'X'))).toEqual([
      '<p>a<strong>b</strong>X<strong>c</strong>d</p>',
      '<p>a<strong>bXc</strong>d</p>',
    ])
    // At the edges the typed text takes the marks of what precedes it on its own client, and the bold covers only its own range.
    expect(both('<p>abcd</p>', bold, (c) => typeAt(c, 0, 1, 'S'))).toEqual(['<p>aS<strong>bc</strong>d</p>', '<p>aS<strong>bc</strong>d</p>'])
    expect(both('<p>abcd</p>', bold, (c) => typeAt(c, 0, 3, 'E'))).toEqual(['<p>a<strong>bc</strong>Ed</p>', '<p>a<strong>bc</strong>Ed</p>'])
  })

  test('overlapping deletes remove the union once', () => {
    const del = (from: number, to: number) => (c: Client) => {
      select(c, 0, from, 0, to)
      input(c, 'deleteContentBackward')
    }
    expect(both('<p>abcdef</p>', del(1, 4), del(2, 5))).toEqual(['<p>af</p>', '<p>af</p>'])
  })

  test('a range delete across a concurrent split covers the new break', () => {
    const del = (c: Client) => {
      select(c, 0, 1, 1, 1)
      input(c, 'deleteContentBackward')
    }
    const split = (c: Client) => {
      select(c, 1, 0)
      input(c, 'insertParagraph')
    }
    const split2 = (c: Client) => {
      select(c, 0, 2)
      input(c, 'insertParagraph')
    }
    const [x, y] = both('<p>abc</p><p>def</p>', del, split2)
    expect(x).toBe(y)
    expect(x.replace(/<[^>]+>/g, '')).toBe('aef')
    const [p, q] = both('<p>abc</p><p>def</p>', del, split)
    expect(p).toBe(q)
  })

  test('a tag change vs a split: the first half keeps the new tag', () => {
    const tag = (c: Client) => c.collab.apply(new SetBlockStep(0, 'h2'))
    const split = (c: Client) => {
      select(c, 0, 2)
      input(c, 'insertParagraph')
    }
    expect(both('<p>abcd</p>', tag, split)).toEqual(['<h2>ab</h2><p>cd</p>', '<h2>ab</h2><p>cd</p>'])
  })

  test('a join vs a tag change on the joined block: the join wins either way', () => {
    const join = (c: Client) => {
      select(c, 1, 0)
      input(c, 'deleteContentBackward')
    }
    const tag = (c: Client) => c.collab.apply(new SetBlockStep(4, 'h2'))
    const [x, y] = both('<p>ab</p><p>cd</p>', join, tag)
    expect(x).toBe(y)
    expect(x).toBe('<p>abcd</p>')
  })
})
