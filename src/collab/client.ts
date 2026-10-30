import { blocksBetween, getSelectionFor, pointToPos, posToPoint, selectPoints, type Pos } from '../dom'
import { attachHook, type EditHook, type Editor, type EditorImpl } from '../editor'
import { MERGE_MS } from '../history'
import { Cursors } from './cursors'
import { DomTarget, readTokens } from './dom'
import { Mapping, StepMap } from './mapping'
import { cut, parse, renderHTML, sliceSize, StepError, type Token } from './model'
import { PROTOCOL, schemaHash, type ClientMessage, type Presence, type ServerMessage } from './protocol'
import { IdleBuild, SizeIndex } from './sizes'
import { AddMarkStep, ModelTarget, RemoveMarkStep, ReplaceStep, Step } from './steps'
import { websocket, type Transport, type TransportConnection } from './transport'

export interface BindOptions {
  /** A WebSocket URL, or a transport (tests use an in-memory one). */
  server: string | Transport
  /** The document's id on the server. */
  doc?: string
  /** The version the editor's HTML is at. Defaults to the root's `data-version`, read when the connection opens. */
  version?: number
  /** The server's size index for the HTML's version, if the page has it. Pass a function to parse it only when needed. */
  sizes?: SizesPayload | (() => SizesPayload)
  clientId?: string
  /** Shown on this client's cursor for others. */
  name?: string
  color?: string
  /** Start connected (the default) or offline. */
  online?: boolean
  /** Check the DOM against a DOM-free replay of every step after each change, and log mismatches. Development only. */
  debug?: boolean
}

export interface SizesPayload {
  version: number
  sizes: number[]
}

export type CollabEvent =
  | { type: 'error'; reason: string; message: string }
  | { type: 'status'; status: 'offline' | 'connecting' | 'online' }
  | { type: 'sync'; version: number }

/** A step not yet confirmed by the server, with the steps that undo it. */
interface Unconfirmed {
  step: Step
  inverse: Step[]
  time: number
  /**
   * Sent at least once. The server may have accepted it even if the
   * connection dropped before saying so, so it never changes again (no
   * typing merges into it) until it's confirmed or rebased.
   */
  sent: boolean
}

/** One undo entry: steps that revert a local change, in the order to apply them, mapped to the current document. */
interface Group {
  steps: Step[]
  /** The last forward step, while typing can still join this entry. */
  last: Step | null
  time: number
}

const HISTORY_LIMIT = 200
const PRESENCE_MAPS = 1000

interface Capture {
  first: number
  count: number
  blocks: number
  tokens: Token[]
  start: number
  /** Where the edit starts in `tokens`, to place an ambiguous diff (typing "a" after "a"). */
  hint: number
  /** The command's range in `tokens`. */
  range: [number, number]
  mark?: string
}

export class Collab extends EventTarget {
  readonly clientId: string
  readonly root: HTMLElement
  private readonly editor: EditorImpl
  private readonly options: BindOptions
  private readonly transport: Transport

  private version: number | null = null
  private unconfirmed: Unconfirmed[] = []
  /** How many of `unconfirmed` are on the wire, and the version they were sent at. */
  private inflight = 0
  private sentAt = -1

  private index: SizeIndex | null = null
  private target: DomTarget | null = null
  private build: IdleBuild | null = null

  private done: Group[] = []
  private undone: Group[] = []

  private connection: TransportConnection | null = null
  private status: 'offline' | 'connecting' | 'online' = 'offline'
  private wantOnline: boolean
  private refused = false
  private retry: ReturnType<typeof setTimeout> | null = null
  private backoff = 250

  private capture: Capture | null = null
  private composing = false
  private held: ServerMessage[] = []

  /** Step maps of confirmed versions, `mapsBase` onwards, for mapping other clients' cursors. */
  private maps: StepMap[] = []
  private mapsBase = 0
  private cursors: Cursors | null = null
  private presenceFrame = 0
  private lastPresence = ''

  private shadow: ModelTarget | null = null
  private readonly onSelectionChange = () => this.queuePresence()

  constructor(editor: Editor, options: BindOptions) {
    super()
    this.options = options
    this.root = editor.root
    this.clientId = options.clientId ?? Math.random().toString(36).slice(2, 10)
    this.transport = typeof options.server === 'string' ? websocket(options.server) : options.server
    this.wantOnline = options.online ?? true
    const hook: EditHook = {
      begin: (from, to, info) => this.begin(from, to, info),
      end: () => this.end(),
      undo: () => this.undo(),
      redo: () => this.redo(),
    }
    this.editor = attachHook(editor, hook)
    this.root.ownerDocument.addEventListener('selectionchange', this.onSelectionChange)
    // Nothing reads the document now: the connection and the size index wait for the browser to be idle.
    if (!options.sizes) this.build = new IdleBuild(this.root, (index) => this.adopt(index)).start()
    if (this.wantOnline) this.retry = setTimeout(() => this.connect(), 0)
  }

  get online(): boolean {
    return this.wantOnline
  }

  /** Going offline keeps editing; the edits merge when it comes back. */
  set online(on: boolean) {
    if (on === this.wantOnline) return
    this.wantOnline = on
    if (on) {
      this.refused = false
      this.connect()
    } else {
      this.disconnect()
    }
  }

  /** The last version the server confirmed. */
  get confirmedVersion(): number {
    return this.htmlVersion()
  }

  /** Steps made here that the server hasn't confirmed yet. */
  get pending(): number {
    return this.unconfirmed.length
  }

  /** The size index, building it now if it isn't ready. */
  sizes(): number[] {
    return this.ensureIndex().index.toArray()
  }

  /** Applies a step as a local edit, for commands the editor has no key for (changing a block's tag, for one). */
  apply(step: Step): boolean {
    const { target } = this.ensureIndex()
    const sel = this.selectionPositions()
    let inverse: Step[]
    try {
      inverse = step.apply(target)
    } catch (e) {
      if (e instanceof StepError) return false
      throw e
    }
    this.local([{ step, inverse }], 'edit')
    if (sel) this.restoreSelection(sel, new Mapping([step.getMap()]))
    return true
  }

  destroy(): void {
    this.disconnect()
    this.build?.cancel()
    this.cursors?.destroy()
    this.root.ownerDocument.removeEventListener('selectionchange', this.onSelectionChange)
    if (this.editor.hook) attachHook(this.editor, null)
  }

  /** Debug check: the DOM equals a DOM-free replay of every step. True without debug. */
  check(): boolean {
    if (!this.shadow) return true
    const expected = renderHTML(this.shadow.doc.content, this.editor.schema)
    const actual = Array.from(this.root.children, (b) => b.outerHTML).join('')
    if (expected === actual) return true
    console.error('wysiwyg: the DOM diverged from its steps', { expected, actual })
    return false
  }

  private emit(event: CollabEvent): void {
    this.dispatchEvent(Object.assign(new Event(event.type), { detail: event }))
  }

  private setStatus(status: Collab['status']): void {
    if (status === this.status) return
    this.status = status
    this.emit({ type: 'status', status })
  }

  // ---- the size index ----

  private htmlVersion(): number {
    if (this.version == null) {
      const attr = this.root.getAttribute('data-version')
      this.version = this.options.version ?? (attr ? Number(attr) : 0)
    }
    return this.version
  }

  private adopt(index: SizeIndex): void {
    if (this.index) return
    this.build?.cancel()
    this.build = null
    this.index = index
    this.target = new DomTarget(this.root, this.editor.schema, index)
    if (this.options.debug) this.shadow = new ModelTarget({ kind: 'node', tag: 'doc', attrs: {}, content: parse(readTokens([...this.root.children], this.editor.schema)) }, this.editor.schema)
  }

  /** Every edit path calls this first, so the document can't change under an unfinished build. */
  private ensureIndex(): { index: SizeIndex; target: DomTarget } {
    if (!this.index) {
      const given = typeof this.options.sizes === 'function' ? this.options.sizes() : this.options.sizes
      if (given && given.version === this.htmlVersion() && given.sizes.length === this.root.childElementCount) this.adopt(new SizeIndex(given.sizes.slice()))
      else this.adopt((this.build ?? new IdleBuild(this.root)).finish())
    }
    return { index: this.index!, target: this.target! }
  }

  private indexOf(block: Element): number {
    let i = 0
    for (let b = block.previousElementSibling; b; b = b.previousElementSibling) i++
    return i
  }

  private toInt(pos: Pos): number {
    return this.index!.start(this.indexOf(pos.block)) + 1 + pos.offset
  }

  private toPos(n: number): Pos | null {
    const index = this.index!
    if (!index.count) return null
    const i = Math.min(index.find(n), index.count - 1)
    const block = this.root.children[i]
    if (!block) return null
    const offset = Math.max(0, Math.min(n - index.start(i) - 1, index.size(i) - 2))
    return { block, offset }
  }

  // ---- local edits ----

  private begin(from: Pos, to: Pos, info?: { mark?: string; composing?: boolean }): void {
    const { index } = this.ensureIndex()
    if (info?.composing) this.composing = true
    const first = this.indexOf(from.block)
    const blocks = blocksBetween(from.block, to.block)
    const start = index.start(first)
    this.capture = {
      first,
      count: this.root.childElementCount,
      blocks: blocks.length,
      tokens: readTokens(blocks, this.editor.schema),
      start,
      hint: 1 + from.offset,
      range: [1 + from.offset, index.start(first + blocks.length - 1) - start + 1 + to.offset],
      mark: info?.mark,
    }
  }

  private end(): void {
    const cap = this.capture
    this.capture = null
    const wasComposing = this.composing
    this.composing = false
    if (cap) {
      const changed = this.root.childElementCount - cap.count
      const blocks: Element[] = []
      for (let b = this.root.children[cap.first] ?? null; b && blocks.length < cap.blocks + changed; b = b.nextElementSibling) blocks.push(b)
      const tokens = readTokens(blocks, this.editor.schema)
      const steps = cap.mark ? markSteps(cap) : diffSteps(cap, tokens)
      if (!cap.mark) this.index!.splice(cap.first, cap.blocks, topSizes(tokens))
      if (steps.length) this.local(steps, 'edit')
    }
    if (wasComposing && this.held.length) {
      const held = this.held.splice(0)
      for (const message of held) this.receive(message)
    }
  }

  /**
   * Records local steps already applied to the DOM: they join the
   * unconfirmed list (typing merges into the last unsent step), and undo
   * history is mapped through them.
   */
  private local(steps: { step: Step; inverse: Step[] }[], kind: 'edit' | 'undo' | 'redo'): void {
    const now = Date.now()
    const maps = new Mapping(steps.map((s) => s.step.getMap()))
    const inverse = steps.flatMap((s) => s.inverse).reverse()

    // Undo history.
    const typing = kind === 'edit' && steps.length === 1 ? steps[0]!.step : null
    const last = this.done.at(-1)
    const joins = !!typing && !!last?.last && now - last.time < MERGE_MS && last.last instanceof ReplaceStep && !!last.last.merge(typing)
    if (kind === 'edit') this.undone = []
    const own = kind === 'undo' ? this.undone : this.done
    for (const group of this.done) if (!(joins && group === last)) mapGroup(group, maps)
    for (const group of this.undone) mapGroup(group, maps)
    if (joins) {
      last!.steps = [...inverse, ...last!.steps]
      last!.last = (last!.last as ReplaceStep).merge(typing!)
      last!.time = now
    } else {
      own.push({ steps: inverse, last: kind === 'edit' ? typing : null, time: now })
      if (own.length > HISTORY_LIMIT) own.shift()
    }

    // Unconfirmed steps.
    for (const { step, inverse } of steps) {
      const prev = this.unconfirmed.at(-1)
      const merged =
        prev && !prev.sent && now - prev.time < MERGE_MS && prev.step instanceof ReplaceStep && prev.inverse.length === 1
          ? prev.step.merge(step)
          : null
      if (merged) {
        prev!.step = merged
        prev!.inverse = [new ReplaceStep(merged.from, merged.from + sliceSize(merged.slice), (prev!.inverse[0] as ReplaceStep).slice)]
        prev!.time = now
      } else {
        this.unconfirmed.push({ step, inverse, time: now, sent: false })
      }
      this.shadowApply(step)
    }
    this.check()
    this.cursors?.redraw()
    this.queuePresence()
    this.send()
  }

  private undo(): void {
    this.revert(this.done, 'undo')
  }

  private redo(): void {
    this.revert(this.undone, 'redo')
  }

  /** Applies an undo entry's mapped steps as new local steps, so it reverts only this client's change, where it is now. */
  private revert(stack: Group[], kind: 'undo' | 'redo'): void {
    const group = stack.pop()
    if (!group) return
    const { target } = this.ensureIndex()
    const applied: { step: Step; inverse: Step[] }[] = []
    let caret: number | null = null
    for (const step of group.steps) {
      try {
        applied.push({ step, inverse: step.apply(target) })
        if (step instanceof ReplaceStep) caret = step.from + sliceSize(step.slice)
        else if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) caret = step.to
      } catch (e) {
        if (!(e instanceof StepError)) throw e
      }
    }
    if (!applied.length) return
    this.local(applied, kind)
    const pos = caret == null ? null : this.toPos(caret)
    if (pos && this.selectionInside()) this.editor.place(pos)
  }

  // ---- the connection ----

  private connect(): void {
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    if (!this.wantOnline || this.connection || this.refused) return
    this.setStatus('connecting')
    const connection = this.transport.connect({
      open: () => {
        const sizes = !this.index && !this.options.sizes
        this.post({ v: PROTOCOL, type: 'hello', doc: this.options.doc ?? 'default', clientId: this.clientId, schemaHash: schemaHash(this.editor.schema), version: this.htmlVersion(), wantSizes: sizes })
      },
      message: (message) => {
        if (this.connection === connection) this.receive(message)
      },
      close: () => {
        if (this.connection !== connection) return
        this.connection = null
        this.inflight = 0
        this.sentAt = -1
        this.setStatus('offline')
        if (this.wantOnline && !this.refused) {
          this.retry = setTimeout(() => this.connect(), this.backoff)
          this.backoff = Math.min(this.backoff * 2, 5000)
        }
      },
    })
    this.connection = connection
  }

  private disconnect(): void {
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    const connection = this.connection
    this.connection = null
    this.inflight = 0
    this.sentAt = -1
    connection?.close()
    this.setStatus('offline')
  }

  private post(message: ClientMessage): void {
    this.connection?.send(message)
  }

  private send(): void {
    if (this.status !== 'online' || this.inflight || this.composing || !this.unconfirmed.length) return
    this.inflight = this.unconfirmed.length
    this.sentAt = this.htmlVersion()
    for (const u of this.unconfirmed) u.sent = true
    this.post({ v: PROTOCOL, type: 'steps', version: this.sentAt, steps: this.unconfirmed.map((u) => u.step.toJSON()), clientId: this.clientId })
  }

  private receive(message: ServerMessage): void {
    if (this.composing && message.type === 'steps') {
      this.held.push(message)
      return
    }
    switch (message.type) {
      case 'welcome':
        this.backoff = 250
        if (message.sizes && !this.index && message.sizes.version === this.htmlVersion() && message.sizes.sizes.length === this.root.childElementCount) {
          this.adopt(new SizeIndex(message.sizes.sizes.slice()))
        }
        this.setStatus('online')
        return
      case 'refused':
        this.refused = true
        this.emit({ type: 'error', reason: message.reason, message: message.message })
        this.disconnect()
        return
      case 'steps':
        this.receiveSteps(message.version, message.steps.map((s) => Step.fromJSON(s)), message.clientIds)
        return
      case 'rejected':
        if (message.version !== this.sentAt) return
        this.inflight = 0
        this.sentAt = -1
        if (message.reason === 'invalid') {
          this.emit({ type: 'error', reason: 'invalid', message: message.message })
          this.dropUnconfirmed()
        }
        this.send()
        return
      case 'presence':
        if (message.clientId !== this.clientId) {
          this.cursors ??= new Cursors(this.root)
          const { v: _, type: __, ...presence } = message
          this.cursors.set(presence, (p) => this.resolvePresence(p))
        }
        return
      case 'leave':
        this.cursors?.remove(message.clientId)
        return
      case 'gone':
        this.emit({ type: 'error', reason: 'gone', message: 'the server no longer has this version' })
        this.disconnect()
        return
    }
  }

  /** The server refused our steps as invalid: take them back out of the document. */
  private dropUnconfirmed(): void {
    const { target } = this.ensureIndex()
    for (const u of this.unconfirmed.reverse()) {
      for (const inv of u.inverse) {
        inv.apply(target)
        this.shadowApply(inv)
      }
    }
    this.unconfirmed = []
    this.done = []
    this.undone = []
  }

  /**
   * Steps from the server, starting at `version`. Leading steps with our
   * client id confirm our in-flight steps. Others are applied by rebasing:
   * revert unconfirmed steps, apply the remote ones, then map each
   * unconfirmed step through them and reapply it.
   */
  private receiveSteps(version: number, steps: Step[], clientIds: string[]): void {
    const current = this.htmlVersion()
    if (version > current) return
    const skip = current - version
    steps = steps.slice(skip)
    clientIds = clientIds.slice(skip)
    if (!steps.length) {
      this.send()
      return
    }

    let ours = 0
    // Our steps can only be confirmed while sent, and the server puts an accepted batch right at the version it was sent at.
    while (ours < clientIds.length && this.unconfirmed[ours]?.sent && clientIds[ours] === this.clientId) ours++
    for (const step of steps) this.maps.push(step.getMap())
    if (this.maps.length > PRESENCE_MAPS) {
      this.mapsBase += this.maps.length - PRESENCE_MAPS
      this.maps.splice(0, this.maps.length - PRESENCE_MAPS)
    }
    this.version = current + steps.length
    if (ours) {
      this.unconfirmed.splice(0, ours)
      this.inflight = 0
      this.sentAt = -1
    }
    const remote = steps.slice(ours)
    if (remote.length) this.rebase(remote)
    this.emit({ type: 'sync', version: this.version })
    this.cursors?.redraw()
    this.send()
  }

  private rebase(remote: Step[]): void {
    const { target } = this.ensureIndex()
    const sel = this.selectionPositions()
    const pending = this.editor.pending
    const pendingAt = pending ? this.toInt(pending) : null
    // Anything in flight was sent at an old version and will be rejected; it's resent rebased.
    this.inflight = 0
    this.sentAt = -1

    const mapping = new Mapping()
    const unconfirmed = this.unconfirmed
    const after: number[] = []
    const mirror: (number | null)[] = []
    for (let i = unconfirmed.length - 1; i >= 0; i--) {
      const u = unconfirmed[i]!
      mirror[i] = u.inverse.length === 1 && u.step instanceof ReplaceStep ? mapping.maps.length : null
      for (const inv of u.inverse) {
        inv.apply(target)
        this.shadowApply(inv)
        mapping.appendMap(inv.getMap())
      }
      after[i] = mapping.maps.length
    }
    for (const step of remote) {
      try {
        step.apply(target)
      } catch (e) {
        if (!(e instanceof StepError)) throw e
        this.emit({ type: 'error', reason: 'diverged', message: `a confirmed step didn't apply: ${e.message}` })
        throw e
      }
      this.shadowApply(step)
      mapping.appendMap(step.getMap())
    }
    const rebased: Unconfirmed[] = []
    for (let i = 0; i < unconfirmed.length; i++) {
      const u = unconfirmed[i]!
      const mapped = u.step.map(mapping.slice(after[i]))
      if (!mapped) continue
      let inverse: Step[]
      try {
        inverse = mapped.apply(target)
      } catch (e) {
        if (!(e instanceof StepError)) throw e
        continue
      }
      this.shadowApply(mapped)
      mapping.appendMap(mapped.getMap(), mirror[i] ?? undefined)
      rebased.push({ step: mapped, inverse, time: 0, sent: false })
    }
    this.unconfirmed = rebased

    for (const group of this.done) {
      mapGroup(group, mapping)
      group.last = null
    }
    for (const group of this.undone) mapGroup(group, mapping)
    if (sel) this.restoreSelection(sel, mapping)
    if (pending && pendingAt != null) {
      const pos = this.toPos(mapping.map(pendingAt, -1))
      this.editor.pending = pos ? { ...pos, marks: pending.marks } : null
    }
    this.check()
  }

  // ---- selection ----

  private selectionInside(): boolean {
    const sel = getSelectionFor(this.root)
    return !!sel?.anchorNode && this.root.contains(sel.anchorNode) && !!sel.focusNode && this.root.contains(sel.focusNode)
  }

  private selectionPositions(): { anchor: number; head: number } | null {
    if (!this.index || !this.selectionInside()) return null
    const sel = getSelectionFor(this.root)!
    const a = pointToPos(this.root, sel.anchorNode!, sel.anchorOffset)
    const h = pointToPos(this.root, sel.focusNode!, sel.focusOffset)
    return a && h ? { anchor: this.toInt(a), head: this.toInt(h) } : null
  }

  private restoreSelection(sel: { anchor: number; head: number }, mapping: Mapping): void {
    const a = this.toPos(mapping.map(sel.anchor))
    const h = this.toPos(mapping.map(sel.head))
    if (a && h) selectPoints(this.root, posToPoint(a), posToPoint(h))
  }

  // ---- presence ----

  private queuePresence(): void {
    if (this.presenceFrame || this.status !== 'online') return
    const raf = globalThis.requestAnimationFrame ?? ((cb: () => void) => setTimeout(cb, 16))
    this.presenceFrame = raf(() => {
      this.presenceFrame = 0
      this.sendPresence()
    }) as number
  }

  private sendPresence(): void {
    if (this.status !== 'online' || !this.selectionInside()) return
    this.ensureIndex()
    const sel = this.selectionPositions()
    if (!sel) return
    // Back to the confirmed version, through the inverses of the unconfirmed steps.
    const back = new Mapping()
    for (let i = this.unconfirmed.length - 1; i >= 0; i--) for (const inv of this.unconfirmed[i]!.inverse) back.appendMap(inv.getMap())
    const presence: Presence = {
      clientId: this.clientId,
      name: this.options.name ?? 'Anonymous',
      color: this.options.color ?? '#7c4dff',
      version: this.htmlVersion(),
      anchor: back.map(sel.anchor, -1),
      head: back.map(sel.head, -1),
    }
    const key = JSON.stringify(presence)
    if (key === this.lastPresence) return
    this.lastPresence = key
    this.post({ v: PROTOCOL, type: 'presence', ...presence })
  }

  /** Other clients' cursors, mapped to this document. The overlay draws these. */
  remoteCursors(): (Presence & { from: Pos; to: Pos })[] {
    return (this.cursors?.list() ?? []).flatMap((p) => {
      const at = this.resolvePresence(p)
      return at ? [{ ...p, from: at.anchor, to: at.head }] : []
    })
  }

  /** A remote cursor at its version, mapped to the document as it is here. Null until we've caught up to it. */
  private resolvePresence(p: Presence): { anchor: Pos; head: Pos } | null {
    this.ensureIndex()
    const current = this.htmlVersion()
    if (p.version > current || p.version < this.mapsBase) return null
    const mapping = new Mapping(this.maps.slice(p.version - this.mapsBase))
    for (const u of this.unconfirmed) mapping.appendMap(u.step.getMap())
    const anchor = this.toPos(mapping.map(p.anchor, -1))
    const head = this.toPos(mapping.map(p.head, -1))
    return anchor && head ? { anchor, head } : null
  }

  // ---- debug ----

  private shadowApply(step: Step): void {
    if (!this.shadow) return
    try {
      step.apply(this.shadow)
    } catch (e) {
      console.error('wysiwyg: a step applied to the DOM failed on the model', step.toJSON(), e)
    }
  }
}

/** Maps an undo entry's steps to the document after `mapping`, dropping steps whose target is gone. */
function mapGroup(group: Group, mapping: Mapping): void {
  // The steps run in sequence, so each is mapped through the ones before it undone, the change, and them redone.
  const steps = group.steps
  const m = new Mapping()
  const back: number[] = []
  for (let i = steps.length - 1; i >= 0; i--) {
    back[i] = m.maps.length
    m.appendMap(invertMap(steps[i]!.getMap()))
  }
  m.appendMapping(mapping)
  const out: Step[] = []
  for (let i = 0; i < steps.length; i++) {
    const mapped = steps[i]!.map(m.slice(back[i]! + 1))
    if (mapped) {
      m.appendMap(mapped.getMap(), back[i])
      out.push(mapped)
    } else {
      m.appendMap(StepMap.empty)
    }
  }
  group.steps = out
}

function invertMap(map: StepMap): StepMap {
  const r = map.ranges
  const out: number[] = []
  let diff = 0
  for (let i = 0; i < r.length; i += 3) {
    out.push(r[i]! + diff, r[i + 2]!, r[i + 1]!)
    diff += r[i + 2]! - r[i + 1]!
  }
  return new StepMap(out)
}

/** A comparable key for each position-unit of a token list. */
function units(tokens: readonly Token[]): string[] {
  const out: string[] = []
  for (const t of tokens) {
    if (t.kind === 'text') {
      const marks = t.marks.slice().sort().join(',')
      for (const ch of t.text.split('')) out.push(`t${marks}|${ch}`)
    } else if (t.kind === 'open') {
      out.push(`o${t.tag}${t.attrs ? JSON.stringify(t.attrs) : ''}`)
    } else {
      out.push(t.kind)
    }
  }
  return out
}

/** The size of each top-level node in a token list. */
function topSizes(tokens: readonly Token[]): number[] {
  const out: number[] = []
  let depth = 0
  for (const t of tokens) {
    if (depth === 0) out.push(0)
    out[out.length - 1]! += t.kind === 'text' ? t.text.length : 1
    if (t.kind === 'open') depth++
    else if (t.kind === 'close') depth--
  }
  return out
}

/**
 * The replace step that turns the captured blocks into what the command
 * left: the tokens between the common prefix and suffix. An ambiguous diff
 * (typing "a" next to "a") is placed at the caret.
 */
function diffSteps(cap: Capture, next: Token[]): { step: Step; inverse: Step[] }[] {
  const a = units(cap.tokens)
  const b = units(next)
  const min = Math.min(a.length, b.length)
  let prefix = 0
  while (prefix < min && a[prefix] === b[prefix]) prefix++
  if (prefix === a.length && a.length === b.length) return []
  let suffix = 0
  while (suffix < min && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++
  let p = prefix
  if (prefix + suffix > min) {
    const slack = prefix + suffix - min
    p = Math.max(prefix - slack, Math.min(prefix, cap.hint))
  }
  const s = Math.min(suffix, min - p)
  const from = cap.start + p
  const removed = cut(cap.tokens, p, a.length - s)
  const inserted = cut(next, p, b.length - s)
  return [{ step: new ReplaceStep(from, cap.start + a.length - s, inserted), inverse: [new ReplaceStep(from, from + sliceSize(inserted), removed)] }]
}

/**
 * Mark steps for a toggle, from the content before it: one step per run of
 * text that changes, so each inverts exactly. The rule matches `toggleMark`:
 * if all the text in range has the mark it's removed, otherwise added.
 */
function markSteps(cap: Capture): { step: Step; inverse: Step[] }[] {
  const mark = cap.mark!
  const [lo, hi] = cap.range
  const texts: [number, number, boolean][] = []
  let pos = 0
  for (const t of cap.tokens) {
    const size = t.kind === 'text' ? t.text.length : 1
    if (t.kind === 'text' && pos + size > lo && pos < hi) texts.push([Math.max(pos, lo), Math.min(pos + size, hi), t.marks.includes(mark)])
    pos += size
  }
  if (!texts.length) return []
  const add = !texts.every(([, , has]) => has)
  const out: { step: Step; inverse: Step[] }[] = []
  let run: [number, number] | null = null
  const flush = () => {
    if (!run) return
    const a = cap.start + run[0]
    const b = cap.start + run[1]
    out.push(add ? { step: new AddMarkStep(a, b, mark), inverse: [new RemoveMarkStep(a, b, mark)] } : { step: new RemoveMarkStep(a, b, mark), inverse: [new AddMarkStep(a, b, mark)] })
    run = null
  }
  // A run stretches over breaks between text that changes, and stops at text that doesn't.
  for (const [a, b, has] of texts) {
    if (has === add) flush()
    else if (run) run[1] = b
    else run = [a, b]
  }
  flush()
  return out
}

export function bind(editor: Editor, options: BindOptions): Collab {
  return new Collab(editor, options)
}

