import { contentLength } from '../dom'

/**
 * The size of every top-level node, so a DOM caret converts to a flat
 * position without reading the blocks before it. A Fenwick tree keeps
 * prefix sums and single updates at O(log n). Inserting or removing blocks
 * rebuilds it, which is O(n) arithmetic and no DOM reads.
 */
export class SizeIndex {
  private tree: number[] = []

  constructor(private sizes: number[]) {
    this.rebuild()
  }

  get count(): number {
    return this.sizes.length
  }

  get total(): number {
    return this.start(this.sizes.length)
  }

  toArray(): number[] {
    return this.sizes.slice()
  }

  size(i: number): number {
    return this.sizes[i]!
  }

  /** The position of node `i`'s open token: the sum of the sizes before it. */
  start(i: number): number {
    let sum = 0
    for (let k = i; k > 0; k -= k & -k) sum += this.tree[k]!
    return sum
  }

  /** The node `pos` falls in: `start(i) <= pos < start(i + 1)`. `count` at or past the end. */
  find(pos: number): number {
    let i = 0
    let rest = pos
    let step = 1
    while (step * 2 <= this.sizes.length) step *= 2
    for (; step > 0; step >>= 1) {
      const next = i + step
      if (next <= this.sizes.length && this.tree[next]! <= rest) {
        i = next
        rest -= this.tree[next]!
      }
    }
    return i
  }

  set(i: number, size: number): void {
    const diff = size - this.sizes[i]!
    if (!diff) return
    this.sizes[i] = size
    for (let k = i + 1; k <= this.sizes.length; k += k & -k) this.tree[k]! += diff
  }

  /** Replaces `deleteCount` sizes at `i` with `sizes`. Same count updates in place. */
  splice(i: number, deleteCount: number, sizes: readonly number[]): void {
    if (deleteCount === sizes.length) {
      sizes.forEach((size, k) => this.set(i + k, size))
      return
    }
    this.sizes.splice(i, deleteCount, ...sizes)
    this.rebuild()
  }

  private rebuild(): void {
    const n = this.sizes.length
    const tree = new Array<number>(n + 1).fill(0)
    for (let k = 1; k <= n; k++) {
      tree[k]! += this.sizes[k - 1]!
      const parent = k + (k & -k)
      if (parent <= n) tree[parent]! += tree[k]!
    }
    this.tree = tree
  }
}

/** A block's size: its content plus its open and close tokens. */
export function blockSize(block: Element): number {
  return contentLength(block) + 2
}

type Idle = (cb: (deadline: { timeRemaining(): number }) => void) => number

/**
 * Measures every block in idle time, a slice at a time, when nothing else
 * supplies the sizes. A Worker can't read the DOM, so it runs on the main
 * thread and yields between slices. `finish()` measures what's left at once,
 * for an edit that can't wait.
 */
export class IdleBuild {
  private readonly sizes: number[] = []
  private next: Element | null
  private handle: number | ReturnType<typeof setTimeout> | null = null
  private result: SizeIndex | null = null
  /** Slices run so far and the longest one, for the performance check. */
  readonly stats = { slices: 0, longest: 0 }

  constructor(
    root: Element,
    private readonly onDone: (index: SizeIndex) => void = () => {},
    private readonly sliceMs = 8,
  ) {
    this.next = root.firstElementChild
  }

  get done(): boolean {
    return !!this.result
  }

  start(): this {
    this.schedule()
    return this
  }

  cancel(): void {
    if (this.handle == null) return
    const g = globalThis as { cancelIdleCallback?: (h: number) => void }
    if (g.cancelIdleCallback) g.cancelIdleCallback(this.handle as number)
    else clearTimeout(this.handle as ReturnType<typeof setTimeout>)
    this.handle = null
  }

  finish(): SizeIndex {
    this.cancel()
    while (this.next) this.measure()
    return this.complete()
  }

  private schedule(): void {
    const idle = (globalThis as { requestIdleCallback?: Idle }).requestIdleCallback
    // WebKit has no requestIdleCallback, so it gets a timer and a fixed budget.
    this.handle = idle
      ? idle((deadline) => this.slice(() => deadline.timeRemaining() > 1))
      : setTimeout(() => {
          const end = performance.now() + this.sliceMs
          this.slice(() => performance.now() < end)
        }, 1)
  }

  private slice(more: () => boolean): void {
    this.handle = null
    const start = performance.now()
    do {
      for (let i = 0; i < 64 && this.next; i++) this.measure()
    } while (this.next && more())
    this.stats.slices++
    this.stats.longest = Math.max(this.stats.longest, performance.now() - start)
    if (this.next) this.schedule()
    else this.complete()
  }

  private measure(): void {
    this.sizes.push(blockSize(this.next!))
    this.next = this.next!.nextElementSibling
  }

  private complete(): SizeIndex {
    if (!this.result) {
      this.result = new SizeIndex(this.sizes)
      this.onDone(this.result)
    }
    return this.result
  }
}
