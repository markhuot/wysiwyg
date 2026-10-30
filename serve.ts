import { COLLAB_START } from './demo/collab-doc'
import demo from './demo/index.html'
import { CollabServer, type Connection } from './src/collab/server'
import { defaultSchema } from './src/schema'
import fixture from './tests/e2e/fixture.html'

// The multiplayer reference server: in memory, one document per id, every id starting from the same HTML.
const collab = new CollabServer({ schema: defaultSchema, html: () => COLLAB_START })

// The demo at /, the e2e fixture at /fixture and the multiplayer socket at /collab, from one server.
const server = Bun.serve<{ connection: Connection | null }>({
  port: Number(process.env.PORT ?? 3000),
  routes: {
    '/': demo,
    '/fixture': fixture,
    // A document's HTML, version and size index, for a page to start an editor from. `version` picks an older one.
    '/collab/doc': (req: Request) => {
      const url = new URL(req.url)
      const authority = collab.authority(url.searchParams.get('doc') ?? 'demo')
      const asked = Number(url.searchParams.get('version') ?? authority.version)
      const version = Number.isSafeInteger(asked) ? Math.max(0, Math.min(asked, authority.version)) : authority.version
      return Response.json({ html: authority.htmlAt(version), version, head: authority.version, sizes: authority.sizesAt(version) })
    },
  },
  fetch(req, server) {
    if (new URL(req.url).pathname === '/collab' && server.upgrade(req, { data: { connection: null } })) return undefined
    return new Response('Not found', { status: 404 })
  },
  websocket: {
    open(ws) {
      ws.data.connection = collab.connect((message) => {
        ws.send(JSON.stringify(message))
        if (message.type === 'refused') ws.close()
      })
    },
    message(ws, data) {
      try {
        ws.data.connection?.receive(JSON.parse(String(data)))
      } catch (e) {
        console.error('collab: bad message', e)
      }
    },
    close(ws) {
      ws.data.connection?.close()
    },
  },
  development: true,
})

console.log(`wysiwyg demo on ${server.url}`)
