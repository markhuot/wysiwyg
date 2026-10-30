import demo from './demo/index.html'
import fixture from './tests/e2e/fixture.html'

// The demo at / and the e2e fixture at /fixture, from one server.
const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  routes: { '/': demo, '/fixture': fixture },
  development: true,
})

console.log(`wysiwyg demo on ${server.url}`)
