import { expect, test, type Page } from '@playwright/test'
import type {} from '../../demo/main'

type Which = 'c' | 'd'

let docs = 0
const docId = (name: string) => `e2e-${name}-${Date.now().toString(36)}-${docs++}-${Math.random().toString(36).slice(2, 6)}`

async function open(page: Page, query: string) {
  await page.goto(`/?${query}`)
  await page.waitForFunction(() => 'demo' in window)
  await page.evaluate(() => window.demo.collab)
}

const html = (page: Page, which: Which) => page.evaluate((w) => document.getElementById(`editor-${w}`)!.innerHTML, which)

const valid = (page: Page, which: Which) =>
  page.evaluate((w) => {
    const el = document.getElementById(`editor-${w}`)!
    return window.demo.validate(el, { blocks: ['p', 'h1', 'h2'], marks: ['strong', 'em'], defaultBlock: 'p' }).length === 0
  }, which)

const place = (page: Page, which: Which, block: number, offset: number) =>
  page.evaluate(
    ([w, b, o]) => {
      const root = document.getElementById(`editor-${w}`)!
      root.focus()
      const point = window.demo.posToPoint({ block: root.children[b as number]!, offset: o as number })
      document.getSelection()!.collapse(point.node, point.offset)
    },
    [which, block, offset] as const,
  )

const online = (page: Page, which: Which, on: boolean) => page.locator(`[data-collab="${which}"] [data-online]`).setChecked(on)

/** Waits until both editors on every page hold the same, valid HTML with nothing unsent, and returns it. */
async function converged(...pages: Page[]): Promise<string> {
  let result = ''
  await expect
    .poll(async () => {
      const all: string[] = []
      for (const page of pages) {
        for (const w of ['c', 'd'] as const) {
          all.push(await html(page, w))
          if (!(await valid(page, w))) return 'invalid'
          if (!(await page.locator(`[data-collab="${w}"] [data-sync]`).textContent())?.includes('· 0 unsent')) return 'unsent'
        }
      }
      result = all[0]!
      return all.every((h) => h === all[0]) ? 'same' : 'different'
    })
    .toBe('same')
  return result
}

test('typing before the connection opens merges once it does', async ({ page }) => {
  await open(page, `doc=${docId('before')}&offline`)
  await expect(page.locator('[data-collab="c"] [data-status]')).toHaveText('offline')
  await place(page, 'c', 1, 4)
  await page.keyboard.type(' (Ada)')
  await place(page, 'd', 4, 5)
  await page.keyboard.press('Enter')
  await page.keyboard.type('Grace was here')
  await expect(page.locator('[data-collab="c"] [data-sync]')).toContainText('v0 · 1 unsent')
  await online(page, 'c', true)
  await online(page, 'd', true)
  const result = await converged(page)
  expect(result).toContain('Both (Ada) editors')
  expect(result).toContain('<p>Split</p><p>Grace was here a paragraph')
})

test('take one editor offline, edit both, reconnect: they converge', async ({ page }) => {
  await open(page, `doc=${docId('offline')}`)
  await expect(page.locator('[data-collab="d"] [data-status]')).toHaveText('online')
  await online(page, 'd', false)
  await place(page, 'c', 2, 0)
  await page.keyboard.type('Ada: ')
  await place(page, 'c', 3, 3)
  await page.keyboard.press('Enter')
  await place(page, 'd', 2, 8)
  await page.keyboard.press('Backspace')
  await page.keyboard.type('ONE')
  await place(page, 'd', 1, 0)
  await page.keyboard.press('Backspace')
  expect(await html(page, 'c')).not.toBe(await html(page, 'd'))
  await online(page, 'd', true)
  const result = await converged(page)
  expect(result).toContain('Ada: Take onONE')
  expect(result).toContain('<h1>Shared notesBoth editors')
  expect(result).toContain('<h2>Try</h2><p><br></p>')
})

test("a remote cursor appears at the other client's caret", async ({ page }) => {
  await open(page, `doc=${docId('cursor')}`)
  await expect(page.locator('[data-collab="d"] [data-status]')).toHaveText('online')
  await place(page, 'c', 1, 4)
  await expect
    .poll(() =>
      page.evaluate(() => {
        // Ada's caret, drawn over Grace's editor, where Grace's own DOM has that position.
        const root = document.getElementById('editor-d')!
        const point = window.demo.posToPoint({ block: root.children[1]!, offset: 4 })
        const range = document.createRange()
        range.setStart(point.node, point.offset)
        const want = range.getClientRects()[0]!
        return [...document.querySelectorAll<HTMLElement>('.wysiwyg-cursor')].some((el) => {
          const r = el.getBoundingClientRect()
          return Math.abs(r.left - want.left) < 2 && Math.abs(r.top - want.top) < 2 && el.textContent === 'Ada'
        })
      }),
    )
    .toBe(true)
  // Cursors never enter the document.
  expect(await html(page, 'd')).not.toContain('cursor')
})

test('a page opened at an older version catches up, then edits with the others', async ({ page, context }) => {
  const doc = docId('older')
  await open(page, `doc=${doc}`)
  await expect(page.locator('[data-collab="c"] [data-status]')).toHaveText('online')
  for (const word of ['one ', 'two ', 'three ']) {
    await place(page, 'c', 1, 0)
    await page.keyboard.type(word)
    await converged(page)
  }
  const other = await context.newPage()
  await open(other, `doc=${doc}&version=0`)
  expect(await other.evaluate(() => document.getElementById('editor-c')!.dataset.version)).toBe('0')
  await place(other, 'd', 0, 0)
  await other.keyboard.type('Late: ')
  const result = await converged(page, other)
  expect(result).toContain('<h1>Late: Shared notes</h1><p>three two one Both')
})

test('IME composition holds a concurrent remote edit until it ends', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'IME is simulated through the Chrome DevTools Protocol')
  const doc = docId('ime')
  await open(page, `doc=${doc}`)
  const other = await context.newPage()
  await open(other, `doc=${doc}`)
  await expect(page.locator('[data-collab="c"] [data-status]')).toHaveText('online')
  await expect(other.locator('[data-collab="c"] [data-status]')).toHaveText('online')

  await place(page, 'c', 1, 4)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 })
  await place(other, 'c', 3, 0)
  await other.keyboard.type('Remote ')
  // Grace's editor on the composing page applies it; Ada's, mid-composition, waits.
  await expect.poll(() => html(page, 'd')).toContain('Remote Try')
  expect(await html(page, 'c')).not.toContain('Remote')
  await cdp.send('Input.imeSetComposition', { text: 'にほ', selectionStart: 2, selectionEnd: 2 })
  await cdp.send('Input.insertText', { text: '日本' })
  const result = await converged(page, other)
  expect(result).toContain('Both日本 editors')
  expect(result).toContain('<h2>Remote Try</h2>')
})

test('the multiplayer paths stay well under a frame on 3,000 paragraphs', async ({ page }) => {
  await page.goto('/fixture')
  const perf = await page.evaluate(() => window.fixture.perf(3000))
  test.info().annotations.push({ type: 'perf', description: JSON.stringify(perf) })
  console.log(`[${test.info().project.name}] perf`, JSON.stringify(perf))
  expect(perf.converged).toBe(true)
  // requestIdleCallback deadlines are at most 50 ms; the timer fallback budgets 8 ms.
  expect(perf.longestSlice).toBeLessThan(50)
  expect(perf.step).toBeLessThan(16)
  expect(perf.apply).toBeLessThan(16)
  expect(perf.rebase).toBeLessThan(16)
})
