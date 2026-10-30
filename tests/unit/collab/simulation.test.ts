import { afterEach, expect, test } from 'bun:test'
import { SetBlockStep } from '../../../src/collab'
import { contentLength } from '../../../src/dom'
import { client, expectConverged, input, Net, select, settle, type Client } from './net'

/** mulberry32: a small seeded generator, so a failure replays from its seed. */
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const START = '<h1>Title</h1><p>one <strong>two</strong> three</p><p>four <em>five</em></p><h2>Six</h2><p>seven</p>'
const WORDS = ['a', 'b', 'xy', ' ', 'hello', 'é', '😀']
const TAGS = ['p', 'h1', 'h2']

const live: Client[] = []

afterEach(() => {
  for (const c of live.splice(0)) {
    c.collab.destroy()
    c.editor.destroy()
  }
  document.body.replaceChildren()
})

function run(seed: number, steps: number): void {
  const random = rng(seed)
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!
  const net = new Net(START, undefined, () => 1 + Math.floor(random() * 6))
  const clients: Client[] = []
  const log: string[] = []
  const add = (version: number) => {
    const c = client(net, net.authority.htmlAt(version), version, { clientId: `c${clients.length}` })
    clients.push(c)
    live.push(c)
    log.push(`new client c${clients.length - 1} at version ${version}`)
  }
  for (let i = 0; i < 3; i++) add(0)

  const position = (c: Client): [number, number] => {
    const block = Math.floor(random() * c.root.children.length)
    return [block, Math.floor(random() * (contentLength(c.root.children[block]!) + 1))]
  }

  try {
    for (let i = 0; i < steps; i++) {
      const r = random()
      const c = pick(clients)
      const name = c.collab.clientId
      if (r < 0.55) {
        const [block, offset] = position(c)
        const action = random()
        if (action < 0.35) {
          const word = pick(WORDS)
          log.push(`${name} types ${JSON.stringify(word)} at ${block}:${offset}`)
          select(c, block, offset)
          input(c, 'insertText', word)
        } else if (action < 0.5) {
          log.push(`${name} splits at ${block}:${offset}`)
          select(c, block, offset)
          input(c, 'insertParagraph')
        } else if (action < 0.62) {
          log.push(`${name} backspaces at ${block}:${offset}`)
          select(c, block, offset)
          input(c, 'deleteContentBackward')
        } else if (action < 0.75) {
          const [b2, o2] = position(c)
          const [from, to] = block < b2 || (block === b2 && offset <= o2) ? [[block, offset], [b2, o2]] : [[b2, o2], [block, offset]]
          log.push(`${name} deletes ${from} to ${to}`)
          select(c, from[0]!, from[1]!, to[0]!, to[1]!)
          input(c, 'deleteContentBackward')
        } else if (action < 0.87) {
          const [b2, o2] = position(c)
          const mark = random() < 0.5 ? 'formatBold' : 'formatItalic'
          log.push(`${name} ${mark} ${block}:${offset} to ${b2}:${o2}`)
          select(c, block, offset, b2, o2)
          input(c, mark)
        } else if (action < 0.95) {
          const tag = pick(TAGS)
          log.push(`${name} sets block ${block} to ${tag}`)
          let pos = 0
          for (let k = 0; k < block; k++) pos += contentLength(c.root.children[k]!) + 2
          c.collab.apply(new SetBlockStep(pos, tag))
        } else {
          log.push(`${name} undoes`)
          select(c, block, offset)
          input(c, random() < 0.8 ? 'historyUndo' : 'historyRedo')
        }
      } else if (r < 0.65) {
        c.collab.online = !c.collab.online
        log.push(`${name} goes ${c.collab.online ? 'online' : 'offline'}`)
      } else if (r < 0.97) {
        net.deliver(1 + Math.floor(random() * 6))
      } else if (clients.length < 6) {
        add(Math.floor(random() * (net.authority.version + 1)))
      }
    }
    settle(net, clients)
    const html = expectConverged(net, clients)
    if (process.env.SIM_PROBE) console.log(seed, 'version', net.authority.version, 'clients', clients.length, html.slice(0, 160))
  } catch (e) {
    if (process.env.SIM_PROBE) console.log((e as Error).stack)
    throw new Error(`seed ${seed} failed: ${(e as Error).message}\n${log.slice(-40).join('\n')}`, { cause: e })
  }
}

const SEEDS = Number(process.env.SIM_SEEDS ?? 60)
const FIRST = Number(process.env.SIM_SEED ?? 1)

test(`${SEEDS} randomized sessions converge to the server's document`, () => {
  const errors: string[] = []
  for (let seed = FIRST; seed < FIRST + SEEDS; seed++) {
    try {
      run(seed, 250)
    } catch (e) {
      errors.push((e as Error).message)
      if (errors.length >= 3) break
    }
    for (const c of live.splice(0)) {
      c.collab.destroy()
      c.editor.destroy()
    }
    document.body.replaceChildren()
  }
  expect(errors).toEqual([])
}, 120_000)
