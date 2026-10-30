import { afterEach, describe, expect, test } from 'bun:test'
import { ReplaceStep, type CollabEvent } from '../../../src/collab'
import { Authority } from '../../../src/collab/server'
import { IdleBuild } from '../../../src/collab/sizes'
import { defaultSchema } from '../../../src/schema'
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

function errors(c: Client): CollabEvent[] {
  const out: CollabEvent[] = []
  c.collab.addEventListener('error', (e) => out.push((e as Event & { detail: CollabEvent }).detail))
  return out
}

describe('the handshake', () => {
  test('a client whose schema differs is refused with an error event and stops reconnecting', () => {
    const net = new Net('<p>a</p>')
    const c = track(client(net))
    const paragraphs = new Net('<p>a</p>', { blocks: ['p'], marks: ['strong', 'em'], defaultBlock: 'p' })
    const other = track(client(paragraphs))
    // The paragraph-only client talks to the default-schema server.
    ;(other.collab as unknown as { transport: unknown }).transport = net.transport()
    const seen = errors(other)
    other.collab.online = true
    net.deliver()
    expect(seen).toEqual([{ type: 'error', reason: 'schema', message: expect.stringContaining("doesn't match") }])
    expect(net.queued).toBe(0)
    // The matching client still connects.
    settle(net, [c])
  })

  test('a version the server never had is refused', () => {
    const net = new Net('<p>a</p>')
    const c = track(client(net, '<p>a</p>', 7))
    const seen = errors(c)
    c.collab.online = true
    net.deliver()
    expect(seen.map((e) => e.type === 'error' && e.reason)).toEqual(['version'])
  })
})

describe('sending steps', () => {
  test('the server refuses a step that breaks the schema, and the client takes it back out', () => {
    const net = new Net('<p>ab</p>')
    const c = track(client(net))
    settle(net, [c])
    const seen = errors(c)
    // A step the local DOM accepts but the server's model doesn't: forged by swapping the JSON on the way out.
    const conn = (c.collab as unknown as { connection: { send: (m: unknown) => void } }).connection
    const send = conn.send
    conn.send = (m) => send({ ...(m as object), steps: [{ stepType: 'replace', from: 2, to: 2, slice: [{ kind: 'open', tag: 'div' }, { kind: 'close' }] }] })
    expect(c.collab.apply(new ReplaceStep(2, 2, [{ kind: 'text', text: 'X', marks: [] }]))).toBe(true)
    expect(c.root.innerHTML).toBe('<p>aXb</p>')
    net.deliver()
    expect(seen.map((e) => e.type === 'error' && e.reason)).toEqual(['invalid'])
    expect(c.root.innerHTML).toBe('<p>ab</p>')
    expect(net.authority.version).toBe(0)
  })

  test('a send that loses the race is rejected, rebased and resent', () => {
    const net = new Net('<p>ab</p>')
    const a = track(client(net))
    const b = track(client(net))
    settle(net, [a, b])
    typeAt(a, 0, 1, 'A')
    typeAt(b, 0, 1, 'B')
    // Both sends are on the wire at version 0; A's is accepted first.
    net.deliver()
    expect(net.authority.version).toBe(2)
    expectConverged(net, [a, b])
    // B's insert at the same point maps after A's.
    expect(a.root.innerHTML).toBe('<p>aABb</p>')
  })

  test('a client from an old version catches up, then edits with the others', () => {
    const net = new Net('<p>ab</p>')
    const a = track(client(net))
    settle(net, [a])
    typeAt(a, 0, 2, 'cd')
    select(a, 0, 4)
    input(a, 'insertParagraph')
    typeAt(a, 1, 0, 'ef')
    settle(net, [a])
    const v1 = 1
    const late = track(client(net, net.authority.htmlAt(v1), v1))
    const fresh = track(client(net, net.authority.htmlAt(0), 0))
    typeAt(late, 0, 0, '>')
    typeAt(fresh, 0, 0, '<')
    settle(net, [a, late, fresh])
    expect(expectConverged(net, [a, late, fresh])).toBe('<p>&gt;&lt;abcd</p><p>ef</p>')
  })

  test('the server sends a size index matching one built on the client', () => {
    const net = new Net('<h1>Title</h1><p>a <strong>b</strong><br>c</p><p><br></p>')
    const c = track(client(net))
    settle(net, [c])
    // No timer has run, so the idle build hasn't: the index came with the welcome.
    expect((c.collab as unknown as { index: unknown }).index).not.toBeNull()
    const built = new IdleBuild(c.root).finish().toArray()
    expect(c.collab.sizes()).toEqual(built)
    expect(net.authority.sizesAt()).toEqual([7, 7, 2])
  })
})

describe('Authority', () => {
  test('keeps every version: HTML at each one and steps since any of them', () => {
    const authority = new Authority('<p>a</p>', defaultSchema)
    authority.receive(0, [new ReplaceStep(2, 2, [{ kind: 'text', text: 'b', marks: [] }]).toJSON()], 'x')
    authority.receive(1, [new ReplaceStep(3, 3, [{ kind: 'text', text: 'c', marks: [] }]).toJSON()], 'y')
    expect([0, 1, 2].map((v) => authority.htmlAt(v))).toEqual(['<p>a</p>', '<p>ab</p>', '<p>abc</p>'])
    expect(authority.stepsSince(1)?.clientIds).toEqual(['y'])
    expect(authority.stepsSince(3)).toBeNull()
    expect(authority.receive(1, [], 'z')).toMatchObject({ ok: false, reason: 'version' })
  })
})
