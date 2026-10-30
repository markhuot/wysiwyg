import { expect, test, type Page } from '@playwright/test'
import type {} from '../../demo/main'

type Which = 'a' | 'b'

const html = (page: Page, which: Which) => page.evaluate((w) => window.demo[w].root.innerHTML, which)

const violations = (page: Page, which: Which) =>
  page.evaluate((w) => window.demo.validate(window.demo[w].root, window.demo[w].schema).length, which)

const place = (page: Page, which: Which, block: number, offset: number) =>
  page.evaluate(
    ([w, b, o]) => {
      const { root } = window.demo[w]
      root.focus()
      const point = window.demo.posToPoint({ block: root.children[b]!, offset: o })
      document.getSelection()!.collapse(point.node, point.offset)
    },
    [which, block, offset] as const,
  )

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => 'demo' in window)
})

test('createEditor on a few thousand blocks boots well under a millisecond', async ({ page }) => {
  await expect(page.locator('[data-editor="a"] [data-boot]')).toHaveText(/createEditor: [\d.]+ ms/)
  await expect(page.locator('[data-editor="a"] [data-valid]')).toHaveText('valid')
  expect(await page.evaluate(() => window.demo.a.root.children.length)).toBeGreaterThan(3000)

  // Browsers coarsen performance.now() to 0.1–1 ms, so average many boots of the same large element.
  const average = await page.evaluate(() => {
    const runs = 1000
    const start = performance.now()
    for (let i = 0; i < runs; i++) window.demo.createEditor(window.demo.a.root).destroy()
    return (performance.now() - start) / runs
  })
  expect(average).toBeLessThan(0.1)
})

test('attaching the multiplayer binding keeps boot well under a millisecond', async ({ page }) => {
  const average = await page.evaluate(() => {
    const transport = { connect: () => ({ send() {}, close() {} }) }
    const runs = 1000
    const start = performance.now()
    for (let i = 0; i < runs; i++) {
      const editor = window.demo.createEditor(window.demo.a.root)
      window.demo.bind(editor, { server: transport, online: false }).destroy()
      editor.destroy()
    }
    return (performance.now() - start) / runs
  })
  expect(average).toBeLessThan(0.1)
})

test('the form posts both editors and reset restores them', async ({ page }) => {
  await place(page, 'b', 0, 1)
  await page.keyboard.type('Q')
  await page.click('button[type=submit]')
  const posted = await page.locator('[data-posted]').textContent()
  expect(posted).toContain('body = <h1>A large document</h1>')
  expect(posted).toContain('notes = <p>AQ second')
  await page.click('button[type=reset]')
  expect(await html(page, 'b')).not.toContain('AQ')
})

test('edits and undo in editor A leave editor B byte-identical', async ({ page }) => {
  const before = await html(page, 'b')
  await place(page, 'a', 0, 1)
  await page.keyboard.type('xyz')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('ControlOrMeta+z')
  await page.keyboard.press('ControlOrMeta+z')
  expect(await html(page, 'b')).toBe(before)

  // B's history is its own: undo in B has nothing to undo.
  await place(page, 'b', 0, 0)
  await page.keyboard.press('ControlOrMeta+z')
  expect(await html(page, 'b')).toBe(before)
})

test('Enter on the h1 in the default-schema editor gives an h1 and a p', async ({ page }) => {
  await place(page, 'a', 0, 7)
  await page.keyboard.press('Enter')
  const [first, second] = await page.evaluate(() =>
    [...window.demo.a.root.children].slice(0, 2).map((el) => el.outerHTML),
  )
  expect(first).toBe('<h1>A large</h1>')
  expect(second).toBe('<p> document</p>')
  expect(await violations(page, 'a')).toBe(0)
})

test('the paragraph-only editor stays paragraphs', async ({ page }) => {
  await place(page, 'b', 0, 3)
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  const tags = await page.evaluate(() => [...window.demo.b.root.children].map((el) => el.localName))
  expect(new Set(tags)).toEqual(new Set(['p']))
  expect(await violations(page, 'b')).toBe(0)
})

test('after destroy() on A, B still works and A no longer intercepts edits', async ({ page }) => {
  await page.evaluate(() => {
    window.demo.a.destroy()
    const seen: boolean[] = ((window as unknown as { prevented: boolean[] }).prevented = [])
    window.demo.a.root.addEventListener('beforeinput', (e) => seen.push(e.defaultPrevented))
  })
  await place(page, 'a', 1, 0)
  await page.keyboard.type('Z')
  expect(await page.evaluate(() => (window as unknown as { prevented: boolean[] }).prevented)).toEqual([false])

  const before = await html(page, 'b')
  await place(page, 'b', 0, 1)
  await page.keyboard.type('Q')
  expect(await html(page, 'b')).toBe(before.replace('<p>A', '<p>AQ'))
})
