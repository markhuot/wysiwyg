import type { Schema } from '../schema'
import { StepMap, type Mappable } from './mapping'
import {
  checkNodes,
  checkTag,
  contentSize,
  elementAt,
  element,
  markContent,
  replaceContent,
  sliceSize,
  StepError,
  updateAt,
  type Attrs,
  type ElementNode,
  type Token,
} from './model'

/**
 * What a step applies to: the DOM-free model (`ModelTarget`) or the live DOM
 * (the binding's `DomTarget`). Each method checks the result against the
 * schema and throws `StepError` without changing anything if it fails.
 */
export interface Target {
  /** Replaces `from`–`to` with `slice` and returns what it removed. */
  replace(from: number, to: number, slice: readonly Token[]): Token[]
  /** Adds or removes a mark on the text in range. Returns the ranges whose text changed. */
  mark(from: number, to: number, mark: string, add: boolean): [number, number][]
  /** Sets the tag and attributes of the element whose open token is at `pos`, and returns the old ones. */
  setBlock(pos: number, tag: string, attrs: Attrs): { tag: string; attrs: Attrs }
}

export type StepJSON =
  | { stepType: 'replace'; from: number; to: number; slice: Token[] }
  | { stepType: 'addMark' | 'removeMark'; from: number; to: number; mark: string }
  | { stepType: 'setBlock'; pos: number; tag: string; attrs?: Attrs }

/**
 * One of ProseMirror's three primitive edits. Applying a step returns the
 * steps that undo it, in the order to apply them.
 */
export abstract class Step {
  abstract apply(target: Target): Step[]
  abstract getMap(): StepMap
  /** The step moved through `mapping`, or null when what it changes was deleted. */
  abstract map(mapping: Mappable): Step | null
  abstract toJSON(): StepJSON

  static fromJSON(json: StepJSON): Step {
    switch (json?.stepType) {
      case 'replace':
        return new ReplaceStep(int(json.from), int(json.to), tokens(json.slice))
      case 'addMark':
        return new AddMarkStep(int(json.from), int(json.to), str(json.mark))
      case 'removeMark':
        return new RemoveMarkStep(int(json.from), int(json.to), str(json.mark))
      case 'setBlock':
        return new SetBlockStep(int(json.pos), str(json.tag), attrs(json.attrs))
    }
    throw new StepError(`unknown step ${JSON.stringify(json)}`)
  }
}

/**
 * Replaces a range with a slice. Typing, paste, delete, split (an empty range
 * replaced with a close and an open) and join (the close and open between
 * two blocks replaced with nothing) are all this step.
 */
export class ReplaceStep extends Step {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly slice: readonly Token[],
  ) {
    super()
  }

  apply(target: Target): Step[] {
    const removed = target.replace(this.from, this.to, this.slice)
    return [new ReplaceStep(this.from, this.from + sliceSize(this.slice), removed)]
  }

  getMap(): StepMap {
    return new StepMap([this.from, this.to - this.from, sliceSize(this.slice)])
  }

  map(mapping: Mappable): Step | null {
    const from = mapping.mapResult(this.from, 1)
    const to = mapping.mapResult(this.to, -1)
    if (from.deletedAcross && to.deletedAcross) return null
    return new ReplaceStep(from.pos, Math.max(from.pos, to.pos), this.slice)
  }

  /**
   * Joins `next` onto this step when it continues it: typing right after
   * inserted text, or deleting back into it. Null when it doesn't.
   */
  merge(next: Step): ReplaceStep | null {
    if (!(next instanceof ReplaceStep)) return null
    const inline = (s: readonly Token[]) => s.every((t) => t.kind === 'text' || t.kind === 'br')
    if (!inline(this.slice) || !inline(next.slice)) return null
    const end = this.from + sliceSize(this.slice)
    if (next.from === end && next.to === end) return new ReplaceStep(this.from, this.to, [...this.slice, ...next.slice])
    if (!next.slice.length && next.to === end && next.from >= this.from) {
      return new ReplaceStep(this.from, this.to, cutTokens(this.slice, next.from - this.from))
    }
    return null
  }

  toJSON(): StepJSON {
    return { stepType: 'replace', from: this.from, to: this.to, slice: this.slice.slice() }
  }
}

function cutTokens(slice: readonly Token[], size: number): Token[] {
  const out: Token[] = []
  let n = 0
  for (const t of slice) {
    if (n >= size) break
    if (t.kind === 'text') {
      const text = t.text.slice(0, size - n)
      out.push({ ...t, text })
      n += text.length
    } else {
      out.push(t)
      n++
    }
  }
  return out
}

abstract class MarkStep extends Step {
  protected abstract readonly add: boolean

  constructor(
    readonly from: number,
    readonly to: number,
    readonly mark: string,
  ) {
    super()
  }

  apply(target: Target): Step[] {
    const changed = target.mark(this.from, this.to, this.mark, this.add)
    const Inverse = this.add ? RemoveMarkStep : AddMarkStep
    return changed.map(([a, b]) => new Inverse(a, b, this.mark))
  }

  getMap(): StepMap {
    return StepMap.empty
  }

  map(mapping: Mappable): Step | null {
    const from = mapping.mapResult(this.from, 1)
    const to = mapping.mapResult(this.to, -1)
    if ((from.deleted && to.deleted) || from.pos >= to.pos) return null
    return new (this.constructor as new (from: number, to: number, mark: string) => MarkStep)(from.pos, to.pos, this.mark)
  }

  toJSON(): StepJSON {
    return { stepType: this.add ? 'addMark' : 'removeMark', from: this.from, to: this.to, mark: this.mark }
  }
}

export class AddMarkStep extends MarkStep {
  protected readonly add = true
}

export class RemoveMarkStep extends MarkStep {
  protected readonly add = false
}

/** Changes the tag and attributes of the block whose open token is at `pos`. Later, a list item's path is an attribute. */
export class SetBlockStep extends Step {
  constructor(
    readonly pos: number,
    readonly tag: string,
    readonly attrs: Attrs = {},
  ) {
    super()
  }

  apply(target: Target): Step[] {
    const old = target.setBlock(this.pos, this.tag, this.attrs)
    return [new SetBlockStep(this.pos, old.tag, old.attrs)]
  }

  getMap(): StepMap {
    return StepMap.empty
  }

  map(mapping: Mappable): Step | null {
    const pos = mapping.mapResult(this.pos, 1)
    return pos.deletedAfter ? null : new SetBlockStep(pos.pos, this.tag, this.attrs)
  }

  toJSON(): StepJSON {
    return Object.keys(this.attrs).length
      ? { stepType: 'setBlock', pos: this.pos, tag: this.tag, attrs: this.attrs }
      : { stepType: 'setBlock', pos: this.pos, tag: this.tag }
  }
}

// ---- input checks for steps off the wire ----

function int(n: unknown): number {
  if (!Number.isSafeInteger(n) || (n as number) < 0) throw new StepError(`bad position ${n}`)
  return n as number
}

function str(s: unknown): string {
  if (typeof s !== 'string' || !s) throw new StepError(`bad name ${s}`)
  return s
}

function attrs(a: unknown): Attrs {
  if (a == null) return {}
  if (typeof a !== 'object' || Array.isArray(a)) throw new StepError('bad attributes')
  for (const v of Object.values(a)) if (typeof v !== 'string') throw new StepError('bad attribute value')
  return a as Attrs
}

function tokens(slice: unknown): Token[] {
  if (!Array.isArray(slice)) throw new StepError('bad slice')
  return slice.map((t: Record<string, unknown>): Token => {
    switch (t?.kind) {
      case 'text':
        if (typeof t.text !== 'string' || !Array.isArray(t.marks) || !t.marks.every((m) => typeof m === 'string')) break
        return { kind: 'text', text: t.text, marks: t.marks as string[] }
      case 'br':
        return { kind: 'br' }
      case 'close':
        return { kind: 'close' }
      case 'open':
        return t.attrs == null ? { kind: 'open', tag: str(t.tag) } : { kind: 'open', tag: str(t.tag), attrs: attrs(t.attrs) }
    }
    throw new StepError(`bad token ${JSON.stringify(t)}`)
  })
}

/**
 * Applies steps to the DOM-free document. The server keeps one at its head
 * version, tests compare it with the live DOM, and debug mode checks the DOM
 * against it.
 */
export class ModelTarget implements Target {
  constructor(
    public doc: ElementNode,
    readonly schema: Schema,
  ) {}

  get size(): number {
    return contentSize(this.doc.content)
  }

  replace(from: number, to: number, slice: readonly Token[]): Token[] {
    const { content, removed } = replaceContent(this.doc.content, from, to, slice, (nodes, parent) =>
      checkNodes(nodes, parent, this.schema),
    )
    if (!content.length) throw new StepError('the document needs at least one block')
    this.doc = element('doc', content)
    return removed
  }

  mark(from: number, to: number, mark: string, add: boolean): [number, number][] {
    if (!this.schema.marks.includes(mark)) throw new StepError(`<${mark}> is not an allowed mark`)
    if (from < 0 || to > this.size || from > to) throw new StepError(`range ${from}–${to} is outside the document`)
    const changed: [number, number][] = []
    this.doc = element('doc', markContent(this.doc.content, from, to, mark, add, this.schema, 0, changed))
    return changed
  }

  setBlock(pos: number, tag: string, attrs: Attrs): { tag: string; attrs: Attrs } {
    const found = elementAt(this.doc.content, pos)
    if (!found) throw new StepError(`no block starts at ${pos}`)
    checkTag(tag, found.path.length === 1 ? 'doc' : 'container', this.schema)
    this.doc = element('doc', updateAt(this.doc.content, found.path, (old) => element(tag, old.content, attrs)))
    return { tag: found.node.tag, attrs: found.node.attrs }
  }
}
