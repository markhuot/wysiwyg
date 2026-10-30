import { describe, expect, test } from 'bun:test'

// Imports by package name go through package.json's exports map, the same way an installed copy resolves.
describe('package exports', () => {
  test('the main entry exposes the editor', async () => {
    const mod = await import('wysiwyg')
    expect(typeof mod.createEditor).toBe('function')
    expect(mod.defaultSchema.defaultBlock).toBe('p')
  })

  test('the collab entry exposes the binding', async () => {
    const mod = await import('wysiwyg/collab')
    expect(typeof mod.bind).toBe('function')
  })

  test('the server entry exposes the authority and server', async () => {
    const mod = await import('wysiwyg/collab/server')
    expect(typeof mod.Authority).toBe('function')
    expect(typeof mod.CollabServer).toBe('function')
  })
})
