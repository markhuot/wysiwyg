import { describe, expect, test } from 'bun:test'
import { defaultSchema, validate } from '../../src/schema'

const messages = (html: string) => {
  const root = document.createElement('div')
  root.innerHTML = html
  return validate(root, defaultSchema).map((v) => v.message)
}

describe('validate', () => {
  test('accepts valid markup, including whitespace between blocks and both placeholder forms', () => {
    expect(messages('<h1>T</h1>\n<p><br></p>\n<p>a<br><br></p><p><strong>a<em>b</em></strong><br>c</p>')).toEqual([])
  })

  test.each([
    ['<div>a</div>', '<div> is not an allowed block'],
    ['loose', 'text outside a block'],
    ['<p></p>', 'empty <p> needs a placeholder <br>'],
    ['<p>a<br></p>', '<p> ends with a <br> that has no placeholder after it'],
    ['<p><b>a</b></p>', '<b> is not an allowed mark'],
    ['<p><em><strong>a</strong></em></p>', '<strong> must not sit inside <em>'],
    ['<p><strong><strong>a</strong></strong></p>', '<strong> must not sit inside <strong>'],
    ['<p>a<em></em></p>', 'empty <em>'],
    ['<p><em>a</em><em>b</em></p>', 'adjacent <em> elements should be merged'],
    ['<p><strong>a<br>b</strong></p>', '<br> inside <strong>'],
  ])('%s is flagged', (html, message) => {
    expect(messages(html)).toContain(message)
  })
})
