/**
 * Position mapping, after ProseMirror's `StepMap` and `Mapping`. A step map
 * lists the ranges a step replaced as `(start, oldSize, newSize)` triples. A
 * position maps through it by shifting past the ranges before it; one
 * inside a replaced range moves to the range's edge and is flagged deleted.
 */

const DEL_BEFORE = 1
const DEL_AFTER = 2
const DEL_ACROSS = 4
const DEL_SIDE = 8

const FACTOR = 0x10000

export class MapResult {
  constructor(
    readonly pos: number,
    private readonly delInfo: number,
    /** Set when the position was inside a replaced range: where in it, so a mirror can recover it. */
    readonly recover: number | null,
  ) {}

  /** The position was deleted on the side `assoc` points to. */
  get deleted(): boolean {
    return (this.delInfo & DEL_SIDE) > 0
  }
  /** The token before the position was deleted. */
  get deletedBefore(): boolean {
    return (this.delInfo & (DEL_BEFORE | DEL_ACROSS)) > 0
  }
  /** The token after the position was deleted. */
  get deletedAfter(): boolean {
    return (this.delInfo & (DEL_AFTER | DEL_ACROSS)) > 0
  }
  /** The position was strictly inside a deleted range. */
  get deletedAcross(): boolean {
    return (this.delInfo & DEL_ACROSS) > 0
  }

  /** @internal */
  get info(): number {
    return this.delInfo
  }
}

export interface Mappable {
  map(pos: number, assoc?: number): number
  mapResult(pos: number, assoc?: number): MapResult
}

export class StepMap implements Mappable {
  static readonly empty = new StepMap([])

  constructor(readonly ranges: readonly number[]) {}

  /** Where a position recorded inside range `index` of this map lands. */
  recover(value: number): number {
    const index = value % FACTOR
    const offset = (value - index) / FACTOR
    let diff = 0
    for (let i = 0; i < index; i++) diff += this.ranges[i * 3 + 2]! - this.ranges[i * 3 + 1]!
    return this.ranges[index * 3]! + diff + offset
  }

  map(pos: number, assoc = 1): number {
    return this.mapResult(pos, assoc).pos
  }

  /**
   * `assoc` decides a position exactly at an insertion: -1 stays before the
   * inserted content, 1 moves after it.
   */
  mapResult(pos: number, assoc = 1): MapResult {
    let diff = 0
    for (let i = 0; i < this.ranges.length; i += 3) {
      const start = this.ranges[i]!
      if (start > pos) break
      const oldSize = this.ranges[i + 1]!
      const newSize = this.ranges[i + 2]!
      const end = start + oldSize
      if (pos <= end) {
        const side = !oldSize ? assoc : pos === start ? -1 : pos === end ? 1 : assoc
        const result = start + diff + (side < 0 ? 0 : newSize)
        const recover = pos === (assoc < 0 ? start : end) ? null : i / 3 + (pos - start) * FACTOR
        let del = pos === start ? DEL_AFTER : pos === end ? DEL_BEFORE : DEL_ACROSS
        if (assoc < 0 ? pos !== start : pos !== end) del |= DEL_SIDE
        return new MapResult(result, del, recover)
      }
      diff += newSize - oldSize
    }
    return new MapResult(pos + diff, 0, null)
  }
}

/**
 * A pipeline of step maps. A mirror pairs a step's map with the map of the
 * same change undone and redone (an inverse and its rebased step), so a
 * position inside text a client deleted and reinserted itself maps back to
 * where it was instead of collapsing to the edge.
 */
export class Mapping implements Mappable {
  constructor(
    readonly maps: StepMap[] = [],
    private mirror: number[] = [],
    readonly from = 0,
    private toIndex = -1,
  ) {}

  get to(): number {
    return this.toIndex < 0 ? this.maps.length : this.toIndex
  }

  /** A view of maps `from` to `to`, sharing the maps and mirrors. */
  slice(from = 0, to = this.maps.length): Mapping {
    return new Mapping(this.maps, this.mirror, from, to === this.maps.length && this.toIndex < 0 ? -1 : to)
  }

  appendMap(map: StepMap, mirrors?: number): void {
    this.maps.push(map)
    if (mirrors != null) this.setMirror(this.maps.length - 1, mirrors)
  }

  appendMapping(mapping: Mapping): void {
    for (let i = mapping.from, start = this.maps.length; i < mapping.to; i++) {
      const mirror = mapping.getMirror(i)
      this.appendMap(mapping.maps[i]!, mirror != null && mirror < i ? start + mirror - mapping.from : undefined)
    }
  }

  setMirror(n: number, m: number): void {
    this.mirror.push(n, m)
  }

  getMirror(n: number): number | undefined {
    for (let i = 0; i < this.mirror.length; i++) {
      if (this.mirror[i] === n) return this.mirror[i + (i % 2 ? -1 : 1)]
    }
    return undefined
  }

  map(pos: number, assoc = 1): number {
    return this.mapResult(pos, assoc).pos
  }

  mapResult(pos: number, assoc = 1): MapResult {
    let info = 0
    for (let i = this.from; i < this.to; i++) {
      const result = this.maps[i]!.mapResult(pos, assoc)
      if (result.recover != null) {
        const corr = this.getMirror(i)
        if (corr != null && corr > i && corr < this.to) {
          i = corr
          pos = this.maps[corr]!.recover(result.recover)
          continue
        }
      }
      info |= result.info
      pos = result.pos
    }
    return new MapResult(pos, info, null)
  }
}
