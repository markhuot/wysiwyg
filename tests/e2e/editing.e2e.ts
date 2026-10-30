import { expect, test, type Page } from '@playwright/test'

async function mount(page: Page, html: string, schema = 'default') {
  await page.goto('/fixture')
  await page.evaluate(([h, s]) => window.fixture.mount(h!, s), [html, schema])
}

const select = (page: Page, block: number, offset: number, endBlock = block, endOffset = offset) =>
  page.evaluate((args) => window.fixture.select(...(args as [number, number, number, number])), [
    block,
    offset,
    endBlock,
    endOffset,
  ])

/** The exact HTML, and that it's valid for the schema. */
async function expectDoc(page: Page, html: string) {
  expect(await page.evaluate(() => window.fixture.html())).toBe(html)
  expect(await page.evaluate(() => window.fixture.violations())).toEqual([])
}

test.describe('typing', () => {
  test('inserts at the caret', async ({ page }) => {
    await mount(page, '<p>ab</p>')
    await select(page, 0, 1)
    await page.keyboard.type('X Y')
    await expectDoc(page, '<p>aX Yb</p>')
  })

  test('takes the marks of the text before the caret', async ({ page }) => {
    await mount(page, '<p><strong>ab</strong>cd</p>')
    await select(page, 0, 2)
    await page.keyboard.type('X')
    await expectDoc(page, '<p><strong>abX</strong>cd</p>')
  })

  test('at the start of a block takes the marks after the caret', async ({ page }) => {
    await mount(page, '<p><em>ab</em></p>')
    await select(page, 0, 0)
    await page.keyboard.type('XY')
    await expectDoc(page, '<p><em>XYab</em></p>')
  })

  test('over a selection across blocks replaces it', async ({ page }) => {
    await mount(page, '<h1>abc</h1><p>def</p>')
    await select(page, 0, 1, 1, 2)
    await page.keyboard.type('X')
    await expectDoc(page, '<h1>aXf</h1>')
  })
})

test.describe('Enter', () => {
  test('splits a paragraph', async ({ page }) => {
    await mount(page, '<p>abcd</p>')
    await select(page, 0, 2)
    await page.keyboard.press('Enter')
    await page.keyboard.type('X')
    await expectDoc(page, '<p>ab</p><p>Xcd</p>')
  })

  test('at the end of a heading starts a paragraph', async ({ page }) => {
    await mount(page, '<h1>Title</h1>')
    await select(page, 0, 5)
    await page.keyboard.press('Enter')
    await expectDoc(page, '<h1>Title</h1><p><br></p>')
    await page.keyboard.type('x')
    await expectDoc(page, '<h1>Title</h1><p>x</p>')
  })

  test('the paragraph-only schema never makes a heading', async ({ page }) => {
    await mount(page, '<p>ab</p>', 'paragraph')
    await select(page, 0, 1)
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await expectDoc(page, '<p>a</p><p><br></p><p>b</p>')
  })
})

test.describe('Shift+Enter', () => {
  test('splits marks around the <br> and the next character lands after it', async ({ page }) => {
    await mount(page, '<p><strong>abcd</strong></p>')
    await select(page, 0, 2)
    await page.keyboard.press('Shift+Enter')
    await expectDoc(page, '<p><strong>ab</strong><br><strong>cd</strong></p>')
    await page.keyboard.type('X')
    await expectDoc(page, '<p><strong>ab</strong><br><strong>Xcd</strong></p>')
  })

  test('at the end of a block adds a placeholder', async ({ page }) => {
    await mount(page, '<p>ab</p>')
    await select(page, 0, 2)
    await page.keyboard.press('Shift+Enter')
    await expectDoc(page, '<p>ab<br><br></p>')
    await page.keyboard.type('X')
    await expectDoc(page, '<p>ab<br>X</p>')
  })

  test('Backspace after a trailing <br> removes it and its placeholder', async ({ page }) => {
    await mount(page, '<p>ab</p>')
    await select(page, 0, 2)
    await page.keyboard.press('Shift+Enter')
    await page.keyboard.press('Backspace')
    await page.keyboard.type('X')
    await expectDoc(page, '<p>abX</p>')
  })
})

test.describe('Backspace and Delete', () => {
  test('Backspace inside a block', async ({ page }) => {
    await mount(page, '<p>a<em>b</em>c</p>')
    await select(page, 0, 2)
    await page.keyboard.press('Backspace')
    await expectDoc(page, '<p>ac</p>')
    await page.keyboard.type('X')
    await expectDoc(page, '<p>aXc</p>')
  })

  test('Backspace at a block start joins into the previous block', async ({ page }) => {
    await mount(page, '<h1>ab</h1><p><strong>cd</strong></p>')
    await select(page, 1, 0)
    await page.keyboard.press('Backspace')
    await expectDoc(page, '<h1>ab<strong>cd</strong></h1>')
    await page.keyboard.type('X')
    await expectDoc(page, '<h1>abX<strong>cd</strong></h1>')
  })

  test('Enter then Backspace at the start of a heading gives the heading back', async ({ page }) => {
    await mount(page, '<h1>Title</h1>')
    await select(page, 0, 0)
    await page.keyboard.press('Enter')
    await expectDoc(page, '<p><br></p><h1>Title</h1>')
    await page.keyboard.press('Backspace')
    await expectDoc(page, '<h1>Title</h1>')
    await page.keyboard.type('X')
    await expectDoc(page, '<h1>XTitle</h1>')
  })

  test('Delete at a block end joins the next block', async ({ page }) => {
    await mount(page, '<p>ab</p><p>cd</p>')
    await select(page, 0, 2)
    await page.keyboard.press('Delete')
    await page.keyboard.type('X')
    await expectDoc(page, '<p>abXcd</p>')
  })

  test('Backspace over a selection across three blocks', async ({ page }) => {
    await mount(page, '<p>a<strong>bc</strong></p><h2>mid</h2><p><em>de</em>f</p>')
    await select(page, 0, 2, 2, 1)
    await page.keyboard.press('Backspace')
    await expectDoc(page, '<p>a<strong>b</strong><em>e</em>f</p>')
  })

  test('word delete backward', async ({ page }) => {
    await mount(page, '<p>one two three</p>')
    await select(page, 0, 7)
    await page.keyboard.press(process.platform === 'darwin' ? 'Alt+Backspace' : 'Control+Backspace')
    await expectDoc(page, '<p>one  three</p>')
  })
})

test.describe('marks', () => {
  test('Mod+B toggles strong over a selection', async ({ page }) => {
    await mount(page, '<p>a<strong>b</strong>cd</p>')
    await select(page, 0, 0, 0, 3)
    await page.keyboard.press('ControlOrMeta+b')
    await expectDoc(page, '<p><strong>abc</strong>d</p>')
    await page.keyboard.press('ControlOrMeta+b')
    await expectDoc(page, '<p>abcd</p>')
  })

  test('Mod+I nests em inside strong', async ({ page }) => {
    await mount(page, '<p><strong>abc</strong></p>')
    await select(page, 0, 1, 0, 2)
    await page.keyboard.press('ControlOrMeta+i')
    await expectDoc(page, '<p><strong>a<em>b</em>c</strong></p>')
  })

  test('Mod+B with a collapsed caret marks the next characters', async ({ page }) => {
    await mount(page, '<p>ab</p>')
    await select(page, 0, 1)
    await page.keyboard.press('ControlOrMeta+b')
    await expectDoc(page, '<p>ab</p>')
    await page.keyboard.type('XY')
    await expectDoc(page, '<p>a<strong>XY</strong>b</p>')
  })

  test('the pending mark is dropped when the caret moves', async ({ page }) => {
    await mount(page, '<p>ab</p>')
    await select(page, 0, 1)
    await page.keyboard.press('ControlOrMeta+b')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.type('X')
    await expectDoc(page, '<p>abX</p>')
  })

  test('Mod+U is cancelled', async ({ page }) => {
    await mount(page, '<p>abc</p>')
    await select(page, 0, 0, 0, 3)
    await page.keyboard.press('ControlOrMeta+u')
    await expectDoc(page, '<p>abc</p>')
  })
})

test.describe('paste', () => {
  test('plain text with newlines splits blocks', async ({ page, context, browserName }) => {
    if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await mount(page, '<h1>ab</h1>')
    await select(page, 0, 1)
    await page.evaluate(() => navigator.clipboard.writeText('one\ntwo'))
    await page.keyboard.press('ControlOrMeta+v')
    await expectDoc(page, '<h1>aone</h1><p>twob</p>')
    await page.keyboard.type('X')
    await expectDoc(page, '<h1>aone</h1><p>twoXb</p>')
  })
})

test.describe('undo and redo', () => {
  test('a burst of typing is one undo step', async ({ page }) => {
    await mount(page, '<p>ab</p>')
    await select(page, 0, 2)
    await page.keyboard.type('cde')
    await page.keyboard.press('ControlOrMeta+z')
    await expectDoc(page, '<p>ab</p>')
    await page.keyboard.press('ControlOrMeta+Shift+z')
    await expectDoc(page, '<p>abcde</p>')
  })

  test('undoes Enter, Shift+Enter, marks and deletes one at a time', async ({ page }) => {
    await mount(page, '<p>abcd</p>')
    await select(page, 0, 2)
    await page.keyboard.press('Enter')
    await page.keyboard.press('Shift+Enter')
    await select(page, 1, 1, 1, 3)
    await page.keyboard.press('ControlOrMeta+b')
    await page.keyboard.press('Backspace')
    await expectDoc(page, '<p>ab</p><p><br><br></p>')

    const steps = ['<p>ab</p><p><br><strong>cd</strong></p>', '<p>ab</p><p><br>cd</p>', '<p>ab</p><p>cd</p>', '<p>abcd</p>']
    for (const html of steps) {
      await page.keyboard.press('ControlOrMeta+z')
      await expectDoc(page, html)
    }
    for (const html of steps.reverse().slice(1)) {
      await page.keyboard.press('ControlOrMeta+Shift+z')
      await expectDoc(page, html)
    }
  })

  test('undo restores the caret', async ({ page }) => {
    await mount(page, '<p>abcd</p>')
    await select(page, 0, 2)
    await page.keyboard.press('Enter')
    await page.keyboard.press('ControlOrMeta+z')
    await page.keyboard.type('X')
    await expectDoc(page, '<p>abXcd</p>')
  })
})

test.describe('composition', () => {
  test('runs natively and leaves a valid block that undoes in one step', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'IME is simulated through the Chrome DevTools Protocol')
    await mount(page, '<p><strong>ab</strong></p>')
    await select(page, 0, 2)
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 })
    await cdp.send('Input.imeSetComposition', { text: 'にほ', selectionStart: 2, selectionEnd: 2 })
    await cdp.send('Input.insertText', { text: '日本' })
    await expectDoc(page, '<p><strong>ab日本</strong></p>')
    await page.keyboard.press('ControlOrMeta+z')
    await expectDoc(page, '<p><strong>ab</strong></p>')
  })

  test('repairs browser markup left in the composed block', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'IME is simulated through the Chrome DevTools Protocol')
    await mount(page, '<p>ab</p>')
    await select(page, 0, 2)
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Input.imeSetComposition', { text: 'x', selectionStart: 1, selectionEnd: 1 })
    // Stand in for an engine that leaves non-schema markup behind during composition.
    await page.evaluate(() => document.querySelector('#ed p')!.insertAdjacentHTML('afterbegin', '<b>bold</b>'))
    await cdp.send('Input.insertText', { text: 'y' })
    await expectDoc(page, '<p><strong>bold</strong>aby</p>')
  })
})
