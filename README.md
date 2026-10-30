# wysiwyg

A `contenteditable` editor that enforces a strict schema with zero boot time.

The stored format is HTML, and the DOM is the document. You start the field with valid markup, `contenteditable` included, and `createEditor` trusts it: it registers the element and does nothing else. It doesn't parse, walk, validate or write. Every edit is intercepted at `beforeinput` and applied by the editor's own commands, which keep the markup valid. The browser never gets to add `<b>`, `<span style>` or stray `<div>`s.

## Usage

```html
<div id="body" contenteditable="true"><h1>Hello</h1><p>World</p></div>
```

```css
/* Typed spaces go in as plain spaces, so the editor needs pre-wrap to show runs of them. */
[contenteditable] { white-space: pre-wrap; }
```

```ts
import { createEditor, defaultSchema } from './src'

const editor = createEditor(document.getElementById('body')!, defaultSchema)
editor.getHTML() // el.innerHTML, nothing serialized
editor.destroy()
```

A schema lists the block tags, the mark tags (outermost first) and the block to use for new blocks:

```ts
const paragraphsOnly = { blocks: ['p'], marks: ['strong', 'em'], defaultBlock: 'p' }
```

`validate(root, schema)` lists violations. It walks the whole document, so it's meant for tests and debugging; pass `{ debug: true }` as the third argument to `createEditor` to run it after every edit.

## The default schema

- The root holds `p`, `h1` and `h2`.
- Blocks hold text, `strong`, `em` and `br`. `strong` always sits outside `em`, and `br` never sits inside a mark.
- An empty block is `<p><br></p>`. A block whose last line is empty ends with an extra placeholder `<br>`.

## Editing

Typing, Enter, Shift+Enter, Backspace/Delete (with the word and line variants), ⌘/Ctrl+B and ⌘/Ctrl+I, plain-text paste, spellcheck replacements and undo/redo all run through the editor's commands. IME composition is the one native path: the browser composes in place, and when composition ends the editor repairs the block it touched. Edits the schema has no rule for (lists, underline, drag-and-drop…) are cancelled.

## Development

```sh
bun install
bunx playwright install chromium firefox webkit

bun run dev        # the two-editor demo on http://localhost:3000
bun test           # unit tests (happy-dom)
bun run test:e2e   # Playwright in Chromium, Firefox and WebKit
bun run typecheck
```
