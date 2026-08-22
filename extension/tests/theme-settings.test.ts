// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { applyTheme } from '../src/lib/settings'

describe('applyTheme', () => {
  it('sets or clears an explicit document theme', () => {
    applyTheme('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    applyTheme('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    applyTheme('system')
    expect(document.documentElement.dataset.theme).toBeUndefined()
  })
})
