import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../src/sidepanel/index.css', import.meta.url), 'utf8')

describe('Nox theme', () => {
  it('defines semantic light and dark tokens', () => {
    expect(css).toContain('--nox-surface:')
    expect(css).toContain('@media (prefers-color-scheme: light)')
  })

  it('disables interface motion when reduced motion is requested', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).toContain('.nox-resolve')
  })
})
