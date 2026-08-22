// @vitest-environment jsdom
import { vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('chrome', {
    runtime: { onMessage: { addListener: vi.fn() } },
  })
})

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Composer } from '../src/sidepanel/Composer'

describe('viewer mode', () => {
  it('disables the composer for read-only windows', () => {
    const html = renderToStaticMarkup(
      <Composer busy={false} readOnly onSend={vi.fn()} onCancel={vi.fn()} />,
    )
    expect(html).toMatch(/<textarea[^>]*disabled=""/)
  })
})
