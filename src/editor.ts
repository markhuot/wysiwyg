import { deleteRange, stepBackward, stepForward, type DeleteUnit } from './commands/deleteRange'
import { insertLineBreak } from './commands/insertLineBreak'
import { insertPlainText } from './commands/insertPlainText'
import { insertText } from './commands/insertText'
import { repairBlock } from './commands/repairBlock'
import type { Ctx } from './commands/replaceRange'
import { splitBlock } from './commands/splitBlock'
import { pendingAt, toggleMark, togglePending, type PendingMarks } from './commands/toggleMark'
import { getSelectionFor, ordered, pointToPos, posToPoint, selectPoints, type Pos } from './dom'
import { History } from './history'
import { defaultSchema, validate, validateBlock, type Schema } from './schema'

export interface EditorOptions {
  /** Validate the whole document after every edit and log violations. Development only. */
  debug?: boolean
}

export interface Editor {
  readonly root: HTMLElement
  readonly schema: Schema
  getHTML(): string
  destroy(): void
}

/** Input types the browser runs itself. Chrome doesn't let a page cancel composition. */
const COMPOSITION = new Set(['insertCompositionText', 'deleteCompositionText', 'insertFromComposition'])

/** Keyboard shortcuts that toggle a mark. */
const MARK_KEYS: Record<string, string> = { b: 'strong', i: 'em' }

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform)

/** Editing root → editor. With the listener counts below, the only module state. */
const editors = new WeakMap<EventTarget, EditorImpl>()
const listening = new WeakMap<Document, number>()

/**
 * Registers an editor on `el`. This is deliberately all it does: no DOM reads
 * or writes, not even `contenteditable`, which comes from the author's markup.
 */
export function createEditor(el: HTMLElement, schema: Schema = defaultSchema, options: EditorOptions = {}): Editor {
  editors.get(el)?.destroy()
  const editor = new EditorImpl(el, schema, options)
  editors.set(el, editor)
  const doc = el.ownerDocument
  const count = listening.get(doc) ?? 0
  if (count === 0) listen(doc, true)
  listening.set(doc, count + 1)
  return editor
}

// For contenteditable, beforeinput/keydown/composition events almost always
// target the editing host itself, so dispatch is one map lookup.
// composedPath()[0] sees through shadow roots. Chrome targets a paste at the
// block instead, so a miss inside editable content walks up to the host;
// events outside editable content still cost one miss.
function editorFor(e: Event): EditorImpl | undefined {
  const target = e.composedPath()[0] ?? e.target
  if (!target) return undefined
  const editor = editors.get(target)
  if (editor || !(target as HTMLElement).isContentEditable) return editor
  for (let n = (target as Node).parentNode; n; n = n.parentNode) {
    const found = editors.get(n)
    if (found) return found
  }
  return undefined
}
const onBeforeInput = (e: Event) => editorFor(e)?.beforeInput(e as InputEvent)
const onKeyDown = (e: Event) => editorFor(e)?.keyDown(e as KeyboardEvent)
const onCompositionEnd = (e: Event) => editorFor(e)?.compositionEnd()

function listen(doc: Document, on: boolean): void {
  const method = on ? 'addEventListener' : 'removeEventListener'
  // Capture phase, so an app's stopPropagation can't starve the editor.
  doc[method]('beforeinput', onBeforeInput, true)
  doc[method]('keydown', onKeyDown, true)
  doc[method]('compositionend', onCompositionEnd, true)
}

interface SelectedRange {
  from: Pos
  to: Pos
  collapsed: boolean
}

class EditorImpl implements Editor {
  private readonly history: History
  private readonly ctx: Ctx
  private pending: PendingMarks | null = null
  private composing = false

  constructor(
    readonly root: HTMLElement,
    readonly schema: Schema,
    private readonly options: EditorOptions,
  ) {
    this.history = new History(root)
    this.ctx = { root, schema }
  }

  getHTML(): string {
    return this.root.innerHTML
  }

  destroy(): void {
    if (editors.get(this.root) !== this) return
    editors.delete(this.root)
    const doc = this.root.ownerDocument
    const count = (listening.get(doc) ?? 1) - 1
    listening.set(doc, count)
    if (count === 0) listen(doc, false)
  }

  beforeInput(e: InputEvent): void {
    const type = e.inputType
    if (COMPOSITION.has(type) || e.isComposing) {
      if (!this.composing) {
        this.composing = true
        this.pending = null
        this.history.record()
      }
      return
    }
    if (!e.cancelable) return
    e.preventDefault()

    switch (type) {
      case 'insertText':
        return this.type(e.data ?? e.dataTransfer?.getData('text/plain') ?? '')
      case 'insertReplacementText':
        return this.replace(e)
      case 'insertParagraph':
        return this.apply((from, to) => splitBlock(this.ctx, from, to))
      case 'insertLineBreak':
        return this.apply((from, to) => insertLineBreak(this.ctx, from, to))
      case 'insertFromPaste': {
        const text = e.dataTransfer?.getData('text/plain') ?? e.data ?? ''
        if (text) this.apply((from, to) => insertPlainText(this.ctx, from, to, text))
        return
      }
      case 'formatBold':
        return this.toggle('strong')
      case 'formatItalic':
        return this.toggle('em')
      case 'historyUndo':
        return this.undo()
      case 'historyRedo':
        return this.redo()
      case 'deleteByDrag':
        return
    }
    if (type.startsWith('delete')) this.delete(e)
    // Anything else (lists, links, underline, drops…) has no schema rule and stays cancelled.
  }

  keyDown(e: KeyboardEvent): void {
    if (e.isComposing || e.altKey) return
    // Engines disagree on Shift+Enter (WebKit can send insertParagraph), so it's bound here.
    if (e.key === 'Enter' && e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      return this.apply((from, to) => insertLineBreak(this.ctx, from, to))
    }
    if (!(isMac ? e.metaKey : e.ctrlKey)) return
    const key = e.key.toLowerCase()
    const mark = MARK_KEYS[key]
    if (mark) {
      e.preventDefault()
      this.toggle(mark)
    } else if (key === 'u') {
      e.preventDefault()
    } else if (key === 'z') {
      e.preventDefault()
      if (e.shiftKey) this.redo()
      else this.undo()
    } else if (key === 'y' && !isMac) {
      e.preventDefault()
      this.redo()
    }
  }

  /** Composition ran natively, so check the caret's block, and only that block, against the schema. */
  compositionEnd(): void {
    this.composing = false
    const sel = getSelectionFor(this.root)
    const anchor = sel?.anchorNode
    if (!sel || !anchor || !this.root.contains(anchor)) return
    let node: Node | null | undefined = anchor === this.root ? this.root.childNodes[sel.anchorOffset] : anchor
    while (node && node.parentNode !== this.root) node = node.parentNode
    if (!node) return
    if (node.nodeType === 1 && !validateBlock(node as Element, this.schema).length) return
    const pos = repairBlock(this.ctx, node, { node: anchor, offset: sel.anchorOffset })
    if (pos) this.place(pos)
    this.check()
  }

  private selection(): SelectedRange | null {
    const sel = getSelectionFor(this.root)
    return sel?.rangeCount ? this.toRange(sel.getRangeAt(0)) : null
  }

  private toRange(r: AbstractRange): SelectedRange | null {
    const a = pointToPos(this.root, r.startContainer, r.startOffset)
    const b = pointToPos(this.root, r.endContainer, r.endOffset)
    if (!a || !b) return null
    const [from, to] = ordered(a, b)
    return { from, to, collapsed: from.block === to.block && from.offset === to.offset }
  }

  /** The engine's target range for this edit, if it gave a usable one. */
  private targetRange(e: InputEvent): SelectedRange | null {
    const range = e.getTargetRanges?.()[0]
    return range ? this.toRange(range) : null
  }

  private place(from: Pos, to: Pos = from): void {
    selectPoints(this.root, posToPoint(from), posToPoint(to))
  }

  private apply(command: (from: Pos, to: Pos) => Pos, range = this.selection()): void {
    if (!range) return
    this.history.record()
    this.pending = null
    this.place(command(range.from, range.to))
    this.check()
  }

  private type(text: string): void {
    if (!text) return
    const sel = getSelectionFor(this.root)
    const node = sel?.anchorNode

    // The common case: a caret inside a text node, after a character whose
    // marks the new text takes. One insertData, no block rewrite.
    if (!this.pending && sel?.isCollapsed && node?.nodeType === 3 && sel.anchorOffset > 0 && this.root.contains(node)) {
      const offset = sel.anchorOffset
      this.history.record(this.history.caretKey())
      ;(node as Text).insertData(offset, text)
      selectPoints(this.root, { node, offset: offset + text.length })
      this.history.typed(this.history.caretKey())
      this.check()
      return
    }

    const range = this.selection()
    if (!range) return
    const marks = range.collapsed ? pendingAt(this.pending, range.from) : undefined
    this.history.record(range.collapsed ? this.history.caretKey() : undefined)
    this.pending = null
    this.place(insertText(this.ctx, range.from, range.to, text, marks))
    this.history.typed(this.history.caretKey())
    this.check()
  }

  /** Spellcheck and autocorrect: replace the engine's target range (often not the selection) with plain text. */
  private replace(e: InputEvent): void {
    const text = e.data ?? e.dataTransfer?.getData('text/plain') ?? ''
    this.apply((from, to) => insertText(this.ctx, from, to, text), this.targetRange(e) ?? this.selection())
  }

  private delete(e: InputEvent): void {
    let range = this.selection()
    if (!range) return
    const type = e.inputType
    if (range.collapsed) {
      if (type === 'deleteByCut' || type === 'deleteContent') return
      const unit: DeleteUnit = /Word/.test(type) ? 'word' : /Line/.test(type) ? 'line' : 'char'
      // Word and line ends depend on layout and language, so prefer the engine's range for those.
      const target = unit === 'char' ? null : this.targetRange(e)
      if (target && !target.collapsed) {
        range = target
      } else {
        const step = /Forward/.test(type) ? stepForward : stepBackward
        const other = step(this.ctx, range.from, unit)
        if (!other) return
        const [from, to] = ordered(range.from, other)
        range = { from, to, collapsed: false }
      }
    }
    this.apply((from, to) => deleteRange(this.ctx, from, to), range)
  }

  private toggle(mark: string): void {
    if (!this.schema.marks.includes(mark)) return
    const range = this.selection()
    if (!range) return
    if (range.collapsed) {
      this.pending = togglePending(this.ctx, this.pending, range.from, mark)
      return
    }
    this.history.record()
    this.pending = null
    toggleMark(this.ctx, range.from, range.to, mark)
    this.place(range.from, range.to)
    this.check()
  }

  private undo(): void {
    this.pending = null
    this.history.undo()
  }

  private redo(): void {
    this.pending = null
    this.history.redo()
  }

  private check(): void {
    if (!this.options.debug) return
    const violations = validate(this.root, this.schema)
    if (violations.length) console.error('wysiwyg: schema violations after edit', violations)
  }
}
