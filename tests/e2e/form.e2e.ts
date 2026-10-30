import { expect, test, type Page } from '@playwright/test'

async function mount(page: Page, html: string, options: { form?: boolean; name?: string } = {}) {
  await page.goto('/fixture')
  await page.evaluate(([h, o]) => window.fixture.mount(h as string, 'default', o as { form?: boolean; name?: string }), [html, options] as const)
}

const select = (page: Page, block: number, offset: number) => page.evaluate(([b, o]) => window.fixture.select(b!, o!), [block, offset])
const formData = (page: Page) =>
  page.evaluate(() => [...new FormData(document.getElementById('form') as HTMLFormElement)].map(([k, v]) => [k, String(v)]))

test.describe('the form value', () => {
  test('new FormData(form) has the HTML under the root name', async ({ page }) => {
    await mount(page, '<p>ab</p>', { form: true, name: 'body' })
    await select(page, 0, 1)
    await page.keyboard.type('X')
    await page.keyboard.press('Enter')
    expect(await formData(page)).toEqual([
      ['title', 't'],
      ['body', '<p>aX</p><p>b</p>'],
    ])
  })

  test('a real submit posts it', async ({ page }) => {
    await mount(page, '<h1>T&amp;C</h1>', { form: true, name: 'body' })
    let posted = ''
    await page.route('**/submitted', async (route) => {
      posted = route.request().postData() ?? ''
      await route.fulfill({ body: 'ok' })
    })
    await select(page, 0, 3)
    await page.keyboard.type('!')
    await Promise.all([page.waitForURL('**/submitted'), page.click('button')])
    expect(new URLSearchParams(posted).get('body')).toBe('<h1>T&amp;C!</h1>')
  })

  test('an editor with no name posts nothing, and one outside the form is not in it', async ({ page }) => {
    await mount(page, '<p>ab</p>', { form: true })
    expect(await formData(page)).toEqual([['title', 't']])
    await mount(page, '<p>ab</p>', { name: 'body' })
    const outside = await page.evaluate(() => {
      const form = document.createElement('form')
      document.body.append(form)
      return [...new FormData(form)].length
    })
    expect(outside).toBe(0)
  })

  test('reset restores the starting HTML, even after more than 500 undo steps', async ({ page }) => {
    await mount(page, '<p>ab</p>', { form: true, name: 'body' })
    await select(page, 0, 1)
    for (let i = 0; i < 510; i++) await page.keyboard.press('Enter')
    expect(await page.evaluate(() => document.querySelectorAll('#ed p').length)).toBe(511)
    await page.evaluate(() => (document.getElementById('form') as HTMLFormElement).reset())
    expect(await page.evaluate(() => window.fixture.html())).toBe('<p>ab</p>')
    await page.keyboard.press('ControlOrMeta+z')
    expect(await page.evaluate(() => window.fixture.html())).toBe('<p>ab</p>')
  })

  test('reset on an untouched editor changes nothing', async ({ page }) => {
    await mount(page, '<p>ab <em>c</em></p>', { form: true, name: 'body' })
    await page.evaluate(() => (document.getElementById('form') as HTMLFormElement).reset())
    expect(await page.evaluate(() => window.fixture.html())).toBe('<p>ab <em>c</em></p>')
  })
})
