# wysiwyg

[![CI](https://github.com/markhuot/wysiwyg/actions/workflows/ci.yml/badge.svg)](https://github.com/markhuot/wysiwyg/actions/workflows/ci.yml)

A `contenteditable` editor that enforces a strict schema with zero boot time.

The stored format is HTML, and the DOM is the document. You start the field with valid markup, `contenteditable` included, and `createEditor` trusts it: it registers the element and does nothing else. It doesn't parse, walk, validate or write. Every edit is intercepted at `beforeinput` and applied by the editor's own commands, which keep the markup valid. The browser never gets to add `<b>`, `<span style>` or stray `<div>`s.

## Installation

The package isn't on npm. Install it from GitHub at a release tag:

```sh
bun add github:markhuot/wysiwyg#v0.1.0
# or
npm install github:markhuot/wysiwyg#v0.1.0
```

It has no runtime dependencies and ships its TypeScript source, with no build step. Bun runs it as is, and bundlers that compile TypeScript (Vite, esbuild, Bun's bundler) handle it like your own code. There are three entry points:

```ts
import { createEditor, defaultSchema, validate } from 'wysiwyg'
import { bind } from 'wysiwyg/collab'                     // the multiplayer binding, in the browser
import { Authority, CollabServer } from 'wysiwyg/collab/server' // the collaboration server, no DOM
```

## Usage

```html
<div id="body" contenteditable="true"><h1>Hello</h1><p>World</p></div>
```

```css
/* Typed spaces go in as plain spaces, so the editor needs pre-wrap to show runs of them. */
[contenteditable] { white-space: pre-wrap; }
```

```ts
import { createEditor, defaultSchema } from 'wysiwyg'

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

Typing, Enter, Shift+Enter, Backspace/Delete (with the word and line variants), ⌘/Ctrl+B and ⌘/Ctrl+I, plain-text paste and spellcheck replacements run through the editor's commands. IME composition is the one native path: the browser composes in place, and when composition ends the editor repairs the block it touched. Edits the schema has no rule for (lists, underline, drag-and-drop…) are cancelled.

Undo and redo restore snapshots: before each change the history saves the root's `innerHTML` and the selection, and typing at the caret within a second of the last keystroke joins the same entry. It keeps 500 entries. A bound multiplayer editor undoes through steps instead (see below).

## Forms

An editor inside a `<form>` posts like a `<textarea>`. The field name is the root's `name` attribute, and the value is the editor's HTML:

```html
<form method="post" action="/save">
  <div contenteditable="true" name="body"><p>Hello</p></div>
  <button>Save</button>
  <button type="reset">Reset</button>
</form>
```

Both a submit and `new FormData(form)` include it, through the form's `formdata` event, so nothing runs until the form is read. An editor with no `name` posts nothing. A form `reset` restores the editor's starting HTML and clears its undo history. The starting HTML isn't copied at boot: the history's first snapshot already is it, so the history keeps that one even after the 500-entry limit. An editor that was never edited is already at its starting HTML, so reset leaves it alone. In a multiplayer session reset does nothing, since the document is shared.

## Multiplayer

Multiplayer is optional and lives in its own entry point, `wysiwyg/collab`. Without it the editor works exactly as above.

```ts
import { createEditor } from 'wysiwyg'
import { bind } from 'wysiwyg/collab'

const editor = createEditor(el)
const collab = bind(editor, {
  server: '/collab',          // a WebSocket URL, or a transport
  doc: 'notes',               // the document's id on the server
  sizes: () => JSON.parse(document.getElementById('sizes')!.textContent!), // optional, see below
  name: 'Ada',
  color: '#d0368a',
})
collab.online = false         // keep editing offline; edits merge on reconnect
collab.addEventListener('error', (e) => console.error((e as CustomEvent).detail))
```

It follows ProseMirror's collaboration design, written without dependencies and applied to the live DOM:

- **A central server orders every edit.** Clients send steps made at a version. The server accepts them only at its head version and if every step applies cleanly and passes the schema, then numbers them and broadcasts them to everyone, the sender included. A client whose send loses the race rebases: it reverts its unconfirmed steps, applies the server's, maps its own through them and sends again.
- **Positions are flat integers.** Position 0 is before the first block, entering or leaving a block counts 1, and inside a block each UTF-16 unit and each `<br>` counts 1. Containers such as tables will add their own enter and leave tokens, so the same integers reach any depth.
- **There are three step types.** `replace(from, to, slice)` covers typing, paste, delete, split (an empty range replaced with a close and an open token) and join (the close and open between two blocks deleted, so the first block keeps its tag). `addMark`/`removeMark(from, to, mark)` and `setBlock(pos, tag, attrs)` don't move positions.
- **Mapping** follows ProseMirror's `StepMap` and `Mapping`, mirrors included, so a position inside text a client deleted and reinserted while rebasing comes back where it was.
- **Undo** reverts only this client's changes: it keeps the inverse of each of its own steps, maps them through everyone's later steps, and applies them as new steps.
- **Remote cursors** travel over the same socket, outside the step log, and are drawn in a layer over the page, outside the editable root. They never reach `getHTML()`, the form value or `validate()`.

### Versions and zero boot

A client starts from HTML at a known version: the root's `data-version` attribute, or the `version` option. `bind()` reads nothing at boot. The connection opens in the background, and edits made before it opens are ordinary unconfirmed steps against that version. Connecting sends `hello` with the version, and the server replies with every step since.

### The size index

Turning a DOM caret into an integer position needs the size of every block before it. The binding keeps a size index (a Fenwick tree) updated by every step. It gets its starting sizes from the server, in the page through the `sizes` option (parsed when first needed, and used only if its version matches), or in the `hello` reply. Without either it measures the blocks itself in idle time, a slice at a time. Any edit that arrives before the build is done finishes it first.

### The server

`wysiwyg/collab/server` (`src/collab/server.ts`) has the server, with no DOM and no dependencies. `Authority` holds one document: its starting HTML, every step since, and a model at the head version that validates each step against the schema. It can produce the HTML and size index for any version. `CollabServer` speaks the protocol over any socket library. `serve.ts` hosts it with Bun's WebSocket at `/collab`, and `/collab/doc?doc=…&version=…` returns a version's HTML, number and size index.

The protocol is JSON, and every message carries the format version `v: 1`:

| From | Message | Meaning |
| --- | --- | --- |
| client | `hello { doc, clientId, schemaHash, version, wantSizes? }` | Join a document from `version`. |
| server | `welcome { head, sizes? }` | The handshake passed. |
| server | `refused { reason, message }` | The schema hash doesn't match, or the version is unknown. |
| client | `steps { version, steps, clientId }` | Steps made at `version`. |
| server | `steps { version, steps, clientIds }` | Accepted steps from `version` on, broadcast to everyone. |
| server | `rejected { reason, version, message }` | Not the head (`version`), or a step didn't apply (`invalid`). |
| both | `presence { clientId, name, color, version, anchor, head }` | A cursor, at a version. |
| server | `leave { clientId }` | A client disconnected. |
| server | `gone` | Reserved for a server that prunes old versions. Never sent yet. |

The schema hash is a hash of the schema's block tags, marks (in order) and default block. A client with a different schema is refused at the handshake, so every step a client sends means the same thing to everyone.

The server in `serve.ts` keeps documents in memory. It's a reference implementation of a real protocol, not a production server.

## Development

```sh
bun install
bunx playwright install chromium firefox webkit

bun run dev        # the demo, single-player and collaborative, on http://localhost:3000
bun test           # unit tests (happy-dom), including a seeded randomized multiplayer simulation
bun run test:e2e   # Playwright in Chromium, Firefox and WebKit
bun run typecheck
```

`SIM_SEEDS=2000 bun test simulation` runs the randomized simulation over more seeds, and `SIM_SEED=118 SIM_SEEDS=1` replays one.
