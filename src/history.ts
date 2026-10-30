import { decodePoint, encodePoint, getSelectionFor, selectPoints, type EncodedPoint } from './dom'

interface Snapshot {
  html: string
  anchor: EncodedPoint | null
  focus: EncodedPoint | null
}

/** Typing within this many milliseconds of the last keystroke joins the same undo entry. */
export const MERGE_MS = 1000

/**
 * One editor's undo and redo stacks. Nothing is read until the first
 * `record()`, so creating a History costs nothing.
 */
export class History {
  private done: Snapshot[] = []
  private undone: Snapshot[] = []
  /** The snapshot before the first change: the starting HTML. Kept apart so the limit never evicts it. */
  private first: Snapshot | undefined
  private typingKey: string | undefined
  private typingTime = 0

  constructor(
    private readonly root: Element,
    private readonly limit = 500,
  ) {}

  /**
   * Call before each change. Pass `typingKey` (the encoded caret) for typing:
   * if it matches where the last typing left the caret, and the typing hasn't
   * paused, the change joins the previous entry.
   */
  record(typingKey?: string): void {
    if (typingKey !== undefined && typingKey === this.typingKey && Date.now() - this.typingTime < MERGE_MS) return
    const snapshot = this.snapshot()
    this.first ??= snapshot
    this.done.push(snapshot)
    if (this.done.length > this.limit) this.done.shift()
    this.undone = []
    this.typingKey = undefined
  }

  /** Call after typing with the caret's new key, so the next keystroke can merge. */
  typed(caretKey: string | undefined): void {
    this.typingKey = caretKey
    this.typingTime = Date.now()
  }

  undo(): boolean {
    return this.move(this.done, this.undone)
  }

  redo(): boolean {
    return this.move(this.undone, this.done)
  }

  /**
   * Restores the starting HTML, like a form reset restores a `<textarea>`, and
   * clears undo and redo. With no change recorded the HTML is already the
   * starting HTML, so there's nothing to do.
   */
  reset(): void {
    if (!this.first) return
    this.root.innerHTML = this.first.html
    this.first = undefined
    this.done = []
    this.undone = []
    this.typingKey = undefined
  }

  /** Encodes the caret for `record`/`typed`. */
  caretKey(): string | undefined {
    const sel = getSelectionFor(this.root)
    if (!sel?.focusNode || !this.root.contains(sel.focusNode)) return undefined
    return JSON.stringify(encodePoint(this.root, sel.focusNode, sel.focusOffset))
  }

  private move(from: Snapshot[], to: Snapshot[]): boolean {
    const snapshot = from.pop()
    if (!snapshot) return false
    to.push(this.snapshot())
    this.restore(snapshot)
    this.typingKey = undefined
    return true
  }

  private snapshot(): Snapshot {
    const sel = getSelectionFor(this.root)
    const inside = !!sel?.anchorNode && this.root.contains(sel.anchorNode) && this.root.contains(sel.focusNode)
    return {
      html: this.root.innerHTML,
      anchor: inside ? encodePoint(this.root, sel!.anchorNode!, sel!.anchorOffset) : null,
      focus: inside ? encodePoint(this.root, sel!.focusNode!, sel!.focusOffset) : null,
    }
  }

  private restore(snapshot: Snapshot): void {
    this.root.innerHTML = snapshot.html
    const anchor = snapshot.anchor && decodePoint(this.root, snapshot.anchor)
    const focus = snapshot.focus && decodePoint(this.root, snapshot.focus)
    if (anchor && focus) selectPoints(this.root, anchor, focus)
  }
}
